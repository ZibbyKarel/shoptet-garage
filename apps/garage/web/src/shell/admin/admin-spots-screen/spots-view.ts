/**
 * What the spots screen decides, as pure functions: where a failed write is
 * shown, whose write a spinner belongs to, and what the category band counts.
 *
 * The rules live here rather than in the 500-line screen that draws them, for
 * the reason `lot/lot-view.ts` gives for its own half of the app: a decision
 * spread over a lookup table, a type and a nested conditional inside a
 * component body can only be exercised through the DOM, while the same
 * decision as a named function has a spec that states it directly.
 *
 * No React, no hooks, no network.
 */

import type { ParkingGroup, ParkingSpot } from '@garage/contract';
import { PARKING_GROUPS } from '@garage/i18n';
import type { AdminWrite } from '../admin-errors';

/**
 * Which dialog the screen has open, and on what. `null` means none.
 *
 * Lives here rather than in the screen because two of the rules below are
 * about it, and a type whose invariants are stated elsewhere is a type nobody
 * checks against them.
 */
export type SpotDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly spot: ParkingSpot }
  | { readonly kind: 'delete'; readonly spot: ParkingSpot };

/** Which of the three dialogs is open. Derived, so it cannot drift. */
type SpotDialogKind = SpotDialog['kind'];

/** A surface that can *start* a write: the table, or one of the three dialogs. */
type FailureHome = 'table' | SpotDialogKind;

/**
 * A surface that can *show* a failure. There are two, not four: a dialog is a
 * modal and covers the table, so all three of them share one place to print in.
 */
export type FailureSurface = 'table' | 'dialog';

/**
 * Which surfaces could have started each write.
 *
 * A second, independent guard behind `onDiscardFailure`. Discarding is what
 * *should* keep a stale sentence off the next dialog; this is what makes the
 * bad case unrepresentable even if a discard is ever missed — a `spotRetire`
 * failure has no route to the "Nové parkovací místo" form, because nothing in
 * that form can retire a spot.
 *
 * A write with no entry (`userUpdate`, `windowUpdate` — neither reaches the
 * spots screen) shows nowhere. Silence is the right failure direction for a
 * sentence whose origin that screen cannot account for.
 */
const WRITE_ORIGINS: Partial<Record<AdminWrite, readonly FailureHome[]>> = {
  spotCreate: ['create'],
  // Both the edit modal's "Uložit" and the row's inline category picker.
  spotRename: ['edit', 'table'],
  // Both the "Smazat" confirmation and the row's switch being turned off.
  spotRetire: ['delete', 'table'],
  // Only the row's switch: no dialog turns a spot back on.
  spotRevive: ['table'],
  // Only the row's "Skryté" switch.
  spotVisibility: ['table'],
  // Only the row's "Nabíječka" switch.
  spotEvCharger: ['table'],
};

/**
 * The surface an admin is looking at: whichever dialog is open, else the table.
 *
 * Exported for its own spec rather than for a call site: it is the smaller
 * half of {@link shouldShowFailureIn} and is worth stating on its own.
 */
export function failureSurfaceOf(dialogKind: SpotDialogKind | null): FailureSurface {
  return dialogKind === null ? 'table' : 'dialog';
}

/**
 * Whether the failure from `write` belongs on `where`, with `dialogKind` open.
 *
 * Two questions, in order. First, could this surface have produced the write
 * at all ({@link WRITE_ORIGINS})? Second, is `where` the surface the admin is
 * actually looking at — a message printed behind an open modal is a message
 * nobody reads. Keying the second question on the open dialog rather than on
 * the write is what puts the sentence where the user is looking: every write
 * here has *two* possible origins, `spotRename` being both the edit modal's
 * Save and the row's inline category picker.
 *
 * `false` for every other combination, so each call site renders at most one
 * `Toast`.
 */
export function shouldShowFailureIn(
  write: AdminWrite,
  dialogKind: SpotDialogKind | null,
  where: FailureSurface
): boolean {
  const home: FailureHome = dialogKind ?? 'table';
  if (!(WRITE_ORIGINS[write] ?? []).includes(home)) {
    return false;
  }
  return failureSurfaceOf(dialogKind) === where;
}

/**
 * Whether the write in flight belongs to the open dialog.
 *
 * `isSaving` is "any write anywhere", so reading it directly put the dialog's
 * "Uložit" into its loading state — and disabled "Zrušit" — because an
 * unrelated row switch was mid-flight. `pendingSpotId` is the row scope the
 * panel already keeps: `null` for a create, which has no id yet, and the
 * spot's id for everything else. Comparing the two is what confines the
 * dialog's spinner to the dialog's own write.
 */
export function isDialogSaving(
  isSaving: boolean,
  dialog: SpotDialog | null,
  pendingSpotId: string | null
): boolean {
  if (!isSaving || dialog === null) {
    return false;
  }
  return pendingSpotId === (dialog.kind === 'create' ? null : dialog.spot.id);
}

/** Module-private for the same reason as the banner view: nothing writes it. */
interface CategoryCount {
  readonly group: ParkingGroup;
  readonly count: number;
}

/**
 * One count per category, in the enum's own order.
 *
 * Counts every spot the table shows, inactive ones included — the number has
 * to agree with the rows underneath it, and hiding retired spots from the
 * count while showing them in the list would make the two disagree. Every
 * category is listed even at zero: the band's other job is to say which
 * categories exist at all, and a closed enum with a missing member reads as a
 * category that was removed (`doc/decision/0164-*`).
 */
export function toCategoryCounts(spots: readonly ParkingSpot[]): readonly CategoryCount[] {
  return PARKING_GROUPS.map((group) => ({
    group,
    count: spots.filter((spot) => spot.group === group).length,
  }));
}
