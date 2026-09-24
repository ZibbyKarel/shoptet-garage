/**
 * `ReservationsService.userMonth` against a real PostgreSQL 17.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 *
 * `reservations-my-month.db.spec.ts` already pins the month-range query for
 * the caller-scoped side, and both procedures share one body
 * (`ReservationsService.monthSummary`). What this file adds is the part the
 * shared body cannot prove on its own: that the subject really is the
 * **named** user against real rows and a real `date` column — the one thing a
 * `where` clause written backwards would get wrong while every unit test
 * against `PrismaDouble` still passed.
 */
import type { PrismaClient } from '@garage/database';
import { DEFAULT_MONTHLY_RESERVATION_CAP } from '@garage/shared-types';
import { AuditLogService } from '../audit/audit-log.service';
import { toDateColumn } from '../common/prisma-mapping';
import { ReservationPolicy } from './reservation-policy';
import { ReservationsService } from './reservations.service';
import { WaitlistPromotionService } from './waitlist-promotion.service';
import type { DomainEventPublisher } from './reservation-events';
import { ReservationLimitsService } from '../reservation-limits/reservation-limits.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import {
  actorFor,
  asPrismaService,
  connect,
  seedSpot,
  seedUser,
  setLockMode,
} from '../testing/database/reservation-harness';

/** Nothing in this suite asserts on published events; a plain no-op stands in. */
const noopPublisher: DomainEventPublisher = { publish: jest.fn(), notifyPromotions: jest.fn() };

describe('ReservationsService.userMonth against a real PostgreSQL', () => {
  let client: PrismaClient;
  let reservations: ReservationsService;

  beforeAll(() => {
    client = connect();
    const prisma = asPrismaService(client);
    const audit = new AuditLogService(prisma);
    reservations = new ReservationsService(
      prisma,
      new ReservationWindowService(prisma, audit),
      new ReservationPolicy(),
      new WaitlistPromotionService(audit),
      audit,
      noopPublisher,
      new ReservationLimitsService(prisma, audit)
    );
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  // Another suite may have left the singleton on an override; the cap in the
  // expectations below only exists under `AUTO`.
  beforeEach(() => setLockMode(client, 'AUTO'));

  it('counts the named user’s reservations, not the calling admin’s', async () => {
    const spot = await seedSpot(client);
    const [admin, holder] = [await seedUser(client), await seedUser(client)];
    // Two different spots, because `Reservation (parkingSpotId, date)` is
    // unique — two people cannot hold the same spot on the same day.
    const otherSpot = await seedSpot(client);
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: admin.id, date: toDateColumn('2026-09-07') },
    });
    await client.reservation.create({
      data: { parkingSpotId: otherSpot.id, userId: holder.id, date: toDateColumn('2026-09-07') },
    });
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: holder.id, date: toDateColumn('2026-09-14') },
    });

    const result = await reservations.userMonth(
      { userId: holder.id, month: '2026-09' },
      actorFor(admin, 'ADMIN'),
      '2026-08-31'
    );

    expect(result).toEqual({
      month: '2026-09',
      reservedDates: ['2026-09-07', '2026-09-14'],
      count: 2,
      // The cap in force, read from the seeded `ReservationLimitSettings`
      // singleton — which the seed writes at the documented default.
      cap: DEFAULT_MONTHLY_RESERVATION_CAP,
    });
  });

  it('includes the named user’s last day of the month and excludes the first of the next', async () => {
    const spot = await seedSpot(client);
    const [admin, holder] = [await seedUser(client), await seedUser(client)];
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: holder.id, date: toDateColumn('2026-09-30') },
    });
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: holder.id, date: toDateColumn('2026-10-01') },
    });

    const result = await reservations.userMonth(
      { userId: holder.id, month: '2026-09' },
      actorFor(admin, 'ADMIN'),
      '2026-08-31'
    );

    expect(result).toEqual({
      month: '2026-09',
      reservedDates: ['2026-09-30'],
      count: 1,
      cap: DEFAULT_MONTHLY_RESERVATION_CAP,
    });
  });

  it('answers an empty month for an id that holds nothing, rather than throwing', async () => {
    const admin = await seedUser(client);
    // A well-formed but unassigned `userId`: the column is `@db.Uuid`, so an
    // arbitrary string (as the unit-test double happily accepts) would fail
    // at the database with an "invalid input syntax for type uuid" error
    // rather than exercising the "holds nothing" path this test is about.
    const noSuchUser = '00000000-0000-0000-0000-000000000000';

    const result = await reservations.userMonth(
      { userId: noSuchUser, month: '2026-09' },
      actorFor(admin, 'ADMIN'),
      '2026-08-31'
    );

    expect(result).toEqual({
      month: '2026-09',
      reservedDates: [],
      count: 0,
      cap: DEFAULT_MONTHLY_RESERVATION_CAP,
    });
  });
});
