import { Prisma } from '@garage/database';
import { AuditLogService } from '../audit/audit-log.service';
import { DomainError } from '../common/errors/domain-error';
import { PrismaDouble } from '../testing/prisma-double';
import { SpotsService } from './spots.service';

const TODAY = '2026-09-02';

describe('SpotsService', () => {
  let double: PrismaDouble;
  let spots: SpotsService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(`${TODAY}T09:00:00.000Z`) });
    double = new PrismaDouble();
    spots = new SpotsService(
      double.asPrismaService(),
      new AuditLogService(double.asPrismaService())
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('listing', () => {
    it('returns active spots only, in a stable group-then-label order', async () => {
      double.seedSpot({ label: 'S2', group: 'SHARED' });
      double.seedSpot({ label: 'IT1', group: 'IT' });
      double.seedSpot({ label: 'S1', group: 'SHARED' });
      double.seedSpot({ label: 'GONE', group: 'SHARED', active: false });

      const result = await spots.listActive();

      expect(result.map((spot) => spot.label)).toEqual(['IT1', 'S1', 'S2']);
    });

    it('maps timestamps to the contract’s ISO strings, not Date objects', async () => {
      double.seedSpot({ label: 'A1' });

      const [spot] = await spots.listActive();

      expect(spot?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('hides retired spots from the admin table unless asked for them', async () => {
      double.seedSpot({ label: 'LIVE' });
      double.seedSpot({ label: 'GONE', active: false });

      await expect(spots.adminList({ includeInactive: false })).resolves.toHaveLength(1);
      await expect(spots.adminList({ includeInactive: true })).resolves.toHaveLength(2);
    });

    it('filters by group', async () => {
      double.seedSpot({ label: 'IT1', group: 'IT' });
      double.seedSpot({ label: 'S1', group: 'SHARED' });

      const result = await spots.adminList({ includeInactive: false, group: 'IT' });

      expect(result.map((spot) => spot.label)).toEqual(['IT1']);
    });

    it('leaves hidden spots out of the plain listing, and keeps them in the other two', async () => {
      double.seedSpot({ label: 'SEEN' });
      double.seedSpot({ label: 'SECRET', hidden: true });

      await expect(spots.listVisible()).resolves.toMatchObject([{ label: 'SEEN' }]);
      await expect(spots.listActive()).resolves.toHaveLength(2);
      await expect(spots.adminList({ includeInactive: false })).resolves.toHaveLength(2);
    });
  });

  describe('create', () => {
    it('stores the spot and returns it in contract shape', async () => {
      const created = await spots.create({ label: 'E2.92', group: 'IT' }, 'admin-1');

      expect(created).toMatchObject({ label: 'E2.92', group: 'IT', active: true });
      expect(double.spots).toHaveLength(1);
    });

    it('writes an audit entry naming the new spot', async () => {
      const created = await spots.create({ label: 'E2.92', group: 'IT' }, 'admin-1');

      expect(double.auditLogs).toEqual([
        expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'SPOT_UPDATED',
          entityType: 'ParkingSpot',
          entityId: created.id,
          payload: { change: 'created', label: 'E2.92', group: 'IT', evCharger: false },
        }),
      ]);
    });

    it('stores the EV charger flag when one is sent', async () => {
      const created = await spots.create(
        { label: 'E2.93', group: 'IT', evCharger: true },
        'admin-1'
      );

      expect(created).toMatchObject({ label: 'E2.93', evCharger: true });
      expect(double.auditLogs).toEqual([
        expect.objectContaining({
          payload: { change: 'created', label: 'E2.93', group: 'IT', evCharger: true },
        }),
      ]);
    });

    it('defaults to no charger when the flag is omitted', async () => {
      const created = await spots.create({ label: 'E2.94', group: 'IT' }, 'admin-1');

      expect(created.evCharger).toBe(false);
    });

    it('lets the unique index reject a duplicate label', async () => {
      await spots.create({ label: 'E2.92', group: 'IT' }, 'admin-1');

      // Raised as P2002, which `toOrpcError` turns into the contract's CONFLICT.
      await expect(spots.create({ label: 'E2.92', group: 'SHARED' }, 'admin-1')).rejects.toThrow(
        Prisma.PrismaClientKnownRequestError
      );
    });
  });

  describe('update', () => {
    it('changes only the fields that were sent', async () => {
      const spot = double.seedSpot({ label: 'A1', group: 'SHARED' });

      const updated = await spots.update({ id: spot.id, label: 'A2' }, 'admin-1');

      expect(updated).toMatchObject({ label: 'A2', group: 'SHARED', active: true });
    });

    it('records the before and the after', async () => {
      const spot = double.seedSpot({ label: 'A1', group: 'SHARED' });

      await spots.update({ id: spot.id, group: 'IT' }, 'admin-1');

      expect(double.auditLogs[0]?.payload).toEqual({
        change: 'updated',
        before: { label: 'A1', group: 'SHARED', active: true, hidden: false, evCharger: false },
        after: { label: 'A1', group: 'IT', active: true, hidden: false, evCharger: false },
      });
    });

    it('rejects an unknown spot with NOT_FOUND', async () => {
      await expect(
        spots.update({ id: '11111111-1111-4111-8111-111111111111', label: 'X' }, 'admin-1')
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('applies the deactivation rule to `active: false` too, not just to deactivate()', async () => {
      // Otherwise `update({ active: false })` would be a way around the check —
      // which is how a spot ends up retired with people still holding it.
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-10' });

      await expect(spots.update({ id: spot.id, active: false }, 'admin-1')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(double.spots[0]?.active).toBe(true);
    });
  });

  describe('hiding', () => {
    it('hides and unhides a spot, audits it, and keeps isHidden in step', async () => {
      const spot = double.seedSpot({ label: 'A1' });

      await expect(spots.update({ id: spot.id, hidden: true }, 'admin-1')).resolves.toMatchObject({
        hidden: true,
        active: true,
      });
      expect(spots.isHidden(spot.id)).toBe(true);

      await spots.update({ id: spot.id, hidden: false }, 'admin-1');
      expect(spots.isHidden(spot.id)).toBe(false);
      expect(double.auditLogs.at(-1)?.payload).toMatchObject({
        change: 'updated',
        before: { hidden: true },
        after: { hidden: false },
      });
    });

    it('is not a retirement: it succeeds while somebody holds the spot from today on', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: TODAY });
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-10' });

      await expect(spots.update({ id: spot.id, hidden: true }, 'admin-1')).resolves.toMatchObject({
        hidden: true,
      });
    });

    it('loads the hidden ids at boot', async () => {
      const hidden = double.seedSpot({ label: 'SECRET', hidden: true });
      const seen = double.seedSpot({ label: 'SEEN' });

      await spots.onModuleInit();

      expect(spots.isHidden(hidden.id)).toBe(true);
      expect(spots.isHidden(seen.id)).toBe(false);
    });
  });

  describe('the EV charger flag', () => {
    it('sets and clears the flag, and audits it', async () => {
      const spot = double.seedSpot({ label: 'A1' });

      await expect(
        spots.update({ id: spot.id, evCharger: true }, 'admin-1')
      ).resolves.toMatchObject({ evCharger: true, active: true, hidden: false });

      await spots.update({ id: spot.id, evCharger: false }, 'admin-1');
      expect(double.spots[0]?.evCharger).toBe(false);
      expect(double.auditLogs.at(-1)?.payload).toMatchObject({
        change: 'updated',
        before: { evCharger: true },
        after: { evCharger: false },
      });
    });

    it('refuses nothing: it succeeds while somebody holds the spot from today on', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: TODAY });
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-10' });

      await expect(
        spots.update({ id: spot.id, evCharger: true }, 'admin-1')
      ).resolves.toMatchObject({ evCharger: true });
    });

    it('leaves a hidden spot hidden', async () => {
      const spot = double.seedSpot({ label: 'SECRET', hidden: true });
      await spots.onModuleInit();

      await expect(
        spots.update({ id: spot.id, evCharger: true }, 'admin-1')
      ).resolves.toMatchObject({ hidden: true, evCharger: true });
      expect(spots.isHidden(spot.id)).toBe(true);
    });
  });

  describe('deactivate', () => {
    it('retires the spot rather than deleting the row', async () => {
      const spot = double.seedSpot({ label: 'A1' });

      const result = await spots.deactivate({ id: spot.id }, 'admin-1');

      expect(result.active).toBe(false);
      expect(double.spots).toHaveLength(1);
    });

    it('writes an audit entry', async () => {
      const spot = double.seedSpot({ label: 'A1' });

      await spots.deactivate({ id: spot.id }, 'admin-1');

      expect(double.auditLogs).toEqual([
        expect.objectContaining({
          action: 'SPOT_UPDATED',
          entityId: spot.id,
          payload: { change: 'deactivated', label: 'A1' },
        }),
      ]);
    });

    it('refuses while somebody holds the spot today or later', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: TODAY });

      await expect(spots.deactivate({ id: spot.id }, 'admin-1')).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reservations: 1, waitlistEntries: 0 },
      });
    });

    it('refuses while somebody is only *queued* for the spot, with no reservation left', async () => {
      // Reachable without any admin mistake: a cancellation whose whole queue is
      // ineligible promotes nobody, so the spot goes free with its queue intact.
      // Retiring it then orphans those entries behind `listActive` — invisible
      // on the day overview, unreachable by the person queued, and never
      // promotable. See `doc/decision/0235-*`.
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-10' });

      await expect(spots.deactivate({ id: spot.id }, 'admin-1')).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reservations: 0, waitlistEntries: 1 },
      });
      expect(double.spots[0]?.active).toBe(true);
    });

    it('refuses while a guest block sits on the spot today or later', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      double.seedTimedReservation({
        parkingSpotId: spot.id,
        date: TODAY,
        startMinute: 540,
        endMinute: 600,
      });

      await expect(spots.deactivate({ id: spot.id }, 'admin-1')).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reservations: 0, waitlistEntries: 0, timedReservations: 1 },
      });
      expect(double.spots[0]?.active).toBe(true);
    });

    it('ignores reservations and queue entries that are already in the past', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const user = double.seedUser();
      double.seedReservation({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-01' });
      double.seedWaitlistEntry({ parkingSpotId: spot.id, userId: user.id, date: '2026-09-01' });

      await expect(spots.deactivate({ id: spot.id }, 'admin-1')).resolves.toMatchObject({
        active: false,
      });
    });

    it('is a no-op on an already retired spot, and writes no audit noise', async () => {
      const spot = double.seedSpot({ label: 'A1', active: false });

      await expect(spots.deactivate({ id: spot.id }, 'admin-1')).resolves.toMatchObject({
        active: false,
      });
      expect(double.auditLogs).toHaveLength(0);
    });

    it('rejects an unknown spot with NOT_FOUND', async () => {
      await expect(
        spots.deactivate({ id: '11111111-1111-4111-8111-111111111111' }, 'admin-1')
      ).rejects.toBeInstanceOf(DomainError);
    });
  });
});
