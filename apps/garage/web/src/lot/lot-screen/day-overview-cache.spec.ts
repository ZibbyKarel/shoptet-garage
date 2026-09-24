import type { DayOverviewOutput, DaySpotOverview, PublicTimedReservation } from '@garage/contract';
import type {
  ReservationCancelledEvent,
  ReservationCreatedEvent,
  ReservationReassignedEvent,
  TimedReservationsUpdatedEvent,
  WaitlistUpdatedEvent,
} from '@garage/contract/realtime';
import {
  applyReservationCancelled,
  applyReservationCreated,
  applyReservationReassigned,
  applyTimedReservationsUpdated,
  applyWaitlistUpdated,
  reservationCancelledTouchesViewer,
  reservationCreatedTouchesViewer,
  reservationReassignedTouchesViewer,
  waitlistUpdatedTouchesViewer,
} from './day-overview-cache';

const DATE = '2026-09-28';
const OTHER_DATE = '2026-09-29';
const VIEWER = 'user-viewer';
const STRANGER = 'user-stranger';

function row(id: string, overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id,
      label: id.toUpperCase(),
      group: 'IT',
      active: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    reservation: null,
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
    ...overrides,
  };
}

function publicReservation(id: string, userId: string) {
  return {
    id,
    createdAt: '2026-09-01T08:00:00.000Z',
    holder: { kind: 'USER' as const, userId, name: 'Petr Novák', licensePlate: '8SC 9012' },
  };
}

function day(overrides: Partial<DayOverviewOutput> = {}): DayOverviewOutput {
  return {
    date: DATE,
    window: {
      month: '2026-09',
      windowFrom: '2026-08-25',
      windowTo: '2026-08-31',
      state: 'OPEN',
      lockMode: 'AUTO',
    },
    canReserve: true,
    canReserveMonth: true,
    spots: [row('spot-a'), row('spot-b')],
    viewerReservationId: null,
    ...overrides,
  };
}

describe('applyReservationCreated', () => {
  const event: ReservationCreatedEvent = {
    date: DATE,
    parkingSpotId: 'spot-a',
    reservation: publicReservation('res-1', STRANGER),
  };

  it('paints the new holder onto the cell', () => {
    const next = applyReservationCreated(day(), event);
    expect(next.spots[0]?.reservation).toEqual(event.reservation);
    expect(next.spots[1]?.reservation).toBeNull();
  });

  it('leaves every other field of the day alone', () => {
    const before = day();
    const next = applyReservationCreated(before, event);
    expect(next.date).toBe(before.date);
    expect(next.window).toBe(before.window);
    expect(next.canReserve).toBe(before.canReserve);
    expect(next.viewerReservationId).toBe(before.viewerReservationId);
  });

  it('ignores an event for a different day, by reference', () => {
    // A client is typically in several day rooms and Socket.io does not say
    // which one a message came through. Returning the same reference is what
    // keeps that from re-rendering the grid.
    const before = day();
    expect(applyReservationCreated(before, { ...event, date: OTHER_DATE })).toBe(before);
  });

  it('ignores an event for a spot this overview does not have', () => {
    const before = day();
    expect(applyReservationCreated(before, { ...event, parkingSpotId: 'spot-zz' })).toBe(before);
  });

  it('is idempotent — a redelivered event changes nothing, by reference', () => {
    const once = applyReservationCreated(day(), event);
    expect(applyReservationCreated(once, event)).toBe(once);
  });
});

describe('applyReservationCancelled', () => {
  const held = day({
    spots: [row('spot-a', { reservation: publicReservation('res-1', STRANGER) }), row('spot-b')],
  });
  const event: ReservationCancelledEvent = {
    date: DATE,
    parkingSpotId: 'spot-a',
    reservationId: 'res-1',
  };

  it('frees the cell', () => {
    expect(applyReservationCancelled(held, event).spots[0]?.reservation).toBeNull();
  });

  it('refuses to blank a cell somebody else now holds', () => {
    // The cancel is for a reservation this client has already replaced with a
    // newer one. Clearing on the strength of the spot id alone would erase a
    // live booking.
    expect(applyReservationCancelled(held, { ...event, reservationId: 'res-stale' })).toBe(held);
  });

  it('ignores a cancel for an already-free cell, by reference', () => {
    const free = day();
    expect(applyReservationCancelled(free, event)).toBe(free);
  });

  it('ignores an event for a different day, by reference', () => {
    expect(applyReservationCancelled(held, { ...event, date: OTHER_DATE })).toBe(held);
  });
});

describe('applyReservationReassigned', () => {
  const held = day({
    spots: [row('spot-a', { reservation: publicReservation('res-1', STRANGER) }), row('spot-b')],
  });
  const event: ReservationReassignedEvent = {
    date: DATE,
    parkingSpotId: 'spot-a',
    cause: 'WAITLIST_PROMOTION',
    previousReservationId: 'res-1',
    reservation: publicReservation('res-2', VIEWER),
    fromWaitlistEntryId: 'wait-1',
  };

  it('swaps the holder in one step, never through an empty cell', () => {
    // One committed transaction produces exactly one event
    // (`doc/decision/0022-*`), so the cell must never be observed empty.
    const next = applyReservationReassigned(held, event);
    expect(next.spots[0]?.reservation?.id).toBe('res-2');
    expect(next.spots[0]?.reservation?.holder).toMatchObject({ kind: 'USER', userId: VIEWER });
  });

  it('ignores an event for a different day, by reference', () => {
    expect(applyReservationReassigned(held, { ...event, date: OTHER_DATE })).toBe(held);
  });

  it('is idempotent, by reference', () => {
    const once = applyReservationReassigned(held, event);
    expect(applyReservationReassigned(once, event)).toBe(once);
  });
});

describe('applyWaitlistUpdated', () => {
  const event: WaitlistUpdatedEvent = { date: DATE, parkingSpotId: 'spot-a', waitlistCount: 3 };

  it('patches only the count', () => {
    const before = day({
      spots: [
        row('spot-a', {
          reservation: publicReservation('res-1', STRANGER),
          waitlistCount: 1,
          viewerWaitlistEntryId: 'wait-9',
          viewerWaitlistPosition: 1,
        }),
      ],
    });
    const next = applyWaitlistUpdated(before, event);
    expect(next.spots[0]?.waitlistCount).toBe(3);
    // The viewer fields are deliberately untouched: the broadcast is not
    // allowed to carry them, so guessing would be worse than being stale for
    // the length of the refetch that `waitlistUpdatedTouchesViewer` triggers.
    expect(next.spots[0]?.viewerWaitlistEntryId).toBe('wait-9');
    expect(next.spots[0]?.viewerWaitlistPosition).toBe(1);
    expect(next.spots[0]?.reservation?.id).toBe('res-1');
  });

  it('patches a drop to zero', () => {
    const before = day({ spots: [row('spot-a', { waitlistCount: 2 })] });
    expect(
      applyWaitlistUpdated(before, { ...event, waitlistCount: 0 }).spots[0]?.waitlistCount
    ).toBe(0);
  });

  it('ignores an unchanged count, by reference', () => {
    const before = day({ spots: [row('spot-a', { waitlistCount: 3 })] });
    expect(applyWaitlistUpdated(before, event)).toBe(before);
  });

  it('ignores an event for a different day, by reference', () => {
    const before = day();
    expect(applyWaitlistUpdated(before, { ...event, date: OTHER_DATE })).toBe(before);
  });
});

function publicTimedReservation(
  overrides: Partial<PublicTimedReservation> = {}
): PublicTimedReservation {
  return {
    id: 'timed-1',
    startTime: '09:00',
    endTime: '10:30',
    guestName: 'Jan Host',
    licensePlate: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('applyTimedReservationsUpdated', () => {
  const blocks = [publicTimedReservation()];
  const event: TimedReservationsUpdatedEvent = {
    date: DATE,
    parkingSpotId: 'spot-a',
    timedReservations: blocks,
  };

  it('replaces the cell’s guest blocks and leaves every other spot untouched', () => {
    const before = day({
      spots: [row('spot-a', { timedReservations: [] }), row('spot-b', { waitlistCount: 2 })],
    });
    const next = applyTimedReservationsUpdated(before, event);
    expect(next.spots[0]?.timedReservations).toEqual(blocks);
    expect(next.spots[1]).toBe(before.spots[1]);
  });

  it('ignores an event for a different day, by reference', () => {
    const before = day();
    expect(applyTimedReservationsUpdated(before, { ...event, date: OTHER_DATE })).toBe(before);
  });
});

describe('deciding when a patch is not enough', () => {
  it('invalidates a created reservation only when the caller is the new holder', () => {
    const mine: ReservationCreatedEvent = {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', VIEWER),
    };
    const theirs: ReservationCreatedEvent = {
      ...mine,
      reservation: publicReservation('res-1', STRANGER),
    };
    expect(reservationCreatedTouchesViewer(mine, VIEWER)).toBe(true);
    expect(reservationCreatedTouchesViewer(theirs, VIEWER)).toBe(false);
  });

  it('invalidates a cancellation only when it was the caller’s own reservation', () => {
    const event: ReservationCancelledEvent = {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservationId: 'res-1',
    };
    expect(reservationCancelledTouchesViewer(day({ viewerReservationId: 'res-1' }), event)).toBe(
      true
    );
    expect(reservationCancelledTouchesViewer(day({ viewerReservationId: 'res-9' }), event)).toBe(
      false
    );
    expect(reservationCancelledTouchesViewer(day(), event)).toBe(false);
  });

  it('invalidates a reassignment for the promoted caller', () => {
    const event: ReservationReassignedEvent = {
      date: DATE,
      parkingSpotId: 'spot-a',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-1',
      reservation: publicReservation('res-2', VIEWER),
      fromWaitlistEntryId: 'wait-1',
    };
    expect(reservationReassignedTouchesViewer(day(), event, VIEWER)).toBe(true);
  });

  it('invalidates a reassignment for the caller who lost the spot', () => {
    const event: ReservationReassignedEvent = {
      date: DATE,
      parkingSpotId: 'spot-a',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-1',
      reservation: publicReservation('res-2', STRANGER),
      fromWaitlistEntryId: 'wait-1',
    };
    expect(
      reservationReassignedTouchesViewer(day({ viewerReservationId: 'res-1' }), event, VIEWER)
    ).toBe(true);
  });

  it('invalidates a reassignment for a caller merely queued on that cell', () => {
    // Their own entry did not change, but the entry ahead of them was
    // consumed, so `viewerWaitlistPosition` moved. Nothing in the payload
    // says so — which is the whole reason this predicate exists.
    const event: ReservationReassignedEvent = {
      date: DATE,
      parkingSpotId: 'spot-a',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-1',
      reservation: publicReservation('res-2', STRANGER),
      fromWaitlistEntryId: 'wait-1',
    };
    const queued = day({
      spots: [row('spot-a', { viewerWaitlistEntryId: 'wait-7', viewerWaitlistPosition: 2 })],
    });
    expect(reservationReassignedTouchesViewer(queued, event, VIEWER)).toBe(true);
    expect(reservationReassignedTouchesViewer(day(), event, VIEWER)).toBe(false);
  });

  it('does not invalidate a reassignment on a cell the caller is queued for on another day', () => {
    const event: ReservationReassignedEvent = {
      date: OTHER_DATE,
      parkingSpotId: 'spot-a',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-1',
      reservation: publicReservation('res-2', STRANGER),
      fromWaitlistEntryId: 'wait-1',
    };
    const queued = day({
      spots: [row('spot-a', { viewerWaitlistEntryId: 'wait-7', viewerWaitlistPosition: 2 })],
    });
    expect(reservationReassignedTouchesViewer(queued, event, VIEWER)).toBe(false);
  });

  it('invalidates a waitlist update only for a caller in that queue', () => {
    const event: WaitlistUpdatedEvent = { date: DATE, parkingSpotId: 'spot-a', waitlistCount: 3 };
    const queued = day({
      spots: [row('spot-a', { viewerWaitlistEntryId: 'wait-7', viewerWaitlistPosition: 2 })],
    });
    expect(waitlistUpdatedTouchesViewer(queued, event)).toBe(true);
    expect(waitlistUpdatedTouchesViewer(day(), event)).toBe(false);
    expect(waitlistUpdatedTouchesViewer(queued, { ...event, date: OTHER_DATE })).toBe(false);
    expect(waitlistUpdatedTouchesViewer(queued, { ...event, parkingSpotId: 'spot-b' })).toBe(false);
  });
});
