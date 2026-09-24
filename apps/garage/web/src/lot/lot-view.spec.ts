import type { AdminUser, DaySpotOverview, MonthWindowOverview } from '@garage/contract';
import { CAR_COLOR_PALETTE } from '@garage/design-system/tokens';
import { createDateFormatters } from '@garage/i18n';
import type { PublicTimedReservation } from '@garage/contract';
import {
  CAR_COLOR_VARS,
  GUEST_CAR_COLOR_VAR,
  carColorVar,
  carColorIndex,
  formatTimeRange,
  toBannerView,
  toDayNoteView,
  toGroupViews,
  toHolderOptions,
  toLotCounts,
  toRealtimeNoticeView,
  toSpotView,
  type CellLockView,
  type LotViewContext,
} from './lot-view';

const VIEWER = '01890000-0000-7000-8000-00000000v1ew';
const OTHER = '01890000-0000-7000-8000-0000000000th';

function spotRow(overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id: 'spot-1',
      label: 'E2.92',
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

function timedBlock(overrides: Partial<PublicTimedReservation> = {}): PublicTimedReservation {
  return {
    id: 'timed-1',
    startTime: '09:00',
    endTime: '10:30',
    guestName: 'Jan Host',
    licensePlate: null,
    createdAt: '2026-08-02T09:00:00.000Z',
    ...overrides,
  };
}

/** A user-held reservation, the common case every existing case here wants. */
function reservation(userId: string, name = 'Petr Novák', plate: string | null = '8SC 9012') {
  return {
    id: `res-${userId}`,
    createdAt: '2026-08-02T09:00:00.000Z',
    holder: { kind: 'USER' as const, userId, name, licensePlate: plate },
  };
}

/** A guest-held reservation. No `userId` exists on this member of the union. */
function guestReservation(name = 'Jan Host', plate: string | null = null) {
  return {
    id: 'res-guest',
    createdAt: '2026-08-02T09:00:00.000Z',
    holder: { kind: 'GUEST' as const, name, licensePlate: plate },
  };
}

function context(overrides: Partial<LotViewContext> = {}): LotViewContext {
  return {
    canReserve: true,
    isAdmin: false,
    viewerUserId: VIEWER,
    locks: new Map<string, CellLockView>(),
    viewerReservationId: null,
    ...overrides,
  };
}

function lock(holderId: string, holderName = 'Jana Dvořáková'): Map<string, CellLockView> {
  return new Map([['spot-1', { holderId, holderName, expiresAt: '2026-08-02T09:00:30.000Z' }]]);
}

describe('carColorIndex', () => {
  it('lands inside the design system palette for any id', () => {
    for (const id of ['', 'a', VIEWER, OTHER, 'x'.repeat(200), '💥 emoji id']) {
      const index = carColorIndex(id);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(CAR_COLOR_PALETTE.length);
    }
  });

  it('is deterministic — the same id always gets the same colour', () => {
    // The design requires this explicitly: a car whose colour changed between
    // renders would be a different car every repaint.
    expect(carColorIndex(VIEWER)).toBe(carColorIndex(VIEWER));
    expect(carColorVar(VIEWER)).toBe(carColorVar(VIEWER));
  });

  it('does not collapse ids that share a long prefix', () => {
    // UUID v7 is timestamp-prefixed, so every user provisioned in the same
    // millisecond shares its leading characters. A hash reading only the front
    // of the string would paint them all one colour.
    const base = '01890000-0000-7000-8000-00000000000';
    const indexes = new Set(
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((suffix) =>
        carColorIndex(base + suffix)
      )
    );
    expect(indexes.size).toBeGreaterThan(1);
  });

  it('names the utility for the index it picked, not a fixed one', () => {
    // Written as an invariant tying the two functions together rather than as
    // a shape check. A shape check (`/^text-car-[123]$/`) was the first
    // version and a constant `carColorVar` survived it — the hazard of
    // mutating only the helper the tests call, when the call site is what
    // ships.
    for (const id of ['', 'a', VIEWER, OTHER, 'spot-holder-7', 'ř💥']) {
      expect(carColorVar(id)).toBe(`var(--color-car-${carColorIndex(id) + 1})`);
    }
  });

  it('does not paint every car the same colour', () => {
    const classes = new Set(
      Array.from({ length: 40 }, (_unused, index) => carColorVar(`user-${index}`))
    );
    expect(classes.size).toBe(CAR_COLOR_PALETTE.length);
  });
});

describe('toSpotView', () => {
  it('draws a free, bookable spot as free and offers reserving it', () => {
    const view = toSpotView(spotRow(), context());
    expect(view.appearance).toBe('free');
    expect(view.action).toBe('reserve');
    expect(view.showAdminMenu).toBe(false);
  });

  it('draws a free spot as window-locked and offers the explanation when canReserve is false', () => {
    const view = toSpotView(spotRow(), context({ canReserve: false }));
    expect(view.appearance).toBe('window-locked');
    expect(view.action).toBe('info');
    expect(view.infoReason).toBe('window-locked');
  });

  it('gives every non-`info` spot a null infoReason', () => {
    expect(toSpotView(spotRow(), context()).infoReason).toBeNull();
    expect(
      toSpotView(spotRow({ reservation: reservation(OTHER) }), context()).infoReason
    ).toBeNull();
    expect(
      toSpotView(spotRow({ reservation: reservation(VIEWER) }), context()).infoReason
    ).toBeNull();
  });

  it('refuses reserve on a free spot when the viewer already holds a reservation elsewhere that day', () => {
    const view = toSpotView(spotRow(), context({ viewerReservationId: 'res-elsewhere' }));
    expect(view.appearance).toBe('free');
    expect(view.action).toBe('info');
    expect(view.infoReason).toBe('already-reserved');
  });

  it('refuses queueing on a taken spot when the viewer already holds a reservation elsewhere that day', () => {
    const view = toSpotView(
      spotRow({ reservation: reservation(OTHER) }),
      context({ viewerReservationId: 'res-elsewhere' })
    );
    expect(view.appearance).toBe('taken');
    expect(view.action).toBe('info');
    expect(view.infoReason).toBe('already-reserved');
  });

  it('still offers cancelling the caller’s own spot when viewerReservationId names it', () => {
    const view = toSpotView(
      spotRow({ reservation: reservation(VIEWER) }),
      context({ viewerReservationId: 'res-VIEWER' })
    );
    expect(view.isMine).toBe(true);
    expect(view.action).toBe('mine');
    expect(view.infoReason).toBeNull();
  });

  it('reports window-locked, not already-reserved, when both are true', () => {
    // A locked month is the more fundamental restriction — it applies to
    // every viewer, not just one already holding a spot — so it wins the
    // copy even when the viewer also already has a reservation elsewhere.
    const view = toSpotView(
      spotRow(),
      context({ canReserve: false, viewerReservationId: 'res-elsewhere' })
    );
    expect(view.appearance).toBe('window-locked');
    expect(view.infoReason).toBe('window-locked');
  });

  it('reads canReserve from the payload rather than re-deriving it from the window', () => {
    // The contract forbids re-derivation: an admin is not restricted by the
    // window at all, and a past or non-business day is refused whatever the
    // window says. Both directions are checked.
    expect(toSpotView(spotRow(), context({ canReserve: true, isAdmin: false })).appearance).toBe(
      'free'
    );
    expect(toSpotView(spotRow(), context({ canReserve: false, isAdmin: true })).appearance).toBe(
      'window-locked'
    );
  });

  it("draws somebody else's reservation as taken and offers the queue", () => {
    const view = toSpotView(spotRow({ reservation: reservation(OTHER) }), context());
    expect(view.appearance).toBe('taken');
    expect(view.action).toBe('queue');
    expect(view.isMine).toBe(false);
    expect(view.holderName).toBe('Petr Novák');
    expect(view.holderPlate).toBe('8SC 9012');
    expect(view.carColorClass).toBe(carColorVar(OTHER));
  });

  it('offers cancelling rather than queueing on the caller’s own reservation', () => {
    const view = toSpotView(spotRow({ reservation: reservation(VIEWER) }), context());
    expect(view.isMine).toBe(true);
    expect(view.action).toBe('mine');
  });

  it('lets a cell lock win over an occupied spot, and makes the tile inert', () => {
    const view = toSpotView(
      spotRow({ reservation: reservation(OTHER) }),
      context({ locks: lock(OTHER) })
    );
    expect(view.appearance).toBe('editing');
    expect(view.action).toBe('none');
    expect(view.editorName).toBe('Jana Dvořáková');
    expect(view.holderName).toBeNull();
  });

  it('ignores a lock this client holds itself', () => {
    // Whether the gateway echoes a broadcast to its own sender is Task 15's
    // business. The caller with the form open must never see their own tile
    // hatched and their own reserve action taken away.
    const view = toSpotView(spotRow(), context({ locks: lock(VIEWER) }));
    expect(view.appearance).toBe('free');
    expect(view.action).toBe('reserve');
    expect(view.editorName).toBeNull();
  });

  it('shows the ⋯ menu only to an admin, and only on a taken spot', () => {
    const taken = spotRow({ reservation: reservation(OTHER) });
    expect(toSpotView(taken, context({ isAdmin: true })).showAdminMenu).toBe(true);
    expect(toSpotView(taken, context({ isAdmin: false })).showAdminMenu).toBe(false);
    expect(toSpotView(spotRow(), context({ isAdmin: true })).showAdminMenu).toBe(false);
    expect(toSpotView(taken, context({ isAdmin: true, locks: lock(OTHER) })).showAdminMenu).toBe(
      false
    );
  });

  it('carries the waitlist through in every appearance', () => {
    const row = { waitlistCount: 2, viewerWaitlistEntryId: 'w-1', viewerWaitlistPosition: 2 };
    for (const ctx of [
      context(),
      context({ canReserve: false }),
      context({ locks: lock(OTHER) }),
    ]) {
      const view = toSpotView(spotRow(row), ctx);
      expect(view.waitlistCount).toBe(2);
      expect(view.viewerWaitlistEntryId).toBe('w-1');
      expect(view.viewerWaitlistPosition).toBe(2);
    }
  });
});

describe('toSpotView — guest time blocks', () => {
  const blocks = [
    timedBlock({ id: 'timed-1', startTime: '09:00', endTime: '10:30' }),
    timedBlock({ id: 'timed-2', startTime: '13:00', endTime: '14:00' }),
  ];

  it('draws a spot with guest blocks and no full-day holder as timed', () => {
    const view = toSpotView(spotRow({ timedReservations: blocks }), context());
    expect(view.appearance).toBe('timed');
    expect(view.timedBlocks).toEqual(blocks);
    expect(view.holderName).toBeNull();
  });

  it('offers reserving a timed spot only to an admin who can reserve', () => {
    const row = spotRow({ timedReservations: blocks });

    expect(toSpotView(row, context({ isAdmin: true, canReserve: true })).action).toBe('reserve');
    expect(toSpotView(row, context({ isAdmin: false, canReserve: true })).action).toBe('info');
    expect(toSpotView(row, context({ isAdmin: false, canReserve: true })).infoReason).toBe('timed');
    expect(toSpotView(row, context({ isAdmin: true, canReserve: false })).action).toBe('info');
    expect(toSpotView(row, context({ isAdmin: true, canReserve: false })).infoReason).toBe(
      'window-locked'
    );
  });

  it('lets a cell lock win over guest blocks too', () => {
    const view = toSpotView(
      spotRow({ timedReservations: blocks }),
      context({ locks: lock(OTHER) })
    );
    expect(view.appearance).toBe('editing');
  });
});

describe('formatTimeRange', () => {
  it('strips a leading zero off the hour and joins with an en dash', () => {
    expect(formatTimeRange({ startTime: '09:00', endTime: '10:30' })).toBe('9:00–10:30');
  });

  it('leaves a two-digit hour, including midnight, alone', () => {
    expect(formatTimeRange({ startTime: '23:30', endTime: '24:00' })).toBe('23:30–24:00');
  });
});

describe('toGroupViews', () => {
  function rowIn(group: 'IT' | 'SHARED', id: string, overrides: Partial<DaySpotOverview> = {}) {
    return spotRow({
      ...overrides,
      spot: { ...spotRow().spot, id, label: id, group },
    });
  }

  it('orders the groups as the contract enumerates them', () => {
    const groups = toGroupViews([rowIn('SHARED', 's1'), rowIn('IT', 'i1')], context());
    expect(groups.map((group) => group.group)).toEqual(['IT', 'SHARED']);
  });

  it('omits a group with no active spots rather than drawing an empty rule', () => {
    const groups = toGroupViews([rowIn('IT', 'i1')], context());
    expect(groups.map((group) => group.group)).toEqual(['IT']);
  });

  it('counts a spot free when it has neither a holder nor a lock', () => {
    const groups = toGroupViews(
      [
        rowIn('IT', 'spot-1'),
        rowIn('IT', 'i2', { reservation: reservation(OTHER) }),
        rowIn('IT', 'i3'),
      ],
      context({ locks: lock(OTHER) })
    );
    // spot-1 is locked, i2 is taken, i3 is free.
    expect(groups[0]?.freeCount).toBe(1);
    expect(groups[0]?.totalCount).toBe(3);
  });

  it('still counts a window-locked tile as free', () => {
    // A ⊘ tile is an unoccupied spot. Telling an admin "0 z 2 volných" for a
    // lot they can still book would be wrong.
    const groups = toGroupViews(
      [rowIn('IT', 'i1'), rowIn('IT', 'i2')],
      context({ canReserve: false })
    );
    expect(groups[0]?.freeCount).toBe(2);
  });

  it('does not count a timed spot as free', () => {
    const groups = toGroupViews(
      [rowIn('IT', 'i1', { timedReservations: [timedBlock()] }), rowIn('IT', 'i2')],
      context()
    );
    expect(groups[0]?.freeCount).toBe(1);
    expect(groups[0]?.totalCount).toBe(2);
  });
});

describe('toLotCounts', () => {
  it('counts holders, ignoring who is editing', () => {
    const rows = [
      spotRow({ spot: { ...spotRow().spot, id: 'a' }, reservation: reservation(OTHER) }),
      spotRow({ spot: { ...spotRow().spot, id: 'b' } }),
      spotRow({ spot: { ...spotRow().spot, id: 'c' } }),
    ];
    expect(toLotCounts(rows)).toEqual({ free: 2, taken: 1 });
  });

  it('counts a spot with guest blocks and no full-day holder as taken', () => {
    const rows = [
      spotRow({ spot: { ...spotRow().spot, id: 'a' }, timedReservations: [timedBlock()] }),
      spotRow({ spot: { ...spotRow().spot, id: 'b' } }),
    ];
    expect(toLotCounts(rows)).toEqual({ free: 1, taken: 1 });
  });

  it('is zero for an empty lot', () => {
    expect(toLotCounts([])).toEqual({ free: 0, taken: 0 });
  });
});

describe('toHolderOptions', () => {
  it('picks the three fields a picker needs, dropping the rest of the admin row', () => {
    const row: AdminUser = {
      id: VIEWER,
      email: 'a@b.cz',
      name: 'Anna Nováková',
      licensePlate: '1AB2345',
      role: 'USER',
      oktaId: 'okta-1',
      active: true,
      preferredParkingSpotId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    expect(toHolderOptions([row])).toEqual([
      { userId: VIEWER, name: 'Anna Nováková', licensePlate: '1AB2345' },
    ]);
  });

  it('is empty for an empty list', () => {
    expect(toHolderOptions([])).toEqual([]);
  });
});

describe('toBannerView', () => {
  const cs = createDateFormatters('cs');

  function window(overrides: Partial<MonthWindowOverview> = {}): MonthWindowOverview {
    return {
      month: '2026-09',
      windowFrom: '2026-08-25',
      windowTo: '2026-08-31',
      state: 'OPEN',
      lockMode: 'AUTO',
      ...overrides,
    };
  }

  it('quotes the window’s last day when the state came from the automatic rule', () => {
    const view = toBannerView(window(), false, cs, '2026-08-28');
    expect(view).toEqual({
      tone: 'success',
      messageKey: 'bannerOpen',
      values: { month: 'září', until: '31. srpna', from: '25. srpna' },
    });
  });

  it('drops the cap once today is past the window, in the running month', () => {
    // `doc/decision/0315-*`: under AUTO, OPEN also covers the running month,
    // where the cap no longer applies and `windowTo` is already in the past —
    // quoting it as a still-binding deadline would be a false statement.
    const view = toBannerView(window(), false, cs, '2026-09-05');
    expect(view.messageKey).toBe('bannerOpenUncapped');
  });

  it('never quotes a date when an admin forced the state', () => {
    // `monthWindowOverviewSchema`: windowFrom/windowTo are the range the AUTO
    // rule *would* have produced and are hypothetical under an override, so
    // "do 31. srpna platí měsíční limit" would be a false statement.
    const view = toBannerView(window({ lockMode: 'FORCE_OPEN' }), false, cs, '2026-08-28');
    expect(view.messageKey).toBe('bannerOpenForced');
    expect(view.values.until).toBe('');
    expect(view.values.from).toBe('');
  });

  it('tells an admin and a normal user different things about a locked month', () => {
    const locked = window({ state: 'LOCKED', lockMode: 'FORCE_LOCKED' });
    expect(toBannerView(locked, true, cs, '2026-08-28').messageKey).toBe('bannerLockedAdmin');
    expect(toBannerView(locked, false, cs, '2026-08-28').messageKey).toBe('bannerLockedUser');
    expect(toBannerView(locked, false, cs, '2026-08-28').tone).toBe('warning');
  });

  it('has a third state the design’s boolean does not', () => {
    const view = toBannerView(window({ state: 'NOT_YET_OPEN' }), false, cs, '2026-08-20');
    expect(view.messageKey).toBe('bannerNotYetOpen');
    expect(view.tone).toBe('warning');
    expect(view.values.from).toBe('25. srpna');
  });

  it('drops the opening date from NOT_YET_OPEN under an override too', () => {
    const view = toBannerView(
      window({ state: 'NOT_YET_OPEN', lockMode: 'FORCE_LOCKED' }),
      false,
      cs,
      '2026-08-20'
    );
    expect(view.messageKey).toBe('bannerNotYetOpenForced');
    expect(view.values.from).toBe('');
  });

  it('names the month of the window, not of today', () => {
    expect(toBannerView(window({ month: '2026-01' }), false, cs, '2026-08-28').values.month).toBe(
      'leden'
    );
    expect(toBannerView(window({ month: '2026-12' }), false, cs, '2026-08-28').values.month).toBe(
      'prosinec'
    );
  });
});

describe('toDayNoteView', () => {
  it('names a Czech public holiday', () => {
    expect(toDayNoteView('2026-09-28')).toEqual({
      key: 'holiday',
      name: 'Den české státnosti',
      highlighted: true,
    });
  });

  it('calls a Saturday a weekend rather than a working day', () => {
    // The design has only "holiday" and "Pracovní den". A weekend is a day
    // `isBusinessDay` refuses, so every tile on it is window-locked and this
    // bar is the only place that says why.
    expect(toDayNoteView('2026-09-26').key).toBe('weekend');
    expect(toDayNoteView('2026-09-27').key).toBe('weekend');
  });

  it('calls an ordinary weekday a working day, and does not highlight it', () => {
    expect(toDayNoteView('2026-09-29')).toEqual({ key: 'workday', name: '', highlighted: false });
  });

  it('prefers the holiday label when a holiday falls on a weekend', () => {
    // 2026-12-26 (2. svátek vánoční) is a Saturday.
    expect(toDayNoteView('2026-12-26').key).toBe('holiday');
  });
});

describe('toRealtimeNoticeView', () => {
  it('says nothing while the board is live', () => {
    expect(toRealtimeNoticeView('connected', true)).toBe('none');
    expect(toRealtimeNoticeView('connected', false)).toBe('none');
  });

  it('names a dropped connection once the board has been live', () => {
    // The state I1 produces: broadcasts are being missed and the grid is
    // showing taken spots as free, with nothing on screen saying so.
    expect(toRealtimeNoticeView('disconnected', true)).toBe('dropped');
    expect(toRealtimeNoticeView('connecting', true)).toBe('dropped');
  });

  it('stays quiet before the first connection, so a page load does not flash a warning', () => {
    // `RealtimeProvider` starts at `disconnected`, and `RealtimeBoundary`
    // holds the socket closed until the session resolves. A rule that read
    // the status alone would warn on every single load, about data that has
    // not gone stale because it has not arrived.
    expect(toRealtimeNoticeView('disconnected', false)).toBe('none');
    expect(toRealtimeNoticeView('connecting', false)).toBe('none');
  });

  it('reports a refused handshake whether or not the board was ever live', () => {
    // Terminal by construction, and a credential problem rather than a slow
    // start — there is no later state that would correct it.
    expect(toRealtimeNoticeView('rejected', false)).toBe('rejected');
    expect(toRealtimeNoticeView('rejected', true)).toBe('rejected');
  });
});

describe('toSpotView — who holds the bay', () => {
  it('is mine when the user holder is the viewer', () => {
    const view = toSpotView(
      spotRow({ reservation: reservation(VIEWER, 'Karel Zíbar', '4AB 1234') }),
      context({ viewerUserId: VIEWER })
    );

    expect(view.isMine).toBe(true);
    expect(view.holderIsGuest).toBe(false);
    expect(view.holderName).toBe('Karel Zíbar');
    expect(view.holderPlate).toBe('4AB 1234');
  });

  it('is never mine when a guest holds it, whoever is looking', () => {
    const view = toSpotView(
      spotRow({ reservation: guestReservation() }),
      context({ viewerUserId: VIEWER })
    );

    expect(view.isMine).toBe(false);
    expect(view.holderIsGuest).toBe(true);
    expect(view.holderName).toBe('Jan Host');
    expect(view.holderPlate).toBeNull();
  });

  it('gives a guest the neutral car colour, not a per-user one', () => {
    // `carColorVar` is a hash of a user id and is stable for the life of that
    // user. A guest has no id to hash, and falling through to index 0 would
    // silently claim the first user's colour.
    const view = toSpotView(
      spotRow({ reservation: guestReservation() }),
      context({ viewerUserId: VIEWER })
    );

    expect(view.carColorClass).toBe(GUEST_CAR_COLOR_VAR);
    expect(CAR_COLOR_VARS).not.toContain(view.carColorClass);
  });
});
