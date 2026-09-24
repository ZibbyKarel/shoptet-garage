/**
 * Shared scalar schemas. Every entity schema is built out of these, so a change
 * to the wire representation of an id, a day or a timestamp happens once.
 */

import * as z from 'zod';
import { isHalfHourTime } from '@garage/shared-types';

/**
 * Primary key of every entity: an RFC 9562 UUID in canonical text form, of
 * **any** version. `z.uuid()` accepts v1, v4, v7 and the nil UUID alike, and
 * that is deliberate — the version is an implementation detail of `libs/garage/database`
 * (Task 9), not something a client may depend on. Ids are opaque strings on the
 * wire; nothing in the contract reads a bit out of them.
 *
 * Binding on Task 9: ids are UUIDs (not cuid, not an autoincrement), because
 * they travel in URLs and realtime payloads and must not leak row counts or
 * ordering. Which UUID version Prisma generates is Task 9's call.
 *
 * See `doc/decision/0016-closed-enums-and-uuid-in-contract.md`.
 */
export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/**
 * A reservation day: `YYYY-MM-DD` in Europe/Prague, stored as `DATE` in
 * Postgres — never a timestamp.
 *
 * This validates the **format only**. It deliberately does not check that the
 * day is in the future, nor that it falls inside the reservation window: the
 * window depends on `ReservationWindowSettings` read from the database, which
 * a static schema cannot see. Both checks belong to the service layer, on top
 * of `isMonthOpen` / `monthLockState` from `@garage/shared-types`
 * (see `doc/decision/0004-mvp-scope-includes-design-features.md`).
 *
 * Note that `z.iso.date()` does validate the calendar: `2023-02-29` and
 * `2026-04-31` are rejected.
 */
export const dateOnlySchema = z.iso.date();

/** Calendar month `YYYY-MM`, used by the reservation-window overview. */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
  error: 'Expected a YYYY-MM month',
});

/**
 * A point in time, as an ISO 8601 UTC string (`2026-08-28T09:15:00.000Z`).
 *
 * Timestamps travel as strings rather than as `Date` instances so the contract
 * stays transport-neutral — see
 * `doc/decision/0015-timestamps-in-contract-are-iso-strings.md`.
 */
export const timestampSchema = z.iso.datetime();

/**
 * A half-hour time of day, `HH:MM`: `00:00`, `00:30`, …, `23:30`, `24:00`.
 *
 * This validates the **format** only — that a value is one of the 49 half-hour
 * marks the day admits. It says nothing about whether it may start a block or
 * only end one, nor whether it comes before or after another time: `24:00` is
 * a valid *end* (the day's exclusive upper bound, meaning "until midnight")
 * but never a valid *start*, and ordering between a start and an end is the
 * input schema's job (`createTimedReservationInputSchema`), because a `.refine()`
 * on this shared primitive would apply to every field built from it, start and
 * end alike.
 */
export const halfHourTimeSchema = z.string().refine(isHalfHourTime, {
  error: 'Expected HH:MM on a half hour (00:00–24:00)',
});
