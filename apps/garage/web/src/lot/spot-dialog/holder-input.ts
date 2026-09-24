/**
 * The holder form's pure half: its field shape, its validation, and the
 * translation from flat field values to the contract's holder union.
 *
 * Flat, and then mapped — rather than validating the union directly — because
 * the union's members have different fields, and a react-hook-form resolver
 * needs every field to exist for the whole life of the form. `useAppForm`'s
 * `TIn`/`TOut` split could carry a Zod `.transform()` here instead; it is kept
 * out on purpose, so the mapping is a plain function with a plain test and the
 * form stays the same single-parameter `useAppForm<TValues>` shape as
 * `apps/garage/web/src/shell/admin/admin-spots-screen/spot-form-dialog.tsx`.
 *
 * **No `t()` anywhere below.** The schema is built once at module level, where
 * there is no translator; messages are resolved at render time from the issue's
 * path, the way `spot-form-dialog.tsx` resolves `spotsLabelRequired`.
 */

import * as z from 'zod';
import type { ReservationHolderInput } from '@garage/contract';
import { isHalfHourTime, timeOfDayToMinutes } from '@garage/i18n';

/**
 * The `Select` value that means "a guest, not a user". Not a uuid, so it can
 * never collide with one.
 */
export const GUEST_HOLDER_VALUE = 'GUEST';

/** One selectable user: what the picker shows, and the plate it hints. */
export interface HolderOption {
  readonly userId: string;
  readonly name: string;
  readonly licensePlate: string | null;
}

/**
 * `'FULL_DAY'` books the whole day, the form's default. `'TIMED'` books a
 * half-hour-granular block instead — only meaningful for a guest holder; a
 * user always books the whole day (`plan.md`).
 */
export type HolderDuration = 'FULL_DAY' | 'TIMED';

/** The form's field values. Flat, and all fields always present. */
export interface HolderFormValues {
  /** A user id, or {@link GUEST_HOLDER_VALUE}. */
  readonly holderId: string;
  /** Only meaningful for a guest; empty otherwise. */
  readonly guestName: string;
  /** Blank means "use the holder's stored plate". */
  readonly licensePlate: string;
  /** Only meaningful for a guest; a user always books the whole day. */
  readonly duration: HolderDuration;
  readonly startTime: string;
  readonly endTime: string;
}

export const holderFormSchema: z.ZodType<HolderFormValues, HolderFormValues> = z
  .object({
    holderId: z.string().min(1),
    guestName: z.string(),
    licensePlate: z.string(),
    duration: z.enum(['FULL_DAY', 'TIMED']),
    startTime: z.string(),
    endTime: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.holderId === GUEST_HOLDER_VALUE && values.guestName.trim() === '') {
      // A `message` is required, not decorative: `FormField` forwards
      // `fieldState.error?.message`, and a render that keys off
      // `fieldError === undefined` sees `undefined` for an issue with none.
      // The string is a **developer-facing marker** — the Czech copy is resolved
      // at render time from the catalogue, never from here.
      ctx.addIssue({ code: 'custom', path: ['guestName'], message: 'GUEST_NAME_REQUIRED' });
    }
    if (
      values.holderId === GUEST_HOLDER_VALUE &&
      values.duration === 'TIMED' &&
      !(
        isHalfHourTime(values.startTime) &&
        isHalfHourTime(values.endTime) &&
        timeOfDayToMinutes(values.startTime) < timeOfDayToMinutes(values.endTime)
      )
    ) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'TIME_RANGE_INVALID' });
    }
  });

/** Blank, or whitespace only, is "not given" — never an empty string on the wire. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Flat field values as the contract's holder. */
export function toHolderInput(values: HolderFormValues): ReservationHolderInput {
  const licensePlate = orNull(values.licensePlate);

  if (values.holderId === GUEST_HOLDER_VALUE) {
    return { kind: 'GUEST', name: values.guestName.trim(), licensePlate };
  }
  return { kind: 'USER', userId: values.holderId, licensePlate };
}

/**
 * What submitting the form actually books: either the existing full-day
 * holder shape, or a guest's half-hour block. Only a guest may pick
 * `'TIMED'` — {@link toReservationRequest} falls back to `'FULL_DAY'` for a
 * user holder even if `duration` somehow says otherwise, since a user's own
 * reservation is always the whole day.
 */
export type ReservationRequest =
  | { readonly kind: 'FULL_DAY'; readonly holder: ReservationHolderInput }
  | {
      readonly kind: 'TIMED';
      readonly guestName: string;
      readonly licensePlate: string | null;
      readonly startTime: string;
      readonly endTime: string;
    };

/** Flat field values as what the dialog should actually submit. */
export function toReservationRequest(values: HolderFormValues): ReservationRequest {
  if (values.holderId === GUEST_HOLDER_VALUE && values.duration === 'TIMED') {
    return {
      kind: 'TIMED',
      guestName: values.guestName.trim(),
      licensePlate: orNull(values.licensePlate),
      startTime: values.startTime,
      endTime: values.endTime,
    };
  }
  return { kind: 'FULL_DAY', holder: toHolderInput(values) };
}

/**
 * The stored plate to show as the plate field's placeholder: what this holder
 * gets if the admin types nothing. `null` for a guest, and for a user who has
 * none.
 */
export function plateHintFor(options: readonly HolderOption[], holderId: string): string | null {
  if (holderId === GUEST_HOLDER_VALUE) return null;
  return options.find((option) => option.userId === holderId)?.licensePlate ?? null;
}
