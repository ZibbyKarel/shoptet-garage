/**
 * What happens when the retry itself keeps losing.
 *
 * Everything else about cancellation is tested against a real PostgreSQL, and
 * should be. This one case cannot be: it needs a conflict to recur
 * {@link MAX_CANCEL_ATTEMPTS} times in a row, and a real race that is *forced*
 * to be lost three times running is not a race any more — it is a stub with
 * extra steps and a database attached.
 *
 * So the transaction is the stub here, and nothing else is: the service under
 * test is the real one, and the error it is fed is the shape
 * `database-contract.db.spec.ts` pins against PostgreSQL 17 on every
 * `api:test-db`. That is the arrangement this project learned to insist on — a
 * double may stand in for *when* an error arrives, never for what one looks
 * like.
 *
 * The two claims:
 *
 * 1. it stops. `MAX_CANCEL_ATTEMPTS` attempts, not an unbounded loop holding row
 *    locks forever;
 * 2. it stops with `CONFLICT`, not with the underlying
 *    `RESERVATION_LIMIT_REACHED` — which would tell the caller *they* have a
 *    reservation-limit problem when in fact somebody they have never heard of
 *    does.
 */

import { Prisma } from '@garage/database';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import { mapUniqueConstraintViolation } from '../common/errors/prisma-error-mapping';
import type { PrismaService } from '../database/prisma.service';
import type { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { MAX_CANCEL_ATTEMPTS, ReservationsService } from './reservations.service';

const ACTOR: AuthenticatedUser = {
  id: '00000000-0000-7000-8000-000000000001',
  oktaId: 'okta-1',
  email: 'user@example.test',
  name: 'User',
  role: 'USER',
  active: true,
};

/**
 * The `P2002` that a promotion losing its race actually produces.
 *
 * Transcribed from a live server — `database-contract.db.spec.ts`
 * ("Reservation(userId, date) is RESERVATION_LIMIT_REACHED") asserts the same
 * shape against PostgreSQL, so if Prisma ever changes it, that suite fails and
 * this constant is what has to be corrected.
 */
function promotionConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Reservation',
      driverAdapterError: {
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'Reservation_userId_date_key' },
          table: 'Reservation',
        },
      },
    },
  });
}

/** A `PrismaService` whose `$transaction` always fails with `error`. */
function alwaysFailing(error: unknown): { prisma: PrismaService; attempts: () => number } {
  let attempts = 0;
  const prisma = {
    client: {
      $transaction: async () => {
        attempts += 1;
        throw error;
      },
    },
  } as unknown as PrismaService;

  return { prisma, attempts: () => attempts };
}

function serviceOver(prisma: PrismaService): ReservationsService {
  const unused = undefined as never;
  const window = {
    getSettings: () => Promise.resolve({ openDaysBefore: 7, lockMode: 'AUTO' as const }),
  } as unknown as ReservationWindowService;
  return new ReservationsService(prisma, window, unused, unused, unused, unused, unused);
}

describe('a cancellation whose retries all lose', () => {
  it('is fed the error a real promotion conflict produces', () => {
    // Guards the rest of this file: if the shape stopped mapping, every
    // assertion below would be about a code path the service never takes.
    expect(mapUniqueConstraintViolation(promotionConflict().meta)).toBe(
      'RESERVATION_LIMIT_REACHED'
    );
  });

  it('gives up after MAX_CANCEL_ATTEMPTS rather than looping forever', async () => {
    const { prisma, attempts } = alwaysFailing(promotionConflict());

    await expect(
      serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)
    ).rejects.toBeInstanceOf(DomainError);

    expect(attempts()).toBe(MAX_CANCEL_ATTEMPTS);
  });

  it('reports CONFLICT, not the constraint the caller had nothing to do with', async () => {
    const { prisma } = alwaysFailing(promotionConflict());

    const error = await serviceOver(prisma)
      .cancel({ reservationId: 'r-1' }, ACTOR)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('CONFLICT');
    expect((error as DomainError).details).toEqual({ attempts: MAX_CANCEL_ATTEMPTS });
  });

  it('does not retry a deadlock forever either', async () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError('Write conflict', {
      code: 'P2034',
      clientVersion: '7.10.0',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '40P01', kind: 'TransactionWriteConflict' },
        },
      },
    });
    const { prisma, attempts } = alwaysFailing(deadlock);

    await expect(serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      }
    );
    expect(attempts()).toBe(MAX_CANCEL_ATTEMPTS);
  });

  it('retries the same deadlock when it arrives from a raw statement, as P2010', async () => {
    // The regression `doc/decision/0240-*` records. `promote`'s cross-cell
    // `DELETE … RETURNING` is a `$queryRaw`, so when *it* is the deadlock victim
    // the driver's error is wrapped rather than translated, and the code is
    // `P2010`, not `P2034`. A predicate that tested only `P2034` stopped
    // retrying — silently, because nothing throws when a retry does not happen.
    //
    // Transcribed from a live server, like every other shape in this file:
    // `database-contract.db.spec.ts` ("a deadlock on a raw statement") asserts
    // it against PostgreSQL 17, so an upstream change fails there and this
    // constant is what gets corrected.
    const rawDeadlock = new Prisma.PrismaClientKnownRequestError(
      '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `40P01`. Message: `deadlock detected`',
      {
        code: 'P2010',
        clientVersion: '7.10.0',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '40P01',
              originalMessage: 'deadlock detected',
              kind: 'TransactionWriteConflict',
            },
          },
        },
      }
    );
    const { prisma, attempts } = alwaysFailing(rawDeadlock);

    await expect(serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)).rejects.toMatchObject(
      { code: 'CONFLICT' }
    );
    expect(attempts()).toBe(MAX_CANCEL_ATTEMPTS);
  });

  it('does not retry a raw query that failed for any other reason — that is a defect', async () => {
    // The other half of the same predicate, and the reason it matches SQLSTATE
    // class 40 rather than "any P2010": a malformed cast or a typo in raw SQL
    // fails identically on every attempt, so retrying it only makes the defect
    // take three times as long to report and holds row locks while it does.
    const badCast = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `22P02`. Message: `invalid input syntax for type uuid`',
      {
        code: 'P2010',
        clientVersion: '7.10.0',
        meta: {
          driverAdapterError: {
            cause: { originalCode: '22P02', kind: 'QueryError' },
          },
        },
      }
    );
    const { prisma, attempts } = alwaysFailing(badCast);

    await expect(serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)).rejects.toBe(badCast);
    expect(attempts()).toBe(1);
  });

  it('does not retry anything else — a NOT_FOUND is final on the first attempt', async () => {
    const notFound = new DomainError('NOT_FOUND');
    const { prisma, attempts } = alwaysFailing(notFound);

    await expect(serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)).rejects.toBe(
      notFound
    );
    expect(attempts()).toBe(1);
  });

  it('does not retry SPOT_ALREADY_RESERVED, which would be a defect rather than a race', async () => {
    const spotTaken = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'Reservation',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: 'Reservation_parkingSpotId_date_key' },
            table: 'Reservation',
          },
        },
      },
    });
    const { prisma, attempts } = alwaysFailing(spotTaken);

    await expect(serviceOver(prisma).cancel({ reservationId: 'r-1' }, ACTOR)).rejects.toBe(
      spotTaken
    );
    expect(attempts()).toBe(1);
  });
});
