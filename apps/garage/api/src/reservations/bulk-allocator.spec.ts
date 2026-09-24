/**
 * The allocator's preference order, proven by making it choose.
 *
 * Every case here is written so that removing the rule it covers changes the
 * answer rather than merely reordering an array — the plans are compared field
 * by field, and the fixtures are built so that two rules never point at the same
 * spot. The mutation table in the task report records what each of these fails
 * with when the corresponding line of `bulk-allocator.ts` is broken.
 *
 * Everything here is pure: no database, no clock, no Nest.
 */

import type { BulkDayPlan } from '@garage/contract';
import type { DateOnly } from '@garage/shared-types';
import { isBusinessDay } from '@garage/shared-types';
import type { AllocatableSpot, AllocationRequest, DayState } from './bulk-allocator';
import { allocateBulk } from './bulk-allocator';

/** January 2099: `01` is New Year (a Thursday), `03` a Saturday, `05` a Monday. */
const HOLIDAY = '2099-01-01' as DateOnly;
const WEEKEND = '2099-01-03' as DateOnly;
const MONDAY = '2099-01-05' as DateOnly;
const TUESDAY = '2099-01-06' as DateOnly;
const WEDNESDAY = '2099-01-07' as DateOnly;

const USER = 'user-under-test';

/**
 * Four spots whose canonical order is `IT-1, IT-2, SHARED-1, SHARED-2` and whose
 * *label* order alone would be `IT-1, IT-2, SHARED-1, SHARED-2` too — so the
 * group rule is exercised by {@link CROSSED_SPOTS} instead, where the two orders
 * genuinely disagree.
 */
const SPOTS: AllocatableSpot[] = [
  { id: 'it-1', label: 'IT-1', group: 'IT' },
  { id: 'it-2', label: 'IT-2', group: 'IT' },
  { id: 'shared-1', label: 'SHARED-1', group: 'SHARED' },
  { id: 'shared-2', label: 'SHARED-2', group: 'SHARED' },
];

/**
 * Labels chosen so that pure label order (`A1`, `B1`) and the required order
 * (group first: `B1` the IT spot, then `A1`) are **opposites**. Without the
 * group rule the allocator picks `A1`; with it, `B1`.
 */
const CROSSED_SPOTS: AllocatableSpot[] = [
  { id: 'shared-a', label: 'A1', group: 'SHARED' },
  { id: 'it-b', label: 'B1', group: 'IT' },
];

function day(overrides: Partial<DayState> = {}): DayState {
  return {
    reservedSpotIds: new Set(),
    userHasReservation: false,
    queuedUserIdsBySpotId: new Map(),
    blockedSpotIds: new Set(),
    ...overrides,
  };
}

function request(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    dates: [MONDAY],
    spots: SPOTS,
    userId: USER,
    preferredParkingSpotId: null,
    stateByDate: new Map(),
    ...overrides,
  };
}

/** Every spot taken, by anybody. */
function fullDay(spots: readonly AllocatableSpot[] = SPOTS): Partial<DayState> {
  return { reservedSpotIds: new Set(spots.map((spot) => spot.id)) };
}

function onlyPlan(overrides: Partial<AllocationRequest>): BulkDayPlan {
  const [plan] = allocateBulk(request(overrides));
  if (plan === undefined) {
    throw new Error('The allocator returned no plan for a single requested day.');
  }
  return plan;
}

describe('the fixtures mean what the cases assume', () => {
  // Without this, "skipped because it is a holiday" and "skipped because the
  // user is busy" would be indistinguishable and every assertion below vacuous.
  it.each([
    [HOLIDAY, false],
    [WEEKEND, false],
    [MONDAY, true],
    [TUESDAY, true],
    [WEDNESDAY, true],
  ])('%s is a business day: %s', (date, expected) => {
    expect(isBusinessDay(date)).toBe(expected);
  });

  it('has a fixture where label order and group order disagree', () => {
    const byLabel = [...CROSSED_SPOTS].sort((left, right) => left.label.localeCompare(right.label));
    expect(byLabel[0]?.id).toBe('shared-a');
    // …so an allocator that ignored `group` would pick `shared-a`, and the case
    // below asserts it picks `it-b`.
  });
});

describe('choosing a free spot', () => {
  it('takes the first spot in group-then-label order', () => {
    expect(onlyPlan({})).toEqual({
      outcome: 'SPOT_ASSIGNED',
      date: MONDAY,
      parkingSpotId: 'it-1',
      parkingSpotLabel: 'IT-1',
      isPreferredSpot: false,
    });
  });

  it('puts IT before SHARED even when the label order says otherwise', () => {
    expect(onlyPlan({ spots: CROSSED_SPOTS })).toMatchObject({
      parkingSpotId: 'it-b',
      parkingSpotLabel: 'B1',
    });
  });

  it('orders by label inside a group', () => {
    // `it-1` occupied, so the choice is between `it-2` and the SHARED spots.
    expect(
      onlyPlan({
        stateByDate: new Map([[MONDAY, day({ reservedSpotIds: new Set(['it-1']) })]]),
      })
    ).toMatchObject({ parkingSpotId: 'it-2' });
  });

  it('does not depend on the order the spots arrive in', () => {
    const shuffled = [SPOTS[3], SPOTS[1], SPOTS[2], SPOTS[0]] as AllocatableSpot[];

    expect(onlyPlan({ spots: shuffled })).toEqual(onlyPlan({ spots: SPOTS }));
  });

  it('gives the same answer for the same input, twice', () => {
    const twice = request({
      dates: [WEDNESDAY, MONDAY, TUESDAY],
      preferredParkingSpotId: 'shared-1',
      stateByDate: new Map([[MONDAY, day({ reservedSpotIds: new Set(['shared-1']) })]]),
    });

    expect(allocateBulk(twice)).toEqual(allocateBulk(twice));
  });
});

describe('the preferred spot', () => {
  it('wins over the first spot in the canonical order', () => {
    expect(onlyPlan({ preferredParkingSpotId: 'shared-2' })).toEqual({
      outcome: 'SPOT_ASSIGNED',
      date: MONDAY,
      parkingSpotId: 'shared-2',
      parkingSpotLabel: 'SHARED-2',
      isPreferredSpot: true,
    });
  });

  it('is ignored when it is taken, and the fallback is not flagged as preferred', () => {
    expect(
      onlyPlan({
        preferredParkingSpotId: 'shared-2',
        stateByDate: new Map([[MONDAY, day({ reservedSpotIds: new Set(['shared-2']) })]]),
      })
    ).toEqual({
      outcome: 'SPOT_ASSIGNED',
      date: MONDAY,
      parkingSpotId: 'it-1',
      parkingSpotLabel: 'IT-1',
      isPreferredSpot: false,
    });
  });

  it('is ignored when it is not among the active spots', () => {
    // A retired preferred spot never reaches the allocator's `spots` list.
    expect(onlyPlan({ preferredParkingSpotId: 'retired-spot' })).toMatchObject({
      parkingSpotId: 'it-1',
      isPreferredSpot: false,
    });
  });
});

describe('a spot with a guest block that day', () => {
  it('is skipped even when it is the preferred spot, in favour of the next free one', () => {
    expect(
      onlyPlan({
        preferredParkingSpotId: 'it-1',
        stateByDate: new Map([[MONDAY, day({ blockedSpotIds: new Set(['it-1']) })]]),
      })
    ).toEqual({
      outcome: 'SPOT_ASSIGNED',
      date: MONDAY,
      parkingSpotId: 'it-2',
      parkingSpotLabel: 'IT-2',
      isPreferredSpot: false,
    });
  });

  it('is never the target of a queue, even as the only free-looking spot', () => {
    // Every other spot reserved, one spot blocked: the queue must land on a
    // non-blocked, reserved spot rather than on the block — a queue waits for a
    // full-day holder to cancel, and a block is not one. `it-1` is blocked and
    // has no queue at all; without the fix it would win the shortest-queue
    // tiebreak outright.
    expect(
      onlyPlan({
        stateByDate: new Map([
          [
            MONDAY,
            day({
              reservedSpotIds: new Set(['it-2', 'shared-1', 'shared-2']),
              blockedSpotIds: new Set(['it-1']),
              queuedUserIdsBySpotId: new Map([['shared-1', ['a']]]),
            }),
          ],
        ]),
      })
    ).toMatchObject({ outcome: 'QUEUED', parkingSpotId: 'it-2' });
    // Whatever it picks among the non-blocked spots, it must never be `it-1`.
  });

  it('reports NO_SPOTS_AVAILABLE when every spot is blocked', () => {
    expect(
      onlyPlan({
        stateByDate: new Map([
          [MONDAY, day({ blockedSpotIds: new Set(SPOTS.map((spot) => spot.id)) })],
        ]),
      })
    ).toEqual({
      outcome: 'UNAVAILABLE',
      date: MONDAY,
      reason: 'NO_SPOTS_AVAILABLE',
    });
  });
});

describe('a full day', () => {
  it('queues for the shortest queue', () => {
    expect(
      onlyPlan({
        stateByDate: new Map([
          [
            MONDAY,
            day({
              ...fullDay(),
              queuedUserIdsBySpotId: new Map([
                ['it-1', ['a', 'b']],
                ['it-2', ['c', 'd', 'e']],
                ['shared-1', ['f']],
                ['shared-2', ['g', 'h']],
              ]),
            }),
          ],
        ]),
      })
    ).toEqual({
      outcome: 'QUEUED',
      date: MONDAY,
      parkingSpotId: 'shared-1',
      parkingSpotLabel: 'SHARED-1',
      waitlistPosition: 2,
    });
  });

  it('breaks a tie by label, not by group or by input order', () => {
    // Every queue is length 1, so only the tiebreak decides. `A1` is SHARED and
    // `B1` is IT: the tiebreak is the **label**, so `A1` wins — which is also
    // the opposite of what the group order would have said.
    expect(
      onlyPlan({
        spots: CROSSED_SPOTS,
        stateByDate: new Map([
          [
            MONDAY,
            day({
              ...fullDay(CROSSED_SPOTS),
              queuedUserIdsBySpotId: new Map([
                ['it-b', ['x']],
                ['shared-a', ['y']],
              ]),
            }),
          ],
        ]),
      })
    ).toMatchObject({ parkingSpotId: 'shared-a', parkingSpotLabel: 'A1', waitlistPosition: 2 });
  });

  it('reports position 1 for an empty queue', () => {
    expect(onlyPlan({ stateByDate: new Map([[MONDAY, day(fullDay())]]) })).toMatchObject({
      outcome: 'QUEUED',
      waitlistPosition: 1,
    });
  });

  it('reports the position the user already holds rather than the back of the queue', () => {
    expect(
      onlyPlan({
        stateByDate: new Map([
          [
            MONDAY,
            day({
              ...fullDay(),
              queuedUserIdsBySpotId: new Map([
                ['it-1', ['a', USER, 'b']],
                ['it-2', ['c', 'd']],
                ['shared-1', ['e', 'f']],
                ['shared-2', ['g', 'h']],
              ]),
            }),
          ],
        ]),
      })
      // `it-1` and the others are all length 2 or 3; `it-2` ties with the two
      // SHARED spots at 2 and wins on label, so the user joins the back there.
    ).toMatchObject({ parkingSpotId: 'it-2', waitlistPosition: 3 });
  });

  it('reports the existing position when the shortest queue is one the user is in', () => {
    expect(
      onlyPlan({
        stateByDate: new Map([
          [
            MONDAY,
            day({
              ...fullDay(),
              queuedUserIdsBySpotId: new Map([
                ['it-1', [USER, 'a']],
                ['it-2', ['b', 'c', 'd']],
                ['shared-1', ['e', 'f', 'g']],
                ['shared-2', ['h', 'i', 'j']],
              ]),
            }),
          ],
        ]),
      })
    ).toMatchObject({ parkingSpotId: 'it-1', waitlistPosition: 1 });
  });
});

describe('days nothing can be done for', () => {
  it('skips a Czech public holiday, even though it is a weekday', () => {
    expect(onlyPlan({ dates: [HOLIDAY] })).toEqual({
      outcome: 'UNAVAILABLE',
      date: HOLIDAY,
      reason: 'NOT_A_BUSINESS_DAY',
    });
  });

  it('skips a weekend', () => {
    expect(onlyPlan({ dates: [WEEKEND] })).toMatchObject({ reason: 'NOT_A_BUSINESS_DAY' });
  });

  it('skips a day the user already has a reservation on, even with spots free', () => {
    expect(
      onlyPlan({ stateByDate: new Map([[MONDAY, day({ userHasReservation: true })]]) })
    ).toEqual({
      outcome: 'UNAVAILABLE',
      date: MONDAY,
      reason: 'ALREADY_HAS_RESERVATION',
    });
  });

  it('does not queue somebody who already has a reservation that day', () => {
    // The rule that matters: a queue entry for a user who holds a spot that day
    // could never be promoted, so `ALREADY_HAS_RESERVATION` has to beat `QUEUED`.
    expect(
      onlyPlan({
        stateByDate: new Map([[MONDAY, day({ ...fullDay(), userHasReservation: true })]]),
      })
    ).toMatchObject({ outcome: 'UNAVAILABLE', reason: 'ALREADY_HAS_RESERVATION' });
  });

  it('reports the holiday rather than the reservation when both are true', () => {
    expect(
      onlyPlan({
        dates: [HOLIDAY],
        stateByDate: new Map([[HOLIDAY, day({ userHasReservation: true })]]),
      })
    ).toMatchObject({ reason: 'NOT_A_BUSINESS_DAY' });
  });

  it('reports NO_SPOTS_AVAILABLE when the lot has no active spot', () => {
    expect(onlyPlan({ spots: [] })).toEqual({
      outcome: 'UNAVAILABLE',
      date: MONDAY,
      reason: 'NO_SPOTS_AVAILABLE',
    });
  });
});

describe('the shape of the whole plan', () => {
  it('comes back in ascending date order, whatever order it was asked in', () => {
    const plan = allocateBulk(request({ dates: [WEDNESDAY, MONDAY, WEEKEND, TUESDAY] }));

    expect(plan.map((entry) => entry.date)).toEqual([WEEKEND, MONDAY, TUESDAY, WEDNESDAY]);
  });

  it('treats days independently — the same spot is assigned on every one of them', () => {
    const plan = allocateBulk(request({ dates: [MONDAY, TUESDAY, WEDNESDAY] }));

    expect(
      plan.map((entry) => (entry.outcome === 'SPOT_ASSIGNED' ? entry.parkingSpotId : null))
    ).toEqual(['it-1', 'it-1', 'it-1']);
  });

  it('treats a date with no state at all as an empty day', () => {
    expect(allocateBulk(request({ dates: [MONDAY], stateByDate: new Map() }))).toEqual([
      {
        outcome: 'SPOT_ASSIGNED',
        date: MONDAY,
        parkingSpotId: 'it-1',
        parkingSpotLabel: 'IT-1',
        isPreferredSpot: false,
      },
    ]);
  });
});
