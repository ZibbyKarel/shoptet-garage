/**
 * The append-only audit trail.
 *
 * Every admin action and every mutation that changes who may park where writes
 * one row here. That matters most for the operations that leave **no trace in
 * the data**: cancelling a reservation is a hard delete (`doc/decision/0027-*`),
 * so without an entry the row simply stops existing and nobody can say who
 * removed it or when.
 *
 * ## Append-only is enforced below this class, not by it
 *
 * There is deliberately no `update` and no `delete` here, but that is a
 * convenience, not the guarantee: two database triggers created by the init
 * migration reject `UPDATE`, `DELETE` and `TRUNCATE` against `AuditLog`
 * (`doc/decision/0027-*`). A service method is a rule anybody can route around
 * with `prisma.client.auditLog.deleteMany`; the trigger is not. What this class
 * owns is the *shape* of what goes in.
 *
 * ## Why `record` takes the client
 *
 * Task 13 writes its audit entries **inside** the interactive transaction that
 * cancels a reservation and promotes the next person in the queue: if the
 * transaction rolls back, the entry claiming it happened must roll back with it.
 * So the write runs on whatever client the caller is holding — the request-scoped
 * `PrismaService.client` by default, or a `Prisma.TransactionClient` when there
 * is one. That is why `record` is not simply `this.prisma.client.auditLog.create`.
 */

import { Injectable } from '@nestjs/common';
import type { AuditLogAction } from '@garage/contract';
import type { PrismaClient } from '@garage/database';
import { PrismaService } from '../database/prisma.service';
import type { AuditPayloads } from './audit-payloads';

/**
 * The subset of a Prisma client an audit write needs.
 *
 * Structural rather than nominal so that both `PrismaClient` and the
 * `Prisma.TransactionClient` handed to `$transaction`'s callback satisfy it,
 * without this module having to name the transaction type.
 */
export type AuditLogWriter = Pick<PrismaClient, 'auditLog'>;

/**
 * Entity kinds that can be audited. Narrower than the contract's
 * `entityType: z.string().min(1)` on purpose: a typo in a free string would
 * silently split one entity's history into two, and nothing would fail.
 *
 * Which action gets which kind is no longer decided here — that is
 * {@link AuditEntityTypeFor}, and this list is now the bound it is checked
 * against, so a kind named there has to be a kind that exists.
 */
export const AUDIT_ENTITY_TYPES = [
  'Reservation',
  'WaitlistEntry',
  'User',
  'ParkingSpot',
  'ReservationWindowSettings',
  'ReservationLimitSettings',
  'TimedReservation',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The entity kind each action applies to.
 *
 * One kind per action, not a free choice: `WAITLIST_JOINED` names a
 * `WaitlistEntry` and `WAITLIST_PROMOTED` names the `Reservation` it produced,
 * and a row that got those the wrong way round would be indistinguishable from
 * a correct one — `entityId` is an opaque string, so nothing downstream could
 * notice. Stated once here rather than re-decided at each of the twelve call
 * sites.
 */
type AuditEntityTypeFor = {
  RESERVATION_CREATED: 'Reservation';
  RESERVATION_CANCELLED: 'Reservation';
  RESERVATION_CANCELLED_BY_ADMIN: 'Reservation';
  WAITLIST_PROMOTED: 'Reservation';
  WAITLIST_JOINED: 'WaitlistEntry';
  USER_UPDATED: 'User';
  SPOT_UPDATED: 'ParkingSpot';
  RESERVATION_WINDOW_UPDATED: 'ReservationWindowSettings';
  RESERVATION_LIMITS_UPDATED: 'ReservationLimitSettings';
  RESERVATION_CREATED_BY_ADMIN: 'Reservation';
  WAITLIST_JOINED_BY_ADMIN: 'WaitlistEntry';
  TIMED_RESERVATION_CREATED: 'TimedReservation';
  TIMED_RESERVATION_CANCELLED: 'TimedReservation';
} & Record<AuditLogAction, AuditEntityType>;

/**
 * One entry, as a union over `action`.
 *
 * A union rather than a struct with an `action` field beside a JSON bag,
 * because `entityType` and `payload` are both *functions* of `action` — see
 * {@link AuditPayloads} for what a divergence in an append-only table costs.
 * Nothing here can name `WAITLIST_JOINED` and then describe a reservation, or
 * write `SPOT_UPDATED` with a key the other two spot writers do not use.
 *
 * The payload types are `type` aliases of object literals so they keep
 * TypeScript's implicit index signature and remain assignable to Prisma's JSON
 * **input** object — the column is `JSONB`, and a value that cannot be
 * serialised (a `Date`, a class instance, `undefined`) has no representation in
 * it. The contract's `Record<string, unknown>` would accept all three and fail
 * at runtime; reading the log back still yields the contract's shape.
 */
export type AuditEntry = {
  [TAction in AuditLogAction]: {
    /**
     * Who performed the action. A system action (waitlist auto-promotion) is
     * attributed to the user whose request triggered it — the audit log has a
     * non-null FK to `User` and there is no "system" row to point at.
     */
    actorUserId: string;
    action: TAction;
    entityType: AuditEntityTypeFor[TAction];
    entityId: string;
    /**
     * What happened, beyond what the row can recover on its own — the
     * before/after of a changed field, the day a deleted reservation was for.
     */
    payload: AuditPayloads[TAction];
  };
}[AuditLogAction];

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one entry.
   *
   * @param entry  what happened
   * @param writer the client to write through; defaults to the request's own.
   *               Pass the transaction client to make the entry share the fate
   *               of the change it describes.
   */
  async record(entry: AuditEntry, writer: AuditLogWriter = this.prisma.client): Promise<void> {
    await writer.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payload: entry.payload,
      },
    });
  }

  /**
   * Appends several entries in one statement.
   *
   * Exists for `reservation.confirmBulk`, which can create up to 31 reservations
   * and queue entries in a single transaction: one `INSERT` per row would be 31
   * round trips taken while that transaction is already holding uncommitted
   * unique keys other requests may be blocked on, and the length of that window
   * is the whole concurrency cost of bulk booking.
   *
   * Same shape, same table, same append-only trigger — the only difference from
   * {@link record} is the number of statements. An empty list writes nothing
   * rather than issuing a no-op `INSERT`.
   */
  async recordMany(
    entries: readonly AuditEntry[],
    writer: AuditLogWriter = this.prisma.client
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await writer.auditLog.createMany({
      data: entries.map((entry) => ({
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payload: entry.payload,
      })),
    });
  }
}
