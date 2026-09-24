/**
 * Spot administration: adding a bay, refusing a duplicate label, refusing then
 * allowing a retirement, and the active toggle's effect on the lot overview.
 *
 * This is a browser-layer journey rather than a unit test because the thing
 * under test is the round trip through `admin.spot.*` and back into
 * `overview.day` — the app never re-derives "is this bay offered today" on its
 * own, it reads whatever `SpotsService.listActive` returns, and that only
 * changes because a mutation went through the API. A component test can stub
 * that response; it cannot show that clicking the switch actually produces it.
 *
 * `apps/garage/api/src/spots/spots.service.ts` is worth having read before this file:
 * "Smazat" in the UI is `admin.spot.deactivate`, which never deletes the row
 * (`Reservation`/`WaitlistEntry`/`AuditLog` all reference it) — it flips
 * `active` to `false`, and refuses to while anybody holds the spot, or is
 * queued for it, from today onward. The active `Switch` in the table calls the
 * same check through `admin.spot.update`. And `DayOverviewService.getDay`
 * reads `SpotsService.listActive()`, which filters on `active` — so an
 * inactive spot is not a locked tile on the lot overview, it is *no tile at
 * all*. Every assertion below about "the tile is gone" means exactly that,
 * not a disabled or hatched one.
 *
 * The four tests share one bay (`E2E.01`, on `SPEC_DAY_SLOTS.adminSpots`) and
 * run in series, each leaving the state the next one needs — the same shape
 * as `reservation.spec.ts` and `admin-reservation.spec.ts`. The end state is
 * the bay retired (inactive, no reservation): the closest thing to "removed"
 * this application allows, since a spot can never be hard-deleted.
 */

import type { Locator, Page } from '@playwright/test';
import { goToAdminTab, tableRow } from './support/admin-page';
import { e2eDayForSlot, SPEC_DAY_SLOTS } from './support/dates';
import { expect, test } from './support/fixtures';
import { LOT_PATH } from './support/oidc-login';
import { USER } from './support/personas';
import {
  cancelReservation,
  expectFree,
  expectHeldBy,
  goToDate,
  reserveSpot,
  spotDialog,
  spotMenuButton,
  spotTile,
} from './support/lot-page';

const DATE = e2eDayForSlot(SPEC_DAY_SLOTS.adminSpots);
// Obviously test-created, and distinct from the nine seeded labels
// (E2.61/62/65/66/92-96) so this file cannot collide with a seed row.
const SPOT = 'E2E.01';

test.describe.configure({ mode: 'serial' });

/** The confirm dialog `admin-spots-screen.tsx` opens for "Smazat". */
function deleteConfirmDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: `Smazat místo ${SPOT}?` });
}

/**
 * The admin add/edit form (`spot-form-dialog.tsx`), anchored on its own title
 * rather than reused from `lot-page.ts`'s `spotDialog()` — that helper's name
 * and docblock are about the lot's *booking* dialog, and using it here would
 * mislead a reader even though the underlying `page.getByRole('dialog')` query
 * happens to match either one. Only the create title is needed in this file.
 */
function spotFormDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Nové parkovací místo' });
}

/**
 * Tolerates a leftover `E2E.01` from an earlier, interrupted run of this file
 * — the DB reset between suite runs is not something this spec relies on.
 *
 * Two independent things can be left over: a reservation held on `DATE` (from
 * the create-and-reserve test), and the spot row itself, active or not. Both
 * are put right before the first test does anything of its own.
 */
async function cleanUpLeftoverSpot(adminPage: Page): Promise<void> {
  // A held bay only ever shows the `⋯` menu for an admin looking at somebody
  // else's reservation (`showAdminMenu`) — every reservation this file makes
  // is `USER`'s, never the admin's own, so this is the one way in.
  //
  // `menuButton.count()` does not wait, so this branch is only safe because
  // `SpotDialog`'s trigger (the tile grid) renders synchronously from
  // already-fetched `overview.day` data — see `waitlist-queue.spec.ts`'s
  // `leaveQueueIfQueued` for the full argument, and the `tableRow` precedent
  // this is the same class of bug as. A lazy fetch or loading skeleton added
  // later would make this silently take the wrong path.
  await adminPage.goto(LOT_PATH);
  await goToDate(adminPage, DATE);
  const menuButton = spotMenuButton(adminPage, SPOT);
  if ((await menuButton.count()) > 0) {
    await menuButton.click();
    const dialog = spotDialog(adminPage);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Zrušit rezervaci' }).click();
    await expect(dialog).toBeHidden();
  }

  const panel = await goToAdminTab(adminPage, 'spots');
  const row = tableRow(panel, SPOT);
  if ((await row.count()) === 0) {
    // No row at all: nothing was ever created, or a previous run's own
    // cleanup already went all the way through. `tableRow` matches a retired
    // row too (it is still listed, just badged "Neaktivní" — see below), so
    // this branch is reached only when the spot genuinely does not exist.
    return;
  }

  const toggle = row.getByRole('switch', { name: `Aktivní místo ${SPOT}` });
  if (!(await toggle.isChecked())) {
    // Retired already: `requireNoFutureCommitments` (spots.service.ts) refused
    // to retire it while anything still pointed at it, so a retired row can
    // never carry a leftover reservation — free by construction, nothing left
    // to tolerate.
    return;
  }

  await row.getByRole('button', { name: 'Smazat' }).click();
  const confirmDialog = deleteConfirmDialog(adminPage);
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Smazat', exact: true }).click();
  await expect(confirmDialog).toBeHidden();
}

test('an admin creates a new parking spot, and it appears as a bookable tile for an ordinary user', async ({
  adminPage,
  userPage,
}) => {
  await cleanUpLeftoverSpot(adminPage);

  const panel = await goToAdminTab(adminPage, 'spots');
  await panel.getByRole('button', { name: 'Přidat místo' }).click();

  const dialog = spotFormDialog(adminPage);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Štítek').fill(SPOT);
  await dialog.getByLabel('Kategorie').selectOption('SHARED');
  await dialog.getByRole('button', { name: 'Uložit' }).click();
  await expect(dialog).toBeHidden();

  const row = tableRow(panel, SPOT);
  await expect(row).toBeVisible();
  // The row's own category cell is a `<Select>`, not static text
  // (`admin-spots-screen.tsx`'s `group` column) — reading it back is the only
  // proof the submitted category was actually stored, not silently dropped.
  await expect(row.getByRole('combobox', { name: `Kategorie místa ${SPOT}` })).toHaveValue(
    'SHARED'
  );

  // The new bay is exactly as bookable to an ordinary user as any seeded one.
  await userPage.goto(LOT_PATH);
  await goToDate(userPage, DATE);
  await reserveSpot(userPage, SPOT);
  await expectHeldBy(userPage, SPOT, USER.displayName);
});

test("a duplicate label is refused with the screen's own message", async ({ adminPage }) => {
  const panel = await goToAdminTab(adminPage, 'spots');
  await panel.getByRole('button', { name: 'Přidat místo' }).click();

  const dialog = spotFormDialog(adminPage);
  await dialog.getByLabel('Štítek').fill(SPOT);
  await dialog.getByLabel('Kategorie').selectOption('IT');
  await dialog.getByRole('button', { name: 'Uložit' }).click();

  // The unique-index conflict, not the generic write-failure sentence
  // (`admin-spots-screen.tsx`'s docs on why `CONFLICT` gets its own copy here).
  await expect(dialog).toContainText('Místo s tímto štítkem už existuje.');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Zrušit', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('deleting a spot with a reservation is refused, and succeeds once it is cancelled', async ({
  adminPage,
  userPage,
}) => {
  const panel = await goToAdminTab(adminPage, 'spots');
  const row = tableRow(panel, SPOT);
  await row.getByRole('button', { name: 'Smazat' }).click();

  const confirmDialog = deleteConfirmDialog(adminPage);
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Smazat', exact: true }).click();

  // Refused: `SpotsService`'s `requireNoFutureCommitments` sees the user's
  // reservation. Since 0fc3af5 the sentence renders through the global
  // `useNotify`/toast region, not as the `ConfirmDialog`'s own children, so
  // it is asserted at page level rather than scoped to the dialog — scoped
  // to the toast region by its `'Oznámení'` accessible name, because
  // Next.js's own route announcer also carries a bare `role="alert"` and
  // `getByRole('alert')` alone matches both. The dialog itself stays open
  // regardless, per `admin-spots-screen.tsx`'s `onConfirm` (left open so the
  // retry affordance is visible).
  await expect(
    adminPage.getByRole('region', { name: 'Oznámení' }).getByRole('alert')
  ).toContainText('Na tomto místě jsou rezervace ode dneška dál. Nejdřív je zrušte.');
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Zrušit', exact: true }).click();
  await expect(confirmDialog).toBeHidden();

  // Give the bay back …
  await userPage.goto(LOT_PATH);
  await goToDate(userPage, DATE);
  await cancelReservation(userPage, SPOT);
  await expectFree(userPage, SPOT);

  // … and the same delete now goes through.
  await row.getByRole('button', { name: 'Smazat' }).click();
  const secondConfirmDialog = deleteConfirmDialog(adminPage);
  await expect(secondConfirmDialog).toBeVisible();
  await secondConfirmDialog.getByRole('button', { name: 'Smazat', exact: true }).click();
  await expect(secondConfirmDialog).toBeHidden();

  // Retired means gone from the lot, not merely unbookable: `overview.day`
  // reads `listActive()`, so there is no tile — not a locked one — at all.
  // A reload is required to see it: `libs/garage/contract/src/realtime/events.ts`
  // carries no event for a spot's lifecycle (only cell locks and reservation/
  // waitlist changes), so `userPage` — last navigated before the deactivation
  // happened in the admin's browser — has nothing pushing it to refetch.
  await userPage.reload();
  await goToDate(userPage, DATE);
  await expect(spotTile(userPage, SPOT)).toHaveCount(0);
});

test('the active toggle controls whether the spot is offered on the lot overview', async ({
  adminPage,
  userPage,
}) => {
  const panel = await goToAdminTab(adminPage, 'spots');
  const row = tableRow(panel, SPOT);
  const toggle = row.getByRole('switch', { name: `Aktivní místo ${SPOT}` });

  // Retired by the previous test; reactivate it to see the toggle's own
  // effect rather than reading a state the delete flow already produced. The
  // row still carries the "Neaktivní" badge at this point, so its label cell's
  // accessible name is "E2E.01 Neaktivní" rather than "E2E.01" alone —
  // `tableRow` (support/admin-page.ts) is written to match that on purpose,
  // anchoring on the label's start rather than the whole cell text.
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();

  await userPage.goto(LOT_PATH);
  await goToDate(userPage, DATE);
  await expectFree(userPage, SPOT);

  // Switch it back off: same disappearance as the delete test, reached
  // through the inline control instead of the confirm dialog.
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await userPage.reload();
  await goToDate(userPage, DATE);
  await expect(spotTile(userPage, SPOT)).toHaveCount(0);

  // Left inactive and unreserved — as removed as a spot can ever be
  // (`spots.service.ts`: it is never deleted, only retired), so a later run
  // of this file finds nothing to tolerate.
});
