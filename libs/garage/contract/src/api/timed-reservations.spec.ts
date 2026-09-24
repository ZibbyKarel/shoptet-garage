import {
  cancelTimedReservationInputSchema,
  createTimedReservationInputSchema,
} from './timed-reservations';

const base = {
  parkingSpotId: '0192f5f0-0000-7000-8000-000000000001',
  date: '2026-10-05',
  guestName: 'Jana Hostová',
  licensePlate: null,
};

describe('createTimedReservationInputSchema', () => {
  it.each([
    ['09:00', '10:30'],
    ['00:00', '24:00'],
    ['23:30', '24:00'],
  ])('accepts %s–%s', (startTime, endTime) => {
    expect(
      createTimedReservationInputSchema.safeParse({ ...base, startTime, endTime }).success
    ).toBe(true);
  });

  it.each([
    ['10:00', '10:00'],
    ['11:00', '10:30'],
    ['10:15', '11:00'],
    ['10:00', '24:30'],
    ['24:00', '24:00'],
  ])('refuses %s–%s', (startTime, endTime) => {
    expect(
      createTimedReservationInputSchema.safeParse({ ...base, startTime, endTime }).success
    ).toBe(false);
  });

  it('refuses an empty guest name', () => {
    expect(
      createTimedReservationInputSchema.safeParse({
        ...base,
        guestName: '',
        startTime: '09:00',
        endTime: '10:00',
      }).success
    ).toBe(false);
  });
});

describe('cancelTimedReservationInputSchema', () => {
  it('needs a uuid', () => {
    expect(cancelTimedReservationInputSchema.safeParse({ timedReservationId: 'x' }).success).toBe(
      false
    );
  });
});
