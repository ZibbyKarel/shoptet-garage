/**
 * What a database error *means* — the vocabulary, the driver-adapter meta
 * readers, and the three predicates/mappers built on them.
 *
 * This is a **database** concern, not an HTTP one. It lived inside
 * `common/filters/contract-exception.filter.ts` until the module boundary was
 * corrected, which told every reader — by import path alone — that deciding
 * whether to re-run a transaction was a question about exception filtering. It
 * is not: the filter is one consumer of these answers, and the retry loop in
 * `ReservationsService.isRetryableConflict` is another.
 *
 * **A Prisma constraint violation becomes the domain error it actually is.**
 * `Reservation (parkingSpotId, date)` is unique in the database, which is what
 * makes double-booking impossible under concurrency; without the P2002 mapping
 * below, the losing request of that race would surface as a 500.
 *
 * Note the name. `common/prisma-mapping.ts` is a different module with a
 * confusingly close one: it maps database *rows* to contract shapes
 * (`toDateOnly`, `toContractSpot`, …). This file maps database *errors*.
 */

import type { ErrorCode } from '@garage/contract';
import { Prisma } from '@garage/database';

/** Prisma error codes this module recognises. Anything else is a 500. */
const PRISMA_RECORD_NOT_FOUND = 'P2025';
const PRISMA_UNIQUE_CONSTRAINT = 'P2002';
const PRISMA_FOREIGN_KEY_CONSTRAINT = 'P2003';
/**
 * A serialization failure or a deadlock — PostgreSQL `40001` / `40P01`.
 *
 * Added by Task 13, which found a real one: two cancellations promoting the same
 * person out of two different queues deadlock against each other
 * (`ReservationsService.isRetryableConflict` has the cycle). That path retries,
 * so this mapping is the *last* resort — but without it a lost race would come
 * back as a 500, and a 500 tells an operator to look for a defect that is not
 * there and tells the client not to try again, which is the wrong advice.
 *
 * See `doc/decision/0065-*`.
 */
export const PRISMA_WRITE_CONFLICT = 'P2034';

/**
 * The same failure, arriving from a **raw** statement instead of the query API.
 *
 * `P2034` is what Prisma raises when *its own* generated SQL is the deadlock
 * victim. A statement sent through `$queryRaw` / `$executeRaw` never gets that
 * code: the driver's error is wrapped verbatim as `P2010` ("Raw query failed"),
 * and the `40P01` survives only inside `meta`. Two codes, one condition — which
 * is why {@link isWriteConflict} exists rather than a bare `=== P2034`.
 *
 * `doc/decision/0240-*` has the regression this cost. Pinned against a live
 * server by `database-contract.db.spec.ts` ("a deadlock on a raw statement").
 */
const PRISMA_RAW_QUERY_FAILED = 'P2010';

/**
 * PostgreSQL SQLSTATE class 40, *transaction rollback* — the only class whose
 * remedy is "run the whole transaction again".
 *
 * `40001` serialization_failure, `40P01` deadlock_detected. Matched by the
 * two-character class rather than by listing the members, because the class is
 * the property that matters: the server has already rolled the transaction back
 * and nothing it did survives, so a retry starts from a clean slate.
 */
const SQLSTATE_TRANSACTION_ROLLBACK = '40';

/** Narrows an unknown to a plain object without asserting its contents. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the constraint out of the driver adapter's own error, which is where
 * `@prisma/adapter-pg` puts it — and the **only** place it appears.
 *
 * Prisma 7 with a driver adapter does not populate the documented `meta.target`
 * at all. What a real `(parkingSpotId, date)` collision produces is:
 *
 * ```
 * code: 'P2002'
 * meta: { modelName: 'Reservation', driverAdapterError: { cause: {
 *          originalCode: '23505', kind: 'UniqueConstraintViolation',
 *          constraint: { index: 'Reservation_parkingSpotId_date_key' },
 *          table: 'Reservation' } } }
 * ```
 *
 * `constraint` is a tagged union: Postgres reports the index it violated
 * (`{ index }`), while other drivers report the columns (`{ fields }`). Both are
 * read, because both feed the same matcher — an index name is one of the two
 * forms `targetMatches` already accepts.
 *
 * Verified against PostgreSQL 17 in `database-contract.db.spec.ts`, which
 * asserts this shape *and* that `meta.target` is absent. That spec is the reason
 * the fallback exists: `PrismaDouble` fabricated a `target` key, so every unit
 * test of this mapping passed while every real unique violation degraded to
 * `CONFLICT`.
 */
function driverAdapterConstraint(meta: Record<string, unknown> | undefined): string[] {
  const constraint = asRecord(
    asRecord(asRecord(meta?.['driverAdapterError'])?.['cause'])?.['constraint']
  );
  if (constraint === undefined) {
    return [];
  }
  const index = constraint['index'];
  if (typeof index === 'string') {
    return [index];
  }
  const fields = constraint['fields'];
  if (Array.isArray(fields)) {
    return fields.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

/**
 * The SQLSTATE the server actually returned, for a `P2010`.
 *
 * Both places it can hide are read, for the same reason `uniqueConstraintTarget`
 * reads two: `meta.code` is what Prisma documents for `P2010` and what the
 * query-engine-backed client emits, and `meta.driverAdapterError.cause.
 * originalCode` is what `@prisma/adapter-pg` actually produces today. Measured,
 * for a raw `DELETE` that lost a deadlock:
 *
 * ```
 * code: 'P2010'
 * message: 'Raw query failed. Code: `40P01`. Message: `deadlock detected`'
 * meta: { driverAdapterError: { cause: {
 *          originalCode: '40P01', originalMessage: 'deadlock detected',
 *          kind: 'TransactionWriteConflict' } } }
 * ```
 *
 * The message is *not* parsed. It carries the same code, but a predicate that
 * decides whether to re-run a transaction on the strength of a substring in a
 * human-readable string is one upstream rewording away from silently doing the
 * wrong thing, and the wrong thing here is invisible: it does not throw, it just
 * stops retrying.
 */
function rawQuerySqlState(meta: Record<string, unknown> | undefined): string | undefined {
  const documented = meta?.['code'];
  if (typeof documented === 'string') {
    return documented;
  }
  const original = asRecord(asRecord(meta?.['driverAdapterError'])?.['cause'])?.['originalCode'];
  return typeof original === 'string' ? original : undefined;
}

/**
 * True when the transaction lost a race and the server rolled it back — whether
 * the losing statement was Prisma's own SQL or one of ours.
 *
 * This is the predicate a retry loop wants; `mapPrismaErrorCode` answers the
 * separate question of what to tell a client once retrying has stopped.
 */
export function isWriteConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code === PRISMA_WRITE_CONFLICT) {
    return true;
  }
  if (error.code !== PRISMA_RAW_QUERY_FAILED) {
    return false;
  }
  return rawQuerySqlState(error.meta)?.startsWith(SQLSTATE_TRANSACTION_ROLLBACK) === true;
}

/**
 * True when this is a unique-constraint violation at all — the *easy* half of
 * every retry predicate in the API.
 *
 * Exported because it was previously missing: this module handed out the hard
 * half ({@link mapUniqueConstraintViolation}, "which constraint fired") and left
 * every caller to re-derive the easy half, which produced four spellings of one
 * fact — a bare `'P2002'` literal in `ReservationsService.isRetryableConflict`
 * and three separate file-private `PRISMA_UNIQUE_CONSTRAINT` constants.
 *
 * Takes `unknown` rather than a narrowed error on purpose: every call site is a
 * `catch` block, so narrowing is part of the question being asked, not a
 * precondition the caller should have to satisfy first. It answers with a type
 * predicate for the same reason — the body already proves the error is a
 * `PrismaClientKnownRequestError`, and a bare `boolean` would throw that proof
 * away at the `return`, leaving the caller to re-establish it with a second
 * `instanceof` before it can read `.meta` or `.code`.
 */
export function isUniqueConstraintViolation(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_CONSTRAINT
  );
}

/**
 * Normalises P2002's constraint identity to a list of names.
 *
 * `meta.target` is what Prisma documents — the constraint name, an array of
 * column names, or a single string — and is what the query-engine-backed client
 * emits. It is checked first so that this keeps working if the adapter is ever
 * dropped. The driver-adapter path below it is what actually fires today.
 */
function uniqueConstraintTarget(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.['target'];
  if (Array.isArray(target)) {
    return target.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof target === 'string') {
    return [target];
  }
  return driverAdapterConstraint(meta);
}

/**
 * True when `target` names exactly this constraint — either as the full set of
 * its columns, or as the index name Prisma generates for it.
 *
 * The comparison is by **exact set**, not substring. An earlier version joined
 * the columns and used `includes`, which matched any future column merely
 * containing the name (`dateFrom`, `updatedDate` both satisfy a test for
 * `date`) and treated a superset as a match, so the check order carried the
 * correctness rather than the check itself.
 */
function targetMatches(target: string[], table: string, columns: readonly string[]): boolean {
  const normalised = target.map((entry) => entry.toLowerCase()).sort();
  const expectedColumns = columns.map((column) => column.toLowerCase()).sort();
  if (
    normalised.length === expectedColumns.length &&
    normalised.every((entry, index) => entry === expectedColumns[index])
  ) {
    return true;
  }
  // Prisma's own naming for a unique index: `Table_col1_col2_key`, columns in
  // the order the `@@unique` block declares them. Checked against the generated
  // migration SQL rather than assumed — all seven unique indexes in this schema
  // follow it, none carries a `map:` override, and `database-contract.db.spec.ts`
  // provokes each one against a real server:
  //
  //   User_email_key, User_oktaId_key, User_icsToken_key, ParkingSpot_label_key,
  //   Reservation_parkingSpotId_date_key, Reservation_userId_date_key,
  //   WaitlistEntry_parkingSpotId_userId_date_key
  //
  // A future `@@unique([...], map: "…")` would break this path silently, which
  // is why the db spec asserts the literal index name and not just the mapping.
  const indexName = `${table}_${columns.join('_')}_key`.toLowerCase();
  return normalised.length === 1 && normalised[0] === indexName;
}

/**
 * The two constraint names raised by the (spot, day) triggers in migration
 * `20260924120000_timed_reservation` — not indexes, so they do not follow
 * Prisma's `Table_cols_key` naming and are matched by exact name.
 * `doc/decision/0314-*`.
 */
const TIMED_RESERVATION_CONFLICTS = [
  'timedreservation_spot_day_conflict',
  'reservation_timed_reservation_conflict',
] as const;

function isTimedConflictTarget(target: string[]): boolean {
  const [only] = target;
  return (
    target.length === 1 &&
    only !== undefined &&
    (TIMED_RESERVATION_CONFLICTS as readonly string[]).includes(only.toLowerCase())
  );
}

/** True for a P2002 raised by the full-day/blocks triggers. Used by `confirmBulk`'s retry. */
export function isTimedReservationConflict(error: unknown): boolean {
  return (
    isUniqueConstraintViolation(error) && isTimedConflictTarget(uniqueConstraintTarget(error.meta))
  );
}

/**
 * Maps a unique-constraint violation to the domain error it means.
 *
 * A blanket `P2002 → SPOT_ALREADY_RESERVED` would mislabel two real
 * constraints: `Reservation (userId, date)` is the *one reservation per person
 * per day* rule (`RESERVATION_LIMIT_REACHED`), and `User_email_key` /
 * `ParkingSpot_label_key` are not about reservations at all. So the constraint
 * is read from `meta.target`, and anything unrecognised degrades to the
 * deliberately vague `CONFLICT` — also a 409, so the caller still learns it
 * lost a race rather than that the server broke.
 */
export function mapUniqueConstraintViolation(meta: Record<string, unknown> | undefined): ErrorCode {
  const target = uniqueConstraintTarget(meta);

  // Each entry names its table, so these are exact identifications rather than
  // an ordered sequence of increasingly loose guesses. They must stay in step
  // with the `@@unique` blocks in `libs/garage/database/prisma/schema.prisma`.
  if (targetMatches(target, 'WaitlistEntry', ['parkingSpotId', 'userId', 'date'])) {
    return 'ALREADY_IN_WAITLIST';
  }
  if (isTimedConflictTarget(target)) {
    return 'SPOT_ALREADY_RESERVED';
  }
  if (targetMatches(target, 'Reservation', ['parkingSpotId', 'date'])) {
    return 'SPOT_ALREADY_RESERVED';
  }
  if (targetMatches(target, 'Reservation', ['userId', 'date'])) {
    return 'RESERVATION_LIMIT_REACHED';
  }
  return 'CONFLICT';
}

/**
 * Maps a known Prisma request error to a contract code, or `undefined` when
 * this module has nothing meaningful to say — in which case it is a 500 and the
 * cause goes to the log, not to the client.
 */
export function mapPrismaErrorCode(
  error: Prisma.PrismaClientKnownRequestError
): ErrorCode | undefined {
  switch (error.code) {
    case PRISMA_UNIQUE_CONSTRAINT:
      return mapUniqueConstraintViolation(error.meta);
    case PRISMA_RECORD_NOT_FOUND:
      return 'NOT_FOUND';
    case PRISMA_FOREIGN_KEY_CONSTRAINT:
      // Every foreign key in this schema is ON DELETE RESTRICT, so this is
      // always "something still references the row you tried to remove".
      return 'CONFLICT';
    case PRISMA_WRITE_CONFLICT:
      // Literally the contract's definition of `CONFLICT`: "the request lost a
      // race against a concurrent change". Retrying is the right advice, and it
      // is what the Czech copy for this code already tells the user.
      return 'CONFLICT';
    case PRISMA_RAW_QUERY_FAILED:
      // The same fact about a raw statement — but only for class 40. Every
      // *other* `P2010` is a broken query or a bad cast, which is a defect and
      // must keep its 500 rather than be dressed up as somebody else's race.
      return isWriteConflict(error) ? 'CONFLICT' : undefined;
    default:
      return undefined;
  }
}
