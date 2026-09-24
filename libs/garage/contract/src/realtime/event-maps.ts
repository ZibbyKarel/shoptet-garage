/**
 * The two Socket.io event maps, plus the schema registries they are derived
 * from.
 *
 * Socket.io types a connection as `Server<ClientToServerEvents,
 * ServerToClientEvents>` (and, on the client, the two reversed), where each map
 * is an object whose values are **function types** — `(payload) => void`. A
 * function type is not something Zod can describe, so the maps below are the
 * one place in the contract that is not itself a schema.
 *
 * They are still not hand-written. Each map is a **mapped type over a registry
 * of Zod schemas**, so every payload type is a `z.infer` (global constraint 1)
 * and the two artefacts cannot drift: adding an event means adding one line to
 * a registry, and both the runtime validation table and the compile-time
 * handler signature follow from it. Registering an event and forgetting to
 * validate it is not expressible.
 */

import type * as z from 'zod';
import { cellLockAckSchema, cellLockCommandSchema, dayRoomCommandSchema } from './commands';
import {
  cellLockedEventSchema,
  cellUnlockedEventSchema,
  reservationCancelledEventSchema,
  reservationCreatedEventSchema,
  reservationReassignedEventSchema,
  timedReservationsUpdatedEventSchema,
  waitlistUpdatedEventSchema,
} from './events';

/**
 * Every server → client event, with the schema of its payload.
 *
 * Runtime value, not just a type: Task 15 can validate what it is about to
 * broadcast in development, and a test can assert the two maps are exhaustive.
 */
export const SERVER_TO_CLIENT_EVENT_SCHEMAS = {
  'cell:locked': cellLockedEventSchema,
  'cell:unlocked': cellUnlockedEventSchema,
  'reservation:created': reservationCreatedEventSchema,
  'reservation:cancelled': reservationCancelledEventSchema,
  'reservation:reassigned': reservationReassignedEventSchema,
  'timed-reservations:updated': timedReservationsUpdatedEventSchema,
  'waitlist:updated': waitlistUpdatedEventSchema,
} as const;

/**
 * Every client → server command, with the schema of its payload.
 *
 * **This is the gateway's validation table.** Task 15 looks the inbound event
 * name up here and `safeParse`s the payload before any handler runs; an event
 * name that is not a key is not handled at all.
 */
export const CLIENT_TO_SERVER_EVENT_SCHEMAS = {
  'day:subscribe': dayRoomCommandSchema,
  'day:unsubscribe': dayRoomCommandSchema,
  'cell:lock': cellLockCommandSchema,
  'cell:unlock': cellLockCommandSchema,
} as const;

/**
 * The subset of commands that answer with an acknowledgement, and the schema of
 * that answer. Keys must also be keys of {@link CLIENT_TO_SERVER_EVENT_SCHEMAS};
 * the `satisfies` below enforces it.
 */
export const CLIENT_TO_SERVER_ACK_SCHEMAS = {
  'cell:lock': cellLockAckSchema,
} satisfies Partial<Record<keyof typeof CLIENT_TO_SERVER_EVENT_SCHEMAS, z.ZodType>>;

/** Name of a server → client event. */
export type ServerToClientEventName = keyof typeof SERVER_TO_CLIENT_EVENT_SCHEMAS;
/** Name of a client → server command. */
export type ClientToServerEventName = keyof typeof CLIENT_TO_SERVER_EVENT_SCHEMAS;
/** Name of a command that answers with an acknowledgement. */
export type AcknowledgedEventName = keyof typeof CLIENT_TO_SERVER_ACK_SCHEMAS;

/**
 * Events the server emits into a day room.
 *
 * ```ts
 * const io = new Server<ClientToServerEvents, ServerToClientEvents>();
 * io.to(roomForDate(date)).emit('reservation:created', payload);
 * ```
 */
export type ServerToClientEvents = {
  [K in ServerToClientEventName]: (
    payload: z.infer<(typeof SERVER_TO_CLIENT_EVENT_SCHEMAS)[K]>
  ) => void;
};

/**
 * Commands the server accepts from a client. `cell:lock` additionally takes
 * Socket.io's acknowledgement callback as its second argument.
 */
export type ClientToServerEvents = {
  [K in ClientToServerEventName]: K extends AcknowledgedEventName
    ? (
        payload: z.infer<(typeof CLIENT_TO_SERVER_EVENT_SCHEMAS)[K]>,
        ack: (result: z.infer<(typeof CLIENT_TO_SERVER_ACK_SCHEMAS)[K]>) => void
      ) => void
    : (payload: z.infer<(typeof CLIENT_TO_SERVER_EVENT_SCHEMAS)[K]>) => void;
};
