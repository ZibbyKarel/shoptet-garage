/**
 * Payload schemas of the **server → client** realtime events.
 *
 * Naming, settled here for the whole project (Task 5 brief asks for it):
 *
 * - `<subject>:<past participle>` — every one of these announces something that
 *   has **already happened and is already committed**. Task 15 broadcasts only
 *   after the transaction commits, and the past tense is what says so. Commands
 *   travelling the other way are imperative (`cell:lock`), so a name alone tells
 *   you which direction it belongs to; see `./commands`.
 * - `:` as the separator, lower case, singular subject, no verb tense mixing.
 * - The subject is a **domain** noun, except `cell`, which is deliberate: the
 *   editing hold is held on the pair (`parkingSpotId`, `date`) — one cell of the
 *   day × spot grid — and neither `spot:` nor `reservation:` names that pair.
 *   `spot:locked` would read as "this spot is locked on every day", which is a
 *   different (and non-existent) thing. `plan.md` and the Task 24 brief already
 *   call it a "cell-lock".
 *
 * **`locked` here has nothing to do with `MonthLockState.LOCKED`.** That is the
 * reservation window closing for a whole month; this is one user editing one
 * cell for the next ~30 seconds. No payload below carries a window state, and
 * no window state is ever broadcast — see `doc/contract.md`, §Realtime.
 *
 * Every payload repeats `date` even though the room already implies it: a
 * client is typically joined to several day rooms, and Socket.io does not tell
 * a handler which room a message arrived through.
 *
 * Every payload is **broadcast to a whole day room**, so nothing viewer-relative
 * (`viewerWaitlistPosition`) and nothing secret (`icsToken`, `email`, `oktaId`)
 * may appear in one. Other users are exposed through `userSummarySchema` only.
 */

import * as z from 'zod';
import { RESERVATION_REASSIGN_CAUSES } from '@garage/shared-types';
import {
  publicReservationSchema,
  publicTimedReservationSchema,
  userSummarySchema,
} from '../schemas/entities';
import { dateOnlySchema, idSchema, timestampSchema } from '../schemas/primitives';

/**
 * The pair that identifies one cell of the parking grid. Every realtime payload
 * starts from it, which is what makes a client able to route an event to a tile
 * without consulting anything else.
 */
export const cellRefSchema = z.object({
  date: dateOnlySchema,
  parkingSpotId: idSchema,
});
export type CellRef = z.infer<typeof cellRefSchema>;

/** Why a spot changed hands without its new holder asking. */
export const reservationReassignCauseSchema = z.enum(RESERVATION_REASSIGN_CAUSES);
export type ReservationReassignCause = z.infer<typeof reservationReassignCauseSchema>;

/**
 * `cell:locked` — somebody started editing a cell and holds it until
 * `expiresAt`. Other clients render the "právě upravuje …" state and must not
 * offer the reserve action.
 *
 * `expiresAt` travels with the event so a client can clear the state on its own
 * when the TTL runs out. A lost `cell:unlocked` (a browser closed mid-edit, a
 * dropped socket) must not freeze a tile forever.
 */
export const cellLockedEventSchema = cellRefSchema.extend({
  lockedBy: userSummarySchema,
  expiresAt: timestampSchema,
});
export type CellLockedEvent = z.infer<typeof cellLockedEventSchema>;

/**
 * `cell:unlocked` — the hold is gone, whether released, expired or dropped with
 * the socket. Carries no holder: who *used* to be editing is of no use to
 * anybody once they have stopped.
 */
export const cellUnlockedEventSchema = cellRefSchema;
export type CellUnlockedEvent = z.infer<typeof cellUnlockedEventSchema>;

/**
 * `reservation:created` — a free cell is now taken.
 *
 * The whole `publicReservation` travels, not just its id: the tile has to
 * render the new holder's name and plate immediately, and a client that had to
 * re-fetch the day to learn them would defeat the point of the broadcast.
 */
export const reservationCreatedEventSchema = cellRefSchema.extend({
  reservation: publicReservationSchema,
});
export type ReservationCreatedEvent = z.infer<typeof reservationCreatedEventSchema>;

/**
 * `reservation:cancelled` — a taken cell is now free, and **stays** free.
 *
 * A cancellation that immediately promoted somebody out of the waitlist emits
 * `reservation:reassigned` **instead** of this event, never both. One committed
 * transaction produces exactly one event: emitting a cancel followed by a
 * create would make every client flash the cell empty before repainting it.
 */
export const reservationCancelledEventSchema = cellRefSchema.extend({
  reservationId: idSchema,
});
export type ReservationCancelledEvent = z.infer<typeof reservationCancelledEventSchema>;

/**
 * `reservation:reassigned` — a cell changed hands inside one transaction, with
 * nobody having asked for it.
 *
 * This is a **separate event from `reservation:created` on purpose** (ruling
 * `window-1`): waitlist auto-promotion is a system action, exempt from the
 * reservation-window lock, so a client that saw a `created` in a locked month
 * would have to conclude the window had been violated. The name says it was not
 * a user action, and `cause` says which system action it was.
 *
 * `fromWaitlistEntryId` is what lets the promoted user's own client drop its
 * queue entry without a refetch. It is nullable rather than required so that
 * adding a non-promotion cause later is not a breaking change; for
 * `WAITLIST_PROMOTION`, the only cause that exists today, it is always set.
 */
export const reservationReassignedEventSchema = cellRefSchema.extend({
  cause: reservationReassignCauseSchema,
  /** The reservation that was released, so clients can drop it by id. */
  previousReservationId: idSchema,
  /** The reservation that now holds the cell, with its new holder. */
  reservation: publicReservationSchema,
  /** Queue entry that was consumed. Always set for `WAITLIST_PROMOTION`. */
  fromWaitlistEntryId: idSchema.nullable(),
});
export type ReservationReassignedEvent = z.infer<typeof reservationReassignedEventSchema>;

/**
 * `waitlist:updated` — the queue for one cell got longer or shorter.
 *
 * **Only the count.** Who is queued for a spot is not public: `overview.day`
 * exposes `waitlistCount` plus the *caller's own* position and nothing else, and
 * this event goes to every member of the day room, so it cannot say more than
 * the day overview says to a stranger. A client whose own position may have
 * moved refetches the day; there is no way to broadcast "your position is now
 * 2" to a room without telling everyone else who is in the queue.
 */
export const waitlistUpdatedEventSchema = cellRefSchema.extend({
  waitlistCount: z.int().nonnegative(),
});
export type WaitlistUpdatedEvent = z.infer<typeof waitlistUpdatedEventSchema>;

/**
 * `timed-reservations:updated` — the whole set of guest blocks on this cell,
 * after a create or a cancel.
 *
 * `timedReservations` is the **whole current list**, not a delta: a client
 * replaces its state rather than merges the payload into it, and a missed
 * event self-heals on the next one instead of drifting forever. The same
 * reason a full spot row, not a diff, travels on `reservation:created`.
 */
export const timedReservationsUpdatedEventSchema = cellRefSchema.extend({
  timedReservations: z.array(publicTimedReservationSchema),
});
export type TimedReservationsUpdatedEvent = z.infer<typeof timedReservationsUpdatedEventSchema>;
