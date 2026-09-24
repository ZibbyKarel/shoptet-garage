import {
  DATE_A,
  INVALID_DATE,
  NOT_A_UUID,
  TIMESTAMP,
  UUID_A,
  UUID_B,
} from '../__fixtures__/fixtures';
import {
  cancelReservationInputSchema,
  cancelReservationOutputSchema,
  createReservationInputSchema,
  createReservationOutputSchema,
  myMonthReservationsInputSchema,
  myMonthReservationsOutputSchema,
} from './reservations';

describe('createReservationInputSchema', () => {
  const valid = { parkingSpotId: UUID_B, date: DATE_A };

  it('accepts a spot and a day', () => {
    expect(createReservationInputSchema.parse(valid)).toEqual(valid);
  });

  it('is derived from the entity — the client cannot set id, userId or createdAt', () => {
    const parsed = createReservationInputSchema.parse({
      ...valid,
      id: UUID_A,
      userId: UUID_A,
      createdAt: TIMESTAMP,
    });
    expect(parsed).toEqual(valid);
  });

  it.each([
    ['parkingSpotId', NOT_A_UUID],
    ['date', INVALID_DATE],
    ['date', '15. 9. 2026'],
  ])('rejects an invalid %s (%p)', (field, value) => {
    expect(createReservationInputSchema.safeParse({ ...valid, [field]: value }).success).toBe(
      false
    );
  });

  it('rejects a missing field', () => {
    expect(createReservationInputSchema.safeParse({ date: DATE_A }).success).toBe(false);
  });
});

describe('createReservationOutputSchema', () => {
  it('returns the whole reservation entity', () => {
    const reservation = {
      id: UUID_A,
      parkingSpotId: UUID_B,
      userId: UUID_A,
      guestName: null,
      licensePlate: null,
      date: DATE_A,
      createdAt: TIMESTAMP,
    };
    expect(createReservationOutputSchema.parse(reservation)).toEqual(reservation);
  });

  it('rejects a Date instance where an ISO timestamp is expected', () => {
    // doc/decision/0015: timestamps travel as ISO strings, not Date objects.
    expect(
      createReservationOutputSchema.safeParse({
        id: UUID_A,
        parkingSpotId: UUID_B,
        userId: UUID_A,
        guestName: null,
        licensePlate: null,
        date: DATE_A,
        createdAt: new Date(TIMESTAMP),
      }).success
    ).toBe(false);
  });
});

describe('cancelReservationInputSchema', () => {
  it('accepts a reservation id', () => {
    expect(cancelReservationInputSchema.parse({ reservationId: UUID_A })).toEqual({
      reservationId: UUID_A,
    });
  });

  it('rejects a non-uuid id and a missing id', () => {
    expect(cancelReservationInputSchema.safeParse({ reservationId: NOT_A_UUID }).success).toBe(
      false
    );
    expect(cancelReservationInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('createReservationInputSchema — the holder', () => {
  const cell = { parkingSpotId: UUID_A, date: DATE_A };

  it('accepts no holder at all — the caller books for themselves', () => {
    const parsed = createReservationInputSchema.parse(cell);
    expect(parsed).toEqual(cell);
    expect('holder' in parsed).toBe(false);
  });

  it('accepts a named user holder with an overriding plate', () => {
    const input = {
      ...cell,
      holder: { kind: 'USER' as const, userId: UUID_B, licensePlate: '9XY 8765' },
    };
    expect(createReservationInputSchema.parse(input)).toEqual(input);
  });

  it('accepts a named user holder with no plate override', () => {
    const input = {
      ...cell,
      holder: { kind: 'USER' as const, userId: UUID_B, licensePlate: null },
    };
    expect(createReservationInputSchema.parse(input)).toEqual(input);
  });

  it('accepts a guest holder, and gives it no userId', () => {
    const input = {
      ...cell,
      holder: { kind: 'GUEST' as const, name: 'Jan Host', licensePlate: null },
    };
    const parsed = createReservationInputSchema.parse(input);
    expect(parsed.holder).toEqual(input.holder);
    expect(parsed.holder !== undefined && 'userId' in parsed.holder).toBe(false);
  });

  it('rejects a guest with an empty name', () => {
    expect(
      createReservationInputSchema.safeParse({
        ...cell,
        holder: { kind: 'GUEST', name: '', licensePlate: null },
      }).success
    ).toBe(false);
  });

  it('rejects a user holder with no userId', () => {
    expect(
      createReservationInputSchema.safeParse({
        ...cell,
        holder: { kind: 'USER', licensePlate: null },
      }).success
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(
      createReservationInputSchema.safeParse({
        ...cell,
        holder: { kind: 'ROBOT', name: 'x', licensePlate: null },
      }).success
    ).toBe(false);
  });
});

describe('cancelReservationOutputSchema', () => {
  const valid = {
    reservationId: UUID_A,
    date: DATE_A,
    parkingSpotId: UUID_B,
    promoted: false,
  };

  it('echoes the day and spot plus whether the queue absorbed the spot', () => {
    expect(cancelReservationOutputSchema.parse(valid)).toEqual(valid);
    expect(cancelReservationOutputSchema.parse({ ...valid, promoted: true }).promoted).toBe(true);
  });

  it('requires promoted — the client must not have to guess', () => {
    const withoutPromoted: Record<string, unknown> = { ...valid };
    delete withoutPromoted['promoted'];
    expect(cancelReservationOutputSchema.safeParse(withoutPromoted).success).toBe(false);
  });

  it('rejects a non-boolean promoted flag', () => {
    expect(cancelReservationOutputSchema.safeParse({ ...valid, promoted: 'yes' }).success).toBe(
      false
    );
  });
});

describe('myMonthReservationsInputSchema', () => {
  it('accepts a valid year-month', () => {
    expect(myMonthReservationsInputSchema.parse({ month: '2026-09' })).toEqual({
      month: '2026-09',
    });
  });

  it.each(['2026-9', '26-09', '2026/09', '2026-13', 'not-a-month'])(
    'rejects an invalid month (%p)',
    (month) => {
      expect(myMonthReservationsInputSchema.safeParse({ month }).success).toBe(false);
    }
  );
});

describe('myMonthReservationsOutputSchema', () => {
  it('accepts the reserved dates, the count and the cap', () => {
    const output = { month: '2026-09', reservedDates: [DATE_A], count: 1, cap: 5 };
    expect(myMonthReservationsOutputSchema.parse(output)).toEqual(output);
  });

  it('accepts an empty month', () => {
    const output = { month: '2026-09', reservedDates: [], count: 0, cap: 5 };
    expect(myMonthReservationsOutputSchema.parse(output)).toEqual(output);
  });

  it('accepts a null cap — no cap applies to this month today', () => {
    const output = { month: '2026-09', reservedDates: [], count: 7, cap: null };
    expect(myMonthReservationsOutputSchema.parse(output)).toEqual(output);
  });

  it('rejects a negative count', () => {
    expect(
      myMonthReservationsOutputSchema.safeParse({
        month: '2026-09',
        reservedDates: [],
        count: -1,
        cap: 5,
      }).success
    ).toBe(false);
  });

  it('rejects a missing cap — it is required, not defaulted', () => {
    expect(
      myMonthReservationsOutputSchema.safeParse({ month: '2026-09', reservedDates: [], count: 0 })
        .success
    ).toBe(false);
  });
});
