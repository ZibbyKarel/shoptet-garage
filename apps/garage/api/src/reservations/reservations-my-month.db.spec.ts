/**
 * `ReservationsService.myMonth` against a real PostgreSQL 17.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 * Exists alongside the PrismaDouble unit test in `reservations-my-month.spec.ts`
 * to cover what a double cannot: the actual UTC-midnight date-column semantics
 * `toDateColumn`/`toDateOnly` document, at real calendar-month boundaries.
 */
import type { PrismaClient } from '@garage/database';
import { DEFAULT_MONTHLY_RESERVATION_CAP } from '@garage/shared-types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuditLogService } from '../audit/audit-log.service';
import { toDateColumn } from '../common/prisma-mapping';
import { ReservationPolicy } from './reservation-policy';
import { ReservationsService } from './reservations.service';
import { WaitlistPromotionService } from './waitlist-promotion.service';
import type { DomainEventPublisher } from './reservation-events';
import { ReservationLimitsService } from '../reservation-limits/reservation-limits.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import {
  asPrismaService,
  connect,
  seedSpot,
  seedUser,
  setLockMode,
} from '../testing/database/reservation-harness';

/** Nothing in this suite asserts on published events; a plain no-op stands in. */
const noopPublisher: DomainEventPublisher = { publish: jest.fn(), notifyPromotions: jest.fn() };

function authenticated(id: string): AuthenticatedUser {
  return {
    id,
    oktaId: `okta-${id}`,
    email: `${id}@example.test`,
    name: id,
    role: 'USER',
    active: true,
  };
}

describe('ReservationsService.myMonth against a real PostgreSQL', () => {
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

  it('includes the last day of the month and excludes the first day of the next', async () => {
    const spot = await seedSpot(client);
    const user = await seedUser(client);
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn('2026-09-30') },
    });
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn('2026-10-01') },
    });

    const result = await reservations.myMonth(
      { month: '2026-09' },
      authenticated(user.id),
      '2026-08-31'
    );

    expect(result).toEqual({
      month: '2026-09',
      reservedDates: ['2026-09-30'],
      count: 1,
      cap: DEFAULT_MONTHLY_RESERVATION_CAP,
    });
  });
});
