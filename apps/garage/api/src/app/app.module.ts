import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from '../auth/auth.module';
import { CalendarModule } from '../calendar/calendar.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ContractExceptionFilter } from '../common/filters/contract-exception.filter';
import { globalThrottlerOptions } from '../common/throttling/throttle-tiers';
import { DatabaseModule } from '../database/database.module';
import type { ApiEnv } from '../env';
import { validateApiEnv } from '../env';
import { HealthModule } from '../health/health.module';
import { buildLoggerOptions } from '../logging/logger.options';
import { MeModule } from '../me/me.module';
import { OverviewModule } from '../overview/overview.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReservationLimitsModule } from '../reservation-limits/reservation-limits.module';
import { ReservationWindowModule } from '../reservation-window/reservation-window.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { ShutdownModule } from '../shutdown/shutdown.module';
import { SlackModule } from '../slack/slack.module';
import { SpotsModule } from '../spots/spots.module';
import { TimedReservationsModule } from '../timed-reservations/timed-reservations.module';
import { UsersModule } from '../users/users.module';

/**
 * The operational baseline is assembled here rather than in `main.ts` wherever
 * it can be, so that a test spinning up `AppModule` gets the same filter,
 * guard and logger the running server does. Only what genuinely needs the
 * `INestApplication` — helmet, CORS, body limits, shutdown hooks — lives in
 * `main.ts`.
 *
 * `ConfigModule` is first on purpose: `validateApiEnv` runs during its
 * initialization, so a missing variable aborts the boot before any other module
 * has done anything.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateApiEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<ApiEnv, true>) =>
        buildLoggerOptions({
          LOG_LEVEL: configService.get('LOG_LEVEL', { infer: true }),
          NODE_ENV: configService.get('NODE_ENV', { infer: true }),
        }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<ApiEnv, true>) =>
        globalThrottlerOptions({
          THROTTLE_TTL_MS: configService.get('THROTTLE_TTL_MS', { infer: true }),
          THROTTLE_LIMIT: configService.get('THROTTLE_LIMIT', { infer: true }),
        }),
    }),
    ShutdownModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    // Domain modules (Task 12). Each one mounts its share of the oRPC contract;
    // `orpc-route-parity.spec.ts` fails if the routes and the contract drift.
    SpotsModule,
    UsersModule,
    MeModule,
    ReservationWindowModule,
    ReservationLimitsModule,
    OverviewModule,
    // Task 15. The Socket.io gateway and the editing-hold registry. Listed
    // explicitly even though `ReservationsModule` also imports it (for the
    // after-commit publisher), because a gateway that exists only as somebody
    // else's transitive import is a gateway one refactor away from vanishing.
    RealtimeModule,
    // Task 13. Reservations, the waitlist, and the auto-promotion that couples
    // them inside one transaction.
    ReservationsModule,
    // Admin-only guest half-hour blocks. Imported after `ReservationsModule`
    // because it reuses that module's exported `ReservationPolicy` and
    // `DomainEventPublisher` rather than standing up its own.
    TimedReservationsModule,
    // The ICS feed (Task 14). The one controller outside the oRPC contract —
    // see its class comment and `doc/decision/0080-*`.
    CalendarModule,
    // Outbound Slack notifications and the daily-summary job (Task 16).
    // Imported here as well as by `ReservationsModule` so the composition root
    // shows it: the job is not a reservations concern, and Nest resolves the
    // same singleton either way.
    SlackModule,
  ],
  // No controllers of its own. The Nx scaffold's `AppController`
  // (`GET /api` → `{"message":"Hello API"}`) lived here and was deleted: it
  // existed in no contract, which global constraint 1 forbids, and nothing
  // called it. See `doc/decision/0239-*`.
  providers: [
    // Registered as a provider rather than via `app.useGlobalFilters(...)` so
    // that Nest can inject the pino logger into it.
    { provide: APP_FILTER, useClass: ContractExceptionFilter },
    // Global guards run in registration order, and this order is load-bearing:
    //
    // 1. `ThrottlerGuard` — rate limiting must apply to unauthenticated
    //    traffic too, so it cannot sit behind authentication.
    // 2. `JwtAuthGuard` — authenticates by default; `@Public()` opts out.
    // 3. `RolesGuard` — authorizes, and reads the `request.user` that (2) set.
    //
    // Registering (3) before (2) would make every `@Roles()` route answer 401.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
