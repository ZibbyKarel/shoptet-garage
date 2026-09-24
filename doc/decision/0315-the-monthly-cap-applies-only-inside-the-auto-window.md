# 0315 – The monthly cap applies only inside the AUTO window, and a running month stays open

**Date:** 2026-09-24 · **Status:** accepted · **Task:** `TODO.md` item 2 ·
**Amends:** `doc/decision/0004-mvp-scope-includes-design-features.md` (the AUTO
rule), `doc/decision/0312-the-monthly-cap-is-its-own-settings-singleton.md`
(when the cap binds)

## What

The per-user monthly reservation cap (`ReservationLimitSettings`) binds only
while it is **in force**: lock mode `AUTO` and today inside the target month's
window (`reservationWindowRange`, by default the week before the month starts).
`isMonthlyCapInForce()` in `@garage/shared-types` is the single definition.

| situation                 | normal user may book?               | cap                                                                                   |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `AUTO`, before the window | no (`OUT_OF_HORIZON`)               | —                                                                                     |
| `AUTO`, inside the window | yes                                 | in force                                                                              |
| `AUTO`, month running     | **yes** (was `RESERVATIONS_LOCKED`) | **none**                                                                              |
| `FORCE_OPEN`              | yes                                 | **none**                                                                              |
| `FORCE_LOCKED`            | no (`RESERVATIONS_LOCKED`)          | booking is admin-only as before; the cap does not apply (a change — see Consequences) |

To make "month running" bookable, `monthLockState` under `AUTO` no longer
returns `LOCKED` from the 1st: it is `NOT_YET_OPEN` before the window and
`OPEN` from then on. `LOCKED` is now only the admin's `FORCE_LOCKED`.

## Why

The user's rule (TODO item 2, clarified 2026-09-24): the cap exists so one
person cannot claim a spot for the whole month in advance; once the month is
under way, whatever is left may be used freely. That requires both halves —
lifting the cap _and_ opening the running month, which 0004 had locked.

## How it is enforced

Every writer that inserts a reservation for a real user —
`ReservationsService.create`, `cancel` → `WaitlistPromotionService.promote`,
`BulkReservationService.confirm` — computes `isMonthlyCapInForce` from the
window settings it already reads **outside** the transaction, the same
snapshot its window check uses, and skips `assertWithinMonthlyReservationCap`
(and therefore its advisory lock) when the cap is not in force. The cap
_value_ is still read inside the transaction, as 0312 requires. An admin
changing the lock mode mid-request is judged by the snapshot, exactly as the
window check itself always was.

`reservation.myMonth` / `admin.reservation.month` report `cap: null` when no
cap applies, and the bulk modal leaves the grid unbounded only on that explicit
`null` — a failed summary still falls back to the bounded default.

## Consequences

- Normal users can now join a queue in the running month, and a spot freed
  then is promoted to the first eligible waiter without a cap check.
- An admin booking for a colleague is capped only inside the AUTO window (the
  cap follows the holder and the calendar, not the actor). This also means an
  admin booking for a user before the window opens (`NOT_YET_OPEN`) or under
  `FORCE_LOCKED` is uncapped too — a literal reading of `isMonthlyCapInForce`,
  since neither situation is "inside the AUTO window". The user may want to
  revisit this: those are exactly the two cases where an admin is doing
  something a normal user cannot, and an uncapped admin override there was
  not separately discussed.
- The admin banner's `bannerLockedAuto` key is unreachable (AUTO never yields
  `LOCKED`); it is left in place rather than widening this change.
- Copy that promised "you can reserve until {until}" and "reservations lock
  when the month starts" was rewritten.
