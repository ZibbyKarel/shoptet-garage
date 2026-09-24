# 0314 – Guest time blocks are their own table, and a trigger keeps them apart from full days

**Date:** 2026-09-24 · **Status:** accepted · **Task:** `TODO.md` item 1

## What

An admin may now book a spot for a guest on a **half-hour-granular block** of
one day instead of the whole day — `admin.timedReservation.create` /
`.cancel` (`libs/garage/contract/src/api/timed-reservations.ts`). The block
lives on a new table, `TimedReservation`
(`parkingSpotId`, `date`, `startMinute`, `endMinute`, `guestName`,
`licensePlate`), not on `Reservation`. One `(parkingSpotId, date)` is either
one full-day `Reservation` **or** any number of non-overlapping
`TimedReservation` blocks, never both — enforced by a `CHECK` on the block's
own range plus a pair of database triggers across both tables, not by
application code. `admin.timedReservation.*` sits under `admin` in the
router with `@Roles('ADMIN')`, and `.create` runs the same window/day
eligibility guard `reservation.create` does
(`ReservationPolicy.assertMayTakeDay`), so the admin window exemption applies
there too; `.cancel` runs no such guard, exactly like `reservation.cancel` —
deleting a block is never blocked by a closed or not-yet-open month.

## Why a separate table rather than nullable times on `Reservation`

Every existing flow that touches a reservation is keyed on
`Reservation_parkingSpotId_date_key` — the waitlist, promotion, the bulk
allocator, the monthly cap, the ICS feed, the Slack notification. All of them
mean "the one reservation this spot has on this day" when they read that key,
and every one of them would have had to learn a second meaning for the same
row — "one of possibly several, for a possibly-null time range" — the moment
`startTime`/`endTime` went nullable on `Reservation` itself. That is not a
refactor a feature this size should force on eleven unrelated call sites.

The two things a guest block needs are also not the two things a full-day
reservation needs:

- **Guest-only.** A block has no `userId` at all — it books a name, never a
  user — while a full-day `Reservation` may belong to either. Nullable times
  on `Reservation` would still need the existing `Reservation_holder_check`
  XOR (`doc/decision/0305-*`) to somehow also forbid "a user holder with a
  time range", a constraint that has nothing to do with what that CHECK is
  for.
- **Many per (spot, day).** `@@unique([parkingSpotId, date])` on
  `Reservation` is the whole point of the table — one row per cell. A block
  needs the opposite: several non-overlapping rows on the same cell. The two
  invariants cannot both be true of one column set on one table without the
  unique index itself changing meaning for every other reader of it.

A new table costs a second read path (`day-overview.service.ts` runs a third
query and merges it in) and a second write path
(`TimedReservationsService`), but every one of the eleven existing readers of
`Reservation` keeps meaning exactly what it always meant, unchanged. The
Slack daily digest (`SlackNotificationService.collectDailySummary`) is the
one exception, and it was not unchanged on first ship: it listed a
guest-blocked spot as free, because "free" was computed only from the
absence of a `Reservation` row. It now also reads `TimedReservation` for the
day and excludes those spots' labels too — see the fix recorded against this
branch's final review.

## Why triggers, and why they raise `unique_violation`

Two tables cannot share one unique index, so "never both" cannot be a
constraint at all — it has to be a check that runs at write time, on both
tables, against the other one. An application-level check (read
`Reservation`, read `TimedReservation`, then decide) was rejected because it
cannot be made safe against a concurrent writer, and — more concretely —
because it would have to be repeated correctly at **every** write path that
can put a row into either table: `TimedReservationsService.create`,
`ReservationsService.create`, `BulkReservationService`'s allocator and
`confirmOnce`, and `WaitlistPromotionService.promote`. Missing one of those
(`confirmBulk`'s `INSERT … ON CONFLICT DO NOTHING`, or a promotion's insert
running from inside a cancellation) is exactly the kind of omission an
application check invites and a database constraint does not.

So the rule is two triggers instead — `timed_reservation_reject_conflict`
(`BEFORE INSERT OR UPDATE` on `TimedReservation`) and
`reservation_reject_timed_conflict` (`AFTER INSERT OR UPDATE` on
`Reservation` — see "the trigger timing asymmetry" below for why they are not
both the same). Both call `lock_spot_day(spot, day)`, a
`pg_advisory_xact_lock` keyed on the cell, held for the rest of the
transaction. Every statement inside a PL/pgSQL function gets its own fresh
snapshot under PostgreSQL's default READ COMMITTED, so the `EXISTS` check
that runs immediately after the lock is granted sees whatever the previous
lock holder committed — the lock is what turns "check, then maybe conflict"
into "check exactly once, against a settled world".

The violation is raised as `unique_violation` (`ERRCODE = 'unique_violation'`)
with a named constraint — `TimedReservation_spot_day_conflict` or
`Reservation_timed_reservation_conflict` — on purpose, not because Postgres
requires it for a `RAISE EXCEPTION`. `@prisma/adapter-pg` turns that
combination into an ordinary `P2002` whose `constraint.index` is the named
constraint, so `mapUniqueConstraintViolation` — the same mapping every writer
already goes through for the plain one-per-day `P2002` — answers
`SPOT_ALREADY_RESERVED` without any writer needing new error-handling code.
Reusing the existing P2002 path, rather than inventing a new error shape for
a trigger-raised conflict, is what let five call sites gain this rule without
five call sites being touched for it.

## Why half-open minutes in storage and `HH:MM` on the wire

`TimedReservation.startMinute`/`.endMinute` are `SMALLINT`s, minutes since
local midnight, half-open (`[start, end)`) on the half-hour grid — `10:00` to
`11:00` and `11:00` to `12:00` do not overlap, because the second block's
`startMinute` equals the first's `endMinute` and the overlap test
(`"startMinute" < NEW."endMinute" AND NEW."startMinute" < "endMinute"`) is
strict on both sides. Arithmetic on the half-open range — the `CHECK`, the
overlap test in the exclusivity trigger — is simpler and cheaper on integers
than on `HH:MM` strings. The contract still carries `startTime`/`endTime` as
`HH:MM` on the wire, because that is the format every other time-of-day value
in this contract uses and the format a person reads; `@garage/shared-types`'s
`timeOfDayToMinutes`/`minutesToTimeOfDay` own the one conversion at that
boundary, so the storage representation never leaks past
`prisma-mapping.ts`.

## Why the `Reservation` trigger is `AFTER`, and the `TimedReservation` trigger is `BEFORE`

The two triggers are not symmetric, and the asymmetry is load-bearing, not
cosmetic. `timed_reservation_reject_conflict` is `BEFORE INSERT OR UPDATE OF
… ON "TimedReservation"` — a block's own `CHECK` and its overlap test both
have to pass before the row is allowed to exist at all, so there is nothing
to gain by writing it first. `reservation_reject_timed_conflict` is `AFTER
INSERT OR UPDATE OF "parkingSpotId", "date" ON "Reservation"`, and it did not
start that way.

The original migration made it `BEFORE`, matching the `TimedReservation`
side, and that shipped a deadlock
(`.superpowers/sdd/2026-09-24-guest-half-hour-blocks/task-4-fix-report.md`).
The cycle: a cancellation's transaction ran `SELECT … FOR UPDATE` then
`DELETE` on a `Reservation` row, leaving the deleted index entry uncommitted;
a concurrent create's `BEFORE` trigger took the `lock_spot_day` advisory lock
(nobody held it yet), passed its `EXISTS` check, and then blocked on the
`(parkingSpotId, date)` unique index waiting for the cancelling transaction to
finish; the cancellation's own waitlist promotion then tried to `INSERT` a
new `Reservation` for the same cell, whose trigger needed the same advisory
lock the waiting create already held. Two transactions, each waiting on
something the other held: `40P01` deadlock, surfaced to the create as
`CONFLICT` instead of the `SPOT_ALREADY_RESERVED` it should have gotten by
losing an ordinary race.

Moving the trigger to `AFTER` (and changing its body to `RETURN NULL`, since
an `AFTER` trigger's return value is ignored) fixes the lock order for every
`Reservation` writer: a create now meets the unique index **first**, exactly
as it did before either trigger existed, and only takes the advisory lock
once it already has the cell — uncontested by other `Reservation` writers.
The row is inserted (uncommitted) by the time the trigger runs, so a
concurrent `TimedReservation` insert that needs the same lock either gets it
first and sees nothing yet (the `Reservation` insert hasn't reached its
`AFTER` trigger), or waits and then sees the now-committed row once it does.
Exclusivity is unchanged either way; only the order in which locks are
acquired changed, and that order is now the same order every other
`Reservation`-vs-`Reservation` race already used. A side effect worth naming:
`INSERT … ON CONFLICT DO NOTHING` (bulk confirm's skipped rows) no longer
takes a spot-day lock for a row it never actually inserts, because `AFTER`
never fires for a conflict that resolved to nothing.

## What it costs

- **The bulk race.** A guest block can commit on a preferred spot between
  `BulkReservationService`'s `readWorld` and its own reservation insert for
  that cell. The insert then fails with the trigger's `P2002`, which
  `confirmBulk`'s retry recognises via `isTimedReservationConflict` and
  re-reads the world before trying again — the same retry path
  `isWriteConflict` already uses for a `40P01`, extended to cover this one
  additional cause.
- **Broadcast ordering.** Two near-simultaneous writes to the same cell's
  blocks — a create and a cancel, or two creates — can have their
  `timed-reservations:updated` events arrive out of order at a client,
  because each publish computes and sends the _whole current list_ for that
  cell independently of the other. This self-heals: the event schema's own
  documented contract is "replace, don't merge", so the next write (or a
  manual refetch) always lands the true list regardless of what order the
  two broadcasts were seen in. This applies to a cancel racing a create the
  same way it applies to two creates.
- **Deleting a block takes no lock.** `TimedReservationsService.cancel` is a
  plain `DELETE`, with no trigger and no `lock_spot_day` call on that path.
  A concurrent full-day `Reservation` insert for the same cell can therefore
  be refused by the trigger's `EXISTS` check against a block that is
  mid-delete but not yet committed — a conservative false refusal
  (`SPOT_ALREADY_RESERVED` for a cell that is, a moment later, actually
  free) rather than a race that could double-book it. The admin simply
  retries the full-day reservation once the delete has committed.
- **Guest names in blocks are visible to everyone in the day room**, exactly
  as they already are for a full-day guest reservation
  (`doc/decision/0305-*`): `publicTimedReservationSchema` carries
  `guestName` to every viewer of that day, not only to admins.
- **A spot with blocks has no queue.** The waitlist is a `Reservation`-shaped
  concept — one holder, one queue behind them — and nothing here gives a
  cell with guest blocks an equivalent. An admin who wants a spot held for a
  specific person on a specific half hour is expected to say so directly
  (book the block), not to queue for a cell that was never fully taken in
  the first place.
