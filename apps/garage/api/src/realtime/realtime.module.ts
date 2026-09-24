import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SpotsModule } from '../spots/spots.module';
import { LockService } from './lock.service';
import { RealtimeHandshakeAuthenticator } from './realtime-handshake';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeDomainEventPublisher } from './realtime.publisher';

/**
 * The realtime half of the API: the Socket.io gateway, the editing-hold
 * registry, and the implementation of the after-commit broadcast seam.
 *
 * ## Why the publisher lives here and not in `ReservationsModule`
 *
 * `DomainEventPublisher` is declared in `reservations/reservation-events.ts`
 * because that is where the events are *produced*; the Socket.io
 * implementation of it lives here, because this is where they are *delivered*.
 *
 * What this module exports is the **concrete** {@link
 * RealtimeDomainEventPublisher}, not the `DomainEventPublisher` token. Task 15
 * did bind the token here, but Task 16 (outbound Slack) implements the same
 * seam, and one token resolves to one provider: binding it in either module
 * would silently exclude the other. So `ReservationsModule` — the module that
 * declares the token and is the only place that can name both implementations
 * — binds it to a composite assembled from what the two modules export. See
 * `reservations/composite-domain-event.publisher.ts`.
 *
 * That direction — reservations importing realtime — is the one that does not
 * close a cycle: this module imports `reservation-events.ts` for the token and
 * the `DomainEvent` type, a file that imports nothing from `realtime/`.
 *
 * `AuthModule` is imported for `JwksVerifierService` and `AuthUserService`,
 * which {@link RealtimeHandshakeAuthenticator} injects and which it exports for
 * exactly this reason (`doc/decision/0042-*`): the handshake must reuse the
 * process's single JWKS client rather than open a second one with its own
 * cache, rate limiter and rotation moment. `PrismaService` and
 * `GracefulShutdownService` arrive from global modules.
 *
 * `SpotsModule` is imported for `SpotsService.isHidden`, which the gateway
 * reads on every broadcast to decide whether it may reach a non-admin
 * (`doc/decision/0316-*`). `SpotsModule` imports nothing from `realtime/`, so
 * this does not close a cycle.
 */
@Module({
  imports: [AuthModule, SpotsModule],
  providers: [
    LockService,
    // Not exported: who may connect is this module's own business, and the
    // gateway is the only thing that installs it.
    RealtimeHandshakeAuthenticator,
    RealtimeGateway,
    RealtimeDomainEventPublisher,
  ],
  exports: [RealtimeDomainEventPublisher, LockService, RealtimeGateway],
})
export class RealtimeModule {}
