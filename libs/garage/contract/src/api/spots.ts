/**
 * Parking spots: one read for everybody, four admin mutations.
 *
 * The plain `spot.list` exists because normal users need it too — the settings
 * screen has to offer a picker for `preferredParkingSpotId`. It returns active,
 * visible spots only — never a hidden one, for anybody — and takes no filters;
 * everything richer is admin-only.
 */

import * as z from 'zod';
import { parkingSpotSchema } from '../schemas/entities';
import { parkingGroupSchema } from '../schemas/enums';
import { idSchema } from '../schemas/primitives';
import { authed, contractErrors, noInputSchema } from './builder';

export const spotListOutputSchema = z.object({
  spots: z.array(parkingSpotSchema),
});
export type SpotListOutput = z.infer<typeof spotListOutputSchema>;

/** Active, non-hidden spots, for pickers and labels. No input: no filters, no paging. */
export const listSpotsContract = authed.input(noInputSchema).output(spotListOutputSchema);

export const adminListSpotsInputSchema = z.object({
  /** Deactivated spots are kept for their foreign keys; admins can see them. */
  includeInactive: z.boolean().default(false),
  group: parkingGroupSchema.optional(),
});
export type AdminListSpotsInput = z.infer<typeof adminListSpotsInputSchema>;
export type AdminListSpotsInputRaw = z.input<typeof adminListSpotsInputSchema>;

export const adminListSpotsContract = authed
  .input(adminListSpotsInputSchema)
  .output(spotListOutputSchema);

/** `id`, `active`, `hidden`, `evCharger`, `createdAt` and `updatedAt` are the server's to assign — a new spot is always active, visible and without a charger. */
export const createSpotInputSchema = parkingSpotSchema.pick({
  label: true,
  group: true,
});
export type CreateSpotInput = z.infer<typeof createSpotInputSchema>;

/**
 * `CONFLICT` is the duplicate label: `label` is unique across the lot, and the
 * database constraint is what actually enforces it.
 */
export const createSpotContract = authed
  .input(createSpotInputSchema)
  .output(parkingSpotSchema)
  .errors(contractErrors('CONFLICT', 'VALIDATION_FAILED'));

/**
 * Partial update. An omitted field is left alone; there is no field here that
 * can be cleared, so no `null` has a meaning.
 */
export const updateSpotInputSchema = parkingSpotSchema
  .pick({ label: true, group: true, active: true, hidden: true, evCharger: true })
  .partial()
  .extend({ id: idSchema });
export type UpdateSpotInput = z.infer<typeof updateSpotInputSchema>;

export const updateSpotContract = authed
  .input(updateSpotInputSchema)
  .output(parkingSpotSchema)
  .errors(contractErrors('NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'));

export const deactivateSpotInputSchema = z.object({
  id: idSchema,
});
export type DeactivateSpotInput = z.infer<typeof deactivateSpotInputSchema>;

/**
 * Retire a spot. A soft delete (`active: false`), never a row deletion — past
 * reservations and audit entries point at it.
 *
 * `CONFLICT` covers a spot that still has reservations in the future: the admin
 * has to deal with those first, because silently stranding them would leave
 * people believing they have a parking place.
 */
export const deactivateSpotContract = authed
  .input(deactivateSpotInputSchema)
  .output(parkingSpotSchema)
  .errors(contractErrors('NOT_FOUND', 'CONFLICT'));
