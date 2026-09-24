/**
 * Admin-only guest half-hour blocks — against a real PostgreSQL 17.
 *
 * Everything here rests on the (spot, day) exclusivity triggers from migration
 * `20260924120000_timed_reservation` (`doc/decision/0314-*`), which is why
 * this is a `.db.spec.ts` rather than a `PrismaDouble` unit test:
 * `reservations.db.spec.ts`'s own opening comment makes the same argument for
 * `FOR UPDATE` and `P2002`, and it applies here word for word.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 */

import type { PrismaClient } from '@garage/database';
import { AuditLogService } from '../audit/audit-log.service';
import { ReservationLimitsService } from '../reservation-limits/reservation-limits.service';
import { ReservationPolicy } from '../reservations/reservation-policy';
import { ReservationsService } from '../reservations/reservations.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { WaitlistPromotionService } from '../reservations/waitlist-promotion.service';
import {
  FUTURE_BUSINESS_DAY,
  FUTURE_WEEKEND_DAY,
  RecordingPublisher,
  TODAY,
  actorFor,
  asPrismaService,
  codeOf,
  connect,
  seedSpot,
  seedUser,
} from '../testing/database/reservation-harness';
import { TimedReservationsService } from './timed-reservations.service';

describe('admin.timedReservation.* against a real PostgreSQL', () => {
  let client: PrismaClient;
  let publisher: RecordingPublisher;
  let timedReservations: TimedReservationsService;
  let reservations: ReservationsService;

  beforeAll(() => {
    client = connect();
    const prismaService = asPrismaService(client);
    const audit = new AuditLogService(prismaService);
    const window = new ReservationWindowService(prismaService, audit);
    const policy = new ReservationPolicy();
    const limits = new ReservationLimitsService(prismaService, audit);
    publisher = new RecordingPublisher();
    timedReservations = new TimedReservationsService(
      prismaService,
      window,
      policy,
      audit,
      publisher
    );
    // The waitlist-promotion service is unused by the fixture below (nobody is
    // ever queued), but `ReservationsService`'s constructor still needs one.
    reservations = new ReservationsService(
      prismaService,
      window,
      policy,
      new WaitlistPromotionService(audit),
      audit,
      publisher,
      limits
    );
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  beforeEach(() => {
    publisher.reset();
  });

  it('lets an admin book a guest block on a hidden spot', async () => {
    const admin = await seedUser(client);
    const hidden = await seedSpot(client, { hidden: true });

    await expect(
      timedReservations.create(
        {
          parkingSpotId: hidden.id,
          date: FUTURE_BUSINESS_DAY,
          startTime: '13:00',
          endTime: '14:00',
          guestName: 'Hidden Guest',
          licensePlate: null,
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      )
    ).resolves.toMatchObject({ guestName: 'Hidden Guest' });
  });

  it('books a half-hour block, audits it and broadcasts the one-block list', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];

    const block = await timedReservations.create(
      {
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'Guest One',
        licensePlate: null,
      },
      actorFor(admin, 'ADMIN'),
      TODAY
    );

    expect(block).toMatchObject({
      parkingSpotId: spot.id,
      startTime: '09:00',
      endTime: '10:30',
      guestName: 'Guest One',
      licensePlate: null,
    });

    const audit = await client.auditLog.findMany({ where: { entityId: block.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'TIMED_RESERVATION_CREATED',
      actorUserId: admin.id,
      payload: {
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'Guest One',
      },
    });

    expect(publisher.ofKind('timed-reservations:updated')).toEqual([
      {
        name: 'timed-reservations:updated',
        payload: {
          date: FUTURE_BUSINESS_DAY,
          parkingSpotId: spot.id,
          timedReservations: [
            expect.objectContaining({ id: block.id, startTime: '09:00', endTime: '10:30' }),
          ],
        },
      },
    ]);
  });

  it('books a second, non-overlapping block and broadcasts both, ascending', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];
    const first = await timedReservations.create(
      {
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'Guest One',
        licensePlate: null,
      },
      actorFor(admin, 'ADMIN'),
      TODAY
    );
    publisher.reset();

    const second = await timedReservations.create(
      {
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        startTime: '10:30',
        endTime: '11:00',
        guestName: 'Guest Two',
        licensePlate: null,
      },
      actorFor(admin, 'ADMIN'),
      TODAY
    );

    const [event] = publisher.ofKind('timed-reservations:updated');
    expect(event?.payload.timedReservations.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it('refuses an overlapping block with SPOT_ALREADY_RESERVED, and audits nothing for it', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];
    const first = await timedReservations.create(
      {
        parkingSpotId: spot.id,
        date: FUTURE_BUSINESS_DAY,
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'Guest One',
        licensePlate: null,
      },
      actorFor(admin, 'ADMIN'),
      TODAY
    );

    await expect(
      codeOf(
        timedReservations.create(
          {
            parkingSpotId: spot.id,
            date: FUTURE_BUSINESS_DAY,
            startTime: '10:00',
            endTime: '11:00',
            guestName: 'Guest Two',
            licensePlate: null,
          },
          actorFor(admin, 'ADMIN'),
          TODAY
        )
      )
    ).resolves.toBe('SPOT_ALREADY_RESERVED');

    // Only the first block's own row exists — the rejected create audited
    // nothing about a block that was never persisted.
    const audit = await client.auditLog.findMany({ where: { entityId: first.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'TIMED_RESERVATION_CREATED' });
  });

  it('refuses a block on a spot already reserved for the whole day', async () => {
    const [admin, holder, spot] = [
      await seedUser(client),
      await seedUser(client),
      await seedSpot(client),
    ];
    await reservations.create(
      { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
      actorFor(holder),
      TODAY
    );

    await expect(
      codeOf(
        timedReservations.create(
          {
            parkingSpotId: spot.id,
            date: FUTURE_BUSINESS_DAY,
            startTime: '09:00',
            endTime: '10:00',
            guestName: 'Guest',
            licensePlate: null,
          },
          actorFor(admin, 'ADMIN'),
          TODAY
        )
      )
    ).resolves.toBe('SPOT_ALREADY_RESERVED');
  });

  it('refuses a past date with PAST_DATE', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];

    await expect(
      codeOf(
        timedReservations.create(
          {
            parkingSpotId: spot.id,
            date: TODAY,
            startTime: '09:00',
            endTime: '10:00',
            guestName: 'Guest',
            licensePlate: null,
          },
          actorFor(admin, 'ADMIN'),
          '2099-01-06'
        )
      )
    ).resolves.toBe('PAST_DATE');
  });

  it('refuses a non-business day with VALIDATION_FAILED', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];

    await expect(
      codeOf(
        timedReservations.create(
          {
            parkingSpotId: spot.id,
            date: FUTURE_WEEKEND_DAY,
            startTime: '09:00',
            endTime: '10:00',
            guestName: 'Guest',
            licensePlate: null,
          },
          actorFor(admin, 'ADMIN'),
          TODAY
        )
      )
    ).resolves.toBe('VALIDATION_FAILED');
  });

  it('refuses an inactive spot with NOT_FOUND', async () => {
    const [admin, spot] = [await seedUser(client), await seedSpot(client)];
    await client.parkingSpot.update({ where: { id: spot.id }, data: { active: false } });

    await expect(
      codeOf(
        timedReservations.create(
          {
            parkingSpotId: spot.id,
            date: FUTURE_BUSINESS_DAY,
            startTime: '09:00',
            endTime: '10:00',
            guestName: 'Guest',
            licensePlate: null,
          },
          actorFor(admin, 'ADMIN'),
          TODAY
        )
      )
    ).resolves.toBe('NOT_FOUND');
  });

  describe('cancel', () => {
    it('removes the block, audits it and broadcasts the remaining list', async () => {
      const [admin, spot] = [await seedUser(client), await seedSpot(client)];
      const first = await timedReservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          startTime: '09:00',
          endTime: '10:00',
          guestName: 'Guest One',
          licensePlate: null,
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      );
      const second = await timedReservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          startTime: '10:00',
          endTime: '11:00',
          guestName: 'Guest Two',
          licensePlate: null,
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      );
      publisher.reset();

      const result = await timedReservations.cancel(
        { timedReservationId: first.id },
        actorFor(admin, 'ADMIN')
      );

      expect(result).toEqual({
        timedReservationId: first.id,
        date: FUTURE_BUSINESS_DAY,
        parkingSpotId: spot.id,
      });

      const stored = await client.timedReservation.findUnique({ where: { id: first.id } });
      expect(stored).toBeNull();

      // Two rows share this entityId — its create and its cancellation — which
      // is the audit trail doing its job for a hard-deleted row.
      const audit = await client.auditLog.findMany({
        where: { entityId: first.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual([
        'TIMED_RESERVATION_CREATED',
        'TIMED_RESERVATION_CANCELLED',
      ]);
      expect(audit[1]).toMatchObject({
        action: 'TIMED_RESERVATION_CANCELLED',
        actorUserId: admin.id,
        payload: {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          startTime: '09:00',
          endTime: '10:00',
          guestName: 'Guest One',
        },
      });

      const [event] = publisher.ofKind('timed-reservations:updated');
      expect(event?.payload.timedReservations.map((row) => row.id)).toEqual([second.id]);
    });

    it('refuses an unknown id with NOT_FOUND', async () => {
      const admin = await seedUser(client);

      await expect(
        codeOf(
          timedReservations.cancel(
            { timedReservationId: '00000000-0000-7000-8000-000000000000' },
            actorFor(admin, 'ADMIN')
          )
        )
      ).resolves.toBe('NOT_FOUND');
    });

    it('lets a full-day reservation through once the last block on that spot-day is gone', async () => {
      const [admin, holder, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      const block = await timedReservations.create(
        {
          parkingSpotId: spot.id,
          date: FUTURE_BUSINESS_DAY,
          startTime: '09:00',
          endTime: '10:00',
          guestName: 'Guest',
          licensePlate: null,
        },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      await timedReservations.cancel({ timedReservationId: block.id }, actorFor(admin, 'ADMIN'));

      const reservation = await reservations.create(
        { parkingSpotId: spot.id, date: FUTURE_BUSINESS_DAY },
        actorFor(holder),
        TODAY
      );

      expect(reservation.parkingSpotId).toBe(spot.id);
    });
  });
});
