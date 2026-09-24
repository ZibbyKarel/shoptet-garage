/**
 * The day overview — one request that paints the whole parking screen.
 *
 * `plan.md` and the contract are explicit that this is **one** query from the
 * client's side: the grid, the queue badges, the caller's own position and the
 * reservation-window banner all come back together. A screen assembled from four
 * round trips can render a day's grid against a window it fetched a second
 * earlier, and the two would disagree exactly when it matters — at the moment a
 * month opens or closes.
 *
 * ## Why the waitlist is read whole and counted here
 *
 * Three of the five fields per spot come from the same rows: how many people are
 * queued, whether the caller is one of them, and where in the queue they stand.
 * A `groupBy` for the counts plus a second query for the caller's position would
 * be two reads of the same data with nothing keeping them consistent, and the
 * position is defined by the *order* of the rows anyway (`createdAt`, then `id`
 * as the tiebreaker — the same order Task 13 promotes in). One ordered read of
 * one day's queue, counted in memory, is both cheaper and the only way the count
 * and the position cannot contradict each other.
 */

import { Injectable } from '@nestjs/common';
import type {
  DayOverviewInput,
  DayOverviewOutput,
  DaySpotOverview,
  ReservationWindowSettings,
} from '@garage/contract';
import type { DateOnly } from '@garage/shared-types';
import { compareDateOnly, isBusinessDay, isMonthOpen, todayInPrague } from '@garage/shared-types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import {
  toDateColumn,
  toPublicReservation,
  toPublicTimedReservation,
} from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import { ReservationWindowService } from '../reservation-window/reservation-window.service';
import { WAITLIST_ORDER } from '../reservations/waitlist-order';
import { SpotsService } from '../spots/spots.service';

@Injectable()
export class DayOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spots: SpotsService,
    private readonly window: ReservationWindowService
  ) {}

  async getDay(
    input: DayOverviewInput,
    viewer: AuthenticatedUser,
    today: DateOnly = todayInPrague()
  ): Promise<DayOverviewOutput> {
    const dateColumn = toDateColumn(input.date);

    const [spots, settings, reservations, waitlist, timedReservations] = await Promise.all([
      this.spots.listActive(),
      this.window.getSettings(),
      this.prisma.client.reservation.findMany({
        where: { date: dateColumn },
        include: { user: { select: { id: true, name: true, licensePlate: true } } },
      }),
      this.prisma.client.waitlistEntry.findMany({
        where: { date: dateColumn },
        orderBy: WAITLIST_ORDER,
        select: { id: true, parkingSpotId: true, userId: true },
      }),
      this.prisma.client.timedReservation.findMany({
        where: { date: dateColumn },
        orderBy: { startMinute: 'asc' },
      }),
    ]);

    const reservationBySpot = new Map(reservations.map((row) => [row.parkingSpotId, row]));
    const queueBySpot = new Map<string, { id: string; userId: string }[]>();
    for (const entry of waitlist) {
      const queue = queueBySpot.get(entry.parkingSpotId) ?? [];
      queue.push({ id: entry.id, userId: entry.userId });
      queueBySpot.set(entry.parkingSpotId, queue);
    }
    const timedReservationsBySpot = new Map<string, typeof timedReservations>();
    for (const row of timedReservations) {
      const blocks = timedReservationsBySpot.get(row.parkingSpotId) ?? [];
      blocks.push(row);
      timedReservationsBySpot.set(row.parkingSpotId, blocks);
    }

    const spotOverviews: DaySpotOverview[] = spots.map((spot) => {
      const reservation = reservationBySpot.get(spot.id);
      const queue = queueBySpot.get(spot.id) ?? [];
      // `findIndex` on an already-ordered array: the position *is* the order.
      const viewerIndex = queue.findIndex((entry) => entry.userId === viewer.id);
      const viewerEntry = viewerIndex === -1 ? undefined : queue[viewerIndex];

      return {
        // Already in contract shape: `SpotsService.listActive` is the single
        // definition of "which spots exist and in what order", and re-mapping it
        // here would be a second one.
        spot,
        reservation:
          reservation === undefined ? null : toPublicReservation(reservation, reservation.user),
        waitlistCount: queue.length,
        viewerWaitlistEntryId: viewerEntry?.id ?? null,
        viewerWaitlistPosition: viewerEntry === undefined ? null : viewerIndex + 1,
        timedReservations: (timedReservationsBySpot.get(spot.id) ?? []).map(
          toPublicTimedReservation
        ),
      };
    });

    const viewerReservation = reservations.find((row) => row.userId === viewer.id);

    const canReserveMonth = this.canReserveMonth(input.date, settings, viewer, today);

    return {
      date: input.date,
      window: this.window.describeDay(input.date, settings, today),
      canReserve: canReserveMonth && this.isReservableDay(input.date, today),
      canReserveMonth,
      spots: spotOverviews,
      viewerReservationId: viewerReservation?.id ?? null,
    };
  }

  /**
   * Whether **this** caller may create reservations anywhere in the month
   * `date` falls in — the **per-month** half of `canReserve`.
   *
   * 1. An admin is exempt from the reservation window (`plan.md`
   *    §Byznys pravidla, `doc/decision/0004-*`).
   * 2. Everybody else needs the target day's month to be open, which is
   *    `isMonthOpen` from `@garage/shared-types` and is never re-implemented
   *    here.
   *
   * Both facts are the backend's alone — the frontend must not re-derive them
   * from `window`, because the admin exemption does not appear anywhere in the
   * payload (`doc/decision/0120-*`).
   */
  private canReserveMonth(
    date: DateOnly,
    settings: ReservationWindowSettings,
    viewer: AuthenticatedUser,
    today: DateOnly
  ): boolean {
    if (viewer.role === 'ADMIN') {
      return true;
    }
    return isMonthOpen(date, settings.openDaysBefore, settings.lockMode, today);
  }

  /**
   * Whether **this** day could be booked at all, by anybody — the **per-day**
   * half of `canReserve`.
   *
   * 1. A day in the past cannot be booked by anybody, admin included.
   * 2. Neither can a weekend or a Czech public holiday: the lot is a workplace
   *    car park.
   *
   * Kept apart from {@link canReserveMonth} rather than inlined into one
   * four-rule check, because the two halves answer different questions and
   * `canReserveMonth` is now on the wire in its own right
   * (`doc/decision/0175-*`). Splitting them is also what makes `canReserve`'s
   * composition visible: `canReserveMonth && isReservableDay`, in that order,
   * is exactly the four rules the previous single method ran — the admin
   * exemption still does **not** rescue a weekend, because this conjunct is
   * evaluated regardless of role.
   *
   * Note what is deliberately *not* in either half: whether the caller already
   * holds a reservation that day. That is the one-per-day rule, it is enforced
   * by a unique constraint at write time, and the screen can see it directly in
   * `viewerReservationId` — folding it in would make `canReserve` mean two
   * different things at once.
   */
  private isReservableDay(date: DateOnly, today: DateOnly): boolean {
    return compareDateOnly(date, today) >= 0 && isBusinessDay(date);
  }
}
