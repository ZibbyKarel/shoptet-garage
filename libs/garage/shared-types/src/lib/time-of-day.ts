/**
 * Half-hour time-of-day (`HH:MM`) handling for guest reservations.
 *
 * Admins book guests into half-hour blocks, not whole days. A booking spans
 * `[start, end)` where both are half-hour times: `10:00`–`11:00` and
 * `11:00`–`12:00` are adjacent slots with no overlap. The day is `00:00`–`24:00`
 * (48 half-hour slots), so `24:00` is a valid *end* time (the day's exclusive
 * upper bound) but never a start time.
 *
 * Times are transmitted as `HH:MM` strings on the wire for human readability,
 * but stored as minutes-since-midnight for arithmetic: `timeOfDayToMinutes` and
 * `minutesToTimeOfDay` convert between the two.
 */

export type TimeOfDay = string;

export const MINUTES_PER_DAY = 1440;
export const TIME_BLOCK_MINUTES = 30;

const HALF_HOUR_TIME = /^(?:(?:[01]\d|2[0-3]):(?:00|30)|24:00)$/;

/**
 * True when `value` is a half-hour time: `00:00`, `00:30`, …, `23:30`, `24:00`.
 */
export function isHalfHourTime(value: string): boolean {
  return HALF_HOUR_TIME.test(value);
}

/**
 * Converts `HH:MM` to minutes since midnight. Throws if the value is not a
 * valid half-hour time.
 */
export function timeOfDayToMinutes(value: TimeOfDay): number {
  if (!isHalfHourTime(value)) {
    throw new Error(`Not a half-hour time of day: ${JSON.stringify(value)}`);
  }
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours * 60 + minutes;
}

/**
 * Converts minutes since midnight to `HH:MM`. Throws unless the minutes are
 * in `[0, 1440]` and divisible by 30.
 */
export function minutesToTimeOfDay(minutes: number): TimeOfDay {
  if (
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > MINUTES_PER_DAY ||
    minutes % TIME_BLOCK_MINUTES !== 0
  ) {
    throw new Error(`Not a half-hour minute of the day: ${minutes}`);
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const SLOTS = MINUTES_PER_DAY / TIME_BLOCK_MINUTES;

/**
 * All valid half-hour start times: `00:00`, `00:30`, …, `23:30` (48 entries).
 */
export const HALF_HOUR_START_TIMES: readonly TimeOfDay[] = Array.from({ length: SLOTS }, (_, i) =>
  minutesToTimeOfDay(i * TIME_BLOCK_MINUTES)
);

/**
 * All valid half-hour end times: `00:30`, `01:00`, …, `24:00` (48 entries).
 */
export const HALF_HOUR_END_TIMES: readonly TimeOfDay[] = Array.from({ length: SLOTS }, (_, i) =>
  minutesToTimeOfDay((i + 1) * TIME_BLOCK_MINUTES)
);
