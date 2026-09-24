/**
 * The day overview — one request that fully paints the parking screen for a
 * given day: every spot, who holds it, how many people are queued for it, where
 * the caller stands, **and** the reservation-window state of that day.
 *
 * The window travels with the payload on purpose (Task 4 brief): the banner and
 * the "reservations locked" tiles are rendered from the same response, so the
 * frontend never needs a second round trip and can never render a day's grid
 * against a stale window.
 */

import * as z from 'zod';
import {
  parkingSpotSchema,
  publicReservationSchema,
  publicTimedReservationSchema,
} from '../schemas/entities';
import { dateOnlySchema, idSchema } from '../schemas/primitives';
import { monthWindowOverviewSchema } from '../schemas/reservation-window';
import { authed } from './builder';

/** One spot's row in the day overview. */
export const daySpotOverviewSchema = z.object({
  spot: parkingSpotSchema,
  /**
   * `null` when the spot is free for that day. `publicReservationSchema` lives
   * in `../schemas/entities` because the realtime events broadcast the same
   * shape, and `src/realtime` must not import from `src/api`.
   */
  reservation: publicReservationSchema.nullable(),
  /** How many people are queued for this spot on this day. */
  waitlistCount: z.int().nonnegative(),
  /** The caller's own queue entry for this spot, or `null` if not queued. */
  viewerWaitlistEntryId: idSchema.nullable(),
  /** The caller's 1-based position in that queue, or `null` if not queued. */
  viewerWaitlistPosition: z.int().positive().nullable(),
  /**
   * Guest blocks on this spot this day, ascending by `startTime`. Non-empty
   * only while `reservation` is `null` — the database refuses both at once
   * (`doc/decision/0314-*`). A spot with blocks cannot take a full-day
   * reservation, but an admin may add further non-overlapping blocks.
   */
  timedReservations: z.array(publicTimedReservationSchema),
});
export type DaySpotOverview = z.infer<typeof daySpotOverviewSchema>;

export const dayOverviewInputSchema = z.object({
  date: dateOnlySchema,
});
export type DayOverviewInput = z.infer<typeof dayOverviewInputSchema>;

export const dayOverviewOutputSchema = z.object({
  date: dateOnlySchema,
  /**
   * Window state of the month `date` falls in. Read `state` for the truth and
   * `lockMode` to know whether an admin overrode it — `windowFrom`/`windowTo`
   * are the AUTO-derived range and are hypothetical unless `lockMode === 'AUTO'`.
   */
  window: monthWindowOverviewSchema,
  /**
   * Whether **this caller** may create a reservation on **this day**, already
   * accounting for the window, the admin exemption, past dates and business
   * days. The frontend must not re-derive this from `window`: an admin is not
   * restricted by the window at all, and that fact lives on the backend.
   */
  canReserve: z.boolean(),
  /**
   * Whether **this caller** may create reservations **anywhere in the month**
   * `date` falls in — the window and the admin exemption, and nothing about
   * `date` itself.
   *
   * This is `canReserve` with the two *per-day* rules removed: a past day and a
   * non-business day both make `canReserve` false while leaving the month wide
   * open. A screen whose subject is the month rather than the day — the bulk
   * booking modal, which offers a whole month's grid from whatever day the user
   * happens to be looking at — must read this one, or it switches itself off on
   * every weekend, every Czech public holiday and every past day of an open
   * month (`doc/decision/0175-*`).
   *
   * It is a separate field rather than something the client derives, for the
   * same reason `canReserve` is (`doc/decision/0120-*`): the admin exemption
   * does not appear anywhere in `window`, so `window.state === 'OPEN'` is not
   * this value and never can be.
   */
  canReserveMonth: z.boolean(),
  /**
   * Every active spot the caller may see, in a stable order chosen by the
   * backend: all of them for an admin (hidden ones with `spot.hidden: true`),
   * and for anybody else the visible ones plus a hidden one they hold or are
   * queued for that day (`doc/decision/0316-*`).
   */
  spots: z.array(daySpotOverviewSchema),
  /**
   * The caller's own reservation that day, if any. There is at most one, by the
   * "one reservation per user and day" rule.
   */
  viewerReservationId: idSchema.nullable(),
});
export type DayOverviewOutput = z.infer<typeof dayOverviewOutputSchema>;

/**
 * Read-only. Never fails on the window — a locked or not-yet-open day is still
 * viewable; the state is reported in `window`, not thrown.
 *
 * Declares nothing beyond the inherited `FORBIDDEN` on purpose. There is no
 * domain rule a structurally valid date can break here: any day is viewable, so
 * a day outside every window comes back with `canReserve: false` rather than an
 * error. A malformed date is caught by the input schema, which is oRPC's own
 * validation failure and not one of our codes.
 */
export const getDayOverviewContract = authed
  .input(dayOverviewInputSchema)
  .output(dayOverviewOutputSchema);
