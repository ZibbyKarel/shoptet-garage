/**
 * Waitlist: queueing for a spot somebody else already holds, and leaving that
 * queue. Promotion out of a queue is never a client call — it happens on the
 * backend when the holder cancels, and is announced over
 * `@garage/contract/realtime` (Task 5).
 */

import * as z from 'zod';
import { waitlistEntrySchema } from '../schemas/entities';
import { dateOnlySchema, idSchema } from '../schemas/primitives';
import { authed, contractErrors } from './builder';

/**
 * Who to queue, when the caller is not queueing themselves.
 *
 * Unlike `reservationHolderInputSchema`, this is **not** a discriminated
 * union: `WaitlistEntry.userId` is non-nullable — there is no guest
 * waitlisting — so a bare user id is the whole shape. Omitted means "the
 * caller, for themselves", which is what `waitlist.join` has always done.
 * **Only an admin may name somebody else** — a schema cannot see who is
 * calling, so that is `ReservationPolicy.assertMayNameWaitlistTarget`, and the
 * refusal is the `FORBIDDEN` the base builder already declares.
 */
export const joinWaitlistInputSchema = waitlistEntrySchema
  .pick({
    parkingSpotId: true,
    date: true,
  })
  .extend({ holderId: idSchema.optional() });
export type JoinWaitlistInput = z.infer<typeof joinWaitlistInputSchema>;

export const joinWaitlistOutputSchema = z.object({
  entry: waitlistEntrySchema,
  /** 1-based position in the queue at the moment of joining. */
  position: z.int().positive(),
});
export type JoinWaitlistOutput = z.infer<typeof joinWaitlistOutputSchema>;

/**
 * Join the queue for an occupied spot.
 *
 * Ruling window-1: joining is a write and is blocked in a month that is not
 * open, so both window codes apply. `RESERVATION_LIMIT_REACHED` is reachable
 * here even though nothing is reserved yet: a promotion would give the caller a
 * second reservation on a day they already have one, so the queue refuses them
 * up front rather than silently never promoting them.
 */
export const joinWaitlistContract = authed
  .input(joinWaitlistInputSchema)
  .output(joinWaitlistOutputSchema)
  .errors(
    contractErrors(
      'NOT_FOUND',
      'ALREADY_IN_WAITLIST',
      'CANNOT_WAITLIST_OWN_SPOT',
      'SPOT_NOT_OCCUPIED',
      'RESERVATION_LIMIT_REACHED',
      'PAST_DATE',
      'OUT_OF_HORIZON',
      'RESERVATIONS_LOCKED',
      'VALIDATION_FAILED',
      'CONFLICT'
    )
  );

export const leaveWaitlistInputSchema = z.object({
  waitlistEntryId: idSchema,
});
export type LeaveWaitlistInput = z.infer<typeof leaveWaitlistInputSchema>;

export const leaveWaitlistOutputSchema = z.object({
  waitlistEntryId: idSchema,
  /** Echoed so the client can invalidate exactly the affected day and spot. */
  parkingSpotId: idSchema,
  date: dateOnlySchema,
});
export type LeaveWaitlistOutput = z.infer<typeof leaveWaitlistOutputSchema>;

/**
 * Leave the queue.
 *
 * **No window errors.** Like cancelling a reservation, leaving a queue is never
 * blocked by a closed or not-yet-open month — see
 * `doc/decision/0233-leaving-a-waitlist-is-exempt-from-the-reservation-window`,
 * which amends `doc/decision/0004-*`. Before `doc/decision/0315-*`, every
 * `AUTO` month was `LOCKED` from its own 1st — the entire period a queue for
 * it could be promoted in — so the window rule made leaving impossible for a
 * queue's whole live life. `0315` lifted that for `AUTO`, but an admin's
 * `FORCE_LOCKED` can still close the month at any time, so the exemption
 * still matters. Leaving moves
 * everyone behind you *up*, which is nearer to cancellation (always allowed)
 * than to creation.
 */
export const leaveWaitlistContract = authed
  .input(leaveWaitlistInputSchema)
  .output(leaveWaitlistOutputSchema)
  .errors(contractErrors('NOT_FOUND', 'CONFLICT'));
