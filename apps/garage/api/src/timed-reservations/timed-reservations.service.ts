/**
 * Admin-only, guest-only half-hour blocks: `admin.timedReservation.create` and
 * `.cancel`.
 *
 * **The exclusivity rule is not checked here.** One (spot, day) is either one
 * full-day `Reservation` or any number of non-overlapping `TimedReservation`
 * blocks, never both — a `CHECK` and a pair of triggers in the migration
 * enforce that (`doc/decision/0314-*`), and their `P2002` is mapped onto
 * `SPOT_ALREADY_RESERVED` by `mapUniqueConstraintViolation`, the same mapping
 * `ReservationsService` relies on for the plain one-per-day rule. A
 * read-then-write check here could not be made safe against a concurrent
 * writer anyway, so — as in `reservations.service.ts` — nothing below is the
 * thing that enforces the rule, only a way of producing a real `NOT_FOUND` /
 * `PAST_DATE` / `VALIDATION_FAILED` ahead of it.
 *
 * **The list is re-read inside the transaction** because the realtime event
 * carries the *whole current list* of blocks on the cell, not a delta
 * (`timedReservationsUpdatedEventSchema`'s comment) — so after a create or a
 * cancel, this reads back every block still on that (spot, day) rather than
 * patching the one row it just touched.
 *
 * **Events publish after commit**, exactly as `reservation-events.ts`
 * documents: the transaction callback returns nothing to publish and instead
 * computes the list itself, but the publish call still happens only once
 * `await` on `$transaction` has resolved, never inside it.
 */

import { Injectable } from '@nestjs/common';
import type {
  CancelTimedReservationInput,
  CancelTimedReservationOutput,
  CreateTimedReservationInput,
  TimedReservation,
} from '@garage/contract';
import type { Prisma, TimedReservation as TimedReservationRow } from '@garage/database';
import type { DateOnly } from '@garage/shared-types';
import { timeOfDayToMinutes, todayInPrague } from '@garage/shared-types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import {
  toContractTimedReservation,
  toDateColumn,
  toPublicTimedReservation,
} from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { DomainEventPublisher } from '../reservations/reservation-events';
import { ReservationPolicy } from '../reservations/reservation-policy';
import { RESERVATION_TRANSACTION_OPTIONS } from '../reservations/transaction-options';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';

@Injectable()
export class TimedReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly window: ReservationWindowService,
    private readonly policy: ReservationPolicy,
    private readonly audit: AuditLogService,
    private readonly publisher: DomainEventPublisher
  ) {}

  /**
   * Books one half-hour-granular block for a guest.
   *
   * The window exemption for admins comes free from
   * `ReservationPolicy.assertMayTakeDay` — the same guard `reservation.create`
   * runs — so `OUT_OF_HORIZON` / `RESERVATIONS_LOCKED` never reach this
   * procedure, which is why the contract does not declare them.
   */
  async create(
    input: CreateTimedReservationInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<TimedReservation> {
    const settings = await this.window.getSettings();
    this.policy.assertMayTakeDay(input.date, actor, settings, today);

    const spot = await this.prisma.client.parkingSpot.findUnique({
      where: { id: input.parkingSpotId },
      select: { active: true },
    });
    if (spot === null || !spot.active) {
      throw new DomainError('NOT_FOUND', { message: 'No such active parking spot.' });
    }

    const { row, blocks } = await this.prisma.client.$transaction(async (tx) => {
      // The (spot, day) trigger is what actually enforces exclusivity; its
      // P2002 is mapped to `SPOT_ALREADY_RESERVED` by the exception filter.
      const created = await tx.timedReservation.create({
        data: {
          parkingSpotId: input.parkingSpotId,
          date: toDateColumn(input.date),
          startMinute: timeOfDayToMinutes(input.startTime),
          endMinute: timeOfDayToMinutes(input.endTime),
          guestName: input.guestName,
          licensePlate: input.licensePlate,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'TIMED_RESERVATION_CREATED',
          entityType: 'TimedReservation',
          entityId: created.id,
          payload: {
            parkingSpotId: input.parkingSpotId,
            date: input.date,
            startTime: input.startTime,
            endTime: input.endTime,
            guestName: input.guestName,
          },
        },
        tx
      );
      return { row: created, blocks: await this.blocksOn(tx, input.parkingSpotId, created.date) };
    }, RESERVATION_TRANSACTION_OPTIONS);

    this.publishBlocks(input.parkingSpotId, input.date, blocks);
    return toContractTimedReservation(row);
  }

  /** Removes one block. */
  async cancel(
    input: CancelTimedReservationInput,
    actor: AuthenticatedUser
  ): Promise<CancelTimedReservationOutput> {
    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.timedReservation.findUnique({
        where: { id: input.timedReservationId },
      });
      if (row === null) {
        throw new DomainError('NOT_FOUND', { message: 'No such timed reservation.' });
      }
      await tx.timedReservation.delete({ where: { id: row.id } });
      const contract = toContractTimedReservation(row);
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: 'TIMED_RESERVATION_CANCELLED',
          entityType: 'TimedReservation',
          entityId: row.id,
          payload: {
            parkingSpotId: row.parkingSpotId,
            date: contract.date,
            startTime: contract.startTime,
            endTime: contract.endTime,
            guestName: row.guestName,
          },
        },
        tx
      );
      return { contract, blocks: await this.blocksOn(tx, row.parkingSpotId, row.date) };
    }, RESERVATION_TRANSACTION_OPTIONS);

    this.publishBlocks(outcome.contract.parkingSpotId, outcome.contract.date, outcome.blocks);
    return {
      timedReservationId: outcome.contract.id,
      date: outcome.contract.date,
      parkingSpotId: outcome.contract.parkingSpotId,
    };
  }

  /** Every block still on this (spot, day), ascending by start time. */
  private blocksOn(
    tx: Prisma.TransactionClient,
    parkingSpotId: string,
    date: Date
  ): Promise<TimedReservationRow[]> {
    return tx.timedReservation.findMany({
      where: { parkingSpotId, date },
      orderBy: { startMinute: 'asc' },
    });
  }

  private publishBlocks(
    parkingSpotId: string,
    date: DateOnly,
    blocks: readonly TimedReservationRow[]
  ): void {
    this.publisher.publish([
      {
        name: 'timed-reservations:updated',
        payload: {
          date,
          parkingSpotId,
          timedReservations: blocks.map(toPublicTimedReservation),
        },
      },
    ]);
  }
}
