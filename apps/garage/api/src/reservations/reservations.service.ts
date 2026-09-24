/**
 * Single-day reservations: taking a spot, and giving it back.
 *
 * The whole risk of this task is in {@link ReservationsService.cancel}. Creating
 * is a guarded insert; cancelling is a delete that may hand the freed spot
 * straight to somebody else, inside one transaction, while other requests are
 * doing the same thing to neighbouring rows.
 *
 * ## Three concurrency guarantees, and which mechanism provides each
 *
 * | rule | mechanism |
 * | --- | --- |
 * | one reservation per spot per day | unique index `Reservation (parkingSpotId, date)` |
 * | one reservation per user per day | unique index `Reservation (userId, date)` |
 * | the queue is served in order, once | `SELECT … FOR UPDATE` in `WaitlistPromotionService` |
 *
 * None of the three is a check in this file, and that is deliberate. A
 * read-then-write check cannot be made safe against a concurrent writer, so
 * every check below is a way of producing a *better error message* than the
 * index would, never the thing that enforces the rule. Where the two disagree
 * — because a writer committed between the read and the write — the index wins
 * and `mapUniqueConstraintViolation` turns its `P2002` into the same contract
 * code the check would have produced.
 *
 * ## Why cancellation retries
 *
 * The one place a `P2002` is genuinely *transient* is promotion. The queue is
 * locked and the candidate's other reservations are read inside the
 * transaction, but a reservation for that candidate can still be committed by
 * another request between the read and the promoting insert — a second
 * cancellation, on a different spot, whose queue that same person heads.
 *
 * Retrying the whole transaction is the answer rather than catching the error
 * inside it: a failed statement aborts a Postgres transaction, so there is no
 * "continue with the next candidate" available without savepoints, which the
 * Prisma client does not expose.
 *
 * **The retry terminates.** Each attempt re-reads the queue, and the reservation
 * that caused the previous attempt to fail is by then committed — so the
 * candidate that lost is skipped by {@link WaitlistPromotionService}'s own
 * eligibility read, and the attempt makes strictly more progress than the last.
 * With N people queued for a cell, at most N candidates can be eliminated this
 * way. {@link MAX_CANCEL_ATTEMPTS} bounds it anyway, because a bound that
 * depends on an argument about somebody else's code is not a bound.
 *
 * **When the retry itself loses**, the caller gets `CONFLICT` — a declared error
 * on `reservation.cancel`, and a 409, so the client is told it lost a race and
 * may try again, rather than being told the server broke. What it does *not* do
 * is cancel without promoting: a partial outcome is exactly what one transaction
 * exists to rule out.
 *
 * ## Nothing that can block on the network happens inside the transaction
 *
 * The callback returns the events it wants emitted; they are published after
 * `await` resolves. See `reservation-events.ts`.
 */

import { Injectable } from '@nestjs/common';
import type {
  AdminUserMonthReservationsInput,
  CancelReservationInput,
  CancelReservationOutput,
  CreateReservationInput,
  CreateReservationOutput,
  MonthReservations,
  MyMonthReservationsInput,
  MyMonthReservationsOutput,
  ReservationWindowSettings,
} from '@garage/contract';
import type { Prisma } from '@garage/database';
import { Prisma as PrismaNamespace } from '@garage/database';
import type { DateOnly, YearMonth } from '@garage/shared-types';
import {
  endOfMonth,
  isMonthlyCapInForce,
  startOfYearMonth,
  todayInPrague,
} from '@garage/shared-types';
import { AuditLogService } from '../audit/audit-log.service';
import { ReservationLimitsService } from '../reservation-limits/reservation-limits.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import {
  isUniqueConstraintViolation,
  isWriteConflict,
  mapUniqueConstraintViolation,
} from '../common/errors/prisma-error-mapping';
import {
  toContractReservation,
  toDateColumn,
  toDateOnly,
  toPublicReservation,
} from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { assertActiveUser } from './active-user';
import {
  assertWithinMonthlyReservationCap,
  readMonthlyReservationCap,
} from './monthly-reservation-cap';
import type { DomainEvent, WaitlistPromotionNotice } from './reservation-events';
import { DomainEventPublisher } from './reservation-events';
import { ReservationPolicy } from './reservation-policy';
import { RESERVATION_TRANSACTION_OPTIONS } from './transaction-options';
import { WaitlistPromotionService } from './waitlist-promotion.service';

/**
 * How many times a cancellation may lose the promotion race before answering
 * `CONFLICT`.
 *
 * Three, not one: a single retry is enough for the two-cancellation race that
 * actually happens, and the extra attempts cost nothing unless a cell's queue is
 * being drained from several directions at once. Not unbounded, because the
 * transaction holds row locks and a request that never gives up is a request
 * that holds them forever.
 */
export const MAX_CANCEL_ATTEMPTS = 3;

/** What one cancel attempt produced, before anything is broadcast. */
interface CancelOutcome {
  result: CancelReservationOutput;
  events: DomainEvent[];
  notices: WaitlistPromotionNotice[];
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly window: ReservationWindowService,
    private readonly policy: ReservationPolicy,
    private readonly promotion: WaitlistPromotionService,
    private readonly audit: AuditLogService,
    private readonly publisher: DomainEventPublisher,
    private readonly limits: ReservationLimitsService
  ) {}

  /**
   * Reserves one spot for one day.
   *
   * The spot lookup is a real check (a retired or non-existent spot has no
   * constraint to violate — the foreign key would only say `CONFLICT`), the two
   * one-per-day rules are not: they are left to the unique indexes, which is
   * what makes two simultaneous requests for the last free spot produce one
   * reservation and one `SPOT_ALREADY_RESERVED` rather than two reservations.
   *
   * **The holder may be somebody else**, if the caller is an admin: another
   * user, or a guest. `assertMayNameHolder` is the boundary; the target user's
   * existence is a real check (a foreign key would only say `CONFLICT`), and the
   * two one-per-day rules stay the unique indexes' job. A guest has no `userId`,
   * so `(userId, date)` does not apply to one — see `doc/decision/0303-*`.
   */
  async create(
    input: CreateReservationInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<CreateReservationOutput> {
    const settings = await this.window.getSettings();
    // Authorization before the day's own state: a non-admin naming somebody
    // else is refused as `FORBIDDEN` even in a locked month, because that is
    // the more specific and more durable fact about the request — the same
    // argument `ReservationPolicy`'s class comment makes for reporting a
    // Saturday ahead of a lock.
    this.policy.assertMayNameHolder(input.holder, actor);
    this.policy.assertMayTakeDay(input.date, actor, settings, today);

    // Same settings snapshot as the window check above, so one request is never
    // judged "open" under one lock mode and "capped" under another.
    const capInForce = isMonthlyCapInForce(
      input.date,
      settings.openDaysBefore,
      settings.lockMode,
      today
    );

    const spot = await this.prisma.client.parkingSpot.findUnique({
      where: { id: input.parkingSpotId },
      select: { id: true, active: true },
    });
    if (spot === null || !spot.active) {
      throw new DomainError('NOT_FOUND', { message: 'No such active parking spot.' });
    }

    // Which row the reservation belongs to, and which plate it freezes.
    // An omitted holder is the caller, unchanged behaviour and no plate override.
    const holder = input.holder ?? { kind: 'USER' as const, userId: actor.id, licensePlate: null };

    if (holder.kind === 'USER' && holder.userId !== actor.id) {
      // See `active-user.ts` for why this is a real check and runs outside
      // the transaction, for the same reason the spot lookup above does.
      await assertActiveUser(this.prisma.client, holder.userId);
    }

    // The reservation and the audit entry that records it share a transaction:
    // a reservation nobody can account for is exactly what the audit log exists
    // to prevent. No locks are taken and no queue is read, so this is short.
    const reservation = await this.prisma.client.$transaction(async (tx) => {
      if (holder.kind === 'USER' && capInForce) {
        const cap = await readMonthlyReservationCap(tx);
        await assertWithinMonthlyReservationCap(tx, holder.userId, input.date, 1, cap);
      }

      // `include` rather than a second read: the broadcast needs the holder's
      // plate, and `AuthenticatedUser` deliberately does not carry one (it is a
      // token claim short of the row). One statement, one consistent answer.
      // For a guest the relation is simply absent.
      const row = await tx.reservation.create({
        data: {
          parkingSpotId: input.parkingSpotId,
          userId: holder.kind === 'USER' ? holder.userId : null,
          guestName: holder.kind === 'GUEST' ? holder.name : null,
          licensePlate: holder.licensePlate,
          date: toDateColumn(input.date),
        },
        include: { user: { select: { id: true, name: true, licensePlate: true } } },
      });
      // `RESERVATION_CREATED` still means "the holder took it for themselves",
      // admin or not; naming somebody else is a different action, because the
      // trail has to say who acted and on whose behalf.
      const bookedForSomebodyElse = !(holder.kind === 'USER' && holder.userId === actor.id);
      // The `payload` shape is fixed per action by `../audit/audit-payloads.ts`.
      await this.audit.record(
        bookedForSomebodyElse
          ? {
              actorUserId: actor.id,
              action: 'RESERVATION_CREATED_BY_ADMIN',
              entityType: 'Reservation',
              entityId: row.id,
              payload: {
                parkingSpotId: row.parkingSpotId,
                date: input.date,
                holderUserId: row.userId,
                guestName: row.guestName,
              },
            }
          : {
              actorUserId: actor.id,
              action: 'RESERVATION_CREATED',
              entityType: 'Reservation',
              entityId: row.id,
              payload: { parkingSpotId: row.parkingSpotId, date: input.date },
            },
        tx
      );
      return row;
    }, RESERVATION_TRANSACTION_OPTIONS);

    this.publisher.publish([
      {
        name: 'reservation:created',
        payload: {
          date: input.date,
          parkingSpotId: reservation.parkingSpotId,
          reservation: toPublicReservation(reservation, reservation.user),
        },
      },
    ]);

    return toContractReservation(reservation);
  }

  /**
   * The caller's own confirmed reservations in one calendar month.
   *
   * See {@link monthSummary} for why this and `userMonth` share one body.
   */
  async myMonth(
    input: MyMonthReservationsInput,
    actor: AuthenticatedUser
  ): Promise<MyMonthReservationsOutput> {
    return this.monthSummary(actor.id, input.month);
  }

  /**
   * One **named** user's confirmed reservations in one calendar month, for an
   * admin booking on that person's behalf.
   *
   * `actor` is unused on purpose and stays in the signature: the authorization
   * is `@Roles('ADMIN')` on the route (`reservations.controller.ts`), not a
   * row-level rule this method could apply — there is no per-row decision to
   * make about a read of somebody's own month. Keeping the parameter matches
   * every other service method's shape, so the controller wiring reads the
   * same as its neighbours.
   *
   * An unknown `userId` holds no reservations and is answered as an empty
   * month rather than `NOT_FOUND`; the contract says why.
   */
  async userMonth(
    input: AdminUserMonthReservationsInput,
    _actor: AuthenticatedUser
  ): Promise<MonthReservations> {
    return this.monthSummary(input.userId, input.month);
  }

  /**
   * The frontend counterpart of `assertWithinMonthlyReservationCap`
   * (`./monthly-reservation-cap.ts`), which this must never diverge from: both
   * read the same `[startOfYearMonth(month), endOfMonth(...)]` range for the
   * same `userId`. One body, two procedures — `myMonth` supplies the caller's
   * id and `userMonth` a named one, and that is the *only* difference between
   * them, so it is the only thing either method says.
   *
   * Unlike the cap check, this takes no lock — it answers "what does this user
   * currently hold", not "may an insert proceed", so there is nothing here for
   * a concurrent writer to race against in a way that matters: a reservation
   * created a moment after this read simply is not reflected yet, the same
   * staleness every other read in this app tolerates.
   *
   * The `cap` it reports is the same admin setting the check enforces, read
   * through `ReservationLimitsService` — this runs outside any transaction, so
   * it is not the transaction-scoped `readMonthlyReservationCap` the writers
   * use. Both default a missing row to `DEFAULT_MONTHLY_RESERVATION_CAP`.
   */
  private async monthSummary(userId: string, month: YearMonth): Promise<MonthReservations> {
    const from = startOfYearMonth(month);
    const to = endOfMonth(from);

    const [rows, cap] = await Promise.all([
      this.prisma.client.reservation.findMany({
        where: {
          userId,
          date: { gte: toDateColumn(from), lte: toDateColumn(to) },
        },
        select: { date: true },
        // `id` is a tiebreaker that can never fire: `Reservation (userId, date)`
        // is a unique index, so this `userId` has at most one row per `date`.
        // Included anyway because it is the one `orderBy` shape `PrismaDouble`
        // (`../testing/prisma-double.ts`) has been taught for this table, and a
        // deterministic order is free to ask for.
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
      this.limits.monthlyCap(),
    ]);

    return {
      month,
      reservedDates: rows.map((row) => toDateOnly(row.date)),
      count: rows.length,
      cap,
    };
  }

  /**
   * Cancels a reservation and, in the same transaction, hands the freed spot to
   * the first eligible person queued for it.
   *
   * **No window check.** Ruling window-1: a user may always give a spot back,
   * including in a locked month, and the promotion that follows is a system
   * action which the window never applied to either. That is not an omission,
   * it is why `cancelReservationContract` declares no window errors at all.
   * The window settings are still read — once, before the retry loop —
   * because the promotion's monthly cap applies only while the cap is in
   * force (`isMonthlyCapInForce`).
   */
  async cancel(
    input: CancelReservationInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<CancelReservationOutput> {
    // Outside the retry loop: one cancellation, one reading of the window.
    const settings = await this.window.getSettings();
    const outcome = await this.committedCancel(input, actor, settings, today);

    // Past `await`, so past `COMMIT` — and deliberately outside the retry loop.
    // Nothing above this line may talk to Slack or Socket.io; nothing below it
    // is inside a transaction, and a publisher that threw here must not be
    // mistaken for a lost race and re-run a cancellation that has committed.
    this.publisher.publish(outcome.events);
    this.publisher.notifyPromotions(outcome.notices);
    return outcome.result;
  }

  /** {@link cancel}'s transaction, retried. Returns only once something committed. */
  private async committedCancel(
    input: CancelReservationInput,
    actor: AuthenticatedUser,
    settings: ReservationWindowSettings,
    today: DateOnly
  ): Promise<CancelOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          (tx) => this.cancelOnce(tx, input, actor, settings, today),
          RESERVATION_TRANSACTION_OPTIONS
        );
      } catch (error) {
        if (!this.isRetryableConflict(error)) {
          throw error;
        }
        if (attempt >= MAX_CANCEL_ATTEMPTS) {
          throw this.exhaustedRetries();
        }
      }
    }
  }

  /** One attempt. Everything here runs inside `tx`; nothing here does I/O off-box. */
  private async cancelOnce(
    tx: Prisma.TransactionClient,
    input: CancelReservationInput,
    actor: AuthenticatedUser,
    settings: ReservationWindowSettings,
    today: DateOnly
  ): Promise<CancelOutcome> {
    // Locked, not merely read: two requests cancelling the same reservation must
    // not both go on to promote. The loser blocks here, then finds the row gone.
    const [reservation] = await tx.$queryRaw<
      { id: string; parkingSpotId: string; userId: string | null; date: Date }[]
    >`
      SELECT "id", "parkingSpotId", "userId", "date"
      FROM "Reservation"
      WHERE "id" = ${input.reservationId}::uuid
      FOR UPDATE
    `;
    if (reservation === undefined) {
      throw new DomainError('NOT_FOUND', { message: 'No such reservation.' });
    }

    const isOwner = reservation.userId === actor.id;
    if (!isOwner && actor.role !== 'ADMIN') {
      throw new DomainError('FORBIDDEN', {
        message: 'Only the holder of a reservation, or an admin, may cancel it.',
      });
    }

    const date = toDateOnly(reservation.date);
    await tx.reservation.delete({ where: { id: reservation.id } });

    await this.audit.record(
      {
        actorUserId: actor.id,
        action: isOwner ? 'RESERVATION_CANCELLED' : 'RESERVATION_CANCELLED_BY_ADMIN',
        entityType: 'Reservation',
        entityId: reservation.id,
        payload: {
          parkingSpotId: reservation.parkingSpotId,
          date,
          holderUserId: reservation.userId,
        },
      },
      tx
    );

    const capInForce = isMonthlyCapInForce(date, settings.openDaysBefore, settings.lockMode, today);
    const promotion = await this.promotion.promote(
      tx,
      reservation.parkingSpotId,
      date,
      actor.id,
      capInForce
    );

    const cell = { date, parkingSpotId: reservation.parkingSpotId };
    if (promotion === null) {
      return {
        result: {
          reservationId: reservation.id,
          date,
          parkingSpotId: cell.parkingSpotId,
          promoted: false,
        },
        // One committed transaction, one event about the cell: the spot is free
        // and stays free. The queue length did not change, so no
        // `waitlist:updated` either — an empty queue is still empty.
        events: [
          { name: 'reservation:cancelled', payload: { ...cell, reservationId: reservation.id } },
        ],
        notices: [],
      };
    }

    const waitlistCount = await tx.waitlistEntry.count({
      where: { parkingSpotId: reservation.parkingSpotId, date: toDateColumn(date) },
    });

    // The promotion deleted every queue entry the promoted person held for this
    // day, which can shorten queues on spots nobody in this request named. Each
    // of those cells needs its own `waitlist:updated`: the web cache patches
    // `waitlistCount` only for the cell an event names
    // (`apps/garage/web/src/lot/lot-screen/day-overview-cache.ts`), so a cell that went 1 → 0 in
    // silence keeps showing "1 waiting" — and everyone queued behind the
    // promoted person there keeps a position one too high — until something
    // unrelated forces a refetch. Sequential rather than `Promise.all`: these
    // are extra round trips inside a transaction that is holding row locks, and
    // an interactive transaction is not a place to fan out.
    const otherCellEvents: DomainEvent[] = [];
    for (const parkingSpotId of promotion.clearedParkingSpotIds) {
      if (parkingSpotId === reservation.parkingSpotId) {
        continue;
      }
      const count = await tx.waitlistEntry.count({
        where: { parkingSpotId, date: toDateColumn(date) },
      });
      otherCellEvents.push({
        name: 'waitlist:updated',
        payload: { date, parkingSpotId, waitlistCount: count },
      });
    }

    return {
      result: {
        reservationId: reservation.id,
        date,
        parkingSpotId: cell.parkingSpotId,
        promoted: true,
      },
      events: [
        {
          // `reassigned`, never `cancelled` + `created`: the contract's schemas
          // say so, and a client that saw both would flash the cell empty.
          name: 'reservation:reassigned',
          payload: {
            ...cell,
            cause: 'WAITLIST_PROMOTION',
            previousReservationId: reservation.id,
            reservation: toPublicReservation(promotion.reservation, promotion.user),
            fromWaitlistEntryId: promotion.waitlistEntryId,
          },
        },
        // A different fact about the same cell: the queue got shorter.
        { name: 'waitlist:updated', payload: { ...cell, waitlistCount } },
        // …and the same fact about every other cell the promotion emptied.
        ...otherCellEvents,
      ],
      notices: [
        {
          userId: promotion.user.id,
          parkingSpotId: reservation.parkingSpotId,
          date,
          reservationId: promotion.reservation.id,
        },
      ],
    };
  }

  /**
   * True for a failure a *retry* can actually clear. There are exactly two, and
   * both come from promotion.
   *
   * **`P2002` on `Reservation (userId, date)`** — the promoted candidate
   * acquired a reservation elsewhere on that day between this transaction's
   * eligibility read and its insert.
   *
   * **A deadlock** (`40P01`). Found by `waitlist-concurrency.db.spec.ts`, not by
   * reasoning, and worth spelling out because it is not obvious. Two
   * cancellations on different spots, same day, whose queues are headed by the
   * same person:
   *
   * ```
   * T1 (spot A)                            T2 (spot B)
   * FOR UPDATE on A's queue  ✓             FOR UPDATE on B's queue  ✓
   * INSERT reservation for W ✓
   *                                        INSERT reservation for W  → waits on
   *                                          T1's uncommitted (userId, date) key
   * DELETE W's queue entries for the day
   *   → waits on B's queue row, held by T2
   * ```
   *
   * A cycle, so PostgreSQL kills one of them. The cross-cell `DELETE` is
   * required by the rule ("their other waitlist entries for that day are
   * deleted"), and no ordering of the locks *this design* takes removes it — a
   * transaction cannot know which cells it will have to reach into until it has
   * read the queue. (An ordering that would remove it exists — locking the
   * whole day's queue rows in canonical order — but that is functionally the
   * `pg_advisory_xact_lock` upgrade path documented as the alternative, not a
   * variant of the current locking.) Retrying is the documented remedy, and it
   * converges for the same reason the `P2002` retry does: the winner's
   * reservation is committed by then, so the retry skips that candidate and
   * never reaches for the other cell at all.
   *
   * Which of the two statements the server picks as the victim is not ours to
   * choose, and it decides how the failure is *spelled*: the promotion's
   * `INSERT` is Prisma's own SQL and comes back `P2034`, while the cross-cell
   * `DELETE … RETURNING` is a `$queryRaw` and comes back `P2010` wrapping the
   * same `40P01`. Both are the identical condition and both must be retried,
   * which is why the test is {@link isWriteConflict} and not `code === 'P2034'`.
   * Getting that wrong made half of `waitlist-concurrency.db.spec.ts`'s
   * concurrent-cancellation runs fail — `doc/decision/0240-*`.
   *
   * See `doc/decision/0065-*` for the full deadlock analysis and the
   * advisory-lock upgrade path.
   *
   * `SPOT_ALREADY_RESERVED` is deliberately **not** retryable: it would mean
   * somebody took the cell this transaction was in the middle of freeing, which
   * the unique index makes impossible while our delete is uncommitted. If it
   * ever happened it would be a defect, and retrying a defect only makes it
   * slower.
   */
  private isRetryableConflict(error: unknown): boolean {
    if (!(error instanceof PrismaNamespace.PrismaClientKnownRequestError)) {
      return false;
    }
    if (isWriteConflict(error)) {
      return true;
    }
    return (
      isUniqueConstraintViolation(error) &&
      mapUniqueConstraintViolation(error.meta) === 'RESERVATION_LIMIT_REACHED'
    );
  }

  /**
   * The error the caller sees when the attempts run out.
   *
   * `CONFLICT` rather than the raw `RESERVATION_LIMIT_REACHED`: the caller does
   * not have a reservation-limit problem — somebody they have never heard of
   * does, and telling them "you already have a reservation that day" would be
   * false. `CONFLICT` is declared on `reservation.cancel`, is also a 409, and
   * its Czech copy ("někdo jiný mezitím provedl stejnou změnu — zkuste to
   * prosím znovu") is exactly the situation.
   */
  private exhaustedRetries(): DomainError {
    return new DomainError('CONFLICT', {
      message: 'The freed spot could not be handed on; another request kept winning the race.',
      details: { attempts: MAX_CANCEL_ATTEMPTS },
    });
  }
}
