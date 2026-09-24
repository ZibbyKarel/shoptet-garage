/**
 * The monthly-cap helper against a real PostgreSQL 17.
 *
 * Run with `nx run api:test-db` after `docker compose --profile dev up -d`.
 */
import { RESERVATION_LIMIT_SETTINGS_ID, type PrismaClient } from '@garage/database';
import { addDays, isBusinessDay, toYearMonth, type DateOnly } from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import type { Harness } from '../testing/database/reservation-harness';
import {
  FUTURE_BUSINESS_DAY,
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
import {
  DEFAULT_MONTHLY_RESERVATION_CAP,
  assertWithinMonthlyReservationCap,
  readMonthlyReservationCap,
} from './monthly-reservation-cap';

/**
 * `count` business days in the same calendar month as `FUTURE_BUSINESS_DAY`,
 * starting from it.
 *
 * Typed as a non-empty tuple — every caller passes a `count >= 1` and asks for
 * the first date — so indexing `[0]` type-checks under `noUncheckedIndexedAccess`
 * without a non-null assertion, which this project's lint config forbids.
 */
function businessDaysInMonth(count: number): [DateOnly, ...DateOnly[]] {
  if (count < 1) {
    throw new Error('count must be at least 1');
  }
  const month = FUTURE_BUSINESS_DAY.slice(0, 7);
  const dates: DateOnly[] = [];
  let cursor = FUTURE_BUSINESS_DAY;
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
  return dates as [DateOnly, ...DateOnly[]];
}

/**
 * `arr[index]`, but typed as `T` rather than `T | undefined`.
 *
 * A plain runtime guard rather than a non-null assertion: this project's lint
 * config forbids `!` (`@typescript-eslint/no-non-null-assertion`), and this is
 * the one place below that needs an index past position `0`, which
 * `businessDaysInMonth`'s tuple return does not cover.
 */
function nth<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`index ${index} out of range for an array of length ${arr.length}`);
  }
  return value;
}

describe('assertWithinMonthlyReservationCap against a real PostgreSQL', () => {
  let client: PrismaClient;

  beforeAll(() => {
    client = connect();
  });

  /**
   * The three configured-cap tests below mutate the settings singleton every
   * other test in this file reads, so it is put back after each one. There is no
   * other cleanup convention in this file — the rest of it only ever appends
   * rows — so this `afterEach` is new; `--runInBand` in `api:test-db` means one
   * suite at a time, so restoring here is enough.
   */
  afterEach(async () => {
    await client.reservationLimitSettings.upsert({
      where: { id: RESERVATION_LIMIT_SETTINGS_ID },
      create: {
        id: RESERVATION_LIMIT_SETTINGS_ID,
        monthlyReservationCap: DEFAULT_MONTHLY_RESERVATION_CAP,
      },
      update: { monthlyReservationCap: DEFAULT_MONTHLY_RESERVATION_CAP },
    });
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it('passes when the user is under the cap for the month', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    const dates = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP - 1);
    for (const date of dates) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }

    await expect(
      client.$transaction((tx) =>
        assertWithinMonthlyReservationCap(tx, user.id, dates[0], 1, DEFAULT_MONTHLY_RESERVATION_CAP)
      )
    ).resolves.toBeUndefined();
  });

  it('rejects with MONTHLY_RESERVATION_LIMIT_REACHED once the cap would be exceeded', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    const dates = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP);
    for (const date of dates) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }

    const code = await codeOf(
      client.$transaction((tx) =>
        assertWithinMonthlyReservationCap(tx, user.id, dates[0], 1, DEFAULT_MONTHLY_RESERVATION_CAP)
      )
    );
    expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');
  });

  it("does not count another user's reservations toward this user's cap", async () => {
    const [userA, userB] = [await seedUser(client), await seedUser(client)];
    const spot = await seedSpot(client);
    const dates = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP);
    for (const date of dates) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: userB.id, date: toDateColumn(date) },
      });
    }

    await expect(
      client.$transaction((tx) =>
        assertWithinMonthlyReservationCap(
          tx,
          userA.id,
          dates[0],
          1,
          DEFAULT_MONTHLY_RESERVATION_CAP
        )
      )
    ).resolves.toBeUndefined();
  });

  it('does not count a reservation in a different calendar month', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    // `CAP - 1` in-month rows, so the assertion below sits exactly on the cap:
    // 4 + 1 = 5 passes, and the next-month row counted too would be 5 + 1 = 6
    // and would throw. Seeding fewer would make this test pass either way —
    // which it did, until the numbers were tightened to discriminate.
    const [inMonth, ...rest] = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP);
    for (const date of rest) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }
    // One more, next month — must not push this month's count over the cap.
    const nextMonthDay = addDays(inMonth, 32) as DateOnly;
    expect(toYearMonth(nextMonthDay)).not.toBe(toYearMonth(inMonth));
    await client.reservation.create({
      data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(nextMonthDay) },
    });

    await expect(
      client.$transaction((tx) =>
        assertWithinMonthlyReservationCap(tx, user.id, inMonth, 1, DEFAULT_MONTHLY_RESERVATION_CAP)
      )
    ).resolves.toBeUndefined();
  });

  it('serializes two callers on the same (user, month), so the recount is authoritative', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    const dates = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP);
    for (const date of dates.slice(0, DEFAULT_MONTHLY_RESERVATION_CAP - 1)) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }
    const lastDate = nth(dates, DEFAULT_MONTHLY_RESERVATION_CAP - 1);

    const other = connect();
    try {
      // A: passes at CAP-1, inserts the CAP-th row, then holds its locks.
      const held = holdTransaction(client, async (tx) => {
        await assertWithinMonthlyReservationCap(
          tx,
          user.id,
          dates[0],
          1,
          DEFAULT_MONTHLY_RESERVATION_CAP
        );
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(lastDate) },
        });
      });
      await held.ready;

      // B: must block on the advisory lock, not read a stale count of CAP-1.
      const second = codeOf(
        other.$transaction((tx) =>
          assertWithinMonthlyReservationCap(
            tx,
            user.id,
            dates[0],
            1,
            DEFAULT_MONTHLY_RESERVATION_CAP
          )
        )
      );
      await waitForBlockedBackend(other);
      held.release();
      await held.done;

      expect(await second).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');
    } finally {
      await other.$disconnect();
    }
  });

  it('enforces the configured cap, not the default, once an admin has lowered it', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    await client.reservationLimitSettings.update({
      where: { id: RESERVATION_LIMIT_SETTINGS_ID },
      data: { monthlyReservationCap: 2 },
    });
    const dates = businessDaysInMonth(2);
    for (const date of dates) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }

    const code = await codeOf(
      client.$transaction(async (tx) => {
        const cap = await readMonthlyReservationCap(tx);
        return assertWithinMonthlyReservationCap(tx, user.id, nth(dates, 0), 1, cap);
      })
    );

    expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');
  });

  it('allows a sixth reservation once an admin has raised the cap above the default', async () => {
    const user = await seedUser(client);
    const spot = await seedSpot(client);
    await client.reservationLimitSettings.update({
      where: { id: RESERVATION_LIMIT_SETTINGS_ID },
      data: { monthlyReservationCap: 6 },
    });
    const dates = businessDaysInMonth(6);
    for (const date of dates.slice(0, 5)) {
      await client.reservation.create({
        data: { parkingSpotId: spot.id, userId: user.id, date: toDateColumn(date) },
      });
    }

    await expect(
      client.$transaction(async (tx) => {
        const cap = await readMonthlyReservationCap(tx);
        return assertWithinMonthlyReservationCap(tx, user.id, nth(dates, 5), 1, cap);
      })
    ).resolves.toBeUndefined();
  });

  it('reads the default when the singleton row is absent', async () => {
    await client.reservationLimitSettings.deleteMany({});

    const cap = await client.$transaction((tx) => readMonthlyReservationCap(tx));

    expect(cap).toBe(DEFAULT_MONTHLY_RESERVATION_CAP);
  });

  /**
   * The three production call sites, each driven through its own service with a
   * cap an admin has changed.
   *
   * These exist because everything above them — and every unit spec — answers
   * `DEFAULT_MONTHLY_RESERVATION_CAP` for a different reason: the tests above
   * call the helper pair directly, `PrismaDouble`'s limit settings start `null`
   * so the double answers the default, and every other database suite reads the
   * stored 5 the migration inserted, which *equals* the constant. So an edit
   * that replaced `cap` with `DEFAULT_MONTHLY_RESERVATION_CAP` at
   * `reservations.service.ts`, `bulk-reservation.service.ts` or
   * `waitlist-promotion.service.ts` used to pass the entire workspace. Each
   * test below is written so that it would fail under the default and pass only
   * under the configured number, which is the whole point of having it.
   *
   * They live in this file rather than beside each service's own suite for the
   * settings singleton's sake: the restore is the sharp edge, this file already
   * owns it in one `afterEach`, and spreading the same mutate-and-restore into
   * three suites that never touch that row would be three chances to leave a
   * lowered cap behind for whatever runs next.
   */
  describe('through the services, with a cap an admin has changed', () => {
    let harness: Harness;

    beforeAll(() => {
      harness = buildHarness(client);
    });

    /**
     * `AUTO` with the suite's `TODAY` (2098-12-29), which lies inside
     * January 2099's window: the cap only applies there
     * (`doc/decision/0315-the-monthly-cap-applies-only-inside-the-auto-window`),
     * so `FORCE_OPEN` — used here before — would switch it off.
     */
    beforeEach(async () => {
      harness.publisher.reset();
      await setLockMode(client, 'AUTO');
    });

    /** Rows written straight to the database, to put `user` at `count` for the month. */
    async function fillMonth(
      userId: string,
      dates: readonly DateOnly[],
      spotId: string
    ): Promise<void> {
      for (const date of dates) {
        await client.reservation.create({
          data: { parkingSpotId: spotId, userId, date: toDateColumn(date) },
        });
      }
    }

    async function setCap(monthlyReservationCap: number): Promise<void> {
      await client.reservationLimitSettings.upsert({
        where: { id: RESERVATION_LIMIT_SETTINGS_ID },
        create: { id: RESERVATION_LIMIT_SETTINGS_ID, monthlyReservationCap },
        update: { monthlyReservationCap },
      });
    }

    it('refuses a single-day reservation at a lowered cap that the default would allow', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client);
      await setCap(2);
      // Two days used, a third asked for: over a cap of 2, comfortably under
      // the default of 5. A service still reading the constant would succeed.
      const dates = businessDaysInMonth(3);
      await fillMonth(user.id, dates.slice(0, 2), spot.id);

      const code = await codeOf(
        harness.reservations.create(
          { parkingSpotId: spot.id, date: nth(dates, 2) },
          actorFor(user),
          TODAY
        )
      );

      expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');
    });

    it('accepts a single-day reservation at a raised cap that the default would refuse', async () => {
      const user = await seedUser(client);
      const spot = await seedSpot(client);
      await setCap(DEFAULT_MONTHLY_RESERVATION_CAP + 2);
      // Exactly `DEFAULT` days used, so the next one is the first the default
      // would reject: a service still reading the constant would refuse it.
      const dates = businessDaysInMonth(DEFAULT_MONTHLY_RESERVATION_CAP + 1);
      await fillMonth(user.id, dates.slice(0, DEFAULT_MONTHLY_RESERVATION_CAP), spot.id);

      const created = await harness.reservations.create(
        { parkingSpotId: spot.id, date: nth(dates, DEFAULT_MONTHLY_RESERVATION_CAP) },
        actorFor(user),
        TODAY
      );

      expect(created.date).toBe(nth(dates, DEFAULT_MONTHLY_RESERVATION_CAP));
    });

    it("measures a bulk confirmation's assigned days against the lowered cap", async () => {
      const user = await seedUser(client);
      // At least one free spot on those days, so the allocator assigns all
      // three rather than queueing them — `assignedCount` is what the cap check
      // is handed, and a queued day contributes nothing to it.
      await seedSpot(client);
      await setCap(2);
      const dates = businessDaysInMonth(3);

      const code = await codeOf(harness.bulk.confirm({ dates }, actorFor(user), TODAY));

      expect(code).toBe('MONTHLY_RESERVATION_LIMIT_REACHED');
      expect(await client.reservation.count({ where: { userId: user.id } })).toBe(0);
    });

    it('skips a waitlist candidate who is at the lowered cap, and promotes the next one', async () => {
      const [holder, firstInLine, secondInLine] = [
        await seedUser(client),
        await seedUser(client),
        await seedUser(client),
      ];
      const [contested, filler] = [await seedSpot(client), await seedSpot(client)];
      await setCap(3);
      const dates = businessDaysInMonth(4);
      const contestedDay = dates[0];

      await harness.reservations.create(
        { parkingSpotId: contested.id, date: contestedDay },
        actorFor(holder),
        TODAY
      );
      // Both join while still under the cap — `join` checks the target's cap
      // too, so the queue has to be formed before the month is filled.
      await harness.waitlist.join(
        { parkingSpotId: contested.id, date: contestedDay },
        actorFor(firstInLine),
        TODAY
      );
      await harness.waitlist.join(
        { parkingSpotId: contested.id, date: contestedDay },
        actorFor(secondInLine),
        TODAY
      );
      // Three days on *other* dates: `eligibleInOrder` already filters somebody
      // who holds the contested day itself, so filling that day would make this
      // test pass without the cap being consulted at all.
      await fillMonth(firstInLine.id, dates.slice(1), filler.id);

      const reservation = await client.reservation.findUniqueOrThrow({
        where: {
          parkingSpotId_date: {
            parkingSpotId: contested.id,
            date: toDateColumn(contestedDay),
          },
        },
      });
      await harness.reservations.cancel({ reservationId: reservation.id }, actorFor(holder), TODAY);

      // Under the default cap of 5 the person first in line is under their
      // budget and takes the spot; under the configured 3 they are skipped.
      const promoted = await client.reservation.findUnique({
        where: {
          parkingSpotId_date: {
            parkingSpotId: contested.id,
            date: toDateColumn(contestedDay),
          },
        },
      });
      expect(promoted?.userId).toBe(secondInLine.id);
    });
  });
});
