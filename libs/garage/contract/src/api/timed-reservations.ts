/**
 * Admin-only: book and cancel half-hour, guest-only blocks.
 *
 * Admin-only by position in the router, not by anything a schema here can
 * express — both procedures sit under `contract.admin.timedReservation` and
 * the backend enforces `@Roles('ADMIN')` on that subtree.
 *
 * `SPOT_ALREADY_RESERVED` covers two different database refusals with one
 * honest answer: the spot already has a full-day `Reservation` that day, or
 * the requested block overlaps another `TimedReservation` on it. Both are
 * "this time on this spot is taken" from the caller's point of view, and the
 * database trigger backing the exclusivity (`doc/decision/0314-*`) does not
 * distinguish them either.
 *
 * `PAST_DATE` and `VALIDATION_FAILED` (a non-business day) come from
 * `ReservationPolicy.assertMayTakeDay`, the same guard `reservation.create`
 * runs — the admin window exemption applies here too, so neither
 * `OUT_OF_HORIZON` nor `RESERVATIONS_LOCKED` is reachable.
 */

import * as z from 'zod';
import { isHalfHourTime, timeOfDayToMinutes } from '@garage/shared-types';
import { timedReservationSchema } from '../schemas/entities';
import { dateOnlySchema, idSchema } from '../schemas/primitives';
import { authed, contractErrors } from './builder';

/**
 * Derived from the entity, not written out again: the server owns `id` and
 * `createdAt`.
 *
 * `guestName` and `licensePlate` are re-declared rather than picked, because
 * this input is stricter than the entity on `guestName` (bounded length, same
 * as `reservationHolderInputSchema`'s guest branch) and identical on
 * `licensePlate`; picking would have kept the entity's bound silently in sync
 * with an input that has its own reason to have one.
 *
 * `.refine()` is fine here even though `timedReservationSchema` above
 * deliberately has none: nothing `.pick()`s or `.extend()`s from *this*
 * schema afterwards, so Zod v4's ban on refined-object composition never
 * applies to it.
 */
export const createTimedReservationInputSchema = timedReservationSchema
  .pick({ parkingSpotId: true, date: true, startTime: true, endTime: true })
  .extend({
    guestName: z.string().min(1).max(120),
    licensePlate: z.string().min(1).nullable(),
  })
  .refine(
    (value) =>
      // Zod v4 runs an object-level `.refine()` even when one of its fields
      // failed its own field-level check — each field schema's `.refine()`
      // (in `halfHourTimeSchema`) is a check on *that* field, not a gate on
      // whether this object-level refinement runs at all. Guard explicitly
      // rather than let `timeOfDayToMinutes` throw on an already-rejected value.
      isHalfHourTime(value.startTime) &&
      isHalfHourTime(value.endTime) &&
      timeOfDayToMinutes(value.startTime) < timeOfDayToMinutes(value.endTime),
    {
      path: ['endTime'],
      error: 'endTime must be after startTime',
    }
  );
export type CreateTimedReservationInput = z.infer<typeof createTimedReservationInputSchema>;

export const createTimedReservationOutputSchema = timedReservationSchema;
export type CreateTimedReservationOutput = z.infer<typeof createTimedReservationOutputSchema>;

/** Book a spot for a guest for a half-hour-granular block of one day. */
export const createTimedReservationContract = authed
  .input(createTimedReservationInputSchema)
  .output(createTimedReservationOutputSchema)
  .errors(
    contractErrors(
      'NOT_FOUND',
      'SPOT_ALREADY_RESERVED',
      'PAST_DATE',
      'VALIDATION_FAILED',
      'CONFLICT'
    )
  );

export const cancelTimedReservationInputSchema = z.object({ timedReservationId: idSchema });
export type CancelTimedReservationInput = z.infer<typeof cancelTimedReservationInputSchema>;

export const cancelTimedReservationOutputSchema = z.object({
  timedReservationId: idSchema,
  date: dateOnlySchema,
  parkingSpotId: idSchema,
});
export type CancelTimedReservationOutput = z.infer<typeof cancelTimedReservationOutputSchema>;

/** Remove one block. */
export const cancelTimedReservationContract = authed
  .input(cancelTimedReservationInputSchema)
  .output(cancelTimedReservationOutputSchema)
  .errors(contractErrors('NOT_FOUND'));
