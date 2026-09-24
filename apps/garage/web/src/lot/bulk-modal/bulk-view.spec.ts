import { createApiClient } from '@garage/api-client';
import type { BulkDayPlan, BulkDayResult, ParkingSpot } from '@garage/contract';
import { T0 } from '../../testing/fixtures';
import {
  buildMonthGrid,
  diffBulkSchedule,
  sameOutcome,
  toBadge,
  toBadgeMessage,
  toBulkErrorMessageKey,
  toPreferredSpotMessage,
  toPreferredSpotView,
  toScheduleRows,
  weekendColumns,
  type BulkDayCell,
  type BulkMonthGrid,
} from './bulk-view';

/**
 * The bulk modal's decisions, with no DOM in sight.
 *
 * The failures `toBulkErrorMessageKey` is tested against come off a **real**
 * `RPCLink` with only `fetch` replaced, exactly as `screen-state.spec.tsx`
 * builds its errors and for the same reason: a hand-built `ORPCError` would
 * assert this file's idea of the wire shape rather than the transport's, and
 * `apps/garage/web` may not import `@orpc/client` at all.
 */

function cells(grid: BulkMonthGrid): BulkDayCell[] {
  return grid.weeks
    .flatMap((week) => week.slots)
    .map((slot) => slot.day)
    .filter((day): day is BulkDayCell => day !== null);
}

function cellOn(grid: BulkMonthGrid, date: string): BulkDayCell {
  const found = cells(grid).find((cell) => cell.date === date);
  if (found === undefined) {
    throw new Error(`No cell for ${date}`);
  }
  return found;
}

function spot(id: string, label: string, overrides: Partial<ParkingSpot> = {}): ParkingSpot {
  return {
    id,
    label,
    group: 'IT',
    active: true,
    hidden: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function assigned(
  date: string,
  overrides: Partial<Extract<BulkDayPlan, { outcome: 'SPOT_ASSIGNED' }>> = {}
) {
  return {
    outcome: 'SPOT_ASSIGNED',
    date,
    parkingSpotId: 'spot-1',
    parkingSpotLabel: 'E2.92',
    isPreferredSpot: false,
    ...overrides,
  } as const satisfies BulkDayPlan;
}

function queued(
  date: string,
  overrides: Partial<Extract<BulkDayPlan, { outcome: 'QUEUED' }>> = {}
) {
  return {
    outcome: 'QUEUED',
    date,
    parkingSpotId: 'spot-1',
    parkingSpotLabel: 'E2.92',
    waitlistPosition: 2,
    ...overrides,
  } as const satisfies BulkDayPlan;
}

function unavailable(
  date: string,
  reason: 'ALREADY_HAS_RESERVATION' | 'NOT_A_BUSINESS_DAY' | 'NO_SPOTS_AVAILABLE'
) {
  return { outcome: 'UNAVAILABLE', date, reason } as const satisfies BulkDayPlan;
}

describe('buildMonthGrid — the layout the design draws', () => {
  it('starts the first row on Monday, padding the days before the 1st', () => {
    // September 2026 begins on a Tuesday (doc/design/screens/10-modal-bulk.png:
    // the first row's PO cell is empty and the 1 sits under ÚT).
    const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set());

    expect(grid.month).toBe('2026-09');
    expect(grid.weeks[0]?.slots[0]?.day).toBeNull();
    expect(grid.weeks[0]?.slots[1]?.day?.dayOfMonth).toBe(1);
  });

  it('lays out exactly seven slots per row and every day of the month once', () => {
    const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set());

    for (const week of grid.weeks) {
      expect(week.slots).toHaveLength(7);
    }
    expect(cells(grid).map((cell) => cell.dayOfMonth)).toEqual(
      Array.from({ length: 30 }, (_unused, index) => index + 1)
    );
  });

  it('handles a month that begins on a Monday with no leading blanks', () => {
    // 2026-06-01 is a Monday.
    const grid = buildMonthGrid('2026-06-10', '2026-06-01', new Set());
    expect(grid.weeks[0]?.slots[0]?.day?.dayOfMonth).toBe(1);
  });

  it('gives every slot a key that carries the month, so a re-layout cannot reuse one', () => {
    const september = buildMonthGrid('2026-09-15', '2026-09-01', new Set());
    const october = buildMonthGrid('2026-10-15', '2026-09-01', new Set());

    const keys = new Set([
      ...september.weeks.flatMap((week) => [week.key, ...week.slots.map((slot) => slot.key)]),
    ]);
    for (const week of october.weeks) {
      expect(keys.has(week.key)).toBe(false);
      for (const slot of week.slots) {
        expect(keys.has(slot.key)).toBe(false);
      }
    }
  });
});

describe('buildMonthGrid — which days may be picked', () => {
  const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set());

  it('blocks Saturday and Sunday and marks them as the right-hand columns', () => {
    // 2026-09-05 Saturday, 2026-09-06 Sunday.
    for (const date of ['2026-09-05', '2026-09-06']) {
      const cell = cellOn(grid, date);
      expect(cell).toMatchObject({ selectable: false, block: 'WEEKEND' });
      expect(cell.weekendColumn).toBe(true);
    }
  });

  it('blocks a Czech public holiday that falls on a weekday', () => {
    // 28 September — Den české státnosti, a Monday in 2026. The design greys
    // this exact cell out.
    const cell = cellOn(grid, '2026-09-28');
    expect(cell).toMatchObject({ selectable: false, block: 'HOLIDAY' });
    expect(cell.weekendColumn).toBe(false);
  });

  it('leaves an ordinary weekday selectable', () => {
    const cell = cellOn(grid, '2026-09-15');
    expect(cell).toEqual({
      date: '2026-09-15',
      dayOfMonth: 15,
      weekendColumn: false,
      selectable: true,
    });
  });

  it('blocks a business day that is already in the past', () => {
    // One `PAST_DATE` day rejects the whole batch (doc/decision/0090-*), so a
    // past cell must not be offered.
    const midMonth = buildMonthGrid('2026-09-15', '2026-09-15', new Set());
    expect(cellOn(midMonth, '2026-09-14')).toMatchObject({ selectable: false, block: 'PAST' });
    expect(cellOn(midMonth, '2026-09-15').selectable).toBe(true);
  });

  it('reports a past Saturday as a weekend, the way the allocator orders it', () => {
    // `planDay` asks `isBusinessDay` first (doc/decision/0090-*): a Saturday is
    // the most durable fact about a day. Reversing the two checks would put
    // "in the past" on a cell whose real reason never changes.
    const late = buildMonthGrid('2026-09-15', '2026-09-30', new Set());
    expect(cellOn(late, '2026-09-05')).toMatchObject({ selectable: false, block: 'WEEKEND' });
    expect(cellOn(late, '2026-09-28')).toMatchObject({ selectable: false, block: 'HOLIDAY' });
  });
});

describe('buildMonthGrid — already-reserved days', () => {
  it('marks a day the viewer already holds as ALREADY_RESERVED, not selectable', () => {
    const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set(['2026-09-16']));
    const cell = cellOn(grid, '2026-09-16');

    expect(cell.selectable).toBe(false);
    expect(cell.selectable === false && cell.block).toBe('ALREADY_RESERVED');
  });

  it('takes priority over nothing — a weekend the viewer somehow holds still reads as WEEKEND', () => {
    // 2026-09-19 is a Saturday. Business-day blocking is a more durable fact
    // about a day than "did a reservation get created here", so it is checked
    // first — mirroring the existing PAST-before-nothing-else ordering this
    // module's own docs describe for `toCell`.
    const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set(['2026-09-19']));
    const cell = cellOn(grid, '2026-09-19');

    expect(cell.selectable === false && cell.block).toBe('WEEKEND');
  });

  it('leaves an unreserved business day selectable', () => {
    const grid = buildMonthGrid('2026-09-15', '2026-09-01', new Set(['2026-09-16']));
    const cell = cellOn(grid, '2026-09-17');

    expect(cell.selectable).toBe(true);
  });
});

describe('toPreferredSpotView — the label and its four ways of not existing', () => {
  const spots = [spot('spot-1', 'E2.92'), spot('spot-2', 'E2.93')];

  it('names the spot when the id resolves', () => {
    expect(toPreferredSpotView('spot-1', spots, false)).toEqual({ kind: 'named', label: 'E2.92' });
  });

  it('says there is no preference when the profile stores null', () => {
    expect(toPreferredSpotView(null, spots, false)).toEqual({ kind: 'none' });
  });

  it('waits while the profile has not arrived', () => {
    expect(toPreferredSpotView(undefined, spots, false)).toEqual({ kind: 'loading' });
  });

  it('waits while the spot list has not arrived', () => {
    expect(toPreferredSpotView('spot-1', undefined, false)).toEqual({ kind: 'loading' });
  });

  it('says so when the preferred spot is no longer among the active ones', () => {
    // `spot.list` returns active spots only. A spot deactivated after the user
    // chose it leaves an id with no label — the display and the stored value
    // disagreeing is exactly the shape that must not render as a blank.
    expect(toPreferredSpotView('spot-retired', spots, false)).toEqual({ kind: 'unavailable' });
  });

  it('stops promising a resolution when the read failed rather than being in flight', () => {
    // A query's `data` is `undefined` in both states, so without the flag a
    // 500 on `me.get` leaves "načítá se…" on screen for the whole flow.
    expect(toPreferredSpotView(undefined, spots, true)).toEqual({ kind: 'unknown' });
    expect(toPreferredSpotView('spot-1', undefined, true)).toEqual({ kind: 'unknown' });
  });

  it('prefers "we could not find out" over any answer built from a failed read', () => {
    // Even with both reads apparently present, a failure flag means at least
    // one of them is stale or partial — the label must not be asserted from it.
    expect(toPreferredSpotView('spot-1', spots, true)).toEqual({ kind: 'unknown' });
    expect(toPreferredSpotView(null, spots, true)).toEqual({ kind: 'unknown' });
  });
});

describe('toPreferredSpotMessage — which of the five sentences, and its one value', () => {
  it('names the spot for the only case that has a label to interpolate', () => {
    expect(toPreferredSpotMessage({ kind: 'named', label: 'E2.92' })).toEqual({
      messageKey: 'preferredSpot',
      values: { label: 'E2.92' },
    });
  });

  it('gives each of the other four its own key', () => {
    expect(toPreferredSpotMessage({ kind: 'loading' }).messageKey).toBe('preferredSpotLoading');
    expect(toPreferredSpotMessage({ kind: 'unknown' }).messageKey).toBe('preferredSpotUnknown');
    expect(toPreferredSpotMessage({ kind: 'none' }).messageKey).toBe('preferredSpotNone');
    expect(toPreferredSpotMessage({ kind: 'unavailable' }).messageKey).toBe(
      'preferredSpotUnavailable'
    );
  });

  it('populates `values` in every case, so the caller never varies with the key', () => {
    // The same contract `lot-view.ts`'s `toBannerView` keeps: one `t` call
    // covers all five sentences because the values are always there.
    for (const view of [
      { kind: 'loading' },
      { kind: 'unknown' },
      { kind: 'none' },
      { kind: 'unavailable' },
    ] as const) {
      expect(toPreferredSpotMessage(view).values).toEqual({ label: '' });
    }
  });

  it('never answers the failed read with a key that promises a resolution', () => {
    // The pair that matters: `unknown` must not share a key with `loading`.
    expect(toPreferredSpotMessage({ kind: 'unknown' }).messageKey).not.toBe(
      toPreferredSpotMessage({ kind: 'loading' }).messageKey
    );
  });
});

describe('toBadgeMessage — which of the six sentences, and its one value', () => {
  it('gives the two assigned kinds different keys', () => {
    expect(toBadgeMessage({ kind: 'ASSIGNED_PREFERRED' }).messageKey).toBe(
      'badgeAssignedPreferred'
    );
    expect(toBadgeMessage({ kind: 'ASSIGNED' }).messageKey).toBe('badgeAssigned');
  });

  it('carries the queue position through to the sentence that interpolates it', () => {
    expect(toBadgeMessage({ kind: 'QUEUED', position: 3 })).toEqual({
      messageKey: 'badgeQueued',
      values: { position: 3 },
    });
  });

  it('gives each unavailable reason its own key rather than one generic sentence', () => {
    const keys = (
      ['ALREADY_HAS_RESERVATION', 'NOT_A_BUSINESS_DAY', 'NO_SPOTS_AVAILABLE'] as const
    ).map((reason) => toBadgeMessage({ kind: 'UNAVAILABLE', reason }).messageKey);

    expect(keys).toEqual(['badgeAlreadyReserved', 'badgeNotBusinessDay', 'badgeNoSpots']);
    expect(new Set(keys).size).toBe(3);
  });

  it('populates `values` in every case, so the caller never varies with the key', () => {
    for (const badge of [
      { kind: 'ASSIGNED_PREFERRED' },
      { kind: 'ASSIGNED' },
      { kind: 'UNAVAILABLE', reason: 'NO_SPOTS_AVAILABLE' },
    ] as const) {
      expect(toBadgeMessage(badge).values).toEqual({ position: 0 });
    }
  });

  it('reads its key off the badge the module itself produced', () => {
    // The whole point of the move: one enumeration of the union, at the place
    // that produces it. `toBadge` -> `toBadgeMessage` has to compose.
    expect(toBadgeMessage(toBadge(queued('2026-09-01', { waitlistPosition: 2 })))).toEqual({
      messageKey: 'badgeQueued',
      values: { position: 2 },
    });
  });
});

describe("weekendColumns — the design's recessed right-hand columns", () => {
  it('marks exactly the sixth and seventh columns, Monday first', () => {
    expect(weekendColumns(buildMonthGrid('2026-09-15', '2026-09-01', new Set()))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('answers the same for a month whose first row is mostly blanks', () => {
    // 2026-08-01 is a Saturday, so the first row has five leading blanks and
    // its only days land in the two weekend columns.
    expect(weekendColumns(buildMonthGrid('2026-08-10', '2026-08-01', new Set()))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('reads the flag off the grid rather than assuming a column index', () => {
    // Deliberately **not** built by `buildMonthGrid`. Every grid it produces is
    // Monday-first, so against a real grid `index >= 5` and "the cell says so"
    // give the same answer for every month of every year — a test driven by
    // `buildMonthGrid` cannot tell the two implementations apart, whatever it
    // claims in its name. A hand-made grid with the weekend flags in the first
    // and third columns can, and that is the whole point of deriving the heads
    // from the cells rather than from a constant.
    const cell = (dayOfMonth: number, weekendColumn: boolean): BulkDayCell => ({
      date: `2026-09-${String(dayOfMonth).padStart(2, '0')}`,
      dayOfMonth,
      weekendColumn,
      ...(weekendColumn ? { selectable: false, block: 'WEEKEND' } : { selectable: true }),
    });
    const grid: BulkMonthGrid = {
      month: '2026-09',
      weeks: [
        {
          key: '2026-09-w0',
          slots: [1, 2, 3, 4, 5, 6, 7].map((dayOfMonth) => ({
            key: `k${String(dayOfMonth)}`,
            day: cell(dayOfMonth, dayOfMonth === 1 || dayOfMonth === 3),
          })),
        },
      ],
    };

    expect(weekendColumns(grid)).toEqual([true, false, true, false, false, false, false]);
  });
});

describe('toBadge / toScheduleRows', () => {
  it('separates the preferred spot from an ordinary one', () => {
    expect(toBadge(assigned('2026-09-01', { isPreferredSpot: true }))).toEqual({
      kind: 'ASSIGNED_PREFERRED',
    });
    expect(toBadge(assigned('2026-09-01'))).toEqual({ kind: 'ASSIGNED' });
  });

  it('carries the queue position', () => {
    expect(toBadge(queued('2026-09-01', { waitlistPosition: 3 }))).toEqual({
      kind: 'QUEUED',
      position: 3,
    });
  });

  it('carries the unavailable reason', () => {
    expect(toBadge(unavailable('2026-09-05', 'NOT_A_BUSINESS_DAY'))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'NOT_A_BUSINESS_DAY',
    });
  });

  it('puts the rows in date order whatever order they were requested in', () => {
    const rows = toScheduleRows([
      assigned('2026-09-10'),
      queued('2026-09-02'),
      unavailable('2026-09-05', 'NO_SPOTS_AVAILABLE'),
    ]);
    expect(rows.map((row) => row.date)).toEqual(['2026-09-02', '2026-09-05', '2026-09-10']);
  });

  it('has no spot label for an unavailable day', () => {
    const [row] = toScheduleRows([unavailable('2026-09-05', 'NO_SPOTS_AVAILABLE')]);
    expect(row?.spotLabel).toBeNull();
  });

  it('carries the allocated spot label for the days that got one', () => {
    const [row] = toScheduleRows([assigned('2026-09-10', { parkingSpotLabel: 'E2.99' })]);
    expect(row?.spotLabel).toBe('E2.99');
  });
});

describe('sameOutcome', () => {
  it('is false when the outcome kind changed', () => {
    expect(sameOutcome(assigned('2026-09-01'), queued('2026-09-01'))).toBe(false);
  });

  it('is false when the assigned spot changed', () => {
    expect(
      sameOutcome(assigned('2026-09-01'), assigned('2026-09-01', { parkingSpotId: 'spot-9' }))
    ).toBe(false);
  });

  it('is false when an assignment stopped being the preferred spot', () => {
    expect(
      sameOutcome(
        assigned('2026-09-01', { isPreferredSpot: true }),
        assigned('2026-09-01', { isPreferredSpot: false })
      )
    ).toBe(false);
  });

  it('is false when the queue position moved', () => {
    expect(sameOutcome(queued('2026-09-01'), queued('2026-09-01', { waitlistPosition: 5 }))).toBe(
      false
    );
  });

  it('is false when the unavailable reason changed', () => {
    expect(
      sameOutcome(
        unavailable('2026-09-05', 'NO_SPOTS_AVAILABLE'),
        unavailable('2026-09-05', 'ALREADY_HAS_RESERVATION')
      )
    ).toBe(false);
  });

  it('ignores the ids only the result carries', () => {
    const confirmed: BulkDayResult = { ...assigned('2026-09-01'), reservationId: 'res-1' };
    expect(sameOutcome(assigned('2026-09-01'), confirmed)).toBe(true);
  });
});

describe('diffBulkSchedule — what the user must not be allowed to miss', () => {
  it('reports nothing when the confirmation matched the proposal', () => {
    const proposal = [assigned('2026-09-01'), queued('2026-09-02')];
    const confirmed: BulkDayResult[] = [
      { ...assigned('2026-09-01'), reservationId: 'res-1' },
      { ...queued('2026-09-02'), waitlistEntryId: 'wl-1' },
    ];
    expect(diffBulkSchedule(proposal, confirmed)).toEqual([]);
  });

  it('reports a promised spot that became a queue place', () => {
    // The race `doc/decision/0092-*` deliberately leaves open.
    const proposal = [assigned('2026-09-01', { isPreferredSpot: true })];
    const confirmed: BulkDayResult[] = [
      { ...queued('2026-09-01', { waitlistPosition: 1 }), waitlistEntryId: 'wl-1' },
    ];

    const differences = diffBulkSchedule(proposal, confirmed);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.date).toBe('2026-09-01');
    expect(differences[0]?.proposed?.outcome).toBe('SPOT_ASSIGNED');
    expect(differences[0]?.confirmed?.outcome).toBe('QUEUED');
  });

  it('reports a day whose queue position moved even though the outcome kind did not', () => {
    const proposal = [queued('2026-09-01', { waitlistPosition: 1 })];
    const confirmed: BulkDayResult[] = [
      { ...queued('2026-09-01', { waitlistPosition: 4 }), waitlistEntryId: 'wl-1' },
    ];
    expect(diffBulkSchedule(proposal, confirmed)).toHaveLength(1);
  });

  it('reports a day the result mentions and the proposal never did', () => {
    const confirmed: BulkDayResult[] = [{ ...assigned('2026-09-03'), reservationId: 'res-1' }];
    expect(diffBulkSchedule([], confirmed)).toEqual([
      { date: '2026-09-03', proposed: null, confirmed: confirmed[0] },
    ]);
  });

  it('reports a day the proposal mentioned and the result dropped', () => {
    const proposal = [assigned('2026-09-03')];
    expect(diffBulkSchedule(proposal, [])).toEqual([
      { date: '2026-09-03', proposed: proposal[0], confirmed: null },
    ]);
  });

  it('returns the differences in date order, whatever order the two lists were in', () => {
    const proposal = [assigned('2026-09-10'), assigned('2026-09-02')];
    const confirmed: BulkDayResult[] = [
      { ...queued('2026-09-02'), waitlistEntryId: 'wl-1' },
      { ...queued('2026-09-10'), waitlistEntryId: 'wl-2' },
    ];
    expect(diffBulkSchedule(proposal, confirmed).map((row) => row.date)).toEqual([
      '2026-09-02',
      '2026-09-10',
    ]);
  });

  it('keeps the matching days out of the list so the changed ones stand alone', () => {
    const proposal = [assigned('2026-09-01'), assigned('2026-09-02')];
    const confirmed: BulkDayResult[] = [
      { ...assigned('2026-09-01'), reservationId: 'res-1' },
      { ...queued('2026-09-02'), waitlistEntryId: 'wl-1' },
    ];
    expect(diffBulkSchedule(proposal, confirmed).map((row) => row.date)).toEqual(['2026-09-02']);
  });
});

describe('toBulkErrorMessageKey — one sentence per thing that actually went wrong', () => {
  const API_URL = 'https://api.test/rpc';

  /**
   * oRPC's error envelope, as `apps/garage/api`'s global filter serialises it:
   * `{ json, meta }` on the outside (the payload is not at the top level) and
   * `defined: false` on the inside — `doc/decision/0033-*`, and the reason
   * `toContractError` reads the code rather than oRPC's `defined` flag.
   */
  function errorResponse(code: string, status: number) {
    return async () =>
      new Response(
        JSON.stringify({
          json: { defined: false, code, status, message: 'developer-facing' },
          meta: [],
        }),
        { status, headers: { 'content-type': 'application/json' } }
      );
  }

  /** Drives one real `confirmBulk` call and returns what the transport threw. */
  async function failureFor(fetchImpl: () => Promise<Response>): Promise<unknown> {
    const client = createApiClient({ url: API_URL, fetch: fetchImpl });
    const marker = Symbol('resolved');
    const outcome = await client.reservation.confirmBulk({ dates: ['2026-09-01'] }).then(
      () => marker,
      (error: unknown) => error
    );
    if (outcome === marker) {
      throw new Error('expected the call to reject, but it resolved');
    }
    return outcome;
  }

  it.each([
    ['PAST_DATE', 422, 'errorPastDate'],
    ['OUT_OF_HORIZON', 422, 'errorOutOfHorizon'],
    ['RESERVATIONS_LOCKED', 422, 'errorLocked'],
    ['VALIDATION_FAILED', 422, 'errorValidation'],
    ['CONFLICT', 409, 'errorConflict'],
    ['FORBIDDEN', 403, 'errorForbidden'],
  ])('maps %s (HTTP %i) to its own key, %s', async (code, status, key) => {
    const failure = await failureFor(errorResponse(String(code), Number(status)));
    expect(toBulkErrorMessageKey(failure)).toBe(key);
  });

  it('gives every declared code a distinct key rather than one shared sentence', async () => {
    // The defect this exists to prevent: several typed contract errors
    // funnelled into a single line of copy.
    const codes = [
      'PAST_DATE',
      'OUT_OF_HORIZON',
      'RESERVATIONS_LOCKED',
      'VALIDATION_FAILED',
      'CONFLICT',
      'FORBIDDEN',
    ];
    const keys: string[] = [];
    for (const code of codes) {
      keys.push(toBulkErrorMessageKey(await failureFor(errorResponse(code, 422))));
    }
    expect(new Set(keys).size).toBe(codes.length);
  });

  it('falls back to the generic key for a code outside the contract enum', async () => {
    expect(toBulkErrorMessageKey(await failureFor(errorResponse('SOMETHING_ELSE', 500)))).toBe(
      'errorUnknown'
    );
  });

  it('falls back to the generic key for a transport failure', async () => {
    const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(toBulkErrorMessageKey(await failureFor(dropped))).toBe('errorUnknown');
  });

  it('does not claim a domain code for a contract error the bulk procedures never raise', async () => {
    // `SPOT_ALREADY_RESERVED` belongs to `reservation.create`. Borrowing its
    // copy here would describe a single-day failure that did not happen.
    expect(
      toBulkErrorMessageKey(await failureFor(errorResponse('SPOT_ALREADY_RESERVED', 409)))
    ).toBe('errorUnknown');
  });
});
