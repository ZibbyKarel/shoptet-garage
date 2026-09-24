/**
 * Parking spots: one read for everybody, three mutations for admins.
 *
 * The rule that shapes this whole file is that **a spot is never deleted**.
 * `Reservation` and `WaitlistEntry` reference it with `ON DELETE RESTRICT`, and
 * `AuditLog` entries name it by id, so retiring one is `active: false`
 * (`doc/decision/0027-*`). Everything else follows from that: `spot.list`
 * filters on `active`, and `deactivate` has to refuse while the spot still holds
 * reservations — or queues — somebody is counting on.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  AdminListSpotsInput,
  CreateSpotInput,
  DeactivateSpotInput,
  ParkingSpot,
  UpdateSpotInput,
} from '@garage/contract';
import type { ParkingSpot as ParkingSpotRow, Prisma } from '@garage/database';
import { todayInPrague } from '@garage/shared-types';
import { AuditLogService } from '../audit/audit-log.service';
import { DomainError } from '../common/errors/domain-error';
import { toContractSpot, toDateColumn } from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';

/**
 * A stable order for every listing: group first (the `IT` block is a real,
 * physically separate part of the lot), then the painted label.
 *
 * Stable ordering is not cosmetic here — the day overview renders spots as a
 * grid, and a grid whose cells move between two reads of the same day is
 * unusable.
 */
const SPOT_ORDER: Prisma.ParkingSpotOrderByWithRelationInput[] = [
  { group: 'asc' },
  { label: 'asc' },
];

@Injectable()
export class SpotsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * Ids of every hidden spot, for the realtime gateway, which decides per
   * broadcast — synchronously, on the way out — whether a non-admin may hear
   * it (`doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`).
   *
   * ponytail: an in-process copy of `ParkingSpot.hidden`, loaded at boot and
   * kept current only by {@link update}. Correct for the single instance this
   * app targets; a second API instance must read the column per broadcast (or
   * share this set) instead.
   */
  private readonly hiddenSpotIds = new Set<string>();

  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.client.parkingSpot.findMany({
      where: { hidden: true },
      select: { id: true },
    });
    for (const row of rows) {
      this.hiddenSpotIds.add(row.id);
    }
  }

  /** Whether the spot is hidden. Unknown ids are not. */
  isHidden(spotId: string): boolean {
    return this.hiddenSpotIds.has(spotId);
  }

  /** Active spots, hidden ones included. What the day grid reads; it filters per viewer itself. */
  async listActive(): Promise<ParkingSpot[]> {
    const rows = await this.prisma.client.parkingSpot.findMany({
      where: { active: true },
      orderBy: SPOT_ORDER,
    });
    return rows.map(toContractSpot);
  }

  /**
   * Active spots nobody has hidden — `spot.list`, the preferred-spot picker.
   * Hidden spots are left out for admins too: bulk booking never assigns one,
   * so preferring it would be a promise nothing keeps.
   */
  async listVisible(): Promise<ParkingSpot[]> {
    const rows = await this.prisma.client.parkingSpot.findMany({
      where: { active: true, hidden: false },
      orderBy: SPOT_ORDER,
    });
    return rows.map(toContractSpot);
  }

  /** The admin table: optionally including retired spots, optionally one group. */
  async adminList(input: AdminListSpotsInput): Promise<ParkingSpot[]> {
    const rows = await this.prisma.client.parkingSpot.findMany({
      where: {
        ...(input.includeInactive ? {} : { active: true }),
        ...(input.group === undefined ? {} : { group: input.group }),
      },
      orderBy: SPOT_ORDER,
    });
    return rows.map(toContractSpot);
  }

  /**
   * Adds a spot.
   *
   * A duplicate `label` is left to the unique index rather than pre-checked: a
   * read-then-write would still lose a race against a concurrent create, and the
   * constraint is what actually decides. P2002 arrives at the client as
   * `CONFLICT` through `toOrpcError`.
   */
  async create(input: CreateSpotInput, actorUserId: string): Promise<ParkingSpot> {
    const row = await this.prisma.client.parkingSpot.create({
      data: { label: input.label, group: input.group },
    });

    // The `payload` shape is fixed per action by `../audit/audit-payloads.ts`.
    await this.audit.record({
      actorUserId,
      action: 'SPOT_UPDATED',
      entityType: 'ParkingSpot',
      entityId: row.id,
      payload: { change: 'created', label: row.label, group: row.group },
    });

    return toContractSpot(row);
  }

  /**
   * Changes a spot's label, group or activity.
   *
   * Deactivating through here is the same operation as {@link deactivate} and is
   * held to the same rule — otherwise `update({ active: false })` would be a way
   * around the check, which is how a spot ends up retired with people still
   * holding reservations for it. Hiding (`hidden`) is deliberately *not* held
   * to that rule: a hidden spot is still bookable by an admin and still shown
   * to whoever holds it. The EV charger flag is held to no rule at all: it is
   * information about the bay (`doc/decision/0317-*`).
   */
  async update(input: UpdateSpotInput, actorUserId: string): Promise<ParkingSpot> {
    const { id, ...changes } = input;
    const existing = await this.requireSpot(id);

    if (changes.active === false && existing.active) {
      await this.requireNoFutureCommitments(id);
    }

    // Spread the present fields only. `exactOptionalPropertyTypes` is on, so
    // `{ label: undefined }` is a different type from `{}` — and to Prisma it
    // would also be a different statement.
    const data: Prisma.ParkingSpotUpdateInput = {
      ...(changes.label === undefined ? {} : { label: changes.label }),
      ...(changes.group === undefined ? {} : { group: changes.group }),
      ...(changes.active === undefined ? {} : { active: changes.active }),
      ...(changes.hidden === undefined ? {} : { hidden: changes.hidden }),
      ...(changes.evCharger === undefined ? {} : { evCharger: changes.evCharger }),
    };
    const row = await this.prisma.client.parkingSpot.update({ where: { id }, data });

    if (row.hidden) {
      this.hiddenSpotIds.add(row.id);
    } else {
      this.hiddenSpotIds.delete(row.id);
    }

    await this.audit.record({
      actorUserId,
      action: 'SPOT_UPDATED',
      entityType: 'ParkingSpot',
      entityId: row.id,
      payload: {
        change: 'updated',
        before: {
          label: existing.label,
          group: existing.group,
          active: existing.active,
          hidden: existing.hidden,
          evCharger: existing.evCharger,
        },
        after: {
          label: row.label,
          group: row.group,
          active: row.active,
          hidden: row.hidden,
          evCharger: row.evCharger,
        },
      },
    });

    return toContractSpot(row);
  }

  /**
   * Retires a spot.
   *
   * Idempotent: a spot that is already inactive comes back unchanged and writes
   * no audit entry, because nothing happened. Auditing a no-op would put noise
   * into the one table that is supposed to answer "what actually changed".
   */
  async deactivate(input: DeactivateSpotInput, actorUserId: string): Promise<ParkingSpot> {
    const existing = await this.requireSpot(input.id);
    if (!existing.active) {
      return toContractSpot(existing);
    }

    await this.requireNoFutureCommitments(input.id);

    const row = await this.prisma.client.parkingSpot.update({
      where: { id: input.id },
      data: { active: false },
    });

    await this.audit.record({
      actorUserId,
      action: 'SPOT_UPDATED',
      entityType: 'ParkingSpot',
      entityId: row.id,
      payload: { change: 'deactivated', label: row.label },
    });

    return toContractSpot(row);
  }

  private async requireSpot(id: string): Promise<ParkingSpotRow> {
    const spot = await this.prisma.client.parkingSpot.findUnique({ where: { id } });
    if (spot === null) {
      throw new DomainError('NOT_FOUND', { message: 'No such parking spot.' });
    }
    return spot;
  }

  /**
   * Refuses while anybody is still counting on this spot for today or a later
   * day — whether they hold it or are queued for it.
   *
   * "Today" is a Europe/Prague calendar day, and the comparison is `>=` rather
   * than `>`: a reservation for *today* is one somebody has already parked on.
   * Silently retiring the spot under them would leave them believing they have a
   * place — which is why this is a `CONFLICT` the admin has to resolve first,
   * not a warning.
   *
   * **Waitlist entries count too**, and that is not symmetry for its own sake.
   * A queue can outlive the reservation it was waiting on: a cancellation whose
   * whole queue is ineligible promotes nobody
   * (`WaitlistPromotionService.promote` returns `null`), so the spot goes free
   * with its queue intact. Retiring it then would leave those entries pointing
   * at a spot `listActive` filters out — invisible on the day overview,
   * unreachable by the person who queued, and never promotable, because nothing
   * will ever free a spot nobody can reserve. `ON DELETE RESTRICT` explains why
   * the *row* survives a retirement; it says nothing about why the *queue*
   * should. See `doc/decision/0235-*`.
   *
   * **Guest half-hour blocks count too**, for the plainer reason: a guest is
   * booked to park there on a named day, and retiring the spot out from under
   * them is exactly the same mistake as retiring it out from under a full-day
   * holder. `doc/decision/0314-*`.
   */
  private async requireNoFutureCommitments(spotId: string): Promise<void> {
    const from = toDateColumn(todayInPrague());
    const where = { parkingSpotId: spotId, date: { gte: from } };
    // Three statements rather than one destructured array literal: the counts
    // run one after the other, and the array shape read like `Promise.all`
    // without being it. They are deliberately not parallelised — that would
    // change how many pool connections a deactivation holds, for no gain at
    // this size.
    const reservations = await this.prisma.client.reservation.count({ where });
    const waitlistEntries = await this.prisma.client.waitlistEntry.count({ where });
    const timedReservations = await this.prisma.client.timedReservation.count({ where });

    if (reservations + waitlistEntries + timedReservations > 0) {
      throw new DomainError('CONFLICT', {
        message:
          'The spot still has reservations, guest blocks or waitlist entries from today onwards.',
        details: { reservations, waitlistEntries, timedReservations },
      });
    }
  }
}
