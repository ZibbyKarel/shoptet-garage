import {
  DATE_A,
  INVALID_DATE,
  TIMESTAMP,
  UUID_A,
  parkingSpotFixture,
  userSummaryFixture,
} from '../__fixtures__/fixtures';
import { dayOverviewInputSchema, dayOverviewOutputSchema, daySpotOverviewSchema } from './overview';

describe('dayOverviewInputSchema', () => {
  it('accepts a date-only day', () => {
    expect(dayOverviewInputSchema.parse({ date: DATE_A })).toEqual({ date: DATE_A });
  });

  it.each([INVALID_DATE, '2026-9-15', '2026-09-15T00:00:00Z', '', 20260915])(
    'rejects %p as a date',
    (date) => {
      expect(dayOverviewInputSchema.safeParse({ date }).success).toBe(false);
    }
  );

  it('rejects a missing date', () => {
    expect(dayOverviewInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('daySpotOverviewSchema', () => {
  const free = {
    spot: parkingSpotFixture,
    reservation: null,
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
  };

  it('accepts a free spot', () => {
    expect(daySpotOverviewSchema.safeParse(free).success).toBe(true);
  });

  it('accepts an occupied spot with the caller queued behind it', () => {
    expect(
      daySpotOverviewSchema.safeParse({
        ...free,
        reservation: {
          id: UUID_A,
          createdAt: TIMESTAMP,
          holder: {
            kind: 'USER',
            userId: userSummaryFixture.id,
            name: userSummaryFixture.name,
            licensePlate: userSummaryFixture.licensePlate,
          },
        },
        waitlistCount: 2,
        viewerWaitlistEntryId: UUID_A,
        viewerWaitlistPosition: 2,
      }).success
    ).toBe(true);
  });

  it('rejects a negative queue count and a zero-based position', () => {
    expect(daySpotOverviewSchema.safeParse({ ...free, waitlistCount: -1 }).success).toBe(false);
    expect(daySpotOverviewSchema.safeParse({ ...free, viewerWaitlistPosition: 0 }).success).toBe(
      false
    );
  });

  it('accepts a spot carrying guest blocks', () => {
    expect(
      daySpotOverviewSchema.safeParse({
        ...free,
        timedReservations: [
          {
            id: UUID_A,
            startTime: '09:00',
            endTime: '10:30',
            guestName: 'Jan Host',
            licensePlate: null,
            createdAt: TIMESTAMP,
          },
        ],
      }).success
    ).toBe(true);
  });

  it('requires timedReservations — a spot cannot omit it and imply empty', () => {
    const withoutTimed: Record<string, unknown> = { ...free };
    delete withoutTimed['timedReservations'];
    expect(daySpotOverviewSchema.safeParse(withoutTimed).success).toBe(false);
  });
});

describe('dayOverviewOutputSchema', () => {
  const valid = {
    date: DATE_A,
    window: {
      month: '2026-09',
      windowFrom: '2026-08-25',
      windowTo: '2026-08-31',
      state: 'OPEN',
      lockMode: 'AUTO',
    },
    canReserve: true,
    canReserveMonth: true,
    spots: [
      {
        spot: parkingSpotFixture,
        reservation: null,
        waitlistCount: 0,
        viewerWaitlistEntryId: null,
        viewerWaitlistPosition: null,
        timedReservations: [],
      },
    ],
    viewerReservationId: null,
  };

  it('accepts a full day overview', () => {
    expect(dayOverviewOutputSchema.safeParse(valid).success).toBe(true);
  });

  it('carries the window state, so the frontend needs no second request', () => {
    const parsed = dayOverviewOutputSchema.parse(valid);
    expect(parsed.window.state).toBe('OPEN');
    expect(parsed.window.lockMode).toBe('AUTO');
    expect(parsed.canReserve).toBe(true);
  });

  it('requires the window — an overview without it is not renderable', () => {
    const withoutWindow: Record<string, unknown> = { ...valid };
    delete withoutWindow['window'];
    expect(dayOverviewOutputSchema.safeParse(withoutWindow).success).toBe(false);
  });

  it('rejects an overview whose window state is not a MonthLockState', () => {
    expect(
      dayOverviewOutputSchema.safeParse({
        ...valid,
        window: { ...valid.window, state: 'CLOSED' },
      }).success
    ).toBe(false);
  });

  it('requires canReserveMonth — a screen whose subject is the month cannot fall back to canReserve', () => {
    const withoutMonth: Record<string, unknown> = { ...valid };
    delete withoutMonth['canReserveMonth'];
    expect(dayOverviewOutputSchema.safeParse(withoutMonth).success).toBe(false);
  });

  it('accepts canReserve: false alongside canReserveMonth: true — a weekend in an open month', () => {
    // The two fields answer different questions, so this combination is not a
    // contradiction the schema should reject: it is the normal state of every
    // Saturday, Sunday and Czech public holiday of an open month
    // (`doc/decision/0175-*`).
    expect(
      dayOverviewOutputSchema.safeParse({ ...valid, canReserve: false, canReserveMonth: true })
        .success
    ).toBe(true);
  });

  it('keeps canReserve separate from the window state', () => {
    // An admin is not restricted by the window at all, so a LOCKED month with
    // canReserve: true is a valid payload and the UI must not "correct" it.
    expect(
      dayOverviewOutputSchema.safeParse({
        ...valid,
        window: { ...valid.window, state: 'LOCKED', lockMode: 'FORCE_LOCKED' },
        canReserve: true,
      }).success
    ).toBe(true);
  });
});
