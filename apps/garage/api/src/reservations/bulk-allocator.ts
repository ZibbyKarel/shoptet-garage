/**
 * The bulk-booking allocator: which spot each selected day should get.
 *
 * Pure. It takes a snapshot of the world and returns a plan; it reads no
 * database, opens no transaction and has no clock. That is what lets
 * `reservation.previewBulk` and `reservation.confirmBulk` share one definition
 * of "what should happen" while differing only in whether anything is written —
 * and it is what makes the preference order testable by an ordinary unit test
 * rather than only through a live PostgreSQL.
 *
 * ## The order of preference, and why each step is where it is
 *
 * Per day, in this order (`doc/decision/0090-*`):
 *
 * 1. **Not a business day** → `UNAVAILABLE / NOT_A_BUSINESS_DAY`. First because
 *    it is the most durable fact: a Saturday is still a Saturday next month,
 *    whereas "every spot is taken" is true for an afternoon. Same reasoning as
 *    `ReservationPolicy.assertMayTakeDay`'s ordering.
 * 2. **The user already holds a reservation that day** → `UNAVAILABLE /
 *    ALREADY_HAS_RESERVATION`. Above the queue branch on purpose: queueing
 *    somebody who already has a spot would create an entry that can never be
 *    promoted (one reservation per user per day), which is exactly what
 *    `WaitlistService.join` refuses at the door.
 * 3. **No active spots at all** → `UNAVAILABLE / NO_SPOTS_AVAILABLE`. There is
 *    nothing to reserve *and* nothing to queue for, so it is neither of the two
 *    outcomes below.
 * 4. **The preferred spot, if it is free** → `SPOT_ASSIGNED`, `isPreferredSpot`.
 * 5. **The first free spot** in the canonical order below → `SPOT_ASSIGNED`.
 * 6. Otherwise **the shortest queue** → `QUEUED`, with the position the user
 *    would take (or already holds). The tiebreak there is the label *alone*,
 *    not the group-then-label order of steps 4–5 — see {@link shortestQueue}.
 *
 * ## Why the allocator sorts its own inputs
 *
 * Both orders it depends on — spots, and days — are re-derived here rather than
 * trusted from the caller:
 *
 * - **Spots** are sorted by group (`IT` before `SHARED`, from the declaration
 *   order of `PARKING_GROUPS`) then by `label`. A `findMany` that lost its
 *   `orderBy` would otherwise silently change which spot a bulk booking picks,
 *   and nothing would fail. `bulk-allocator.spec.ts` shuffles the input and
 *   asserts the same plan comes back.
 * - **Days** are processed in ascending date order, and that is **not
 *   cosmetic**: it is the lock ordering that keeps two concurrent
 *   `confirmBulk`s from deadlocking. Each transaction inserts its reservation
 *   keys in this order, so two of them acquire shared keys in the same
 *   sequence and no cycle can form. Process them in request order instead and
 *   two users submitting the same days in opposite orders deadlock — which
 *   `bulk-concurrency.db.spec.ts` § "a forced interleaving inside one multi-row
 *   INSERT" forces with a test-only `BEFORE INSERT` trigger. See
 *   `doc/decision/0092-*`.
 *
 *   **This line is the single authority for that order.** The plan's order is
 *   the row order of the reservation `INSERT` — `createReservations` maps
 *   straight off `plans` — so nothing between here and the write can reorder
 *   it. `BulkReservationService.assertRequestable` sorts too, but only locally,
 *   to name the earliest offending day in a rejection; it returns nothing, and
 *   the list it was handed reaches the allocator in request order on purpose. It
 *   used to return a sorted copy, and while it did, either sort could be deleted
 *   with every test still green.
 *
 * The plan therefore comes back in ascending date order. Putting it back into
 * the order the client asked for is the service's job, because the contract
 * promises the response in request order and the *writes* have to stay in this
 * one.
 */

import type { BulkDayPlan } from '@garage/contract';
import type { DateOnly, ParkingGroup } from '@garage/shared-types';
import { PARKING_GROUPS, compareDateOnly, isBusinessDay } from '@garage/shared-types';

/** The three fields the allocator needs about a spot. Active spots only. */
export interface AllocatableSpot {
  id: string;
  label: string;
  group: ParkingGroup;
}

/** Everything the allocator is allowed to know about one day. */
export interface DayState {
  /** Spots that already have a reservation that day. */
  reservedSpotIds: ReadonlySet<string>;
  /** Whether the booking user already holds a reservation that day. */
  userHasReservation: boolean;
  /**
   * Each spot's queue that day, in promotion order (`createdAt`, then `id`), as
   * user ids. A spot with no queue may be absent.
   */
  queuedUserIdsBySpotId: ReadonlyMap<string, readonly string[]>;
  /**
   * Spots holding a guest block that day. Neither assignable nor queueable: a
   * queue waits for a full-day holder to give the spot up, and a block has no
   * full-day holder to wait on.
   */
  blockedSpotIds: ReadonlySet<string>;
}

export interface AllocationRequest {
  /** The days to plan for. Any order; the allocator sorts them. */
  dates: readonly DateOnly[];
  /** Active spots. Any order; the allocator sorts them. */
  spots: readonly AllocatableSpot[];
  /** The user the plan is for. */
  userId: string;
  /** Their first choice, or `null`. A retired spot is simply absent from `spots`. */
  preferredParkingSpotId: string | null;
  /** One entry per date in {@link dates}. A missing date is an empty day. */
  stateByDate: ReadonlyMap<DateOnly, DayState>;
}

/** An empty world, for a date the caller had nothing to say about. */
const EMPTY_DAY: DayState = {
  reservedSpotIds: new Set(),
  userHasReservation: false,
  queuedUserIdsBySpotId: new Map(),
  blockedSpotIds: new Set(),
};

/**
 * `IT` before `SHARED`, taken from the single declaration of the group list
 * rather than from a literal here — the enum's order *is* the rule, and
 * `libs/garage/database`'s parity spec already pins that order against Postgres.
 */
function groupRank(group: ParkingGroup): number {
  return PARKING_GROUPS.indexOf(group);
}

/** The canonical spot order: group, then painted label. Labels are unique. */
export function compareSpots(left: AllocatableSpot, right: AllocatableSpot): number {
  const byGroup = groupRank(left.group) - groupRank(right.group);
  return byGroup === 0 ? left.label.localeCompare(right.label) : byGroup;
}

/** Where the user stands in one queue, 1-based, joining the back if absent. */
function positionIn(queue: readonly string[], userId: string): number {
  const existing = queue.indexOf(userId);
  return existing === -1 ? queue.length + 1 : existing + 1;
}

/**
 * The spot to queue for when every spot is taken: the shortest queue, with the
 * **label** as the tiebreak.
 *
 * The label alone, deliberately — not the group-then-label order used to pick a
 * free spot. Choosing a queue is not choosing where to park: every candidate is
 * already taken, so the `IT`-before-`SHARED` preference has nothing to say, and
 * the only thing that matters is getting a deterministic, explainable answer.
 * Reusing the assignment order here would silently make the shortest-queue
 * tiebreak prefer IT spots, which nobody asked for.
 *
 * The tiebreak is what makes two identical requests produce the same plan —
 * without it the answer would depend on the order the rows came back in, and the
 * preview would stop predicting the confirmation.
 */
function shortestQueue(
  spots: readonly AllocatableSpot[],
  day: DayState
): AllocatableSpot | undefined {
  const byLabel = [...spots].sort((left, right) => left.label.localeCompare(right.label));

  let best: AllocatableSpot | undefined;
  let bestLength = Number.POSITIVE_INFINITY;

  for (const spot of byLabel) {
    const length = day.queuedUserIdsBySpotId.get(spot.id)?.length ?? 0;
    // Strictly shorter only: the candidates are already in label order, so the
    // first spot at the shortest length is the label-order winner.
    if (length < bestLength) {
      best = spot;
      bestLength = length;
    }
  }

  return best;
}

/** One day, given the rules in this file's header. */
function planDay(
  date: DateOnly,
  spots: readonly AllocatableSpot[],
  request: AllocationRequest,
  day: DayState
): BulkDayPlan {
  if (!isBusinessDay(date)) {
    return { outcome: 'UNAVAILABLE', date, reason: 'NOT_A_BUSINESS_DAY' };
  }
  if (day.userHasReservation) {
    return { outcome: 'UNAVAILABLE', date, reason: 'ALREADY_HAS_RESERVATION' };
  }
  const candidates = spots.filter((spot) => !day.blockedSpotIds.has(spot.id));
  if (candidates.length === 0) {
    return { outcome: 'UNAVAILABLE', date, reason: 'NO_SPOTS_AVAILABLE' };
  }

  const free = candidates.filter((spot) => !day.reservedSpotIds.has(spot.id));
  const preferred = free.find((spot) => spot.id === request.preferredParkingSpotId);
  const chosen = preferred ?? free[0];

  if (chosen !== undefined) {
    return {
      outcome: 'SPOT_ASSIGNED',
      date,
      parkingSpotId: chosen.id,
      parkingSpotLabel: chosen.label,
      isPreferredSpot: chosen.id === request.preferredParkingSpotId,
    };
  }

  // Every non-blocked spot is taken. `candidates` is non-empty and
  // `shortestQueue` returns the first of them at worst, so this cannot be
  // `undefined` — but the compiler cannot see that, and a thrown defect is
  // better than a fabricated fallback.
  const queueTarget = shortestQueue(candidates, day);
  if (queueTarget === undefined) {
    throw new Error('No spot to queue for, on a day that has spots.');
  }

  return {
    outcome: 'QUEUED',
    date,
    parkingSpotId: queueTarget.id,
    parkingSpotLabel: queueTarget.label,
    waitlistPosition: positionIn(
      day.queuedUserIdsBySpotId.get(queueTarget.id) ?? [],
      request.userId
    ),
  };
}

/**
 * The plan, **in ascending date order** — which is the order the writes have to
 * happen in. See the header for why.
 */
export function allocateBulk(request: AllocationRequest): BulkDayPlan[] {
  const spots = [...request.spots].sort(compareSpots);
  const dates = [...request.dates].sort(compareDateOnly);

  return dates.map((date) =>
    planDay(date, spots, request, request.stateByDate.get(date) ?? EMPTY_DAY)
  );
}
