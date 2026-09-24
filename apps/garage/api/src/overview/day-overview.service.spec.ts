import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaDouble } from '../testing/prisma-double';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { SpotsService } from '../spots/spots.service';
import { DayOverviewService } from './day-overview.service';

/** 2026-09-02 is a Wednesday; 2026-09-05 a Saturday; 2026-09-28 a Czech holiday. */
const TODAY = '2026-09-02';

function authenticated(id: string, role: AuthenticatedUser['role'] = 'USER'): AuthenticatedUser {
  return { id, oktaId: `okta-${id}`, email: `${id}@example.test`, name: id, role, active: true };
}

describe('DayOverviewService', () => {
  let double: PrismaDouble;
  let overview: DayOverviewService;

  beforeEach(() => {
    double = new PrismaDouble();
    const prisma = double.asPrismaService();
    const audit = new AuditLogService(prisma);
    overview = new DayOverviewService(
      prisma,
      new SpotsService(prisma, audit),
      new ReservationWindowService(prisma, audit)
    );
    double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'AUTO' });
  });

  it('returns every active spot, in the same order as the spot listing', async () => {
    double.seedSpot({ label: 'S1', group: 'SHARED' });
    double.seedSpot({ label: 'IT1', group: 'IT' });
    double.seedSpot({ label: 'GONE', active: false });

    const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

    expect(result.spots.map((row) => row.spot.label)).toEqual(['IT1', 'S1']);
  });

  it('attaches the holder of each reserved spot, and nothing else about them', async () => {
    const spot = double.seedSpot({ label: 'A1' });
    const holder = double.seedUser({ name: 'Alice', licensePlate: '1AB 2345' });
    double.seedReservation({ parkingSpotId: spot.id, userId: holder.id, date: TODAY });

    const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

    expect(result.spots[0]?.reservation).toMatchObject({
      holder: { kind: 'USER', userId: holder.id, name: 'Alice', licensePlate: '1AB 2345' },
    });
    // Everything else about the holder — above all the ICS token — stays here.
    expect(JSON.stringify(result)).not.toContain(holder.icsToken);
    expect(JSON.stringify(result)).not.toContain(holder.email);
  });

  it('leaves a free spot’s reservation null', async () => {
    double.seedSpot({ label: 'A1' });

    const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

    expect(result.spots[0]?.reservation).toBeNull();
  });

  it('reads a reservation only for the day it was asked about', async () => {
    const spot = double.seedSpot({ label: 'A1' });
    const holder = double.seedUser();
    double.seedReservation({ parkingSpotId: spot.id, userId: holder.id, date: '2026-09-03' });

    const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

    expect(result.spots[0]?.reservation).toBeNull();
  });

  it('lists a spot’s guest blocks ascending by start time, and nothing for a spot with none', async () => {
    const spot = double.seedSpot({ label: 'A1' });
    double.seedSpot({ label: 'A2' });
    double.seedTimedReservation({
      parkingSpotId: spot.id,
      date: TODAY,
      startMinute: 630, // 10:30
      endMinute: 660,
      guestName: 'Later Guest',
    });
    double.seedTimedReservation({
      parkingSpotId: spot.id,
      date: TODAY,
      startMinute: 540, // 09:00
      endMinute: 600,
      guestName: 'Earlier Guest',
    });

    const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

    expect(result.spots[0]?.timedReservations).toMatchObject([
      { startTime: '09:00', endTime: '10:00', guestName: 'Earlier Guest' },
      { startTime: '10:30', endTime: '11:00', guestName: 'Later Guest' },
    ]);
    expect(result.spots[1]?.timedReservations).toEqual([]);
  });

  describe('the queue', () => {
    it('counts everybody waiting for a spot on that day', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const other = double.seedSpot({ label: 'A2' });
      const [a, b, c] = [double.seedUser(), double.seedUser(), double.seedUser()];
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: a.id, date: TODAY });
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: b.id, date: TODAY });
      double.seedWaitlistEntry({ parkingSpotId: other.id, userId: c.id, date: TODAY });

      const result = await overview.getDay({ date: TODAY }, authenticated('viewer'), TODAY);

      expect(result.spots.map((row) => row.waitlistCount)).toEqual([2, 1]);
    });

    it('reports the viewer’s own entry and their 1-based position', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const first = double.seedUser();
      const viewer = double.seedUser();
      double.seedWaitlistEntry({
        parkingSpotId: spot.id,
        userId: first.id,
        date: TODAY,
        createdAt: new Date('2026-08-01T08:00:00.000Z'),
      });
      const mine = double.seedWaitlistEntry({
        parkingSpotId: spot.id,
        userId: viewer.id,
        date: TODAY,
        createdAt: new Date('2026-08-01T09:00:00.000Z'),
      });

      const result = await overview.getDay({ date: TODAY }, authenticated(viewer.id), TODAY);

      expect(result.spots[0]).toMatchObject({
        waitlistCount: 2,
        viewerWaitlistEntryId: mine.id,
        viewerWaitlistPosition: 2,
      });
    });

    it('orders the queue by createdAt with id as the tiebreaker, like Task 13 promotes', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const viewer = double.seedUser();
      const sameInstant = new Date('2026-08-01T08:00:00.000Z');
      double.seedWaitlistEntry({
        id: 'aaaaaaaa-0000-4000-8000-000000000000',
        parkingSpotId: spot.id,
        userId: double.seedUser().id,
        date: TODAY,
        createdAt: sameInstant,
      });
      double.seedWaitlistEntry({
        id: 'bbbbbbbb-0000-4000-8000-000000000000',
        parkingSpotId: spot.id,
        userId: viewer.id,
        date: TODAY,
        createdAt: sameInstant,
      });

      const result = await overview.getDay({ date: TODAY }, authenticated(viewer.id), TODAY);

      expect(result.spots[0]?.viewerWaitlistPosition).toBe(2);
    });

    it('reports null for a viewer who is not queued', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      double.seedWaitlistEntry({
        parkingSpotId: spot.id,
        userId: double.seedUser().id,
        date: TODAY,
      });

      const result = await overview.getDay({ date: TODAY }, authenticated('outsider'), TODAY);

      expect(result.spots[0]).toMatchObject({
        viewerWaitlistEntryId: null,
        viewerWaitlistPosition: null,
      });
    });
  });

  it('names the viewer’s own reservation for that day', async () => {
    const spot = double.seedSpot({ label: 'A1' });
    const viewer = double.seedUser();
    const reservation = double.seedReservation({
      parkingSpotId: spot.id,
      userId: viewer.id,
      date: TODAY,
    });

    const result = await overview.getDay({ date: TODAY }, authenticated(viewer.id), TODAY);

    expect(result.viewerReservationId).toBe(reservation.id);
  });

  describe('the reservation window travels with the payload', () => {
    it('describes the month the requested day falls in', async () => {
      const result = await overview.getDay({ date: '2026-10-15' }, authenticated('v'), TODAY);

      expect(result.window).toMatchObject({
        month: '2026-10',
        state: 'NOT_YET_OPEN',
        lockMode: 'AUTO',
      });
    });

    it('is read under the stored settings, not under the defaults', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_OPEN' });

      const result = await overview.getDay({ date: '2026-12-15' }, authenticated('v'), TODAY);

      expect(result.window.state).toBe('OPEN');
    });
  });

  describe('canReserve', () => {
    it('is false for a day in the past, admin included', async () => {
      await expect(
        overview.getDay({ date: '2026-09-01' }, authenticated('a', 'ADMIN'), TODAY)
      ).resolves.toMatchObject({ canReserve: false });
    });

    it('is false at the weekend', async () => {
      await expect(
        overview.getDay({ date: '2026-09-05' }, authenticated('a', 'ADMIN'), TODAY)
      ).resolves.toMatchObject({ canReserve: false });
    });

    it('is false on a Czech public holiday', async () => {
      // 2026-09-28 — St Wenceslas Day, a Monday.
      await expect(
        overview.getDay({ date: '2026-09-28' }, authenticated('a', 'ADMIN'), TODAY)
      ).resolves.toMatchObject({ canReserve: false });
    });

    it('is true for an admin on a locked business day — the window does not bind them', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' });

      const result = await overview.getDay(
        { date: '2026-10-15' },
        authenticated('a', 'ADMIN'),
        TODAY
      );

      expect(result.window.state).toBe('LOCKED');
      expect(result.canReserve).toBe(true);
    });

    it('is false for an ordinary user when the month is not open', async () => {
      const result = await overview.getDay({ date: '2026-10-15' }, authenticated('u'), TODAY);

      expect(result.window.state).toBe('NOT_YET_OPEN');
      expect(result.canReserve).toBe(false);
    });

    it('is true for an ordinary user when the month is open', async () => {
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });

      const result = await overview.getDay({ date: '2026-10-15' }, authenticated('u'), TODAY);

      expect(result.window.state).toBe('OPEN');
      expect(result.canReserve).toBe(true);
    });

    it('is true for an ordinary user in the running month under AUTO — the window only opens', async () => {
      // 2026-09-15 is a Tuesday in the month `TODAY` (2026-09-02) is in.
      const result = await overview.getDay({ date: '2026-09-15' }, authenticated('u'), TODAY);

      expect(result.window.state).toBe('OPEN');
      expect(result.canReserve).toBe(true);
    });

    it('is exactly canReserveMonth and the day’s own reservability, never one of them alone', async () => {
      // The composition, asserted where it can actually be seen: an open month
      // with a weekend inside it is the case that separates the two fields.
      // It has to be **October**, not September: the window closes at the start
      // of the target month, so the month `TODAY` is in is locked to an
      // ordinary user whatever `openDaysBefore` says.
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });

      const saturday = await overview.getDay({ date: '2026-10-03' }, authenticated('u'), TODAY);
      expect(saturday.window.state).toBe('OPEN');
      expect(saturday).toMatchObject({ canReserve: false, canReserveMonth: true });

      const weekday = await overview.getDay({ date: '2026-10-05' }, authenticated('u'), TODAY);
      expect(weekday).toMatchObject({ canReserve: true, canReserveMonth: true });
    });

    it('does not fold in the one-per-day rule — the screen reads that from viewerReservationId', async () => {
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });
      const spot = double.seedSpot({ label: 'A1' });
      const viewer = double.seedUser();
      double.seedReservation({
        parkingSpotId: spot.id,
        userId: viewer.id,
        date: '2026-10-15',
      });

      const result = await overview.getDay({ date: '2026-10-15' }, authenticated(viewer.id), TODAY);

      expect(result.canReserve).toBe(true);
      expect(result.viewerReservationId).not.toBeNull();
    });
  });

  /**
   * The per-month answer, which `doc/decision/0175-*` added because
   * `canReserve` cannot serve a screen whose subject is the month. Every case
   * below is one where the two fields must **disagree** or must agree for a
   * reason that is not the day.
   */
  describe('canReserveMonth', () => {
    it('stays true on a weekend of an open month, where canReserve is false', async () => {
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });

      // 2026-10-03 is a Saturday, and October is the month an ordinary user can
      // still book on 2026-09-02 — the window closes at the start of the target
      // month, so an open month is always a **future** one for them.
      const result = await overview.getDay({ date: '2026-10-03' }, authenticated('u'), TODAY);

      // Asserted, not assumed: without this the test would also pass on a month
      // that is simply locked for everybody.
      expect(result.window.state).toBe('OPEN');
      expect(result.canReserveMonth).toBe(true);
      expect(result.canReserve).toBe(false);
    });

    it('stays true on a Czech public holiday of an open month', async () => {
      // 2026-09-28 — Den české státnosti, the very day the bulk modal's design
      // screenshot is taken on (`doc/design/screens/10-modal-bulk.png`). For
      // September to be open, "today" has to be inside its window: 40 days
      // before 2026-09-01 is 2026-07-23, and the window runs to 2026-08-31.
      double.seedWindowSettings({ openDaysBefore: 40, lockMode: 'AUTO' });

      const result = await overview.getDay(
        { date: '2026-09-28' },
        authenticated('u'),
        '2026-08-20'
      );

      expect(result.window.state).toBe('OPEN');
      expect(result.canReserveMonth).toBe(true);
      expect(result.canReserve).toBe(false);
    });

    it('stays true on a past day, for an admin who is not bound by the window at all', async () => {
      // A past day of an *open* month cannot exist for an ordinary user, since
      // the window shuts when the month begins. The admin is the one caller for
      // whom "the month is available, this day is not" is reachable in the past,
      // and it is the case that proves the past-day rule lives in the day half.
      const result = await overview.getDay(
        { date: '2026-09-01' },
        authenticated('a', 'ADMIN'),
        TODAY
      );

      expect(result.canReserveMonth).toBe(true);
      expect(result.canReserve).toBe(false);
    });

    it('is false for an ordinary user when the month is not open, on a perfectly good weekday', async () => {
      const result = await overview.getDay({ date: '2026-10-15' }, authenticated('u'), TODAY);

      expect(result.window.state).toBe('NOT_YET_OPEN');
      expect(result.canReserveMonth).toBe(false);
    });

    it('is false for an ordinary user when the month is locked', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' });

      const result = await overview.getDay({ date: '2026-10-15' }, authenticated('u'), TODAY);

      expect(result.window.state).toBe('LOCKED');
      expect(result.canReserveMonth).toBe(false);
    });

    it('is true for an admin in a locked month — the exemption is not in the window', async () => {
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' });

      const result = await overview.getDay(
        { date: '2026-10-15' },
        authenticated('a', 'ADMIN'),
        TODAY
      );

      expect(result.window.state).toBe('LOCKED');
      expect(result.canReserveMonth).toBe(true);
    });

    it('does not let the admin exemption rescue a weekend for canReserve', async () => {
      // The ordering that matters: `canReserveMonth && isReservableDay`. An
      // admin gets the month, never the Saturday.
      double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'FORCE_LOCKED' });

      const result = await overview.getDay(
        { date: '2026-09-05' },
        authenticated('a', 'ADMIN'),
        TODAY
      );

      expect(result.canReserveMonth).toBe(true);
      expect(result.canReserve).toBe(false);
    });
  });
});
