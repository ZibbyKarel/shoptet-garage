# Contract – structure, rules, how to add a schema

`libs/garage/contract` is the **single source of truth** for every data shape that
crosses the frontend ↔ backend boundary. No endpoint, DTO, or realtime event
may exist in code before it exists here.

This document was established by Task 3 (entities, primitives, the error
contract); Task 4 added the oRPC procedures and Task 5 the realtime events.

---

## Two libs, a sharp division

| lib                        | tags                                            | what it is                                                    | what it **must not** contain                               |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `libs/garage/shared-types` | `type:util`, `scope:shared`, `layer:foundation` | domain constants and pure date-only logic for `Europe/Prague` | Zod, next-intl, any runtime dependency                     |
| `libs/garage/contract`     | `type:contract`, `scope:shared`                 | Zod schemas + the oRPC contract + realtime events             | anything from npm besides `zod`, `@orpc/contract`, `tslib` |

The split isn't cosmetic. `libs/garage/shared-types` is imported by both `apps/garage/api`
and `libs/shared/i18n`, so it must not pull in Zod or frontend libraries (see
`doc/decision/0003-*`). `libs/garage/contract`, conversely, must not reach for
transport — which is why ESLint only allows it `@orpc/contract`, never
`@orpc/client` or `@orpc/server` (see `doc/decision/0007-*`).

The dependency runs one way only: **`contract` → `shared-types`**, never the
reverse.

---

## Structure of `libs/garage/contract`

```
libs/garage/contract/src/
  index.ts                  entry point @garage/contract
  schemas/
    primitives.ts           idSchema, dateOnlySchema, yearMonthSchema, timestampSchema
    enums.ts                Zod wrappers around the domain enums from shared-types
    entities.ts             User, ParkingSpot, Reservation, WaitlistEntry, AuditLog
    reservation-window.ts   ReservationWindowSettings, MonthWindowOverview
    errors.ts               ERROR_CODES, errorCodeSchema, errorDetailsSchema, errorShapeSchema
    index.ts                barrel
  api/                      oRPC procedures (Task 4)
    errors.ts               ERROR_DEFINITIONS, contractErrors(), the `authed` builder
    overview.ts             the day overview
    reservations.ts         create, cancel
    bulk.ts                 previewBulk, confirmBulk
    waitlist.ts             join, leave
    spots.ts, users.ts      spot and user administration
    me.ts                   profile, settings, ICS token regeneration
    ics.ts                  constants and a helper for the ICS URL (the feed is outside oRPC)
    reservation-window.ts   admin management of the reservation window
    router.ts               `contract` — the entire router
    index.ts                barrel
  realtime/                 entry point @garage/contract/realtime
    events.ts               payloads for server → client events
    commands.ts             payloads for client → server commands + the cell:lock ack
    event-maps.ts           the schema registry + ServerToClientEvents / ClientToServerEvents
    rooms.ts                roomForDate(), DAY_ROOM_PREFIX
    index.ts                barrel
  __fixtures__/             test fixtures, excluded from tsconfig.lib.json
```

The schemas in `schemas/` are shared by both branches (`api/` and
`realtime/`) — that's why they don't live in either one. Specifically, two
projections live there too, not just bare entities: `userSummarySchema` (how a
user looks to **another** user) and `publicReservationSchema` (a reservation
as the whole day sees it). Both the day overview and the realtime broadcast
need them, and `src/realtime` must not import from `src/api`.

`fixtures.ts` deliberately sits in `__fixtures__/`, which `tsconfig.lib.json`
excludes — it wasn't enough on its own that nothing re-exports it, since it
was still part of the lib's compiled program.

---

## Why types are derived

Every type comes from `z.infer`; it is never hand-written next to a schema:

```ts
export const reservationSchema = z.object({
  /* ... */
});
export type Reservation = z.infer<typeof reservationSchema>;
```

A hand-written type next to a schema is a duplicate that drifts silently: the
schema changes, the type doesn't, TypeScript stays quiet, and the bug only
shows up at runtime in production. A derived type can't drift.

When a schema **transforms** (typically `.default()`), distinguish:

- `z.infer<T>` = `z.output<T>` – the shape **after** validation, with defaults
  filled in,
- `z.input<T>` – the shape **before** validation, where fields with a default
  are optional.

`reservationWindowSettingsSchema` exports both
(`ReservationWindowSettings`, `ReservationWindowSettingsInput`), because the
admin form sends the input shape while the service layer works with the
output shape.

One exception that isn't really an exception: enum values (`PARKING_GROUPS`,
`USER_ROLES`, …) live in `libs/garage/shared-types` as an `as const` tuple, and the
contract just wraps them (`z.enum(PARKING_GROUPS)`). The values therefore
still live in one place, and the type in the contract stays derived. A test
in `enums.spec.ts` also type-checks that the two sides haven't drifted apart.

---

## Dates and time

| what                | schema                                 | note                                                     |
| ------------------- | -------------------------------------- | -------------------------------------------------------- |
| the reservation day | `dateOnlySchema` (`z.iso.date()`)      | `YYYY-MM-DD`, `DATE` in Postgres, never a timestamp      |
| a month             | `yearMonthSchema`                      | `YYYY-MM`                                                |
| a timestamp         | `timestampSchema` (`z.iso.datetime()`) | an ISO string in UTC, not `Date` (`doc/decision/0015-*`) |

`dateOnlySchema` validates **format and calendar validity** (neither
`2023-02-29` nor `2026-04-31` passes) — and **nothing else**. Specifically it
does not validate:

- that the day isn't in the past,
- that the day falls inside the open reservation window.

Both are **service-level** checks (Task 13), since the window depends on
`ReservationWindowSettings` read from the database, which a static schema
can't see. The old horizon from `plan.md` ("until the end of the following
month") was replaced by `doc/decision/0004-*`.

Computing the month state is done by the pure function `monthLockState()` /
`isMonthOpen()` in `libs/garage/shared-types`. It's deliberately **descriptive
only** — it enforces nothing. An automatic waitlist promotion is a system
action, and the lock doesn't apply to it, which works only because the
caller simply never invokes it.

---

## The error contract

The backend never returns an ad-hoc error shape. Everything goes through
`errorShapeSchema`:

```ts
{ code: ErrorCode, message: string, details?: Record<string, unknown> }
```

`ERROR_CODES` is a closed enum of twelve codes. The frontend branches on
`code`; `message` is detail for logs and unexpected cases, and the Czech UI
copy is keyed by code (`libs/shared/i18n`).

Two "window" codes are deliberately distinguished, because they tell the user
something different:

| code                  | target month's state | what happened                                                        |
| --------------------- | -------------------- | -------------------------------------------------------------------- |
| `OUT_OF_HORIZON`      | `NOT_YET_OPEN`       | reservations for that month aren't open yet                          |
| `RESERVATIONS_LOCKED` | `LOCKED`             | the window has already closed (including any month that has started) |

Both are returned by the service layer based on `monthLockState()`, never by
a schema.

This contract maps onto oRPC 1:1 — `details` and oRPC's `data` are the same
field. The code definitions (HTTP status, default message) are in
`api/errors.ts`; details in
`doc/decision/0018-mapping-error-contract-to-orpc.md`.

---

## oRPC procedures

The router is a single object, `contract`, in `api/router.ts`. **The grouping
is an authorization boundary:** everything under `admin.` requires
`role: 'ADMIN'`; everything else just needs an active user.

That file exports two types alongside it: `Contract` (the router object's own
type) and **`ContractClient`** — the same router seen from the caller's side,
i.e. `ContractRouterClient<Contract>` already applied. `libs/shared/api-client` types
its client as `ContractClient` and never imports `@orpc/contract` itself, which
keeps that package allow-listed for the `type:contract` tag alone rather than
for every wrapper lib. See `doc/decision/0040-*`.

**Every** procedure declares `FORBIDDEN` — it sits on the shared `authed`
builder, because a deactivated user (`active: false`, which is how
offboarding works) is rejected before any handler runs. It therefore isn't
repeated in the tables below; a `—` in the errors column means "nothing
beyond `FORBIDDEN`".

**Every procedure has an input schema, even one with no arguments.** oRPC
allows `.input()` to be omitted, but an omitted schema means an accidentally
sent payload is silently discarded. The five argument-less procedures
(`overview` doesn't have one; the others are `spot.list`, `me.get`,
`me.regenerateIcsToken`, `admin.window.get`, `admin.reservationLimits.get`)
therefore declare the shared
`noInputSchema` from `api/errors.ts` – it accepts `undefined` (how a call
arrives via RPC) as well as `{}` (how a GET with no parameters arrives via
OpenAPI), but rejects anything with a key. In the tables, their input is
written as `—`.

**When `VALIDATION_FAILED` occurs.** It means "the request is structurally
fine, but it violates a domain rule that requires a database lookup" — not a
bad format, which the schema catches and oRPC returns as its own error. Every
procedure that declares it has a specific trigger:

| procedure                                            | what triggers it                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `reservation.create`, `waitlist.join`                | the spot exists but is deactivated                                     |
| `reservation.create`, `waitlist.join`                | `date` isn't a business day (a weekend or a Czech public holiday)      |
| `reservation.previewBulk`, `reservation.confirmBulk` | the same, for the user's preferred spot                                |
| `me.updateSettings`                                  | the preferred spot is deactivated                                      |
| `admin.spot.create`, `admin.spot.update`             | `group` outside the parking lot's allowed set of groups                |
| `admin.user.update`                                  | a role change that can't be made (the last admin)                      |
| `admin.window.update`                                | a combination of `openDaysBefore` and `lockMode` that can't be applied |

`waitlist.join` appears twice in the table deliberately: both rules can only
be discovered from the database (a deactivated spot) or the holiday calendar,
and the schema can't catch either. That `date` must be a business day follows
from `canReserve` (see below) — a single-day reservation for a Saturday or for
September 28th must therefore fail, and `VALIDATION_FAILED` is the only
declared code that fits.
(Bulk reservation handles this differently: there, a non-business day is a
per-day `UNAVAILABLE` / `NOT_A_BUSINESS_DAY` result inside a successful
response, not an error for the whole batch.)

`admin.window.months` **does not declare** `VALIDATION_FAILED`. The
`from`–`to` range is entirely guarded structurally: `from <= to` via a
refinement, and the range length against `MAX_MONTH_WINDOW_SPAN`
(`libs/garage/shared-types`), the same way `MAX_BULK_BOOKING_DAYS` works for the
bulk reservation. The client therefore learns the limit from the schema and
doesn't have to discover it by being rejected.

`overview.day` **does not declare it** — it's a read, and no domain rule can
be violated by a structurally valid date there (a day outside every window is
returned with `canReserve: false`, not an error). Declaring a code a
procedure never returns is, per `doc/decision/0018-*`, the same mistake as
returning an undeclared one.

### Day overview

| procedure      | input      | output                                                                        | other errors |
| -------------- | ---------- | ----------------------------------------------------------------------------- | ------------ |
| `overview.day` | `{ date }` | `{ date, window, canReserve, canReserveMonth, spots[], viewerReservationId }` | —            |

Everything the parking lot screen needs, in one query: every active spot, who
holds it, how many people are behind it on the waitlist, where the caller
stands — **and the reservation-window state for that day**. The window
travels with the response deliberately, so the FE never needs a second query
and can never render the day grid against a stale window.

Three fields that must not be confused:

- `window` — the `MonthWindowOverview` of the month `date` falls into. The
  truth is carried by `state`; `lockMode !== 'AUTO'` means the state was
  **overridden by an admin**, and `windowFrom`/`windowTo` are only
  hypothetical (what the automatic rule would do).
- `canReserve` — whether **this** user may reserve **this** day. It already
  accounts for the window, the admin exception, the past, and business days.
  **The FE must not derive it from `window` itself** — an admin isn't bound by
  the window, and that's a fact that lives on the backend.
- `canReserveMonth` — whether this user may reserve **anywhere in the month**
  `date` falls in: the window and the admin exception, and nothing about `date`
  itself. A screen whose subject is the month (the bulk-reservation modal) reads
  this one. `canReserve: false` with `canReserveMonth: true` is every weekend
  and every holiday of an open month, so the pair disagreeing is normal;
  `doc/decision/0175-*` records why the month answer had to travel separately
  rather than be inferred client-side from `canReserve` and the calendar.

Read-only: a locked or not-yet-open day isn't thrown as an error, it's just
reported in `window`.

Other users' data goes out as `userSummarySchema` — a `pick` of three fields
(`id`, `name`, `licensePlate`). `email`, `oktaId`, and above all `icsToken`
never reach another user's browser.

Each spot row also carries `timedReservations[]` — the guest half-hour
blocks booked on that spot for that day, ascending by `startTime`. It is
non-empty only while `reservation` is `null`: the database refuses a
full-day `Reservation` and any `TimedReservation` block on the same cell at
once (`doc/decision/0314-*`), so the two fields are never both meaningful for
the same row. A spot with blocks cannot take a full-day reservation, but an
admin may add further non-overlapping blocks to it.

### Reservations

| procedure                 | input                     | output                                             | other errors                                                                                                                                             |
| ------------------------- | ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation.create`      | `{ parkingSpotId, date }` | `Reservation`                                      | `NOT_FOUND`, `SPOT_ALREADY_RESERVED`, `RESERVATION_LIMIT_REACHED`, `PAST_DATE`, `OUT_OF_HORIZON`, `RESERVATIONS_LOCKED`, `VALIDATION_FAILED`, `CONFLICT` |
| `reservation.cancel`      | `{ reservationId }`       | `{ reservationId, date, parkingSpotId, promoted }` | `NOT_FOUND`, `CONFLICT`                                                                                                                                  |
| `reservation.myMonth`     | `{ month }`               | `{ month, reservedDates[], count, cap }`           | —                                                                                                                                                        |
| `admin.reservation.month` | `{ userId, month }`       | `{ month, reservedDates[], count, cap }`           | —                                                                                                                                                        |

`reservation.cancel` **deliberately declares no window error.** Per
`doc/decision/0004-*`, a regular user may cancel their own reservation at any
time, even in a locked month — the lock prevents taking spots, not giving them
back. `FORBIDDEN` covers someone else's reservation; an admin may cancel any
of them.

`promoted: true` means the freed spot was immediately given to the first
person on the waitlist. An automatic promotion is a system action, and the
lock doesn't apply to it, so it can happen even in a locked month.

`SPOT_ALREADY_RESERVED` is the honest answer for an occupied spot;
`CONFLICT` is the narrower case of a lost race between the check and the
insert, which the unique constraint on (spot, day) turns into an error
instead of a double booking.

`reservation.myMonth` is caller-scoped — there is no `userId` input, so it can
only ever answer for whoever is calling. `admin.reservation.month` answers the
same question about a named user instead and is `@Roles('ADMIN')`: unlike the
rest of this table, reading somebody else's month is a rule about the route,
not about a row.

`cap` is the monthly reservation cap **in force**, not the count of
reservations that already exist. It comes from the `ReservationLimitSettings`
singleton (`doc/decision/0312-*`), rides along on both procedures for the same
reason the reservation-window state rides along on `overview.day`: the
client's whole job with the two numbers is `cap - count`, and a count and a
cap fetched from two independent round trips could disagree the moment an
admin changes the setting between them. See "Reservation limits (admin)"
below for where `cap` is written.

### Waitlist

| procedure        | input                     | output                                     | other errors                                                                                                                                                                                            |
| ---------------- | ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitlist.join`  | `{ parkingSpotId, date }` | `{ entry, position }`                      | `NOT_FOUND`, `ALREADY_IN_WAITLIST`, `CANNOT_WAITLIST_OWN_SPOT`, `SPOT_NOT_OCCUPIED`, `RESERVATION_LIMIT_REACHED`, `PAST_DATE`, `OUT_OF_HORIZON`, `RESERVATIONS_LOCKED`, `VALIDATION_FAILED`, `CONFLICT` |
| `waitlist.leave` | `{ waitlistEntryId }`     | `{ waitlistEntryId, parkingSpotId, date }` | `NOT_FOUND`, `OUT_OF_HORIZON`, `RESERVATIONS_LOCKED`, `CONFLICT`                                                                                                                                        |

Both are writes, so both are blocked by a locked window —
`doc/decision/0004-*` names "leaving the waitlist" explicitly, since leaving
reshuffles everyone behind you.

`RESERVATION_LIMIT_REACHED` on `join` isn't a typo: a promotion would give the
user a second reservation on a day they already have one, so the waitlist
rejects them upfront instead of never promoting them.

`OUT_OF_HORIZON` on `leave` looks unreachable (you couldn't have joined a
month that wasn't open), but it is reachable: an admin lowers
`openDaysBefore`, and the month goes back to `NOT_YET_OPEN` while entries in
it already exist.

A waitlist promotion **is not a procedure** — it happens on the backend when
a cancellation occurs, and it's reported via a realtime event (Task 5).

### Bulk reservation

| procedure                 | input                    | output                                               | other errors                                                              |
| ------------------------- | ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `reservation.previewBulk` | `{ dates[] }`            | `{ month, preferredParkingSpotId, days[], summary }` | `PAST_DATE`, `OUT_OF_HORIZON`, `RESERVATIONS_LOCKED`, `VALIDATION_FAILED` |
| `reservation.confirmBulk` | `{ dates[] }` (the same) | the same + ids of the written rows                   | additionally `CONFLICT`                                                   |

`previewBulk` **writes nothing** — no reservation, no waitlist entry, no
audit record. It declares the same window errors as `confirmBulk`: proposing
a schedule for a month the user can't reserve means showing them a plan they
can never confirm.

A day is a discriminated union on `outcome`:

| outcome         | carries                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `SPOT_ASSIGNED` | `parkingSpotId`, `parkingSpotLabel`, `isPreferredSpot`                             |
| `QUEUED`        | `parkingSpotId`, `parkingSpotLabel`, `waitlistPosition`                            |
| `UNAVAILABLE`   | `reason` (`ALREADY_HAS_RESERVATION` / `NOT_A_BUSINESS_DAY` / `NO_SPOTS_AVAILABLE`) |

In `confirmBulk`'s result, `SPOT_ASSIGNED` additionally carries
`reservationId` and `QUEUED` additionally carries `waitlistEntryId` — every
result variant is a superset of the same preview variant.

**The client computes the diff between the preview and the outcome** by
pairing both arrays up by `date`; the server doesn't know the preview and has
no need to. Why, and why the input stays just a list of days, is in
`doc/decision/0019-draft-and-confirm-bulk-reservation.md`.

The input validates **only structure**: non-empty, at most
`MAX_BULK_BOOKING_DAYS` (31), no duplicates, all days in one month. Not
weekends, holidays, or the past — that's day eligibility and belongs to the
service layer, same as the window (ruling window-2).

### Spots

| procedure               | input                                 | output        | other errors                                 |
| ----------------------- | ------------------------------------- | ------------- | -------------------------------------------- |
| `spot.list`             | —                                     | `{ spots[] }` | —                                            |
| `admin.spot.list`       | `{ includeInactive = false, group? }` | `{ spots[] }` | —                                            |
| `admin.spot.create`     | `{ label, group }`                    | `ParkingSpot` | `CONFLICT`, `VALIDATION_FAILED`              |
| `admin.spot.update`     | `{ id, label?, group?, active? }`     | `ParkingSpot` | `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED` |
| `admin.spot.deactivate` | `{ id }`                              | `ParkingSpot` | `NOT_FOUND`, `CONFLICT`                      |

`spot.list` exists for a regular user too, because the settings screen needs
a picker for `preferredParkingSpotId`. It returns only active spots and takes
no filters.

`CONFLICT` on `create`/`update` is a duplicate `label` (unique across the
whole lot); on `deactivate` it's a spot with future reservations — an admin
must resolve those before deactivating it. Deactivation is always a soft
delete; the row isn't deleted, because of foreign keys from reservations and
the audit log.

### Users

| procedure           | input                         | output        | other errors                                 |
| ------------------- | ----------------------------- | ------------- | -------------------------------------------- |
| `admin.user.list`   | `{ role?, active?, search? }` | `{ users[] }` | —                                            |
| `admin.user.update` | `{ id, role?, active? }`      | `AdminUser`   | `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED` |

Users **aren't created** through the API (provisioning happens from the Okta
token on first login) or deleted (offboarding is `active: false`).

`adminUserSchema` is `userSchema.omit({ icsToken: true })` — the token is the
only secret on the entity, and an admin has no reason to hold someone else's.
`omit` is chosen deliberately: a new field on the entity shows up in the admin
view automatically, which is the safer default for an administrative view
than `pick`.

An admin may only change role and active status; name, email, and license
plate belong to the user. `CONFLICT` guards against two ways of locking the
system out: demoting/deactivating the last active admin, and deactivating
yourself.

### User settings

| procedure               | input                                        | output                             | other errors                     |
| ----------------------- | -------------------------------------------- | ---------------------------------- | -------------------------------- |
| `me.get`                | —                                            | `User` (own, including `icsToken`) | —                                |
| `me.updateSettings`     | `{ licensePlate?, preferredParkingSpotId? }` | `User`                             | `NOT_FOUND`, `VALIDATION_FAILED` |
| `me.regenerateIcsToken` | —                                            | `{ icsToken }`                     | —                                |

`me.get` returns `icsToken`, because it's the caller's own token, and the
settings screen builds the feed address from it.

`me.updateSettings` is a partial update with **three** states per field:

| value        | meaning                                         |
| ------------ | ----------------------------------------------- |
| field absent | don't change it                                 |
| `null`       | clear it (no license plate / no preferred spot) |
| a value      | set it                                          |

Both fields are nullable on the entity, so "clear" must be expressible;
`.partial()` alone couldn't distinguish it from "don't change". `NOT_FOUND` is
a nonexistent preferred spot; `VALIDATION_FAILED` targets a deactivated one.

`preferredParkingSpotId` is used **exclusively** as the first choice during a
bulk reservation; it has no effect on a regular single-day reservation
(`doc/decision/0004-*`).

### ICS feed

The feed itself is **outside oRPC** — `plan.md` §Contract-first names it as
the sole exception. Calendar clients (Outlook, Google) download a plain URL
and can't be taught to send headers, so the feed can't ride the RPC transport
or a session cookie. It's a plain `GET`, authenticated by an unguessable
token in the path.

The contract therefore doesn't own an endpoint, but **the URL's shape**, so
`apps/garage/api` (which serves it) and `apps/garage/web` (which displays it) can't drift
apart:

```ts
ICS_FEED_BASE_PATH; // '/api/calendar'   (including apps/garage/api's global prefix)
ICS_FEED_FILE_EXTENSION; // '.ics'
buildIcsFeedPath(token); // '/api/calendar/<token>.ics'
buildIcsFeedUrl(base, token); // 'https://host/api/calendar/<token>.ics'
```

`buildIcsFeedUrl` trims trailing slashes from `base` and percent-encodes the
token. An empty token or an empty `base` throws — otherwise the URL would end
up pointing at a collection instead of a user.

`me.regenerateIcsToken` returns **only the token**, not a URL: the contract
doesn't know which origin the deployment is reachable at, and it shouldn't
guess. The client assembles the URL with a helper. Regenerating immediately
invalidates the old address, so the UI must tell the user they need to
re-subscribe their calendar.

The procedure **does not declare `CONFLICT`**. The only conceivable collision
is a unique constraint on a freshly generated random token, which isn't a
state the client can do anything about — it's an instruction to retry.
**Task 12 must therefore generate it in a retry loop inside the handler**,
rather than surface an error the UI has no copy for. Reasoning:
`doc/decision/0021-*`.

### Reservation window (admin)

| procedure             | input                            | output                      | other errors                    |
| --------------------- | -------------------------------- | --------------------------- | ------------------------------- |
| `admin.window.get`    | —                                | `ReservationWindowSettings` | —                               |
| `admin.window.update` | `{ openDaysBefore?, lockMode? }` | `ReservationWindowSettings` | `VALIDATION_FAILED`, `CONFLICT` |
| `admin.window.months` | `{ from, to }` (`YYYY-MM`)       | `{ months[], settings }`    | —                               |

`admin.window.update` is a **replacement, not a patch**: the input is
directly `reservationWindowSettingsSchema`, so an omitted field falls back to
its **default** (`openDaysBefore: 7`, `lockMode: 'AUTO'`), not to the
currently stored value. There are only two fields, and the admin form always
renders both — "PUT replaces the resource" reads better than a patch whose
result depends on invisible state. **Always send both.**

`admin.window.months` returns months in ascending order along with the
settings the states were derived under, so the admin tab can render both the
table and the form from a single response. `from <= to` is checked in the
schema — `YYYY-MM` sorts lexicographically, so no date arithmetic is needed
for that. The range length is bounded by `MAX_MONTH_WINDOW_SPAN` (24 months),
also in the schema, so the procedure doesn't declare `VALIDATION_FAILED` — it
has no domain rule left that a structurally valid input could violate.

A regular user calls none of these procedures; they get the window state for
a specific day from `overview.day`.

### Reservation limits (admin)

| procedure                        | input                        | output                     | other errors                    |
| -------------------------------- | ---------------------------- | -------------------------- | ------------------------------- |
| `admin.reservationLimits.get`    | —                            | `ReservationLimitSettings` | —                               |
| `admin.reservationLimits.update` | `{ monthlyReservationCap? }` | `ReservationLimitSettings` | `VALIDATION_FAILED`, `CONFLICT` |

Same shape as the reservation window's pair, and deliberately so — a second
settings surface built the same way rather than a variant
(`doc/decision/0312-*`). `admin.reservationLimits.update` is a **replacement,
not a patch**: the input is `reservationLimitSettingsSchema` itself, so an
omitted field falls back to its default (`monthlyReservationCap: 5`), not to
the value currently stored.

A regular user calls neither procedure. The cap they need to render a correct
grid rides along on `reservation.myMonth` / `admin.reservation.month` instead
— see "Reservations" above.

`admin.reservationLimits.update` declares `VALIDATION_FAILED` on the shared
`authed` error builder, the same as `admin.window.update`, but — unlike
`admin.window.update`, whose combination of fields can be rejected by
`ReservationWindowService` — nothing in `ReservationLimitsService` currently
throws it: the one field is a bounded integer the schema itself already
guards (`MIN_MONTHLY_RESERVATION_CAP`–`MAX_MONTHLY_RESERVATION_CAP`), the same
situation `admin.window.months` is in above. Worth checking against
`doc/decision/0021-declared-error-must-have-a-reachable-trigger.md` — this
documentation task does not change the contract, so it is left declared as
written and flagged here rather than silently doc'd over.

### Timed reservations (admin)

| procedure                       | input                                                                  | output                                        | other errors                                                                       |
| ------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `admin.timedReservation.create` | `{ parkingSpotId, date, startTime, endTime, guestName, licensePlate }` | `TimedReservation`                            | `NOT_FOUND`, `SPOT_ALREADY_RESERVED`, `PAST_DATE`, `VALIDATION_FAILED`, `CONFLICT` |
| `admin.timedReservation.cancel` | `{ timedReservationId }`                                               | `{ timedReservationId, date, parkingSpotId }` | `NOT_FOUND`                                                                        |

Admin-only, guest-only: a `TimedReservation` books a spot for a named guest on
a half-hour-granular block of one day (`startTime`/`endTime` on the half-hour
grid, half-open — `10:00`–`11:00` and `11:00`–`12:00` do not overlap), not the
whole day. It is a separate row from `Reservation`, not a nullable time range
on it, because every existing flow keyed on `Reservation`'s one-per-spot-per-
day rule — the waitlist, promotion, the bulk allocator, the cap, the ICS
feed, Slack — would otherwise have had to learn a second meaning for the
same row (`doc/decision/0314-*`).

`SPOT_ALREADY_RESERVED` covers two different refusals with one honest
answer: the spot already has a full-day `Reservation` that day, or the
requested block overlaps another `TimedReservation` on it. Both are enforced
by a database trigger, not by a read-then-write check here, and the trigger
does not distinguish the two cases either. `PAST_DATE` and
`VALIDATION_FAILED` (a non-business day) come from the same
`ReservationPolicy.assertMayTakeDay` guard `reservation.create` runs, so the
admin window exemption applies here too and neither `OUT_OF_HORIZON` nor
`RESERVATIONS_LOCKED` is reachable — the contract does not declare them.

A spot with blocks has no waitlist: the queue is a `Reservation`-shaped
concept, and nothing here gives a cell with guest blocks an equivalent.

---

## Realtime (`@garage/contract/realtime`)

The Socket.io half of the contract has its **own entry point**. That isn't
cosmetic: `@garage/contract` pulls in `@orpc/contract`, and the RPC
builder has no business on the realtime path — not in the browser bundle
that only opens a socket, and not in the gateway. Rules:

- **Nothing under `src/realtime` imports from `src/api`.** Both branches take
  their shared schemas from `src/schemas`; that's why `userSummarySchema` and
  `publicReservationSchema` live there too.
- **The root `src/index.ts` does not re-export realtime.** A single barrel
  would undo that isolation in one line.
- The proof is `src/realtime/no-orpc.spec.ts`: it walks the **actual module
  graph** starting from `realtime/index.ts` and fails on any `@orpc/*` or on
  any file from `api/`. ESLint alone couldn't guard this — `@orpc/contract`
  is allowed for this lib and `@orpc/client` is installed in the repo. The
  test has its own check built in: the same walker must **find**
  `@orpc/contract` in `api/index.ts`, otherwise it would only pass because it
  isn't actually searching.

### Rooms

One room per day, `day:YYYY-MM-DD`, via `roomForDate(date)`. Everything the
parking lot screen draws is bound to a single day; a room per spot would
multiply the joins by the lot's size, and one global room would send every
day's traffic to everyone. The name is **derived, never stored anywhere**, so
the server and client can't drift apart. `roomForDate` is a pure function and
**throws** on an invalid date — a room is a broadcast target, not a string to
be taken on faith.

### Server → client events

All of these are sent **only after** a transaction commits (Task 15) and go
to the entire day room.

| event                        | payload                                                                                   | when                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cell:locked`                | `{ date, parkingSpotId, lockedBy, expiresAt }`                                            | someone started editing a cell; the UI shows "currently being edited by …" |
| `cell:unlocked`              | `{ date, parkingSpotId }`                                                                 | the lock was released, expired, or dropped with the socket                 |
| `reservation:created`        | `{ date, parkingSpotId, reservation }`                                                    | a free spot is now occupied                                                |
| `reservation:cancelled`      | `{ date, parkingSpotId, reservationId }`                                                  | the spot is free and **stays** free                                        |
| `reservation:reassigned`     | `{ date, parkingSpotId, cause, previousReservationId, reservation, fromWaitlistEntryId }` | the spot changed holder within a single transaction                        |
| `waitlist:updated`           | `{ date, parkingSpotId, waitlistCount }`                                                  | the waitlist on a cell got longer or shorter                               |
| `timed-reservations:updated` | `{ date, parkingSpotId, timedReservations[] }`                                            | a guest half-hour block was created or cancelled on this cell              |

**Names.** `<subject>:<past-participle>`, a colon, lowercase, subject in the
singular. The past tense is information: an event announces something that
has already happened and is committed. Commands in the opposite direction use
the imperative (`cell:lock`), so direction is readable from the name. `cell`
is the only non-domain subject and it's deliberate — the lock holds a pair
(`parkingSpotId`, `date`), i.e. one **cell** of the day × spot grid, and
`spot:locked` would read as "this spot is locked every day", which is
something different and non-existent. `plan.md` and the Task 24 brief already
call it "cell-lock".

> **`cell:locked` has nothing to do with `MonthLockState.LOCKED`.** That's a
> whole month's reservation window being closed; this is one user editing one
> cell for about 30 seconds. No payload above carries the window state, and
> **the window state is never broadcast** — see "What isn't broadcast".

**One transaction = one event.** A cancellation that immediately promotes the
first waitlist entry sends `reservation:reassigned` **instead of**
`reservation:cancelled`, never both. A cancel + create pair would, for every
client, first flash the cell empty.

One consequence follows that's easy to forget: **a promotion shortened the
waitlist, but `waitlist:updated` is not sent for it** — that would be a
second event from the same transaction. A non-null `fromWaitlistEntryId`
means "this cell's waitlist is one shorter"; the client either decrements
`waitlistCount` locally, or reloads the day. Task 15 therefore does **not**
emit `waitlist:updated` after a promotion.

**`reservation:reassigned` is deliberately its own event** (ruling
`window-1`): an automatic promotion is a system action, and the window lock
doesn't apply to it, so `reservation:created` in a locked month would look
like a window violation. That it wasn't a user action is said by the name;
**which** system action it was is said by `cause`
(`RESERVATION_REASSIGN_CAUSES` in `shared-types`, today a single value,
`WAITLIST_PROMOTION` — see `doc/decision/0022-*`).

**`timed-reservations:updated` carries the whole current list of blocks on
that cell, not a delta** — the same reason `reservation:created` carries a
full spot row rather than a diff: a client that missed one event self-heals
on the next rather than drifting forever. No field on it is viewer-relative
(a guest block has no `userId` and no queue position), so unlike the events
above it is never followed by a refetch. Two near-simultaneous writes to the
same cell can have their events arrive out of order; the next write — or a
manual refetch — always lands the true list regardless (`doc/decision/0314-*`).

### Client → server commands

| command           | payload                   | ack                                                                                       |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `day:subscribe`   | `{ date }`                | —                                                                                         |
| `day:unsubscribe` | `{ date }`                | —                                                                                         |
| `cell:lock`       | `{ date, parkingSpotId }` | `{ result: 'ACQUIRED', expiresAt }` or `{ result: 'HELD_BY_OTHER', lockedBy, expiresAt }` |
| `cell:unlock`     | `{ date, parkingSpotId }` | —                                                                                         |

**The server always validates incoming client→server events.** The gateway
(Task 15) looks up the event name in `CLIENT_TO_SERVER_EVENT_SCHEMAS`, runs
the payload through `safeParse`, and **only then** lets the handler run; an
invalid payload is dropped, and a name not in the registry isn't handled at
all. For this to be a rule and not a wish, three things hold:

1. The schema registry is also what `ClientToServerEvents`'s type is derived
   from — a command without a schema can't be declared.
2. No schema uses `z.any()`, `z.unknown()`, `z.record()`, or passthrough.
   Inbound payloads are additionally `strictObject`: an unknown key is
   **rejected**, not silently dropped. (Outbound events stay lenient — the
   client must tolerate a server deployed ahead of it; the server has no such
   obligation toward the client.)
3. The surface is as small as possible. Four commands, two payload shapes,
   **nothing domain-specific**: a reservation can't be created or cancelled
   over the socket. The socket carries subscriptions and the editing lock;
   mutations go through the API, where authorization and the window check
   live.

**A heartbeat isn't a separate command.** Resending `cell:lock` for a cell
the caller already holds **extends** the TTL — it's idempotent, one fewer
command on the surface, and a client that lost track of its own state can't
corrupt the server's state.

The lock is a **reservation of intent, not a reservation of a spot.** It
books nothing; a reservation is still created through the API, which
re-verifies everything. A client that skips the lock gets `CONFLICT` from
`reservation.create` instead of a nicer message — the lock is a courtesy
toward the other user, not an authorization step.

### What isn't broadcast

- **Anything relative to the viewer.** An event goes to the whole room, so it
  can't carry `viewerWaitlistPosition` or anything similar. A client whose own
  queue position may have changed reloads the day.
- **Anything secret.** Another user goes out exclusively as
  `userSummarySchema` (`id`, `name`, `licensePlate`); `email`, `oktaId`, and
  `icsToken` never reach the room.
- **Who is on the waitlist.** `waitlist:updated` only carries a count, because
  that's exactly how much another person learns about the waitlist from
  `overview.day` too.
- **The reservation-window state.** A change from `admin.window.update` isn't
  broadcast in realtime; the banner catches up on the next `overview.day`.
  This is a deliberate gap: an event nobody emits is the same mistake as an
  undeclared code (`doc/decision/0021-*`), and the Task 15 brief has no
  window broadcast. Once a few seconds of a stale banner turns out to matter,
  `window:updated` gets added **to the contract first**.

### How to add an event

1. The payload as a Zod schema, in `realtime/events.ts` (outbound) or
   `realtime/commands.ts` (inbound). Derive it from `schemas/` —
   `cellRefSchema` already carries the (`date`, `parkingSpotId`) pair.
2. Register it in `realtime/event-maps.ts`. That also creates the entry in
   `ServerToClientEvents` / `ClientToServerEvents`; those aren't hand-written,
   they're mapped types over the registry.
3. Add it to the expected list in `realtime/event-maps.spec.ts` and write a
   payload test.
4. Describe it in the table above.

---

## How to add a procedure

1. **Input and output schemas** as named constants (`fooInputSchema`,
   `fooOutputSchema`) in the file for that domain under `api/`. Derive from
   entities (`.pick()`, `.omit()`, `.partial()`), never copy them by hand.
   Derive the type via `z.infer`.
2. **Build the procedure** on the `authed` builder (carries `FORBIDDEN`), add
   `.input()`, `.output()`, and `.errors(contractErrors(...))`. **A procedure
   with no declared errors is almost certainly wrong** — and so is a
   procedure that declares a code whose trigger you can't name.
   `.input()` is **never omitted**: an argument-less procedure gets
   `noInputSchema`.
3. **Wire it into `router.ts`** — under `admin.` if it requires that role.
4. **A test alongside it** (`*.spec.ts`): valid input, invalid input, and
   what the output must guarantee.
5. **Update `EXPECTED_PROCEDURES` and `EXPECTED_ERROR_CODES` in
   `api/router.spec.ts`.** Those two lists are deliberately manual — every
   change to the API's surface then shows up in the diff.
6. **Describe it here**, in the relevant section's table.

What **does not** get added: a procedure returning an ad-hoc error shape,
validation that needs data from the database (that belongs in the service
layer), or any import from `@orpc/client` or `@orpc/server` — the contract
must not reach for transport, and ESLint enforces that.

---

## How to add a new schema

1. **Figure out where it belongs.** A shared entity → `schemas/entities.ts`.
   A new primitive (a scalar used in multiple places) → `schemas/primitives.ts`.
   A new enum value → first a tuple in
   `libs/garage/shared-types/src/lib/domain-constants.ts`, only then a Zod wrapper
   in `schemas/enums.ts`.
2. **Build on existing pieces.** Never rewrite `z.uuid()` or `z.iso.date()` –
   use `idSchema`, `dateOnlySchema`, `timestampSchema`. Derive request shapes
   from an entity (`.pick()`, `.omit()`, `.partial()`), don't write them
   again.
3. **Export the type via `z.infer`.** For a schema with `.default()`, also
   export the `z.input`.
4. **Write a test alongside it** (`*.spec.ts` in the same folder): a valid
   input, an invalid input, edge values. For an enum, also test the exact
   composition of the list — so extending it shows up in the diff.
5. **Re-export** it from `schemas/index.ts` if you added a file.
6. **Verify**: `npm run lint && npm run typecheck && npm run test`.

What **does not** get added: a new error code with no entry in this document,
a new AuditLog action without extending `AUDIT_LOG_ACTIONS`, and any
validation that needs data from the database — that belongs in the service
layer.

---

## What `libs/garage/shared-types` provides

The contract builds on it, but the backend and `libs/shared/i18n` use it too.

| area                  | functions                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| date-only             | `isDateOnly`, `assertDateOnly`, `parseDateOnly`, `formatDateOnly`, `addDays`, `addMonths`, `differenceInDays`, `compareDateOnly`, `isBefore/isAfter/isSameDay`, `startOfMonth`, `endOfMonth`, `toYearMonth`, `startOfYearMonth`, `dayOfWeek`, `isWeekend`, `daysInMonth` |
| Europe/Prague         | `PRAGUE_TIME_ZONE`, `todayInPrague`, `toDateOnlyInPrague`, `startOfDayInPrague`, `endOfDayExclusiveInPrague`                                                                                                                                                             |
| Czech public holidays | `czechPublicHolidayOn`, `isCzechPublicHoliday`, `isBusinessDay`, and the type `CzechHoliday`                                                                                                                                                                             |
| enums and defaults    | `PARKING_GROUPS`, `USER_ROLES`, `RESERVATION_LOCK_MODES`, `MONTH_LOCK_STATES`, `DEFAULT_OPEN_DAYS_BEFORE`, `MIN/MAX_OPEN_DAYS_BEFORE`, `DEFAULT_RESERVATION_LOCK_MODE`                                                                                                   |
| bulk reservation      | `BULK_DAY_OUTCOMES`, `BULK_UNAVAILABLE_REASONS`, `MAX_BULK_BOOKING_DAYS`                                                                                                                                                                                                 |
| reservation window    | `isMonthOpen`, `monthLockState`, `reservationWindowRange`, `MAX_MONTH_WINDOW_SPAN`                                                                                                                                                                                       |
| realtime              | `RESERVATION_REASSIGN_CAUSES`, `CELL_LOCK_RESULTS`                                                                                                                                                                                                                       |

Arithmetic is calendar-based, and the timezone is resolved at a single
boundary — see `doc/decision/0013-calendar-arithmetic-and-single-timezone-boundary.md`. Movable holidays (Good Friday, Easter
Monday) are computed with the Meeus/Jones/Butcher algorithm, not from a
table, so they never go stale.

The holiday row is a **named** export list rather than a star, and it is
shorter than the module behind it. The Easter arithmetic (`easterSunday`,
`goodFriday`, `easterMonday`, `GOOD_FRIDAY_FIRST_YEAR`) and the year's holiday
table (`czechPublicHolidays`, `CZECH_HOLIDAY_IDS`, `CzechHolidayId`) stay
module-scoped: they are how the calendar is _computed_, not what a caller asks
it, nothing outside the lib names any of them, and `czech-holidays.spec.ts`
imports the module directly. The narrowness matters more here than elsewhere
because this barrel is also `@garage/i18n`'s, re-exported wholesale under
the same names (`doc/decision/0003-*`) — so a symbol published here is
published to the browser bundle too.

---

## Related decisions

- `doc/decision/0003-date-helpers-in-shared-types.md` – why the date logic
  isn't in `libs/shared/i18n`
- `doc/decision/0004-mvp-scope-includes-design-features.md` – the reservation
  window, bulk reservation, preferred spot
- `doc/decision/0013-calendar-arithmetic-and-single-timezone-boundary.md`
- `doc/decision/0014-dateonly-is-an-unbranded-string.md`
- `doc/decision/0015-timestamps-in-contract-are-iso-strings.md`
- `doc/decision/0016-closed-enums-and-uuid-in-contract.md` – why the UUID
  version is unconstrained
- `doc/decision/0018-mapping-error-contract-to-orpc.md` – `details` = oRPC
  `data`, statuses
- `doc/decision/0019-draft-and-confirm-bulk-reservation.md` – why the client
  computes the diff
- `doc/decision/0020-orpc-is-esm-only-jest-must-transpile-it.md` – the
  required Jest configuration
- `doc/decision/0021-declared-error-must-have-a-reachable-trigger.md` – why a
  code with no trigger gets removed and the limit belongs in the schema
- `doc/decision/0022-realtime-event-names-and-one-transaction-one-event.md`
- `doc/decision/0023-realtime-is-a-separate-entry-point-and-maps-are-derived.md`
