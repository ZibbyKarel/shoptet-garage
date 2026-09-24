/**
 * Bulk booking: `reservation.previewBulk` and `reservation.confirmBulk`.
 *
 * One allocator (`bulk-allocator.ts`, pure), two callers. The preview runs it
 * against a snapshot and returns the plan; the confirmation runs it inside one
 * interactive transaction and then writes what it can. Nothing about *which*
 * spot a day should get lives in this file — that is the whole point of the
 * split, because a preview that predicted a different spot from the one the
 * confirmation takes would be worse than no preview at all.
 *
 * ## `previewBulk` writes nothing
 *
 * No transaction, no lock, no row. It is a read of the same four things the
 * confirmation reads, handed to the same function. `bulk-reservation.db.spec.ts`
 * asserts that by counting `Reservation`, `WaitlistEntry` and `AuditLog` rows
 * either side of a preview and requiring all three to be unchanged — a claim a
 * return-value assertion could never make.
 *
 * It still refuses a locked month and a past day, because a plan the caller can
 * never confirm is not a useful answer, and because the contract declares those
 * errors on both procedures for exactly that reason.
 *
 * ## `confirmBulk` never lets a statement fail
 *
 * The rule is: **one day colliding must not discard the batch**. Task 13
 * established why that is hard — a failed statement aborts a PostgreSQL
 * transaction, and Prisma exposes no savepoints, which is why
 * `ReservationsService.cancel` retries the whole transaction rather than
 * catching a `P2002` inside it.
 *
 * So this transaction never raises one. Both write phases go through
 * `createManyAndReturn({ skipDuplicates: true })` — `INSERT … ON CONFLICT DO
 * NOTHING RETURNING …` — so a cell somebody took between the preview and the
 * confirmation comes back as a **missing row**, not as an error. The transaction
 * stays alive, that day falls to the waitlist, and the result says so. No
 * statement in this transaction may raise, and the retry loop below is not a
 * licence for one to start: it catches deadlocks the server itself raises
 * (see below), never a `P2002` this file could have avoided.
 *
 * ## Deadlock: the ascending-date order is the lock ordering
 *
 * A bulk confirmation touches up to 31 `(spot, date)` cells, which is up to 31
 * uncommitted unique keys held at once — Task 13's deadlock risk, multiplied.
 * What removes the cycle is that **every** confirmation acquires those keys in
 * ascending date order, and that each date takes at most **one** reservation
 * key: a transaction waiting at date *d* holds no key at date *d*, so two of
 * them cannot each hold what the other wants. Two users submitting the same days
 * in opposite request order therefore serialise instead of deadlocking.
 *
 * That order has exactly **one** authority: `allocateBulk`'s
 * `[...request.dates].sort(compareDateOnly)`, whose output order *is* the row
 * order of the `INSERT` (`createReservations` maps straight off `plans`). The
 * service does not sort for it: `assertRequestable` sorts only locally, to name
 * the earliest offending day in a rejection, and does not reorder the list the
 * allocator sees — that stays `input.dates`, in request order. There was once a
 * second sort there whose returned list fed the allocator, which meant *either*
 * sort could be deleted with every test still green — measured, not assumed. See
 * `doc/decision/0092-*` §"One authority".
 *
 * The remaining sort is pinned directly by `bulk-allocator.spec.ts` ("comes back
 * in ascending date order, whatever order it was asked in"). It *used* to be
 * pinned end to end as well, by `bulk-concurrency.db.spec.ts` › "a forced
 * interleaving inside one multi-row INSERT", which breaks a multi-row `INSERT`
 * between its rows with a test-only `BEFORE INSERT` trigger and deadlocked the
 * moment the sort went. That pin is now weakened, not removed: `committedConfirm`
 * retries a `40P01`, and the retry cannot tell a cell-ordering cycle from the
 * monthly cap's, so a missing sort surfaces only if the retries lose too — which
 * has not been re-measured. Treat `bulk-allocator.spec.ts` as the sort's only
 * reliable guard and see `doc/decision/0307-*` §"What is not tested".
 *
 * This path takes no `FOR UPDATE` of its own, but that no longer keeps it out of
 * the cancel/promote wait graph in `doc/decision/0065-*`, and the claim that it
 * did is retracted. Since the monthly cap, `confirmOnce` takes a month-scoped
 * `pg_advisory_xact_lock` on `(userId, month)` and then, in `releaseOwnQueues`,
 * `DELETE`s that user's `WaitlistEntry` rows — which can block on a queue row a
 * concurrent `cancel` + `promote` is holding `FOR UPDATE` while *that*
 * transaction blocks on our advisory lock. A real cycle, rare but not
 * impossible, and month scope is exactly what defeats the date-confinement
 * argument the deadlock table in `doc/bulk-reservation.md` used to rest on.
 *
 * The resolution is a retry, not an ordering: `committedConfirm` re-runs the
 * whole transaction on any {@link isWriteConflict}, and reports `CONFLICT` when
 * the attempts run out. See `doc/decision/0307-*` and the deadlock table in
 * `doc/bulk-reservation.md`.
 *
 * ## The one race this deliberately does not close
 *
 * `waitlist.join` takes `SELECT … FOR SHARE` on the reservation of the cell it
 * is queueing for, so a caller cannot be queued for a spot a concurrent
 * cancellation is in the middle of freeing. Bulk booking does **not**: locking
 * one reservation row per selected day would add up to 31 more locks to a
 * transaction whose lock footprint is the whole reason this file is careful, and
 * would put it back into the cancel path's wait graph.
 *
 * The consequence is bounded and self-correcting. A day the allocator decided to
 * queue can, in the window between the read and the insert, have its spot freed
 * — leaving the caller queued for a spot that is free. They are not stuck: the
 * spot is visible on the day screen and they can simply reserve it, and if
 * somebody else takes it first the queue entry becomes meaningful again. Days
 * that queue because they *lost* a race are not affected at all: they queue for
 * the spot whose insert was refused, which is occupied by definition. Same
 * shape of documented, benign gap as `WaitlistService.join`'s
 * `RESERVATION_LIMIT_REACHED` pre-check — see `doc/bulk-reservation.md`.
 *
 * ## Nothing that can block on the network happens inside the transaction
 *
 * Same seam as Task 13: the callback returns its events, and they are published
 * after `await` has resolved. See `reservation-events.ts`.
 */

import { Injectable } from '@nestjs/common';
import type {
  BulkBookingInput,
  BulkBookingSummary,
  BulkDayPlan,
  BulkDayResult,
  ConfirmBulkOutput,
  PreviewBulkOutput,
  ReservationWindowSettings,
} from '@garage/contract';
import type { CellRef } from '@garage/contract/realtime';
import type { Prisma } from '@garage/database';
import { Prisma as PrismaNamespace } from '@garage/database';
import type { DateOnly } from '@garage/shared-types';
import { compareDateOnly, todayInPrague, toYearMonth } from '@garage/shared-types';
import type { AuditEntry } from '../audit/audit-log.service';
import { AuditLogService } from '../audit/audit-log.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import { isTimedReservationConflict, isWriteConflict } from '../common/errors/prisma-error-mapping';
import { toDateColumn, toDateOnly, toPublicReservation } from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { assertActiveUser } from './active-user';
import type { AllocatableSpot, DayState } from './bulk-allocator';
import { allocateBulk } from './bulk-allocator';
import {
  assertWithinMonthlyReservationCap,
  readMonthlyReservationCap,
} from './monthly-reservation-cap';
import type { DomainEvent } from './reservation-events';
import { DomainEventPublisher } from './reservation-events';
import { ReservationPolicy } from './reservation-policy';
import { MAX_CANCEL_ATTEMPTS } from './reservations.service';
import { RESERVATION_TRANSACTION_OPTIONS } from './transaction-options';
import { WAITLIST_ORDER } from './waitlist-order';

/**
 * The reservation fields a created row has to give back.
 *
 * `userId`, `guestName` and `licensePlate` mirror the nullable columns
 * (`doc/decision/0303-*`) even though bulk booking only ever creates a
 * user-held row today — the request field a guest reservation needs does not
 * exist until Task 5.
 */
interface CreatedReservation {
  id: string;
  parkingSpotId: string;
  userId: string | null;
  guestName: string | null;
  licensePlate: string | null;
  date: Date;
  createdAt: Date;
}

/** One queue entry, as the insert and the position read-back both return it. */
interface QueueRow {
  id: string;
  parkingSpotId: string;
  userId: string;
  date: Date;
}

/** The spot one day will queue for: an id and the label the result carries. */
interface QueueTarget {
  id: string;
  label: string;
}

/** {@link DayState}, while it is still being assembled. */
interface MutableDayState {
  reservedSpotIds: Set<string>;
  userHasReservation: boolean;
  queuedUserIdsBySpotId: Map<string, string[]>;
  blockedSpotIds: Set<string>;
}

/** Everything both procedures read before they can decide anything. */
interface World {
  spots: AllocatableSpot[];
  preferredParkingSpotId: string | null;
  holder: { id: string; name: string; licensePlate: string | null };
  stateByDate: ReadonlyMap<DateOnly, DayState>;
}

/** What one confirmation produced, before anything is broadcast. */
interface ConfirmOutcome {
  result: ConfirmBulkOutput;
  events: DomainEvent[];
}

/**
 * A `(spot, date)` cell, as a map key.
 *
 * Takes the contract's own {@link CellRef} rather than two positional strings,
 * for the reason `LockService.cellKey` does: `DateOnly` and a spot id are both
 * bare `string` (`doc/decision/0014-*`, `doc/decision/0016-*`), so a
 * transposition at a call site would type-check and produce a key that simply
 * never matches. Named fields make that mistake unrepresentable.
 *
 * `|` is safe as a separator because both halves are closed shapes the contract
 * validated before they reached here — `YYYY-MM-DD` and a UUID — so neither can
 * contain one and no two distinct cells can collide on a key.
 */
function cellKey(cell: CellRef): string {
  return `${cell.date}|${cell.parkingSpotId}`;
}

@Injectable()
export class BulkReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly window: ReservationWindowService,
    private readonly policy: ReservationPolicy,
    private readonly audit: AuditLogService,
    private readonly publisher: DomainEventPublisher
  ) {}

  /**
   * The user this batch is for, and the authorization check that allows it.
   *
   * Mirrors `WaitlistService.join`'s `targetUserId` resolution exactly — bulk
   * booking's queue days land on `WaitlistEntry`, the same table, under the
   * same non-nullable-`userId` constraint, so there is no guest branch here
   * either. An omitted `holderId` is always the caller.
   */
  private async resolveHolder(
    holderId: string | undefined,
    actor: AuthenticatedUser
  ): Promise<string> {
    this.policy.assertMayNameWaitlistTarget(holderId, actor);
    const targetUserId = holderId ?? actor.id;
    if (targetUserId !== actor.id) {
      // See `active-user.ts` for why this is a real check and runs outside
      // any transaction.
      await assertActiveUser(this.prisma.client, targetUserId);
    }
    return targetUserId;
  }

  /** The read-only proposal. Writes nothing — see the class comment. */
  async preview(
    input: BulkBookingInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<PreviewBulkOutput> {
    const holderId = await this.resolveHolder(input.holderId, actor);
    const settings = await this.window.getSettings();
    this.assertRequestable(input.dates, actor, settings, today);
    const month = this.monthOf(input.dates);

    const world = await this.readWorld(this.prisma.client, input.dates, holderId);
    const days = this.inRequestOrder(input.dates, this.allocate(input.dates, world, holderId));

    return {
      month,
      preferredParkingSpotId: world.preferredParkingSpotId,
      days,
      summary: this.summarise(days),
    };
  }

  /** The real booking. One transaction; broadcasts strictly after it commits. */
  async confirm(
    input: BulkBookingInput,
    actor: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<ConfirmBulkOutput> {
    const holderId = await this.resolveHolder(input.holderId, actor);
    const settings = await this.window.getSettings();
    this.assertRequestable(input.dates, actor, settings, today);
    const month = this.monthOf(input.dates);

    const outcome = await this.committedConfirm(input.dates, month, actor, holderId);

    // Past `await`, so past `COMMIT` — and deliberately outside the retry loop.
    // Nothing above this line may talk to Slack or Socket.io. There are no
    // promotion notices: bulk booking never promotes anybody, it only queues
    // them.
    this.publisher.publish(outcome.events);
    return outcome.result;
  }

  /**
   * {@link confirm}'s transaction, retried. Returns only once something committed.
   *
   * The retry exists for exactly one condition: the deadlock the monthly cap's
   * `(userId, month)` advisory lock introduced between this path and
   * `cancel` + `promote` (`doc/decision/0307-*`). Everything else this
   * transaction can hit is still handled the way the class comment describes —
   * `ON CONFLICT DO NOTHING` turns a lost cell into a missing row rather than an
   * error — so the test is {@link isWriteConflict} and nothing wider. In
   * particular a `P2002` is *not* retried here: a statement that raises one is a
   * defect in this file, and retrying a defect only makes it slower.
   *
   * `isWriteConflict` rather than `code === 'P2034'` because the same `40P01`
   * arrives spelled two ways depending on which statement the server picks as
   * the victim — Prisma's own SQL reports `P2034`, a `$queryRaw` reports `P2010`
   * wrapping `40P01`. `doc/decision/0240-*`.
   *
   * It is also retried on {@link isTimedReservationConflict}: a guest half-hour
   * block committed on the preferred spot between this transaction's
   * `readWorld` and its reservation insert surfaces as a `P2002` on the trigger
   * that enforces spot/day exclusivity, not as a deadlock — the read simply
   * missed a block that exists now. The retry re-reads the world, which sees
   * the block and routes the allocator around it. `doc/decision/0314-*`.
   *
   * **Why it terminates.** Not for the reason `ReservationsService.cancel`'s
   * loop does: that one eliminates a candidate per attempt, and a re-run of
   * `allocateBulk` makes no such monotone progress — it can reach for the same
   * cells again. What is true is that the transaction it deadlocked with has
   * committed or rolled back by the time the retry starts, so the retry does not
   * replay the identical interleaving, and any cell the competitor won comes
   * back as a missing row rather than an error, leaving the retry a strictly
   * smaller set of days to assign. {@link MAX_CANCEL_ATTEMPTS} bounds it
   * regardless, because a bound that rests on an argument about somebody else's
   * code is not a bound.
   *
   * That constant is imported rather than duplicated with a bulk-flavoured name:
   * both loops bound the same `40P01` retry against the same wait graph, and two
   * numbers that must agree but are written down twice eventually disagree.
   */
  private async committedConfirm(
    dates: readonly DateOnly[],
    month: string,
    actor: AuthenticatedUser,
    holderId: string
  ): Promise<ConfirmOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(
          (tx) => this.confirmOnce(tx, dates, month, actor, holderId),
          RESERVATION_TRANSACTION_OPTIONS
        );
      } catch (error) {
        if (
          !(error instanceof PrismaNamespace.PrismaClientKnownRequestError) ||
          !(isWriteConflict(error) || isTimedReservationConflict(error))
        ) {
          throw error;
        }
        if (attempt >= MAX_CANCEL_ATTEMPTS) {
          // `CONFLICT`, not the underlying deadlock: the caller has no
          // reservation problem of their own — they lost a race with somebody
          // they have never heard of. It is declared on `confirmBulk`, is a 409,
          // and its copy ("někdo jiný mezitím provedl stejnou změnu") is exactly
          // the situation. The batch is all-or-nothing, so nothing was written.
          throw new DomainError('CONFLICT', {
            message: 'The batch could not be booked; another request kept winning the race.',
            details: { attempts: MAX_CANCEL_ATTEMPTS },
          });
        }
      }
    }
  }

  /**
   * The whole confirmation, inside `tx`.
   *
   * Read, allocate, insert the reservations, insert the queue entries for what
   * is left, read the positions back, audit — in that order, and the order is
   * load-bearing: the queue target for a day that *lost* its spot can only be
   * chosen once the reservation phase has said which days lost.
   */
  private async confirmOnce(
    tx: Prisma.TransactionClient,
    dates: readonly DateOnly[],
    month: string,
    actor: AuthenticatedUser,
    holderId: string
  ): Promise<ConfirmOutcome> {
    const world = await this.readWorld(tx, dates, holderId);
    const plans = this.allocate(dates, world, holderId);

    const assignedCount = plans.filter((plan) => plan.outcome === 'SPOT_ASSIGNED').length;
    if (assignedCount > 0) {
      const [firstDate] = dates;
      if (firstDate === undefined) {
        throw new DomainError('VALIDATION_FAILED', {
          message: 'A bulk booking must name at least one day.',
        });
      }
      const cap = await readMonthlyReservationCap(tx);
      await assertWithinMonthlyReservationCap(tx, holderId, firstDate, assignedCount, cap);
    }

    const created = await this.createReservations(tx, plans, holderId);
    const createdByDate = new Map(created.map((row) => [toDateOnly(row.date), row]));

    // A day the caller was already queued on and has now been given a spot.
    //
    // `WaitlistService.join` refuses that state at the door and `promote` clears
    // it on the other side; this was the one writer that could create it. The
    // entry would not corrupt anything — `eligibleInOrder` skips somebody who
    // already holds the day — but the person's day screen would show them queued
    // for a spot they can never be promoted into while they hold their own. See
    // `doc/decision/0236-*`.
    const releasedCells = await this.releaseOwnQueues(tx, [...createdByDate.keys()], holderId);

    // Every day that could still end up on a queue, re-read before it does.
    //
    // Two sources, and they need the same second read for the same reason: a day
    // the allocator wanted to **assign** and could not (either somebody took the
    // cell, or the caller acquired a reservation elsewhere — indistinguishable at
    // an `ON CONFLICT DO NOTHING` insert), and a day it planned to **queue**, on
    // which the caller can equally have acquired a reservation between
    // `readWorld` and here. Queueing either of them would write an entry for a
    // user who already holds that day — one that can never be promoted, and one
    // `WaitlistService.join` refuses at the door.
    const lost = plans.flatMap((plan) =>
      plan.outcome === 'SPOT_ASSIGNED' && !createdByDate.has(plan.date) ? [plan.date] : []
    );
    const planned = plans.flatMap((plan) => (plan.outcome === 'QUEUED' ? [plan.date] : []));
    const busyElsewhere = await this.datesAlreadyReserved(tx, [...lost, ...planned], holderId);

    const targets = this.queueTargets(plans, createdByDate, busyElsewhere);
    const queued = await this.createWaitlistEntries(tx, targets, holderId);
    const queues = await this.readQueues(tx, targets);

    // Naming somebody other than the actor as holder is a different action
    // than the actor acting for themselves — the trail has to say who acted
    // and on whose behalf, mirroring `ReservationsService.create`'s
    // `bookedForSomebodyElse` and `WaitlistService.join`'s
    // `queuedForSomebodyElse`. One flag for the whole batch: a bulk request
    // names exactly one holder, never a mix.
    const bookedForSomebodyElse = holderId !== actor.id;
    await this.audit.recordMany(
      [
        ...this.reservationAudit(created, actor.id, holderId, bookedForSomebodyElse),
        ...this.queueAudit(queued, actor.id, holderId, bookedForSomebodyElse),
      ],
      tx
    );

    const days = this.inRequestOrder(
      dates,
      plans.map((plan) =>
        this.resolve(plan, createdByDate, busyElsewhere, targets, queues, holderId)
      )
    );

    return {
      result: {
        month,
        preferredParkingSpotId: world.preferredParkingSpotId,
        days,
        summary: this.summarise(days),
      },
      events: [
        ...created.map(
          (row): DomainEvent => ({
            name: 'reservation:created',
            payload: {
              date: toDateOnly(row.date),
              parkingSpotId: row.parkingSpotId,
              reservation: toPublicReservation(row, world.holder),
            },
          })
        ),
        // The cells the caller's own pre-existing entries were removed from.
        // Same reasoning as an insert: the queue got shorter, and everyone
        // behind them moved up.
        ...releasedCells,
        // Only the cells an entry was actually inserted into: a queue whose
        // length did not change is not news, and `skipDuplicates` means a
        // planned entry that was already there changed nothing.
        ...queued.map((row): DomainEvent => {
          const date = toDateOnly(row.date);
          return {
            name: 'waitlist:updated',
            payload: {
              date,
              parkingSpotId: row.parkingSpotId,
              waitlistCount: (queues.get(cellKey({ date, parkingSpotId: row.parkingSpotId })) ?? [])
                .length,
            },
          };
        }),
      ],
    };
  }

  // --- reads -----------------------------------------------------------------

  /**
   * The four reads the allocator needs, as one snapshot.
   *
   * Takes the client rather than reaching for `this.prisma.client`, because the
   * confirmation has to read **inside its own transaction** — a snapshot taken
   * on another connection would be a different world from the one it writes to.
   * That is also why `SpotsService.listActive` is not reused here: it is bound
   * to the request-scoped client and cannot be handed a transaction.
   */
  private async readWorld(
    client: Prisma.TransactionClient,
    dates: readonly DateOnly[],
    holderId: string
  ): Promise<World> {
    const dateColumns = dates.map(toDateColumn);

    const [spots, holder, reservations, waitlist, timedReservations] = await Promise.all([
      client.parkingSpot.findMany({
        where: { active: true },
        select: { id: true, label: true, group: true },
      }),
      // `preferredParkingSpotId` and the plate are row facts, not token claims —
      // `AuthenticatedUser` carries neither, exactly as `reservation.create`
      // found when it needed the plate for its broadcast.
      client.user.findUniqueOrThrow({
        where: { id: holderId },
        select: { id: true, name: true, licensePlate: true, preferredParkingSpotId: true },
      }),
      client.reservation.findMany({
        where: { date: { in: dateColumns } },
        select: { parkingSpotId: true, userId: true, date: true },
      }),
      client.waitlistEntry.findMany({
        where: { date: { in: dateColumns } },
        // `WAITLIST_ORDER` (`waitlist-order.ts`) — the same order the queue is
        // promoted in and the day overview shows. The position the preview
        // reports is therefore the position that would be promoted.
        orderBy: WAITLIST_ORDER,
        select: { parkingSpotId: true, userId: true, date: true },
      }),
      // Guest half-hour blocks. A blocked spot has no full-day holder, so it is
      // neither assignable nor queueable that day — see `bulk-allocator.ts`'s
      // `blockedSpotIds`.
      client.timedReservation.findMany({
        where: { date: { in: dateColumns } },
        select: { parkingSpotId: true, date: true },
      }),
    ]);

    const stateByDate = new Map<DateOnly, MutableDayState>();
    const dayFor = (date: DateOnly): MutableDayState => {
      const existing = stateByDate.get(date);
      if (existing !== undefined) {
        return existing;
      }
      const fresh: MutableDayState = {
        reservedSpotIds: new Set(),
        userHasReservation: false,
        queuedUserIdsBySpotId: new Map(),
        blockedSpotIds: new Set(),
      };
      stateByDate.set(date, fresh);
      return fresh;
    };

    for (const date of dates) {
      dayFor(date);
    }
    for (const row of reservations) {
      const day = dayFor(toDateOnly(row.date));
      day.reservedSpotIds.add(row.parkingSpotId);
      if (row.userId === holderId) {
        day.userHasReservation = true;
      }
    }
    for (const row of waitlist) {
      const day = dayFor(toDateOnly(row.date));
      const queue = day.queuedUserIdsBySpotId.get(row.parkingSpotId) ?? [];
      queue.push(row.userId);
      day.queuedUserIdsBySpotId.set(row.parkingSpotId, queue);
    }
    for (const row of timedReservations) {
      dayFor(toDateOnly(row.date)).blockedSpotIds.add(row.parkingSpotId);
    }

    return {
      spots,
      holder,
      preferredParkingSpotId: holder.preferredParkingSpotId,
      stateByDate,
    };
  }

  /** Which of `dates` the caller already holds a reservation on. */
  private async datesAlreadyReserved(
    tx: Prisma.TransactionClient,
    dates: readonly DateOnly[],
    holderId: string
  ): Promise<Set<DateOnly>> {
    if (dates.length === 0) {
      return new Set();
    }
    const rows = await tx.reservation.findMany({
      where: { userId: holderId, date: { in: dates.map(toDateColumn) } },
      select: { date: true },
    });
    return new Set(rows.map((row) => toDateOnly(row.date)));
  }

  /** Every queue the result has to report a position out of, in promotion order. */
  private async readQueues(
    tx: Prisma.TransactionClient,
    targets: ReadonlyMap<DateOnly, QueueTarget>
  ): Promise<Map<string, QueueRow[]>> {
    const queues = new Map<string, QueueRow[]>();
    if (targets.size === 0) {
      return queues;
    }

    const rows = await tx.waitlistEntry.findMany({
      where: {
        date: { in: [...targets.keys()].map(toDateColumn) },
        parkingSpotId: { in: [...new Set([...targets.values()].map((spot) => spot.id))] },
      },
      orderBy: WAITLIST_ORDER,
      select: { id: true, parkingSpotId: true, userId: true, date: true },
    });

    for (const row of rows) {
      const key = cellKey({ date: toDateOnly(row.date), parkingSpotId: row.parkingSpotId });
      const queue = queues.get(key) ?? [];
      queue.push(row);
      queues.set(key, queue);
    }
    return queues;
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Inserts the planned reservations, skipping the cells somebody else has
   * taken, and returns only the rows that were actually written.
   *
   * `skipDuplicates` is what keeps one collision from discarding the batch, and
   * the ascending date order of `plans` is what keeps two of these from
   * deadlocking — see the class comment.
   */
  private async createReservations(
    tx: Prisma.TransactionClient,
    plans: readonly BulkDayPlan[],
    holderId: string
  ): Promise<CreatedReservation[]> {
    const data = plans.flatMap((plan) =>
      plan.outcome === 'SPOT_ASSIGNED'
        ? [{ parkingSpotId: plan.parkingSpotId, userId: holderId, date: toDateColumn(plan.date) }]
        : []
    );
    if (data.length === 0) {
      return [];
    }

    return tx.reservation.createManyAndReturn({
      data,
      skipDuplicates: true,
      select: {
        id: true,
        parkingSpotId: true,
        userId: true,
        guestName: true,
        licensePlate: true,
        date: true,
        createdAt: true,
      },
    });
  }

  /** Inserts the queue entries, skipping queues the caller is already in. */
  private async createWaitlistEntries(
    tx: Prisma.TransactionClient,
    targets: ReadonlyMap<DateOnly, QueueTarget>,
    holderId: string
  ): Promise<QueueRow[]> {
    if (targets.size === 0) {
      return [];
    }

    const data = [...targets.entries()]
      .sort(([left], [right]) => compareDateOnly(left, right))
      .map(([date, spot]) => ({
        parkingSpotId: spot.id,
        userId: holderId,
        date: toDateColumn(date),
      }));

    return tx.waitlistEntry.createManyAndReturn({
      data,
      skipDuplicates: true,
      select: { id: true, parkingSpotId: true, userId: true, date: true },
    });
  }

  /**
   * Drops the caller's own queue entries on days this batch just reserved for
   * them, and reports the cells that got shorter.
   *
   * `DELETE … RETURNING` rather than `deleteMany`, which reports only a count:
   * the cells have to be named in the broadcast, and only the delete itself
   * knows which they were. Ordered by `(date, parkingSpotId)` so two
   * confirmations that reach into the same rows take them in the same order —
   * the same reason `createReservations` inserts in ascending date order.
   *
   * The recount afterwards is a second round trip per cell, sequentially: these
   * run inside a transaction that is holding row locks, which is not a place to
   * fan out. Cells are few — at most one per day in the batch.
   */
  private async releaseOwnQueues(
    tx: Prisma.TransactionClient,
    dates: readonly DateOnly[],
    holderId: string
  ): Promise<DomainEvent[]> {
    if (dates.length === 0) {
      return [];
    }

    const days = PrismaNamespace.join(
      [...dates].sort(compareDateOnly).map((date) => PrismaNamespace.sql`${date}::date`)
    );
    const cleared = await tx.$queryRaw<{ parkingSpotId: string; date: Date }[]>`
      DELETE FROM "WaitlistEntry"
      WHERE "userId" = ${holderId}::uuid
        AND "date" IN (${days})
      RETURNING "parkingSpotId", "date"
    `;

    const events: DomainEvent[] = [];
    for (const row of [...cleared].sort(
      (left, right) =>
        left.date.getTime() - right.date.getTime() ||
        left.parkingSpotId.localeCompare(right.parkingSpotId)
    )) {
      const date = toDateOnly(row.date);
      const waitlistCount = await tx.waitlistEntry.count({
        where: { parkingSpotId: row.parkingSpotId, date: row.date },
      });
      events.push({
        name: 'waitlist:updated',
        payload: { date, parkingSpotId: row.parkingSpotId, waitlistCount },
      });
    }
    return events;
  }

  // --- assembling the answer -------------------------------------------------

  private allocate(dates: readonly DateOnly[], world: World, holderId: string): BulkDayPlan[] {
    return allocateBulk({
      dates,
      spots: world.spots,
      userId: holderId,
      preferredParkingSpotId: world.preferredParkingSpotId,
      stateByDate: world.stateByDate,
    });
  }

  /**
   * Which spot each still-unsatisfied day should queue for.
   *
   * Two sources, and the second one is the interesting half:
   *
   * - a day the allocator already decided to queue keeps the spot it chose (the
   *   shortest queue, tiebroken by label);
   * - a day it wanted to **assign** and lost queues for *that same spot* — the
   *   brief's rule, "a collision does not fail the batch, that day falls onto
   *   the waitlist". The spot it lost is the one spot on that day this
   *   transaction knows for certain is occupied: the insert was skipped, which
   *   only happens when a row is already there. Re-running the shortest-queue
   *   rule over the stale snapshot would instead have queued the caller behind
   *   a spot that looked free a moment ago and may still be.
   *
   * A day the caller turns out to already hold a reservation on is deliberately
   * absent: they could never be promoted out of that queue.
   */
  private queueTargets(
    plans: readonly BulkDayPlan[],
    createdByDate: ReadonlyMap<DateOnly, CreatedReservation>,
    busyElsewhere: ReadonlySet<DateOnly>
  ): Map<DateOnly, QueueTarget> {
    const targets = new Map<DateOnly, QueueTarget>();

    for (const plan of plans) {
      if (plan.outcome === 'UNAVAILABLE') {
        continue;
      }
      // Whatever the allocator wanted, a day the caller turns out to already hold
      // a reservation on is never queued — planned `QUEUED` days included.
      if (busyElsewhere.has(plan.date)) {
        continue;
      }
      if (plan.outcome === 'SPOT_ASSIGNED' && createdByDate.has(plan.date)) {
        continue;
      }
      targets.set(plan.date, { id: plan.parkingSpotId, label: plan.parkingSpotLabel });
    }

    return targets;
  }

  /** One planned day, as it actually turned out. */
  private resolve(
    plan: BulkDayPlan,
    createdByDate: ReadonlyMap<DateOnly, CreatedReservation>,
    busyElsewhere: ReadonlySet<DateOnly>,
    targets: ReadonlyMap<DateOnly, QueueTarget>,
    queues: ReadonlyMap<string, readonly QueueRow[]>,
    holderId: string
  ): BulkDayResult {
    if (plan.outcome === 'UNAVAILABLE') {
      return plan;
    }

    if (plan.outcome === 'SPOT_ASSIGNED') {
      const created = createdByDate.get(plan.date);
      if (created !== undefined) {
        return { ...plan, reservationId: created.id };
      }
    }

    if (busyElsewhere.has(plan.date)) {
      // Somebody — another request of theirs, or a promotion — gave the caller a
      // reservation that day while this transaction was running. That is the
      // one-per-day rule, reported with the reason that names it, and it applies
      // to a day the allocator planned to queue exactly as it does to one it
      // planned to assign.
      return { outcome: 'UNAVAILABLE', date: plan.date, reason: 'ALREADY_HAS_RESERVATION' };
    }

    const target = targets.get(plan.date);
    if (target === undefined) {
      // Only reachable for a day with no spot to queue for at all, which the
      // allocator would already have reported as `NO_SPOTS_AVAILABLE`.
      return { outcome: 'UNAVAILABLE', date: plan.date, reason: 'NO_SPOTS_AVAILABLE' };
    }

    const queue = queues.get(cellKey({ date: plan.date, parkingSpotId: target.id })) ?? [];
    const index = queue.findIndex((row) => row.userId === holderId);
    const entry = queue[index];
    if (entry === undefined) {
      // The entry was either inserted by this transaction or was already there,
      // and both are visible to this read. Absent means a defect, and a defect
      // is better as a 500 than as a fabricated queue position.
      throw new Error(`No queue entry for ${holderId} on ${plan.date} after inserting one.`);
    }

    return {
      outcome: 'QUEUED',
      date: plan.date,
      parkingSpotId: target.id,
      parkingSpotLabel: target.label,
      waitlistPosition: index + 1,
      waitlistEntryId: entry.id,
    };
  }

  private reservationAudit(
    created: readonly CreatedReservation[],
    actorUserId: string,
    holderUserId: string,
    bookedForSomebodyElse: boolean
  ): AuditEntry[] {
    return created.map((row) =>
      bookedForSomebodyElse
        ? {
            actorUserId,
            action: 'RESERVATION_CREATED_BY_ADMIN',
            entityType: 'Reservation',
            entityId: row.id,
            payload: {
              parkingSpotId: row.parkingSpotId,
              date: toDateOnly(row.date),
              holderUserId,
              guestName: null,
            },
          }
        : {
            actorUserId,
            action: 'RESERVATION_CREATED',
            entityType: 'Reservation',
            entityId: row.id,
            payload: { parkingSpotId: row.parkingSpotId, date: toDateOnly(row.date) },
          }
    );
  }

  private queueAudit(
    queued: readonly QueueRow[],
    actorUserId: string,
    targetUserId: string,
    queuedForSomebodyElse: boolean
  ): AuditEntry[] {
    return queued.map((row) =>
      queuedForSomebodyElse
        ? {
            actorUserId,
            action: 'WAITLIST_JOINED_BY_ADMIN',
            entityType: 'WaitlistEntry',
            entityId: row.id,
            payload: { parkingSpotId: row.parkingSpotId, date: toDateOnly(row.date), targetUserId },
          }
        : {
            actorUserId,
            action: 'WAITLIST_JOINED',
            entityType: 'WaitlistEntry',
            entityId: row.id,
            payload: { parkingSpotId: row.parkingSpotId, date: toDateOnly(row.date) },
          }
    );
  }

  /**
   * The plans, back in the order the client listed the days.
   *
   * The allocator works in ascending date order because that is the lock
   * ordering; the contract promises the response "in the order the days were
   * requested". Both are true, and this is the one line where they meet.
   */
  private inRequestOrder<T extends { date: DateOnly }>(
    requested: readonly DateOnly[],
    entries: readonly T[]
  ): T[] {
    const byDate = new Map(entries.map((entry) => [entry.date, entry]));
    return requested.flatMap((date) => {
      const entry = byDate.get(date);
      return entry === undefined ? [] : [entry];
    });
  }

  /**
   * The counts, off whichever of the two day shapes the caller has.
   *
   * `BulkDayPlan` rather than a union of both: every member of `BulkDayResult`
   * is a superset of the matching plan member — which is the property the
   * contract's comment says makes the two zip by `date` — so one function
   * summarises a proposal and a result alike, and the two can never disagree
   * about how a summary is counted.
   */
  private summarise(days: readonly BulkDayPlan[]): BulkBookingSummary {
    return {
      assigned: days.filter((day) => day.outcome === 'SPOT_ASSIGNED').length,
      queued: days.filter((day) => day.outcome === 'QUEUED').length,
      unavailable: days.filter((day) => day.outcome === 'UNAVAILABLE').length,
      preferredSpotHits: days.filter(
        (day) => day.outcome === 'SPOT_ASSIGNED' && day.isPreferredSpot
      ).length,
    };
  }

  // --- request-level rules ---------------------------------------------------

  /**
   * The two conditions that invalidate the **whole** request.
   *
   * An assertion, and nothing else: it hands nothing back, so there is exactly
   * one list of days in this file — the caller's own `input.dates` — and no
   * reader has to prove to themselves that a returned copy still matches it.
   *
   * A day in the past and a closed window are contract errors on the procedure;
   * a weekend, a holiday, a full day and a day the caller is already booked on
   * are per-day facts reported inside a successful response
   * (`doc/decision/0090-*`).
   *
   * The scan runs in ascending order so the error names the **earliest**
   * offending day rather than whichever one the client happened to list first —
   * pinned by `bulk-reservation.db.spec.ts`, "names the earliest offending day,
   * not the first one listed". That sort is deliberately **local to the scan**:
   * the caller's list is left in request order, because the write order has
   * exactly one authority (`allocateBulk`) and a second sort here would make
   * that one unfalsifiable. See `doc/decision/0092-*` §"One authority".
   */
  private assertRequestable(
    dates: readonly DateOnly[],
    actor: AuthenticatedUser,
    settings: ReservationWindowSettings,
    today: DateOnly
  ): void {
    if (dates.length === 0) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'A bulk booking must name at least one day.',
      });
    }

    for (const date of [...dates].sort(compareDateOnly)) {
      this.policy.assertNotInThePast(date, today);
      this.policy.assertWindowOpen(date, actor, settings, today);
    }
  }

  /**
   * The single month the request covers.
   *
   * `bulkBookingInputSchema` already refuses a request that spans two months, so
   * on the wire this cannot fail. It is still checked, because the service is
   * also called directly and `month` is a claim about the whole batch: deriving
   * it from one day and hoping is how a response ends up describing a month it
   * does not cover.
   */
  private monthOf(dates: readonly DateOnly[]): string {
    const [first] = dates;
    if (first === undefined) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'A bulk booking must name at least one day.',
      });
    }
    const month = toYearMonth(first);
    if (dates.some((date) => toYearMonth(date) !== month)) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'A bulk booking must stay inside one calendar month.',
        details: { month },
      });
    }
    return month;
  }
}
