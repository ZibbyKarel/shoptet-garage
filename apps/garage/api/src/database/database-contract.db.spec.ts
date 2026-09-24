/**
 * What the **database** does — pinned against a real PostgreSQL 17.
 *
 * Every other spec in `apps/garage/api` runs against `PrismaDouble`, an in-memory
 * stand-in. A double is fine for logic, but it must never be the only thing
 * that decides what a database *error* looks like, and this suite exists
 * because it once was: `PrismaDouble` fabricated `P2002` with a `meta.target`
 * key, the real `@prisma/adapter-pg` emits no such key, and every unique
 * violation therefore degraded to the vague `CONFLICT` — including
 * `SPOT_ALREADY_RESERVED`, which `plan.md` names as the concurrency guarantee
 * of the whole reservation flow. The mapping was unit-tested and green
 * throughout. Nothing short of a real connection could have caught it.
 *
 * ## Why this is a separate target
 *
 * `nx run-many -t test` has to stay runnable without Docker, so these tests are
 * **excluded** from the `api:test` target by `testPathIgnorePatterns` and run by
 * `nx run api:test-db` instead. They deliberately do **not** skip themselves
 * when `DATABASE_URL` is absent — a suite that skips into green is exactly the
 * false confidence this file was written to remove. No database, no run.
 *
 * ## Why nothing is left behind
 *
 * Every case runs inside an interactive transaction that is always rolled back:
 * the fixtures are created, the constraint is provoked, the error propagates out
 * of the callback and Prisma rolls the whole thing back. That is also the only
 * way to test the `AuditLog` triggers at all — the table rejects `DELETE`, so a
 * row inserted to test it could never be cleaned up any other way.
 */

import { Prisma } from '@garage/database';
import type { PrismaClient } from '@garage/database';
import { createPrismaClient } from '@garage/database';
import { requireDatabaseUrl, unique } from '../testing/database/test-database';
import {
  isTimedReservationConflict,
  isWriteConflict,
  mapPrismaErrorCode,
  mapUniqueConstraintViolation,
} from '../common/errors/prisma-error-mapping';

const DATE = new Date('2099-01-05T00:00:00.000Z');

/**
 * Runs `work` inside a transaction that is **always** rolled back, and returns
 * the error the database raised.
 *
 * Fails the test if the statement succeeded: "no error" and "the wrong error"
 * have to be distinguishable, and a bare `expect(...).rejects` would let a
 * silent success through as a passing assertion about `undefined`.
 */
async function rejectedBy(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<unknown>
): Promise<unknown> {
  const marker = Symbol('rolled back');
  try {
    await prisma.$transaction(async (tx) => {
      await work(tx);
      throw marker;
    });
  } catch (error) {
    if (error === marker) {
      throw new Error('Expected the database to reject this statement, but it succeeded.');
    }
    return error;
  }
  throw new Error('The transaction resolved without rolling back.');
}

/** A promise with its resolver, for steering two transactions into each other. */
function resolvable(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function seedUser(tx: Prisma.TransactionClient) {
  return tx.user.create({
    data: {
      email: `${unique('user')}@example.test`,
      name: 'Database contract fixture',
      oktaId: unique('okta'),
      icsToken: unique('ics'),
    },
  });
}

async function seedSpot(tx: Prisma.TransactionClient) {
  return tx.parkingSpot.create({ data: { label: unique('SPOT'), group: 'IT' } });
}

describe('what PostgreSQL actually does', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: requireDatabaseUrl() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the shape of a unique-constraint violation', () => {
    it('is P2002 with no `target` key at all, and names the index under the driver adapter', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        const [one, two] = [await seedUser(tx), await seedUser(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: one.id, date: DATE },
        });
        return tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: two.id, date: DATE },
        });
      });

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(known.code).toBe('P2002');

      // The fact the mapper has to be built around: Prisma's documented
      // `meta.target` is simply not there on this driver.
      expect(known.meta).toBeDefined();
      expect(known.meta).not.toHaveProperty('target');

      // What *is* there, and what the fallback reads.
      expect(known.meta).toMatchObject({
        driverAdapterError: {
          cause: {
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'Reservation_parkingSpotId_date_key' },
          },
        },
      });
    });
  });

  describe('a reservation has exactly one holder', () => {
    it('rejects a row with neither a userId nor a guest name', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        return tx.$executeRaw`
          INSERT INTO "Reservation" ("id", "parkingSpotId", "userId", "guestName", "date")
          VALUES (gen_random_uuid(), ${spot.id}::uuid, NULL, NULL, ${DATE})
        `;
      });

      expect(String(error)).toContain('Reservation_holder_check');
    });

    it('rejects a row that is both a user and a guest', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const [spot, user] = [await seedSpot(tx), await seedUser(tx)];
        return tx.$executeRaw`
          INSERT INTO "Reservation" ("id", "parkingSpotId", "userId", "guestName", "date")
          VALUES (gen_random_uuid(), ${spot.id}::uuid, ${user.id}::uuid, 'Jan Host', ${DATE})
        `;
      });

      expect(String(error)).toContain('Reservation_holder_check');
    });

    it('accepts a guest row, and lets two guests share a day', async () => {
      // Both inserts are inside one rolled-back transaction, so nothing is left
      // behind. `(userId, date)` cannot stop these: NULLs do not collide.
      const rolledBack = prisma.$transaction(async (tx) => {
        const [one, two] = [await seedSpot(tx), await seedSpot(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: one.id, guestName: 'Jan Host', date: DATE },
        });
        await tx.reservation.create({
          data: { parkingSpotId: two.id, guestName: 'Eva Hostová', date: DATE },
        });
        throw new Error('rollback');
      });

      await expect(rolledBack).rejects.toThrow('rollback');
    });
  });

  describe('every unique constraint maps to the contract error it means', () => {
    it('Reservation(parkingSpotId, date) is SPOT_ALREADY_RESERVED', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        const [one, two] = [await seedUser(tx), await seedUser(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: one.id, date: DATE },
        });
        return tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: two.id, date: DATE },
        });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapUniqueConstraintViolation(known.meta)).toBe('SPOT_ALREADY_RESERVED');
      expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
    });

    it('Reservation(userId, date) is RESERVATION_LIMIT_REACHED', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const [first, second] = [await seedSpot(tx), await seedSpot(tx)];
        const user = await seedUser(tx);
        await tx.reservation.create({
          data: { parkingSpotId: first.id, userId: user.id, date: DATE },
        });
        return tx.reservation.create({
          data: { parkingSpotId: second.id, userId: user.id, date: DATE },
        });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapUniqueConstraintViolation(known.meta)).toBe('RESERVATION_LIMIT_REACHED');
    });

    it('WaitlistEntry(parkingSpotId, userId, date) is ALREADY_IN_WAITLIST', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        const user = await seedUser(tx);
        await tx.waitlistEntry.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
        return tx.waitlistEntry.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapUniqueConstraintViolation(known.meta)).toBe('ALREADY_IN_WAITLIST');
    });

    it('ParkingSpot(label) degrades to the vague CONFLICT, which is correct', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        return tx.parkingSpot.create({ data: { label: spot.label, group: 'SHARED' } });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      // Not a reservation conflict, and the contract has no code for "that
      // label is taken" — `CONFLICT` is the honest answer, not a gap.
      expect(mapUniqueConstraintViolation(known.meta)).toBe('CONFLICT');
    });

    it('User(email) degrades to CONFLICT', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const user = await seedUser(tx);
        return tx.user.create({
          data: {
            email: user.email,
            name: 'Duplicate',
            oktaId: unique('okta'),
            icsToken: unique('ics'),
          },
        });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapUniqueConstraintViolation(known.meta)).toBe('CONFLICT');
    });
  });

  describe('the AuditLog append-only triggers', () => {
    async function withAuditRow(
      change: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>
    ): Promise<unknown> {
      return rejectedBy(prisma, async (tx) => {
        const actor = await seedUser(tx);
        const row = await tx.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'SPOT_UPDATED',
            entityType: 'ParkingSpot',
            entityId: 'fixture',
            payload: { change: 'created' },
          },
        });
        return change(tx, row.id);
      });
    }

    it('rejects an UPDATE', async () => {
      const error = await withAuditRow((tx, id) =>
        tx.auditLog.update({ where: { id }, data: { entityId: 'tampered' } })
      );
      expect(String(error)).toMatch(/append-only|AuditLog/i);
    });

    it('rejects a DELETE', async () => {
      const error = await withAuditRow((tx, id) => tx.auditLog.delete({ where: { id } }));
      expect(String(error)).toMatch(/append-only|AuditLog/i);
    });
  });

  describe('the shape of a deadlock', () => {
    /**
     * Task 13's cancellation path retries `P2034`, and this is what it is
     * retrying. Pinned here for the same reason `P2002` is: the code and the
     * `meta` are what the mapping and the retry predicate read, and neither is
     * something a double should be trusted to describe.
     *
     * Two transactions, two rows, opposite orders — the textbook cycle. It is
     * built out of `parkingSpot.update` rather than out of reservations so that
     * it stays a statement about PostgreSQL, independent of any domain logic.
     */
    it('is P2034 carrying the driver’s own 40P01', async () => {
      const [first, second] = await Promise.all([
        prisma.parkingSpot.create({ data: { label: unique('SPOT'), group: 'IT' } }),
        prisma.parkingSpot.create({ data: { label: unique('SPOT'), group: 'IT' } }),
      ]);

      // `try/finally` around everything after the two rows exist. The cleanup
      // used to be the last statement, so any assertion between here and it
      // leaked two `ParkingSpot` rows into the shared database — contradicting
      // this file's own "Why nothing is left behind" header, and leaving a
      // failing run to poison the next one's `SPOT_ORDER` assertions.
      try {
        const reached = { one: resolvable(), two: resolvable() };
        const lockThen = async (own: string, other: string, mine: keyof typeof reached) => {
          await prisma.$transaction(
            async (tx) => {
              await tx.parkingSpot.update({ where: { id: own }, data: { group: 'SHARED' } });
              reached[mine].resolve();
              // Both transactions hold one row and reach for the other's.
              await Promise.all([reached.one.promise, reached.two.promise]);
              await tx.parkingSpot.update({ where: { id: other }, data: { group: 'SHARED' } });
            },
            { maxWait: 10_000, timeout: 30_000 }
          );
        };

        const outcomes = await Promise.allSettled([
          lockThen(first.id, second.id, 'one'),
          lockThen(second.id, first.id, 'two'),
        ]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        // A deadlock kills exactly one side. If neither failed, the two
        // transactions did not overlap and this test proved nothing.
        expect(failure).toBeDefined();

        const error = (failure as PromiseRejectedResult).reason as unknown;
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        const known = error as Prisma.PrismaClientKnownRequestError;
        expect(known.code).toBe('P2034');
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { originalCode: '40P01', kind: 'TransactionWriteConflict' },
          },
        });

        // And it must not reach the client as a 500.
        expect(mapPrismaErrorCode(known)).toBe('CONFLICT');
      } finally {
        // Undo whichever side committed — this case cannot use `rejectedBy`,
        // because it needs both transactions to really run.
        await prisma.parkingSpot.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      }
    });

    /**
     * The same deadlock, lost by a **raw** statement — a different error code
     * for an identical condition.
     *
     * This is the shape nobody had pinned, and its absence cost a real
     * regression: `WaitlistPromotionService` was changed from `deleteMany` to
     * `DELETE … RETURNING`, which moved its cross-cell delete off the query API
     * and onto `$queryRaw`, and from that moment a deadlock whose victim was
     * that statement stopped matching the cancellation retry's `P2034` test.
     * Half of `waitlist-concurrency.db.spec.ts`'s concurrent cancellations
     * failed. `doc/decision/0240-*`.
     *
     * Deliberately the same two-`ParkingSpot` cycle as above, with only the
     * second statement swapped for `$executeRaw`, so the *one* thing that
     * differs between the two assertions is how the statement was sent.
     */
    it('is P2010 wrapping the driver’s 40P01 when the victim is a raw statement', async () => {
      const [first, second] = await Promise.all([
        prisma.parkingSpot.create({ data: { label: unique('SPOT'), group: 'IT' } }),
        prisma.parkingSpot.create({ data: { label: unique('SPOT'), group: 'IT' } }),
      ]);

      try {
        const reached = { one: resolvable(), two: resolvable() };
        const lockThen = async (own: string, other: string, mine: keyof typeof reached) => {
          await prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`
                UPDATE "ParkingSpot" SET "group" = 'SHARED' WHERE "id" = ${own}::uuid
              `;
              reached[mine].resolve();
              await Promise.all([reached.one.promise, reached.two.promise]);
              await tx.$executeRaw`
                UPDATE "ParkingSpot" SET "group" = 'SHARED' WHERE "id" = ${other}::uuid
              `;
            },
            { maxWait: 10_000, timeout: 30_000 }
          );
        };

        const outcomes = await Promise.allSettled([
          lockThen(first.id, second.id, 'one'),
          lockThen(second.id, first.id, 'two'),
        ]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        expect(failure).toBeDefined();

        const error = (failure as PromiseRejectedResult).reason as unknown;
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        const known = error as Prisma.PrismaClientKnownRequestError;

        // The whole point: **not** P2034.
        expect(known.code).toBe('P2010');
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { originalCode: '40P01', kind: 'TransactionWriteConflict' },
          },
        });

        // And both consumers of that shape agree it is a lost race, not a bug.
        expect(isWriteConflict(known)).toBe(true);
        expect(mapPrismaErrorCode(known)).toBe('CONFLICT');
      } finally {
        await prisma.parkingSpot.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      }
    });
  });

  describe('the reservation-window settings singleton', () => {
    it('rejects any row whose id is not 1', async () => {
      const error = await rejectedBy(prisma, (tx) =>
        tx.reservationWindowSettings.create({
          data: { id: 2, openDaysBefore: 7, lockMode: 'AUTO' },
        })
      );
      expect(String(error)).toMatch(/check|constraint/i);
    });
  });

  describe('a spot-day is one full-day reservation or non-overlapping guest blocks', () => {
    const block = (
      tx: Prisma.TransactionClient,
      parkingSpotId: string,
      startMinute: number,
      endMinute: number
    ) =>
      tx.timedReservation.create({
        data: { parkingSpotId, date: DATE, startMinute, endMinute, guestName: 'Host' },
      });

    it('an overlapping block is rejected by the blocks trigger', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        await block(tx, spot.id, 540, 630);
        return block(tx, spot.id, 600, 660);
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
      expect(known.meta).toMatchObject({
        driverAdapterError: {
          cause: { constraint: { index: 'TimedReservation_spot_day_conflict' } },
        },
      });
    });

    it('a block on a day with a full-day reservation is rejected by the blocks trigger', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const [spot, user] = [await seedSpot(tx), await seedUser(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
        return block(tx, spot.id, 600, 660);
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
      expect(known.meta).toMatchObject({
        driverAdapterError: {
          cause: { constraint: { index: 'TimedReservation_spot_day_conflict' } },
        },
      });
    });

    it('a full-day reservation on a day with a block is rejected by the reservation trigger', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const [spot, user] = [await seedSpot(tx), await seedUser(tx)];
        await block(tx, spot.id, 600, 660);
        return tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
      });

      const known = error as Prisma.PrismaClientKnownRequestError;
      expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
      expect(known.meta).toMatchObject({
        driverAdapterError: {
          cause: { constraint: { index: 'Reservation_timed_reservation_conflict' } },
        },
      });
    });

    it('adjacent blocks are accepted', async () => {
      const rolledBack = prisma.$transaction(async (tx) => {
        const spot = await seedSpot(tx);
        await block(tx, spot.id, 600, 660);
        await block(tx, spot.id, 660, 720);
        const count = await tx.timedReservation.count({ where: { parkingSpotId: spot.id } });
        expect(count).toBe(2);
        throw new Error('rollback');
      });

      await expect(rolledBack).rejects.toThrow('rollback');
    });

    it('a block up to midnight (23:30–24:00) is accepted', async () => {
      const rolledBack = prisma.$transaction(async (tx) => {
        const spot = await seedSpot(tx);
        await block(tx, spot.id, 1410, 1440);
        throw new Error('rollback');
      });

      await expect(rolledBack).rejects.toThrow('rollback');
    });

    it('rejects a start not on the half-hour grid', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        return block(tx, spot.id, 615, 660);
      });
      expect(String(error)).toContain('TimedReservation_range_check');
    });

    it('rejects a zero-length block', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        return block(tx, spot.id, 600, 600);
      });
      expect(String(error)).toContain('TimedReservation_range_check');
    });

    it('rejects an end past midnight', async () => {
      const error = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        return block(tx, spot.id, 1410, 1470);
      });
      expect(String(error)).toContain('TimedReservation_range_check');
    });

    /**
     * Polls `pg_locks` for an advisory lock that is requested but not yet
     * granted — proof that a second session is actually parked inside
     * `lock_spot_day`, not just that two `await`s happened to run close
     * together.
     *
     * The first draft of the two concurrency cases below started both sides
     * as autocommit `create`s gated by one shared `resolve()`. That never
     * forced a real overlap: whichever statement's round trip to Postgres
     * happened to land first would run its trigger, `INSERT` and commit
     * before the second one's trigger even started, so the two statements
     * serialised themselves through ordinary visibility — the assertions
     * passed the same way whether or not `lock_spot_day` existed. Holding the
     * first side open in an interactive transaction and waiting for this
     * function to see the second side queued on the lock is what makes the
     * overlap real.
     */
    async function advisoryLockIsBlocked(): Promise<boolean> {
      const rows = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
      `;
      return (rows[0]?.count ?? 0) > 0;
    }

    async function waitUntilAdvisoryLockIsBlocked(timeoutMs = 5000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await advisoryLockIsBlocked()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    it('concurrent overlapping blocks: exactly one commits, the loser is SPOT_ALREADY_RESERVED', async () => {
      const spot = await prisma.parkingSpot.create({
        data: { label: unique('SPOT'), group: 'IT' },
      });
      try {
        const holdsLock = resolvable();
        const releaseT1 = resolvable();

        // T1: an interactive transaction that inserts a block, then sits on
        // the `lock_spot_day` advisory lock (transaction-scoped, so it stays
        // held until commit) until told to proceed.
        const t1 = prisma.$transaction(
          async (tx) => {
            await block(tx, spot.id, 540, 630);
            holdsLock.resolve();
            await releaseT1.promise;
          },
          { maxWait: 10_000, timeout: 30_000 }
        );

        await holdsLock.promise;

        // T2: a separate, autocommit statement for an overlapping block on
        // the same spot-day. Its own trigger calls `lock_spot_day` with the
        // same key and has to wait for T1. Prisma Client queries are lazy —
        // nothing is sent to the server until something subscribes to the
        // promise — so a no-op `.catch()` right here is what actually
        // dispatches the statement; without it, T2 would not even reach
        // Postgres until the later `Promise.allSettled` below, by which time
        // T1 would already have committed and there would be nothing to wait
        // on at all.
        const t2 = block(prisma, spot.id, 600, 660);
        void t2.catch(() => {
          // Handled via `outcomes` below; this only exists to trigger dispatch.
        });

        // Don't let T1 commit until T2 is actually queued on the lock — see
        // the comment on `advisoryLockIsBlocked` above for why this matters.
        // Release T1 either way: leaving its transaction open on a failed
        // assertion would dangle a lock that the `finally` block's own
        // cleanup queries would then wait on forever.
        const sawBlockedLock = await waitUntilAdvisoryLockIsBlocked();
        releaseT1.resolve();
        expect(sawBlockedLock).toBe(true);

        const outcomes = await Promise.allSettled([t1, t2]);
        expect(outcomes[0]?.status).toBe('fulfilled');
        expect(outcomes[1]?.status).toBe('rejected');

        const error = (outcomes[1] as PromiseRejectedResult).reason as unknown;
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        const known = error as Prisma.PrismaClientKnownRequestError;
        expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
        expect(isTimedReservationConflict(known)).toBe(true);
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { constraint: { index: 'TimedReservation_spot_day_conflict' } },
          },
        });
      } finally {
        await prisma.timedReservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.parkingSpot.delete({ where: { id: spot.id } });
      }
    });

    it('a block vs. a full-day reservation, concurrently: the reservation waits and loses', async () => {
      const spot = await prisma.parkingSpot.create({
        data: { label: unique('SPOT'), group: 'IT' },
      });
      const user = await prisma.user.create({
        data: {
          email: `${unique('user')}@example.test`,
          name: 'Database contract fixture',
          oktaId: unique('okta'),
          icsToken: unique('ics'),
        },
      });
      try {
        const holdsLock = resolvable();
        const releaseT1 = resolvable();

        // T1: an interactive transaction holding a block's slot on the lock.
        const t1 = prisma.$transaction(
          async (tx) => {
            await block(tx, spot.id, 540, 600);
            holdsLock.resolve();
            await releaseT1.promise;
          },
          { maxWait: 10_000, timeout: 30_000 }
        );

        await holdsLock.promise;

        // T2: a full-day reservation on the same spot-day, autocommit. Its
        // trigger (`reservation_reject_timed_conflict`) calls the same
        // `lock_spot_day` key and has to wait for T1. The `.catch()` here is
        // load-bearing, not decorative — see the comment on the previous
        // test's `t2` for why: Prisma Client queries are lazy, and nothing
        // reaches Postgres until something subscribes to the promise.
        const t2 = prisma.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
        void t2.catch(() => {
          // Handled via `outcomes` below; this only exists to trigger dispatch.
        });

        const sawBlockedLock = await waitUntilAdvisoryLockIsBlocked();
        releaseT1.resolve();
        expect(sawBlockedLock).toBe(true);

        const outcomes = await Promise.allSettled([t1, t2]);
        expect(outcomes[0]?.status).toBe('fulfilled');
        expect(outcomes[1]?.status).toBe('rejected');

        const error = (outcomes[1] as PromiseRejectedResult).reason as unknown;
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        const known = error as Prisma.PrismaClientKnownRequestError;
        expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { constraint: { index: 'Reservation_timed_reservation_conflict' } },
          },
        });
      } finally {
        await prisma.timedReservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.reservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.parkingSpot.delete({ where: { id: spot.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    /**
     * The mirror of the case above, and the one that pins the "Reservation"
     * trigger being AFTER: the full-day row is inserted and its trigger has
     * taken the lock *after* the row exists, uncommitted. The block's BEFORE
     * trigger cannot see that row, so it must be parked on the lock — and then
     * see the committed row and lose.
     */
    it('a full-day reservation vs. a block, concurrently: the block waits and loses', async () => {
      const spot = await prisma.parkingSpot.create({
        data: { label: unique('SPOT'), group: 'IT' },
      });
      const user = await prisma.user.create({
        data: {
          email: `${unique('user')}@example.test`,
          name: 'Database contract fixture',
          oktaId: unique('okta'),
          icsToken: unique('ics'),
        },
      });
      try {
        const holdsLock = resolvable();
        const releaseT1 = resolvable();

        const t1 = prisma.$transaction(
          async (tx) => {
            await tx.reservation.create({
              data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
            });
            holdsLock.resolve();
            await releaseT1.promise;
          },
          { maxWait: 10_000, timeout: 30_000 }
        );

        await holdsLock.promise;

        // Dispatched by the `.catch()` — see the first concurrency case.
        const t2 = block(prisma, spot.id, 540, 600);
        void t2.catch(() => {
          // Handled via `outcomes` below; this only exists to trigger dispatch.
        });

        const sawBlockedLock = await waitUntilAdvisoryLockIsBlocked();
        releaseT1.resolve();
        expect(sawBlockedLock).toBe(true);

        const outcomes = await Promise.allSettled([t1, t2]);
        expect(outcomes[0]?.status).toBe('fulfilled');
        expect(outcomes[1]?.status).toBe('rejected');

        const known = (outcomes[1] as PromiseRejectedResult)
          .reason as Prisma.PrismaClientKnownRequestError;
        expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { constraint: { index: 'TimedReservation_spot_day_conflict' } },
          },
        });
      } finally {
        await prisma.timedReservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.reservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.parkingSpot.delete({ where: { id: spot.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    /**
     * A cancellation with a promotion, reduced to its two statements: T1
     * deletes a cell's reservation and re-inserts one for somebody else, and a
     * create for the same cell arrives in between.
     *
     * The create waits on T1's deleted-but-uncommitted entry in the
     * `(parkingSpotId, date)` unique index, then loses to T1's new row with an
     * ordinary unique violation. When the "Reservation" trigger was BEFORE, the
     * create took the spot-day lock before reaching the index, T1's re-insert
     * then waited on that lock, and the pair deadlocked (`40P01` → `CONFLICT`)
     * — the regression `waitlist-concurrency.db.spec.ts` caught through the
     * service. This case forces the interleaving instead of racing for it.
     */
    it('a create arriving between a delete and a re-insert of the same cell loses cleanly, without a deadlock', async () => {
      const spot = await prisma.parkingSpot.create({
        data: { label: unique('SPOT'), group: 'IT' },
      });
      const users = [];
      for (let index = 0; index < 3; index += 1) {
        users.push(
          await prisma.user.create({
            data: {
              email: `${unique('user')}@example.test`,
              name: 'Database contract fixture',
              oktaId: unique('okta'),
              icsToken: unique('ics'),
            },
          })
        );
      }
      const [holder, promoted, latecomer] = users as [
        (typeof users)[number],
        (typeof users)[number],
        (typeof users)[number],
      ];
      try {
        const existing = await prisma.reservation.create({
          data: { parkingSpotId: spot.id, userId: holder.id, date: DATE },
        });

        const deleted = resolvable();
        const releaseT1 = resolvable();
        const t1 = prisma.$transaction(
          async (tx) => {
            await tx.reservation.delete({ where: { id: existing.id } });
            deleted.resolve();
            await releaseT1.promise;
            await tx.reservation.create({
              data: { parkingSpotId: spot.id, userId: promoted.id, date: DATE },
            });
          },
          { maxWait: 10_000, timeout: 30_000 }
        );

        await deleted.promise;

        const t2 = prisma.reservation.create({
          data: { parkingSpotId: spot.id, userId: latecomer.id, date: DATE },
        });
        void t2.catch(() => {
          // Handled via `outcomes` below; this only exists to trigger dispatch.
        });

        // The create is parked on T1's transaction (the index entry), not on
        // anything advisory. Release T1 either way, so a failure cannot leave
        // it open.
        let sawBlocked = false;
        const deadline = Date.now() + 5000;
        while (!sawBlocked && Date.now() < deadline) {
          const rows = await prisma.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted
          `;
          sawBlocked = (rows[0]?.count ?? 0) > 0;
          if (!sawBlocked) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        releaseT1.resolve();
        expect(sawBlocked).toBe(true);

        const outcomes = await Promise.allSettled([t1, t2]);
        expect(outcomes[0]?.status).toBe('fulfilled');
        expect(outcomes[1]?.status).toBe('rejected');

        const known = (outcomes[1] as PromiseRejectedResult)
          .reason as Prisma.PrismaClientKnownRequestError;
        // `P2002`, not `P2034`: no deadlock, no write conflict.
        expect(known.code).toBe('P2002');
        expect(mapPrismaErrorCode(known)).toBe('SPOT_ALREADY_RESERVED');
        expect(known.meta).toMatchObject({
          driverAdapterError: {
            cause: { constraint: { index: 'Reservation_parkingSpotId_date_key' } },
          },
        });

        const current = await prisma.reservation.findMany({ where: { parkingSpotId: spot.id } });
        expect(current.map((row) => row.userId)).toEqual([promoted.id]);
      } finally {
        await prisma.reservation.deleteMany({ where: { parkingSpotId: spot.id } });
        await prisma.parkingSpot.delete({ where: { id: spot.id } });
        await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
      }
    });

    it('isTimedReservationConflict is true for the two triggers and false for the plain Reservation collision', async () => {
      const timedBlockError = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        await block(tx, spot.id, 540, 630);
        return block(tx, spot.id, 600, 660);
      });
      const fullDayThenBlockError = await rejectedBy(prisma, async (tx) => {
        const [spot, user] = [await seedSpot(tx), await seedUser(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
        return block(tx, spot.id, 600, 660);
      });
      const blockThenFullDayError = await rejectedBy(prisma, async (tx) => {
        const [spot, user] = [await seedSpot(tx), await seedUser(tx)];
        await block(tx, spot.id, 600, 660);
        return tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: user.id, date: DATE },
        });
      });
      const plainReservationCollision = await rejectedBy(prisma, async (tx) => {
        const spot = await seedSpot(tx);
        const [one, two] = [await seedUser(tx), await seedUser(tx)];
        await tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: one.id, date: DATE },
        });
        return tx.reservation.create({
          data: { parkingSpotId: spot.id, userId: two.id, date: DATE },
        });
      });

      expect(isTimedReservationConflict(timedBlockError)).toBe(true);
      expect(isTimedReservationConflict(fullDayThenBlockError)).toBe(true);
      expect(isTimedReservationConflict(blockThenFullDayError)).toBe(true);
      expect(isTimedReservationConflict(plainReservationCollision)).toBe(false);
    });
  });
});
