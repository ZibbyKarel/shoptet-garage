import { AuditLogService } from './audit-log.service';
import { PrismaDouble } from '../testing/prisma-double';

describe('AuditLogService', () => {
  let double: PrismaDouble;
  let audit: AuditLogService;

  beforeEach(() => {
    double = new PrismaDouble();
    audit = new AuditLogService(double.asPrismaService());
  });

  it('appends the entry it was given, field for field', async () => {
    await audit.record({
      actorUserId: 'actor-1',
      action: 'SPOT_UPDATED',
      entityType: 'ParkingSpot',
      entityId: 'spot-1',
      payload: { change: 'created', label: 'E2.92', group: 'IT', evCharger: false },
    });

    expect(double.auditLogs).toHaveLength(1);
    expect(double.auditLogs[0]).toMatchObject({
      actorUserId: 'actor-1',
      action: 'SPOT_UPDATED',
      entityType: 'ParkingSpot',
      entityId: 'spot-1',
      payload: { change: 'created', label: 'E2.92', group: 'IT', evCharger: false },
    });
  });

  it('appends rather than replaces — the log is a history, not a latest-value', async () => {
    await audit.record({
      actorUserId: 'actor-1',
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: 'user-1',
      payload: { change: 'ics-token-regenerated', attempt: 1 },
    });
    await audit.record({
      actorUserId: 'actor-1',
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: 'user-1',
      payload: { change: 'ics-token-regenerated', attempt: 2 },
    });

    expect(double.auditLogs.map((row) => row.payload)).toEqual([
      { change: 'ics-token-regenerated', attempt: 1 },
      { change: 'ics-token-regenerated', attempt: 2 },
    ]);
  });

  it('writes through the client it is handed, so a caller in a transaction stays in it', async () => {
    // Task 13 passes the `$transaction` client so the entry rolls back with the
    // change it describes. Modelled here as a second, separate store: if `record`
    // ignored its `writer` argument the row would land in the default one.
    const transaction = new PrismaDouble();

    await audit.record(
      {
        actorUserId: 'actor-1',
        action: 'RESERVATION_CANCELLED',
        entityType: 'Reservation',
        entityId: 'reservation-1',
        payload: { parkingSpotId: 'spot-1', date: '2026-03-02', holderUserId: 'user-1' },
      },
      transaction.asPrismaService().client
    );

    expect(transaction.auditLogs).toHaveLength(1);
    expect(double.auditLogs).toHaveLength(0);
  });

  describe('recordMany', () => {
    // `recordMany` exists for `reservation.confirmBulk`, which can write 31
    // reservations inside one transaction that is already holding uncommitted
    // unique keys. One statement instead of 31 round trips is the entire point,
    // so "how many statements" is what these assert — not just "the rows landed".

    it('appends every entry, field for field, in the order given', async () => {
      await audit.recordMany([
        {
          actorUserId: 'actor-1',
          action: 'RESERVATION_CREATED',
          entityType: 'Reservation',
          entityId: 'reservation-1',
          payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
        },
        {
          actorUserId: 'actor-1',
          action: 'WAITLIST_JOINED',
          entityType: 'WaitlistEntry',
          entityId: 'queue-1',
          payload: { parkingSpotId: 'spot-1', date: '2026-03-03' },
        },
      ]);

      expect(double.auditLogs).toEqual([
        expect.objectContaining({
          actorUserId: 'actor-1',
          action: 'RESERVATION_CREATED',
          entityType: 'Reservation',
          entityId: 'reservation-1',
          payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
        }),
        expect.objectContaining({
          actorUserId: 'actor-1',
          action: 'WAITLIST_JOINED',
          entityType: 'WaitlistEntry',
          entityId: 'queue-1',
          payload: { parkingSpotId: 'spot-1', date: '2026-03-03' },
        }),
      ]);
    });

    it('writes them in one statement, which is the only reason it exists', async () => {
      await audit.recordMany(
        Array.from({ length: 5 }, (_unused, index) => ({
          actorUserId: 'actor-1',
          action: 'RESERVATION_CREATED' as const,
          entityType: 'Reservation' as const,
          entityId: `reservation-${index}`,
          payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
        }))
      );

      expect(double.auditLogs).toHaveLength(5);
      expect(double.auditLogCreateManyCalls).toBe(1);
    });

    it('issues no statement at all for an empty list', async () => {
      await audit.recordMany([]);

      // Not merely "wrote no rows": a `createMany` with an empty array is a
      // round trip inside a transaction holding locks, and the guard in
      // `recordMany` is there to skip it.
      expect(double.auditLogCreateManyCalls).toBe(0);
      expect(double.auditLogs).toHaveLength(0);
    });

    it('writes through the client it is handed, so a caller in a transaction stays in it', async () => {
      const transaction = new PrismaDouble();

      await audit.recordMany(
        [
          {
            actorUserId: 'actor-1',
            action: 'RESERVATION_CREATED',
            entityType: 'Reservation',
            entityId: 'reservation-1',
            payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
          },
        ],
        transaction.asPrismaService().client
      );

      expect(transaction.auditLogs).toHaveLength(1);
      expect(double.auditLogs).toHaveLength(0);
    });
  });

  describe('the entry type', () => {
    // The invariant these pin is a compile-time one, so the assertion is the
    // `@ts-expect-error` itself: it fails the build when the line it guards
    // starts compiling. Each `record` call is awaited so a legal one is also
    // shown to still run — a union that forbids everything would pass a
    // negative-only test.

    it('refuses a payload from another action', async () => {
      await audit.record({
        actorUserId: 'actor-1',
        action: 'WAITLIST_JOINED',
        entityType: 'WaitlistEntry',
        entityId: 'queue-1',
        payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
      });

      await audit.record({
        actorUserId: 'actor-1',
        action: 'WAITLIST_JOINED',
        entityType: 'WaitlistEntry',
        entityId: 'queue-1',
        // @ts-expect-error a `SPOT_UPDATED` payload cannot describe a queue entry
        payload: { change: 'deactivated', label: 'E2.92' },
      });

      expect(double.auditLogs).toHaveLength(2);
    });

    it('refuses an entity kind the action does not name', async () => {
      // @ts-expect-error `WAITLIST_PROMOTED` names the reservation it produced,
      // so `entityType: 'WaitlistEntry'` is unrepresentable. TypeScript reports
      // a rejected member on the argument rather than on the offending key.
      await audit.record({
        actorUserId: 'actor-1',
        action: 'WAITLIST_PROMOTED',
        entityType: 'WaitlistEntry',
        entityId: 'reservation-1',
        payload: {
          parkingSpotId: 'spot-1',
          date: '2026-03-02',
          promotedUserId: 'user-2',
          fromWaitlistEntryId: 'queue-1',
          queueLength: 3,
        },
      });

      expect(double.auditLogs).toHaveLength(1);
    });

    it('refuses a payload that is missing a key the action promises', async () => {
      // @ts-expect-error `holderUserId` is what makes a cancellation
      // accountable, and it is not optional.
      await audit.record({
        actorUserId: 'actor-1',
        action: 'RESERVATION_CANCELLED',
        entityType: 'Reservation',
        entityId: 'reservation-1',
        payload: { parkingSpotId: 'spot-1', date: '2026-03-02' },
      });

      expect(double.auditLogs).toHaveLength(1);
    });
  });

  it('exposes no way to change or remove an entry', () => {
    // The real guarantee is a pair of database triggers (`doc/decision/0027-*`);
    // this only pins that the service does not offer a shortcut past them.
    const methods = Object.getOwnPropertyNames(AuditLogService.prototype).filter(
      (name) => name !== 'constructor'
    );

    expect(methods).toEqual(['record', 'recordMany']);
  });
});
