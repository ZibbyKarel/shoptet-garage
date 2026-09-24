import { DEFAULT_OPEN_DAYS_BEFORE, MAX_OPEN_DAYS_BEFORE } from './domain-constants';
import {
  isMonthOpen,
  isMonthlyCapInForce,
  monthLockState,
  reservationWindowRange,
} from './reservation-window';

const DEFAULT_DAYS = DEFAULT_OPEN_DAYS_BEFORE; // 7

describe('reservationWindowRange', () => {
  it('opens `openDaysBefore` days before the first of the target month and closes the day before it', () => {
    expect(reservationWindowRange('2026-09-15', DEFAULT_DAYS)).toEqual({
      from: '2026-08-25',
      to: '2026-08-31',
    });
  });

  it('is the same for every day of the target month', () => {
    const first = reservationWindowRange('2026-09-01', DEFAULT_DAYS);
    expect(reservationWindowRange('2026-09-30', DEFAULT_DAYS)).toEqual(first);
  });

  it('reaches back into the previous year for a January target', () => {
    expect(reservationWindowRange('2027-01-10', DEFAULT_DAYS)).toEqual({
      from: '2026-12-25',
      to: '2026-12-31',
    });
  });

  it('reaches back over a short February at the maximum of 31 days', () => {
    expect(reservationWindowRange('2026-03-05', MAX_OPEN_DAYS_BEFORE)).toEqual({
      from: '2026-01-29',
      to: '2026-02-28',
    });
    // 2024 is a leap year, so the same 31 days land one day later.
    expect(reservationWindowRange('2024-03-05', MAX_OPEN_DAYS_BEFORE)).toEqual({
      from: '2024-01-30',
      to: '2024-02-29',
    });
  });

  it('works at the minimum of a single day', () => {
    expect(reservationWindowRange('2026-09-15', 1)).toEqual({
      from: '2026-08-31',
      to: '2026-08-31',
    });
  });
});

describe('monthLockState — AUTO boundaries', () => {
  const target = '2026-09-15'; // window: 2026-08-25 .. 2026-08-31

  it.each([
    ['2026-08-24', 'NOT_YET_OPEN', 'the day before the window opens'],
    ['2026-08-25', 'OPEN', 'the first day of the window'],
    ['2026-08-28', 'OPEN', 'a day inside the window'],
    ['2026-08-31', 'OPEN', 'the last day of the window'],
    ['2026-09-01', 'OPEN', 'the first day of the target month — it stays open'],
    ['2026-09-30', 'OPEN', 'the last day of the target month'],
  ])('%s is %s (%s)', (today, expected) => {
    expect(monthLockState(target, DEFAULT_DAYS, 'AUTO', today)).toBe(expected);
  });

  it('reports a month far in the future as NOT_YET_OPEN', () => {
    expect(monthLockState('2027-06-01', DEFAULT_DAYS, 'AUTO', '2026-08-28')).toBe('NOT_YET_OPEN');
  });

  it('keeps the running month open, so leftover spots can still be booked', () => {
    expect(monthLockState('2026-08-28', DEFAULT_DAYS, 'AUTO', '2026-08-28')).toBe('OPEN');
    expect(monthLockState('2026-08-31', DEFAULT_DAYS, 'AUTO', '2026-08-01')).toBe('OPEN');
  });

  it('never reports LOCKED under AUTO — a past day is refused as PAST_DATE elsewhere', () => {
    expect(monthLockState('2026-07-15', DEFAULT_DAYS, 'AUTO', '2026-08-28')).toBe('OPEN');
  });
});

describe('monthLockState — year rollover', () => {
  const target = '2027-01-10'; // window: 2026-12-25 .. 2026-12-31

  it.each([
    ['2026-12-24', 'NOT_YET_OPEN'],
    ['2026-12-25', 'OPEN'],
    ['2026-12-31', 'OPEN'],
    ['2027-01-01', 'OPEN'],
  ])('%s is %s', (today, expected) => {
    expect(monthLockState(target, DEFAULT_DAYS, 'AUTO', today)).toBe(expected);
  });
});

describe('monthLockState — across a daylight saving transition', () => {
  it('opens on the 23-hour spring-forward day', () => {
    // April 2026 window: 2026-03-25 .. 2026-03-31, spanning 2026-03-29 (23 h).
    expect(monthLockState('2026-04-10', DEFAULT_DAYS, 'AUTO', '2026-03-24')).toBe('NOT_YET_OPEN');
    expect(monthLockState('2026-04-10', DEFAULT_DAYS, 'AUTO', '2026-03-29')).toBe('OPEN');
    expect(monthLockState('2026-04-10', DEFAULT_DAYS, 'AUTO', '2026-04-01')).toBe('OPEN');
  });

  it('opens exactly on the 25-hour fall-back day', () => {
    // November 2026 window: 2026-10-25 .. 2026-10-31; 2026-10-25 is 25 h long.
    expect(reservationWindowRange('2026-11-05', DEFAULT_DAYS).from).toBe('2026-10-25');
    expect(monthLockState('2026-11-05', DEFAULT_DAYS, 'AUTO', '2026-10-24')).toBe('NOT_YET_OPEN');
    expect(monthLockState('2026-11-05', DEFAULT_DAYS, 'AUTO', '2026-10-25')).toBe('OPEN');
  });
});

describe('monthLockState — admin overrides', () => {
  it('FORCE_OPEN opens every month regardless of the date', () => {
    expect(monthLockState('2026-08-28', DEFAULT_DAYS, 'FORCE_OPEN', '2026-08-28')).toBe('OPEN');
    expect(monthLockState('2027-12-01', DEFAULT_DAYS, 'FORCE_OPEN', '2026-08-28')).toBe('OPEN');
    expect(monthLockState('2020-01-01', DEFAULT_DAYS, 'FORCE_OPEN', '2026-08-28')).toBe('OPEN');
  });

  it('FORCE_LOCKED locks every month regardless of the date', () => {
    expect(monthLockState('2026-09-15', DEFAULT_DAYS, 'FORCE_LOCKED', '2026-08-28')).toBe('LOCKED');
    expect(monthLockState('2026-09-15', DEFAULT_DAYS, 'FORCE_LOCKED', '2026-08-25')).toBe('LOCKED');
  });
});

describe('isMonthOpen', () => {
  it('is true exactly when monthLockState is OPEN', () => {
    const cases: [string, string][] = [
      ['2026-09-15', '2026-08-24'],
      ['2026-09-15', '2026-08-25'],
      ['2026-09-15', '2026-08-31'],
      ['2026-09-15', '2026-09-01'],
      ['2027-01-10', '2026-12-25'],
    ];
    for (const [target, today] of cases) {
      expect(isMonthOpen(target, DEFAULT_DAYS, 'AUTO', today)).toBe(
        monthLockState(target, DEFAULT_DAYS, 'AUTO', today) === 'OPEN'
      );
    }
  });

  it('matches the four AUTO boundaries', () => {
    expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'AUTO', '2026-08-24')).toBe(false);
    expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'AUTO', '2026-08-25')).toBe(true);
    expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'AUTO', '2026-08-31')).toBe(true);
    expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'AUTO', '2026-09-01')).toBe(true);
  });

  it('follows the admin override', () => {
    expect(isMonthOpen('2026-08-28', DEFAULT_DAYS, 'FORCE_OPEN', '2026-08-28')).toBe(true);
    expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'FORCE_LOCKED', '2026-08-25')).toBe(false);
  });

  it('is pure: it never consults the clock and never enforces anything', () => {
    // Waitlist auto-promotion is a system action exempt from the lock, which
    // only works because callers can simply not call this function.
    jest.useFakeTimers().setSystemTime(new Date('2100-01-01T00:00:00Z'));
    try {
      expect(isMonthOpen('2026-09-15', DEFAULT_DAYS, 'AUTO', '2026-08-25')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an invalid date instead of silently defaulting', () => {
    expect(() => isMonthOpen('2026-02-30', DEFAULT_DAYS, 'AUTO', '2026-01-25')).toThrow(TypeError);
  });
});

describe('isMonthlyCapInForce', () => {
  const target = '2026-09-15'; // window: 2026-08-25 .. 2026-08-31

  it.each([
    ['2026-08-24', false, 'before the window — nothing can be booked, nothing to cap'],
    ['2026-08-25', true, 'the first day of the window'],
    ['2026-08-31', true, 'the last day of the window'],
    ['2026-09-01', false, 'the month has started — leftovers are free for all'],
    ['2026-09-30', false, 'the last day of the month'],
  ])('under AUTO on %s is %s (%s)', (today, expected) => {
    expect(isMonthlyCapInForce(target, DEFAULT_DAYS, 'AUTO', today)).toBe(expected);
  });

  it('is false under FORCE_OPEN, even on a day inside the automatic window', () => {
    expect(isMonthlyCapInForce(target, DEFAULT_DAYS, 'FORCE_OPEN', '2026-08-28')).toBe(false);
  });

  it('is false under FORCE_LOCKED — nobody but an admin can book, and admins book uncapped', () => {
    expect(isMonthlyCapInForce(target, DEFAULT_DAYS, 'FORCE_LOCKED', '2026-08-28')).toBe(false);
  });

  it('answers per month, not per day — every day of the month shares one window', () => {
    expect(isMonthlyCapInForce('2026-09-01', DEFAULT_DAYS, 'AUTO', '2026-08-28')).toBe(true);
    expect(isMonthlyCapInForce('2026-09-30', DEFAULT_DAYS, 'AUTO', '2026-08-28')).toBe(true);
  });

  it('follows openDaysBefore', () => {
    expect(isMonthlyCapInForce(target, 1, 'AUTO', '2026-08-30')).toBe(false);
    expect(isMonthlyCapInForce(target, 1, 'AUTO', '2026-08-31')).toBe(true);
  });

  it('crosses a year boundary', () => {
    expect(isMonthlyCapInForce('2027-01-10', DEFAULT_DAYS, 'AUTO', '2026-12-31')).toBe(true);
    expect(isMonthlyCapInForce('2027-01-10', DEFAULT_DAYS, 'AUTO', '2027-01-01')).toBe(false);
  });
});
