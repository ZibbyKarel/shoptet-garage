/**
 * Who may open a Socket.io connection: the handshake half of `doc/realtime.md`.
 *
 * This is the file that answers "why was my socket refused?". It owns the
 * credential schema, the rejection taxonomy, the single place a refusal is
 * logged, and the `UserSummary` an authenticated socket carries — everything
 * that changes when *authentication* changes (a new claim, a second issuer, a
 * different rejection reason). What a connected socket may then *do* — rooms,
 * the editing hold, the after-commit broadcast — changes for entirely
 * different reasons and lives in `realtime.gateway.ts`. The two share exactly
 * one thing: {@link RealtimeSocketData}, which this file writes and the
 * gateway reads.
 *
 * One guarantee `libs/garage/realtime-client` (Task 21) holds and this file is
 * responsible for honouring:
 *
 * **The token is read from `socket.handshake.auth.token`, and nowhere else.**
 * Not the query string (it lands verbatim in every proxy access log), not a
 * header (the browser `WebSocket` API cannot set one, so Socket.io would apply
 * it to the polling transport only and a socket that upgraded would silently
 * stop presenting its credential). `doc/decision/0060-*`.
 *
 * The companion guarantee — **a refusal must arrive as a CONNECT_ERROR, which
 * means middleware** (`doc/decision/0112-*`) — is a property of *where this is
 * installed*, so it stays with the installation: see
 * `RealtimeGateway.afterInit`, which registers {@link
 * RealtimeHandshakeAuthenticator.authenticate} as `server.use(...)` and turns
 * the error thrown here into `next(error)`.
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Socket } from 'socket.io';
import * as z from 'zod';
import type { UserRole, UserSummary } from '@garage/contract';
import type { ClientToServerEvents, ServerToClientEvents } from '@garage/contract/realtime';
import { AuthUserService } from '../auth/auth-user.service';
import { JwksVerifierService } from '../auth/jwks-verifier.service';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../database/prisma.service';

/**
 * The message every refused handshake carries to the client.
 *
 * One string for every rejection reason, deliberately: the four *operator*
 * problems behind an auth failure are already separated in the logs by
 * `JwksVerifierService`, and telling an unauthenticated caller which of "no
 * token", "bad signature", "wrong audience" and "deactivated account" applies
 * to them is an oracle. `socket.io` puts this in the CONNECT_ERROR packet's
 * `message`; the `data` field is left unset, because whatever goes in it is
 * sent to a caller who has just failed to authenticate.
 */
export const HANDSHAKE_REJECTION_MESSAGE = 'Unauthorized';

/**
 * What the gateway keeps on an authenticated socket.
 *
 * `user` is the `UserSummary` a `cell:locked` broadcast carries, resolved once
 * during the handshake rather than per lock request: it changes about as often
 * as somebody buys a car, and re-reading it fifteen times a minute per open
 * form would be a query per heartbeat.
 *
 * Declared here rather than in the gateway because this is the side that
 * *writes* it — the seam between the two responsibilities, pointing in the one
 * direction that does not close a cycle.
 */
export interface RealtimeSocketData {
  readonly user: UserSummary;
  /**
   * The connecting user's role, at handshake time. Read by the gateway to send
   * a hidden spot's traffic to admins only (`doc/decision/0316-*`). Never
   * broadcast — `user` is the only part of this that reaches another browser.
   */
  readonly role: UserRole;
}

/** A connection, typed from the contract in the direction the server sees it. */
export type RealtimeServerSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

/**
 * The handshake credential.
 *
 * Deliberately **not** in `@garage/contract/realtime`, and that is not a
 * contract-first exception: the contract's realtime entry point declares
 * *events and their payloads*, and this is Socket.io's connection-level auth
 * object, which exists before any event does. `libs/garage/realtime-client` makes the
 * same call — it declares `RealtimeHandshakeAuth` locally rather than in the
 * contract.
 *
 * `looseObject`, not `strictObject`: `handshake.auth` is where Socket.io's own
 * connection-state-recovery machinery puts `pid` and `offset`, so an object
 * with extra keys is the library working, not a client disagreeing.
 */
const handshakeAuthSchema = z.looseObject({
  token: z.string().min(1),
});

/**
 * Why a handshake was refused. Reaches the logs; **never** the client, which
 * gets {@link HANDSHAKE_REJECTION_MESSAGE} for all five.
 */
type HandshakeRejectionReason =
  /** `handshake.auth` carried no usable `token`. */
  | 'no-token'
  /** A token this API was never going to accept. */
  | 'token-rejected'
  /** Verified, but the account is deactivated. */
  | 'user-deactivated'
  /** Verified, but it names nobody this API can provision — an IdP scope problem. */
  | 'user-unprovisionable'
  /** A defect: the database is down, provisioning kept losing races. */
  | 'unexpected-error';

/**
 * Decides who may connect, and writes {@link RealtimeSocketData} onto the
 * socket of everybody who may.
 *
 * Installed by `RealtimeGateway.afterInit` as namespace middleware, which is
 * what makes a refusal a CONNECT_ERROR rather than a disconnect
 * (`doc/decision/0112-*`), and what makes a refused handshake a terminal status
 * the client recovers from with a new socket (`doc/decision/0061-*`).
 */
@Injectable()
export class RealtimeHandshakeAuthenticator {
  constructor(
    private readonly verifier: JwksVerifierService,
    private readonly users: AuthUserService,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(RealtimeHandshakeAuthenticator.name) private readonly logger: PinoLogger
  ) {}

  /**
   * Verifies a handshake and resolves who is on the other end.
   *
   * Same code in dev, e2e and production; only `AUTH_OKTA_ISSUER` differs.
   * There is no `NODE_ENV` branch and no bypass flag, which is why the
   * integration specs stand up a real in-process OIDC issuer and sign real
   * RS256 tokens rather than stubbing this out.
   *
   * `JwksVerifierService.verifyToken` is the *same* verifier, with the same
   * single `JwksClient` and the same `JwtVerificationRules`, that the HTTP
   * guard reaches through `passport-jwt` — `doc/decision/0042-*`. A second
   * `jwks-rsa` client here would mean two key caches, two rate limiters and two
   * rotation moments.
   */
  async authenticate(socket: RealtimeServerSocket): Promise<void> {
    // `handshake.auth`, never `handshake.query` and never a header.
    const auth = handshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) {
      // `libs/garage/realtime-client` sends `{}` — an object with no `token` key at
      // all — when there is no session, precisely so this branch is reached
      // rather than a present-but-null credential.
      throw this.rejectHandshake('no-token');
    }

    // Verification and identity resolution are caught **separately**, because
    // they fail for different reasons and an operator needs to tell them apart.
    let claims: Awaited<ReturnType<JwksVerifierService['verifyToken']>>;
    try {
      claims = await this.verifier.verifyToken(auth.data.token);
    } catch {
      // Everything `verifyToken` raises is a token this API was never going to
      // accept: a malformed JWT, an unknown `kid`, a bad signature, a wrong
      // issuer or audience, an expired token, claims that are not claims.
      // `JwksVerifierService` has already classified and rate-limited its own
      // diagnosis, so this line carries no `err` — forwarding a stack for
      // something an anonymous caller can trigger at will is the log-flood
      // vector `ContractExceptionFilter` refuses for the same reason, and a
      // refused handshake is *retried* by the client at 1 s / 5 s / 30 s.
      //
      // **And no token.** Not the raw JWT, not `handshake.auth`, and not the
      // error — the claims parse raises a `ZodError` that can carry input,
      // which is why the caught value is not bound at all.
      throw this.rejectHandshake('token-rejected');
    }

    try {
      const user = await this.users.resolve(claims);
      // The whole object, not a field of it: `data` is written exactly once, by
      // this middleware, before the socket is connected and before any handler
      // can read it.
      socket.data = {
        user: await this.loadUserSummary(user.id, user.name),
        role: user.role,
      };
    } catch (error) {
      // A deactivated user. The one rejection an *authenticated* caller can
      // reach, so it keeps its stack — the same call `ContractExceptionFilter`
      // makes for a `DomainError` over HTTP, and for the same reason: the
      // frames name the rule that refused, and only somebody with a valid token
      // can trigger one.
      if (error instanceof DomainError) {
        throw this.rejectHandshake('user-deactivated', error);
      }
      // A verified token that names no provisionable user — the IdP client is
      // missing the `email` scope. `AuthUserService` has already logged that at
      // `error` with the subject, so this line adds the socket's side of it and
      // no stack.
      if (error instanceof UnauthorizedException) {
        throw this.rejectHandshake('user-unprovisionable');
      }
      // Anything else is a defect — the database is unreachable, provisioning
      // kept losing races. Logged **with** the stack, because unlike the
      // branches above nobody can trigger this at will, and reaching it means
      // something is broken rather than somebody being refused.
      throw this.rejectHandshake('unexpected-error', error);
    }
  }

  /**
   * The `UserSummary` a broadcast carries.
   *
   * `AuthenticatedUser` is a token claim short of the row — it has no
   * `licensePlate`, which `userSummarySchema` requires — so the plate is read
   * once here. A row that vanished between the auth resolve and this read
   * cannot happen (users are deactivated, never deleted:
   * `doc/decision/0027-*`), but the fallback is the authenticated name rather
   * than a throw, because failing a handshake over a missing plate would be a
   * refusal the client retries three times and then surfaces to the user.
   */
  private async loadUserSummary(userId: string, name: string): Promise<UserSummary> {
    const row = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, licensePlate: true },
    });
    if (row === null) {
      return { id: userId, name, licensePlate: null };
    }
    // The three fields, named. Not `row` and not a spread: the `select` above
    // is a *query* narrowing, and the object it produces is one refactor (or
    // one stand-in that does not honour `select`) away from carrying `email`,
    // `oktaId` and `icsToken` into a payload bound for another user's browser.
    // The outbound schemas strip them either way — this is so there is nothing
    // to strip.
    return { id: row.id, name: row.name, licensePlate: row.licensePlate };
  }

  /**
   * The **one** place a refusal is logged, and the error the middleware hands
   * to `next()`.
   *
   * One message and one `reason` field for every rejection, so an operator
   * greps once. The level, and whether the stack travels, is the same call
   * `ContractExceptionFilter` makes over HTTP for the same situations:
   *
   * | reason | level | `err` | why |
   * | --- | --- | --- | --- |
   * | `no-token`, `token-rejected` | `debug` | no | the 401 analogue: an anonymous caller can trigger it at will, and the client *retries* a refusal — a stack per attempt is a log-flood vector, and the error can carry the token |
   * | `user-unprovisionable` | `debug` | no | an operator problem `AuthUserService` has already logged at `error`, with the subject |
   * | `user-deactivated` | `warn` | yes | a `DomainError`: only a caller with a valid token reaches it, and the frames name the rule |
   * | `unexpected-error` | `error` | yes | a defect. Nobody can trigger it at will, and the token never travels into the calls that raise it |
   *
   * Returns rather than throws, so every call site reads `throw
   * this.rejectHandshake(…)` and the control flow is obvious to a reader and to
   * TypeScript alike.
   */
  private rejectHandshake(reason: HandshakeRejectionReason, error?: unknown): Error {
    const message = 'Refused a Socket.io handshake';
    if (reason === 'unexpected-error') {
      this.logger.error({ err: error, reason }, message);
    } else if (reason === 'user-deactivated') {
      this.logger.warn({ err: error, reason }, message);
    } else {
      this.logger.debug({ reason }, message);
    }
    return new Error(HANDSHAKE_REJECTION_MESSAGE);
  }
}
