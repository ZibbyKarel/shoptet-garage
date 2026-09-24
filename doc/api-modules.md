# API domain modules

How `apps/garage/api` serves the contract: the transport that carries a procedure, the modules that
implement one, and the rules each module owns. Written for Task 12's surface — parking spots,
users, personal settings, the reservation window, the day overview and the audit log. Reservations
and the waitlist (Task 13) plug into the same transport and are documented with their own task. The
ICS feed (Task 14 — this file said "Task 17", which was wrong) does **not**: it is the single
controller outside the contract, and it has its own document, `doc/ics.md`, plus §12 below.

Companion documents: `doc/contract.md` (the procedures and their schemas), `doc/auth.md` (who the
caller is and how they are gated), `doc/database.md` (the schema and its constraints),
`doc/api-operations.md` (logging, health, shutdown, the exception filter), `doc/ics.md` (the ICS
feed, the one controller outside the contract).

---

## 1. The transport

Every procedure in `libs/garage/contract` is served over oRPC's **RPC protocol** at

```
POST /api/rpc/<procedure/path/with/slashes>
```

so `admin.spot.create` is `POST /api/rpc/admin/spot/create`, with the request body
`{ "json": <input>, "meta": [] }` and the response `{ "json": <output> }`. That is exactly what
`libs/shared/api-client`'s `RPCLink` sends and reads; nothing in `apps/garage/web` constructs these URLs by hand.

Three files carry it, all in `apps/garage/api/src/orpc/`:

| File                   | What it owns                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rpc-route.ts`         | `RPC_ROUTE_PREFIX`, `RPC_PATH_PREFIX` (`/api/rpc`) and `rpcRoute(...segments)`. The single definition of where a procedure lives.   |
| `implementer.ts`       | `implement(contract).$context<OrpcContext>()` plus the middleware that maps thrown errors. Every procedure is built from it.        |
| `rpc-route-handler.ts` | One `RPCHandler`, mounted with `prefix: RPC_PATH_PREFIX`; `handle()` throws `NotFoundException` when the path matches no procedure. |

**A procedure is reachable only when a Nest route exists for it.** The controller method is where
authorization lives, so each procedure gets its own `@Post(rpcRoute(...))`:

```ts
@Roles('ADMIN')
@Post(rpcRoute('admin', 'spot', 'create'))
createSpot(
  @Req() request: Request,
  @Res() response: Response,
  @CurrentUser() user: AuthenticatedUser
): Promise<void> {
  return this.rpc.handle(request, response, user);
}
```

Why one route per procedure rather than one wildcard, and why the RPC protocol rather than
`@orpc/nest`'s `@Implement`: `doc/decision/0057-*`.

### Keeping the routing table honest

`apps/garage/api/src/orpc/orpc-route-parity.spec.ts` walks the contract router and, for every procedure,
asserts that

- a Nest route exists at `rpcRoute(...)`'s path, or the procedure is named in
  `NOT_YET_IMPLEMENTED` (the six Task 13 / Task 17 procedures);
- the route is a `POST`;
- the route's `@Roles` metadata is `['ADMIN']` for every `admin.*` procedure, and **absent** for
  every other one.

A procedure implemented but not mounted, or mounted without its guard, fails this spec. Deleting a
single `@Roles('ADMIN')` produces `Expected: ["ADMIN"] / Received: undefined` — the check has been
exercised by removing one, not merely written.

### Authentication and authorization

Unchanged from Task 11 and `doc/auth.md`. `JwtAuthGuard` is global, so every RPC route requires a
valid Okta token unless marked `@Public()` (none are). `RolesGuard` reads `@Roles('ADMIN')` from
the route. `@CurrentUser()` yields the `AuthenticatedUser`, which becomes the oRPC context:

```ts
export interface OrpcContext {
  readonly user: AuthenticatedUser;
}
```

**Nothing in a service reads a user id from the payload.** `me.*` has no user id in its input at
all; the admin procedures take the _subject's_ id and get the _actor's_ from the context. There is
no request shape that lets one user act as another.

### How an error becomes a response

Services throw `DomainError`; Prisma throws its own. Both are translated, and where the translation
happens depends on where the throw happened:

- **Inside a procedure** — `implementer.ts`'s middleware catches it, `toOrpcError()` maps it to an
  `ORPCError` with the status from `ERROR_DEFINITIONS`, and oRPC serialises it. Anything it cannot
  map is rethrown and becomes a logged 500.
- **Before the procedure** (a guard, the body parser, the throttler) — `ContractExceptionFilter`
  handles it. On an `/api/rpc` path it wraps a contract body in `{ json: … }` so the client can
  read the `code`; transport failures keep Nest's shape. See `doc/decision/0058-*` and
  `doc/decision/0033-*`.

The two paths produce byte-identical bodies for the same contract error, which is asserted in
`orpc-pipeline.spec.ts` — a `FORBIDDEN` from `RolesGuard` and a `CONFLICT` from a service both
arrive as `{ "json": { "code": …, "status": … } }`.

**`P2002` is read from the driver adapter, not from `meta.target`.** Prisma documents `target`;
Prisma 7 with `@prisma/adapter-pg` does not populate it, and puts the violated index under
`meta.driverAdapterError.cause.constraint.index` instead. Both are read, `target` first. This is
what lets `Reservation (parkingSpotId, date)` arrive as `SPOT_ALREADY_RESERVED` rather than the
vague `CONFLICT` every unique violation used to degrade to; the shape is pinned against a real
server (§11).

**Stack traces are logged and never sent — and a 4xx does not log one either.** A framework 4xx
(no such route, a malformed body, a throttled caller) is logged at `warn` with the status, method,
path and reason, and _without_ `err`: those frames are `@nestjs/core` router internals that answer
nothing, and 404 is the most common status on a public endpoint, so a scanner walking URLs would
otherwise write a multi-kilobyte log line per probe. A `DomainError` keeps its stack, because there
the frames name the service and the rule that refused; so does every 5xx.

---

## 2. Storage ↔ contract mapping

`apps/garage/api/src/common/prisma-mapping.ts` is the only place a Prisma row becomes a contract object.
Three conversions are worth knowing:

| Function              | Rule                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `toTimestamp(date)`   | `Date` → ISO 8601 string. For `@db.Timestamptz` columns.                        |
| `toDateOnly(date)`    | A `@db.Date` column's `Date` → `YYYY-MM-DD`, read with **UTC** getters.         |
| `toDateColumn(value)` | `YYYY-MM-DD` → `new Date('…T00:00:00.000Z')`, for querying a `@db.Date` column. |

**`toDateOnly` is not `toDateOnlyInPrague`.** They are different functions for different inputs:
`toDateOnly` reads a zoneless calendar day out of a `@db.Date`, `toDateOnlyInPrague` converts an
instant to the day it fell on in Prague. `prisma-mapping.spec.ts` pins the distinction with an
instant where they disagree.

For the `@db.Date` direction specifically, they happen to **agree**, and it is worth saying so
plainly rather than leaving a vague warning in place. Prague is UTC+1 or UTC+2 — always _ahead_ of
UTC — so the UTC midnight a `@db.Date` produces is 01:00 or 02:00 on the **same** calendar day in
Prague; the day is never moved forward. (Measured, not reasoned: both DST Sundays, a leap day, a
new year and both offsets all agree.) `toDateOnly` is still the right call here because it is the
one that says what the value _is_ — a calendar day, not an instant — but that is a clarity choice,
not a bug fix, and code that used the other one would not be wrong about any date.

The projections are equally deliberate:

- `toContractUser` — the caller's own profile, **including** `icsToken`.
- `toAdminUser` — the same minus `icsToken`. An admin listing users has no business holding
  everyone's calendar credential; the spec asserts the two shapes differ by exactly that key.
- `toUserSummary` — `{ id, name, licensePlate }`, what other people see on an occupied spot.

---

## 3. `AuditLogService`

`apps/garage/api/src/audit/audit-log.service.ts`. One method:

```ts
record(entry: AuditEntry, writer: AuditLogWriter = this.prisma.client): Promise<void>
```

**Append-only is enforced by the database, not by this class.** Two triggers from the init
migration reject `UPDATE`, `DELETE` and `TRUNCATE` on `AuditLog` (`doc/decision/0027-*`). The
absence of update/delete methods here is a convenience; the trigger is the guarantee, because a
service method is a rule anybody can route around with `prisma.client.auditLog.deleteMany`.

**`writer` is a parameter because Task 13 needs it.** Cancelling a reservation and promoting the
next person in the queue happens in one interactive transaction; the entry claiming it happened
must roll back with it. Passing `Prisma.TransactionClient` puts the write inside. `AuditLogWriter`
is `Pick<PrismaClient, 'auditLog'>` — structural, so both clients satisfy it without this module
naming the transaction type.

`entityType` is narrowed to `AUDIT_ENTITY_TYPES` rather than the contract's `string`: a typo in a
free string would split one entity's history in two and nothing would fail. `payload` is
`Prisma.InputJsonObject`, not `Record<string, unknown>` — the column is `JSONB`, and a `Date`, a
class instance or an `undefined` has no representation in it.

### What is written, and what is never written

| Action                       | Written by                                      | Payload                                                                            |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SPOT_UPDATED`               | `SpotsService.create` / `update` / `deactivate` | `change: 'created' \| 'updated' \| 'deactivated'`, plus before/after for an update |
| `USER_UPDATED`               | `UsersService.adminUpdate`                      | `change: 'admin-updated'`, before/after `{ role, active }`                         |
| `USER_UPDATED`               | `MeService.updateSettings`                      | `change: 'settings'`, before/after `{ licensePlate, preferredParkingSpotId }`      |
| `USER_UPDATED`               | `MeService.regenerateIcsToken`                  | `change: 'ics-token-regenerated'` — **never the token**                            |
| `RESERVATION_WINDOW_UPDATED` | `ReservationWindowService.updateSettings`       | before/after `{ openDaysBefore, lockMode }`                                        |
| `RESERVATION_LIMITS_UPDATED` | `ReservationLimitsService.updateSettings`       | before/after `{ monthlyReservationCap }`                                           |

`RESERVATION_WINDOW_UPDATED` is new in Task 12, in both the contract enum and the Prisma enum:
`doc/decision/0059-*`. `RESERVATION_LIMITS_UPDATED` is the same shape, added when the monthly cap
became its own settings singleton (`doc/decision/0312-*`).

Two omissions are intentional. **The ICS token never appears in a payload** — it is the only
credential on the personal calendar feed, and an append-only table nobody can redact is the worst
place for it. **A no-op writes nothing**: deactivating an already-inactive spot returns it
unchanged and records nothing, because auditing a non-event puts noise into the one table that is
supposed to answer "what actually changed".

---

## 4. Parking spots

`apps/garage/api/src/spots/`. Routes: `spot.list` (any authenticated user), `admin.spot.list`,
`admin.spot.create`, `admin.spot.update`, `admin.spot.deactivate`.

**A spot is never deleted** (`doc/decision/0027-*`): `Reservation` and `WaitlistEntry` reference it
`ON DELETE RESTRICT` and `AuditLog` names it by id. Retiring one is `active: false`.

- **Ordering** is `group` then `label`, everywhere, from one constant. The day overview renders a
  grid, and a grid whose cells move between two reads of the same day is unusable.
- **`spot.list` returns active, non-hidden spots only.** `admin.spot.list` takes `includeInactive` and an
  optional `group`.
- **A duplicate label is left to the unique index**, not pre-checked: a read-then-write would still
  lose a race, and the constraint is what actually decides. `P2002` arrives at the client as
  `CONFLICT`.
- **Retiring a spot that still has reservations is refused** with `CONFLICT` and
  `details.reservations`. "Still has" means `date >= today` in Europe/Prague — `>=`, not `>`,
  because a reservation for _today_ is one somebody has already parked on.
- **`update({ active: false })` is held to the same rule.** Otherwise it would be the way around
  the check, which is how a spot ends up retired with people still holding it.
- **`deactivate` is idempotent.**

---

## 5. Users (admin)

`apps/garage/api/src/users/`. Routes: `admin.user.list`, `admin.user.update`.

Users are never created here — they are provisioned from the Okta token on first sign-in
(`doc/auth.md`) — and never deleted. Offboarding is `active: false`, and a deactivated user is
refused at the guard with `FORBIDDEN` on their next request.

`search` matches name **or** email, case-insensitive substring. The contract leaves "how" to the
backend; a substring match on the two fields an admin can see is what a search box implies.

### The two lock-outs, both refused

Neither is recoverable through the API: there is no sign-up, no role bootstrap and no way to
promote anybody without already being an admin. Somebody would have to open the database by hand.

1. **Removing the last active admin**, by demotion or deactivation → `CONFLICT`.
2. **Deactivating yourself** → `CONFLICT`, even when other admins remain. The intent is almost
   always a mis-click on the wrong row, and the cost of being wrong is losing your own session
   mid-task. Another admin can still do it, which is the right shape for an offboarding anyway.

Demoting _yourself_ while another admin exists is allowed — a deliberate step down, with rule 1
still covering the dangerous version.

**Known race, accepted.** The "last active admin" check is a count followed by an update. Two
admins demoting each other in the same instant could leave zero. Serialising every role change buys
nothing against a scenario that needs simultaneous requests from two of the handful of admins on a
single-instance deployment.

Be clear about what it would cost, though: **there is no way back through the API.** Every route
that could restore an admin is itself admin-only, and Okta provisions new users as `USER`.
Recovery requires **direct database access** —

```sql
UPDATE "User" SET role = 'ADMIN', active = true WHERE email = '…';
```

— which on a production deployment means someone with database credentials, out of hours, on the
one day nobody can log in. Recorded here rather than hidden, so the trade-off can be re-taken with
the real number in view.

---

## 6. Personal settings

`apps/garage/api/src/me/`. Routes: `me.get`, `me.updateSettings`, `me.regenerateIcsToken`.

The subject is always `context.user`. None of the inputs carries a user id.

**`updateSettings` is three-valued** per field: an absent key leaves it alone, `null` clears it, a
value sets it. `input.licensePlate !== undefined` is what tells "absent" from "clear" — Zod's
`.optional()` omits an absent key entirely, and JSON cannot transmit `undefined`, so `null` is
unambiguous. `preferredParkingSpotId` becomes a Prisma `connect` or `disconnect` accordingly.

A preferred spot must exist (`NOT_FOUND`) **and** be active (`VALIDATION_FAILED`). Two codes,
because they are two situations for the person at the screen: an id that does not exist is a stale
client, while a retired spot is a real spot they can see was taken out of service.

**`regenerateIcsToken` retries a `P2002` up to `MAX_ICS_TOKEN_ATTEMPTS` (3) times.** The contract
declares no error on this procedure (`doc/decision/0021-*`): a collision between two 32-byte random
values is not a state a client can act on, and the UI has no copy for it. An unresolvable collision
rethrows the real Prisma error and becomes a logged 500 — which is what a 1-in-2²⁵⁶ outcome should
look like. The old feed URL stops working immediately.

---

## 7. Reservation window

`apps/garage/api/src/reservation-window/`. Routes: `admin.window.get`, `admin.window.update`,
`admin.window.months`. Also used internally by the day overview.

**Nothing in this module decides whether a month is open.** `monthLockState()` / `isMonthOpen()`
and `reservationWindowRange()` in `@garage/shared-types` (Task 3) transcribe the approved
design's `monthOpen` function and have their own tests. This service loads the settings, asks
today's date in Europe/Prague, calls those functions and shapes the answer. Re-deriving the rule
here — even "just the easy case" — is how the banner and the backend start disagreeing about the
same day. `reservation-window.service.spec.ts` asserts the delegation directly, comparing every
month it returns against `monthLockState` called with the same arguments.

`windowFrom` / `windowTo` are **always** the range the AUTO rule would produce, even when
`lockMode` overrides the state — the UI needs them to explain what the automatic rule would have
done, and reads `lockMode` to know whether it applies.

**The settings row is upserted, and a missing one reads as the documented defaults.** It is a
singleton with a fixed id and a `CHECK ("id" = 1)` constraint (`doc/decision/0026-*`), created by
the seed. A deployment whose seed had not run would otherwise answer `admin.window.get` with a 500,
and the honest value for "no row yet" is not an error — it is the defaults, which is what the row
would have contained.

`update` is a **replacement**, not a patch: the contract's input is the settings schema itself, so
an omitted field has already been filled with its default before it arrives.

---

## 8. Reservation limits

`apps/garage/api/src/reservation-limits/`. Routes: `admin.reservationLimits.get`,
`admin.reservationLimits.update`. Both `@Roles('ADMIN')`, the same as every route in §7.

Built the same way as §7's pair, deliberately — a second singleton settings surface rather than a
column on `ReservationWindowSettings` (`doc/decision/0312-*`): the window decides whether a month is
open to anybody, this decides how much one person may take while it is, and the two settings never
shared an identity to begin with.

**The settings row is upserted, and a missing one reads as the documented default** — the same
reasoning as §7's, and the same reason: a deployment whose seed had not run would otherwise answer
`admin.reservationLimits.get` with a 500, and the honest value for "no row yet" is the default,
which is what the row would have contained.

`update` is a **replacement**, not a patch, same as `admin.window.update`.

**This module is not in the enforcement path.** The cap that actually rejects an over-quota insert
is loaded by `readMonthlyReservationCap` inside the writer's own transaction
(`apps/garage/api/src/reservations/monthly-reservation-cap.ts`), not through this service —
`ReservationLimitsService` serves the admin screen and the month summary
(`reservation.myMonth` / `admin.reservation.month`'s `cap` field), both of which are plain reads
outside any transaction. `ReservationLimitsModule` exports the service for exactly that second
consumer.

---

## 9. Day overview

`apps/garage/api/src/overview/`. Route: `overview.day`, any authenticated user.

One request paints the whole parking screen: the grid, the queue badges, the caller's own position
and the reservation-window banner. A screen assembled from four round trips can render a day's grid
against a window it fetched a second earlier, and the two would disagree exactly when it matters —
at the moment a month opens or closes.

Four reads run in parallel: active spots, the window settings, the day's reservations (with the
holder's summary) and the day's waitlist **whole**, ordered by `createdAt` then `id`. The queue is
counted in memory because three of the five per-spot fields come from those same rows — the count,
whether the caller is queued, and their position. A `groupBy` for the counts plus a second query
for the position would be two reads of the same data with nothing keeping them consistent, and the
position _is_ the row order — the same order Task 13 promotes in.

### `canReserve` and `canReserveMonth`

Two booleans, because two different screens ask two different questions. They are one composition of
two private halves:

```
canReserveMonth = role === 'ADMIN' || isMonthOpen(date, openDaysBefore, lockMode, today)
isReservableDay = date >= today && isBusinessDay(date)

canReserve      = canReserveMonth && isReservableDay
```

- **`canReserveMonth`** — whether this caller may reserve **anywhere in the month** `date` falls in:
  the window and the admin exemption, and nothing about `date` itself. Admins are exempt from the
  reservation window (`plan.md` §Byznys pravidla, `doc/decision/0004-*`).
- **`isReservableDay`** — a past day, or a weekend or Czech public holiday, is not bookable by
  anyone. The lot is a workplace car park (`isBusinessDay`). The admin exemption is in the _other_
  half, so it cannot rescue a Saturday.
- **`canReserve`** — whether this caller may reserve **this** day: both halves.

`canReserve: false` alongside `canReserveMonth: true` is therefore a perfectly ordinary payload —
every weekend and every holiday of an open month — not a contradiction.

**The frontend must not re-derive either from `window`.** The admin exemption does not appear
anywhere in the payload, so a client computing the answer from the window alone would hide it. Nor
may a month-scoped screen fall back to `canReserve`: it says "no" on a third of the calendar of an
open month, which is how the bulk modal first shipped and what `doc/decision/0175-*` records.

Deliberately _not_ folded in: whether the caller already holds a reservation that day. That is the
one-per-day rule, enforced by a unique constraint at write time, and the screen can see it directly
in `viewerReservationId`. Including it would make `canReserve` mean two things at once.

---

## 10. Reservations and the waitlist

`apps/garage/api/src/reservations/`. Routes: `reservation.create`, `reservation.cancel`,
`reservation.myMonth`, `waitlist.join`, `waitlist.leave`, plus the bulk pair below — open to any
authenticated user, because "may I cancel this?" is a fact about a row, not about a route, and
lives in the service with the row. `admin.reservation.month` is the exception: reading somebody
else's month _is_ a rule about the route, since there is no row-level decision left to make once
the subject is a parameter, so it is `@Roles('ADMIN')`.

**`doc/waitlist.md` is the document for this module.** It has the cancel + promote sequence diagram,
why the queue is read `FOR UPDATE`, what happens under concurrency, and what happens after the
commit. Only the shape is repeated here:

- `ReservationPolicy` — day eligibility: past day, business day, reservation window. The one part of
  the module that is pure, and the only one with a non-database spec.
- `ReservationsService` — `create` (guarded insert), `cancel` (delete + audit + promote in one
  interactive transaction, retried on the two conflicts a retry can clear).
- `WaitlistPromotionService` — takes a `Prisma.TransactionClient`, never `PrismaService`: the
  promotion and the cancellation that freed the spot share a fate or neither is correct.
- `WaitlistService` — `join` / `leave`.
- `DomainEventPublisher` — the after-commit seam. Bound to `CompositeDomainEventPublisher`, which
  fans out to Tasks 15's Socket.io broadcast and Task 16's outbound Slack notification, each call in
  its own `try` (`doc/decision/0135-*`). Nothing that can block on the network runs inside the
  transaction.

### Bulk booking

`reservation.previewBulk` / `reservation.confirmBulk`, added by Task 30 on their own controller
(`BulkReservationController`) for the same reason the waitlist has one: a controller here delegates
to exactly one service. Both are open to any authenticated caller — the batch is always written for
`context.user`, so there is no "somebody else's booking" to authorize.

**`doc/bulk-reservation.md` is the document for this half of the module.** It has the allocator's
preference order, why the preview writes nothing, the shape of the transaction and the deadlock
analysis. Only the shape is repeated here:

- `bulk-allocator.ts` — **pure**: a snapshot of the world in, a plan out. No database, no
  transaction, no clock, which is why the preference order has an ordinary unit spec.
- `BulkReservationService` — `preview` (reads, writes nothing) and `confirm` (one interactive
  transaction for the whole batch, events published after it commits).

Two things worth knowing before reading either: a weekend inside a bulk request is a **per-day**
`UNAVAILABLE`, not a rejected request (`doc/decision/0090-*`), and the confirmation never lets a
statement fail — it inserts with `ON CONFLICT DO NOTHING` and reads the difference
(`doc/decision/0092-*`).

`NOT_YET_IMPLEMENTED` in the parity spec (§1) is now empty: every procedure the contract declares
has exactly one route.

---

## 11. Testing

Unit specs sit beside each service and run against `apps/garage/api/src/testing/prisma-double.ts` — an
in-memory stand-in for `PrismaService` that copies every row it returns (a live reference would
make a before/after audit payload compare a row against itself), raises a **real**
`PrismaClientKnownRequestError` with `code: 'P2002'` and a populated `meta.target` for unique
violations, and throws on any query shape it does not model, so an untested access pattern fails
loudly instead of quietly returning `[]`.

**The reservations module (§9) is the exception, and deliberately so.** Its correctness is
`FOR UPDATE`, transaction isolation and the exact shape of a `P2002` — none of which a double can
model, and the last of which this project has already shipped a defect from faking. Everything
there except `ReservationPolicy` is tested against a real PostgreSQL under `api:test-db`.

Two specs test the composition rather than a service:

- **`orpc-route-parity.spec.ts`** — the routing table against the contract (§1).
- **`orpc-pipeline.spec.ts`** — the assembled `AppModule` over real HTTP with real tokens from an
  in-process OIDC issuer. It covers what unit tests structurally cannot: that Nest's body parser
  and oRPC's codec agree on where the body is, that `@Roles('ADMIN')` actually fires on an oRPC
  route, that a refused caller's handler never runs, and that a rejection arrives in the RPC
  envelope from both the filter and oRPC itself.

Four claims were verified by breaking them and watching the tests fail, then restoring:

| Claim removed                                                                 | Result                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The audit write in `SpotsService.create`                                      | 2 failures across the spots spec and the pipeline spec (`Received: Array []`)                            |
| The `monthLockState` delegation, replaced by a hand-rolled rule               | 2 failures; the delegation test reported `["OPEN", …]` against `["LOCKED", "LOCKED", "NOT_YET_OPEN", …]` |
| `@Roles('ADMIN')` on `admin.spot.list`                                        | 2 failures; parity `Expected ["ADMIN"], Received undefined`, pipeline `Expected 403, Received 200`       |
| `admin.spot.list`'s implementation swapped for `create`'s, route left mounted | 1 failure; the schema-identity check in the parity spec                                                  |

### The database-contract suite

`src/database/database-contract.db.spec.ts` runs against a **real PostgreSQL 17**, and exists
because of a defect no double could see. `PrismaDouble` fabricated `P2002` with a `meta.target`
key; `@prisma/adapter-pg` emits no such key, putting the constraint under
`meta.driverAdapterError.cause.constraint.index` instead. Every unit test of the mapping passed,
and every real unique violation degraded to the vague `CONFLICT` — including
`SPOT_ALREADY_RESERVED`, which `plan.md` names as the concurrency guarantee of the whole
reservation flow. Nothing short of a real connection could have caught it.

The suite provokes each constraint and each trigger against the server, inside transactions that
are always rolled back, so it leaves the database exactly as it found it — which is also the only
way to test an append-only table at all. It covers both `Reservation` unique constraints, the
`WaitlistEntry` one, `ParkingSpot.label`, `User.email`, the `AuditLog` `UPDATE`/`DELETE` triggers,
the `CHECK ("id" = 1)` singleton, and — added by Task 13 — the shape of a real **deadlock**
(`P2034` carrying `40P01`), which the cancellation path retries.

Task 13 added three more `*.db.spec.ts` files under the same target, and with them a
`globalSetup` that gives the whole run its **own throwaway database**
(`doc/decision/0066-*`): its concurrency cases have to commit to race at all, and a committed
`AuditLog` row can never be deleted. The developer's `garage` is no longer written to by any of
this, including the rollback-based suite above.

```
docker compose --profile dev up -d
nx run api:test-db
```

Nx loads `.env`, so `DATABASE_URL` is already in place for that target; running the config through
`jest` directly needs it passed.

The role in `DATABASE_URL` needs `CREATEDB`: `globalSetup` creates the throwaway
database itself rather than reusing `garage` (`doc/decision/0066-*` §Risk).
The `docker compose --profile dev` Postgres already grants it to the seeded
role; a role provisioned any other way (a shared server, a hand-rolled local
Postgres) needs `ALTER ROLE <role> CREATEDB` or the suite fails at
`globalSetup` with a raw Postgres permission error and no further guidance.

It is **excluded from `nx run-many -t test`** (`testPathIgnorePatterns` in
`apps/garage/api/jest.config.cts`) so that suite stays runnable without Docker, and it **refuses to skip
itself** when `DATABASE_URL` is missing — it fails, with a message saying how to start the
database. A suite that skips into green is the failure mode this file exists to remove, and the
refusal has been exercised (`DATABASE_URL= jest --config apps/garage/api/jest.database.config.cts` exits
1, not 0).

### Still not exercised

- ~~**Concurrency.**~~ **Closed by Task 13.** `waitlist-concurrency.db.spec.ts` runs real parallel
  transactions: eight simultaneous creates for one cell produce one reservation and seven
  `SPOT_ALREADY_RESERVED`, and two forced interleavings cover the queue's row lock and the
  promotion retry. Both mechanisms were verified by deleting them and watching the suite go red.
- **`PrismaDouble` itself** has no spec of its own. Its `P2002` shape is now transcribed from the
  live server and re-asserted there on every `api:test-db` run, so that particular fiction cannot
  return unnoticed — but the rest of its behaviour is still defined only by the specs that consume
  it.
- **The enum migration's effect**, server-side. It has been applied, but nothing asserts
  `AuditLogAction`'s membership in the database afterwards.

---

## 12. The ICS feed

`apps/garage/api/src/calendar/`. Route: `GET /api/calendar/:icsToken.ics` — **not** a contract procedure,
and the only route in the application that is not. Full write-up in `doc/ics.md`; what matters when
reading the rest of this file:

- It is `@Public()` and `@StrictThrottle()`. The 32-byte `randomBytes` token in the path is the
  whole credential, so this is the one route an unauthenticated stranger can reach with input of
  their choosing.
- **Every unservable token is a `404` with a constant body**, including a _deactivated_ user's
  otherwise valid token — the `active: true` filter sits in the `WHERE` clause so that case takes
  the identical code path. A 401 would let somebody enumerate tokens by response code:
  `doc/decision/0080-*`.
- **The response headers are set inside the handler**, after the lookup. `@Header()` decorators run
  before it, and would have marked every rejection with `Content-Type: text/calendar`.
- The rendered document is a pure function of the data (`DTSTAMP` is the reservation's `createdAt`),
  which is what lets Express `ETag` it and answer a poller with `304`: `doc/decision/0081-*`.
- `ical-generator` is imported **only** by `libs/garage/calendar-export`, enforced by
  `eslint.config.mjs`'s `WRAPPED_LIBRARIES` and probed from two directions.

### `PrismaDouble` grew two query shapes for it

`user.findFirst({ where: { icsToken, active: true } })` and
`reservation.findMany({ where: { userId, date: { gte } }, include: { parkingSpot }, orderBy })`.

One correction came with them, and it is the kind this file exists to record: the reservation
delegate used to sort by date **unconditionally**, so deleting `CalendarService`'s `orderBy` changed
nothing and every test still passed. It now sorts only when an `orderBy` is passed, refuses any
ordering it does not model, and otherwise returns insertion order — which is the closest honest
stand-in for a Postgres that was given no `ORDER BY`.
