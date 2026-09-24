/**
 * The assembled application, listening, with the real `AppModule` behind it —
 * the boot sequence every "through the whole pipeline" spec needs.
 *
 * It was written out five times before this file existed
 * (`realtime/testing/realtime-test-app.ts` plus the inlined `beforeAll`s in
 * `orpc/orpc-pipeline.spec.ts`, `calendar/calendar-pipeline.spec.ts`,
 * `calendar/calendar-logging.spec.ts` and `auth/auth-pipeline.spec.ts`), and it
 * had already drifted: two of the five set only `THROTTLE_LIMIT` and inherited
 * whatever a previously-run spec file had left in `process.env` for the strict
 * tier. Five copies means that question has to be re-answered five times. Now
 * the {@link ApiTestAppOptions} argument is the *only* thing that differs
 * between call sites, and it says so by name.
 *
 * **Nothing here is a test backdoor.** The module under test is the real
 * `AppModule` and the HTTP server is the one `configureApp` builds. Only
 * environment *values* differ from production, and no code path does:
 *
 * - `AUTH_OKTA_ISSUER` points at an in-process OIDC server instead of Okta —
 *   exactly as dev and e2e point it at `mock-oauth2-server`;
 * - the throttle limits are effectively disabled, so a suite that sends a dozen
 *   requests is not measuring the rate limiter by accident;
 * - `DATABASE_URL` is present but unused, because `PrismaService` is replaced
 *   by the caller's in-memory store (Docker is not available to `api:test`).
 *
 * Spec-only support code, excluded from `tsconfig.app.json`.
 */

import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { OidcTestIssuer } from '../auth/testing/oidc-test-issuer';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';
import { buildLoggerOptions } from '../logging/logger.options';

export const AUDIENCE = 'api://default';
export const ALLOWED_ORIGIN = 'http://localhost:4200';

/**
 * The rate limit these suites run at.
 *
 * High enough that rate limiting never interferes with an assertion; the
 * throttler is still in the chain, ahead of the auth guard. Both tiers are
 * pinned rather than only the global one — see the header. The strict tier is
 * an *override* of the same registered throttler and is applied by exactly one
 * decorator (`@StrictThrottle()` on the ICS feed route), so pinning it is a
 * no-op for a suite that never hits that route, and pinning it explicitly is
 * what stops the value depending on which spec file ran first in the worker.
 */
const UNTHROTTLED = '100000';

export interface ApiTestAppOptions {
  /**
   * A live OIDC issuer, whose URL becomes `AUTH_OKTA_ISSUER`.
   *
   * Passed in rather than created here because the caller needs the signing key
   * anyway — to mint tokens, and in two specs to mint deliberately bad ones —
   * and because a caller that boots a *second* app (`calendar-pipeline.spec.ts`,
   * for a fresh throttler counter) reuses the first one's issuer. The caller
   * owns it: {@link ApiTestApp.close} closes the app and nothing else.
   */
  readonly issuer: OidcTestIssuer;
  /**
   * What replaces `PrismaService`. `PrismaDouble` for most suites,
   * `InMemoryUserStore` for `auth-pipeline.spec.ts`.
   */
  readonly store: { asPrismaService(): object };
  /**
   * Extra controllers compiled alongside `AppModule` — `auth-pipeline.spec.ts`'s
   * three probe routes. Not expressible through {@link overrides}, which only
   * sees the builder after `createTestingModule` has taken its metadata.
   */
  readonly controllers?: Type<unknown>[];
  /** `LOG_LEVEL`. `fatal` unless a spec is reading log output. */
  readonly logLevel?: string;
  /** Receives every line pino emits, if a spec asked for a level that emits any. */
  readonly onLogLine?: (line: string) => void;
  /**
   * A last chance to substitute a provider before the module compiles.
   *
   * Used by `realtime-ack-leak.spec.ts` to hand the gateway a `LockService`
   * whose grant carries a *fat* holder — the shape a Prisma `select` that is
   * not honoured produces. There is no other seam that can produce it, because
   * the real `loadUserSummary` (`realtime-handshake.ts`) narrows to three
   * fields on the way in, and a defence that only the code path it guards can
   * reach is a defence no test can falsify. It stands in for a dependency's
   * **behaviour**, never for the shape of an error or for the protocol.
   */
  readonly overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /**
   * Merged over the shared literal, before `AppModule` is imported.
   *
   * The escape hatch for the values only one suite cares about:
   * `REALTIME_LOCK_TTL_MS` for the realtime harness, `THROTTLE_STRICT_LIMIT: '2'`
   * for the one suite that actually wants the strict tier to trip. It has to be
   * an env write rather than an {@link overrides} call because
   * `ConfigModule.forRoot({ validate })` runs at *import* time.
   */
  readonly env?: Partial<Record<TestAppEnvKey, string>>;
}

/**
 * The env keys a caller may override.
 *
 * Deliberately a closed set rather than `string`. The whole point of this
 * module is that five suites stopped writing their own boot env and drifted
 * apart while nobody was looking — three set `THROTTLE_STRICT_LIMIT`, two set
 * only `THROTTLE_LIMIT`. An open `Record<string, string>` is the same door left
 * open: a suite could re-diverge on any key with no reviewer signal. Widen this
 * union when a suite genuinely needs another key, and the widening is the
 * signal.
 */
export type TestAppEnvKey = 'REALTIME_LOCK_TTL_MS' | 'THROTTLE_STRICT_LIMIT';

export interface ApiTestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  /** Closes the app. The issuer belongs to the caller. */
  close(): Promise<void>;
}

/**
 * Boots the app.
 *
 * `process.env` is written before `AppModule` is imported, because
 * `ConfigModule.forRoot({ validate })` runs at import time — the same mechanism
 * `auth-pipeline.spec.ts` documents. Restoring it afterwards is the caller's
 * job, because the caller is the one that knows when its last test has run.
 */
export async function startApiTestApp(options: ApiTestAppOptions): Promise<ApiTestApp> {
  const logLevel = options.logLevel ?? 'fatal';

  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://garage:garage@localhost:5432/garage',
    AUTH_OKTA_ISSUER: options.issuer.issuer,
    AUTH_OKTA_AUDIENCE: AUDIENCE,
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    LOG_LEVEL: logLevel,
    THROTTLE_LIMIT: UNTHROTTLED,
    THROTTLE_STRICT_LIMIT: UNTHROTTLED,
    ...options.env,
  });
  const { AppModule } = await import('../app/app.module');

  // A store built for one service (`InMemoryUserStore`, for `AuthUserService`)
  // does not model every Prisma model — only `PrismaDouble` does. But the real
  // `AppModule` boots every provider regardless of which suite is asking, and
  // `SpotsService.onModuleInit` reads `parkingSpot` at boot. `parkingSpot`
  // therefore gets a harmless empty answer here unless the store already
  // provides its own (`PrismaDouble` does, and wins by spreading second).
  const storePrisma = options.store.asPrismaService() as { client?: Record<string, unknown> };

  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
    ...(options.controllers === undefined ? {} : { controllers: options.controllers }),
  })
    .overrideProvider(PrismaService)
    .useValue({
      ...storePrisma,
      client: {
        parkingSpot: { findMany: () => Promise.resolve([]) },
        ...storePrisma.client,
      },
      ping: jest.fn(),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
    });

  if (options.onLogLine !== undefined) {
    // The real options the running server uses, with a destination attached.
    // Nothing about redaction is configured here; a spec that configured it
    // would be testing its own setup.
    const emit = options.onLogLine;
    const loggerOptions = buildLoggerOptions({
      LOG_LEVEL: logLevel as never,
      NODE_ENV: 'test',
    });
    const params: Params = {
      ...loggerOptions,
      pinoHttp: [
        loggerOptions.pinoHttp as Options,
        {
          write(chunk: string) {
            emit(String(chunk));
          },
        },
      ],
    };
    builder = builder.overrideProvider(PARAMS_PROVIDER_TOKEN).useValue(params);
  }

  if (options.overrides !== undefined) {
    builder = options.overrides(builder);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, { BODY_LIMIT: '100kb', CORS_ALLOWED_ORIGINS: [ALLOWED_ORIGIN] });
  await app.init();
  await app.listen(0);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  return {
    app,
    baseUrl,
    close: async () => {
      await app.close();
    },
  };
}
