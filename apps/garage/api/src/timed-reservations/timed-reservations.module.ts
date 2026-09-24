import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ReservationWindowModule } from '../reservation-window/reservation-window.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { TimedReservationsController } from './timed-reservations.controller';
import { TimedReservationsService } from './timed-reservations.service';

/**
 * `ReservationPolicy` and `DomainEventPublisher` are not re-provided here —
 * both come from `ReservationsModule`, which exports them for exactly this
 * reason. A second `DomainEventPublisher` binding would resolve to its own
 * `CompositeDomainEventPublisher` instance, one that never reaches the
 * Socket.io gateway or the outbound Slack publisher `ReservationsModule`
 * wired up, and this module's events would silently go nowhere.
 */
@Module({
  imports: [AuditModule, ReservationWindowModule, ReservationsModule],
  controllers: [TimedReservationsController],
  providers: [TimedReservationsService],
})
export class TimedReservationsModule {}
