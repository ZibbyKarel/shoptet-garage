/**
 * Reservations, cancellation and auto-promotion — against a real PostgreSQL 17.
 *
 * The sequential half of Task 13's integration suite: the rules, the audit
 * trail, the window, and promotion when nothing else is happening at the same
 * time. The races live in `waitlist-concurrency.db.spec.ts`.
 *
 * Everything here runs against a database created for this run and dropped
 * afterwards (`src/testing/database/test-database.ts`), because promotion writes
 * an `AuditLog` row and `AuditLog` cannot be cleaned up — it rejects `DELETE` by
 * trigger.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 */

import type { PrismaClient } from '@garage/database';
import { addDays, isBusinessDay, type DateOnly } from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import type { Harness } from '../testing/database/reservation-harness';
import {
  FUTURE_BUSINESS_DAY,
  FUTURE_WEEKEND_DAY,
  NEXT_BUSINESS_DAY,
  TODAY,
  actorFor,
  buildHarness,
  codeOf,
  connect,
  seedSpot,
  seedUser,
  setLockMode,
} from '../testing/database/reservation-harness';

function businessDaysInMonth(start: DateOnly, count: number): DateOnly[] {
  const month = start.slice(0, 7);
  const dates: DateOnly[] = [];
  let cursor = start;
  while (dates.length < count) {
    if (cursor.slice(0, 7) !== month) {
      throw new Error(
        `ran out of business days in ${month} — widen the search or pick a later start`
      );
    }
    if (isBusinessDay(cursor)) {
      dates.push(cursor);
    }
    cursor = addDays(cursor, 1);
  }
  return dates;
}

describe('reservations against a real PostgreSQL', () => {
  let client: PrismaClient;
  let harness: Harness;

  beforeAll(() => {
    client = connect();
    harness = buildHarness(client);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  beforeEach(async () => {
    harness.publisher.reset();
    await setLockMode(client, 'AUTO');
  });

  it('uses fixture dates that mean what the cases below assume', () => {
    // Without this, "rejected for the weekend" and "rejected for the window"
    // would be indistinguishable, and every assertion below would still pass.
    expect(isBusinessDay(FUTURE_BUSINESS_DAY)).toBe(true);
    expect(isBusinessDay(NEXT_BUSINESS_DAY)).toBe(true);
    expect(isBusinessDay(FUTURE_WEEKEND_DAY)).toBe(false);
  });

  describe('creating a reservation', () => {
    it('writes the row, the audit entry and one broadcast', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];

      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );

      expect(reservation).toMatchObject({
        parkingSpotId: spot.id,
        userId: user.id,
        date: FUTURE_BUSINESS_DAY,
      });

      // The `@db.Date` round trip, against a real column: what went in as
      // `YYYY-MM-DD` comes back as the same calendar day, not a day either side
      // of it. This is the claim `prisma-mapping.ts` could not exercise before.
      const stored = await client.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(stored.date.toISOString()).toBe(`${FUTURE_BUSINESS_DAY}T00:00:00.000Z`);

      const audit = await client.auditLog.findMany({ where: { entityId: reservation.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'RESERVATION_CREATED', actorUserId: user.id });

      expect(harness.publisher.ofKind('reservation:created')).toEqual([
        {
          name: 'reservation:created',
          payload: {
            date: FUTURE_BUSINESS_DAY,
            parkingSpotId: spot.id,
            reservation: {
              id: reservation.id,
              createdAt: reservation.createdAt,
              holder: { kind: 'USER', userId: user.id, name: user.name, licensePlate: null },
            },
          },
        },
      ]);
    });

    it('refuses an unknown spot, and a retired one, with NOT_FOUND', async () => {
      const user = await seedUser(client);
      const retired = await seedSpot(client);
      await client.parkingSpot.update({ where: { id: retired.id }, data: { active: false } });

      await expect(
        codeOf(
          harness.reservations.create(
            { parkingSpotId: '00000000-0000-7000-8000-000000000000', date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('NOT_FOUND');

      await expect(
        codeOf(
          harness.reservations.create(
            { parkingSpotId: retired.id, date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('NOT_FOUND');
    });

    it('refuses a weekend', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];

      await expect(
        codeOf(
          harness.reservations.create(
            { parkingSpotId: spot.id, date: FUTURE_WEEKEND_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('VALIDATION_FAILED');
    });

    it('lets the unique index, not a pre-check, enforce one spot per day', async () => {
      const [holder, other, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );

      // `SPOT_ALREADY_RESERVED` — and it arriving here at all is the point.
      // `meta.target` does not exist on this driver, so this code can only be
      // produced by the driver-adapter fallback in `mapUniqueConstraintViolation`.
      await expect(
        codeOf(
          harness.reservations.create(
            { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
            actorFor(other),
            TODAY
          )
        )
      ).resolves.toBe('SPOT_ALREADY_RESERVED');
    });

    it('lets the unique index enforce one reservation per person per day', async () => {
      const [user, first, second] = [
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      await harness.reservations.create(
        { parkingSpotId: first.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );

      await expect(
        codeOf(
          harness.reservations.create(
            { parkingSpotId: second.id, date: FUTURE_BUSINESS_DAY },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('RESERVATION_LIMIT_REACHED');
    });

    describe('in a locked month', () => {
      beforeEach(() => setLockMode(client, 'FORCE_LOCKED'));

      it('refuses a normal user with RESERVATIONS_LOCKED', async () => {
        const [user, spot] = [await seedUser(client), await seedSpot(client)];

        await expect(
          codeOf(
            harness.reservations.create(
              { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
              actorFor(user),
              TODAY
            )
          )
        ).resolves.toBe('RESERVATIONS_LOCKED');

        expect(
          await client.reservation.count({
            where: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
          })
        ).toBe(0);
      });

      it('lets an admin through — the window does not apply to them at all', async () => {
        const [admin, spot] = [await seedUser(client), await seedSpot(client)];

        const reservation = await harness.reservations.create(
          { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
          actorFor(admin, 'ADMIN'),
          TODAY
        );

        expect(reservation.parkingSpotId).toBe(spot.id);
      });
    });

    it('lets an admin book for another user, with an overriding plate', async () => {
      const [admin, target, spot] = [
        await seedUser(client),
        await seedUser(client, { name: 'Jana Nováková', licensePlate: '1AB 2345' }),
        await seedSpot(client),
      ];

      const reservation = await harness.reservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'USER', userId: target.id, licensePlate: '9XY 8765' },
        },
        // `actorFor(admin)` would be a USER and would get FORBIDDEN — the
        // second argument is what makes this an admin.
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      expect(reservation).toMatchObject({
        userId: target.id,
        guestName: null,
        licensePlate: '9XY 8765',
      });

      // The plate override reaches the broadcast; the target's stored plate does not.
      expect(harness.publisher.ofKind('reservation:created')[0]?.payload).toMatchObject({
        reservation: {
          holder: {
            kind: 'USER',
            userId: target.id,
            name: 'Jana Nováková',
            licensePlate: '9XY 8765',
          },
        },
      });

      // The trail says who did it and for whom — not `RESERVATION_CREATED`.
      const entries = await client.auditLog.findMany({ where: { entityId: reservation.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'RESERVATION_CREATED_BY_ADMIN',
        actorUserId: admin.id,
      });
      expect(entries[0]?.payload).toMatchObject({ holderUserId: target.id, guestName: null });
    });

    it('lets an admin book for a guest, who has no user row', async () => {
      const [admin, spot] = [await seedUser(client), await seedSpot(client)];

      const reservation = await harness.reservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: '9XY 8765' },
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      expect(reservation).toMatchObject({
        userId: null,
        guestName: 'Jan Host',
        licensePlate: '9XY 8765',
      });
      expect(harness.publisher.ofKind('reservation:created')[0]?.payload).toMatchObject({
        reservation: { holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: '9XY 8765' } },
      });
      expect(
        (await client.auditLog.findMany({ where: { entityId: reservation.id } }))[0]?.payload
      ).toMatchObject({ holderUserId: null, guestName: 'Jan Host' });
    });

    it('lets several guests park on the same day, on different bays', async () => {
      // `(userId, date)` is one reservation per *user* per day; NULLs do not
      // collide, so it deliberately does not limit guests (`decision 0303`).
      const [admin, one, two] = [
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      const actor = actorFor(admin, 'ADMIN');

      await harness.reservations.create(
        {
          parkingSpotId: one.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: null },
        },
        actor,
        TODAY
      );
      await expect(
        harness.reservations.create(
          {
            parkingSpotId: two.id,
            date: FUTURE_BUSINESS_DAY,
            holder: { kind: 'GUEST', name: 'Eva Hostová', licensePlate: null },
          },
          actor,
          TODAY
        )
      ).resolves.toMatchObject({ guestName: 'Eva Hostová' });
    });

    it('audits an admin booking for THEMSELVES as an ordinary creation', async () => {
      const [admin, spot] = [await seedUser(client), await seedSpot(client)];

      const reservation = await harness.reservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'USER', userId: admin.id, licensePlate: null },
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      expect(
        (await client.auditLog.findMany({ where: { entityId: reservation.id } }))[0]
      ).toMatchObject({ action: 'RESERVATION_CREATED' });
    });

    it('A NON-ADMIN CANNOT book for another user', async () => {
      const [alice, bob, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];

      await expect(
        codeOf(
          harness.reservations.create(
            {
              parkingSpotId: spot.id,
              date: FUTURE_BUSINESS_DAY,
              holder: { kind: 'USER', userId: bob.id, licensePlate: null },
            },
            // No second argument, deliberately: `actorFor` defaults to `'USER'`,
            // and that default is what this case is testing.
            actorFor(alice),
            TODAY
          )
        )
      ).resolves.toBe('FORBIDDEN');

      expect(await client.reservation.count({ where: { parkingSpotId: spot.id } })).toBe(0);
    });

    it('A NON-ADMIN CANNOT book for a guest', async () => {
      const [alice, spot] = [await seedUser(client), await seedSpot(client)];

      await expect(
        codeOf(
          harness.reservations.create(
            {
              parkingSpotId: spot.id,
              date: FUTURE_BUSINESS_DAY,
              holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: null },
            },
            actorFor(alice),
            TODAY
          )
        )
      ).resolves.toBe('FORBIDDEN');

      expect(await client.reservation.count({ where: { parkingSpotId: spot.id } })).toBe(0);
    });

    it('refuses an admin naming a user who does not exist, with NOT_FOUND', async () => {
      const [admin, spot] = [await seedUser(client), await seedSpot(client)];

      await expect(
        codeOf(
          harness.reservations.create(
            {
              parkingSpotId: spot.id,
              date: FUTURE_BUSINESS_DAY,
              holder: {
                kind: 'USER',
                userId: '99999999-9999-4999-8999-999999999999',
                licensePlate: null,
              },
            },
            actorFor(admin, 'ADMIN'),
            TODAY
          )
        )
      ).resolves.toBe('NOT_FOUND');
    });

    it('refuses an admin naming a deactivated user, with NOT_FOUND', async () => {
      const [admin, target, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      await client.user.update({ where: { id: target.id }, data: { active: false } });
      // The filter this test pins is `active: true` — assert the row is
      // actually inactive, or a passing test below proves nothing.
      expect((await client.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(
        false
      );

      await expect(
        codeOf(
          harness.reservations.create(
            {
              parkingSpotId: spot.id,
              date: FUTURE_BUSINESS_DAY,
              holder: { kind: 'USER', userId: target.id, licensePlate: null },
            },
            actorFor(admin, 'ADMIN'),
            TODAY
          )
        )
      ).resolves.toBe('NOT_FOUND');

      expect(await client.reservation.count({ where: { parkingSpotId: spot.id } })).toBe(0);
    });

    it('refuses an admin naming a user who already holds a bay that day, with RESERVATION_LIMIT_REACHED', async () => {
      const [admin, target, first, second] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      await harness.reservations.create(
        { parkingSpotId: first.id, date: FUTURE_BUSINESS_DAY },
        actorFor(target),
        TODAY
      );

      await expect(
        codeOf(
          harness.reservations.create(
            {
              parkingSpotId: second.id,
              date: FUTURE_BUSINESS_DAY,
              holder: { kind: 'USER', userId: target.id, licensePlate: null },
            },
            actorFor(admin, 'ADMIN'),
            TODAY
          )
        )
      ).resolves.toBe('RESERVATION_LIMIT_REACHED');

      expect(await client.reservation.count({ where: { parkingSpotId: second.id } })).toBe(0);
    });

    it('rejects the 6th reservation in a calendar month with MONTHLY_RESERVATION_LIMIT_REACHED', async () => {
      const user = await seedUser(client);
      const spots = await Promise.all(Array.from({ length: 6 }, () => seedSpot(client)));
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);

      for (let i = 0; i < 5; i++) {
        const spot = spots[i];
        const date = dates[i];
        if (spot === undefined || date === undefined) {
          throw new Error('unreachable: fixed-length arrays covered by the loop bound');
        }
        await harness.reservations.create({ parkingSpotId: spot.id, date }, actorFor(user), TODAY);
      }

      const sixthSpot = spots[5];
      const sixthDate = dates[5];
      if (sixthSpot === undefined || sixthDate === undefined) {
        throw new Error('unreachable: both arrays were seeded/generated with length 6');
      }

      const code = await codeOf(
        harness.reservations.create(
          { parkingSpotId: sixthSpot.id, date: sixthDate },
          actorFor(user),
          TODAY
        )
      );
      expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');

      // The 6th spot was not silently reserved.
      const stillFree = await client.reservation.findFirst({
        where: { parkingSpotId: sixthSpot.id },
      });
      expect(stillFree).toBeNull();
    });

    it('does not cap a user once the month is running under AUTO', async () => {
      const user = await seedUser(client);
      const spots = await Promise.all(Array.from({ length: 6 }, () => seedSpot(client)));
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);
      // "Today" is the first of those days: January 2099 has begun, its
      // window is over, and the cap with it.
      const runningMonthToday = FUTURE_BUSINESS_DAY;

      for (const [i, date] of dates.entries()) {
        const spot = spots[i];
        if (spot === undefined) {
          throw new Error('unreachable: six spots for six dates');
        }
        await harness.reservations.create(
          { parkingSpotId: spot.id, date },
          actorFor(user),
          runningMonthToday
        );
      }

      expect(await client.reservation.count({ where: { userId: user.id } })).toBe(6);
    });

    it('does not cap a user under FORCE_OPEN', async () => {
      await setLockMode(client, 'FORCE_OPEN');
      const user = await seedUser(client);
      const spots = await Promise.all(Array.from({ length: 6 }, () => seedSpot(client)));
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);

      for (const [i, date] of dates.entries()) {
        const spot = spots[i];
        if (spot === undefined) {
          throw new Error('unreachable: six spots for six dates');
        }
        await harness.reservations.create({ parkingSpotId: spot.id, date }, actorFor(user), TODAY);
      }

      expect(await client.reservation.count({ where: { userId: user.id } })).toBe(6);
    });

    it('does not cap a guest reservation, which has no userId', async () => {
      const admin = await seedUser(client);
      const spots = await Promise.all(Array.from({ length: 6 }, () => seedSpot(client)));
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);
      const adminActor = actorFor(admin, 'ADMIN');

      for (let i = 0; i < 5; i++) {
        const spot = spots[i];
        const date = dates[i];
        if (spot === undefined || date === undefined) {
          throw new Error('unreachable: fixed-length arrays covered by the loop bound');
        }
        await harness.reservations.create(
          {
            parkingSpotId: spot.id,
            date,
            holder: { kind: 'GUEST', name: 'Guest', licensePlate: null },
          },
          adminActor,
          TODAY
        );
      }

      const sixthSpot = spots[5];
      const sixthDate = dates[5];
      if (sixthSpot === undefined || sixthDate === undefined) {
        throw new Error('unreachable: both arrays were seeded/generated with length 6');
      }

      const reservation = await harness.reservations.create(
        {
          parkingSpotId: sixthSpot.id,
          date: sixthDate,
          holder: { kind: 'GUEST', name: 'Guest', licensePlate: null },
        },
        adminActor,
        TODAY
      );
      expect(reservation.parkingSpotId).toBe(sixthSpot.id);
    });
  });

  describe('cancelling', () => {
    it('hard-deletes the row and leaves the audit entry behind', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );
      harness.publisher.reset();

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(user)
      );

      expect(result).toEqual({
        reservationId: reservation.id,
        date: FUTURE_BUSINESS_DAY,
        parkingSpotId: spot.id,
        promoted: false,
      });
      expect(await client.reservation.findUnique({ where: { id: reservation.id } })).toBeNull();

      const audit = await client.auditLog.findMany({
        where: { entityId: reservation.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual([
        'RESERVATION_CREATED',
        'RESERVATION_CANCELLED',
      ]);
    });

    it('refuses somebody else’s reservation, and lets an admin take it', async () => {
      const [holder, stranger, admin, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );

      await expect(
        codeOf(harness.reservations.cancel({ reservationId: reservation.id }, actorFor(stranger)))
      ).resolves.toBe('FORBIDDEN');

      await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(admin, 'ADMIN')
      );

      const audit = await client.auditLog.findMany({ where: { entityId: reservation.id } });
      expect(audit.map((row) => row.action)).toContain('RESERVATION_CANCELLED_BY_ADMIN');
      expect(
        audit.find((row) => row.action === 'RESERVATION_CANCELLED_BY_ADMIN')?.actorUserId
      ).toBe(admin.id);
    });

    it('is allowed in a locked month — a closed window stops taking, not giving back', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );
      await setLockMode(client, 'FORCE_LOCKED');

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(user)
      );

      expect(result.promoted).toBe(false);
      expect(await client.reservation.findUnique({ where: { id: reservation.id } })).toBeNull();
    });

    it('answers NOT_FOUND for a reservation that is already gone', async () => {
      const user = await seedUser(client);

      await expect(
        codeOf(
          harness.reservations.cancel(
            { reservationId: '00000000-0000-7000-8000-000000000000' },
            actorFor(user)
          )
        )
      ).resolves.toBe('NOT_FOUND');
    });

    it('lets an admin cancel a guest reservation, and nobody else', async () => {
      const [admin, alice, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const adminActor = actorFor(admin, 'ADMIN');
      const reservation = await harness.reservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          holder: { kind: 'GUEST', name: 'Jan Host', licensePlate: null },
        },
        adminActor,
        TODAY
      );

      // A guest reservation has no holder user, so `userId === actor.id` is
      // false for everybody: only the admin branch can cancel it.
      await expect(
        codeOf(harness.reservations.cancel({ reservationId: reservation.id }, actorFor(alice)))
      ).resolves.toBe('FORBIDDEN');

      await expect(
        harness.reservations.cancel({ reservationId: reservation.id }, adminActor)
      ).resolves.toMatchObject({ promoted: false });
    });
  });

  describe('auto-promotion', () => {
    it('leaves the spot free when nobody is queued', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(user),
        TODAY
      );
      harness.publisher.reset();

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(user)
      );

      expect(result.promoted).toBe(false);
      expect(
        await client.reservation.count({
          where: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        })
      ).toBe(0);

      // One committed transaction, one event about the cell — and `cancelled`,
      // not `reassigned`.
      expect(harness.publisher.events.map((event) => event.name)).toEqual([
        'reservation:cancelled',
      ]);
      expect(harness.publisher.notices).toEqual([]);
    });

    it('promotes the head of the queue and clears their other queues that day', async () => {
      const [holder, first, second, spot, otherSpot] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );
      // A second occupied spot, so `first` can legitimately be queued for both.
      const otherHolder = await seedUser(client);
      await harness.reservations.create(
        { parkingSpotId: otherSpot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(otherHolder),
        TODAY
      );

      const firstEntry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(first),
        TODAY
      );
      const secondEntry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(second),
        TODAY
      );
      const elsewhere = await harness.waitlist.join(
        { parkingSpotId: otherSpot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(first),
        TODAY
      );
      // Also queued for another *day*, which must survive.
      const nextDayHolder = await seedUser(client);
      await harness.reservations.create(
        { parkingSpotId: spot.id, date: NEXT_BUSINESS_DAY },
        actorFor(nextDayHolder),
        TODAY
      );
      const nextDay = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: NEXT_BUSINESS_DAY },
        actorFor(first),
        TODAY
      );
      expect([firstEntry.position, secondEntry.position]).toEqual([1, 2]);
      harness.publisher.reset();

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder)
      );

      expect(result.promoted).toBe(true);
      const promoted = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: {
            parkingSpotId: spot.id,
            date: toDateColumn(FUTURE_BUSINESS_DAY),
          },
        },
      });
      expect(promoted.userId).toBe(first.id);

      // Their queue entries for **that day** are gone, both of them…
      expect(
        await client.waitlistEntry.findUnique({ where: { id: firstEntry.entry.id } })
      ).toBeNull();
      expect(
        await client.waitlistEntry.findUnique({ where: { id: elsewhere.entry.id } })
      ).toBeNull();
      // …and nobody else's are, nor their own on another day.
      expect(
        await client.waitlistEntry.findUnique({ where: { id: secondEntry.entry.id } })
      ).not.toBeNull();
      expect(
        await client.waitlistEntry.findUnique({ where: { id: nextDay.entry.id } })
      ).not.toBeNull();

      const audit = await client.auditLog.findMany({ where: { entityId: promoted.id } });
      expect(audit.map((row) => row.action)).toEqual(['WAITLIST_PROMOTED']);
      // Attributed to whoever's request caused it — there is no system user row.
      expect(audit[0]?.actorUserId).toBe(holder.id);

      // Three events, not two: the promotion emptied `first`'s queue on
      // `otherSpot` as well, and a queue that got shorter and told nobody leaves
      // that cell's badge reading "1 waiting" on every open day view until an
      // unrelated event forces a refetch (`doc/decision/0234-*`).
      expect(harness.publisher.events.map((event) => event.name)).toEqual([
        'reservation:reassigned',
        'waitlist:updated',
        'waitlist:updated',
      ]);
      expect(harness.publisher.ofKind('reservation:reassigned')[0]?.payload).toMatchObject({
        cause: 'WAITLIST_PROMOTION',
        previousReservationId: reservation.id,
        fromWaitlistEntryId: firstEntry.entry.id,
        reservation: { id: promoted.id, holder: { kind: 'USER', userId: first.id } },
      });
      expect(harness.publisher.ofKind('waitlist:updated').map((event) => event.payload)).toEqual([
        { date: FUTURE_BUSINESS_DAY, parkingSpotId: spot.id, waitlistCount: 1 },
        { date: FUTURE_BUSINESS_DAY, parkingSpotId: otherSpot.id, waitlistCount: 0 },
      ]);
      expect(harness.publisher.notices).toEqual([
        {
          userId: first.id,
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          reservationId: promoted.id,
        },
      ]);
    });

    it('skips a waiter who already holds a reservation that day, and keeps their entry', async () => {
      const [holder, blocked, next, spot, elsewhere] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );
      const blockedEntry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(blocked),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(next),
        TODAY
      );
      // `blocked` is first in line, but gets a spot of their own in the meantime.
      await harness.reservations.create(
        { parkingSpotId: elsewhere.id, date: FUTURE_BUSINESS_DAY },
        actorFor(blocked),
        TODAY
      );

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder)
      );

      expect(result.promoted).toBe(true);
      const promoted = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        },
      });
      expect(promoted.userId).toBe(next.id);

      // Left in place on purpose: they are still legitimately waiting for *this*
      // spot in case the reservation they hold elsewhere goes away.
      expect(
        await client.waitlistEntry.findUnique({ where: { id: blockedEntry.entry.id } })
      ).not.toBeNull();
    });

    it('skips a waiter who is at the monthly cap and promotes the next person in the queue', async () => {
      const [holder, capped, next, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);
      const otherSpots = await Promise.all(Array.from({ length: 5 }, () => seedSpot(client)));
      const targetDate = dates[0];
      if (targetDate === undefined) {
        throw new Error('unreachable: businessDaysInMonth(FUTURE_BUSINESS_DAY, 6) has 6 entries');
      }

      // `capped` already holds 5 reservations elsewhere this month — no budget left.
      for (let i = 1; i <= 5; i++) {
        const otherSpot = otherSpots[i - 1];
        const date = dates[i];
        if (otherSpot === undefined || date === undefined) {
          throw new Error('unreachable: fixed-length arrays covered by the loop bound');
        }
        await client.reservation.create({
          data: { parkingSpotId: otherSpot.id, userId: capped.id, date: toDateColumn(date) },
        });
      }

      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: targetDate },
        actorFor(holder),
        TODAY
      );
      const cappedEntry = await harness.waitlist.join(
        { parkingSpotId: spot.id, date: targetDate },
        actorFor(capped),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: targetDate },
        actorFor(next),
        TODAY
      );

      // `TODAY` is inside January 2099's window, where the cap applies.
      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder),
        TODAY
      );

      expect(result.promoted).toBe(true);
      const promoted = await client.reservation.findUniqueOrThrow({
        where: { parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(targetDate) } },
      });
      expect(promoted.userId).toBe(next.id);

      // Left in place: `capped` is still legitimately waiting for this spot in
      // case one of their other reservations this month is cancelled.
      expect(
        await client.waitlistEntry.findUnique({ where: { id: cappedEntry.entry.id } })
      ).not.toBeNull();
    });

    it('promotes a waiter who is over the cap once the month is running', async () => {
      const [holder, capped, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const dates = businessDaysInMonth(FUTURE_BUSINESS_DAY, 6);
      const otherSpots = await Promise.all(Array.from({ length: 5 }, () => seedSpot(client)));
      const targetDate = dates[0];
      if (targetDate === undefined) {
        throw new Error('unreachable: businessDaysInMonth(FUTURE_BUSINESS_DAY, 6) has 6 entries');
      }

      // `capped` already holds 5 reservations elsewhere this month.
      for (let i = 1; i <= 5; i++) {
        const otherSpot = otherSpots[i - 1];
        const date = dates[i];
        if (otherSpot === undefined || date === undefined) {
          throw new Error('unreachable: fixed-length arrays covered by the loop bound');
        }
        await client.reservation.create({
          data: { parkingSpotId: otherSpot.id, userId: capped.id, date: toDateColumn(date) },
        });
      }

      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: targetDate },
        actorFor(holder),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: targetDate },
        actorFor(capped),
        TODAY
      );

      // The spot is given back on the day itself: the month is running.
      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder),
        targetDate
      );

      expect(result.promoted).toBe(true);
      const promoted = await client.reservation.findUniqueOrThrow({
        where: { parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(targetDate) } },
      });
      expect(promoted.userId).toBe(capped.id);
    });

    it('leaves the spot free when every waiter is blocked', async () => {
      const [holder, blocked, spot, elsewhere] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(blocked),
        TODAY
      );
      await harness.reservations.create(
        { parkingSpotId: elsewhere.id, date: FUTURE_BUSINESS_DAY },
        actorFor(blocked),
        TODAY
      );

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder)
      );

      expect(result.promoted).toBe(false);
      expect(
        await client.reservation.count({
          where: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        })
      ).toBe(0);
    });

    it('promotes in a locked month — auto-promotion is a system action', async () => {
      const [holder, waiter, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(waiter),
        TODAY
      );
      await setLockMode(client, 'FORCE_LOCKED');

      const result = await harness.reservations.cancel(
        { reservationId: reservation.id },
        actorFor(holder)
      );

      expect(result.promoted).toBe(true);
      const promoted = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: { parkingSpotId: spot.id, date: toDateColumn(FUTURE_BUSINESS_DAY) },
        },
      });
      expect(promoted.userId).toBe(waiter.id);
    });
  });

  describe('the after-commit seam', () => {
    it('publishes only once the transaction has committed', async () => {
      const [holder, waiter, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const reservation = await harness.reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(waiter),
        TODAY
      );
      harness.publisher.reset();

      // A **second connection**, which by definition cannot see uncommitted
      // rows. If `publish` ran inside the transaction, this observer would find
      // the old reservation still there and the promotion missing.
      const observer = connect();
      const seen: { oldStillThere: boolean; promotedVisible: boolean }[] = [];
      let probe: Promise<void> = Promise.resolve();
      harness.publisher.onPublish = () => {
        probe = (async () => {
          const old = await observer.reservation.findUnique({ where: { id: reservation.id } });
          const current = await observer.reservation.findUnique({
            where: {
              parkingSpotId_date: {
                parkingSpotId: spot.id,
                date: toDateColumn(FUTURE_BUSINESS_DAY),
              },
            },
          });
          seen.push({
            oldStillThere: old !== null,
            promotedVisible: current?.userId === waiter.id,
          });
        })();
      };

      try {
        await harness.reservations.cancel({ reservationId: reservation.id }, actorFor(holder));
        await probe;

        expect(seen).toEqual([{ oldStillThere: false, promotedVisible: true }]);
      } finally {
        await observer.$disconnect();
      }
    });
  });
});
