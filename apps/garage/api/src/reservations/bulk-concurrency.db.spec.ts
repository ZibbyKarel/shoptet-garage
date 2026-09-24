/**
 * Two bulk bookings at once. Real transactions, real unique keys, real
 * deadlocks.
 *
 * A bulk confirmation holds up to 31 uncommitted `(parkingSpotId, date)` keys at
 * a time, which is Task 13's deadlock risk multiplied by the size of the batch.
 * What keeps it from being a problem is one line in `bulk-allocator.ts` — the
 * ascending sort, the single authority for the order the rows are written in —
 * and this file is where that line stops being an argument:
 *
 * - **the brief's case**: two users booking *the same days in opposite request
 *   order* both succeed, and the database agrees with what each of them was
 *   told;
 * - **the same case, with the statement broken open**: a test-only `BEFORE
 *   INSERT … FOR EACH ROW` trigger stalls between the rows of the multi-row
 *   `INSERT`, so each caller is holding one key while reaching for the other.
 *   They still both succeed — and they stop doing so the moment the sort is
 *   deleted, which is what makes the sort falsifiable end to end rather than
 *   only by a unit test;
 * - **the cycle itself**: a competitor that takes the same two cells in the
 *   opposite order really does deadlock against a confirmation, and when it
 *   happens the batch is all-or-nothing and the caller is told `CONFLICT`
 *   rather than being handed a 500.
 *
 * The last case is what makes the first one meaningful. Without it "both
 * succeeded" could just mean the two requests never met.
 *
 * The days are in **February 2100**, which nothing else in the suite touches,
 * for the same reason `bulk-reservation.db.spec.ts` uses January: spots are
 * global in this database but days do not have to be.
 */

import type { PrismaClient } from '@garage/database';
import type { ConfirmBulkOutput } from '@garage/contract';
import type { DateOnly } from '@garage/shared-types';
import { isBusinessDay } from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import type { Harness } from '../testing/database/reservation-harness';
import {
  TODAY,
  actorFor,
  barrier,
  buildHarness,
  codeOfRejection,
  connect,
  seedSpot,
  seedUser,
  setLockMode,
  waitForBlockedBackend,
} from '../testing/database/reservation-harness';

/** Monday to Wednesday of the first full week of February 2100. */
const OPPOSITE_DAYS = ['2100-02-01', '2100-02-02', '2100-02-03'] as DateOnly[];
/** Thursday and Friday of the same week, for the deadlock case. */
const DEADLOCK_DAYS = ['2100-02-04', '2100-02-05'] as DateOnly[];
/** The Monday and Tuesday after, for the forced-interleaving case. */
const INTERLEAVED_DAYS = ['2100-02-08', '2100-02-09'] as DateOnly[];

/** How long the probe trigger stalls on each row it fires for. */
const PROBE_STALL_SECONDS = 0.3;

/**
 * A test-only `BEFORE INSERT … FOR EACH ROW` trigger that stalls on the days of
 * {@link INTERLEAVED_DAYS}, and nothing else.
 *
 * This is the yield point a multi-row `INSERT` otherwise does not offer *to
 * JavaScript*. It is not, as this task's first report claimed, a yield point
 * PostgreSQL does not have: a multi-row `INSERT` acquires its unique keys row by
 * row, and this project's own deadlock log catches one mid-statement
 * (`CONTEXT: while inserting index tuple`). A row-level `BEFORE` trigger fires
 * between those rows, after the previous row's key is already held — so the
 * interleaving that forms a cycle *can* be forced from outside the process, with
 * no change to production code whatsoever.
 *
 * Scoped to two days no other case touches, so it cannot slow or perturb
 * anything else in the run, and dropped in a `finally`.
 */
async function withProbeTrigger(work: () => Promise<void>, client: PrismaClient): Promise<void> {
  const days = INTERLEAVED_DAYS.map((date) => `DATE '${date}'`).join(', ');
  await client.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zz_bulk_write_order_probe() RETURNS trigger
    LANGUAGE plpgsql AS $probe$
    BEGIN
      IF NEW."date" IN (${days}) THEN
        PERFORM pg_sleep(${PROBE_STALL_SECONDS});
      END IF;
      RETURN NEW;
    END;
    $probe$
  `);
  await client.$executeRawUnsafe(`
    CREATE TRIGGER zz_bulk_write_order_probe
      BEFORE INSERT ON "Reservation"
      FOR EACH ROW EXECUTE FUNCTION zz_bulk_write_order_probe()
  `);
  try {
    await work();
  } finally {
    await client.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS zz_bulk_write_order_probe ON "Reservation"'
    );
    await client.$executeRawUnsafe('DROP FUNCTION IF EXISTS zz_bulk_write_order_probe()');
  }
}

describe('two bulk bookings at once', () => {
  let client: PrismaClient;
  /** A second pool, so the two sides of a race are genuinely separate sessions. */
  let otherClient: PrismaClient;
  let harness: Harness;
  let otherHarness: Harness;

  beforeAll(async () => {
    client = connect();
    otherClient = connect();
    harness = buildHarness(client);
    otherHarness = buildHarness(otherClient);
    // At least one spot of our own, so the lot is never empty.
    await seedSpot(client);
  });

  afterAll(async () => {
    await Promise.all([client.$disconnect(), otherClient.$disconnect()]);
  });

  beforeEach(async () => {
    harness.publisher.reset();
    otherHarness.publisher.reset();
    // February 2100 is far outside the automatic window; these cases are about
    // concurrency, not about the window.
    await setLockMode(client, 'FORCE_OPEN');
  });

  /**
   * Every day of a result really happened, exactly as the caller was told.
   *
   * Written as a check of the *result against the database* rather than against
   * an expected literal, because which of two racing callers wins is genuinely
   * not determined — but "what you were told is what is stored" is, and that is
   * the claim a user of this API depends on.
   */
  async function assertResultMatchesDatabase(
    result: ConfirmBulkOutput,
    userId: string
  ): Promise<void> {
    for (const day of result.days) {
      if (day.outcome === 'SPOT_ASSIGNED') {
        await expect(
          client.reservation.findUniqueOrThrow({ where: { id: day.reservationId } })
        ).resolves.toMatchObject({
          userId,
          parkingSpotId: day.parkingSpotId,
          date: toDateColumn(day.date),
        });
        continue;
      }
      if (day.outcome === 'QUEUED') {
        await expect(
          client.waitlistEntry.findUniqueOrThrow({ where: { id: day.waitlistEntryId } })
        ).resolves.toMatchObject({
          userId,
          parkingSpotId: day.parkingSpotId,
          date: toDateColumn(day.date),
        });
        continue;
      }
      // `UNAVAILABLE` means nothing was written for that day, in either table.
      expect(
        await client.reservation.count({ where: { userId, date: toDateColumn(day.date) } })
      ).toBe(0);
    }
  }

  it('uses fixture days that mean what the cases below assume', () => {
    const everyDay = [...OPPOSITE_DAYS, ...DEADLOCK_DAYS, ...INTERLEAVED_DAYS];
    for (const date of everyDay) {
      expect(isBusinessDay(date)).toBe(true);
    }
    // No case borrows another's day, so they stay independent of run order.
    expect(new Set(everyDay).size).toBe(everyDay.length);
  });

  describe('the same days, requested in opposite order', () => {
    it('lets both callers through and tells each of them the truth', async () => {
      const [first, second] = [await seedUser(client), await seedUser(client)];
      const forwards = OPPOSITE_DAYS;
      const backwards = [...OPPOSITE_DAYS].reverse();

      const outcomes = await Promise.allSettled([
        harness.bulk.confirm({ dates: forwards }, actorFor(first), TODAY),
        otherHarness.bulk.confirm({ dates: backwards }, actorFor(second), TODAY),
      ]);

      // Neither may fail. With the allocator's ascending sort removed the two
      // transactions take the same cells in opposite order and one of them comes
      // back `40P01 deadlock detected` — see the task report.
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      const [firstResult, secondResult] = outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? (outcome.value as ConfirmBulkOutput) : undefined
      );
      if (firstResult === undefined || secondResult === undefined) {
        throw new Error('Both confirmations were expected to have succeeded.');
      }

      expect(firstResult.days.map((day) => day.date)).toEqual(forwards);
      expect(secondResult.days.map((day) => day.date)).toEqual(backwards);
      await assertResultMatchesDatabase(firstResult, first.id);
      await assertResultMatchesDatabase(secondResult, second.id);

      for (const date of OPPOSITE_DAYS) {
        // The rule the unique indexes are there for: nobody holds two spots on
        // one day, and no cell was handed to two people.
        for (const user of [first, second]) {
          expect(
            await client.reservation.count({
              where: { userId: user.id, date: toDateColumn(date) },
            })
          ).toBeLessThanOrEqual(1);
        }
        const held = await client.reservation.findMany({
          where: { date: toDateColumn(date), userId: { in: [first.id, second.id] } },
          select: { parkingSpotId: true },
        });
        expect(new Set(held.map((row) => row.parkingSpotId)).size).toBe(held.length);
      }
    });
  });

  describe('a forced interleaving inside one multi-row INSERT', () => {
    /**
     * The case that makes the ascending sort falsifiable end to end.
     *
     * Two real confirmations, the same two days, opposite request order — the
     * case above — but with {@link withProbeTrigger} stalling each row of the
     * reservation `INSERT` for {@link PROBE_STALL_SECONDS}. Both callers read the
     * same world, so both plan the same spot, and the trigger guarantees each of
     * them is holding its first day's unique key while the other reaches for its
     * second.
     *
     * With the sort in place both write ascending: one takes the earlier day, the
     * other blocks on it holding nothing, and they serialise. Delete
     * `allocateBulk`'s `[...request.dates].sort(compareDateOnly)` and they write
     * in request order — one forwards, one backwards — each holding what the
     * other wants, and PostgreSQL kills a side with `40P01` → `P2034` →
     * `CONFLICT`. Measured: 3/3 fulfilled with the sort, 3/3 with one side
     * rejected without it. See `doc/decision/0092-*` §"One authority".
     *
     * `waitForBlockedBackend` is what stops this from being two requests that
     * never met: it throws if no backend ever waits on a lock, which is exactly
     * what would happen if the two callers had planned different spots.
     */
    it('still lets two opposite-order confirmations through', async () => {
      const [first, second] = [await seedUser(client), await seedUser(client)];
      const forwards = INTERLEAVED_DAYS;
      const backwards = [...INTERLEAVED_DAYS].reverse();

      await withProbeTrigger(async () => {
        const confirming = harness.bulk.confirm({ dates: forwards }, actorFor(first), TODAY);
        const competing = otherHarness.bulk.confirm({ dates: backwards }, actorFor(second), TODAY);
        // Attached now, before the first `await`, so a rejection is never
        // momentarily unhandled.
        const settled = Promise.allSettled([confirming, competing]);
        await waitForBlockedBackend(client);

        const outcomes = await settled;
        // Reported with the contract code rather than as a bare status, so that
        // when this does fail the output says *why* — `rejected CONFLICT` is the
        // deadlock, and it is the whole point of the case.
        expect(
          outcomes.map((outcome) =>
            outcome.status === 'fulfilled' ? 'fulfilled' : `rejected ${codeOfRejection(outcome)}`
          )
        ).toEqual(['fulfilled', 'fulfilled']);
      }, client);

      for (const date of INTERLEAVED_DAYS) {
        const held = await client.reservation.findMany({
          where: { date: toDateColumn(date), userId: { in: [first.id, second.id] } },
          select: { userId: true, parkingSpotId: true },
        });
        // Exactly one of the two got the cell. Two rows would mean they planned
        // different spots and never contended, and the case proved nothing.
        expect(held).toHaveLength(1);
        const loser = held[0]?.userId === first.id ? second : first;
        expect(
          await client.waitlistEntry.count({
            where: { userId: loser.id, date: toDateColumn(date) },
          })
        ).toBe(1);
      }
    });
  });

  describe('a competitor that takes the same cells in the opposite order', () => {
    /**
     * The cycle, built by hand.
     *
     * The competitor is what an *unsorted* bulk confirmation would be: it takes
     * the later day first, waits, then reaches back for the earlier one. The
     * real confirmation takes them in ascending order, so:
     *
     * ```
     * confirmBulk                         competitor
     * INSERT (X, Feb 4)             ✓     INSERT (X, Feb 5)              ✓
     * INSERT (X, Feb 5) → waits on the competitor's uncommitted key
     *                                     INSERT (X, Feb 4) → waits on ours
     * ```
     *
     * PostgreSQL detects the cycle and kills one side. Which side is up to the
     * server — the backend whose lock wait times out first runs the detector and
     * aborts itself.
     *
     * **The caller no longer sees it.** `committedConfirm` retries on any write
     * conflict (`doc/decision/0307-*`, added for the monthly cap's advisory-lock
     * cycle, but not narrowable to it — a `40P01` from a cell-ordering cycle and
     * one from the cap cycle are the same error). By the time the retry starts
     * the competitor has settled, so it cannot deadlock again: it re-reads and
     * queues the days the competitor took. `CONFLICT` is reachable only if
     * `MAX_CANCEL_ATTEMPTS` attempts all lose, which this case cannot produce
     * with a single competitor.
     *
     * So what is asserted is: the cycle really formed
     * (`waitForBlockedBackend`), the confirmation came back rather than
     * failing, and the outcome is all-or-nothing — either the competitor
     * committed both cells and the booker holds neither, or the competitor was
     * the victim and the booker holds both. Never one of each.
     *
     * That the retry also absorbs this deadlock is a widening the monthly cap
     * paid for: this case used to be the end-to-end falsification of
     * `allocateBulk`'s ascending sort, and it no longer is. See
     * `doc/decision/0307-*` §"What is not tested".
     */
    it('deadlocks, and the retry absorbs it without a half-written batch', async () => {
      const booker = await seedUser(client);
      const competitor = await seedUser(client);
      const [earlier, later] = DEADLOCK_DAYS as [DateOnly, DateOnly];

      // Which spot the confirmation will choose, learned without writing.
      const preview = await harness.bulk.preview(
        { dates: [earlier, later] },
        actorFor(booker),
        TODAY
      );
      const planned = preview.days[0];
      if (planned?.outcome !== 'SPOT_ASSIGNED') {
        throw new Error(`Expected the preview to assign ${earlier}, got ${planned?.outcome}.`);
      }
      const spotId = planned.parkingSpotId;

      const reached = barrier();
      const gate = barrier();

      const competing = otherClient
        .$transaction(
          async (tx) => {
            await tx.reservation.create({
              data: { parkingSpotId: spotId, userId: competitor.id, date: toDateColumn(later) },
            });
            reached.release();
            await gate.wait;
            // Reaching *back* for the earlier day is what closes the cycle.
            await tx.reservation.create({
              data: { parkingSpotId: spotId, userId: competitor.id, date: toDateColumn(earlier) },
            });
          },
          { maxWait: 10_000, timeout: 60_000 }
        )
        .then(() => undefined);
      await reached.wait;

      const confirming = harness.bulk.confirm({ dates: [earlier, later] }, actorFor(booker), TODAY);
      // The confirmation has taken the earlier day and is now stuck on the later
      // one. Throws if nothing ever blocks, so this cannot silently become a
      // test of two operations that ran in sequence.
      await waitForBlockedBackend(client);

      gate.release();
      const outcomes = await Promise.allSettled([confirming, competing]);

      const [bulkOutcome, competitorOutcome] = outcomes;
      if (bulkOutcome === undefined || competitorOutcome === undefined) {
        throw new Error('Missing a settlement.');
      }

      // The confirmation always comes back. Reported with the contract code
      // rather than as a bare status, so a regression says *why*: `rejected
      // CONFLICT` here means the retry stopped absorbing the deadlock.
      expect(
        bulkOutcome.status === 'fulfilled'
          ? 'fulfilled'
          : `rejected ${codeOfRejection(bulkOutcome)}`
      ).toBe('fulfilled');
      if (bulkOutcome.status !== 'fulfilled') {
        throw new Error('unreachable — asserted above');
      }

      // Whatever the confirmation reports, the database agrees with it: no
      // half-written batch, no queue entry for a day it says it holds.
      await assertResultMatchesDatabase(bulkOutcome.value, booker.id);

      // Counted on the contested spot only. Spots are global in this database,
      // so when another suite has run first (Jest runs previously failed files
      // first, too) the retry finds a free spot elsewhere and assigns it — a
      // total across all spots then says nothing about the cycle, and this case
      // failed with `2` below whenever it ran after a suite that seeds spots.
      const heldByBooker = await client.reservation.count({
        where: {
          userId: booker.id,
          parkingSpotId: spotId,
          date: { in: DEADLOCK_DAYS.map(toDateColumn) },
        },
      });

      if (competitorOutcome.status === 'fulfilled') {
        // The confirmation was the victim; its retry found both cells taken and
        // queued the booker for them, or placed them elsewhere. Never on X.
        expect(heldByBooker).toBe(0);
      } else {
        // The competitor was the victim; the confirmation's first attempt stood.
        expect(heldByBooker).toBe(2);
      }
    });
  });
});
