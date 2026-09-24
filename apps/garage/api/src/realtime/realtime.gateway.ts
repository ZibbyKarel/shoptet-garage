/**
 * The Socket.io gateway: the server half of `doc/realtime.md`.
 *
 * **What a connected socket may do** — rooms, the editing hold, and the
 * after-commit broadcast. *Who may connect* is the other responsibility, and it
 * is `realtime-handshake.ts`: it changes when authentication changes, this file
 * changes when the realtime protocol does. The two meet at
 * {@link RealtimeSocketData}, which the handshake writes and this file reads.
 *
 * `libs/garage/realtime-client` (Task 21) shipped first and holds guarantees the
 * server is responsible for honouring. Four of them are not obvious from the
 * contract and each is called out where it is implemented:
 *
 * 1. **The token is read from `socket.handshake.auth.token`, and nowhere else.**
 *    See `realtime-handshake.ts`, which holds that guarantee and
 *    `doc/decision/0060-*` with it.
 * 2. **A refusal must arrive as a CONNECT_ERROR, which means middleware.**
 *    See {@link RealtimeGateway.afterInit}.
 * 3. **`cell:lock` must be acknowledged.** See {@link RealtimeGateway.cellLock}.
 * 4. **A lapsed hold must be broadcast.** See {@link RealtimeGateway.onModuleInit}
 *    and `doc/decision/0111-*`.
 *
 * ## Every inbound payload is validated, and the validation cannot be forgotten
 *
 * `CLIENT_TO_SERVER_EVENT_SCHEMAS` is the gateway's validation table, and every
 * handler below reaches it through the single {@link RealtimeGateway.accept}
 * call — there is no second path from a socket frame to a handler body. An
 * event whose payload fails is **dropped**: no state changes, and for the one
 * acknowledged command no acknowledgement is sent, so the client's own ack
 * timeout resolves it. `realtime.gateway.spec.ts` walks the registry and
 * asserts a handler exists for every key, so a command added to the contract
 * cannot be half-implemented here.
 *
 * ## Nothing is broadcast from inside a transaction
 *
 * The gateway is never called from inside one. Reservation and waitlist facts
 * arrive through `DomainEventPublisher`, whose implementations are only ever
 * invoked after `await $transaction(...)` has resolved — see
 * `reservations/reservation-events.ts` and `realtime.publisher.ts`.
 */

import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Server } from 'socket.io';
import * as z from 'zod';
import type {
  CellLockAck,
  CellLockedEvent,
  CellUnlockedEvent,
  ClientToServerEventName,
  ClientToServerEvents,
  ServerToClientEventName,
  ServerToClientEvents,
} from '@garage/contract/realtime';
import {
  CLIENT_TO_SERVER_ACK_SCHEMAS,
  CLIENT_TO_SERVER_EVENT_SCHEMAS,
  SERVER_TO_CLIENT_EVENT_SCHEMAS,
  roomForDate,
} from '@garage/contract/realtime';
import type { DomainEvent } from '../reservations/reservation-events';
import { GracefulShutdownService } from '../shutdown/graceful-shutdown.service';
import { SpotsService } from '../spots/spots.service';
import { LockService } from './lock.service';
import { HANDSHAKE_REJECTION_MESSAGE, RealtimeHandshakeAuthenticator } from './realtime-handshake';
import type { RealtimeServerSocket, RealtimeSocketData } from './realtime-handshake';

/**
 * How many day rooms one socket may be in at once.
 *
 * The parking screen watches one day, and a client prefetching a week or a
 * month around it is well inside this. The cap exists because `day:subscribe`
 * accepts any calendar-valid date, so without one an authenticated socket could
 * ask to join millions of rooms and make the adapter's room map grow without
 * bound — the websocket path has no `ThrottlerGuard` in front of it. Refusing
 * quietly rather than erroring: a client that hits this is misbehaving, and
 * there is no contract error to tell it so with.
 */
export const MAX_DAY_ROOMS_PER_SOCKET = 64;

/**
 * Below this, `doc/decision/0110-*`'s renewal budget starts losing its
 * margin: `CELL_LOCK_RENEW_FRACTION` (0.5) fires the renewal at half the TTL,
 * and two `CELL_LOCK_ACK_TIMEOUT_MS` (5 s) attempts need to resolve before the
 * hold lapses. At 20 s that is a renewal at 10 s and two attempts landing by
 * 20 s — no margin left; below it, the second attempt can land after the
 * hold has already lapsed.
 *
 * A **warning floor, not a schema floor**: `REALTIME_LOCK_TTL_MS` stays
 * exactly as configurable as `env.ts` documents, with no environment branch —
 * every realtime spec in this workspace deliberately runs *below* this
 * number (`realtime.gateway.spec.ts` at 800 ms) so a hold's lifetime is
 * something a test can watch rather than wait 30 s for. This constant only
 * decides when {@link RealtimeGateway.onModuleInit} logs about it; it never
 * rejects the value.
 */
export const REALTIME_LOCK_TTL_WARN_FLOOR_MS = 20_000;

type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

/**
 * What a failed `safeParse` puts in the log, for all three of this file's
 * validation gates.
 *
 * One shape, because the three are the one mechanism the class comments say
 * they are — an inbound command dropped, a broadcast refused, an
 * acknowledgement refused — and an operator reading two of them should not
 * have to learn two log shapes. `path` is kept rather than only `message`: on
 * a five-key payload "Invalid input" alone does not say *which* key, and the
 * outbound gates are the ones whose failure only shows up in production.
 *
 * The issue list and nothing else — deliberately not the payload, which names
 * users and dates, and which on the inbound path is attacker-controlled input
 * on its way into a log.
 */
function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

@Injectable()
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  private readonly server!: RealtimeServer;

  constructor(
    private readonly handshake: RealtimeHandshakeAuthenticator,
    private readonly locks: LockService,
    private readonly shutdown: GracefulShutdownService,
    private readonly spots: SpotsService,
    @InjectPinoLogger(RealtimeGateway.name) private readonly logger: PinoLogger
  ) {}

  /**
   * Subscribes to lapsed holds, and warns once if the configured TTL has
   * fallen below the documented floor.
   *
   * In `onModuleInit` rather than `afterInit` so the subscription exists before
   * any socket does — a lock cannot lapse before it is taken, but a listener
   * registered on a path that also has to have run first is a listener that can
   * be missed.
   *
   * The floor check lives here rather than in `env.ts` (Task 15's review,
   * Finding 7): a schema `.min()` on `REALTIME_LOCK_TTL_MS` would reject the
   * short TTLs every realtime spec in this workspace deliberately runs at,
   * forcing exactly the environment-conditional exemption
   * `realtime-no-backdoor.spec.ts` polices against. A log line has no such
   * cost — it fires in every environment alike, including the test suites,
   * where it is simply true and harmless.
   */
  onModuleInit(): void {
    if (this.locks.ttlMs < REALTIME_LOCK_TTL_WARN_FLOOR_MS) {
      this.logger.warn(
        { REALTIME_LOCK_TTL_MS: this.locks.ttlMs, floorMs: REALTIME_LOCK_TTL_WARN_FLOOR_MS },
        'REALTIME_LOCK_TTL_MS is below the documented floor (doc/decision/0110-*): the client renewal budget may no longer fit inside the hold before it lapses'
      );
    }

    this.locks.onExpired((cell) => {
      // The whole point of `doc/decision/0111-*`: `useCellLock` puts a
      // contended cell into `held-by-other` and then sits still, so a hold that
      // lapses with nothing said leaves every other tile reading "právě
      // upravuje …" for somebody who closed their laptop.
      this.emitCellUnlocked(cell);
    });
  }

  /**
   * Installs handshake authentication, and registers the socket server's close.
   *
   * **Authentication is namespace middleware, and it has to be.** The obvious
   * alternative — accept the connection, check the token in
   * {@link handleConnection}, and `socket.disconnect()` — produces the wrong
   * wire behaviour, and the client is built around the difference:
   *
   * - `Namespace._add` calls `run()`, and a middleware that calls `next(err)`
   *   makes it emit a **CONNECT_ERROR** packet
   *   (`node_modules/socket.io/dist/namespace.js`). On the client,
   *   `Socket.onpacket`'s CONNECT_ERROR branch calls `destroy()` *before*
   *   emitting `connect_error`, which clears `subs` and leaves
   *   `socket.active === false`. `libs/garage/realtime-client` reads exactly that
   *   field to tell a refusal from a dropped transport, and answers a refusal
   *   with the bounded `REJECTED_RETRY_DELAYS_MS` policy plus a
   *   user-actionable `rejected` status.
   * - A disconnect after a *successful* connect is an ordinary transport
   *   failure. `socket.active` stays `true`, so the client would report
   *   `connecting` and retry forever against a credential the gateway has
   *   already refused — the grid silently stops updating and only a reload
   *   fixes it.
   *
   * `realtime-handshake.spec.ts` drives the hand-built `RealtimeTestClient`
   * (`testing/realtime-test-client.ts`) — not `socket.io-client`, which the
   * ESLint wrapper ban forbids in `apps/garage/api` specs as much as in its
   * source — against this server, and asserts the `CONNECT_ERROR` /
   * `socket.active === false` pair, because that claim is a property of two
   * libraries composed and not of any line here.
   */
  afterInit(server: RealtimeServer): void {
    server.use((socket, next) => {
      void this.handshake.authenticate(socket as RealtimeServerSocket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(error instanceof Error ? error : new Error(HANDSHAKE_REJECTION_MESSAGE));
        }
      );
    });

    // Socket.io does not close itself: a live WebSocket is not an "in-flight
    // request", so Nest's HTTP shutdown never touches it and the process hangs
    // until the orchestrator's kill timeout. This is the hook
    // `GracefulShutdownService`'s comment asks for by name.
    this.shutdown.registerCloser('socket.io', async () => {
      await server.close();
    });
  }

  handleConnection(client: RealtimeServerSocket): void {
    // Only reached once the middleware above has resolved a user, so `user` is
    // always set. Logged at `debug`: one line per browser tab per reconnect is
    // more than an operator wants at `info`.
    this.logger.debug({ socketId: client.id, userId: client.data.user.id }, 'Socket connected');
  }

  handleDisconnect(client: RealtimeServerSocket): void {
    // The guarantee `libs/garage/realtime-client` leans on twice: "a dropped socket
    // drops the server's lock with it" is why `useCellLock` sends no
    // `cell:unlock` across a connection gap, and why a closed tab does not
    // freeze a tile.
    for (const cell of this.locks.releaseSocket(client.id)) {
      this.emitCellUnlocked(cell);
    }
    this.logger.debug({ socketId: client.id }, 'Socket disconnected');
  }

  @SubscribeMessage('day:subscribe')
  daySubscribe(@ConnectedSocket() client: RealtimeServerSocket, @MessageBody() raw: unknown): void {
    const payload = this.accept('day:subscribe', raw);
    if (payload === null) {
      return;
    }
    const room = roomForDate(payload.date);
    if (client.rooms.has(room)) {
      return;
    }
    // `client.rooms` always contains the socket's own id room, which is why the
    // comparison is `>` against the cap plus that one.
    if (client.rooms.size > MAX_DAY_ROOMS_PER_SOCKET) {
      this.logger.warn(
        { socketId: client.id, userId: client.data.user.id, rooms: client.rooms.size },
        'Refused a day subscription: this socket is in too many rooms'
      );
      return;
    }
    void client.join(room);
  }

  @SubscribeMessage('day:unsubscribe')
  dayUnsubscribe(
    @ConnectedSocket() client: RealtimeServerSocket,
    @MessageBody() raw: unknown
  ): void {
    const payload = this.accept('day:unsubscribe', raw);
    if (payload === null) {
      return;
    }
    void client.leave(roomForDate(payload.date));
  }

  /**
   * Takes, or extends, the editing hold on one cell.
   *
   * **The return value is the acknowledgement.** Nest's `IoAdapter` calls the
   * client's ack callback with whatever a handler returns, provided it is not
   * `null`/`undefined` and carries no `event` key
   * (`@nestjs/platform-socket.io/adapters/io-adapter.js`, `bindMessageHandlers`).
   * That "not nullish" filter is what makes dropping an invalid payload also
   * mean *not acknowledging it*: `useCellLock` sends through
   * `socket.timeout(CELL_LOCK_ACK_TIMEOUT_MS)`, so a command the gateway
   * refuses to answer resolves on the client as a lost ack — one retry, then
   * `idle` — rather than as a form stuck at `requesting` forever. There is no
   * error variant in `cellLockAckSchema` to answer with instead, and inventing
   * one would be a contract change.
   *
   * The `cell:locked` broadcast excludes the asker. It already knows —
   * that is what this acknowledgement is — and a client that heard its own hold
   * as a broadcast would render "somebody else is editing" over its own open
   * form. A *second tab* of the same user is a different socket and does hear
   * it, which is correct: from that tab's point of view somebody else has the
   * cell.
   */
  @SubscribeMessage('cell:lock')
  cellLock(
    @ConnectedSocket() client: RealtimeServerSocket,
    @MessageBody() raw: unknown
  ): CellLockAck | undefined {
    const cell = this.accept('cell:lock', raw);
    if (cell === null) {
      return undefined;
    }

    const grant = this.locks.acquire(cell, { user: client.data.user, socketId: client.id });
    const expiresAt = grant.expiresAt.toISOString();

    if (grant.outcome === 'HELD_BY_OTHER') {
      return this.acknowledge({ result: 'HELD_BY_OTHER', lockedBy: grant.holder, expiresAt });
    }

    this.emitCellLocked({ ...cell, lockedBy: grant.holder, expiresAt }, client);
    return this.acknowledge({ result: 'ACQUIRED', expiresAt });
  }

  /**
   * Gives a hold back.
   *
   * No acknowledgement — the contract declares one only for `cell:lock` — so a
   * release that names a cell this connection does not hold is simply nothing
   * happening. `LockService.release` is what enforces that a client cannot drop
   * somebody else's hold; the client is documented not to try, and the server
   * does not take its word for it.
   *
   * The requester is the same `{ user, socketId }` pair `cell:lock` acquires
   * with, and passing `client.id` here is not bookkeeping: a release keyed by
   * user alone lets one of a user's connections drop the hold another of them
   * is renewing — a second tab, or a page that reloaded before this server
   * noticed the old socket. `doc/decision/0220-*`.
   */
  @SubscribeMessage('cell:unlock')
  cellUnlock(@ConnectedSocket() client: RealtimeServerSocket, @MessageBody() raw: unknown): void {
    const cell = this.accept('cell:unlock', raw);
    if (cell === null) {
      return;
    }
    if (this.locks.release(cell, { user: client.data.user, socketId: client.id })) {
      this.emitCellUnlocked(cell);
    }
  }

  /**
   * Broadcasts one committed domain fact into its day room.
   *
   * Called by `RealtimeDomainEventPublisher`, i.e. strictly after `COMMIT`.
   * A discriminated union in, so there is no `switch` and no per-event method:
   * an event added to `@garage/contract/realtime` is broadcastable here
   * without a line changing.
   */
  broadcastDomainEvent(event: DomainEvent): void {
    this.emitToDay(event.name, event.payload);
  }

  /**
   * The single gate every inbound payload passes through.
   *
   * The schema is fetched from `CLIENT_TO_SERVER_EVENT_SCHEMAS` **by lookup**,
   * not by a `switch`: a command added to the contract is validated the moment
   * it is added, and there is no second list to forget. A failure is dropped
   * and reported at `debug` with Zod's path/message list and nothing else —
   * deliberately not the payload, which names users and dates, and which is
   * attacker-controlled input on its way into a log.
   */
  private accept<K extends ClientToServerEventName>(
    event: K,
    raw: unknown
  ): z.infer<(typeof CLIENT_TO_SERVER_EVENT_SCHEMAS)[K]> | null {
    const parsed = CLIENT_TO_SERVER_EVENT_SCHEMAS[event].safeParse(raw);
    if (!parsed.success) {
      this.logger.debug(
        { event, issues: formatIssues(parsed.error) },
        'Dropped a realtime command with an invalid payload'
      );
      return null;
    }
    // `safeParse` widens to the schema's own output; the mapped-type index is
    // what the registry guarantees and what the callers rely on.
    return parsed.data as z.infer<(typeof CLIENT_TO_SERVER_EVENT_SCHEMAS)[K]>;
  }

  /**
   * Emits one server → client event into the room of its own `date`.
   *
   * The payload is validated **on the way out** as well, against the registry
   * the client parses it with. It costs a `safeParse` of a five-key object and
   * it turns "the gateway broadcast something the contract does not describe"
   * from a defect every connected browser discovers — `useRealtimeEvent` drops
   * an unparseable payload silently — into a server-side `error` line naming
   * the event. It is on in every environment for that reason: the failure it
   * catches is exactly the one that only shows up in production.
   *
   * A failure is dropped, never thrown: this runs on the request's way out,
   * after `COMMIT`, and a broadcast that throws must not turn a successful
   * cancellation into an error the user sees (`reservation-events.ts`).
   */
  private emitToDay(
    event: ServerToClientEventName,
    payload: { readonly date: string; readonly parkingSpotId: string },
    except?: RealtimeServerSocket
  ): void {
    const schema: z.ZodType = SERVER_TO_CLIENT_EVENT_SCHEMAS[event];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.error(
        { event, issues: formatIssues(parsed.error) },
        'Refused to broadcast a payload the contract does not describe'
      );
      return;
    }
    if (this.server === undefined) {
      // Only reachable if a lock lapsed before the gateway was initialised,
      // which needs a socket that cannot have existed. Guarded rather than
      // asserted because the alternative is a `TypeError` on a timer callback.
      return;
    }

    const room = roomForDate(payload.date);
    if (this.spots.isHidden(payload.parkingSpotId)) {
      this.emitToAdminsIn(room, event, parsed.data, except);
      return;
    }
    // `emit` is typed per event name by `ServerToClientEvents`; this function is
    // deliberately the one place that is not, because it is the *shared*
    // machinery — validation, room derivation, the never-throw guarantee —
    // behind the typed wrappers below. Those wrappers are what callers use, and
    // they pin the payload to the contract's own inferred type.
    const target = except === undefined ? this.server.to(room) : except.to(room);
    (target.emit as (name: string, data: unknown) => void)(event, parsed.data);
  }

  /**
   * A hidden spot's traffic, to the admins in the room only
   * (`doc/decision/0316-hidden-spots-are-seen-and-booked-by-admins-only`) —
   * a normal user must not learn from a broadcast who holds, queues for or is
   * editing a spot the lot does not show them.
   *
   * ponytail: walks this process's own sockets in the room, which is every
   * socket on the single instance this app targets. Behind a multi-node
   * adapter this becomes a role room joined at connection plus
   * `server.to(room).except(nonAdminRoom)`.
   */
  private emitToAdminsIn(
    room: string,
    event: ServerToClientEventName,
    data: unknown,
    except?: RealtimeServerSocket
  ): void {
    for (const socketId of this.server.sockets.adapter.rooms.get(room) ?? []) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (socket !== undefined && socketId !== except?.id && socket.data.role === 'ADMIN') {
        (socket.emit as (name: string, data: unknown) => void)(event, data);
      }
    }
  }

  /**
   * Validates an acknowledgement on the way out, the way a broadcast is.
   *
   * **This is not belt-and-braces, it is the belt.** `cellLockAckSchema` is a
   * closed shape and Zod strips what it does not declare, so `lockedBy` leaves
   * this server as `userSummarySchema`'s three-field pick and nothing else —
   * regardless of what shape the `UserSummary` handed to `LockService` actually
   * had. The ack crosses to *another user's* browser, and `userSchema` next to
   * it carries `email`, `oktaId` and `icsToken`, the secret in a personal
   * calendar-feed URL.
   *
   * A spec caught this: with a Prisma stand-in whose `select` is not honoured,
   * the acknowledgement carried the whole user row. The broadcast on the same
   * path was already safe, because {@link emitToDay} validates — which is what
   * made the asymmetry visible and is the reason the ack now goes through the
   * same gate.
   *
   * `realtime-handshake.ts`'s `loadUserSummary` *also* narrows to three
   * fields, which made this gate unfalsifiable for a while: deleting it failed
   * no test, because nothing could produce a fat holder any more.
   * `realtime-ack-leak.spec.ts` restores the ability to fail — it
   * substitutes a `LockService` whose grant carries the whole row, which is
   * exactly the shape a dropped `select` produces.
   *
   * A payload the contract refuses is dropped rather than sent: the client's
   * `parseAck` would refuse it anyway, and an unacknowledged `cell:lock`
   * resolves there as a lost ack rather than as a corrupt one.
   */
  private acknowledge(ack: CellLockAck): CellLockAck | undefined {
    const parsed = CLIENT_TO_SERVER_ACK_SCHEMAS['cell:lock'].safeParse(ack);
    if (!parsed.success) {
      this.logger.error(
        { issues: formatIssues(parsed.error) },
        'Refused to acknowledge cell:lock with a payload the contract does not describe'
      );
      return undefined;
    }
    return parsed.data;
  }

  /**
   * Typed façades over {@link emitToDay}.
   *
   * They exist so that a caller cannot pair `'cell:locked'` with a
   * `cell:unlocked` payload: `CellLockedEvent` and `CellUnlockedEvent` are the
   * contract's own `z.infer` types, so these signatures change the moment the
   * schemas do.
   */
  private emitCellLocked(payload: CellLockedEvent, except: RealtimeServerSocket): void {
    this.emitToDay('cell:locked', payload, except);
  }

  private emitCellUnlocked(payload: CellUnlockedEvent): void {
    this.emitToDay('cell:unlocked', payload);
  }
}
