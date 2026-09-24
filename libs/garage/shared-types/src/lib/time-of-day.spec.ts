import {
  HALF_HOUR_END_TIMES,
  HALF_HOUR_START_TIMES,
  isHalfHourTime,
  minutesToTimeOfDay,
  timeOfDayToMinutes,
} from './time-of-day';

describe('half-hour times of day', () => {
  it.each(['00:00', '00:30', '09:30', '23:30', '24:00'])('accepts %s', (value) => {
    expect(isHalfHourTime(value)).toBe(true);
  });

  it.each(['24:30', '10:15', '9:30', '25:00', '', '10:00:00', '23:60'])('refuses %j', (value) => {
    expect(isHalfHourTime(value)).toBe(false);
  });

  it('round-trips minutes', () => {
    expect(timeOfDayToMinutes('00:00')).toBe(0);
    expect(timeOfDayToMinutes('10:30')).toBe(630);
    expect(timeOfDayToMinutes('24:00')).toBe(1440);
    expect(minutesToTimeOfDay(630)).toBe('10:30');
    expect(minutesToTimeOfDay(1440)).toBe('24:00');
  });

  it('throws on values off the half-hour grid', () => {
    expect(() => timeOfDayToMinutes('10:15')).toThrow();
    expect(() => minutesToTimeOfDay(45)).toThrow();
    expect(() => minutesToTimeOfDay(1470)).toThrow();
    expect(() => minutesToTimeOfDay(-30)).toThrow();
  });

  it('lists 48 starts and 48 ends', () => {
    expect(HALF_HOUR_START_TIMES).toHaveLength(48);
    expect(HALF_HOUR_START_TIMES[0]).toBe('00:00');
    expect(HALF_HOUR_START_TIMES.at(-1)).toBe('23:30');
    expect(HALF_HOUR_END_TIMES).toHaveLength(48);
    expect(HALF_HOUR_END_TIMES[0]).toBe('00:30');
    expect(HALF_HOUR_END_TIMES.at(-1)).toBe('24:00');
  });
});
