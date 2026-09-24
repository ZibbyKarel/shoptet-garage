export * from './lib/date-only';
export * from './lib/prague-time';
export * from './lib/time-of-day';
/**
 * Named, not a star: the Easter arithmetic (`easterSunday`, `goodFriday`,
 * `easterMonday`, `GOOD_FRIDAY_FIRST_YEAR`) and the year's holiday table
 * (`czechPublicHolidays`, `CZECH_HOLIDAY_IDS`, `CzechHolidayId`) are how the
 * calendar is computed, not what a caller asks it. Nothing outside this lib
 * names any of them; `czech-holidays.spec.ts` imports the module directly.
 *
 * This barrel is also `@garage/i18n`'s, re-exported wholesale under the
 * same names by `doc/decision/0003-*` — so a symbol published here is
 * published to the browser bundle too.
 */
export { czechPublicHolidayOn, isBusinessDay, isCzechPublicHoliday } from './lib/czech-holidays';
export type { CzechHoliday } from './lib/czech-holidays';
export * from './lib/domain-constants';
export * from './lib/reservation-window';
