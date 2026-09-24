/**
 * The per-user, per-calendar-month cap on confirmed reservations.
 *
 * The *count* is a request-time computation, not stored state: no column holds
 * how much of the month somebody has used. The *cap* is an admin setting — the
 * `ReservationLimitSettings` singleton (`doc/decision/0312-*`) — and every path
 * that inserts a `Reservation` row for a real user (never a guest — a guest has
 * no `userId`, so no budget applies) **while the cap is in force**
 * (`isMonthlyCapInForce` in `@garage/shared-types`: `AUTO` and today inside the
 * target month's window — `doc/decision/0315-*`) loads it with
 * {@link readMonthlyReservationCap} and passes it to
 * `assertWithinMonthlyReservationCap`, which runs as the last check before the
 * insert, inside the same transaction that will do the insert.
 *
 * The cap is read **inside** that transaction rather than before it: see
 * {@link readMonthlyReservationCap}. `WaitlistPromotionService.promote` reads it
 * once above its candidate loop rather than per candidate; the reason is stated
 * at the loop, which is where anybody changing it is standing.
 *
 * The `pg_advisory_xact_lock` this takes is a new lock resource, but it is not
 * a disjoint one, and an earlier version of this comment claiming it could not
 * form a new cycle was wrong. Two holders go on to want row locks in the same
 * transaction: `WaitlistPromotionService.promote` takes it once per skipped
 * over-cap candidate while already holding a queue row `FOR UPDATE`, and
 * `BulkReservationService.confirmOnce` takes it and then has
 * `releaseOwnQueues` `DELETE` the caller's `WaitlistEntry` rows, which can
 * block on a queue row a concurrent `cancel` + `promote` holds `FOR UPDATE`
 * while that transaction blocks here. That is a real cycle, and PostgreSQL
 * resolves it by killing one side with `40P01`.
 *
 * The mitigation is a retry, not an ordering — no ordering is available,
 * because the key is month-scoped and the row locks are date-scoped:
 * `BulkReservationService.committedConfirm` re-runs the transaction on any
 * `isWriteConflict` and reports `CONFLICT` when the attempts run out, exactly
 * as `ReservationsService.cancel` does for the cycle in
 * `doc/decision/0065-*`. `doc/decision/0307-*` has the full analysis.
 *
 * Unlike the per-day rule (a real unique index, so an optimistic pre-check is
 * safe and `P2002` is the final arbiter), there is no constraint that could
 * reject an over-cap insert — the lock + recount inside it *is* the
 * authoritative check.
 */

import { RESERVATION_LIMIT_SETTINGS_ID, type Prisma } from '@garage/database';
import {
  endOfMonth,
  DEFAULT_MONTHLY_RESERVATION_CAP,
  startOfMonth,
  toYearMonth,
  type DateOnly,
} from '@garage/shared-types';
import { toDateColumn } from '../common/prisma-mapping';
import { DomainError } from '../common/errors/domain-error';

export { DEFAULT_MONTHLY_RESERVATION_CAP };

/**
 * The cap **in force**, read inside the caller's transaction.
 *
 * Inside, not before: the advisory lock plus recount below is documented as
 * *the* authoritative check, and a cap read outside the transaction could be
 * stale against an admin lowering it between the read and the insert. One more
 * query in a path that already takes a lock is the right trade.
 *
 * A missing row answers the default rather than throwing, exactly as
 * `ReservationWindowService.getSettings` does and for the same reason: the
 * honest value for "the seed has not run" is the documented default, which is
 * what the row would have contained.
 */
export async function readMonthlyReservationCap(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.reservationLimitSettings.findUnique({
    where: { id: RESERVATION_LIMIT_SETTINGS_ID },
    select: { monthlyReservationCap: true },
  });

  return row?.monthlyReservationCap ?? DEFAULT_MONTHLY_RESERVATION_CAP;
}

/**
 * Throws `DomainError('MONTHLY_RESERVATION_LIMIT_REACHED')` if `userId` already
 * holds `cap - additional` or more confirmed reservations in `date`'s calendar
 * month. `additional` is how many more the caller is about to insert in this
 * same transaction: bulk confirm passes the count of days it is about to
 * assign, and the two single-row callers pass `1`. It has **no default** — a
 * parameter with one cannot precede the required `cap` below, and every call
 * site therefore says how many rows it is about to add.
 *
 * `cap` is a **required parameter**, not a constant read from the module: it is
 * an admin setting now (`ReservationLimitSettings`), and a default here would
 * let a caller that forgot to load it silently enforce 5 in a workspace that
 * configured something else. {@link readMonthlyReservationCap} is how every
 * caller gets it, inside the same transaction.
 */
export async function assertWithinMonthlyReservationCap(
  tx: Prisma.TransactionClient,
  userId: string,
  date: DateOnly,
  additional: number,
  cap: number
): Promise<void> {
  const month = toYearMonth(date);
  await lockUserMonth(tx, userId, month);

  const count = await tx.reservation.count({
    where: {
      userId,
      date: { gte: toDateColumn(startOfMonth(date)), lte: toDateColumn(endOfMonth(date)) },
    },
  });

  if (count + additional > cap) {
    throw new DomainError('MONTHLY_RESERVATION_LIMIT_REACHED', {
      details: { month, limit: cap },
    });
  }
}

/**
 * `hashtextextended` rather than `hashtext`: `pg_advisory_xact_lock` takes a
 * `bigint`, and `hashtext` only returns `int4`. The seed argument (`0`) is
 * fixed — it only has to be consistent between calls, not secret.
 *
 * `$executeRaw` rather than `$queryRaw`: `pg_advisory_xact_lock` returns
 * `void`, and Prisma's raw-result deserializer rejects that column type
 * (`Failed to deserialize column of type 'void'`). `$executeRaw` still runs the
 * statement and still blocks until the lock is acquired — it just does not try
 * to read a result set back — and `monthly-reservation-cap.db.spec.ts`
 * (`serializes two callers …`) asserts against a real PostgreSQL that a second
 * transaction really does block on it, not merely that this compiles.
 */
async function lockUserMonth(
  tx: Prisma.TransactionClient,
  userId: string,
  month: string
): Promise<void> {
  const key = `${userId}:${month}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
