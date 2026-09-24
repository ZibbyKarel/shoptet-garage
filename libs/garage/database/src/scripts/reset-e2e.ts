/**
 * Puts the development database into the state the Playwright suite expects.
 *
 * Run from the repo root, with `DATABASE_URL` in the environment:
 *
 * ```
 * npx nx run database:reset-e2e
 * ```
 *
 * `apps/garage/web-e2e`'s `globalSetup` runs it (as a subprocess) before the browsers
 * start. Two things make that a subprocess rather than an import:
 *
 * 1. `libs/garage/database` is tagged `scope:api` and `apps/garage/web-e2e` is `scope:web`,
 *    so the module boundary — rightly — forbids the import. A test app is not a
 *    reason to weaken it.
 * 2. The Prisma client then never loads inside a Playwright worker, where it
 *    would hold a connection pool open for the length of the run.
 *
 * ## What it changes, and what it deliberately does not
 *
 * - **Deletes** every reservation and queue entry in the e2e target month (see
 *   {@link e2eTargetMonth}). Scoped to that month rather than truncating the
 *   tables, so a developer's own data on other days survives a test run.
 * - **Widens the reservation window** to {@link MAX_OPEN_DAYS_BEFORE} days, in
 *   `AUTO` mode. This is a *setting an admin can set in the UI*, not a
 *   test-only switch: with the seeded 7 days no month is bookable except during
 *   the last week of the preceding one, so on most days of the year a normal
 *   user could not create a reservation at all and half the scenarios would
 *   have nothing to exercise. At 31 days the *next* month is always open under
 *   the ordinary `AUTO` rule (its window starts on or before the first of the
 *   current month and ends on its last day), which is what the suite books
 *   into. See `doc/decision/0181-*`.
 * - **Deletes every parking spot that is not one of the nine seeded ones**,
 *   together with any reservation or queue entry on it. That is a spot an
 *   interrupted run of the spot-administration spec created and did not clean
 *   up, and nothing else would ever remove it: the seed is upserts on the
 *   natural key, so it restores the nine and is silent about a tenth.
 * - Touches **no seeded spot, and no user or role**: `prisma db seed` owns
 *   those, is idempotent, and `globalSetup` runs it first — so a role or an
 *   `active` flag an admin spec changed heals itself before the next run.
 *
 * ## What stops it doing that to a real database
 *
 * {@link assertDisposableDatabase}, run before anything else, and the target
 * host is printed either way. "Delete a month of reservations" is not a thing
 * that should ever be one stray environment variable away from a real database.
 *
 * This file used to say the same sentence and then check
 * `NODE_ENV === 'production'`, which is **inert in exactly the situation it
 * existed for**: `NODE_ENV` is unset in a plain shell, `nx run
 * database:reset-e2e` sets only `SWC_NODE_PROJECT`, and `globalSetup` spawns
 * this script with whatever environment it inherited — while `DATABASE_URL`,
 * the variable that actually decides which database is emptied, was never
 * looked at. The final review found it as I-2. The guard now reads the
 * connection string; see
 * `doc/decision/0276-destructive-database-scripts-are-guarded-by-the-connection-string.md`.
 *
 * That guard is also what makes the un-restored reservation window below
 * defensible rather than merely acknowledged: the only databases this script
 * can reach without an explicit `GARAGE_ALLOW_DESTRUCTIVE_RESET=1` are ones
 * whose settings nobody is entitled to rely on between runs.
 *
 * ## `SWC_NODE_PROJECT`
 *
 * Both callers set `SWC_NODE_PROJECT=tsconfig.base.json`. This file imports
 * `@garage/shared-types` by its workspace alias rather than re-deriving the
 * month arithmetic, `@swc-node/register` resolves `paths` from the tsconfig it
 * is pointed at, and there is no `tsconfig.json` at the workspace root — so
 * without that variable the process dies with `Cannot find module
 * '@garage/shared-types'`. `seed.ts` needs no such thing because it imports
 * only relative paths.
 */

import {
  MAX_OPEN_DAYS_BEFORE,
  addMonths,
  endOfMonth,
  startOfMonth,
  todayInPrague,
  type DateOnly,
} from '@garage/shared-types';
import { createPrismaClient } from '../lib/create-prisma-client';
import { assertDisposableDatabase } from '../lib/disposable-database';
import { RESERVATION_WINDOW_SETTINGS_ID, SEED_PARKING_SPOTS } from '../lib/seed-data';

/**
 * The month the e2e suite books into: the one after today's.
 *
 * The current month is already running by whatever day `today` falls on, so
 * it may have too few remaining business days left for every spec's slot,
 * and running specs would collide with dates already used or passed in
 * earlier runs. "Next month" is always a full, untouched month — every day is
 * still ahead of `today`, so the suite gets the same clean slate on any day
 * it happens to run. Returned as its first and last day rather than as a
 * `YearMonth`, because that is what the delete range needs.
 */
export function e2eTargetMonth(today: DateOnly = todayInPrague()): {
  readonly from: DateOnly;
  readonly to: DateOnly;
} {
  const anchor = addMonths(startOfMonth(today), 1);
  return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
}

/** `YYYY-MM-DD` as the UTC midnight Prisma stores in a `@db.Date` column. */
function toDateColumn(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function main(): Promise<void> {
  // Before anything is read, and long before anything is deleted: which
  // database is this, and am I allowed to empty a month of it?
  const target = assertDisposableDatabase(process.env['DATABASE_URL']);
  console.log(
    `reset-e2e target: database "${target.database}" on ${target.host}` +
      (target.overridden ? ' (GARAGE_ALLOW_DESTRUCTIVE_RESET=1).' : '.')
  );

  const { from, to } = e2eTargetMonth();
  const range = { gte: toDateColumn(from), lte: toDateColumn(to) };

  const prisma = createPrismaClient({ connectionString: target.url });

  try {
    // Queue entries first: nothing references them, and deleting the
    // reservations first would leave a window in which a concurrently running
    // API could promote somebody into the month being cleared.
    const waitlist = await prisma.waitlistEntry.deleteMany({ where: { date: range } });
    const reservations = await prisma.reservation.deleteMany({ where: { date: range } });

    // **Spots the suite created and did not manage to clean up.** The spot
    // administration spec creates a spot, and an interrupted run — a failed
    // assertion before its teardown, a Ctrl-C — leaves it behind. Nothing else
    // would ever remove it: `prisma db seed` is upserts on the natural key, so
    // it restores the nine seeded rows and is silent about a tenth. The
    // leftover would then be permanent, and every later run would start in a
    // different world than the one its author measured — a parking lot with an
    // extra bay, one more row in every admin table, one more `<option>` in
    // every holder selector.
    //
    // Deleted here rather than in a spec's `afterAll` for the reason the
    // reservations above are: this script's job is to state what is true before
    // the first browser opens, and that has to hold however the previous run
    // ended. Reservations on such a spot go with it — `onDelete: Cascade` on
    // the relation, and the month sweep above has already taken the ones this
    // suite makes.
    const seededLabels = SEED_PARKING_SPOTS.map((spot) => spot.label);
    const strayReservations = await prisma.reservation.deleteMany({
      where: { parkingSpot: { label: { notIn: seededLabels } } },
    });
    const strayWaitlist = await prisma.waitlistEntry.deleteMany({
      where: { parkingSpot: { label: { notIn: seededLabels } } },
    });
    const strays = await prisma.parkingSpot.deleteMany({
      where: { label: { notIn: seededLabels } },
    });
    if (strays.count > 0) {
      console.log(
        `Removed ${strays.count} non-seeded parking spot(s) left over from an ` +
          `earlier run, with ${strayReservations.count} reservation(s) and ` +
          `${strayWaitlist.count} queue entrie(s) on them.`
      );
    }

    // **Not restored afterwards, and that is a stated term of this script's
    // contract, not an oversight.** The row is global and singular, so every
    // run leaves the database booking-open 31 days ahead until somebody
    // re-seeds. Three things make that acceptable rather than merely
    // acknowledged: it is a value an admin can legitimately set through the UI
    // (`doc/decision/0181-*`); a teardown that restored it would still be wrong
    // for anyone whose run was interrupted; and `assertDisposableDatabase`
    // above means the only databases reachable without an explicit override are
    // local ones whose settings nobody is entitled to rely on between runs.
    // `npx prisma db seed` puts it back to 7 days.
    await prisma.reservationWindowSettings.upsert({
      where: { id: RESERVATION_WINDOW_SETTINGS_ID },
      update: { openDaysBefore: MAX_OPEN_DAYS_BEFORE, lockMode: 'AUTO' },
      create: {
        id: RESERVATION_WINDOW_SETTINGS_ID,
        openDaysBefore: MAX_OPEN_DAYS_BEFORE,
        lockMode: 'AUTO',
      },
    });

    console.log(
      `Reset ${from}..${to}: deleted ${reservations.count} reservation(s) and ` +
        `${waitlist.count} queue entrie(s); reservation window is AUTO / ` +
        `${MAX_OPEN_DAYS_BEFORE} days.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
