/**
 * Single-day reservations: create and cancel.
 *
 * Bulk booking lives in `./bulk`; it is a different flow with a different
 * failure model (per-day outcomes rather than one all-or-nothing answer).
 */

import * as z from 'zod';
import { reservationSchema } from '../schemas/entities';
import { dateOnlySchema, idSchema, yearMonthSchema } from '../schemas/primitives';
import { authed, contractErrors } from './builder';

/**
 * Who the reservation is for, when the caller is not booking for themselves.
 *
 * A discriminated union for the same reason as `reservationHolderSchema`: a
 * guest has no user id, and the type says so rather than carrying a `null` one.
 *
 * `licensePlate` overrides the holder's stored `User.licensePlate` **for this
 * reservation only** — `null` means "use whatever they have on their profile",
 * and this flow never writes the profile (`doc/decision/0306-an-admin-names-the-holder-and-defaults-to-themselves`). For a guest it
 * is the only plate there is.
 *
 * **Only an admin may name a holder other than themselves.** That is not
 * expressible in a schema — a schema cannot see who is calling — so it is
 * `ReservationPolicy.assertMayNameHolder`, and the refusal is the `FORBIDDEN`
 * the base builder already declares.
 */
export const reservationHolderInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('USER'),
    userId: idSchema,
    licensePlate: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal('GUEST'),
    name: z.string().min(1).max(120),
    licensePlate: z.string().min(1).nullable(),
  }),
]);
export type ReservationHolderInput = z.infer<typeof reservationHolderInputSchema>;

/**
 * Derived from the entity, not written out again: the server owns `id` and
 * `createdAt`.
 *
 * **`holder` is optional, and its absence is the whole compatibility story**:
 * omitted means "the caller, for themselves", which is what this procedure has
 * always done and what every existing client still sends.
 */
export const createReservationInputSchema = reservationSchema
  .pick({ parkingSpotId: true, date: true })
  .extend({ holder: reservationHolderInputSchema.optional() });
export type CreateReservationInput = z.infer<typeof createReservationInputSchema>;

export const createReservationOutputSchema = reservationSchema;
export type CreateReservationOutput = z.infer<typeof createReservationOutputSchema>;

/**
 * Create a reservation for one spot on one day.
 *
 * Window rules (`doc/decision/0004-*`, ruling window-1): a normal user may only
 * create inside an open month, so both window codes are reachable —
 * `OUT_OF_HORIZON` when the target month is `NOT_YET_OPEN` and
 * `RESERVATIONS_LOCKED` when it is `LOCKED`. An admin is not restricted by the
 * window and will never see either.
 *
 * `SPOT_ALREADY_RESERVED` is the honest answer for a spot someone else holds;
 * `CONFLICT` is the narrower case of losing a race between the availability
 * check and the insert, which the unique constraint on (spot, day) turns into a
 * failure rather than a double booking.
 *
 * **An admin may name a holder** (`holder` on the input): another user, or a
 * guest. The admin is the actor, so the admin's own window exemption applies —
 * booking *on behalf of* a user does not inherit that user's restriction, and
 * `OUT_OF_HORIZON` / `RESERVATIONS_LOCKED` stay unreachable for an admin.
 * `PAST_DATE` still binds them: the exemption is about which future months are
 * open, not about rewriting the past. A non-admin naming anyone but themselves
 * gets `FORBIDDEN`, which the base builder already declares.
 */
export const createReservationContract = authed
  .input(createReservationInputSchema)
  .output(createReservationOutputSchema)
  .errors(
    contractErrors(
      'NOT_FOUND',
      'SPOT_ALREADY_RESERVED',
      'RESERVATION_LIMIT_REACHED',
      'MONTHLY_RESERVATION_LIMIT_REACHED',
      'PAST_DATE',
      'OUT_OF_HORIZON',
      'RESERVATIONS_LOCKED',
      'VALIDATION_FAILED',
      'CONFLICT'
    )
  );

export const cancelReservationInputSchema = z.object({
  reservationId: idSchema,
});
export type CancelReservationInput = z.infer<typeof cancelReservationInputSchema>;

export const cancelReservationOutputSchema = z.object({
  reservationId: idSchema,
  /** Echoed so the client can invalidate exactly the affected day and spot. */
  date: dateOnlySchema,
  parkingSpotId: idSchema,
  /**
   * `true` when the freed spot was handed straight to the first person in its
   * waitlist. Auto-promotion is a system action and is exempt from the
   * reservation-window lock, so this can be `true` even in a locked month.
   */
  promoted: z.boolean(),
});
export type CancelReservationOutput = z.infer<typeof cancelReservationOutputSchema>;

/**
 * Cancel a reservation.
 *
 * **Declares no window errors, and that is the point.** Ruling window-1: a
 * normal user may cancel their own reservation at any time, including in a
 * locked month — a locked window stops people from taking spots, not from
 * giving them back. `FORBIDDEN` (from the base builder) covers cancelling
 * somebody else's reservation; an admin may cancel any.
 */
export const cancelReservationContract = authed
  .input(cancelReservationInputSchema)
  .output(cancelReservationOutputSchema)
  .errors(contractErrors('NOT_FOUND', 'CONFLICT'));

/**
 * One user's confirmed reservations in one calendar month.
 *
 * The shape is shared by the two procedures that answer it — the caller-scoped
 * `reservation.myMonth` and the admin-only `admin.reservation.month` — because
 * they are the same question about a different subject, and a second
 * hand-copied object is how the two would drift.
 */
export const monthReservationsOutputSchema = z.object({
  month: yearMonthSchema,
  /** Every date in `month` the subject holds a confirmed reservation on, ascending. */
  reservedDates: z.array(dateOnlySchema),
  /** `reservedDates.length` — carried separately so a client need not recompute it. */
  count: z.int().nonnegative(),
  /**
   * The monthly cap **in force for this month today**, or `null` when none
   * applies. The number is the `ReservationLimitSettings` singleton's
   * `monthlyReservationCap`; it is only in force under `AUTO` while today lies
   * inside the month's reservation window (`isMonthlyCapInForce`,
   * `doc/decision/0315-the-monthly-cap-applies-only-inside-the-auto-window`).
   * Once the month is running, and under either admin override, it is `null`
   * and a client must not bound the selection at all.
   *
   * It travels with the count because the client's job is `cap - count`, and
   * the cap is an admin setting: a client that imported
   * `DEFAULT_MONTHLY_RESERVATION_CAP` would grey out the wrong cells for every
   * workspace that changed it. Carried on the shared schema so
   * `reservation.myMonth` and `admin.reservation.month` answer the same value
   * by construction. Still required — never omitted, never defaulted.
   */
  cap: z.int().positive().nullable(),
});
export type MonthReservations = z.infer<typeof monthReservationsOutputSchema>;

export const myMonthReservationsInputSchema = z.object({
  month: yearMonthSchema,
});
export type MyMonthReservationsInput = z.infer<typeof myMonthReservationsInputSchema>;

/**
 * Kept under its original name: every existing consumer annotates with it, and
 * the caller-scoped procedure's output is genuinely this shape.
 */
export const myMonthReservationsOutputSchema = monthReservationsOutputSchema;
export type MyMonthReservationsOutput = MonthReservations;

/**
 * Read-only, like `getDayOverviewContract`: any month is viewable by its own
 * caller, so there is no domain rule a structurally valid `month` can break
 * here beyond the inherited `FORBIDDEN`.
 *
 * Deliberately scoped to **the caller** — there is no `userId` input, and
 * widening it would make every consumer's call site a place where "whose
 * month?" has to be re-answered. An admin who needs somebody else's month
 * asks `admin.reservation.month` instead, which is admin-gated by its
 * position in the router.
 */
export const getMyMonthReservationsContract = authed
  .input(myMonthReservationsInputSchema)
  .output(myMonthReservationsOutputSchema);

export const adminUserMonthReservationsInputSchema = z.object({
  /** Whose month to read. Never defaulted to the caller — see the contract below. */
  userId: idSchema,
  month: yearMonthSchema,
});
export type AdminUserMonthReservationsInput = z.infer<typeof adminUserMonthReservationsInputSchema>;

/**
 * One named user's confirmed reservations in one calendar month, for an admin.
 *
 * Exists because the monthly cap
 * (`apps/garage/api/src/reservations/monthly-reservation-cap.ts`) is
 * enforced against the **holder** of a reservation, who can be somebody other
 * than the caller whenever an admin books on a colleague's behalf. Without
 * this, the bulk modal has no way to show the budget it is actually spending,
 * and the first the admin hears of a full month is the server rejecting the
 * whole batch.
 *
 * `userId` is **required**, with no "defaults to the caller" branch: a
 * procedure that answers about the caller already exists, and an optional
 * subject would make every call site a place to re-decide whose month this is.
 *
 * Admin-only, and enforced by position: this sits under `admin` in the router,
 * which is `@Roles('ADMIN')` on the Nest route. `FORBIDDEN` (inherited from
 * the base builder) is the refusal a non-admin gets. An unknown `userId`
 * honestly holds no reservations, so it answers `count: 0` rather than
 * declaring `NOT_FOUND` — nothing in the UI can produce one, because the
 * holder picker is populated from `admin.user.list`.
 */
export const getUserMonthReservationsContract = authed
  .input(adminUserMonthReservationsInputSchema)
  .output(monthReservationsOutputSchema);
