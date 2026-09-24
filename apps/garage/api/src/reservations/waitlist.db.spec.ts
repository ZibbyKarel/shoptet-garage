/**
 * Joining and leaving a queue, against a real PostgreSQL 17.
 *
 * The rule that shapes the whole file is that a queue only exists for a spot
 * somebody **already holds**: every refusal below is a different way of the
 * caller not being in that position.
 *
 * Run with `nx run api:test-db`.
 */

import type { PrismaClient, User as UserRow, ParkingSpot as SpotRow } from '@garage/database';
import type { DateOnly } from '@garage/shared-types';
import {
  addDays,
  isBusinessDay,
  monthLockState,
  startOfMonth,
  todayInPrague,
} from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import type { Harness } from '../testing/database/reservation-harness';
import {
  FUTURE_BUSINESS_DAY,
  FUTURE_WEEKEND_DAY,
  TODAY,
  actorFor,
  buildHarness,
  codeOf,
  connect,
  holdTransaction,
  seedSpot,
  seedUser,
  setLockMode,
  waitForBlockedBackend,
} from '../testing/database/reservation-harness';

/**
 * The first bookable day of the month `day` falls in.
 *
 * Used to build a target date that `AUTO` has already locked, from the real
 * clock rather than from a fixture — which is the state the window rule made
 * unleavable. Every month has a business day within its first fortnight, so the
 * scan is bounded rather than open-ended; a month without one would be a bug in
 * `isBusinessDay`, and throwing says so instead of hanging.
 */
function firstBusinessDayOfMonthContaining(day: DateOnly): DateOnly {
  const first = startOfMonth(day);
  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = addDays(first, offset);
    if (isBusinessDay(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No business day in the first fortnight of ${first}.`);
}

describe('the waitlist against a real PostgreSQL', () => {
  let client: PrismaClient;
  let otherClient: PrismaClient;
  let harness: Harness;

  beforeAll(() => {
    client = connect();
    otherClient = connect();
    harness = buildHarness(client);
  });

  afterAll(async () => {
    await Promise.all([client.$disconnect(), otherClient.$disconnect()]);
  });

  beforeEach(async () => {
    harness.publisher.reset();
    await setLockMode(client, 'AUTO');
  });

  /** A spot held by somebody else on {@link FUTURE_BUSINESS_DAY}. */
  async function occupiedSpot(): Promise<{ spot: SpotRow; holder: UserRow }> {
    const [holder, spot] = [await seedUser(client), await seedSpot(client)];
    await harness.reservations.create(
      { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
      actorFor(holder),
      TODAY
    );
    return { spot, holder };
  }

  describe('joining', () => {
    it('queues the caller and reports their position', async () => {
      const { spot } = await occupiedSpot();
      const [first, second] = [await seedUser(client), await seedUser(client)];

      const one = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(first),
        TODAY
      );
      harness.publisher.reset();
      const two = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(second),
        TODAY
      );

      expect(one).toMatchObject({
        position: 1,
        entry: { parkingSpotId: spot.id, userId: first.id, date: FUTURE_BUSINESS_DAY },
      });
      expect(two.position).toBe(2);
      // Joining a queue is audited too, in the same transaction as the entry —
      // the waitlist is a promise about a scarce resource, and Task 30 made
      // bulk booking a second way to get into one (`doc/decision/0091-*`).
      await expect(
        client.auditLog.findMany({
          where: { action: 'WAITLIST_JOINED', entityId: { in: [one.entry.id, two.entry.id] } },
          orderBy: { createdAt: 'asc' },
          select: { actorUserId: true, entityType: true, entityId: true, payload: true },
        })
      ).resolves.toEqual([
        {
          actorUserId: first.id,
          entityType: 'WaitlistEntry',
          entityId: one.entry.id,
          payload: { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        },
        {
          actorUserId: second.id,
          entityType: 'WaitlistEntry',
          entityId: two.entry.id,
          payload: { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        },
      ]);
      expect(harness.publisher.ofKind('waitlist:updated')).toEqual([
        {
          name: 'waitlist:updated',
          payload: { date: FUTURE_BUSINESS_DAY, parkingSpotId: spot.id, waitlistCount: 2 },
        },
      ]);
    });

    it('refuses a free spot — reserve it instead', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];

      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('SPOT_NOT_OCCUPIED');
    });

    it('refuses a spot that only carries guest time blocks, with an accurate message', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];
      await client.timedReservation.create({
        data: {
          parkingSpotId: spot.id,
          date: toDateColumn(FUTURE_BUSINESS_DAY),
          startMinute: 9 * 60,
          endMinute: 10 * 60,
          guestName: 'Guest',
        },
      });

      const joining = harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );

      await expect(codeOf(joining)).resolves.toBe('SPOT_NOT_OCCUPIED');
      await expect(joining).rejects.toMatchObject({
        message: expect.stringContaining('guest time blocks'),
      });
    });

    it('refuses the holder’s own spot', async () => {
      const { spot, holder } = await occupiedSpot();

      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
            actorFor(holder),
            TODAY
          )
        )
      ).resolves.toBe('CANNOT_WAITLIST_OWN_SPOT');
    });

    it('refuses somebody who already has a reservation that day', async () => {
      const { spot } = await occupiedSpot();
      const [user, elsewhere] = [await seedUser(client), await seedSpot(client)];
      await harness.reservations.create(
        { parkingSpotId: elsewhere.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );

      // Not a pedantic rule: a promotion could never be honoured for them, so
      // the queue would accept them and then silently never serve them.
      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('RESERVATION_LIMIT_REACHED');
    });

    it('lets the unique index refuse a second join of the same queue', async () => {
      const { spot } = await occupiedSpot();
      const user = await seedUser(client);
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );

      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('ALREADY_IN_WAITLIST');
    });

    describe('an admin naming somebody else', () => {
      it('adds another user to the queue and audits it as WAITLIST_JOINED_BY_ADMIN', async () => {
        const { spot } = await occupiedSpot();
        const [admin, target] = [await seedUser(client), await seedUser(client)];

        const result = await harness.waitlist.join(
          { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, holderId: target.id },
          actorFor(admin, 'ADMIN'),
          TODAY
        );

        expect(result).toMatchObject({
          position: 1,
          entry: { parkingSpotId: spot.id, userId: target.id, date: FUTURE_BUSINESS_DAY },
        });
        await expect(
          client.auditLog.findFirst({
            where: { action: 'WAITLIST_JOINED_BY_ADMIN', entityId: result.entry.id },
            select: { actorUserId: true, entityType: true, payload: true },
          })
        ).resolves.toEqual({
          actorUserId: admin.id,
          entityType: 'WaitlistEntry',
          payload: { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, targetUserId: target.id },
        });
      });

      it('refuses a normal user naming somebody else', async () => {
        const { spot } = await occupiedSpot();
        const [user, target] = [await seedUser(client), await seedUser(client)];

        await expect(
          codeOf(
            harness.waitlist.join(
              { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, holderId: target.id },
              actorFor(user),
              TODAY
            )
          )
        ).resolves.toBe('FORBIDDEN');
      });

      it("checks the target's own spot, not the admin's, for CANNOT_WAITLIST_OWN_SPOT", async () => {
        const { spot, holder } = await occupiedSpot();
        const admin = await seedUser(client);

        await expect(
          codeOf(
            harness.waitlist.join(
              { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, holderId: holder.id },
              actorFor(admin, 'ADMIN'),
              TODAY
            )
          )
        ).resolves.toBe('CANNOT_WAITLIST_OWN_SPOT');
      });

      it("checks the target's reservation limit, not the admin's", async () => {
        const { spot } = await occupiedSpot();
        const [admin, target, elsewhere] = [
          await seedUser(client),
          await seedUser(client),
          await seedSpot(client),
        ];
        await harness.reservations.create(
          { parkingSpotId: elsewhere.id, date: FUTURE_BUSINESS_DAY },
          actorFor(target),
          TODAY
        );

        await expect(
          codeOf(
            harness.waitlist.join(
              { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, holderId: target.id },
              actorFor(admin, 'ADMIN'),
              TODAY
            )
          )
        ).resolves.toBe('RESERVATION_LIMIT_REACHED');
      });

      it('answers NOT_FOUND for an admin naming an unknown user', async () => {
        const { spot } = await occupiedSpot();
        const admin = await seedUser(client);

        await expect(
          codeOf(
            harness.waitlist.join(
              {
                parkingSpotId: spot.id,
                date: FUTURE_BUSINESS_DAY,
                holderId: '00000000-0000-7000-8000-000000000000',
              },
              actorFor(admin, 'ADMIN'),
              TODAY
            )
          )
        ).resolves.toBe('NOT_FOUND');
      });

      it('still lets an admin queue themselves by name, unchanged', async () => {
        const { spot } = await occupiedSpot();
        const admin = await seedUser(client);

        const result = await harness.waitlist.join(
          { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY, holderId: admin.id },
          actorFor(admin, 'ADMIN'),
          TODAY
        );

        expect(result.entry.userId).toBe(admin.id);
        await expect(
          client.auditLog.findFirst({
            where: { action: 'WAITLIST_JOINED', entityId: result.entry.id },
            select: { actorUserId: true },
          })
        ).resolves.toEqual({ actorUserId: admin.id });
        await expect(
          client.auditLog.findFirst({
            where: { action: 'WAITLIST_JOINED_BY_ADMIN', entityId: result.entry.id },
          })
        ).resolves.toBeNull();
      });
    });

    it('refuses an unknown spot and a weekend', async () => {
      const user = await seedUser(client);
      const { spot } = await occupiedSpot();

      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: '00000000-0000-7000-8000-000000000000', date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('NOT_FOUND');
      await expect(
        codeOf(
          harness.waitlist.join(
            { parkingSpotId: spot.id, date: FUTURE_WEEKEND_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('VALIDATION_FAILED');
    });

    describe('in a locked month', () => {
      it('refuses a normal user and admits an admin', async () => {
        const { spot } = await occupiedSpot();
        const [user, admin] = [await seedUser(client), await seedUser(client)];
        await setLockMode(client, 'FORCE_LOCKED');

        await expect(
          codeOf(
            harness.waitlist.join(
              { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
              actorFor(user),
              TODAY
            )
          )
        ).resolves.toBe('RESERVATIONS_LOCKED');

        const admitted = await harness.waitlist.join(
          { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
          actorFor(admin, 'ADMIN'),
          TODAY
        );
        expect(admitted.position).toBe(1);
      });
    });

    it('sees a cancellation that is in flight, and is told the spot is free', async () => {
      // The reason `join` takes `FOR SHARE` on the reservation row. Without it
      // this call would read the doomed reservation, queue the caller for a spot
      // that is about to become free, and leave them waiting forever.
      const { spot, holder } = await occupiedSpot();
      const latecomer = await seedUser(client);
      const reservation = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        },
      });

      const held = holdTransaction(otherClient, async (tx) => {
        await tx.reservation.delete({ where: { id: reservation.id } });
        await tx.auditLog.create({
          data: {
            actorUserId: holder.id,
            action: 'RESERVATION_CANCELLED',
            entityType: 'Reservation',
            entityId: reservation.id,
            payload: { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
          },
        });
      });
      await held.ready;

      const joining = harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(latecomer),
        TODAY
      );
      await waitForBlockedBackend(client);

      held.release();
      await held.done;

      await expect(codeOf(joining)).resolves.toBe('SPOT_NOT_OCCUPIED');
      expect(
        await client.waitlistEntry.count({
          where: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        })
      ).toBe(0);
    });
  });

  describe('leaving', () => {
    it('removes the entry and announces the shorter queue', async () => {
      const { spot } = await occupiedSpot();
      const [going, staying] = [await seedUser(client), await seedUser(client)];
      const entry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(going),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(staying),
        TODAY
      );
      harness.publisher.reset();

      const result = await harness.waitlist.leave(
        { waitlistEntryId: entry.entry.id },
        actorFor(going)
      );

      expect(result).toEqual({
        waitlistEntryId: entry.entry.id,
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
      });
      expect(await client.waitlistEntry.findUnique({ where: { id: entry.entry.id } })).toBeNull();
      expect(harness.publisher.ofKind('waitlist:updated')[0]?.payload.waitlistCount).toBe(1);
    });

    it('refuses somebody else’s entry, and lets an admin remove it', async () => {
      const { spot } = await occupiedSpot();
      const [queued, stranger, admin] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
      ];
      const entry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(queued),
        TODAY
      );

      await expect(
        codeOf(harness.waitlist.leave({ waitlistEntryId: entry.entry.id }, actorFor(stranger)))
      ).resolves.toBe('FORBIDDEN');

      await harness.waitlist.leave({ waitlistEntryId: entry.entry.id }, actorFor(admin, 'ADMIN'));
      expect(await client.waitlistEntry.findUnique({ where: { id: entry.entry.id } })).toBeNull();
    });

    it('is allowed in the running month under AUTO — the timeline a live queue is promoted in', async () => {
      // The window rule this replaced made leaving impossible for the whole
      // live life of every queue: `monthLockState` used to return `LOCKED`
      // from the 1st of the target month onwards. Since
      // `doc/decision/0315-the-monthly-cap-applies-only-inside-the-auto-window`
      // the running month is `OPEN`, and leaving must work there regardless.
      //
      // Deliberately built from the **real** `todayInPrague()` and `AUTO`:
      // every other fixture in this file uses a `TODAY` in the month *before*
      // its target day, so this timeline would be exercised nowhere else.
      // See `doc/decision/0233-*`.
      const today = todayInPrague();
      const target = firstBusinessDayOfMonthContaining(today);
      // The last day of the window under `AUTO`: they joined then.
      const whileOpen = addDays(startOfMonth(today), -1);

      const settings = await harness.window.getSettings();
      expect(monthLockState(target, settings.openDaysBefore, settings.lockMode, today)).toBe(
        'OPEN'
      );
      expect(monthLockState(target, settings.openDaysBefore, settings.lockMode, whileOpen)).toBe(
        'OPEN'
      );

      const [holder, user, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      await harness.reservations.create(
        { parkingSpotId: spot.id, date: target },
        actorFor(holder),
        whileOpen
      );
      const entry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: target },
        actorFor(user),
        whileOpen
      );
      harness.publisher.reset();

      // No `today` argument: `leave` does not take one any more, so this runs
      // against the running month the real clock is in.
      const result = await harness.waitlist.leave(
        { waitlistEntryId: entry.entry.id },
        actorFor(user)
      );

      expect(result).toEqual({
        waitlistEntryId: entry.entry.id,
        parkingSpotId: spot.id,
        date: target,
      });
      expect(await client.waitlistEntry.findUnique({ where: { id: entry.entry.id } })).toBeNull();
      expect(harness.publisher.ofKind('waitlist:updated')).toEqual([
        {
          name: 'waitlist:updated',
          payload: { date: target, parkingSpotId: spot.id, waitlistCount: 0 },
        },
      ]);
    });

    it('answers NOT_FOUND for an entry a promotion already consumed', async () => {
      const { spot, holder } = await occupiedSpot();
      const waiter = await seedUser(client);
      const entry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(waiter),
        TODAY
      );
      const reservation = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        },
      });
      await harness.reservations.cancel({ reservationId: reservation.id }, actorFor(holder));

      // The truth, and the right thing to tell them: they were promoted rather
      // than left waiting.
      await expect(
        codeOf(harness.waitlist.leave({ waitlistEntryId: entry.entry.id }, actorFor(waiter)))
      ).resolves.toBe('NOT_FOUND');
    });
  });
});
