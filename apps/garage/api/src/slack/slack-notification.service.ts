/**
 * The domain half of the Slack integration: what to say, and to whom.
 *
 * `SlackClient` knows how to talk to Slack and nothing about parking;
 * `slack-messages.ts` knows the Czech wording and nothing about the database;
 * this class is the seam that turns a committed fact into one of those messages
 * and hands it over. Splitting it that way is what lets the wording be tested
 * without a network and the retry be tested without a database.
 *
 * ## Everything here runs after `COMMIT`
 *
 * Every method reads the database, so calling one inside a transaction would
 * mean a second connection reading rows the first has not committed — but the
 * far worse problem is the Slack call itself. `reservation-events.ts` puts it
 * plainly: a websocket frame sent inside a transaction that then rolls back is
 * a mistake a client recovers from; **a Slack message that says "your spot is
 * ready" cannot be taken back**, and the person it lied to will drive to the
 * office. `ReservationsService.cancel` already publishes strictly outside the
 * retry loop, past `await`; nothing in this file may be called from anywhere
 * else.
 *
 * ## Failures this class turns into outcomes, and one it does not
 *
 * A missing spot row, an unreachable Slack, a user with no Slack account — all
 * of them return an outcome and log, never a rejection. `plan.md` is explicit
 * that a Slack failure never breaks a domain operation, and the cheapest way to
 * guarantee that at every *Slack* call site is to leave nothing to catch.
 *
 * That does not extend to the database reads above the Slack call in each
 * method (`spotLabel`, the user lookup, `collectDailySummary`'s three reads):
 * none of them is guarded, so a Prisma failure *does* reject the method — an
 * ordinary, expected way for this to fail, not a bug. `SlackDomainEventPublisher.detach`
 * is what actually keeps that off the request path (see its own comment); it is
 * not something this class promises on its own.
 */

import { Injectable } from '@nestjs/common';
import type { DateOnly } from '@garage/shared-types';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { toDateColumn } from '../common/prisma-mapping';
import { PrismaService } from '../database/prisma.service';
import type { WaitlistPromotionNotice } from '../reservations/reservation-events';
import type { SlackDeliveryOutcome } from './slack-client.service';
import { SlackClient } from './slack-client.service';
import type { DailySummary } from './slack-messages';
import { dailySummaryMessage, spotFreedMessage, waitlistPromotedMessage } from './slack-messages';

/** The `reservation:cancelled` facts this service needs, and no more. */
export interface SpotFreedNotice {
  readonly parkingSpotId: string;
  readonly date: DateOnly;
  readonly reservationId: string;
}

/**
 * Outcomes {@link SlackClient} cannot produce, because they happen before a
 * call is attempted. Kept distinct from `'failed'` so a log — and a test — can
 * tell "Slack refused" from "there was nobody to tell".
 */
export type SlackNotificationOutcome =
  | SlackDeliveryOutcome
  /** The spot, user or Slack account the message was about does not exist. */
  | 'skipped';

@Injectable()
export class SlackNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slack: SlackClient,
    @InjectPinoLogger(SlackNotificationService.name) private readonly logger: PinoLogger
  ) {}

  /**
   * A spot was cancelled and nobody was queued for it, so it is free for
   * anyone — which is why this goes to the shared channel rather than to a
   * person.
   */
  async notifySpotFreed(notice: SpotFreedNotice): Promise<SlackNotificationOutcome> {
    const spot = await this.prisma.client.parkingSpot.findUnique({
      where: { id: notice.parkingSpotId },
      select: { label: true, hidden: true },
    });
    if (spot === null) {
      this.logger.warn(
        { parkingSpotId: notice.parkingSpotId, reservationId: notice.reservationId },
        'Freed spot has no row; Slack notice skipped'
      );
      return 'skipped';
    }
    if (spot.hidden) {
      // The channel is everybody; a hidden spot is nobody's but the admins'
      // (`doc/decision/0316-*`). Not a warning — nothing went wrong.
      this.logger.debug(
        { parkingSpotId: notice.parkingSpotId, reservationId: notice.reservationId },
        'Freed spot is hidden; Slack notice skipped'
      );
      return 'skipped';
    }

    return this.slack.postToChannel(spotFreedMessage(spot.label, notice.date));
  }

  /**
   * Somebody was promoted off the waitlist, and is told directly.
   *
   * The Slack account is found with `users.lookupByEmail`, matching on the
   * email the API already holds for the user — the same address Okta
   * authenticated them with, so the two directories agree without this
   * application storing a second identifier per person. A user whose email is
   * not in the workspace is `'skipped'`: they still hold the reservation, they
   * simply learn about it from the app.
   */
  async notifyWaitlistPromotion(
    notice: WaitlistPromotionNotice
  ): Promise<SlackNotificationOutcome> {
    const [user, label] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: notice.userId },
        select: { email: true },
      }),
      this.spotLabel(notice.parkingSpotId),
    ]);

    if (user === null || label === undefined) {
      this.logger.warn(
        { reservationId: notice.reservationId, parkingSpotId: notice.parkingSpotId },
        'Promoted user or spot has no row; Slack DM skipped'
      );
      return 'skipped';
    }

    const slackUserId = await this.slack.lookupUserIdByEmail(user.email);
    if (slackUserId === undefined) {
      // Not a warning when Slack is simply off — `lookupUserIdByEmail` has
      // already said so at `debug`, and this line would repeat it per
      // promotion for an installation that made a deliberate choice.
      this.logger[this.slack.enabled ? 'warn' : 'debug'](
        { reservationId: notice.reservationId },
        'No Slack user for the promoted reservation; DM skipped'
      );
      return this.slack.enabled ? 'skipped' : 'disabled';
    }

    return this.slack.postDirectMessage(slackUserId, waitlistPromotedMessage(label, notice.date));
  }

  /** Posts the summary for one Prague calendar day to the shared channel. */
  async postDailySummary(date: DateOnly): Promise<SlackNotificationOutcome> {
    const summary = await this.collectDailySummary(date);
    return this.slack.postToChannel(dailySummaryMessage(summary));
  }

  /**
   * The summary's data, in one round trip of three independent reads.
   *
   * "Free" is computed by subtracting the day's reservations from the active
   * spots rather than by a `NOT EXISTS` query, because the message lists the
   * free spots by **label** in the same order the lot screen does
   * (`SpotsService.listActive`), and re-deriving that order in SQL would be a
   * second definition of it. Guest time blocks (`TimedReservation`,
   * `doc/decision/0314-*`) make a spot unavailable for a full day too, even
   * though the cell has no `Reservation` row, so they are subtracted the same
   * way. Hidden spots are left out of both the count and the list — the
   * channel is read by everybody (`doc/decision/0316-*`).
   */
  private async collectDailySummary(date: DateOnly): Promise<DailySummary> {
    const dateColumn = toDateColumn(date);
    const [spots, reservations, timedReservations, waitingCount] = await Promise.all([
      this.prisma.client.parkingSpot.findMany({
        where: { active: true, hidden: false },
        orderBy: { label: 'asc' },
        select: { id: true, label: true },
      }),
      this.prisma.client.reservation.findMany({
        where: { date: dateColumn },
        select: { parkingSpotId: true },
      }),
      this.prisma.client.timedReservation.findMany({
        where: { date: dateColumn },
        select: { parkingSpotId: true },
      }),
      this.prisma.client.waitlistEntry.count({ where: { date: dateColumn } }),
    ]);

    const unavailableSpotIds = new Set(
      [...reservations, ...timedReservations].map((row) => row.parkingSpotId)
    );
    return {
      date,
      totalSpots: spots.length,
      freeSpotLabels: spots.filter((spot) => !unavailableSpotIds.has(spot.id)).map((s) => s.label),
      waitingCount,
    };
  }

  private async spotLabel(parkingSpotId: string): Promise<string | undefined> {
    const spot = await this.prisma.client.parkingSpot.findUnique({
      where: { id: parkingSpotId },
      select: { label: true },
    });
    return spot?.label;
  }
}
