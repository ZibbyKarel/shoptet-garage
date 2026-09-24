/**
 * The Prisma error vocabulary is tested without a database on purpose: `P2002`
 * is raised by Postgres, but `PrismaClientKnownRequestError` is an ordinary
 * class, so the exact object Prisma would throw can be constructed here. That
 * makes the most important mapping in the API — the one that turns a lost
 * double-booking race into a clean 409 instead of a 500 — testable on a machine
 * with no Postgres.
 *
 * What a *real* driver-adapter error looks like is asserted separately, against
 * a live PostgreSQL 17, in `apps/garage/api/src/database/database-contract.db.spec.ts`.
 */

import { Prisma } from '@garage/database';
import {
  isTimedReservationConflict,
  isUniqueConstraintViolation,
  mapPrismaErrorCode,
  mapUniqueConstraintViolation,
} from './prisma-error-mapping';

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('Prisma failed', {
    code,
    clientVersion: '7.10.0',
    // `exactOptionalPropertyTypes` is on: an explicit `meta: undefined` is not
    // the same as an absent `meta`, and Prisma itself omits the key.
    ...(meta === undefined ? {} : { meta }),
  });
}

describe('mapUniqueConstraintViolation', () => {
  it.each([
    // `meta.target` as a column list — what Prisma documents, and what the
    // query-engine client emits. NOT what this project's driver adapter emits;
    // an earlier version of this comment claimed it was, and that belief is why
    // the mapping was green while every real violation degraded to CONFLICT.
    // The shape that actually arrives is in the `driverAdapterError` block
    // below, transcribed from a live PostgreSQL 17 and re-asserted on every
    // `nx run api:test-db`.
    [['parkingSpotId', 'date'], 'SPOT_ALREADY_RESERVED'],
    [['userId', 'date'], 'RESERVATION_LIMIT_REACHED'],
    [['parkingSpotId', 'userId', 'date'], 'ALREADY_IN_WAITLIST'],
    [['email'], 'CONFLICT'],
  ])('maps the column list %p to %s', (target, expected) => {
    expect(mapUniqueConstraintViolation({ target })).toBe(expected);
  });

  it.each([
    // …and as the constraint name in other configurations. Both must work, or
    // the mapping silently degrades to CONFLICT in production.
    ['Reservation_parkingSpotId_date_key', 'SPOT_ALREADY_RESERVED'],
    ['Reservation_userId_date_key', 'RESERVATION_LIMIT_REACHED'],
    ['WaitlistEntry_parkingSpotId_userId_date_key', 'ALREADY_IN_WAITLIST'],
    ['User_email_key', 'CONFLICT'],
    ['ParkingSpot_label_key', 'CONFLICT'],
    // The two hand-named constraints the (spot, day) exclusivity triggers
    // raise (`20260924120000_timed_reservation`) — not Prisma's own
    // `Table_cols_key` naming, matched by exact name instead of column set.
    ['TimedReservation_spot_day_conflict', 'SPOT_ALREADY_RESERVED'],
    ['Reservation_timed_reservation_conflict', 'SPOT_ALREADY_RESERVED'],
  ])('maps the constraint name %s to %s', (target, expected) => {
    expect(mapUniqueConstraintViolation({ target })).toBe(expected);
  });

  /**
   * The shape `@prisma/adapter-pg` really sends. There is no `target` key
   * anywhere in it — `database-contract.db.spec.ts` asserts its absence against
   * a live server, so these fixtures cannot drift into fiction unnoticed.
   */
  function driverAdapterMeta(index: string): Record<string, unknown> {
    return {
      modelName: index.split('_')[0],
      driverAdapterError: {
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index },
          table: index.split('_')[0],
        },
      },
    };
  }

  it.each([
    ['Reservation_parkingSpotId_date_key', 'SPOT_ALREADY_RESERVED'],
    ['Reservation_userId_date_key', 'RESERVATION_LIMIT_REACHED'],
    ['WaitlistEntry_parkingSpotId_userId_date_key', 'ALREADY_IN_WAITLIST'],
    ['User_email_key', 'CONFLICT'],
    ['ParkingSpot_label_key', 'CONFLICT'],
    ['TimedReservation_spot_day_conflict', 'SPOT_ALREADY_RESERVED'],
    ['Reservation_timed_reservation_conflict', 'SPOT_ALREADY_RESERVED'],
  ])('maps the driver adapter’s constraint index %s to %s', (index, expected) => {
    expect(mapUniqueConstraintViolation(driverAdapterMeta(index))).toBe(expected);
  });

  it('reads the driver adapter’s `fields` form too, for adapters that report columns', () => {
    // The `constraint` union's other arm. No driver in this project emits it
    // today; it costs three lines and removes a whole class of "worked on
    // Postgres, silent on MySQL".
    const meta = {
      driverAdapterError: {
        cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['userId', 'date'] } },
      },
    };
    expect(mapUniqueConstraintViolation(meta)).toBe('RESERVATION_LIMIT_REACHED');
  });

  it('degrades to CONFLICT when Prisma reports no target at all', () => {
    expect(mapUniqueConstraintViolation(undefined)).toBe('CONFLICT');
    expect(mapUniqueConstraintViolation({})).toBe('CONFLICT');
    // A driver-adapter error that is not a unique violation, and a malformed
    // one: neither may be read as a constraint match.
    expect(mapUniqueConstraintViolation({ driverAdapterError: null })).toBe('CONFLICT');
    expect(
      mapUniqueConstraintViolation({ driverAdapterError: { cause: { constraint: {} } } })
    ).toBe('CONFLICT');
  });

  // The matching is by exact column set. A previous version joined the columns
  // and used `includes`, so each of these mapped to a reservation error.
  it.each([
    [['userId', 'dateFrom']],
    [['userId', 'updatedDate']],
    [['parkingSpotId', 'dateCreated']],
  ])('does not match %p, whose column merely contains "date"', (target) => {
    expect(mapUniqueConstraintViolation({ target })).toBe('CONFLICT');
  });

  it('does not treat a superset of a known constraint as that constraint', () => {
    // A future `Reservation (parkingSpotId, date, tenantId)` is a different
    // rule and must not silently claim SPOT_ALREADY_RESERVED.
    expect(mapUniqueConstraintViolation({ target: ['parkingSpotId', 'date', 'tenantId'] })).toBe(
      'CONFLICT'
    );
  });

  it('does not confuse another table with the same column pair', () => {
    expect(mapUniqueConstraintViolation({ target: 'Invoice_userId_date_key' })).toBe('CONFLICT');
  });
});

describe('mapPrismaErrorCode', () => {
  it('maps P2025 (record not found) to NOT_FOUND', () => {
    expect(mapPrismaErrorCode(prismaError('P2025'))).toBe('NOT_FOUND');
  });

  it('maps P2003 (foreign key) to CONFLICT — every FK here is ON DELETE RESTRICT', () => {
    expect(mapPrismaErrorCode(prismaError('P2003'))).toBe('CONFLICT');
  });

  it('returns undefined for a code it does not know, so it becomes a 500', () => {
    expect(mapPrismaErrorCode(prismaError('P1001'))).toBeUndefined();
  });
});

describe('isTimedReservationConflict', () => {
  it.each(['TimedReservation_spot_day_conflict', 'Reservation_timed_reservation_conflict'])(
    'is true for %s',
    (target) => {
      expect(isTimedReservationConflict(prismaError('P2002', { target: [target] }))).toBe(true);
    }
  );

  it('is false for the plain Reservation(parkingSpotId, date) collision', () => {
    expect(
      isTimedReservationConflict(
        prismaError('P2002', { target: ['Reservation_parkingSpotId_date_key'] })
      )
    ).toBe(false);
  });

  it('is false for a non-P2002 error and for a non-Prisma error', () => {
    expect(isTimedReservationConflict(prismaError('P2025'))).toBe(false);
    expect(isTimedReservationConflict(new Error('not a Prisma error'))).toBe(false);
  });
});

describe('isUniqueConstraintViolation', () => {
  it('is true only for P2002', () => {
    expect(isUniqueConstraintViolation(prismaError('P2002'))).toBe(true);
    expect(isUniqueConstraintViolation(prismaError('P2025'))).toBe(false);
    expect(isUniqueConstraintViolation(new Error('not a Prisma error'))).toBe(false);
    expect(isUniqueConstraintViolation(undefined)).toBe(false);
  });

  it('narrows the error, so a caller can read `meta` without a second instanceof', () => {
    // The assertion that matters here is the one `tsc` makes: this block only
    // compiles while the function returns a type predicate. Reverting it to
    // `boolean` fails `api:typecheck`, not this expectation.
    const error: unknown = prismaError('P2002', { target: ['userId', 'date'] });
    if (!isUniqueConstraintViolation(error)) {
      throw new Error('Expected a unique-constraint violation.');
    }
    expect(mapUniqueConstraintViolation(error.meta)).toBe('RESERVATION_LIMIT_REACHED');
  });
});
