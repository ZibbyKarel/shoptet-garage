/**
 * The assembled application, listening, with a real issuer and a real socket
 * server — the harness the realtime specs drive.
 *
 * The boot itself is `testing/nest-test-app.ts`, which this file was the
 * general version of before four other suites were folded into it. What is left
 * here is what is genuinely realtime-specific: the OIDC issuer and its signing
 * key, the token minters the specs drive the handshake with, the `PrismaDouble`,
 * and the short `REALTIME_LOCK_TTL_MS` that lets a suite watch a hold lapse
 * without waiting 30 s.
 *
 * **Nothing here is a test backdoor** — see the header of `nest-test-app.ts` for
 * the three environment values that differ from production, and why none of
 * them is a code path.
 *
 * Spec-only support code, excluded from `tsconfig.app.json`.
 */

import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { OidcTestIssuer } from '../../auth/testing/oidc-test-issuer';
import { createSigningKey, startOidcTestIssuer } from '../../auth/testing/oidc-test-issuer';
import { PrismaDouble } from '../../testing/prisma-double';
import { ALLOWED_ORIGIN, AUDIENCE, startApiTestApp } from '../../testing/nest-test-app';
import { signTestToken } from '../../auth/testing/sign-test-token';

export { ALLOWED_ORIGIN, AUDIENCE };

export interface RealtimeTestAppOptions {
  /** `REALTIME_LOCK_TTL_MS`. Short by default so a suite can watch a hold lapse. */
  readonly lockTtlMs?: number;
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
}

export interface RealtimeTestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly issuer: OidcTestIssuer;
  readonly double: PrismaDouble;
  /** Mints a token this API should accept, unless an option is deliberately wrong. */
  tokenFor(options: {
    subject: string;
    email?: string;
    name?: string;
    expiresInSeconds?: number;
  }): string;
  /** Mints a token signed by a key the issuer never published. */
  tokenFromAnImpostor(subject: string): string;
  close(): Promise<void>;
}

/** Boots the app, plus the issuer and the double it is wired to. */
export async function startRealtimeTestApp(
  options: RealtimeTestAppOptions = {}
): Promise<RealtimeTestApp> {
  const signingKey = createSigningKey('key-1');
  const issuer = await startOidcTestIssuer([signingKey]);
  const double = new PrismaDouble();

  const { app, baseUrl, close } = await startApiTestApp({
    issuer,
    store: double,
    // Spread rather than assigned: `exactOptionalPropertyTypes` refuses an
    // explicit `undefined` for an optional property.
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.onLogLine === undefined ? {} : { onLogLine: options.onLogLine }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    env: { REALTIME_LOCK_TTL_MS: String(options.lockTtlMs ?? 1_000) },
  });

  return {
    app,
    baseUrl,
    issuer,
    double,
    tokenFor: (tokenOptions) =>
      signTestToken({
        key: signingKey,
        issuer: issuer.issuer,
        audience: AUDIENCE,
        ...tokenOptions,
      }),
    tokenFromAnImpostor: (subject) =>
      signTestToken({
        // A different key pair published under the *same* `kid`, so the lookup
        // succeeds and the signature check is what refuses it.
        key: { ...createSigningKey('impostor'), kid: signingKey.kid },
        issuer: issuer.issuer,
        audience: AUDIENCE,
        subject,
      }),
    close: async () => {
      await close();
      await issuer.close();
    },
  };
}

/** A `UserSummary`-shaped seed, so a spec can assert on what a broadcast carried. */
export function seedEmployee(
  double: PrismaDouble,
  seed: {
    oktaId: string;
    name: string;
    licensePlate?: string | null;
    role?: 'USER' | 'ADMIN';
  }
): { id: string; name: string; licensePlate: string | null; oktaId: string } {
  const row = double.seedUser({
    oktaId: seed.oktaId,
    email: `${seed.oktaId}@example.test`,
    name: seed.name,
    licensePlate: seed.licensePlate ?? null,
    role: seed.role ?? 'USER',
  });
  return { id: row.id, name: row.name, licensePlate: row.licensePlate, oktaId: row.oktaId };
}
