import {
  DATE_A,
  INVALID_DATE,
  NOT_A_UUID,
  TIMESTAMP,
  UUID_A,
  UUID_B,
  UUID_C,
  userFixture,
  userSummaryFixture,
} from '../__fixtures__/fixtures';
import {
  cellLockedEventSchema,
  cellRefSchema,
  cellUnlockedEventSchema,
  reservationCancelledEventSchema,
  reservationCreatedEventSchema,
  reservationReassignedEventSchema,
  timedReservationsUpdatedEventSchema,
  waitlistUpdatedEventSchema,
} from './events';

const cell = { date: DATE_A, parkingSpotId: UUID_B };
const publicReservation = {
  id: UUID_C,
  createdAt: TIMESTAMP,
  holder: {
    kind: 'USER' as const,
    userId: userSummaryFixture.id,
    name: userSummaryFixture.name,
    licensePlate: userSummaryFixture.licensePlate,
  },
};

describe('cellRefSchema', () => {
  it('accepts a day and a spot', () => {
    expect(cellRefSchema.parse(cell)).toEqual(cell);
  });

  it.each([
    ['a calendar-invalid date', { ...cell, date: INVALID_DATE }],
    ['a timestamp instead of a day', { ...cell, date: TIMESTAMP }],
    ['a non-uuid spot', { ...cell, parkingSpotId: NOT_A_UUID }],
    ['a missing date', { parkingSpotId: UUID_B }],
    ['a missing spot', { date: DATE_A }],
  ])('rejects %s', (_case, value) => {
    expect(cellRefSchema.safeParse(value).success).toBe(false);
  });
});

describe('cellLockedEventSchema', () => {
  const locked = { ...cell, lockedBy: userSummaryFixture, expiresAt: TIMESTAMP };

  it('carries the cell, the holder and the deadline', () => {
    expect(cellLockedEventSchema.parse(locked)).toEqual(locked);
  });

  it('never broadcasts a secret, even when handed a whole user', () => {
    // The event goes to every member of the day room. `userSummarySchema` is the
    // boundary; assert the stripping rather than trusting it.
    const parsed = cellLockedEventSchema.parse({ ...locked, lockedBy: userFixture });
    expect(Object.keys(parsed.lockedBy).sort()).toEqual(['id', 'licensePlate', 'name']);
  });

  it('requires the deadline: a client must be able to expire a stale hold itself', () => {
    expect(cellLockedEventSchema.safeParse({ ...cell, lockedBy: userSummaryFixture }).success).toBe(
      false
    );
  });

  it('rejects a non-timestamp deadline', () => {
    expect(cellLockedEventSchema.safeParse({ ...locked, expiresAt: DATE_A }).success).toBe(false);
  });
});

describe('cellUnlockedEventSchema', () => {
  it('is just the cell — who used to hold it is of no use', () => {
    expect(cellUnlockedEventSchema.parse(cell)).toEqual(cell);
    expect(Object.keys(cellUnlockedEventSchema.parse(cell)).sort()).toEqual([
      'date',
      'parkingSpotId',
    ]);
  });
});

describe('reservationCreatedEventSchema', () => {
  const created = { ...cell, reservation: publicReservation };

  it('carries the whole public reservation, so a tile repaints without a refetch', () => {
    expect(reservationCreatedEventSchema.parse(created)).toEqual(created);
  });

  it('rejects a bare reservation id', () => {
    expect(reservationCreatedEventSchema.safeParse({ ...cell, reservation: UUID_C }).success).toBe(
      false
    );
  });

  it('rejects a reservation without its holder', () => {
    expect(
      reservationCreatedEventSchema.safeParse({
        ...cell,
        reservation: { id: UUID_C, createdAt: TIMESTAMP },
      }).success
    ).toBe(false);
  });
});

describe('reservationCancelledEventSchema', () => {
  const cancelled = { ...cell, reservationId: UUID_C };

  it('carries the cell and the reservation that went away', () => {
    expect(reservationCancelledEventSchema.parse(cancelled)).toEqual(cancelled);
  });

  it('says nothing about a promotion — that is a different event', () => {
    // A cancellation that promoted somebody emits `reservation:reassigned`
    // instead, so this payload has no `promoted` flag and no new holder.
    const keys = Object.keys(reservationCancelledEventSchema.parse(cancelled));
    expect(keys).not.toContain('promoted');
    expect(keys).not.toContain('reservation');
  });

  it('rejects a non-uuid reservation id', () => {
    expect(
      reservationCancelledEventSchema.safeParse({ ...cell, reservationId: NOT_A_UUID }).success
    ).toBe(false);
  });
});

describe('reservationReassignedEventSchema', () => {
  const reassigned = {
    ...cell,
    cause: 'WAITLIST_PROMOTION',
    previousReservationId: UUID_C,
    reservation: publicReservation,
    fromWaitlistEntryId: UUID_A,
  };

  it('accepts a waitlist promotion', () => {
    expect(reservationReassignedEventSchema.parse(reassigned)).toEqual(reassigned);
  });

  it('lets a client tell a system reassignment from a user action', () => {
    // Ruling window-1: auto-promotion is exempt from the reservation-window
    // lock precisely because no user performed it. Both the event name and
    // `cause` say so; a `reservation:created` in a locked month would instead
    // look like the window had been violated.
    const parsed = reservationReassignedEventSchema.parse(reassigned);
    expect(parsed.cause).toBe('WAITLIST_PROMOTION');
  });

  it('rejects an unknown cause', () => {
    // Closed enum: a cause nothing emits must not be expressible.
    expect(
      reservationReassignedEventSchema.safeParse({ ...reassigned, cause: 'ADMIN_REASSIGNMENT' })
        .success
    ).toBe(false);
  });

  it('carries both the released and the new reservation', () => {
    const parsed = reservationReassignedEventSchema.parse(reassigned);
    expect(parsed.previousReservationId).toBe(UUID_C);
    expect(parsed.reservation.id).toBe(UUID_C);
  });

  it('allows a null queue entry so a future non-promotion cause is not breaking', () => {
    expect(
      reservationReassignedEventSchema.safeParse({ ...reassigned, fromWaitlistEntryId: null })
        .success
    ).toBe(true);
  });

  it('rejects an omitted queue entry: null has to be said out loud', () => {
    const { fromWaitlistEntryId: _omitted, ...withoutEntry } = reassigned;
    expect(reservationReassignedEventSchema.safeParse(withoutEntry).success).toBe(false);
  });
});

describe('waitlistUpdatedEventSchema', () => {
  const updated = { ...cell, waitlistCount: 3 };

  it('carries only the count', () => {
    expect(waitlistUpdatedEventSchema.parse(updated)).toEqual(updated);
    expect(Object.keys(waitlistUpdatedEventSchema.parse(updated)).sort()).toEqual([
      'date',
      'parkingSpotId',
      'waitlistCount',
    ]);
  });

  it('never names who is queued', () => {
    // Queue membership is not public: `overview.day` gives a stranger the count
    // and nothing else, and this event reaches the whole day room.
    const parsed = waitlistUpdatedEventSchema.parse({
      ...updated,
      entries: [{ userId: UUID_A }],
      viewerWaitlistPosition: 2,
    }) as Record<string, unknown>;
    expect('entries' in parsed).toBe(false);
    expect('viewerWaitlistPosition' in parsed).toBe(false);
  });

  it('accepts an empty queue', () => {
    expect(waitlistUpdatedEventSchema.safeParse({ ...cell, waitlistCount: 0 }).success).toBe(true);
  });

  it.each([
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['a stringified count', '3'],
  ])('rejects %s', (_case, waitlistCount) => {
    expect(waitlistUpdatedEventSchema.safeParse({ ...cell, waitlistCount }).success).toBe(false);
  });
});

describe('timedReservationsUpdatedEventSchema', () => {
  const timedReservation = {
    id: UUID_A,
    startTime: '09:00',
    endTime: '10:30',
    guestName: 'Jana Hostová',
    licensePlate: null,
    createdAt: TIMESTAMP,
  };
  const updated = { ...cell, timedReservations: [timedReservation] };

  it('carries the cell and the whole current list of blocks', () => {
    expect(timedReservationsUpdatedEventSchema.parse(updated)).toEqual(updated);
  });

  it('accepts an empty list — the last block on a cell was just cancelled', () => {
    expect(
      timedReservationsUpdatedEventSchema.safeParse({ ...cell, timedReservations: [] }).success
    ).toBe(true);
  });

  it('rejects a bare id in place of a block', () => {
    expect(
      timedReservationsUpdatedEventSchema.safeParse({ ...cell, timedReservations: [UUID_A] })
        .success
    ).toBe(false);
  });

  it('rejects a missing list: a client must not be left to guess it is empty', () => {
    expect(timedReservationsUpdatedEventSchema.safeParse(cell).success).toBe(false);
  });
});

describe('every event payload', () => {
  it('identifies its cell, because a client is joined to several day rooms', () => {
    // Socket.io does not tell a handler which room a message arrived through,
    // so `date` cannot be left implicit even though the room implies it.
    for (const schema of [
      cellLockedEventSchema,
      cellUnlockedEventSchema,
      reservationCreatedEventSchema,
      reservationCancelledEventSchema,
      reservationReassignedEventSchema,
      timedReservationsUpdatedEventSchema,
      waitlistUpdatedEventSchema,
    ]) {
      expect(schema.safeParse({ parkingSpotId: UUID_B }).success).toBe(false);
    }
  });
});
