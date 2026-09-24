import * as z from 'zod';
import { DATE_A, TIMESTAMP, UUID_B, userSummaryFixture } from '../__fixtures__/fixtures';
import type { CellLockAck, CellLockCommand, DayRoomCommand } from './commands';
import {
  CLIENT_TO_SERVER_ACK_SCHEMAS,
  CLIENT_TO_SERVER_EVENT_SCHEMAS,
  SERVER_TO_CLIENT_EVENT_SCHEMAS,
} from './event-maps';
import type { ClientToServerEvents, ServerToClientEvents } from './event-maps';
import type { CellLockedEvent, ReservationReassignedEvent } from './events';
import { roomForDate } from './rooms';

/**
 * The seven broadcasts and four commands the product needs, written out by
 * hand so that adding, renaming or losing one has to be a deliberate edit
 * here.
 */
const EXPECTED_SERVER_TO_CLIENT = [
  'cell:locked',
  'cell:unlocked',
  'reservation:cancelled',
  'reservation:created',
  'reservation:reassigned',
  'timed-reservations:updated',
  'waitlist:updated',
];

const EXPECTED_CLIENT_TO_SERVER = ['cell:lock', 'cell:unlock', 'day:subscribe', 'day:unsubscribe'];

describe('event registries', () => {
  it('registers exactly the expected server → client events', () => {
    expect(Object.keys(SERVER_TO_CLIENT_EVENT_SCHEMAS).sort()).toEqual(EXPECTED_SERVER_TO_CLIENT);
  });

  it('registers exactly the expected client → server commands', () => {
    expect(Object.keys(CLIENT_TO_SERVER_EVENT_SCHEMAS).sort()).toEqual(EXPECTED_CLIENT_TO_SERVER);
  });

  it('registers a real Zod schema for every event in both directions', () => {
    // The registries are the gateway's validation table; an entry that is not a
    // schema would be an event nothing validates.
    for (const [name, schema] of [
      ...Object.entries(SERVER_TO_CLIENT_EVENT_SCHEMAS),
      ...Object.entries(CLIENT_TO_SERVER_EVENT_SCHEMAS),
    ]) {
      expect([name, schema instanceof z.ZodType]).toEqual([name, true]);
    }
  });

  it('acknowledges only commands that exist', () => {
    for (const name of Object.keys(CLIENT_TO_SERVER_ACK_SCHEMAS)) {
      expect([name, name in CLIENT_TO_SERVER_EVENT_SCHEMAS]).toEqual([name, true]);
    }
  });

  it('names every event consistently: subject, colon, one lower-case word', () => {
    // The subject itself may be hyphenated (`timed-reservations`) when the
    // domain noun for it already is — the rule is one word *per side of the
    // colon*, not one word with no punctuation at all.
    for (const name of [
      ...Object.keys(SERVER_TO_CLIENT_EVENT_SCHEMAS),
      ...Object.keys(CLIENT_TO_SERVER_EVENT_SCHEMAS),
    ]) {
      expect([name, /^[a-z]+(?:-[a-z]+)*:[a-z]+$/.test(name)]).toEqual([name, true]);
    }
  });

  it('keeps the two directions disjoint', () => {
    // Outbound events are past participles, inbound commands imperatives, so no
    // name can mean two different things depending on which way it travels.
    const outbound = new Set<string>(Object.keys(SERVER_TO_CLIENT_EVENT_SCHEMAS));
    for (const name of Object.keys(CLIENT_TO_SERVER_EVENT_SCHEMAS)) {
      expect([name, outbound.has(name)]).toEqual([name, false]);
    }
  });
});

describe('derived event maps', () => {
  it('types a server that emits every broadcast into a day room', () => {
    // Compile-time assertion with a runtime witness: the object literal has to
    // satisfy `ServerToClientEvents`, so a registry entry whose payload type
    // drifted from its schema would not compile.
    const emitted: string[] = [];
    const handlers: ServerToClientEvents = {
      'cell:locked': (payload) => {
        // `payload` is inferred, not annotated — this is the drift check.
        const typed: CellLockedEvent = payload;
        emitted.push(`${typed.lockedBy.name}@${roomForDate(typed.date)}`);
      },
      'cell:unlocked': (payload) => emitted.push(roomForDate(payload.date)),
      'reservation:created': (payload) => emitted.push(payload.reservation.holder.name),
      'reservation:cancelled': (payload) => emitted.push(payload.reservationId),
      'reservation:reassigned': (payload) => {
        const typed: ReservationReassignedEvent = payload;
        emitted.push(typed.cause);
      },
      'timed-reservations:updated': (payload) =>
        emitted.push(String(payload.timedReservations.length)),
      'waitlist:updated': (payload) => emitted.push(String(payload.waitlistCount)),
    };

    handlers['cell:locked']({
      date: DATE_A,
      parkingSpotId: UUID_B,
      lockedBy: userSummaryFixture,
      expiresAt: TIMESTAMP,
    });
    handlers['waitlist:updated']({ date: DATE_A, parkingSpotId: UUID_B, waitlistCount: 2 });

    expect(emitted).toEqual([`${userSummaryFixture.name}@day:${DATE_A}`, '2']);
  });

  it('gives cell:lock an acknowledgement callback and the others none', () => {
    const seen: string[] = [];
    const handlers: ClientToServerEvents = {
      'day:subscribe': (payload) => {
        const typed: DayRoomCommand = payload;
        seen.push(roomForDate(typed.date));
      },
      'day:unsubscribe': (payload) => seen.push(roomForDate(payload.date)),
      'cell:lock': (payload, ack) => {
        const typed: CellLockCommand = payload;
        seen.push(typed.parkingSpotId);
        ack({ result: 'ACQUIRED', expiresAt: TIMESTAMP });
      },
      'cell:unlock': (payload) => seen.push(payload.parkingSpotId),
    };

    let ack: CellLockAck | undefined;
    handlers['cell:lock']({ date: DATE_A, parkingSpotId: UUID_B }, (result) => {
      ack = result;
    });
    handlers['day:subscribe']({ date: DATE_A });

    expect(seen).toEqual([UUID_B, `day:${DATE_A}`]);
    expect(ack).toEqual({ result: 'ACQUIRED', expiresAt: TIMESTAMP });
  });

  it('parses a payload the emit signature accepts, and vice versa', () => {
    // The registry is used twice — once to derive the handler type and once to
    // validate at runtime. This pins the two to the same schema.
    for (const [name, schema] of Object.entries(SERVER_TO_CLIENT_EVENT_SCHEMAS)) {
      expect([name, schema.safeParse({ date: DATE_A, parkingSpotId: UUID_B }).success]).toEqual([
        name,
        // `cell:unlocked` is exactly a cell reference; everything else needs more.
        name === 'cell:unlocked',
      ]);
    }
  });
});
