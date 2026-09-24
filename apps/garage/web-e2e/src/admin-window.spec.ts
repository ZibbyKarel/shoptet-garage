/**
 * Reservation-window administration: the "Rezervační okno" tab of `/admin`
 * (`apps/garage/web/src/shell/admin/admin-window-screen/admin-window-screen.tsx`).
 *
 * This is a browser-layer journey rather than a unit test for one central
 * reason: the screen's own claim is that the month list on the right is "podle
 * nastavení vlevo" — a **live read** of the setting next to it — and that can
 * only be demonstrated by actually changing the setting, through the real
 * `admin.window.update` mutation, and watching the list on the same screen
 * follow it. `admin-window-screen.spec.tsx` and `window-view.spec.ts` already
 * pin the mapping from `(state, lockMode)` to wording as a pure function; this
 * file exists to prove the connected screen wires that function to a real
 * save and a real refetch, and that an ordinary user's own overview reacts the
 * same way theirs does.
 *
 * ## Why `FORCE_LOCKED` is deliberately absent from this file
 *
 * The reservation-window settings row is a **global singleton**, shared by
 * every spec file running concurrently under `fullyParallel: true`.
 * `FORCE_LOCKED` ("Vynutit uzamčeno") would close the target month for every
 * other spec's bookings, and lowering `openDaysBefore` below the seeded
 * maximum (`MAX_OPEN_DAYS_BEFORE`, 31 — `libs/garage/database/src/scripts/reset-e2e.ts`)
 * would do the same by a different route. Neither is exercised here — this
 * file only ever moves between `AUTO` and `FORCE_OPEN`, which keeps the lot
 * open no matter what. The `FORCE_LOCKED` rule itself is already covered where
 * it is enforced: `apps/garage/api/src/reservations/reservation-policy.spec.ts`,
 * `reservations.db.spec.ts`, and `day-overview.service.spec.ts`.
 *
 * ## Serial, and why
 *
 * Not for isolation from other spec files — there is none, the settings row
 * is shared by design — but because this file's own story is a sequence: the
 * month list is asserted under `AUTO`, then under `FORCE_OPEN`, then across a
 * reload, and a later test's premise (`FORCE_OPEN` is active) must not race a
 * `test.describe`-level worker running an earlier one out of order.
 * `test.afterAll` restores `AUTO` unconditionally, exactly the way
 * `admin-users.spec.ts` restores its own mutable fixture — so a run that
 * starts after an earlier one was interrupted mid-file still ends up with the
 * month open for everybody, rather than depending on `prisma db seed` alone.
 */

import type { Locator, Page } from '@playwright/test';
import { e2eDayForSlot, SPEC_DAY_SLOTS } from './support/dates';
import { expect, test } from './support/fixtures';
import { expectWindowSettingsSaved, goToAdminTab, type AdminTab } from './support/admin-page';
import { LOT_PATH } from './support/oidc-login';
import { ADMIN, USER, storageStatePath } from './support/personas';
import {
  cancelReservation,
  expectFree,
  expectHeldBy,
  goToDate,
  reserveSpot,
} from './support/lot-page';

const DATE = e2eDayForSlot(SPEC_DAY_SLOTS.adminWindow);
// A SHARED bay, so a `IT`-department comment in `schema.prisma` never becomes
// this file's business — same reasoning `admin-reservation.spec.ts` gives for
// its own choice of `SECOND_SPOT`.
const SPOT = 'E2.62';

const WINDOW_TAB: AdminTab = 'window';

// cs.json's `admin` namespace: the segmented control's two pills this file is
// allowed to touch. `windowLockFORCE_LOCKED` ("Vynutit uzamčeno") is
// deliberately not named anywhere in this file — see the docblock above.
const LOCK_LABEL = {
  AUTO: 'Automaticky',
  FORCE_OPEN: 'Vynutit otevřeno',
} as const;

type LockMode = keyof typeof LOCK_LABEL;

// cs.json: admin.windowMonthRangeAuto ("otevřeno od {from}, limit do {to}") and
// admin.windowMonthRangeForced ("automaticky by bylo otevřeno od {from}, limit do {to}").
// The date itself is locale-formatted and moves with the calendar; the prefix
// tells the two keys apart, and stops short of the date.
const AUTO_RANGE_PATTERN = /^otevřeno od \d/u;
const FORCED_RANGE_PATTERN = /^automaticky by bylo otevřeno od \d/u;

test.describe.configure({ mode: 'serial' });

/**
 * The target month's own row in "Stav měsíců" — the second of the four listed
 * (`AdminWindowPanel`'s `MONTHS_LISTED = 4`, `from: today's month`).
 * `reservation-window.service.ts` pushes one row per month **ascending**, and
 * `e2eDayForSlot` (`dates.ts`) always lands in the month right after today's,
 * so that row is always index 1 — never today's own (running, so `OPEN` with no cap) and
 * never a `NOT_YET_OPEN` one further out.
 */
function targetMonthRow(panel: Locator): Locator {
  const monthsSection = panel.getByRole('region', { name: 'Stav měsíců' });
  return monthsSection.getByRole('listitem').nth(1);
}

/** The row's second paragraph — the range sentence, not the month heading. */
function rangeText(row: Locator): Locator {
  return row.locator('p').nth(1);
}

/**
 * Puts the reservation-window lock mode into `mode`, saving only if it is not
 * already there — so a repeated call, or one following an interrupted earlier
 * run, is a no-op rather than a spurious write. Returns the tab's panel, fresh
 * from `goToAdminTab`'s own navigation.
 */
async function ensureLockMode(page: Page, mode: LockMode): Promise<Locator> {
  const panel = await goToAdminTab(page, WINDOW_TAB);
  const radio = panel.getByRole('radio', { name: LOCK_LABEL[mode], exact: true });
  if (!(await radio.isChecked())) {
    await radio.click();
    await expectWindowSettingsSaved(page);
  }
  await expect(radio).toBeChecked();
  return panel;
}

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStatePath(ADMIN) });
  const page = await context.newPage();
  try {
    await ensureLockMode(page, 'AUTO');
  } finally {
    await context.close();
  }
});

test('the day-count stepper is pinned at its maximum and cannot be pushed higher', async ({
  adminPage,
}) => {
  const panel = await goToAdminTab(adminPage, WINDOW_TAB);
  // cs.json: admin.windowDaysLabel — the stepper's accessible name, a literal
  // caption ("Otevřít X dní předem"), not an interpolated one.
  const spinbutton = panel.getByRole('spinbutton', { name: 'Otevřít X dní předem' });
  const increment = panel.getByRole('button', { name: 'O den více' });

  // `reset-e2e.ts` always seeds `openDaysBefore` at `MAX_OPEN_DAYS_BEFORE`
  // (31), and nothing in this file ever lowers it — asserting the guard at
  // that value, rather than pressing the decrement stepper and having to
  // restore it, is the only way this test touches the boundary without ever
  // putting the target month's window at risk. `windowDaysValue`'s ICU plural
  // puts 31 in the `other` bucket in Czech (`Intl.PluralRules('cs')`: only 1
  // is "one", 2–4 is "few"), hence "31 dní" rather than "31 den"/"31 dny".
  await expect(spinbutton).toHaveAttribute('aria-valuenow', '31');
  await expect(spinbutton).toHaveText('31 dní');
  // `Stepper` disables its `+` button once `current >= max` (`stepper.tsx`),
  // so this can never fire a write — nothing here needs restoring.
  await expect(increment).toBeDisabled();
});

test('the month list is a live read of the lock mode, and both controls persist across reload', async ({
  adminPage,
}) => {
  let panel = await ensureLockMode(adminPage, 'AUTO');
  await expect(rangeText(targetMonthRow(panel))).toHaveText(AUTO_RANGE_PATTERN);

  panel = await ensureLockMode(adminPage, 'FORCE_OPEN');
  let row = targetMonthRow(panel);
  await expect(rangeText(row)).toHaveText(FORCED_RANGE_PATTERN);
  // cs.json: admin.windowStateOPEN. `FORCE_OPEN` forces every month's state to
  // `OPEN`, independent of where "today" actually falls in the calendar.
  await expect(row.getByText('Otevřeno', { exact: true })).toBeVisible();

  // Persistence, the honest way: a fresh navigation (`goToAdminTab` always
  // starts with `page.goto`), not the component's own still-mounted state.
  panel = await goToAdminTab(adminPage, WINDOW_TAB);
  await expect(
    panel.getByRole('radio', { name: LOCK_LABEL.FORCE_OPEN, exact: true })
  ).toBeChecked();
  row = targetMonthRow(panel);
  await expect(rangeText(row)).toHaveText(FORCED_RANGE_PATTERN);
  await expect(row.getByText('Otevřeno', { exact: true })).toBeVisible();
});

test('under FORCE_OPEN, an ordinary user still sees the forced-open banner and can reserve', async ({
  adminPage,
  userPage,
}) => {
  // Defensive rather than assumed: this test's premise is `FORCE_OPEN`, and it
  // must hold whether or not the previous test ran first.
  await ensureLockMode(adminPage, 'FORCE_OPEN');

  await userPage.goto(LOT_PATH);
  await goToDate(userPage, DATE);

  // `WindowBanner` in `lot-header.tsx` reads the `lot` namespace (not
  // `admin`'s own banner, which only the admin overview screen renders) and
  // renders as `role="status"`. `lot.bannerOpenForced` is
  // "Rezervace na {month} jsou otevřené." — the month name needs
  // `useDateFormatters().monthName`'s nominative table, which this file has no
  // access to (it lives behind `'use client'` React, and `dates.ts`'s own
  // table is genitive day-and-month, for a different key entirely). The
  // pattern below leaves the month out and pins the rest of the sentence,
  // which is exactly what tells `bannerOpenForced` apart from the automatic
  // `bannerOpen` (carries "— do … platí měsíční limit …") and from the locked /
  // not-yet-open keys.
  //
  // `role="status"` is not unique on this screen — `lot-header.tsx` also
  // raises one for the realtime-rejected notice, `screen-state.tsx`'s
  // `ScreenLoading` is one while data is in flight, and so is every `Toast`
  // — so the container is first narrowed to the one that opens with this
  // sentence. But the container's own text also carries the decorative
  // "✓"/"⊘" glyph `WindowBanner` renders next to the `<p>` (aria-hidden, but
  // still part of the status region's text node), which would sit in front of
  // the sentence and break the `^` anchor below. The sentence itself lives in
  // that `<p>`, and only asserting against it — not the container — keeps
  // both anchors meaningful, which is what tells `bannerOpenForced` apart from
  // the automatic `bannerOpen` ("… — do {until} platí měsíční limit rezervací, …").
  const banner = userPage.getByRole('status').filter({ hasText: 'Rezervace na' }).locator('p');
  await expect(banner).toHaveText(/^Rezervace na .+ jsou otevřené\.$/u);

  // FORCE_OPEN keeps the lot bookable regardless of the calendar, and an
  // ordinary user — not just an admin — gets that.
  await reserveSpot(userPage, SPOT);
  await expectHeldBy(userPage, SPOT, USER.displayName);

  // Leaves the bay as it was found, the way every other spec touching a
  // shared bay does.
  await cancelReservation(userPage, SPOT);
  await expectFree(userPage, SPOT);
});
