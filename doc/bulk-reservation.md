# Bulk reservation: the allocator, the preview and the transaction

`apps/garage/api/src/reservations/bulk-*`. Two procedures — `reservation.previewBulk`
and `reservation.confirmBulk` — that take a set of days inside one calendar
month and give every one of them a spot, a queue place, or a reason why not.

The single-day flow and the queue mechanics it hangs off are in
[`doc/waitlist.md`](./waitlist.md); this document is about what is different
when a request carries up to 31 days at once, which is: the allocator, the
preview/confirm split, and the shape of the transaction.

---

## The two procedures

|              | `previewBulk`                                                             | `confirmBulk`                                                |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| writes       | **nothing** — no reservation, no queue entry, no audit row                | reservations, queue entries, audit rows                      |
| transaction  | none                                                                      | one interactive transaction for the whole batch              |
| broadcasts   | none                                                                      | `reservation:created` / `waitlist:updated`, **after** commit |
| answer shape | `days[]` + `summary`                                                      | the same, plus `reservationId` / `waitlistEntryId` per day   |
| errors       | `PAST_DATE`, `OUT_OF_HORIZON`, `RESERVATIONS_LOCKED`, `VALIDATION_FAILED` | those, plus `CONFLICT`                                       |

The shapes match on purpose: the month grid lays the proposal and the result
side by side and shows where reality differed.

### Why the preview writes nothing

It is a _proposal_, and a proposal that reserved anything would be a booking
with an extra step. Three consequences follow, and all three are the point:

- **No holds.** A previewed spot is not held for the user. Two people can
  preview the same day and both be shown the same spot; whoever confirms first
  gets it. Holding would mean either a lock held across a user's thinking time,
  or a "draft reservation" table with an expiry sweeper — Task 4 considered and
  rejected exactly that (`doc/decision/0019-*`), and this is what "no draft"
  means at the service layer.
- **No audit noise.** Looking at a month is not an auditable act.
- **It is cheap and idempotent.** Two identical previews return identical
  answers, which is asserted rather than assumed
  (`bulk-reservation.db.spec.ts`, "gives the same answer for the same input,
  twice").

The preview is not a promise, and the API never pretends otherwise: every field
of the confirmation is built from rows the database actually returned.

---

## The allocator

`bulk-allocator.ts` is **pure** — it takes a snapshot of the world and returns a
plan. It reads no database, opens no transaction and has no clock. That is what
lets the preview and the confirmation share one definition of "what should
happen" while differing only in whether anything is written, and it is what makes
the preference order testable by an ordinary unit test.

### Per day, in this order

1. **Not a business day** → `UNAVAILABLE / NOT_A_BUSINESS_DAY`. First because it
   is the most durable fact: a Saturday is still a Saturday next month, whereas
   "every spot is taken" is true for an afternoon. Note that inside a bulk
   request this is a _per-day fact_, not a rejected request — see
   `doc/decision/0090-*`.
2. **The user already holds a reservation that day** → `UNAVAILABLE /
ALREADY_HAS_RESERVATION`. Above the queue branch on purpose: queueing
   somebody who already has a spot creates an entry that can never be promoted
   (one reservation per user per day), which is what `waitlist.join` refuses at
   the door.
3. **No active, non-hidden spots at all** (`doc/decision/0316-*`) →
   `UNAVAILABLE / NO_SPOTS_AVAILABLE`.
4. **The preferred spot, if free** → `SPOT_ASSIGNED`, `isPreferredSpot: true`.
5. **The first free spot** in canonical order → `SPOT_ASSIGNED`.
6. **Otherwise the shortest queue** → `QUEUED`, with the position the user would
   take (or the one they already hold).

`preferredParkingSpotId` comes from the user's profile and is a bulk-only
preference — the single-day flow never applies it. A retired spot is simply
absent from the candidate list, so a stale preference degrades to step 5.

### The two orderings, and why the allocator re-derives both

- **Spots**: group (`IT` before `SHARED`, taken from the declaration order of
  `PARKING_GROUPS`), then `label`. Re-sorted here rather than trusted from the
  caller so that a `findMany` which lost its `orderBy` cannot silently change
  which spot a bulk booking picks.
- **Days**: ascending. This is not cosmetic — it is the lock ordering that keeps
  two concurrent confirmations from deadlocking (`doc/decision/0092-*`). The
  plan therefore comes back in date order, and the _service_ puts it back into
  request order for the response, because the contract promises request order
  while the writes have to stay in date order.

  **This sort is the single authority for the write order**, and deliberately so.
  The plan's order _is_ the row order of the reservation `INSERT`, so nothing
  between here and the write can reorder it.
  `BulkReservationService.assertRequestable` sorts too, but only _locally_, to
  name the earliest offending day in a rejection; the dates it hands downstream
  are in request order. It used to return them sorted, which meant either sort
  could be deleted with all 68 tests still green — measured: removing either
  alone, 3/3 confirmations fulfilled; removing both, 3/3 `P2034`. A redundant
  guarantee nothing can falsify is the one that rots, so the redundancy went and
  each remaining sort now has a test that fails when it is removed.

**The shortest-queue tiebreak is the label alone**, deliberately not
group-then-label. Choosing a queue is not choosing where to park: every candidate
is already taken, so the `IT`-before-`SHARED` preference has nothing to say, and
reusing the assignment order would silently make queueing prefer IT spots, which
nobody asked for. The tiebreak exists so that two identical requests produce the
same plan.

---

## The transaction

One interactive transaction per confirmation, `{ maxWait: 5_000, timeout:
15_000 }`, in this sequence:

```
read the world (spots, that month's reservations, that month's queues)
  → allocate (pure)
  → INSERT reservations         … ON CONFLICT DO NOTHING RETURNING *
  → re-read: which still-unsatisfied days does the caller now hold a spot on?
  → INSERT waitlist entries     … ON CONFLICT DO NOTHING RETURNING *
  → re-read the affected queues for real positions
  → INSERT audit rows (one per reservation, one per queue entry)
  → return the events
                              ── commit ──
publish reservation:created / waitlist:updated
```

Three properties hold it together, all three argued in full in
`doc/decision/0092-*`:

**Writes go in ascending date order.** Two confirmations acquire their
uncommitted unique keys in the same sequence, so no cycle can form between them.
Request order would deadlock two users who select the same week from opposite
ends.

**No statement is allowed to fail.** `createManyAndReturn({ skipDuplicates:
true })` is `INSERT … ON CONFLICT DO NOTHING RETURNING …`: a day whose spot was
taken since the read simply does not come back, and the service reads the
difference. PostgreSQL aborts a whole transaction on a failed statement and
Prisma exposes no savepoints, so this is the only way one impossible day does
not throw away the other thirty.

**There is no retry.** A batch that loses a genuine write conflict (`P2034`)
fails whole and the caller is told `CONFLICT` — never a 500
(`doc/decision/0065-*` owns that mapping). Re-running a 31-day batch would
re-read the world and produce a _different_ plan, which is a second request the
user did not make.

### The race that is deliberately left open

There is no `SELECT … FOR UPDATE` and no `FOR SHARE`. The gap between the read
and the write stays open, and it is benign because it is **self-correcting**:
the state can only move against the plan (a free spot becomes taken; a taken one
becoming free again cannot help, because promotion is what frees it and
promotion has its own queue). A day that loses its spot falls onto the waitlist
for _that spot_ — exactly what would have happened had the read seen the truth.

What is _not_ left to chance is what the caller is told: every field of the
answer is derived from rows the database returned, never from the plan.

One case is **narrowed, not closed** — the re-read in the sequence above shrinks
it, it does not remove it. A caller who acquires a reservation on one of the
target days while the transaction is running — from another tab, or by being
promoted off a queue — should not then also be given a queue entry for that day.
Such an entry could never be promoted (one reservation per user per day) and is
the exact state `waitlist.join` refuses at the door. The re-read
(`datesAlreadyReserved`) covers **every** still-unsatisfied day, both the ones
that lost an assignment and the ones the allocator had already planned to queue,
and reports `UNAVAILABLE / ALREADY_HAS_RESERVATION` for anything it catches —
which is what `bulk-reservation.db.spec.ts` ("does not queue a planned-QUEUED day
the caller acquired a reservation on") forces and checks.

**What it does not catch:** the re-read runs once, before `createWaitlistEntries`,
not again immediately before it. A promotion that commits **after** the read but
**before** the queue insert still leaves the caller with one reservation _and_
one queue entry for the same day — the exact state the re-read exists to
prevent. This is not hypothetical: bulk's own queue `INSERT` genuinely blocks on
`promote`'s uncommitted `WaitlistEntry` delete (the same edge the deadlock
analysis below names); if `promote` commits while bulk is stalled there, bulk
resumes and writes the queue entry anyway. Measured 4/4 by forcing that exact
interleaving with the trigger technique `bulk-concurrency.db.spec.ts` already
uses elsewhere in this codebase — no test in _this_ suite pins it, so it is not
exercised on every run. The consequence is the same benign, self-limiting one as
the race left open above: an entry that can never be promoted, not a double
booking and not lost data.

If this residual is ever worth closing, it has to happen in that narrower gap —
either re-reading `datesAlreadyReserved` again immediately before
`createWaitlistEntries`, or serialising `confirmBulk` against `cancel` +
`promote` on the contested date. Both are design decisions beyond this
document's scope, not bugs to fix here.

Locking the candidate spots instead would hold a row lock on every spot in the
lot for the length of the transaction, serialising every other reservation in
the building behind one bulk booking — and it would put `confirmBulk` back
inside the lock-ordering cycle `doc/waitlist.md` documents for cancellation.

### Deadlock analysis

| pair                                 | can they deadlock?                                   | why                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmBulk` × `confirmBulk`        | no                                                   | both take reservation keys in ascending date order, at most one per date; the sequences are prefixes of one total order                                                                                                                                                                                                                                                               |
| `confirmBulk` × `reservation.create` | no                                                   | a single-day create takes exactly one key — one key cannot be half of a cycle                                                                                                                                                                                                                                                                                                         |
| `confirmBulk` × `cancel` + promote   | **yes**, since the monthly cap, while it is in force | the cap's `(userId, month)` advisory lock is not date-scoped, so the argument below no longer covers the pair. `confirmBulk` retries and, if the attempts run out, the caller gets `CONFLICT`. See below. Outside the AUTO window neither side takes the cap lock (`doc/decision/0315-*`).                                                                                            |
| `confirmBulk` × anything unordered   | **yes**, but absorbed                                | a writer that takes two of the same cells in the opposite order deadlocks, and `bulk-concurrency.db.spec.ts` builds exactly that competitor: PostgreSQL reports `40P01`. Since `doc/decision/0307-*` the retry swallows it — one competitor cannot make `confirmBulk` lose twice — so the caller sees a normal result and `CONFLICT` needs all `MAX_CANCEL_ATTEMPTS` attempts to lose |

The last row is what makes the first one meaningful: without a demonstrated
cycle, "both callers succeeded" could just mean the two requests never met.

#### The cancel + promote row, restated

This row used to read "bulk takes no `FOR UPDATE` and deletes nothing, so it is
outside the cancel path's cycle". That argument is retracted: a cycle needs two
shared resources taken in opposite orders, not two particular kinds of lock, and
`WaitlistPromotionService.promote` does in fact `deleteMany` the promoted user's
`WaitlistEntry` rows as well as inserting a reservation.

The answer is still "no", for a reason about the resources rather than the locks:
**`cancel` + `promote` is confined to a single date**, and on any single date
`confirmBulk` either holds a reservation key or later wants a queue key — never
both, because a day it assigned is not queued and a day that lost its cell holds
nothing. The wait that does exist (bulk's queue `INSERT` blocking on a
`WaitlistEntry` key `promote` has deleted uncommitted) does have a return edge —
`Reservation`'s `@@unique([userId, date])`, which blocks `promote` when
`confirmBulk` holds an _assigned_ reservation on that date — but never on the
_same_ date as the forward wait, because a date is never both assigned and
queued at once. Two changes would let the two edges land on the same date and
close the cycle: a `promote` that spans more than one date, or a `confirmBulk`
that interleaves its two write phases per day instead of running them as two
batches. Full derivation in `doc/decision/0092-*` §"`confirmBulk` against
`cancel` + promote", including why the outcome would be `CONFLICT` and not a
500 even then.

**A third change arrived and closed it.** The per-user, per-calendar-month
reservation cap takes `pg_advisory_xact_lock` on `(userId, month)` — a resource
that is not scoped to a date at all, which is precisely what the paragraph above
depends on. The cycle is now:

```
T1 = cancel + promote (spot S, day D)      T2 = confirmBulk by U, month M (D included)
FOR UPDATE on S's queue for D       ✓      advisory(U, M)                          ✓
  assertWithinMonthlyReservationCap(U, M)    createReservations
    → blocks on advisory(U, M)               releaseOwnQueues: DELETE U's entries
                                               → blocks on S's queue row, held by T1
```

Both edges are real and neither is avoidable by reordering: the advisory key is
month-scoped, the queue row lock is date-scoped, and no total order exists over
resources of two different granularities that either side can compute in
advance. PostgreSQL kills one of them with `40P01`.

The mitigation is the same one `cancel` uses for the cycle in
`doc/decision/0065-*`: `confirmBulk` retries the whole transaction on any write
conflict (`MAX_CANCEL_ATTEMPTS` attempts, the test being `isWriteConflict` so
that both spellings of `40P01` — `P2034` and `P2010` — are caught), and reports
`CONFLICT` when they run out. The batch is all-or-nothing, so a losing attempt
writes nothing and the caller may simply try again. `doc/decision/0307-*`.

**How the ordering is falsified.** `bulk-concurrency.db.spec.ts` › "a forced
interleaving inside one multi-row INSERT" creates a test-only `BEFORE INSERT …
FOR EACH ROW` trigger that stalls between the rows of the reservation `INSERT`,
so each of two opposite-order callers is holding one day's key while reaching for
the other's. With the sort: 3/3 fulfilled. Without it, when that was measured:
3/3 `rejected CONFLICT`.

**That measurement is out of date, and the pin with it.** `confirmBulk` now
retries a `40P01` (`doc/decision/0307-*`), and the retry cannot tell a
cell-ordering cycle from the monthly cap's, so a deleted sort no longer surfaces
as a rejection unless the retries lose too — which has not been re-measured. The
hand-built-deadlock case in the same file was rewritten to assert the retry
absorbs the cycle, which is what it now does. `bulk-allocator.spec.ts` ("comes
back in ascending date order, whatever order it was asked in") is the sort's only
reliable guard until an end-to-end one is rebuilt; see
`doc/decision/0307-*` §"What is not tested".

An earlier version of this document said such an interleaving "cannot be forced
from outside the process" because the batch is one statement — that is false. A
multi-row `INSERT` acquires its keys row by row and this project's own deadlock
log catches one mid-statement (`CONTEXT: while inserting index tuple`); what it
lacks is a yield point available to _JavaScript_, and the database supplies one
itself. The trigger lives in the spec's setup, is scoped to two days nothing else
touches, and is dropped in a `finally`.

---

## What is a whole-request error and what is a per-day fact

| condition                                                 | result                                          |
| --------------------------------------------------------- | ----------------------------------------------- |
| any selected day is in the past                           | `PAST_DATE` (everyone, admins included)         |
| the month has not opened yet                              | `OUT_OF_HORIZON`                                |
| the month is locked for this caller                       | `RESERVATIONS_LOCKED` — an admin is exempt      |
| the batch is empty or spans two calendar months           | `VALIDATION_FAILED`                             |
| weekend or Czech public holiday                           | per-day `UNAVAILABLE / NOT_A_BUSINESS_DAY`      |
| the caller already holds a reservation that day           | per-day `UNAVAILABLE / ALREADY_HAS_RESERVATION` |
| no active, non-hidden spots exist (`doc/decision/0316-*`) | per-day `UNAVAILABLE / NO_SPOTS_AVAILABLE`      |

The window is checked once for the **whole target month**, which is why a batch
may not span two of them. The split between the two columns is the contract's,
not this module's — see `BULK_UNAVAILABLE_REASONS` and `doc/decision/0090-*`.

---

## After the commit

Events are _returned_ from the transaction callback and published by the caller
once it has committed — the same `DomainEventPublisher` seam the single-day flow
uses (`doc/waitlist.md` §"What happens after the commit"). One
`reservation:created` per reservation actually created, one `waitlist:updated`
per queue entry actually created; a day that changed nothing broadcasts nothing.

Every created reservation gets a `RESERVATION_CREATED` audit row and every
created queue entry a `WAITLIST_JOINED` one (`doc/decision/0091-*`), written by
`AuditLogService.recordMany` inside the same transaction as the rows they
describe.

---

## Testing

| what                                                                                                                                                                                                    | where                         | how it runs          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------- |
| preference order, both sortings, tiebreaks, positions                                                                                                                                                   | `bulk-allocator.spec.ts`      | `nx run api:test`    |
| routes exist and run their own contract procedure                                                                                                                                                       | `orpc-route-parity.spec.ts`   | `nx run api:test`    |
| preview writes nothing; confirm writes rows, audit and broadcasts; window and past-day rejections (naming the earliest offending day); forced mid-transaction races on an assigned **and** a queued day | `bulk-reservation.db.spec.ts` | `nx run api:test-db` |
| two callers in opposite order; the same pair with the `INSERT` broken open by a test-only `BEFORE INSERT` trigger; a hand-built deadlock                                                                | `bulk-concurrency.db.spec.ts` | `nx run api:test-db` |

The database suites follow the rules `doc/waitlist.md` §Testing sets out: real
PostgreSQL, no `PrismaDouble`, a throwaway database per run
(`doc/decision/0066-*`), and `api:test-db` exits 1 rather than skipping when
`DATABASE_URL` is absent.

Two conventions specific to these files, because spots are global in that
database but days are not:

- each case owns a **named, mutually exclusive** set of days (January and
  February **2100**), and a fixture guard asserts no day is shared — so nothing
  depends on Jest's ordering;
- no case asserts _which_ spot the allocator picked from the shared lot. Where
  the spot matters, the case either seeds its own or reads the choice out of a
  preview first.
