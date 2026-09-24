import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RealtimeDomainEventPublisher } from '../realtime/realtime.publisher';
import { ReservationLimitsModule } from '../reservation-limits/reservation-limits.module';
import { ReservationWindowModule } from '../reservation-window/reservation-window.module';
import { SlackDomainEventPublisher } from '../slack/slack-domain-event.publisher';
import { SlackModule } from '../slack/slack.module';
import { BulkReservationController } from './bulk-reservation.controller';
import { BulkReservationService } from './bulk-reservation.service';
import {
  CompositeDomainEventPublisher,
  DOMAIN_EVENT_PUBLISHERS,
} from './composite-domain-event.publisher';
import { DomainEventPublisher } from './reservation-events';
import { ReservationPolicy } from './reservation-policy';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { WaitlistController } from './waitlist.controller';
import { WaitlistPromotionService } from './waitlist-promotion.service';
import { WaitlistService } from './waitlist.service';

/**
 * Reservations, the waitlist and bulk booking, which are one module because they
 * are one transaction: cancelling a reservation promotes out of the waitlist,
 * and splitting them would mean either a circular import or a promotion that
 * could not share the cancellation's transaction. Bulk booking joins them
 * because it writes into both tables at once and shares the same policy, the
 * same audit shape and the same after-commit publisher.
 *
 * The window settings come from `ReservationWindowModule` rather than being
 * re-read here, for the same reason the day overview borrows them: one
 * definition of whether a month is open. `ReservationLimitsModule` is imported
 * on the same grounds: the month summary reports the monthly cap in force, and
 * one definition of it is the point.
 *
 * ## The one after-commit seam, with both implementations behind it
 *
 * `DomainEventPublisher` is an abstract class used as the injection token
 * rather than a `Symbol`, so the seam is discoverable from the type and a
 * replacement cannot silently have the wrong shape. Task 13 bound it to
 * `NoopDomainEventPublisher`; Task 15 (Socket.io broadcasts) and Task 16
 * (outbound Slack) each then claimed it, and each predicted the collision in a
 * comment. Nest resolves one provider per token, so the resolution is not a
 * choice between them: it is {@link CompositeDomainEventPublisher}, bound here
 * and fanning every fact out to both.
 *
 * The delegate list is built by a factory injecting the *concrete* publisher
 * classes, which `RealtimeModule` and `SlackModule` provide and export. That is
 * what preserves the guarantee Task 16 needed `useExisting` for: the Slack
 * publisher is the instance `SlackModule` built, not a second one Nest would
 * construct here — which would resolve, keep its own in-flight set, and fail on
 * the collaborators that module deliberately does not export. The same holds
 * for the realtime publisher, which needs the gateway `RealtimeModule` owns.
 * `slack.module.spec.ts` and `realtime.gateway.spec.ts` both check the identity
 * end-to-end, through the composite, rather than trusting this paragraph.
 *
 * **No call site changed**, and nothing about *when* the seam is called was
 * ever up to its implementation: the services below compute events inside the
 * transaction and publish strictly after `COMMIT`, outside the cancel retry
 * loop. The composite cannot move that, and does not need to know it.
 *
 * Ordering in the list is delivery order, not precedence — every delegate is
 * called for every event regardless of what the ones before it did. See
 * `composite-domain-event.publisher.ts` for why each forward gets its own
 * `try`.
 */
@Module({
  imports: [
    AuditModule,
    ReservationWindowModule,
    ReservationLimitsModule,
    RealtimeModule,
    SlackModule,
  ],
  controllers: [ReservationsController, WaitlistController, BulkReservationController],
  providers: [
    ReservationsService,
    WaitlistService,
    BulkReservationService,
    WaitlistPromotionService,
    ReservationPolicy,
    {
      provide: DOMAIN_EVENT_PUBLISHERS,
      inject: [RealtimeDomainEventPublisher, SlackDomainEventPublisher],
      useFactory: (
        realtime: RealtimeDomainEventPublisher,
        slack: SlackDomainEventPublisher
      ): readonly DomainEventPublisher[] => [realtime, slack],
    },
    { provide: DomainEventPublisher, useClass: CompositeDomainEventPublisher },
  ],
  // `ReservationPolicy` and `DomainEventPublisher` are exported so that
  // `TimedReservationsModule` (Task 4 of the guest-half-hour-blocks plan) can
  // reuse this module's day-eligibility rule and its one after-commit
  // publisher instance, instead of importing `RealtimeModule`/`SlackModule`
  // itself and standing up a second `CompositeDomainEventPublisher` that would
  // never reach either delegate.
  exports: [ReservationPolicy, DomainEventPublisher],
})
export class ReservationsModule {}
