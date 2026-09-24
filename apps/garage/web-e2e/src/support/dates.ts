/**
 * Which calendar days the suite books into, and why they are computed rather
 * than written down.
 *
 * A literal date in a spec file rots: it drifts into the past, lands on a
 * Saturday, or falls on 28 October. All three make a reservation impossible
 * (`DayOverviewService.isReservableDay`) and would show up as a mystifying
 * failure months after the test was written.
 *
 * The rules are the application's own, imported from
 * `@garage/shared-types` — never re-implemented here:
 *
 * - the **month** must be open, and the current month is already partway
 *   through by whatever day `today` falls on, so it may not have enough
 *   business days left for every spec's slot; the suite works in the *next*
 *   month instead, a full, untouched month, which `reset-e2e` guarantees is
 *   open by setting `openDaysBefore` to its maximum;
 * - the **day** must be a business day: `isBusinessDay` excludes weekends and
 *   Czech public holidays, which `isReservableDay` requires.
 */

import {
  addDays,
  endOfMonth,
  isBusinessDay,
  parseDateOnly,
  startOfMonth,
  addMonths,
  todayInPrague,
} from '@garage/shared-types';
import type { DateOnly } from '@garage/shared-types';

/**
 * Every business day of the month after `today`, ascending.
 *
 * Never empty: no calendar month is entirely weekends and holidays.
 */
export function e2eBusinessDays(today: DateOnly = todayInPrague()): readonly DateOnly[] {
  const first = startOfMonth(addMonths(startOfMonth(today), 1));
  const last = endOfMonth(first);

  const days: DateOnly[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    if (isBusinessDay(day)) days.push(day);
  }
  return days;
}

/**
 * The day reserved for one spec file.
 *
 * Spec files take **different** days so that Playwright can run them in
 * parallel without one spec's reservation colliding with another's: a
 * reservation is unique per `(spot, date)` and per `(user, date)`, so two specs
 * booking the same persona on the same day would fail each other intermittently
 * — which is exactly the class of flake this project treats as a bug.
 *
 * @param slot zero-based, one per spec file; see `SPEC_DAY_SLOTS`.
 */
export function e2eDayForSlot(slot: number, today: DateOnly = todayInPrague()): DateOnly {
  const days = e2eBusinessDays(today);
  const day = days[slot];
  if (day === undefined) {
    throw new Error(
      `Slot ${slot} is beyond the ${days.length} business days of the e2e target month.`
    );
  }
  return day;
}

/**
 * The slot each spec file owns. Listed in one place so that adding a spec makes
 * the collision obvious instead of discovering it as a flake.
 */
export const SPEC_DAY_SLOTS = {
  reservation: 0,
  waitlistPromotion: 1,
  cellLock: 2,
  adminReservation: 3,
  icsFeed: 4,
  realtimeConnection: 5,
  adminBulkReservation: 6,
  waitlistQueue: 7,
  adminSpots: 8,
  adminUsers: 9,
  adminWindow: 10,
  settingsProfile: 11,
} as const;

const CZECH_MONTHS_GENITIVE = [
  'ledna',
  'února',
  'března',
  'dubna',
  'května',
  'června',
  'července',
  'srpna',
  'září',
  'října',
  'listopadu',
  'prosince',
] as const;

/**
 * `"<day>. <month>"` in the genitive, matching `useDateFormatters().dayAndMonth`'s
 * rendering closely enough for a `hasText` match against `CalendarTable`'s row
 * text (`{f.dayAndMonth(row.date)} · {f.weekdayName(row.date)}`) — a prefix
 * match, so it does not need to reproduce the weekday half.
 */
export function dayAndMonthCzech(date: DateOnly): string {
  const parts = parseDateOnly(date);
  return `${parts.day}. ${CZECH_MONTHS_GENITIVE[parts.month - 1]}`;
}
