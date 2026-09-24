/**
 * Rooms, the editing hold, and what reaches whose browser — over real
 * WebSockets, against the assembled application.
 *
 * The suite runs against a **short** `REALTIME_LOCK_TTL_MS` so that a hold
 * lapsing is something a test can watch rather than something it has to
 * believe. That is a value, not a branch: `apps/garage/api/src/realtime/**` contains no
 * `NODE_ENV` check and no test flag, and `realtime-no-backdoor.spec.ts` asserts
 * it stays that way.
 *
 * Every test uses its **own cell**, and every wait matches on the payload as
 * well as the event name: with a sub-second TTL the server is legitimately
 * emitting `cell:unlocked` for cells earlier tests abandoned, and an assertion
 * that accepted any of them would pass for the wrong reason.
 */

import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import type { Server } from 'socket.io';
import {
  CLIENT_TO_SERVER_EVENT_SCHEMAS,
  SERVER_TO_CLIENT_EVENT_SCHEMAS,
  roomForDate,
} from '@garage/contract/realtime';
import type { CellLockAck } from '@garage/contract/realtime';
import {
  CompositeDomainEventPublisher,
  DOMAIN_EVENT_PUBLISHERS,
} from '../reservations/composite-domain-event.publisher';
import { DomainEventPublisher } from '../reservations/reservation-events';
import { GracefulShutdownService } from '../shutdown/graceful-shutdown.service';
import { RealtimeDomainEventPublisher } from './realtime.publisher';
import { MAX_DAY_ROOMS_PER_SOCKET, RealtimeGateway } from './realtime.gateway';
import { RealtimeTestClient } from './testing/realtime-test-client';
import type { RealtimeTestApp } from './testing/realtime-test-app';
import { seedEmployee, startRealtimeTestApp } from './testing/realtime-test-app';
import { SpotsService } from '../spots/spots.service';

const LOCK_TTL_MS = 800;
const DAY = '2026-09-15';
const OTHER_DAY = '2026-09-16';

interface Employee {
  id: string;
  name: string;
  licensePlate: string | null;
  oktaId: string;
}

describe('the realtime gateway', () => {
  let harness: RealtimeTestApp;
  let alice: Employee;
  let bob: Employee;
  let carol: Employee;
  let dave: Employee;
  const open: RealtimeTestClient[] = [];
  const originalEnv = { ...process.env };

  /** A cell no other test in this file touches. */
  function freshCell(date = DAY): { date: string; parkingSpotId: string } {
    return { date, parkingSpotId: randomUUID() };
  }

  async function connectAs(employee: Employee): Promise<RealtimeTestClient> {
    const client = await RealtimeTestClient.connect({
      baseUrl: harness.baseUrl,
      token: harness.tokenFor({ subject: employee.oktaId }),
    });
    expect(client.isConnected).toBe(true);
    open.push(client);
    return client;
  }

  /**
   * The `socket.io` `Server` the gateway is holding.
   *
   * Reached through the gateway's `@WebSocketServer()` field rather than
   * through a getter added to production code for the tests' benefit. It is
   * used only to *observe* — room membership — never to drive anything: every
   * command in this file travels over a real socket.
   */
  function ioServer(): Server {
    return (harness.app.get(RealtimeGateway) as unknown as { server: Server }).server;
  }

  /** How many sockets the server has in a day's room. */
  function roomSize(date: string): number {
    return ioServer().sockets.adapter.rooms.get(roomForDate(date))?.size ?? 0;
  }

  /**
   * Joins a day room and waits until the server has actually put the socket in
   * it.
   *
   * `day:subscribe` has no acknowledgement — the contract declares one only for
   * `cell:lock` — so a test that emitted and then immediately broadcast would
   * race the join and fail for a reason that has nothing to do with its claim.
   * Reading the server's own room map is reading its answer, rather than
   * sleeping on a guess.
   */
  async function watch(client: RealtimeTestClient, date: string): Promise<void> {
    const before = roomSize(date);
    client.emit('day:subscribe', { date });
    await waitFor(() => roomSize(date) > before, `a socket to join ${roomForDate(date)}`);
  }

  async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    harness = await startRealtimeTestApp({ lockTtlMs: LOCK_TTL_MS });
    alice = seedEmployee(harness.double, {
      oktaId: 'okta-alice',
      name: 'Alice',
      licensePlate: '1AB 2345',
    });
    bob = seedEmployee(harness.double, { oktaId: 'okta-bob', name: 'Bob' });
    carol = seedEmployee(harness.double, { oktaId: 'okta-carol', name: 'Carol', role: 'ADMIN' });
    dave = seedEmployee(harness.double, { oktaId: 'okta-dave', name: 'Dave', role: 'ADMIN' });
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((client) => client.disconnect()));
  });

  afterAll(async () => {
    await harness?.close();
    process.env = originalEnv;
  });

  describe('day rooms', () => {
    it('delivers a broadcast to a client that subscribed to that day', async () => {
      const client = await connectAs(alice);
      const cell = freshCell();
      await watch(client, DAY);

      publish('waitlist:updated', { ...cell, waitlistCount: 3 });

      await expect(
        client.waitForEvent(
          'waitlist:updated',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toEqual({ ...cell, waitlistCount: 3 });
    });

    it('delivers nothing to a client watching a different day', async () => {
      // The negative half, and the one that makes the positive half mean
      // something: a gateway that broadcast to every socket would pass the test
      // above and fail this one.
      const watcher = await connectAs(alice);
      const bystander = await connectAs(bob);
      const cell = freshCell();
      await watch(watcher, DAY);
      await watch(bystander, OTHER_DAY);

      publish('waitlist:updated', { ...cell, waitlistCount: 1 });

      await watcher.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(bystander.received.filter((event) => event.name === 'waitlist:updated')).toHaveLength(
        0
      );
    });

    it('delivers nothing to a client that subscribed to nothing', async () => {
      const watcher = await connectAs(alice);
      const silent = await connectAs(bob);
      const cell = freshCell();
      await watch(watcher, DAY);

      publish('waitlist:updated', { ...cell, waitlistCount: 1 });

      await watcher.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(silent.received).toHaveLength(0);
    });

    it('stops delivering after day:unsubscribe', async () => {
      const client = await connectAs(alice);
      const keptWatching = await connectAs(bob);
      await watch(client, DAY);
      await watch(keptWatching, DAY);

      client.emit('day:unsubscribe', { date: DAY });
      // Wait for the leave to be visible on the server before broadcasting.
      await settle();
      const cell = freshCell();
      publish('waitlist:updated', { ...cell, waitlistCount: 9 });

      await keptWatching.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(client.received.filter((event) => event.name === 'waitlist:updated')).toHaveLength(0);
    });

    it('caps how many day rooms one socket may join', async () => {
      const client = await connectAs(alice);
      // One more than the cap, all valid dates.
      for (let index = 0; index <= MAX_DAY_ROOMS_PER_SOCKET; index += 1) {
        const day = new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10);
        client.emit('day:subscribe', { date: day });
      }
      await settle();

      // `client.rooms` also holds the socket's own id room, so the ceiling is
      // the cap plus that one. `toBe`, not `toBeLessThanOrEqual`: a gateway
      // that joined no rooms at all would also satisfy the looser assertion.
      expect(socketRoomCount(client)).toBe(MAX_DAY_ROOMS_PER_SOCKET + 1);
    });
  });

  describe('a hidden spot', () => {
    /** A spot hidden the way an admin hides one, so the gateway's view is current. */
    async function hiddenCell(): Promise<{ date: string; parkingSpotId: string }> {
      const spot = harness.double.seedSpot({ label: `HIDDEN-${randomUUID().slice(0, 8)}` });
      await harness.app.get(SpotsService).update({ id: spot.id, hidden: true }, carol.id);
      return { date: DAY, parkingSpotId: spot.id };
    }

    it('broadcasts its domain events to admins in the room and to nobody else', async () => {
      const admin = await connectAs(carol);
      const user = await connectAs(alice);
      await watch(admin, DAY);
      await watch(user, DAY);
      const cell = await hiddenCell();

      publish('waitlist:updated', { ...cell, waitlistCount: 2 });

      await expect(
        admin.waitForEvent(
          'waitlist:updated',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toEqual({ ...cell, waitlistCount: 2 });
      await settle();
      expect(
        user.received.filter(
          (event) =>
            (event.payload as { parkingSpotId?: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it('tells another admin, and no normal user, that an admin is editing it', async () => {
      const editor = await connectAs(carol);
      const otherAdmin = await connectAs(dave);
      const user = await connectAs(alice);
      await watch(otherAdmin, DAY);
      await watch(user, DAY);
      const cell = await hiddenCell();

      await expect(editor.emitWithAck('cell:lock', cell)).resolves.toMatchObject({
        result: 'ACQUIRED',
      });

      await otherAdmin.waitForEvent(
        'cell:locked',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      await settle();
      expect(
        user.received.filter(
          (event) =>
            (event.payload as { parkingSpotId?: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it("refuses a normal user's cell:lock on a hidden spot, but still lets an admin take it", async () => {
      const user = await connectAs(alice);
      const admin = await connectAs(carol);
      const cell = await hiddenCell();

      // No ack at all — the same silent drop as an invalid payload, so the
      // caller learns nothing: not that the spot exists, and not who holds
      // it.
      await expect(user.emitWithAck('cell:lock', cell, 400)).rejects.toThrow(/No acknowledgement/);
      expect(user.received.filter((event) => event.name === 'cell:locked')).toHaveLength(0);

      // The refusal did not take the lock: an admin can still acquire it.
      await expect(admin.emitWithAck('cell:lock', cell)).resolves.toMatchObject({
        result: 'ACQUIRED',
      });
    });

    it('broadcasts its unlock to admins in the room and to nobody else', async () => {
      const editor = await connectAs(carol);
      const otherAdmin = await connectAs(dave);
      const user = await connectAs(alice);
      await watch(otherAdmin, DAY);
      await watch(user, DAY);
      const cell = await hiddenCell();

      await editor.emitWithAck('cell:lock', cell);
      editor.emit('cell:unlock', cell);

      await otherAdmin.waitForEvent(
        'cell:unlocked',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      await settle();
      expect(
        user.received.filter(
          (event) =>
            (event.payload as { parkingSpotId?: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it('still reaches everybody once it is unhidden', async () => {
      const user = await connectAs(alice);
      await watch(user, DAY);
      const cell = await hiddenCell();
      await harness.app
        .get(SpotsService)
        .update({ id: cell.parkingSpotId, hidden: false }, carol.id);

      publish('waitlist:updated', { ...cell, waitlistCount: 1 });

      await expect(
        user.waitForEvent(
          'waitlist:updated',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toEqual({ ...cell, waitlistCount: 1 });
    });
  });

  describe('an invalid inbound payload', () => {
    it('does not join a room when the date is not a date', async () => {
      const client = await connectAs(alice);
      const watcher = await connectAs(bob);
      await watch(watcher, DAY);

      client.emit('day:subscribe', { date: 'tomorrow' });
      await settle();
      const cell = freshCell();
      publish('waitlist:updated', { ...cell, waitlistCount: 1 });

      await watcher.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(client.received).toHaveLength(0);
    });

    it('rejects a stray key, because dayRoomCommandSchema is strict', async () => {
      const client = await connectAs(alice);
      const watcher = await connectAs(bob);
      await watch(watcher, DAY);

      // `strictObject`, deliberately: a stray key is a client that disagrees
      // with the contract about what a subscription is, and stripping it would
      // hide the disagreement.
      client.emit('day:subscribe', { date: DAY, sneaky: true });
      await settle();
      const cell = freshCell();
      publish('waitlist:updated', { ...cell, waitlistCount: 1 });

      await watcher.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(client.received).toHaveLength(0);
    });

    it('does not acknowledge a cell:lock the contract refuses', async () => {
      const client = await connectAs(alice);

      // No error acknowledgement exists in `cellLockAckSchema`, so the honest
      // answer is silence — which the client's own `socket.timeout()` turns
      // into one retry and then `idle`, rather than a form stuck at
      // "requesting" forever.
      await expect(
        client.emitWithAck('cell:lock', { date: DAY, parkingSpotId: 'not-a-uuid' }, 400)
      ).rejects.toThrow(/No acknowledgement/);
    });

    it('does not take a hold when the payload is refused', async () => {
      const client = await connectAs(alice);
      const other = await connectAs(bob);
      const cell = freshCell();

      await expect(client.emitWithAck('cell:lock', { ...cell, extra: 1 }, 400)).rejects.toThrow(
        /No acknowledgement/
      );

      // The cell must still be free.
      const ack = (await other.emitWithAck('cell:lock', cell)) as CellLockAck;
      expect(ack.result).toBe('ACQUIRED');
    });

    it('every command in the contract has a handler, so none can be half-implemented', () => {
      // The registry is the gateway's validation table, and `accept()` is the
      // only path from a frame to a handler body — so validation cannot be
      // forgotten for a command that *has* a handler. What can be forgotten is
      // the handler: a command added to the contract with no
      // `@SubscribeMessage` is silently ignored, which on the wire is
      // indistinguishable from "validated and dropped".
      //
      // `MESSAGE_METADATA` is read from `@nestjs/websockets`' own constant and
      // off the method function, which is where the decorator puts it
      // (`decorators/subscribe-message.decorator.js`), rather than off a name
      // this file guesses.
      const prototype = Object.getPrototypeOf(harness.app.get(RealtimeGateway)) as Record<
        string,
        unknown
      >;
      const subscribed = Object.getOwnPropertyNames(prototype)
        // `@WebSocketServer()` puts a `null` on the prototype, and
        // `Reflect.getMetadata` throws on a non-object target.
        .filter((key) => typeof prototype[key] === 'function')
        .map((key) => Reflect.getMetadata(MESSAGE_METADATA, prototype[key] as object) as unknown)
        .filter((value): value is string => typeof value === 'string');

      expect(subscribed.sort()).toEqual(Object.keys(CLIENT_TO_SERVER_EVENT_SCHEMAS).sort());
    });
  });

  describe('the cell lock', () => {
    it('acknowledges the first asker with a deadline one TTL out', async () => {
      const client = await connectAs(alice);
      const cell = freshCell();
      const before = Date.now();

      const ack = (await client.emitWithAck('cell:lock', cell)) as CellLockAck;

      expect(ack.result).toBe('ACQUIRED');
      const expiresAt = Date.parse(ack.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + LOCK_TTL_MS);
      expect(expiresAt).toBeLessThan(before + LOCK_TTL_MS + 2000);
    });

    it('tells the second asker who has it, with the plate the tile renders', async () => {
      const holder = await connectAs(alice);
      const rival = await connectAs(bob);
      const cell = freshCell();
      await holder.emitWithAck('cell:lock', cell);

      const ack = (await rival.emitWithAck('cell:lock', cell)) as CellLockAck;

      expect(ack).toMatchObject({
        result: 'HELD_BY_OTHER',
        lockedBy: { id: alice.id, name: 'Alice', licensePlate: '1AB 2345' },
      });
    });

    it('never puts a secret in the lockedBy of an acknowledgement', async () => {
      // This test found a real gap. `userSummarySchema` is a three-field pick
      // precisely because this payload crosses to *another user's* browser, and
      // the row next to it carries `email`, `oktaId` and `icsToken` — the secret
      // in a personal calendar-feed URL. The broadcast path was already safe
      // (it validates outbound); the acknowledgement path was not, and now is.
      const holder = await connectAs(alice);
      const rival = await connectAs(bob);
      const cell = freshCell();
      await holder.emitWithAck('cell:lock', cell);

      const ack = (await rival.emitWithAck('cell:lock', cell)) as CellLockAck;

      expect(Object.keys((ack as { lockedBy: object }).lockedBy).sort()).toEqual([
        'id',
        'licensePlate',
        'name',
      ]);
      expect(JSON.stringify(ack)).not.toContain('icsToken');
    });

    it('never puts a secret in the lockedBy of a broadcast either', async () => {
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);

      await holder.emitWithAck('cell:lock', cell);

      const payload = (await neighbour.waitForEvent(
        'cell:locked',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      )) as { lockedBy: object };
      expect(Object.keys(payload.lockedBy).sort()).toEqual(['id', 'licensePlate', 'name']);
      expect(Object.keys(payload).sort()).toEqual([
        'date',
        'expiresAt',
        'lockedBy',
        'parkingSpotId',
      ]);
    });

    it('extends the hold when its own holder asks again', async () => {
      const client = await connectAs(alice);
      const cell = freshCell();
      const first = (await client.emitWithAck('cell:lock', cell)) as CellLockAck;
      await new Promise((resolve) => setTimeout(resolve, LOCK_TTL_MS / 2));

      const renewed = (await client.emitWithAck('cell:lock', cell)) as CellLockAck;

      expect(renewed.result).toBe('ACQUIRED');
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    });

    it('tells the rest of the day room, but not the holder', async () => {
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(holder, DAY);
      await watch(neighbour, DAY);

      await holder.emitWithAck('cell:lock', cell);

      await expect(
        neighbour.waitForEvent(
          'cell:locked',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toMatchObject({ ...cell, lockedBy: { id: alice.id } });
      // The holder already knows — that is what the acknowledgement is. A
      // client that heard its own hold as a broadcast would render "somebody
      // else is editing" over its own open form.
      expect(
        holder.received.filter(
          (event) =>
            event.name === 'cell:locked' &&
            (event.payload as { parkingSpotId: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it('announces a release to the room', async () => {
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await holder.emitWithAck('cell:lock', cell);

      holder.emit('cell:unlock', cell);

      await expect(
        neighbour.waitForEvent(
          'cell:unlocked',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toEqual(cell);
    });

    it('refuses to let one user release another’s hold', async () => {
      const holder = await connectAs(alice);
      const rival = await connectAs(bob);
      const cell = freshCell();
      await holder.emitWithAck('cell:lock', cell);

      rival.emit('cell:unlock', cell);
      await settle();

      const ack = (await rival.emitWithAck('cell:lock', cell)) as CellLockAck;
      expect(ack.result).toBe('HELD_BY_OTHER');
    });

    it('refuses to let one connection release the hold its user re-took on another', async () => {
      // One user, two live connections on one cell — a second tab, or a page
      // that reloaded before this server noticed the old socket. The second
      // `cell:lock` is a renewal and re-keys the hold onto `second`.
      const first = await connectAs(alice);
      const second = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await first.emitWithAck('cell:lock', cell);
      await second.emitWithAck('cell:lock', cell);

      first.emit('cell:unlock', cell);
      await settle();

      // Nothing was announced, so no other tile went back to `Volné`…
      expect(
        neighbour.received.filter(
          (event) =>
            event.name === 'cell:unlocked' &&
            (event.payload as { parkingSpotId: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
      // …and the hold is genuinely still held, not merely unannounced.
      const ack = (await neighbour.emitWithAck('cell:lock', cell)) as CellLockAck;
      expect(ack.result).toBe('HELD_BY_OTHER');
    });

    it('still lets the newest connection of a user drop a hold their older tab is showing', async () => {
      // **This documents a hazard that is open, not one that is closed**, and it
      // is the exact counterpart of the test above.
      //
      // `release` matching `(user, socketId)` stops a *superseded* connection
      // dropping the current hold. It cannot stop the reverse, because
      // `acquire` is keyed by user by design (that is what makes a reconnect a
      // renewal): the second tab's `cell:lock` re-keys the hold onto itself, so
      // when *it* unlocks, it is the recorded owner and the release is
      // legitimate — while the first tab's dialog is still open and still says
      // `held`.
      //
      // The window is bounded by the renewal heartbeat, not by anything here:
      // `CELL_LOCK_RENEW_FRACTION` is 0.5, so the older tab re-takes the cell
      // within half a TTL (~15 s at the shipped 30 s). Closing it properly
      // means changing how a hold is *acquired*, which is a product decision
      // about what a courtesy lock means across a user's own tabs — see
      // `doc/decision/0220-*` §"What it costs" and `doc/realtime.md`.
      const older = await connectAs(alice);
      const newer = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await older.emitWithAck('cell:lock', cell);
      await newer.emitWithAck('cell:lock', cell);

      newer.emit('cell:unlock', cell);
      await settle();

      // The room is told the bay is free…
      expect(
        neighbour.received.filter(
          (event) =>
            event.name === 'cell:unlocked' &&
            (event.payload as { parkingSpotId: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(1);
      // …and it really is, to somebody else, while `older` still has its form open.
      const ack = (await neighbour.emitWithAck('cell:lock', cell)) as CellLockAck;
      expect(ack.result).toBe('ACQUIRED');
    });
  });

  describe('a hold that nobody gives back', () => {
    it('is broadcast as cell:unlocked when it lapses', async () => {
      // The failure this test exists for: `useCellLock` puts a contended cell
      // into `held-by-other` and then **sits still** — it deliberately does not
      // poll. Without this broadcast, a user who closes their laptop mid-edit
      // leaves "právě upravuje …" on every other tile until the page is
      // reloaded. It was parked at Task 21 to be confirmed here.
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await holder.emitWithAck('cell:lock', cell);

      await expect(
        neighbour.waitForEvent(
          'cell:unlocked',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        )
      ).resolves.toEqual(cell);
    });

    it('is actually free afterwards, not merely announced', async () => {
      const holder = await connectAs(alice);
      const rival = await connectAs(bob);
      const cell = freshCell();
      await holder.emitWithAck('cell:lock', cell);

      await new Promise((resolve) => setTimeout(resolve, LOCK_TTL_MS + 200));

      const ack = (await rival.emitWithAck('cell:lock', cell)) as CellLockAck;
      expect(ack.result).toBe('ACQUIRED');
    });

    it('is not announced early', async () => {
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await holder.emitWithAck('cell:lock', cell);

      await new Promise((resolve) => setTimeout(resolve, LOCK_TTL_MS / 2));

      expect(
        neighbour.received.filter(
          (event) =>
            event.name === 'cell:unlocked' &&
            (event.payload as { parkingSpotId: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it('is released, and announced, when the holder’s socket drops', async () => {
      // The other half of the same guarantee, and the one `useCellLock` relies
      // on when it sends no `cell:unlock` across a connection gap.
      //
      // This test used to pass on the *wrong* mechanism: at `LOCK_TTL_MS =
      // 800`, well inside `waitForEvent`'s 5 s budget, the hold lapses on its
      // own regardless of whether `handleDisconnect` frees anything, so
      // mutating `releaseSocket(client.id)` into a no-op (a dropped socket
      // frees nothing) failed **zero** tests here — the same "passes on a
      // defence other than the one it names" shape as the ack-leak gate. The
      // elapsed-time assertion below is what makes the two mechanisms
      // distinguishable: a disconnect-triggered release is one WebSocket round
      // trip, not a wait for the TTL to lapse.
      const holder = await connectAs(alice);
      const neighbour = await connectAs(bob);
      const cell = freshCell();
      await watch(neighbour, DAY);
      await holder.emitWithAck('cell:lock', cell);

      const before = Date.now();
      await holder.disconnect();

      const payload = await neighbour.waitForEvent(
        'cell:unlocked',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      const elapsed = Date.now() - before;

      expect(payload).toEqual(cell);
      // Comfortably below `LOCK_TTL_MS` (800 ms): a real disconnect release
      // arrives in tens of milliseconds, while a hold that only lapsed on its
      // own would not be visible until close to the full TTL.
      expect(elapsed).toBeLessThan(LOCK_TTL_MS / 2);
    });
  });

  describe('the after-commit publisher', () => {
    it('reaches the realtime publisher in the assembled application', () => {
      // Task 13 bound this token to `NoopDomainEventPublisher` and said Task 15
      // would swap it. Without this assertion every broadcast test in this file
      // could pass while the reservation services still published into a void.
      //
      // Since Task 16 the seam is a composite (Socket.io *and* Slack both
      // implement it), so "is the realtime publisher" is now "fans out to the
      // realtime publisher" — and specifically to the instance `RealtimeModule`
      // built, the one holding this app's gateway. A second instance would
      // resolve here and broadcast into a gateway nobody is connected to.
      const bound = harness.app.get(DomainEventPublisher);
      const delegates = harness.app.get<readonly DomainEventPublisher[]>(DOMAIN_EVENT_PUBLISHERS);

      expect(bound).toBeInstanceOf(CompositeDomainEventPublisher);
      expect(delegates).toContain(harness.app.get(RealtimeDomainEventPublisher));
    });

    it('delivers a committed reservation into its day room and no other', async () => {
      const watcher = await connectAs(alice);
      const bystander = await connectAs(bob);
      await watch(watcher, DAY);
      await watch(bystander, OTHER_DAY);
      const cell = freshCell();

      harness.app.get(DomainEventPublisher).publish([
        {
          name: 'reservation:created',
          payload: {
            ...cell,
            reservation: {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              holder: { kind: 'USER', userId: alice.id, name: 'Alice', licensePlate: '1AB 2345' },
            },
          },
        },
      ]);

      await watcher.waitForEvent(
        'reservation:created',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      expect(bystander.received.filter((e) => e.name === 'reservation:created')).toHaveLength(0);
    });

    it('publishes each event of a batch independently', async () => {
      const watcher = await connectAs(alice);
      await watch(watcher, DAY);
      const cell = freshCell();

      harness.app.get(DomainEventPublisher).publish([
        { name: 'reservation:cancelled', payload: { ...cell, reservationId: randomUUID() } },
        { name: 'waitlist:updated', payload: { ...cell, waitlistCount: 0 } },
      ]);

      await watcher.waitForEvent(
        'reservation:cancelled',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
      await watcher.waitForEvent(
        'waitlist:updated',
        (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
      );
    });

    it('refuses to broadcast a payload the contract does not describe', async () => {
      const watcher = await connectAs(alice);
      await watch(watcher, DAY);
      const cell = freshCell();

      harness.app.get(DomainEventPublisher).publish([
        // A `waitlistCount` the schema forbids. Reaching a browser, this would
        // be dropped silently by `useRealtimeEvent`; here it must not leave the
        // server at all.
        { name: 'waitlist:updated', payload: { ...cell, waitlistCount: -1 } } as never,
      ]);
      await settle();

      expect(
        watcher.received.filter(
          (event) =>
            (event.payload as { parkingSpotId?: string }).parkingSpotId === cell.parkingSpotId
        )
      ).toHaveLength(0);
    });

    it('never throws, and still publishes the rest of the batch, when the gateway raises', async () => {
      // `reservation-events.ts`: a failure to broadcast must never turn a
      // successful cancellation into an error the user sees.
      //
      // The gateway is made to raise rather than fed a payload that *ought* to
      // make it raise. The first version of this test passed a malformed date
      // on the theory that `roomForDate`'s `assertDateOnly` would throw — it
      // does, but `emitToDay` validates the payload *before* it builds the
      // room, so the publisher's `catch` was never entered and the test would
      // have passed with the `try` deleted. Mutating the publisher to rethrow
      // failed **zero** tests; it now fails this one. A double stands in here
      // for a dependency's behaviour, not for a protocol or an error shape.
      const watcher = await connectAs(alice);
      await watch(watcher, DAY);
      const cell = freshCell();
      const gateway = harness.app.get(RealtimeGateway);
      const broadcast = jest.spyOn(gateway, 'broadcastDomainEvent').mockImplementationOnce(() => {
        throw new Error('the gateway is broken');
      });

      try {
        expect(() =>
          harness.app.get(DomainEventPublisher).publish([
            { name: 'reservation:cancelled', payload: { ...cell, reservationId: randomUUID() } },
            { name: 'waitlist:updated', payload: { ...cell, waitlistCount: 0 } },
          ])
        ).not.toThrow();

        // The loop is per event on purpose: one broadcast failing must not take
        // the other fact about the same cell down with it.
        await watcher.waitForEvent(
          'waitlist:updated',
          (p: { parkingSpotId: string }) => p.parkingSpotId === cell.parkingSpotId
        );
      } finally {
        broadcast.mockRestore();
      }
    });
  });

  describe('graceful shutdown', () => {
    it('registers the socket server’s close under the name the shutdown service documents', () => {
      // Socket.io does not close itself: a live WebSocket is not an in-flight
      // request, so without this the process hangs until the orchestrator's
      // kill timeout.
      expect(harness.app.get(GracefulShutdownService).registeredClosers()).toContain('socket.io');
    });
  });

  /** Publishes through the real seam, which is what the services use. */
  function publish(name: string, payload: unknown): void {
    harness.app.get(DomainEventPublisher).publish([{ name, payload } as never]);
  }

  /** Every room the server has this client's socket in, its own id room included. */
  function socketRoomCount(client: RealtimeTestClient): number {
    const socket = ioServer().sockets.sockets.get(client.socketId ?? '');
    if (socket === undefined) {
      throw new Error('The server does not know this socket');
    }
    return socket.rooms.size;
  }

  /**
   * A window for a fire-and-forget emit to have been processed.
   *
   * Used only where the claim is a **negative** one ("this did not happen"),
   * and every such test pairs it with a positive assertion on another client —
   * so a window that was too short would fail the positive half first rather
   * than passing the negative one by accident.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

describe('the contract registries', () => {
  it('cover every event the gateway can emit', () => {
    // A payload validated on the way out needs a schema to validate against;
    // this is the assertion that the registry the gateway indexes is the one
    // the client parses with.
    expect(Object.keys(SERVER_TO_CLIENT_EVENT_SCHEMAS).sort()).toEqual([
      'cell:locked',
      'cell:unlocked',
      'reservation:cancelled',
      'reservation:created',
      'reservation:reassigned',
      'timed-reservations:updated',
      'waitlist:updated',
    ]);
  });
});
