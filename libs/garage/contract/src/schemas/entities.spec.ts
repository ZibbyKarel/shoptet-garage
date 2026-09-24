import {
  AUDIT_LOG_ACTIONS,
  auditLogActionSchema,
  auditLogSchema,
  parkingSpotSchema,
  publicReservationSchema,
  publicTimedReservationSchema,
  reservationSchema,
  timedReservationSchema,
  userSchema,
  userSummarySchema,
  waitlistEntrySchema,
} from './entities';

const ID = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const OTHER_ID = '2c0f1a5e-9a1b-4c3d-8e7f-0a1b2c3d4e5f';
const NOW = '2026-08-28T09:15:00.000Z';

const validUser = {
  id: ID,
  email: 'karel.zibar@team.blue',
  name: 'Karel Zíbar',
  licensePlate: '1AB 2345',
  role: 'USER',
  oktaId: 'okta|00u1234',
  active: true,
  icsToken: 'f2b1c3d4e5f6',
  preferredParkingSpotId: OTHER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('userSchema', () => {
  it('accepts a complete user', () => {
    expect(userSchema.safeParse(validUser).success).toBe(true);
  });

  it('accepts null for the nullable fields', () => {
    const result = userSchema.safeParse({
      ...validUser,
      licensePlate: null,
      preferredParkingSpotId: null,
    });
    expect(result.success).toBe(true);
  });

  it('requires the nullable fields to be present', () => {
    const { licensePlate, preferredParkingSpotId, ...withoutNullables } = validUser;
    void licensePlate;
    void preferredParkingSpotId;
    expect(userSchema.safeParse(withoutNullables).success).toBe(false);
  });

  it.each([
    ['email', 'not-an-email'],
    ['email', ''],
    ['name', ''],
    ['role', 'SUPERADMIN'],
    ['oktaId', ''],
    ['icsToken', ''],
    ['active', 'true'],
    ['id', 'nope'],
    ['preferredParkingSpotId', 'nope'],
    ['createdAt', '2026-08-28'],
  ])('rejects an invalid %s (%p)', (field, value) => {
    expect(userSchema.safeParse({ ...validUser, [field]: value }).success).toBe(false);
  });

  it('strips unknown keys rather than failing', () => {
    const result = userSchema.safeParse({ ...validUser, passwordHash: 'nope' });
    expect(result.success).toBe(true);
    expect(result.success && 'passwordHash' in result.data).toBe(false);
  });
});

describe('userSummarySchema', () => {
  const summary = { id: ID, name: 'Karel Zíbar', licensePlate: '1AB 2345' };

  it('accepts the three public fields', () => {
    expect(userSummarySchema.parse(summary)).toEqual(summary);
  });

  it('never leaks the ICS token, e-mail or Okta id of another user', () => {
    // The pick is the security boundary: parsing a whole user must strip them.
    // This matters more for the realtime events than for the day overview —
    // they are broadcast into a room every member of the day can hear.
    const parsed = userSummarySchema.parse(validUser);
    expect(parsed).toEqual({ id: ID, name: validUser.name, licensePlate: validUser.licensePlate });
    expect(Object.keys(parsed).sort()).toEqual(['id', 'licensePlate', 'name']);
  });

  it('rejects a summary with an invalid id', () => {
    expect(userSummarySchema.safeParse({ ...summary, id: 'nope' }).success).toBe(false);
  });
});

describe('publicReservationSchema', () => {
  const heldByUser = {
    id: ID,
    createdAt: NOW,
    holder: {
      kind: 'USER' as const,
      userId: OTHER_ID,
      name: 'Jana Nováková',
      licensePlate: null,
    },
  };

  const heldByGuest = {
    id: ID,
    createdAt: NOW,
    holder: { kind: 'GUEST' as const, name: 'Jan Host', licensePlate: '9XY 8765' },
  };

  it('accepts a reservation held by a user', () => {
    expect(publicReservationSchema.parse(heldByUser)).toEqual(heldByUser);
  });

  it('accepts a reservation held by a guest', () => {
    expect(publicReservationSchema.parse(heldByGuest)).toEqual(heldByGuest);
  });

  it('carries no spot, holder row or date of its own', () => {
    // All three come from the context the payload travels in — the spot row of
    // the day overview, or the event payload of a realtime broadcast.
    expect(Object.keys(publicReservationSchema.parse(heldByUser)).sort()).toEqual([
      'createdAt',
      'holder',
      'id',
    ]);
  });

  it('gives a guest no userId at all — the guest case is unrepresentable as a user', () => {
    const parsed = publicReservationSchema.parse({
      ...heldByGuest,
      holder: { ...heldByGuest.holder, userId: OTHER_ID },
    });
    expect('userId' in parsed.holder).toBe(false);
  });

  it('strips a user holder built from a full user down to the four public fields', () => {
    // Zod strips unknown keys on a `z.object`; assert the stripping, so a
    // widened `userSchema` can never smuggle `icsToken` into a broadcast.
    const parsed = publicReservationSchema.parse({
      ...heldByUser,
      holder: { kind: 'USER', userId: validUser.id, ...validUser },
    });
    expect('icsToken' in parsed.holder).toBe(false);
    expect('email' in parsed.holder).toBe(false);
  });

  it('rejects a missing holder, an unknown kind, and an empty holder name', () => {
    expect(publicReservationSchema.safeParse({ id: ID, createdAt: NOW }).success).toBe(false);
    expect(
      publicReservationSchema.safeParse({
        ...heldByUser,
        holder: { kind: 'ROBOT', name: 'x', licensePlate: null },
      }).success
    ).toBe(false);
    expect(
      publicReservationSchema.safeParse({
        ...heldByGuest,
        holder: { kind: 'GUEST', name: '', licensePlate: null },
      }).success
    ).toBe(false);
  });
});

describe('reservationSchema — the holder columns', () => {
  const base = {
    id: ID,
    parkingSpotId: OTHER_ID,
    date: '2099-01-05',
    createdAt: NOW,
  };

  it('accepts a reservation held by a user, with no guest name', () => {
    const row = { ...base, userId: OTHER_ID, guestName: null, licensePlate: null };
    expect(reservationSchema.parse(row)).toEqual(row);
  });

  it('accepts a reservation held by a guest, with no userId', () => {
    const row = { ...base, userId: null, guestName: 'Jan Host', licensePlate: '9XY 8765' };
    expect(reservationSchema.parse(row)).toEqual(row);
  });

  it('carries the per-reservation plate that overrides the holder’s stored one', () => {
    const row = { ...base, userId: OTHER_ID, guestName: null, licensePlate: '1AB 2345' };
    expect(reservationSchema.parse(row).licensePlate).toBe('1AB 2345');
  });

  it('rejects an empty guest name and an empty plate — absent is `null`, never `""`', () => {
    expect(
      reservationSchema.safeParse({ ...base, userId: null, guestName: '', licensePlate: null })
        .success
    ).toBe(false);
    expect(
      reservationSchema.safeParse({
        ...base,
        userId: OTHER_ID,
        guestName: null,
        licensePlate: '',
      }).success
    ).toBe(false);
  });
});

describe('timedReservationSchema / publicTimedReservationSchema', () => {
  const timedReservation = {
    id: ID,
    parkingSpotId: OTHER_ID,
    date: '2099-01-05',
    startTime: '09:00',
    endTime: '10:30',
    guestName: 'Jan Host',
    licensePlate: null,
    createdAt: NOW,
  };

  it('accepts a half-hour block for a guest', () => {
    expect(timedReservationSchema.parse(timedReservation)).toEqual(timedReservation);
  });

  it('accepts 24:00 as an end time — the day’s exclusive upper bound', () => {
    expect(
      timedReservationSchema.safeParse({
        ...timedReservation,
        startTime: '23:30',
        endTime: '24:00',
      }).success
    ).toBe(true);
  });

  it('rejects a time that is not on a half hour', () => {
    expect(
      timedReservationSchema.safeParse({ ...timedReservation, startTime: '09:15' }).success
    ).toBe(false);
    expect(
      timedReservationSchema.safeParse({ ...timedReservation, endTime: '24:01' }).success
    ).toBe(false);
  });

  it('rejects an empty guest name — a timed block always has a guest', () => {
    expect(timedReservationSchema.safeParse({ ...timedReservation, guestName: '' }).success).toBe(
      false
    );
  });

  it('projects to the six fields a viewer of the day may see', () => {
    expect(Object.keys(publicTimedReservationSchema.parse(timedReservation)).sort()).toEqual([
      'createdAt',
      'endTime',
      'guestName',
      'id',
      'licensePlate',
      'startTime',
    ]);
  });
});

describe('parkingSpotSchema', () => {
  const validSpot = {
    id: ID,
    label: 'E2.92',
    group: 'IT',
    active: true,
    hidden: false,
    evCharger: false,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a spot from each group', () => {
    expect(parkingSpotSchema.safeParse(validSpot).success).toBe(true);
    expect(parkingSpotSchema.safeParse({ ...validSpot, group: 'SHARED' }).success).toBe(true);
  });

  it.each([
    ['label', ''],
    ['group', 'GUEST'],
    ['active', null],
  ])('rejects an invalid %s (%p)', (field, value) => {
    expect(parkingSpotSchema.safeParse({ ...validSpot, [field]: value }).success).toBe(false);
  });
});

describe('reservationSchema / waitlistEntrySchema', () => {
  const validWaitlistEntry = {
    id: ID,
    parkingSpotId: OTHER_ID,
    userId: ID,
    date: '2026-09-15',
    createdAt: NOW,
  };
  // A reservation carries its holder columns; a waitlist entry does not. The
  // two schemas were checked against one object while they happened to agree.
  const validReservation = { ...validWaitlistEntry, guestName: null, licensePlate: null };

  it.each([
    ['reservationSchema', reservationSchema, validReservation],
    ['waitlistEntrySchema', waitlistEntrySchema, validWaitlistEntry],
  ] as const)('%s accepts a valid entry', (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['reservationSchema', reservationSchema, validReservation],
    ['waitlistEntrySchema', waitlistEntrySchema, validWaitlistEntry],
  ] as const)('%s keeps the day date-only', (_name, schema, valid) => {
    expect(schema.safeParse({ ...valid, date: '2026-09-15T00:00:00.000Z' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, date: '2026-09-31' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, date: '2028-02-29' }).success).toBe(true);
  });

  it.each([
    ['reservationSchema', reservationSchema, validReservation],
    ['waitlistEntrySchema', waitlistEntrySchema, validWaitlistEntry],
  ] as const)('%s does not judge the date against the horizon', (_name, schema, valid) => {
    // Both the "not in the past" and the reservation-window checks live in the
    // service layer (Task 13), on top of monthLockState().
    expect(schema.safeParse({ ...valid, date: '2020-01-01' }).success).toBe(true);
    expect(schema.safeParse({ ...valid, date: '2099-12-31' }).success).toBe(true);
  });
});

describe('auditLogSchema', () => {
  const validEntry = {
    id: ID,
    actorUserId: OTHER_ID,
    action: 'RESERVATION_CREATED',
    entityType: 'Reservation',
    entityId: ID,
    payload: { parkingSpotId: OTHER_ID, date: '2026-09-15' },
    createdAt: NOW,
  };

  it('accepts a valid entry', () => {
    expect(auditLogSchema.safeParse(validEntry).success).toBe(true);
  });

  it('accepts an empty payload', () => {
    expect(auditLogSchema.safeParse({ ...validEntry, payload: {} }).success).toBe(true);
  });

  it.each([
    ['action', 'SOMETHING_ELSE'],
    ['entityType', ''],
    ['entityId', ''],
    ['payload', 'not-an-object'],
    ['payload', null],
    ['actorUserId', null],
  ])('rejects an invalid %s (%p)', (field, value) => {
    expect(auditLogSchema.safeParse({ ...validEntry, [field]: value }).success).toBe(false);
  });

  it('enumerates the actions named in the domain model', () => {
    expect([...AUDIT_LOG_ACTIONS]).toEqual([
      'RESERVATION_CREATED',
      'RESERVATION_CANCELLED',
      'RESERVATION_CANCELLED_BY_ADMIN',
      'WAITLIST_PROMOTED',
      'USER_UPDATED',
      'SPOT_UPDATED',
      'RESERVATION_WINDOW_UPDATED',
      'WAITLIST_JOINED',
      'RESERVATION_CREATED_BY_ADMIN',
      'WAITLIST_JOINED_BY_ADMIN',
      'RESERVATION_LIMITS_UPDATED',
      'TIMED_RESERVATION_CREATED',
      'TIMED_RESERVATION_CANCELLED',
    ]);
    for (const action of AUDIT_LOG_ACTIONS) {
      expect(auditLogActionSchema.safeParse(action).success).toBe(true);
    }
  });
});
