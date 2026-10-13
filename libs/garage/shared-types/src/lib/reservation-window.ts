/**
 * The reservation window — pure, parameterised, side-effect free.
 *
 * The algorithm started as the `monthOpen` function of the approved visual
 * design (`doc/design/garage-design.dc.html`, transcribed by
 * `doc/decision/0004-mvp-scope-includes-design-features.md`) and was amended
 * by `doc/decision/0315-the-monthly-cap-applies-only-inside-the-auto-window.md`:
 *
 * ```
 * FORCE_OPEN   -> OPEN
 * FORCE_LOCKED -> LOCKED
 * AUTO         -> from = first day of targetDate's month - openDaysBefore days
 *                 today < from ? NOT_YET_OPEN : OPEN
 * ```
 *
 * Two consequences are load-bearing and easy to get wrong:
 *
 * 1. Under `AUTO` a month **never closes**. The window is the period in which
 *    the monthly cap applies (`isMonthlyCapInForce`); once the month has begun
 *    the cap is over and anybody may book the spots that are left. `LOCKED`
 *    is only ever the admin's `FORCE_LOCKED`.
 * 2. These functions only *report* the state. They never enforce anything, and
 *    callers are expected to skip them where the lock does not apply — waitlist
 *    auto-promotion is a system action and is exempt, admins are not limited by
 *    the window at all, and cancelling one's own reservation is always allowed.
 *
 * All dates are Europe/Prague calendar days; `today` is injected (typically
 * from `todayInPrague()`) so the functions stay deterministic and testable.
 */

import { addDays, compareDateOnly, startOfMonth, type DateOnly } from './date-only';
import type { MonthLockState, ReservationLockMode } from './domain-constants';

/** Inclusive first/last day on which the window for a month is open. */
export interface ReservationWindowRange {
  /** First day the month can be booked: first day of the month − `openDaysBefore`. */
  readonly from: DateOnly;
  /**
   * Last day the window's monthly cap applies: the day before the month
   * starts. Booking itself stays open after it — only the cap ends here.
   */
  readonly to: DateOnly;
}

/**
 * The inclusive date range during which `targetDate`'s month can be booked
 * under `AUTO`. Independent of `today` and of the lock mode — the two override
 * modes ignore the range entirely.
 */
export function reservationWindowRange(
  targetDate: DateOnly,
  openDaysBefore: number
): ReservationWindowRange {
  const first = startOfMonth(targetDate);
  return {
    from: addDays(first, -openDaysBefore),
    to: addDays(first, -1),
  };
}

/**
 * Whether the month containing `targetDate` is currently open for reservations.
 *
 * @param targetDate      the day the user wants to reserve
 * @param openDaysBefore  how many days before the first of the month the window opens
 * @param lockMode        admin override
 * @param today           today's calendar day in Europe/Prague
 */
export function isMonthOpen(
  targetDate: DateOnly,
  openDaysBefore: number,
  lockMode: ReservationLockMode,
  today: DateOnly
): boolean {
  return monthLockState(targetDate, openDaysBefore, lockMode, today) === 'OPEN';
}

/**
 * Which of the three displayed states the month containing `targetDate` is in.
 *
 * The two "window" error codes of the contract map straight onto this:
 * `NOT_YET_OPEN` → `OUT_OF_HORIZON`, `LOCKED` → `RESERVATIONS_LOCKED`. Both are
 * raised by the service layer (Task 13), never by a schema.
 */
export function monthLockState(
  targetDate: DateOnly,
  openDaysBefore: number,
  lockMode: ReservationLockMode,
  today: DateOnly
): MonthLockState {
  if (lockMode === 'FORCE_OPEN') {
    return 'OPEN';
  }
  if (lockMode === 'FORCE_LOCKED') {
    return 'LOCKED';
  }

  const { from } = reservationWindowRange(targetDate, openDaysBefore);
  return compareDateOnly(today, from) < 0 ? 'NOT_YET_OPEN' : 'OPEN';
}

/**
 * Whether the per-user monthly reservation cap applies to `targetDate`'s month
 * **today**: only under `AUTO`, and only while today lies inside that month's
 * window (`reservationWindowRange`, both ends inclusive).
 *
 * The cap exists to stop one person claiming a spot for the whole month in
 * advance; once the month is running, leftovers are free for anybody
 * (`doc/decision/0315-the-monthly-cap-applies-only-inside-the-auto-window.md`).
 * `FORCE_OPEN` never caps, and under `FORCE_LOCKED` only admins can book at
 * all, uncapped.
 */
export function isMonthlyCapInForce(
  targetDate: DateOnly,
  openDaysBefore: number,
  lockMode: ReservationLockMode,
  today: DateOnly
): boolean {
  if (lockMode !== 'AUTO') {
    return false;
  }
  const { from, to } = reservationWindowRange(targetDate, openDaysBefore);
  return compareDateOnly(today, from) >= 0 && compareDateOnly(today, to) <= 0;
}
