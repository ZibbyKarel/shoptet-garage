/**
 * The typed error contract.
 *
 * The backend never returns an ad-hoc error shape: every failure that is not a
 * transport-level problem is one of the codes below, wrapped in
 * `errorShapeSchema`. The frontend switches on `code`; `message` is a fallback
 * for logs and unexpected cases, and localized UI copy is keyed off the code.
 */

import * as z from 'zod';

/**
 * Closed enumeration of domain error codes.
 *
 * The two window-related codes are distinct on purpose, because the user-facing
 * explanation differs (see `doc/decision/0004-*`):
 *
 * - `OUT_OF_HORIZON` — the target month is `NOT_YET_OPEN`; reservations for it
 *   have not opened yet ("Zatím neotevřeno").
 * - `RESERVATIONS_LOCKED` — the target month is `LOCKED`, which only an
 *   admin's `FORCE_LOCKED` produces; under `AUTO` a started month stays open
 *   (`doc/decision/0315-*`).
 *
 * Both are raised by the service layer (Task 13) on top of `monthLockState()`,
 * never by a schema.
 */
export const ERROR_CODES = [
  'SPOT_ALREADY_RESERVED',
  'RESERVATION_LIMIT_REACHED',
  'MONTHLY_RESERVATION_LIMIT_REACHED',
  'PAST_DATE',
  'OUT_OF_HORIZON',
  'NOT_FOUND',
  'FORBIDDEN',
  'ALREADY_IN_WAITLIST',
  'CANNOT_WAITLIST_OWN_SPOT',
  'SPOT_NOT_OCCUPIED',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RESERVATIONS_LOCKED',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Structured context carried alongside an error code, e.g. the id of the
 * conflicting reservation. Free-form on purpose: its keys depend on `code`.
 *
 * On the wire this is oRPC's `data` field — see
 * `doc/decision/0018-mapping-error-contract-to-orpc.md`.
 */
export const errorDetailsSchema = z.record(z.string(), z.unknown());
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

/** The single shape every domain error is serialized into. */
export const errorShapeSchema = z.object({
  code: errorCodeSchema,
  /** Human-readable detail. Not the UI copy — the frontend keys off `code`. */
  message: z.string().min(1),
  /** Optional structured context, e.g. the conflicting reservation's id. */
  details: errorDetailsSchema.optional(),
});
export type ErrorShape = z.infer<typeof errorShapeSchema>;
