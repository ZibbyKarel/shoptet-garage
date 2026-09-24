/**
 * The waitlist: queueing for a spot somebody else holds, and leaving that queue.
 *
 * Promotion **out** of a queue is not here and is never a client call — it
 * happens inside the cancellation that frees the spot
 * (`WaitlistPromotionService`).
 *
 * ## Why joining locks the reservation row
 *
 * "You may only queue for an occupied spot" is a read, and a read of a row
 * another transaction is in the middle of deleting is a read of something that
 * is about to stop being true:
 *
 * ```
 * T1 join (spot S, day D)               T2 cancel the reservation on S/D
 * ─────────────────────────             ─────────────────────────
 * SELECT reservation → found
 *                                       DELETE it, queue empty, COMMIT
 * INSERT waitlist entry     ← queued for a spot that is now free, forever
 * ```
 *
 * `SELECT … FOR SHARE` on that reservation is what closes it. `FOR SHARE`
 * rather than `FOR UPDATE` because several people may legitimately join the
 * same queue at once and must not be serialised against each other — they only
 * need to be serialised against the *deleter*, and a shared lock conflicts with
 * the exclusive one `DELETE` takes. If the cancel gets there first, this
 * statement waits for its commit and then sees no row, and the caller is
 * correctly told `SPOT_NOT_OCCUPIED`.
 *
 * There is no deadlock against the cancel path even though both take two locks:
 * cancel takes `Reservation` then `WaitlistEntry`, join takes `Reservation` and
 * then only *inserts* — and an insert waits on no existing row's lock. Nothing
 * ever waits in the other direction, so there is no cycle to close.
 */

import { Injectable } from '@nestjs/common';
import type {
  JoinWaitlistInput,
  JoinWaitlistOutput,
  LeaveWaitlistInput,
  LeaveWaitlistOutput,
} from '@garage/contract';
import type { Prisma } from '@garage/database';
import type { DateOnly } from '@garage/shared-types';
import { todayInPrague } from '@garage/shared-types';
import { AuditLogService } from '../audit/audit-log.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import { toContractWaitlistEntry, toDateColumn, toDateOnly } from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { assertActiveUser } from './active-user';
import type { DomainEvent } from './reservation-events';
import { DomainEventPublisher } from './reservation-events';
import { ReservationPolicy } from './reservation-policy';
import { RESERVATION_TRANSACTION_OPTIONS } from './transaction-options';
import { WAITLIST_ORDER } from './waitlist-order';

/** What one waitlist mutation produced, before anything is broadcast. */
interface WaitlistOutcome<TResult> {
  result: TResult;
  events: DomainEvent[];
}

@Injectable()
export class WaitlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly window: ReservationWindowService,
    private readonly policy: ReservationPolicy,
    private readonly publisher: DomainEventPublisher,
    private readonly audit: AuditLogService
  ) {}

  /**
   * Joins the queue for an occupied spot.
   *
   * `RESERVATION_LIMIT_REACHED` is refused up front even though nothing is being
   * reserved: a promotion would hand the caller a second reservation on a day
   * they already have one, which the unique index would refuse — so the queue
   * would accept them and then silently never promote them. Refusing at the door
   * is the honest version of the same rule (see `joinWaitlistContract`).
   *
   * Unlike the other checks in this module, **this one has no index behind
   * it** — joining a queue never touches `Reservation`'s unique index, so a
   * reservation acquired elsewhere in the same instant this check passes is
   * not caught here. That is fine, not a gap: `WaitlistPromotionService`
   * re-checks eligibility at promotion time and skips such a candidate then,
   * so the worst case is a queue entry that (correctly) never promotes. See
   * `doc/waitlist.md` §"What happens under concurrency".
   *
   * **The target may be somebody else**, if the caller is an admin.
   * `assertMayNameWaitlistTarget` is the boundary, mirroring
   * `ReservationsService.create`'s `assertMayNameHolder`: every check below
   * that used to read `actor.id` — "already holds it", "already reserved that
   * day" — now reads `targetUserId`, because the question is always about the
   * person being queued, not the person submitting the form.
   */
  async join(
    input: JoinWaitlistInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<JoinWaitlistOutput> {
    const settings = await this.window.getSettings();
    this.policy.assertMayNameWaitlistTarget(input.holderId, actor);
    this.policy.assertMayTakeDay(input.date, actor, settings, today);

    const targetUserId = input.holderId ?? actor.id;
    if (targetUserId !== actor.id) {
      // See `active-user.ts` for why this is a real check and runs outside
      // the transaction.
      await assertActiveUser(this.prisma.client, targetUserId);
    }

    const outcome = await this.prisma.client.$transaction(
      (tx) => this.joinOnce(tx, input, actor, targetUserId),
      RESERVATION_TRANSACTION_OPTIONS
    );

    // Past `await`, so past `COMMIT`.
    this.publisher.publish(outcome.events);
    return outcome.result;
  }

  private async joinOnce(
    tx: Prisma.TransactionClient,
    input: JoinWaitlistInput,
    actor: AuthenticatedUser,
    targetUserId: string
  ): Promise<WaitlistOutcome<JoinWaitlistOutput>> {
    const spot = await tx.parkingSpot.findUnique({
      where: { id: input.parkingSpotId },
      select: { id: true, active: true },
    });
    if (spot === null || !spot.active) {
      throw new DomainError('NOT_FOUND', { message: 'No such active parking spot.' });
    }

    const dateColumn = toDateColumn(input.date);
    const [holder] = await tx.$queryRaw<{ id: string; userId: string | null }[]>`
      SELECT "id", "userId"
      FROM "Reservation"
      WHERE "parkingSpotId" = ${input.parkingSpotId}::uuid
        AND "date" = ${input.date}::date
      FOR SHARE
    `;
    if (holder === undefined) {
      // No full-day `Reservation`, but the cell may still carry guest time
      // blocks (`doc/decision/0314-*`) — that spot is not free either, it
      // just has no queue: see `WaitlistService.join`'s doc comment and
      // "A spot with blocks has no queue" in the decision record.
      const hasBlocks =
        (await tx.timedReservation.count({
          where: { parkingSpotId: input.parkingSpotId, date: dateColumn },
        })) > 0;
      throw new DomainError('SPOT_NOT_OCCUPIED', {
        message: hasBlocks
          ? 'That spot has guest time blocks instead of a full-day reservation, and there is no queue for it.'
          : 'That spot is free — reserve it instead of queueing for it.',
      });
    }
    if (holder.userId === targetUserId) {
      throw new DomainError('CANNOT_WAITLIST_OWN_SPOT', {
        message: 'That user already holds that spot for that day.',
      });
    }

    const own = await tx.reservation.findUnique({
      where: { userId_date: { userId: targetUserId, date: dateColumn } },
      select: { id: true },
    });
    if (own !== null) {
      throw new DomainError('RESERVATION_LIMIT_REACHED', {
        message:
          'That user already has a reservation on that day, so they could never be promoted.',
        details: { reservationId: own.id },
      });
    }

    // A duplicate join is left to the unique index rather than pre-checked, for
    // the reason every other check in this codebase is not the enforcement:
    // a read-then-write would still lose against a concurrent identical request.
    // `WaitlistEntry (parkingSpotId, userId, date)` maps to `ALREADY_IN_WAITLIST`.
    const entry = await tx.waitlistEntry.create({
      data: { parkingSpotId: input.parkingSpotId, userId: targetUserId, date: dateColumn },
    });

    // In the transaction, for the same reason the reservation's entry is: a
    // queue entry nobody can account for is what the audit log exists to
    // prevent, and `reservation.confirmBulk` writes the same action for the
    // rows it creates (`doc/decision/0091-*`). The `payload` shape is fixed per
    // action by `../audit/audit-payloads.ts`.
    //
    // `WAITLIST_JOINED` still means "the queued person joined for themselves",
    // admin or not; naming somebody else is a different action, because the
    // trail has to say who acted and on whose behalf — mirrors
    // `ReservationsService.create`'s `bookedForSomebodyElse` split.
    const queuedForSomebodyElse = targetUserId !== actor.id;
    await this.audit.record(
      queuedForSomebodyElse
        ? {
            actorUserId: actor.id,
            action: 'WAITLIST_JOINED_BY_ADMIN',
            entityType: 'WaitlistEntry',
            entityId: entry.id,
            payload: { parkingSpotId: input.parkingSpotId, date: input.date, targetUserId },
          }
        : {
            actorUserId: actor.id,
            action: 'WAITLIST_JOINED',
            entityType: 'WaitlistEntry',
            entityId: entry.id,
            payload: { parkingSpotId: input.parkingSpotId, date: input.date },
          },
      tx
    );

    // The position is read back rather than counted before the insert: what the
    // caller wants to know is where they *are*, and only the committed order can
    // say. Same order the promotion uses — `WAITLIST_ORDER` (`waitlist-order.ts`).
    const queue = await tx.waitlistEntry.findMany({
      where: { parkingSpotId: input.parkingSpotId, date: dateColumn },
      orderBy: WAITLIST_ORDER,
      select: { id: true },
    });
    const position = queue.findIndex((row) => row.id === entry.id) + 1;

    return {
      result: { entry: toContractWaitlistEntry(entry), position },
      events: [
        {
          name: 'waitlist:updated',
          payload: {
            date: input.date,
            parkingSpotId: input.parkingSpotId,
            waitlistCount: queue.length,
          },
        },
      ],
    };
  }

  /**
   * Leaves the queue.
   *
   * **No window check**, exactly like `reservation.cancel` — see
   * `doc/decision/0233-leaving-a-waitlist-is-exempt-from-the-reservation-window`,
   * which amends `doc/decision/0004-*`. The rule that used to be here read
   * "leaving reshuffles everybody behind you, so it is a write like any other".
   * Under the shipped `AUTO` / `openDaysBefore = 7` defaults that made leaving
   * impossible for the whole live life of every queue: `monthLockState` then
   * returned `LOCKED` from the 1st of the target month onwards (no longer —
   * `doc/decision/0315-*`), and the target month is
   * the only period a queue for it can be promoted in. The person was then
   * force-promoted into a reservation they had asked to leave, with no way out.
   * The reshuffle argument also cuts the other way: everyone behind you moves
   * *up*, which is nearer to cancellation (always allowed) than to creation.
   *
   * That is why `leaveWaitlistContract` declares no window errors at all.
   */
  async leave(input: LeaveWaitlistInput, actor: AuthenticatedUser): Promise<LeaveWaitlistOutput> {
    const outcome = await this.prisma.client.$transaction(
      (tx) => this.leaveOnce(tx, input, actor),
      RESERVATION_TRANSACTION_OPTIONS
    );

    this.publisher.publish(outcome.events);
    return outcome.result;
  }

  private async leaveOnce(
    tx: Prisma.TransactionClient,
    input: LeaveWaitlistInput,
    actor: AuthenticatedUser
  ): Promise<WaitlistOutcome<LeaveWaitlistOutput>> {
    // Locked: a promotion running right now wants this row too, and whichever
    // gets it first decides. If the promotion wins, the `delete` below finds
    // nothing and the caller is told `NOT_FOUND` — which is true, they were
    // promoted rather than left waiting.
    const [entry] = await tx.$queryRaw<
      { id: string; parkingSpotId: string; userId: string; date: Date }[]
    >`
      SELECT "id", "parkingSpotId", "userId", "date"
      FROM "WaitlistEntry"
      WHERE "id" = ${input.waitlistEntryId}::uuid
      FOR UPDATE
    `;
    if (entry === undefined) {
      throw new DomainError('NOT_FOUND', { message: 'No such waitlist entry.' });
    }
    if (entry.userId !== actor.id && actor.role !== 'ADMIN') {
      throw new DomainError('FORBIDDEN', {
        message: 'Only the person queued, or an admin, may leave a queue.',
      });
    }

    const date = toDateOnly(entry.date);
    await tx.waitlistEntry.delete({ where: { id: entry.id } });

    const waitlistCount = await tx.waitlistEntry.count({
      where: { parkingSpotId: entry.parkingSpotId, date: entry.date },
    });

    return {
      result: { waitlistEntryId: entry.id, parkingSpotId: entry.parkingSpotId, date },
      events: [
        {
          name: 'waitlist:updated',
          payload: { date, parkingSpotId: entry.parkingSpotId, waitlistCount },
        },
      ],
    };
  }
}
