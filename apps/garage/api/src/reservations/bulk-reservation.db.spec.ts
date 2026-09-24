/**
 * Bulk booking against a real PostgreSQL 17 — the sequential half.
 *
 * The races are in `bulk-concurrency.db.spec.ts`. What is here is everything a
 * single caller can observe: that the preview writes nothing, that the
 * confirmation writes reservations, queue entries, audit rows and broadcasts,
 * that the window and the past-date rules reject the whole request while a
 * weekend rejects only its own day, and — with a forced interleaving — that a
 * day whose spot is taken mid-transaction falls onto the waitlist instead of
 * discarding the batch.
 *
 * ## Why the fixtures look the way they do
 *
 * **Spots are global.** The database is shared by every `*.db.spec.ts` in the
 * run, and a spot another suite seeded is an active spot this allocator will
 * consider. So nothing here asserts *which* spot was picked out of the whole
 * lot: it asserts the two things that really are this module's claims — that the
 * row the result names exists in the database with the fields the result gave
 * it, and that the preview and the confirmation agree with each other. Where one
 * specific spot has to win, it is made to win by a rule that beats the ordering
 * outright: the caller's `preferredParkingSpotId`. Which spot the *ordering*
 * picks is `bulk-allocator.spec.ts`'s subject, where it can be settled without a
 * database at all.
 *
 * **Days are not shared between cases.** Several cases fill a whole day or book
 * one, so each gets days of its own; a case that reused another's would pass or
 * fail depending on the order Jest happened to run them in. They all sit in
 * **January 2100**, a month nothing else in the suite touches, which also
 * happens to contain a weekday public holiday (`2100-01-01` is a Friday) — that
 * is what makes the `NOT_A_BUSINESS_DAY` case possible inside a single calendar
 * month, which the input schema requires.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 */

import type { PrismaClient, User as UserRow } from '@garage/database';
import type { DateOnly } from '@garage/shared-types';
import { isBusinessDay } from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import type { Harness } from '../testing/database/reservation-harness';
import {
  TODAY,
  actorFor,
  buildHarness,
  codeOf,
  connect,
  detailsOf,
  holdTransaction,
  seedSpot,
  seedUser,
  setLockMode,
  setPreferredSpot,
  waitForBlockedBackend,
} from '../testing/database/reservation-harness';

/** New Year's Day 2100 — a **Friday**, so a holiday that is not a weekend. */
const HOLIDAY = '2100-01-01' as DateOnly;
/** The Saturday after it. */
const WEEKEND = '2100-01-02' as DateOnly;

/** Read-only cases may share these; nothing writes to them. */
const PREVIEW_DAYS = ['2100-01-04', '2100-01-05', '2100-01-06'] as DateOnly[];
/** Days for cases that only ever get rejected. */
const REJECTED_DAY = '2100-01-07' as DateOnly;
/** The one day the locked-month case lets an admin book. */
const ADMIN_DAY = '2100-01-08' as DateOnly;
const CONFIRM_DAYS = ['2100-01-11', '2100-01-12', '2100-01-13'] as DateOnly[];
const PARITY_DAYS = ['2100-01-14', '2100-01-15'] as DateOnly[];
const ALREADY_BOOKED_DAYS = ['2100-01-18', '2100-01-19'] as DateOnly[];
const FULL_DAY = '2100-01-20' as DateOnly;
const QUEUED_BEHIND_DAY = '2100-01-21' as DateOnly;
const AFTER_COMMIT_DAY = '2100-01-22' as DateOnly;
const CONTESTED_DAYS = ['2100-01-25', '2100-01-26'] as DateOnly[];
const BUSY_ELSEWHERE_DAYS = ['2100-01-27', '2100-01-28'] as DateOnly[];
/** A Friday four weeks after {@link HOLIDAY}, so also unaffected by it. */
const GUEST_BLOCK_DAY = '2100-01-29' as DateOnly;
/**
 * The same race against a day the allocator planned to **queue**.
 *
 * In March 2100 rather than January because January 2100 has no unused business
 * day left, and a case that borrowed another's would pass or fail on Jest's
 * ordering. The input schema's rule is "one calendar month per request", not
 * "one month per file", so `[…-03-01, …-03-02]` satisfies it on its own.
 */
const QUEUE_BUSY_DAYS = ['2100-03-01', '2100-03-02'] as DateOnly[];
/** March 2100 too, and for the same reason: January has no day left. */
const ALREADY_QUEUED_DAY = '2100-03-03' as DateOnly;

/** 4 more March business days for the monthly-cap case — Thu/Fri/Mon/Tue, no Czech holiday near them (Easter 2100 is March 28). */
const CAP_PREEXISTING_DAYS = ['2100-03-04', '2100-03-05', '2100-03-08', '2100-03-09'] as DateOnly[];
/** The 2 days the cap-rejected request itself asks for — Wed/Thu, same week. */
const CAP_REQUEST_DAYS = ['2100-03-10', '2100-03-11'] as DateOnly[];

/**
 * The last day of March 2100's automatic window, whatever `openDaysBefore` is:
 * the window always ends the day before the month starts.
 */
const CAP_WINDOW_TODAY = '2100-02-28' as DateOnly;
/** 4 + 2 more March days for the uncapped case — Fri, Mon–Fri, before Easter 2100 (March 28). */
const UNCAPPED_PREEXISTING_DAYS = [
  '2100-03-12',
  '2100-03-15',
  '2100-03-16',
  '2100-03-17',
] as DateOnly[];
const UNCAPPED_REQUEST_DAYS = ['2100-03-18', '2100-03-19'] as DateOnly[];

/** Every day this file names, for the fixture guard. */
const BUSINESS_DAYS = [
  ...PREVIEW_DAYS,
  REJECTED_DAY,
  ADMIN_DAY,
  ...CONFIRM_DAYS,
  ...PARITY_DAYS,
  ...ALREADY_BOOKED_DAYS,
  FULL_DAY,
  QUEUED_BEHIND_DAY,
  AFTER_COMMIT_DAY,
  ...CONTESTED_DAYS,
  ...BUSY_ELSEWHERE_DAYS,
  GUEST_BLOCK_DAY,
];

/** The March days, kept apart from {@link BUSINESS_DAYS}'s one-month guard. */
const MARCH_DAYS = [
  ...QUEUE_BUSY_DAYS,
  ALREADY_QUEUED_DAY,
  ...CAP_PREEXISTING_DAYS,
  ...CAP_REQUEST_DAYS,
  ...UNCAPPED_PREEXISTING_DAYS,
  ...UNCAPPED_REQUEST_DAYS,
];

describe('bulk booking against a real PostgreSQL', () => {
  let client: PrismaClient;
  /** A second pool, for the one case that needs an uncommitted competitor. */
  let otherClient: PrismaClient;
  let harness: Harness;
  let user: UserRow;

  /** Row counts of everything a preview must not touch. */
  async function counts(): Promise<{ reservations: number; waitlist: number; audit: number }> {
    const [reservations, waitlist, audit] = await Promise.all([
      client.reservation.count(),
      client.waitlistEntry.count(),
      client.auditLog.count(),
    ]);
    return { reservations, waitlist, audit };
  }

  /**
   * Gives every active spot to somebody else for `date`.
   *
   * The only honest way to reach the `QUEUED` branch while other suites keep
   * adding spots to the same database: "the lot is full" has to be true of the
   * whole lot, not of the two spots this file happened to seed.
   */
  async function fillTheLot(date: DateOnly): Promise<{ id: string; label: string }[]> {
    const spots = await client.parkingSpot.findMany({
      where: { active: true },
      select: { id: true, label: true },
    });
    await Promise.all(
      spots.map(async (spot) => {
        const holder = await seedUser(client);
        await client.reservation.create({
          data: { parkingSpotId: spot.id, userId: holder.id, date: toDateColumn(date) },
        });
      })
    );
    return spots;
  }

  beforeAll(async () => {
    client = connect();
    otherClient = connect();
    harness = buildHarness(client);
    // At least one spot of our own, so the lot is never empty for these cases.
    await seedSpot(client);
    user = await seedUser(client);
  });

  afterAll(async () => {
    await Promise.all([client.$disconnect(), otherClient.$disconnect()]);
  });

  beforeEach(async () => {
    harness.publisher.reset();
    // 2100-01 is far outside the automatic window, so every case that is not
    // *about* the window forces it open. `monthLockState` is still the only
    // implementation of the rule; this only chooses which branch of it applies.
    await setLockMode(client, 'FORCE_OPEN');
    await setPreferredSpot(client, user.id, null);
  });

  it('uses fixture days that mean what the cases below assume', () => {
    // Without this, "skipped for the holiday" and "skipped for the weekend"
    // would be indistinguishable, and a January that turned out to be all
    // business days would make two cases vacuous.
    expect(isBusinessDay(HOLIDAY)).toBe(false);
    expect(isBusinessDay(WEEKEND)).toBe(false);
    for (const date of BUSINESS_DAYS) {
      expect(isBusinessDay(date)).toBe(true);
    }
    // The input schema requires one calendar month *per request*, so every set
    // of days a case sends together sits in one.
    expect(new Set([...BUSINESS_DAYS, HOLIDAY, WEEKEND].map((date) => date.slice(0, 7)))).toEqual(
      new Set(['2100-01'])
    );
    expect(new Set(MARCH_DAYS.map((date) => date.slice(0, 7)))).toEqual(new Set(['2100-03']));
    for (const date of MARCH_DAYS) {
      expect(isBusinessDay(date)).toBe(true);
    }
    // And no case borrows another's day, which is what keeps them independent
    // of the order Jest runs them in.
    const everyDay = [...BUSINESS_DAYS, ...MARCH_DAYS];
    expect(new Set(everyDay).size).toBe(everyDay.length);
  });

  describe('previewBulk', () => {
    it('writes nothing at all — no reservation, no queue entry, no audit row', async () => {
      const before = await counts();

      const preview = await harness.bulk.preview({ dates: PREVIEW_DAYS }, actorFor(user), TODAY);

      expect(preview.days).toHaveLength(PREVIEW_DAYS.length);
      expect(await counts()).toEqual(before);
      // And nothing was broadcast either: a proposal is not a fact.
      expect(harness.publisher.events).toEqual([]);
    });

    it('gives the same answer for the same input, twice', async () => {
      const first = await harness.bulk.preview({ dates: PREVIEW_DAYS }, actorFor(user), TODAY);
      const second = await harness.bulk.preview({ dates: PREVIEW_DAYS }, actorFor(user), TODAY);

      expect(second).toEqual(first);
    });

    it('answers in the order the days were requested, not in date order', async () => {
      const requested = [PREVIEW_DAYS[2], PREVIEW_DAYS[0], PREVIEW_DAYS[1]] as DateOnly[];

      const preview = await harness.bulk.preview({ dates: requested }, actorFor(user), TODAY);

      expect(preview.days.map((day) => day.date)).toEqual(requested);
      expect(preview.month).toBe('2100-01');
    });

    it('proposes the caller’s preferred spot and says so', async () => {
      const preferred = await seedSpot(client);
      await setPreferredSpot(client, user.id, preferred.id);

      const preview = await harness.bulk.preview(
        { dates: [PREVIEW_DAYS[0] as DateOnly] },
        actorFor(user),
        TODAY
      );

      expect(preview.preferredParkingSpotId).toBe(preferred.id);
      expect(preview.days[0]).toEqual({
        outcome: 'SPOT_ASSIGNED',
        date: PREVIEW_DAYS[0],
        parkingSpotId: preferred.id,
        parkingSpotLabel: preferred.label,
        isPreferredSpot: true,
      });
      expect(preview.summary).toEqual({
        assigned: 1,
        queued: 0,
        unavailable: 0,
        preferredSpotHits: 1,
      });
    });

    it('never proposes a hidden spot, even when it is the preferred one', async () => {
      const hidden = await seedSpot(client, { hidden: true });
      await setPreferredSpot(client, user.id, hidden.id);

      const preview = await harness.bulk.preview(
        { dates: [PREVIEW_DAYS[0] as DateOnly] },
        actorFor(user),
        TODAY
      );

      expect(preview.days[0]).toMatchObject({ outcome: 'SPOT_ASSIGNED', isPreferredSpot: false });
      expect(preview.days[0]).not.toMatchObject({ parkingSpotId: hidden.id });
    });

    it('marks a weekend and a holiday unavailable without discarding the rest', async () => {
      const preview = await harness.bulk.preview(
        { dates: [HOLIDAY, WEEKEND, PREVIEW_DAYS[0] as DateOnly] },
        actorFor(user),
        TODAY
      );

      expect(preview.days.map((day) => [day.date, day.outcome])).toEqual([
        [HOLIDAY, 'UNAVAILABLE'],
        [WEEKEND, 'UNAVAILABLE'],
        [PREVIEW_DAYS[0], 'SPOT_ASSIGNED'],
      ]);
      expect(preview.days.slice(0, 2).map((day) => 'reason' in day && day.reason)).toEqual([
        'NOT_A_BUSINESS_DAY',
        'NOT_A_BUSINESS_DAY',
      ]);
      expect(preview.summary.unavailable).toBe(2);
    });
  });

  describe('the rules that reject the whole request', () => {
    it('refuses a past day', async () => {
      const past = ['2098-01-06'] as DateOnly[];

      await expect(
        codeOf(harness.bulk.preview({ dates: past }, actorFor(user), TODAY))
      ).resolves.toBe('PAST_DATE');
      await expect(
        codeOf(harness.bulk.confirm({ dates: past }, actorFor(user), TODAY))
      ).resolves.toBe('PAST_DATE');
    });

    /**
     * The only thing `assertRequestable`'s sort is still there for.
     *
     * It scans in ascending order so a rejection names the **earliest** offending
     * day rather than whichever one the client happened to list first — and that
     * sort is deliberately *local to the scan*: the dates it hands downstream stay
     * in request order, because the write order has exactly one authority
     * (`allocateBulk`) and a second sort here would make that one unfalsifiable.
     * See `doc/decision/0092-*` §"One authority". Remove the `.sort` from the scan
     * and this case names `2098-01-20` instead.
     */
    it('names the earliest offending day, not the first one listed', async () => {
      const past = ['2098-01-20', '2098-01-06'] as DateOnly[];

      await expect(
        detailsOf(harness.bulk.preview({ dates: past }, actorFor(user), TODAY))
      ).resolves.toMatchObject({ date: '2098-01-06' });
      await expect(
        detailsOf(harness.bulk.confirm({ dates: past }, actorFor(user), TODAY))
      ).resolves.toMatchObject({ date: '2098-01-06' });
    });

    it('refuses a month that has not opened yet', async () => {
      await setLockMode(client, 'AUTO');

      await expect(
        codeOf(harness.bulk.confirm({ dates: [REJECTED_DAY] }, actorFor(user), TODAY))
      ).resolves.toBe('OUT_OF_HORIZON');
    });

    it('refuses a normal user in a locked month, and lets an admin through', async () => {
      await setLockMode(client, 'FORCE_LOCKED');

      await expect(
        codeOf(harness.bulk.confirm({ dates: [ADMIN_DAY] }, actorFor(user), TODAY))
      ).resolves.toBe('RESERVATIONS_LOCKED');
      expect(
        await client.reservation.count({
          where: { userId: user.id, date: toDateColumn(ADMIN_DAY) },
        })
      ).toBe(0);

      const admin = await seedUser(client);
      const result = await harness.bulk.confirm(
        { dates: [ADMIN_DAY] },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      expect(result.summary.assigned).toBe(1);
    });

    it('refuses a request that spans two months', async () => {
      // `bulkBookingInputSchema` refuses this on the wire; the service checks it
      // too, because `month` is a claim about the whole batch.
      await expect(
        codeOf(
          harness.bulk.preview(
            { dates: [REJECTED_DAY, '2100-02-01' as DateOnly] },
            actorFor(user),
            TODAY
          )
        )
      ).resolves.toBe('VALIDATION_FAILED');
    });
  });

  describe('an admin naming a holder', () => {
    const HOLDER_ASSIGNED_DAY = '2100-06-04' as DateOnly;
    const HOLDER_QUEUED_DAY = '2100-06-07' as DateOnly;

    it('books and queues on behalf of another user, and audits it as an admin action', async () => {
      const [admin, target, spot] = [
        await seedUser(client),
        await seedUser(client, { name: 'Jana Nováková' }),
        await seedSpot(client),
      ];
      await setPreferredSpot(client, target.id, spot.id);
      // Fill the *whole lot* on the queued day so the batch has one of each
      // outcome — filling only `spot` would leave the allocator free to assign
      // any of the other active spots instead of queueing (see `fillTheLot`'s
      // own doc comment: spots are global across every `*.db.spec.ts`).
      await fillTheLot(HOLDER_QUEUED_DAY);

      const result = await harness.bulk.confirm(
        { dates: [HOLDER_ASSIGNED_DAY, HOLDER_QUEUED_DAY], holderId: target.id },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      const assigned = result.days.find((day) => day.date === HOLDER_ASSIGNED_DAY);
      const queued = result.days.find((day) => day.date === HOLDER_QUEUED_DAY);
      if (assigned?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(
          `Expected ${HOLDER_ASSIGNED_DAY} to be assigned, got ${assigned?.outcome}.`
        );
      }
      if (queued?.outcome !== 'QUEUED') {
        throw new Error(`Expected ${HOLDER_QUEUED_DAY} to be queued, got ${queued?.outcome}.`);
      }
      expect(assigned).toMatchObject({ outcome: 'SPOT_ASSIGNED', parkingSpotId: spot.id });
      expect(queued).toMatchObject({ outcome: 'QUEUED' });

      // The rows belong to the target, not the admin.
      const reservationId = assigned.reservationId;
      const reservation = await client.reservation.findUniqueOrThrow({
        where: { id: reservationId },
      });
      expect(reservation.userId).toBe(target.id);

      const waitlistEntryId = queued.waitlistEntryId;
      const entry = await client.waitlistEntry.findUniqueOrThrow({
        where: { id: waitlistEntryId },
      });
      expect(entry.userId).toBe(target.id);

      // The trail says who did it and for whom.
      const reservationAudit = await client.auditLog.findMany({
        where: { entityId: reservationId },
      });
      expect(reservationAudit).toHaveLength(1);
      expect(reservationAudit[0]).toMatchObject({
        action: 'RESERVATION_CREATED_BY_ADMIN',
        actorUserId: admin.id,
      });
      expect(reservationAudit[0]?.payload).toMatchObject({
        holderUserId: target.id,
        guestName: null,
      });

      const waitlistAudit = await client.auditLog.findMany({
        where: { entityId: waitlistEntryId },
      });
      expect(waitlistAudit).toHaveLength(1);
      expect(waitlistAudit[0]).toMatchObject({
        action: 'WAITLIST_JOINED_BY_ADMIN',
        actorUserId: admin.id,
      });
      expect(waitlistAudit[0]?.payload).toMatchObject({ targetUserId: target.id });
    });

    it("lets an admin's own exemption from the window apply even when booking for somebody else", async () => {
      const [admin, target, spot] = [
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      await setLockMode(client, 'FORCE_LOCKED');
      // Deterministic against the shared spot pool — see `fillTheLot`'s comment.
      await setPreferredSpot(client, target.id, spot.id);

      const result = await harness.bulk.confirm(
        { dates: ['2100-06-08' as DateOnly], holderId: target.id },
        actorFor(admin, 'ADMIN'),
        TODAY
      );

      expect(result.days[0]).toMatchObject({ outcome: 'SPOT_ASSIGNED', parkingSpotId: spot.id });
    });

    it('refuses a non-admin naming somebody else', async () => {
      const [user, target] = [await seedUser(client), await seedUser(client)];

      expect(
        await codeOf(
          harness.bulk.preview(
            { dates: ['2100-06-11' as DateOnly], holderId: target.id },
            actorFor(user),
            TODAY
          )
        )
      ).toBe('FORBIDDEN');
      expect(
        await codeOf(
          harness.bulk.confirm(
            { dates: ['2100-06-11' as DateOnly], holderId: target.id },
            actorFor(user),
            TODAY
          )
        )
      ).toBe('FORBIDDEN');
    });

    it('lets a user name themselves — the same batch they would get by omitting holderId', async () => {
      const [user, spot] = [await seedUser(client), await seedSpot(client)];
      // Deterministic against the shared spot pool — see `fillTheLot`'s comment.
      await setPreferredSpot(client, user.id, spot.id);

      const result = await harness.bulk.confirm(
        { dates: ['2100-06-14' as DateOnly], holderId: user.id },
        actorFor(user),
        TODAY
      );

      expect(result.days[0]).toMatchObject({ outcome: 'SPOT_ASSIGNED', parkingSpotId: spot.id });
      const created = await client.reservation.findFirstOrThrow({
        where: { userId: user.id, date: toDateColumn('2100-06-14' as DateOnly) },
      });
      // Booking for yourself is never the admin-flavoured action, admin or not.
      const audit = await client.auditLog.findMany({ where: { entityId: created.id } });
      expect(audit[0]).toMatchObject({ action: 'RESERVATION_CREATED' });
    });

    it('reports NOT_FOUND for a holder id that names nobody', async () => {
      const admin = await seedUser(client);
      const missingId = '00000000-0000-0000-0000-000000000000';

      expect(
        await codeOf(
          harness.bulk.preview(
            { dates: ['2100-06-15' as DateOnly], holderId: missingId },
            actorFor(admin, 'ADMIN'),
            TODAY
          )
        )
      ).toBe('NOT_FOUND');
    });
  });

  describe('confirmBulk', () => {
    it('writes a reservation, an audit entry and a broadcast for every assigned day', async () => {
      const booker = await seedUser(client);

      const result = await harness.bulk.confirm({ dates: CONFIRM_DAYS }, actorFor(booker), TODAY);

      expect(result.summary).toMatchObject({ assigned: 3, queued: 0, unavailable: 0 });

      for (const day of result.days) {
        if (day.outcome !== 'SPOT_ASSIGNED') {
          throw new Error(`Expected ${day.date} to be assigned, got ${day.outcome}.`);
        }
        // The row the result names really exists, on the day and spot it names.
        const stored = await client.reservation.findUniqueOrThrow({
          where: { id: day.reservationId },
        });
        expect(stored).toMatchObject({ userId: booker.id, parkingSpotId: day.parkingSpotId });
        expect(stored.date.toISOString()).toBe(`${day.date}T00:00:00.000Z`);

        const audit = await client.auditLog.findMany({ where: { entityId: day.reservationId } });
        expect(audit.map((row) => row.action)).toEqual(['RESERVATION_CREATED']);
        expect(audit[0]?.actorUserId).toBe(booker.id);
      }

      expect(
        harness.publisher.ofKind('reservation:created').map((event) => event.payload.date)
      ).toEqual(CONFIRM_DAYS);
      expect(harness.publisher.ofKind('waitlist:updated')).toEqual([]);
    });

    it('does what the preview proposed, day for day', async () => {
      const booker = await seedUser(client);
      const preferred = await seedSpot(client);
      await setPreferredSpot(client, booker.id, preferred.id);

      const preview = await harness.bulk.preview({ dates: PARITY_DAYS }, actorFor(booker), TODAY);
      const result = await harness.bulk.confirm({ dates: PARITY_DAYS }, actorFor(booker), TODAY);

      expect(result.days.map((day) => [day.date, day.outcome])).toEqual(
        preview.days.map((day) => [day.date, day.outcome])
      );
      expect(result.days.map((day) => ('parkingSpotId' in day ? day.parkingSpotId : null))).toEqual(
        preview.days.map((day) => ('parkingSpotId' in day ? day.parkingSpotId : null))
      );
      expect(result.summary).toEqual(preview.summary);
      expect(result.summary.preferredSpotHits).toBe(2);
    });

    it('routes around a guest block on the preferred spot and still assigns the day', async () => {
      const booker = await seedUser(client);
      const preferred = await seedSpot(client);
      await setPreferredSpot(client, booker.id, preferred.id);
      await client.timedReservation.create({
        data: {
          parkingSpotId: preferred.id,
          date: toDateColumn(GUEST_BLOCK_DAY),
          startMinute: 540,
          endMinute: 600,
          guestName: 'Guest',
        },
      });

      const result = await harness.bulk.confirm(
        { dates: [GUEST_BLOCK_DAY] },
        actorFor(booker),
        TODAY
      );

      const [day] = result.days;
      if (day?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(`Expected ${GUEST_BLOCK_DAY} to be assigned, got ${day?.outcome}.`);
      }
      expect(day.parkingSpotId).not.toBe(preferred.id);
      expect(day.isPreferredSpot).toBe(false);
      expect(result.summary).toMatchObject({ assigned: 1, queued: 0, unavailable: 0 });

      const stored = await client.reservation.findUniqueOrThrow({
        where: { id: day.reservationId },
      });
      expect(stored.parkingSpotId).toBe(day.parkingSpotId);
    });

    it('skips a day the caller already holds a reservation on', async () => {
      const booker = await seedUser(client);
      const spot = await seedSpot(client);
      const [taken, free] = ALREADY_BOOKED_DAYS as [DateOnly, DateOnly];
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: booker.id, date: toDateColumn(taken) },
      });

      const result = await harness.bulk.confirm({ dates: [taken, free] }, actorFor(booker), TODAY);

      expect(result.days[0]).toEqual({
        outcome: 'UNAVAILABLE',
        date: taken,
        reason: 'ALREADY_HAS_RESERVATION',
      });
      expect(result.days[1]?.outcome).toBe('SPOT_ASSIGNED');
      // Still exactly one reservation that day, and in particular they were not
      // put into a queue they could never be promoted out of.
      expect(
        await client.reservation.count({ where: { userId: booker.id, date: toDateColumn(taken) } })
      ).toBe(1);
      expect(
        await client.waitlistEntry.count({
          where: { userId: booker.id, date: toDateColumn(taken) },
        })
      ).toBe(0);
    });

    it('rejects the whole request with MONTHLY_RESERVATION_LIMIT_REACHED when it would push the user over the monthly cap', async () => {
      // The file defaults to FORCE_OPEN, which never caps; the cap lives in the AUTO window.
      await setLockMode(client, 'AUTO');
      const user = await seedUser(client);
      const preexisting = await Promise.all(Array.from({ length: 4 }, () => seedSpot(client)));

      // 4 already held this month, leaving a budget of 1 — the 2-day request below asks for 2.
      for (const [i, day] of CAP_PREEXISTING_DAYS.entries()) {
        const spot = preexisting[i];
        if (spot === undefined) {
          throw new Error(`Expected a seeded spot at index ${i}.`);
        }
        await client.reservation.create({
          data: {
            parkingSpotId: spot.id,
            userId: user.id,
            date: toDateColumn(day),
          },
        });
      }

      const code = await codeOf(
        harness.bulk.confirm({ dates: CAP_REQUEST_DAYS }, actorFor(user), CAP_WINDOW_TODAY)
      );
      expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');

      // Neither requested day was booked — the whole request was rejected.
      const created = await client.reservation.findMany({
        where: { userId: user.id, date: { in: CAP_REQUEST_DAYS.map(toDateColumn) } },
      });
      expect(created).toHaveLength(0);
    });

    it('books the whole request past the cap under FORCE_OPEN, which never caps', async () => {
      const user = await seedUser(client);
      const preexisting = await Promise.all(Array.from({ length: 4 }, () => seedSpot(client)));
      // Free spots for the two requested days, so the allocator assigns rather than queues.
      await seedSpot(client);
      await seedSpot(client);

      for (const [i, day] of UNCAPPED_PREEXISTING_DAYS.entries()) {
        const spot = preexisting[i];
        if (spot === undefined) {
          throw new Error(`Expected a seeded spot at index ${i}.`);
        }
        await client.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(day) },
        });
      }

      await harness.bulk.confirm({ dates: UNCAPPED_REQUEST_DAYS }, actorFor(user), TODAY);

      const created = await client.reservation.findMany({
        where: { userId: user.id, date: { in: UNCAPPED_REQUEST_DAYS.map(toDateColumn) } },
      });
      expect(created).toHaveLength(2);
    });

    it('releases a queue the caller was already in on a day it just reserved for them', async () => {
      // The state the rest of the module treats as invalid from both sides:
      // `WaitlistService.join` refuses it at the door and `promote` cleans it up
      // afterwards, because a queue entry held by somebody who already has that
      // day can never be promoted. `confirmBulk` was the one writer that could
      // create it — `allocateBulk` refuses a day the caller already has a
      // *reservation* on, and nothing did the reverse. See `doc/decision/0236-*`.
      const [booker, holder, behind, contested] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
        await seedSpot(client),
      ];
      await harness.reservations.create(
        { parkingSpotId: contested.id, date: ALREADY_QUEUED_DAY },
        actorFor(holder),
        TODAY
      );
      const own = await harness.waitlist.join(
        { parkingSpotId: contested.id, date: ALREADY_QUEUED_DAY },
        actorFor(booker),
        TODAY
      );
      const theirs = await harness.waitlist.join(
        { parkingSpotId: contested.id, date: ALREADY_QUEUED_DAY },
        actorFor(behind),
        TODAY
      );
      expect([own.position, theirs.position]).toEqual([1, 2]);
      harness.publisher.reset();

      const result = await harness.bulk.confirm(
        { dates: [ALREADY_QUEUED_DAY] },
        actorFor(booker),
        TODAY
      );

      // They got a spot — a different one, since `contested` is held.
      expect(result.summary).toMatchObject({ assigned: 1, queued: 0 });
      expect(result.days[0]).toMatchObject({ outcome: 'SPOT_ASSIGNED' });

      // …and their own queue entry is gone, while the person behind them stays.
      expect(await client.waitlistEntry.findUnique({ where: { id: own.entry.id } })).toBeNull();
      expect(
        await client.waitlistEntry.findUnique({ where: { id: theirs.entry.id } })
      ).not.toBeNull();

      // The shorter queue is announced, or the badge on that cell stays wrong
      // and the person behind keeps a position one too high.
      expect(harness.publisher.ofKind('waitlist:updated').map((event) => event.payload)).toEqual([
        { date: ALREADY_QUEUED_DAY, parkingSpotId: contested.id, waitlistCount: 1 },
      ]);
    });

    it('queues, audits and broadcasts when the whole lot is taken', async () => {
      const spots = await fillTheLot(FULL_DAY);
      const booker = await seedUser(client);

      const result = await harness.bulk.confirm({ dates: [FULL_DAY] }, actorFor(booker), TODAY);

      const queued = result.days[0];
      if (queued?.outcome !== 'QUEUED') {
        throw new Error(`Expected ${FULL_DAY} to be queued, got ${queued?.outcome}.`);
      }
      expect(spots.map((spot) => spot.id)).toContain(queued.parkingSpotId);
      expect(queued.waitlistPosition).toBe(1);
      expect(result.summary).toEqual({
        assigned: 0,
        queued: 1,
        unavailable: 0,
        preferredSpotHits: 0,
      });

      const entry = await client.waitlistEntry.findUniqueOrThrow({
        where: { id: queued.waitlistEntryId },
      });
      expect(entry).toMatchObject({ userId: booker.id, parkingSpotId: queued.parkingSpotId });

      const audit = await client.auditLog.findMany({ where: { entityId: queued.waitlistEntryId } });
      expect(audit.map((row) => row.action)).toEqual(['WAITLIST_JOINED']);
      expect(audit[0]?.entityType).toBe('WaitlistEntry');

      expect(harness.publisher.ofKind('waitlist:updated')).toEqual([
        {
          name: 'waitlist:updated',
          payload: { date: FULL_DAY, parkingSpotId: queued.parkingSpotId, waitlistCount: 1 },
        },
      ]);
      expect(harness.publisher.ofKind('reservation:created')).toEqual([]);
    });

    it('reports the position behind everybody already queued', async () => {
      const spots = await fillTheLot(QUEUED_BEHIND_DAY);
      // Two people ahead in *every* queue, so whichever spot the allocator picks
      // the answer is the same and this case is not secretly about the choice.
      await Promise.all(
        spots.flatMap((spot) =>
          [0, 1].map(async () => {
            const waiter = await seedUser(client);
            await client.waitlistEntry.create({
              data: {
                parkingSpotId: spot.id,
                userId: waiter.id,
                date: toDateColumn(QUEUED_BEHIND_DAY),
              },
            });
          })
        )
      );
      const booker = await seedUser(client);

      const result = await harness.bulk.confirm(
        { dates: [QUEUED_BEHIND_DAY] },
        actorFor(booker),
        TODAY
      );

      expect(result.days[0]).toMatchObject({ outcome: 'QUEUED', waitlistPosition: 3 });
    });

    it('publishes only once the transaction has committed', async () => {
      const booker = await seedUser(client);

      // A **second connection**, which by definition cannot see uncommitted
      // rows. If `publish` ran inside the transaction, this observer would find
      // no reservation at all.
      const observer = connect();
      const seen: boolean[] = [];
      let probe: Promise<void> = Promise.resolve();
      harness.publisher.onPublish = () => {
        probe = (async () => {
          const stored = await observer.reservation.count({
            where: { userId: booker.id, date: toDateColumn(AFTER_COMMIT_DAY) },
          });
          seen.push(stored === 1);
        })();
      };

      try {
        await harness.bulk.confirm({ dates: [AFTER_COMMIT_DAY] }, actorFor(booker), TODAY);
        await probe;

        expect(seen).toEqual([true]);
      } finally {
        await observer.$disconnect();
      }
    });
  });

  describe('a day whose spot is taken mid-transaction', () => {
    /**
     * The partial-failure rule, forced rather than hoped for.
     *
     * A competitor writes a reservation for the spot the preview just proposed
     * and **holds it uncommitted**. The confirmation's own read cannot see that
     * row, so it plans the same spot, and its `INSERT … ON CONFLICT DO NOTHING`
     * blocks on the uncommitted key. Releasing the competitor turns that block
     * into a *skipped row* rather than a `P2002`: the transaction survives, that
     * one day falls onto the waitlist for the spot it lost, and the other day is
     * still assigned.
     *
     * Drop `skipDuplicates` and the whole batch comes back
     * `SPOT_ALREADY_RESERVED` having written nothing. The task report has that
     * failure.
     */
    it('falls onto the waitlist for that spot and keeps the rest of the batch', async () => {
      const booker = await seedUser(client);
      const competitor = await seedUser(client);
      const [contested, spare] = CONTESTED_DAYS as [DateOnly, DateOnly];

      // Learn which spot the allocator will choose, without writing anything.
      const preview = await harness.bulk.preview(
        { dates: [contested, spare] },
        actorFor(booker),
        TODAY
      );
      const planned = preview.days[0];
      if (planned?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(`Expected the preview to assign ${contested}, got ${planned?.outcome}.`);
      }
      harness.publisher.reset();

      const held = holdTransaction(otherClient, (tx) =>
        tx.reservation.create({
          data: {
            parkingSpotId: planned.parkingSpotId,
            userId: competitor.id,
            date: toDateColumn(contested),
          },
        })
      );
      await held.ready;

      const confirming = harness.bulk.confirm(
        { dates: [contested, spare] },
        actorFor(booker),
        TODAY
      );
      // Proves the insert really is stuck on the competitor's uncommitted key
      // rather than having sailed past it. Throws if nothing ever blocks.
      await waitForBlockedBackend(client);

      held.release();
      await held.done;
      const result = await confirming;

      expect(result.summary).toMatchObject({ assigned: 1, queued: 1, unavailable: 0 });

      const lost = result.days[0];
      if (lost?.outcome !== 'QUEUED') {
        throw new Error(`Expected ${contested} to be queued, got ${lost?.outcome}.`);
      }
      // Queued for the spot it lost — the one spot on that day this transaction
      // knows for certain is occupied.
      expect(lost.parkingSpotId).toBe(planned.parkingSpotId);
      expect(lost.waitlistPosition).toBe(1);
      await expect(
        client.waitlistEntry.findUniqueOrThrow({ where: { id: lost.waitlistEntryId } })
      ).resolves.toMatchObject({ userId: booker.id, parkingSpotId: planned.parkingSpotId });

      // The competitor kept the contested cell, and the batch kept the other day.
      const contestedRow = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: {
            parkingSpotId: planned.parkingSpotId,
            date: toDateColumn(contested),
          },
        },
      });
      expect(contestedRow.userId).toBe(competitor.id);
      expect(result.days[1]?.outcome).toBe('SPOT_ASSIGNED');
      expect(
        await client.reservation.count({ where: { userId: booker.id, date: toDateColumn(spare) } })
      ).toBe(1);
      expect(
        await client.reservation.count({
          where: { userId: booker.id, date: toDateColumn(contested) },
        })
      ).toBe(0);
    });

    /**
     * The *other* reason an insert can be skipped, and the reason the
     * confirmation reads a second time before it queues anybody.
     *
     * Here the caller acquires a reservation of their own on the contested day —
     * another request of theirs, or a promotion — between this transaction's read
     * and its insert. `ON CONFLICT DO NOTHING` cannot say which of the two unique
     * indexes it hit, so the two cases are indistinguishable at the insert; only
     * `datesAlreadyReserved` separates them. Getting it wrong would queue somebody
     * for a spot they can never be promoted to, on a day they already have one —
     * exactly what `WaitlistService.join` refuses at the door.
     */
    it('reports ALREADY_HAS_RESERVATION, not a queue place, when the caller got a spot elsewhere', async () => {
      const booker = await seedUser(client);
      const [contested, spare] = BUSY_ELSEWHERE_DAYS as [DateOnly, DateOnly];
      // Sorts last, so the allocator will never propose it and the held row is
      // guaranteed to be on a *different* spot from the planned one.
      const elsewhere = await seedSpot(client, { labelPrefix: 'ZZZ' });

      const preview = await harness.bulk.preview(
        { dates: [contested, spare] },
        actorFor(booker),
        TODAY
      );
      const planned = preview.days[0];
      if (planned?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(`Expected the preview to assign ${contested}, got ${planned?.outcome}.`);
      }
      expect(planned.parkingSpotId).not.toBe(elsewhere.id);

      const held = holdTransaction(otherClient, (tx) =>
        tx.reservation.create({
          data: {
            parkingSpotId: elsewhere.id,
            userId: booker.id,
            date: toDateColumn(contested),
          },
        })
      );
      await held.ready;

      const confirming = harness.bulk.confirm(
        { dates: [contested, spare] },
        actorFor(booker),
        TODAY
      );
      await waitForBlockedBackend(client);

      held.release();
      await held.done;
      const result = await confirming;

      expect(result.days[0]).toEqual({
        outcome: 'UNAVAILABLE',
        date: contested,
        reason: 'ALREADY_HAS_RESERVATION',
      });
      expect(
        await client.waitlistEntry.count({
          where: { userId: booker.id, date: toDateColumn(contested) },
        })
      ).toBe(0);
      // They kept the one reservation they won elsewhere, and the batch kept the
      // other day.
      const own = await client.reservation.findMany({
        where: { userId: booker.id, date: toDateColumn(contested) },
      });
      expect(own.map((row) => row.parkingSpotId)).toEqual([elsewhere.id]);
      expect(result.days[1]?.outcome).toBe('SPOT_ASSIGNED');
    });

    /**
     * The same race, against a day the allocator planned to **queue**.
     *
     * `datesAlreadyReserved` used to be asked only about the days that *lost* a
     * spot, so a day the allocator had already decided to queue was never
     * re-checked. That left a real gap: the lot is full on that day, the caller is
     * promoted onto it (or books it from another tab) while this transaction is
     * running, and the confirmation writes them a queue entry for a day they now
     * hold — an entry that can never be promoted, and the exact state
     * `WaitlistService.join` refuses at the door.
     *
     * Forcing it needs both halves of the batch:
     *
     * - **the full day** is what the allocator plans to queue;
     * - **the contested day** is what makes the transaction *stop* between its
     *   read and its second read. Without an assigned day there is no reservation
     *   `INSERT` at all, so nothing blocks and nothing can interleave — which is
     *   why `waitForBlockedBackend` is here rather than a `Promise.all` and a
     *   hope. It throws if nothing ever blocks.
     *
     * The held transaction is the shape that really produces this in production:
     * a cancellation frees a spot on the full day and hands it to the caller,
     * exactly as `WaitlistPromotionService.promote` does.
     */
    it('does not queue a planned-QUEUED day the caller acquired a reservation on', async () => {
      const booker = await seedUser(client);
      const competitor = await seedUser(client);
      const [contested, full] = QUEUE_BUSY_DAYS as [DateOnly, DateOnly];
      await fillTheLot(full);

      // Which spot the confirmation will take on the contested day, learned
      // without writing anything.
      const preview = await harness.bulk.preview(
        { dates: [contested, full] },
        actorFor(booker),
        TODAY
      );
      const planned = preview.days[0];
      if (planned?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(`Expected the preview to assign ${contested}, got ${planned?.outcome}.`);
      }
      if (preview.days[1]?.outcome !== 'QUEUED') {
        throw new Error(`Expected ${full} to be queued, got ${preview.days[1]?.outcome}.`);
      }
      // Somebody else's reservation on the full day, to be cancelled and handed
      // to the booker while the confirmation is running.
      const freed = await client.reservation.findFirstOrThrow({
        where: { date: toDateColumn(full) },
        select: { id: true, parkingSpotId: true },
      });
      harness.publisher.reset();

      const held = holdTransaction(otherClient, async (tx) => {
        // Blocks the confirmation's reservation insert on the contested day.
        await tx.reservation.create({
          data: {
            parkingSpotId: planned.parkingSpotId,
            userId: competitor.id,
            date: toDateColumn(contested),
          },
        });
        // A cancellation and a promotion, on the day the confirmation is about to
        // queue the booker for.
        await tx.reservation.delete({ where: { id: freed.id } });
        await tx.reservation.create({
          data: {
            parkingSpotId: freed.parkingSpotId,
            userId: booker.id,
            date: toDateColumn(full),
          },
        });
      });
      await held.ready;

      const confirming = harness.bulk.confirm(
        { dates: [contested, full] },
        actorFor(booker),
        TODAY
      );
      await waitForBlockedBackend(client);

      held.release();
      await held.done;
      const result = await confirming;

      // The full day is reported as the day they now hold, not as a queue place…
      expect(result.days[1]).toEqual({
        outcome: 'UNAVAILABLE',
        date: full,
        reason: 'ALREADY_HAS_RESERVATION',
      });
      // …and, the part that is a bug rather than a wording choice, no entry was
      // written for it.
      expect(
        await client.waitlistEntry.count({
          where: { userId: booker.id, date: toDateColumn(full) },
        })
      ).toBe(0);
      // Nor was one broadcast: a queue that did not change is not news.
      expect(
        harness.publisher.ofKind('waitlist:updated').filter((event) => event.payload.date === full)
      ).toEqual([]);
      // They kept the spot the promotion gave them.
      expect(
        await client.reservation.count({ where: { userId: booker.id, date: toDateColumn(full) } })
      ).toBe(1);
      // And the contested day behaved as it always did: lost the cell, queued for
      // it. This is what keeps the case honest — the batch really did run.
      const lost = result.days[0];
      if (lost?.outcome !== 'QUEUED') {
        throw new Error(`Expected ${contested} to be queued, got ${lost?.outcome}.`);
      }
      expect(lost.parkingSpotId).toBe(planned.parkingSpotId);
    });
  });
});
