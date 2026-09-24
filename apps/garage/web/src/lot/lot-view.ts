/**
 * Everything the parking screen decides, as pure functions.
 *
 * The screen is a lot of conditional rendering, and conditional rendering is
 * the part of a UI that is cheapest to get wrong and most expensive to test
 * through the DOM. So the decisions live here — no React, no hooks, no
 * network — and the components below take the result and draw it. Each
 * function is transcribed from the design's own state machine
 * (`doc/design/lets-park-design.dc.html`, the `renderVals()` method), which is
 * the source of truth for this screen.
 *
 * Two rules the design does not state but the contract does, and which win
 * where they differ (see `doc/decision/0121-*`):
 *
 * 1. **`canReserve` is the backend's answer, never re-derived here.**
 *    `dayOverviewOutputSchema` says so in as many words: it already accounts
 *    for the window, the admin exemption, past dates and business days. The
 *    design's `ruleLocked = !windowOpen && !admin` is the same predicate for
 *    the two window cases and silently wrong for the other two.
 * 2. **`windowFrom`/`windowTo` are hypothetical unless `lockMode === 'AUTO'`.**
 *    A dated banner sentence under a forced mode would be a false statement.
 */

import {
  czechPublicHolidayOn,
  isWeekend,
  parseDateOnly,
  startOfYearMonth,
  type DateFormatters,
  type DateOnly,
} from '@garage/i18n';
import type {
  AdminUser,
  DaySpotOverview,
  MonthWindowOverview,
  ParkingGroup,
  PublicTimedReservation,
} from '@garage/contract';
import type { RealtimeStatus } from '@garage/realtime-client';
import { CAR_COLOR_PALETTE } from '@garage/design-system/tokens';
import type { HolderOption } from './spot-dialog/holder-input';

/**
 * Group order on screen. Taken from the contract's closed enum rather than
 * written out, so a group added there cannot be silently dropped from the lot
 * — `PARKING_GROUPS` is `['IT', 'SHARED']` and the design draws them in that
 * order.
 */
export const LOT_GROUP_ORDER: readonly ParkingGroup[] = ['IT', 'SHARED'];

/**
 * Which of the three car colours a user's car is drawn in.
 *
 * `doc/design/README.md` requires this be "deterministically per user, not
 * randomly — otherwise a car's color would change on every render", and
 * `car-palette.ts` repeats it: the design system holds the palette and the
 * consumer picks the index, because picking needs to know what the subject is.
 *
 * FNV-1a over the UTF-16 code units of the id, folded to 32 bits. Any stable
 * hash would do; this one is four lines, has no dependency, and spreads the
 * v7 UUIDs this application uses (whose leading bytes are a timestamp, so a
 * naive "first character" scheme would colour everybody created in the same
 * millisecond alike).
 */
export function carColorIndex(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    // FNV prime, via shifts: `hash * 16777619` overflows a double's integer
    // range and stops being exact after a few rounds.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash % CAR_COLOR_PALETTE.length;
}

/**
 * `--color-car-1..3` (`theme.css`), as `var()` references rather than
 * Tailwind utilities — `car-glyph.tsx` sets these directly as an SVG `fill`
 * presentation attribute, not through a `className`, so there is no utility
 * to spell here for the app to spend.
 */
export const CAR_COLOR_VARS = [
  'var(--color-car-1)',
  'var(--color-car-2)',
  'var(--color-car-3)',
] as const;

/**
 * A guest's car glyph. Deliberately outside {@link CAR_COLOR_VARS}: those
 * are a stable hash of a user id, and a guest has no id — falling through to
 * index 0 would hand every guest the first user's colour.
 */
export const GUEST_CAR_COLOR_VAR = 'var(--color-fg-3)';

/** The car glyph's fill for one holder. Stable for the life of that user. */
export function carColorVar(userId: string): string {
  return CAR_COLOR_VARS[carColorIndex(userId)] ?? CAR_COLOR_VARS[0];
}

/** Somebody else's editing hold, as the grid needs to draw it. */
export interface CellLockView {
  readonly holderId: string;
  readonly holderName: string;
  /** ISO UTC. The map that owns these drops an entry once it passes. */
  readonly expiresAt: string;
}

export interface LotViewContext {
  /**
   * Straight from `overview.day`. **Not** re-derived from `window` — see the
   * module docs.
   */
  readonly canReserve: boolean;
  readonly isAdmin: boolean;
  /** `null` while `me.get` is in flight; see {@link SpotView.isMine}. */
  readonly viewerUserId: string | null;
  /** Live cell locks, keyed by `parkingSpotId`. */
  readonly locks: ReadonlyMap<string, CellLockView>;
  /**
   * The caller's own reservation for this day, if any — straight from
   * `overview.day.viewerReservationId` (`libs/garage/contract/src/api/overview.ts`),
   * never re-derived. There is at most one, by the "one reservation per user
   * and day" rule, so its mere presence — regardless of *which* spot it names
   * — is what `toSpotView` needs to refuse `reserve`/`queue` on every spot
   * that isn't it.
   */
  readonly viewerReservationId: string | null;
}

/**
 * What a tile does when it is clicked.
 *
 * - `reserve` — free, and this caller may book it.
 * - `queue` — somebody else holds it.
 * - `mine` — this caller holds it; the modal offers cancelling.
 * - `info` — free, but this caller may not book this day. The modal explains
 *   why rather than the tile being inert, which is the design's behaviour
 *   (`if (ruleLocked && !taken) { … modal.info … }`).
 * - `none` — somebody else is editing it. The design returns early on a
 *   locked cell and so does this.
 *
 * `'info'` on a `'timed'` spot is the same mechanics as the other two `info`
 * reasons — no primary button, no cell lock — with its own explanation:
 * the spot cannot take a full-day reservation while it holds guest blocks.
 */
export type SpotAction = 'reserve' | 'queue' | 'mine' | 'info' | 'none';

/**
 * How a tile is drawn. Mirrors the design's four `sc-if` branches, plus
 * `'timed'`: free of a full-day holder but carrying one or more guest blocks
 * for part of the day (Task 6). Drawn like `'free'` — same frame, no car
 * glyph — with the blocks' time ranges in place of "Volné".
 */
export type SpotAppearance = 'free' | 'taken' | 'window-locked' | 'editing' | 'timed';

export interface SpotView {
  readonly spotId: string;
  readonly label: string;
  readonly appearance: SpotAppearance;
  readonly action: SpotAction;
  /** Holder's name, for `taken`. */
  readonly holderName: string | null;
  readonly holderPlate: string | null;
  /**
   * The car glyph's fill, as a `var(...)` reference, for `taken`. The field
   * keeps this name — not `carColorVar` — because `spot-dialog.tsx` (a
   * different agent's file) constructs this same shape in its own fixtures;
   * renaming the field would break a file this task does not own. Only the
   * *value* changed, from a Tailwind class to a CSS custom-property
   * reference — see `carColorVar()` below.
   */
  readonly carColorClass: string | null;
  /** Who is editing, for `editing`. */
  readonly editorName: string | null;
  /** The yellow pill; drawn whenever anybody is queued, in every appearance. */
  readonly waitlistCount: number;
  /** This caller holds the reservation. `false` while the viewer is unknown. */
  readonly isMine: boolean;
  /** This caller is in this spot's queue for this day. */
  readonly viewerWaitlistEntryId: string | null;
  readonly viewerWaitlistPosition: number | null;
  /** The `⋯` button: `admin && taken`, exactly as the design has it. */
  readonly showAdminMenu: boolean;
  /**
   * The holder is a guest an admin booked the bay for. There is no user behind
   * the name, so it is never `isMine` and never carries a per-user car colour.
   */
  readonly holderIsGuest: boolean;
  /**
   * Which explanation `action === 'info'` is for, or `null` when the action
   * isn't `'info'`. All three reasons reuse the same dialog mechanics (no
   * primary button, no cell lock taken — see `lot-screen.tsx`) but need
   * different copy: `'window-locked'` is "this day/month is closed",
   * `'already-reserved'` is "you already hold a spot today, cancel it
   * first", `'timed'` is "part of the day is already booked for a guest" —
   * conflating them would, for instance, tell a viewer sitting on their own
   * reservation that the *month* is locked, which is false.
   */
  readonly infoReason: 'window-locked' | 'already-reserved' | 'timed' | null;
  /**
   * The guest blocks a `'timed'` spot carries, ascending by `startTime` —
   * straight from `row.timedReservations`. Empty for every other appearance.
   */
  readonly timedBlocks: readonly PublicTimedReservation[];
}

/**
 * `'9:00–10:30'` — leading zero stripped off the hour (the design never
 * writes "09:00"), minutes kept as-is, joined with an en dash. `'24:00'`
 * (midnight, end-of-day) has no leading zero to strip and is left alone.
 */
export function formatTimeRange(block: { startTime: string; endTime: string }): string {
  const stripHourZero = (time: string): string => time.replace(/^0/, '');
  return `${stripHourZero(block.startTime)}–${stripHourZero(block.endTime)}`;
}

/**
 * One row of `overview.day` as a tile.
 *
 * The precedence is the design's, and the order matters: a cell lock **wins
 * over** an occupied spot (`taken = !!sp.name && !locked`), so a tile being
 * edited hatches whether or not somebody holds it. A lock held by *this*
 * client is ignored — the caller with the form open must not see their own
 * tile hatched, and whether the gateway echoes a broadcast to its sender is
 * Task 15's business, not something this screen should depend on.
 */
export function toSpotView(row: DaySpotOverview, context: LotViewContext): SpotView {
  const rawLock = context.locks.get(row.spot.id) ?? null;
  const lock = rawLock !== null && rawLock.holderId === context.viewerUserId ? null : rawLock;

  const reservation = row.reservation;
  const isTaken = reservation !== null && lock === null;
  const holder = reservation?.holder ?? null;
  // `context.viewerUserId !== null` is **redundant, and knowingly so** — the
  // same shape as `reservationCreatedTouchesViewer` in `day-overview-cache.ts`,
  // for the same reason: `holder.userId` is `idSchema` (a UUID string), so
  // `userId === null` is unrepresentable and the comparison alone already
  // answers `false` for an unknown viewer. Kept because it states the intent
  // ("an unknown viewer is never the holder") at the one place a reader looks
  // for it. It is not load-bearing; do not add a test for it.
  //
  // A guest is never `isMine`: the `GUEST` member of the union has no `userId`
  // to compare, which is the whole point of it being a discriminated union.
  const isMine =
    holder !== null && holder.kind === 'USER' && context.viewerUserId !== null
      ? holder.userId === context.viewerUserId
      : false;

  const timedBlocks = row.timedReservations;
  // The database refuses a full-day `reservation` alongside any guest block
  // (`doc/decision/0314-*`), so `hasBlocks` and `isTaken` are mutually
  // exclusive in practice; `reservation === null` here states that rather
  // than leaning on it.
  const hasBlocks = reservation === null && timedBlocks.length > 0;

  // Precedence: lock > full-day holder > guest blocks > free / window-locked.
  const appearance: SpotAppearance =
    lock !== null
      ? 'editing'
      : isTaken
        ? 'taken'
        : hasBlocks
          ? 'timed'
          : context.canReserve
            ? 'free'
            : 'window-locked';

  // The viewer already holds *some* reservation this day, and it isn't this
  // row: a *new* reserve or queue-join here would only earn a
  // `RESERVATION_LIMIT_REACHED` from the backend (`ReservationsService.create`,
  // `WaitlistService.join`), so neither may be offered — see the module docs'
  // rule 1, extended to this contract-supplied fact the same way it already
  // applies to `canReserve`. **Giving something back is never blocked by it**:
  // a queue entry the viewer already holds on this row is left untouched
  // (`'queue'`, not `'info'`) precisely so `viewerWaitlistEntryId`'s leave
  // path stays reachable — this mirrors `'mine'` staying reachable for a
  // reservation the viewer already holds.
  const viewerBookedElsewhere = context.viewerReservationId !== null && !isMine;
  const alreadyQueuedHere = row.viewerWaitlistEntryId !== null;

  const action: SpotAction =
    appearance === 'editing'
      ? 'none'
      : appearance === 'taken'
        ? isMine
          ? 'mine'
          : viewerBookedElsewhere && !alreadyQueuedHere
            ? 'info'
            : 'queue'
        : appearance === 'free'
          ? viewerBookedElsewhere
            ? 'info'
            : 'reserve'
          : appearance === 'timed'
            ? context.isAdmin && context.canReserve
              ? 'reserve'
              : 'info'
            : 'info';

  const infoReason: SpotView['infoReason'] =
    action !== 'info'
      ? null
      : appearance === 'window-locked'
        ? 'window-locked'
        : appearance === 'timed'
          ? context.canReserve
            ? 'timed'
            : 'window-locked'
          : 'already-reserved';

  return {
    spotId: row.spot.id,
    label: row.spot.label,
    appearance,
    action,
    holderName: isTaken && holder !== null ? holder.name : null,
    holderPlate: isTaken && holder !== null ? holder.licensePlate : null,
    carColorClass:
      isTaken && holder !== null
        ? holder.kind === 'USER'
          ? carColorVar(holder.userId)
          : GUEST_CAR_COLOR_VAR
        : null,
    editorName: lock?.holderName ?? null,
    waitlistCount: row.waitlistCount,
    isMine,
    viewerWaitlistEntryId: row.viewerWaitlistEntryId,
    viewerWaitlistPosition: row.viewerWaitlistPosition,
    showAdminMenu: context.isAdmin && isTaken,
    holderIsGuest: holder !== null && holder.kind === 'GUEST',
    infoReason,
    timedBlocks: hasBlocks ? timedBlocks : [],
  };
}

export interface SpotGroupView {
  readonly group: ParkingGroup;
  readonly spots: readonly SpotView[];
  /** Numerator of the design's "1 z 4 volných". */
  readonly freeCount: number;
  readonly totalCount: number;
}

/**
 * The rows split into the design's two labelled bands.
 *
 * A group with no active spots is **omitted** rather than drawn as an empty
 * rule with "0 z 0 volných", which is noise. The design always renders both
 * because its fixture always has both.
 *
 * `freeCount` counts a spot as free when it has neither a holder nor a lock —
 * the design's `list.filter(s => !s.name && !s.lockedBy)`. Note it deliberately
 * does **not** consult `canReserve`: a `⊘` tile is still an unoccupied spot,
 * and telling an admin "0 z 4 volných" for a lot they can still book would be
 * wrong. A `'timed'` tile is excluded too: it carries guest blocks and cannot
 * take a full-day reservation, so it is not free in the sense this count means.
 */
export function toGroupViews(
  rows: readonly DaySpotOverview[],
  context: LotViewContext
): readonly SpotGroupView[] {
  return LOT_GROUP_ORDER.flatMap((group) => {
    const inGroup = rows.filter((row) => row.spot.group === group);
    if (inGroup.length === 0) return [];

    const spots = inGroup.map((row) => toSpotView(row, context));
    return [
      {
        group,
        spots,
        freeCount: spots.filter(
          (spot) =>
            spot.appearance !== 'taken' &&
            spot.appearance !== 'editing' &&
            spot.appearance !== 'timed'
        ).length,
        totalCount: spots.length,
      },
    ];
  });
}

export interface LotCounts {
  readonly free: number;
  readonly taken: number;
}

/**
 * The two header pills.
 *
 * Counted off the **rows**, not off the tiles, because the design counts them
 * that way (`active.filter(s => !s.name)`): a cell someone is editing is still
 * free or still taken, and flipping the header total every time a colleague
 * opens a form would be noise rather than information.
 */
export function toLotCounts(rows: readonly DaySpotOverview[]): LotCounts {
  // A row with guest blocks and no full-day holder still cannot take a
  // full-day reservation, so the header counts it on the "taken" side too.
  const taken = rows.filter(
    (row) => row.reservation !== null || row.timedReservations.length > 0
  ).length;
  return { free: rows.length - taken, taken };
}

export type BannerTone = 'success' | 'warning';

/** Which `lot` message the banner renders, and the values it needs. */
export type BannerMessageKey =
  | 'bannerOpen'
  | 'bannerOpenForced'
  | 'bannerLockedAdmin'
  | 'bannerLockedUser'
  | 'bannerNotYetOpen'
  | 'bannerNotYetOpenForced';

export interface BannerView {
  readonly tone: BannerTone;
  readonly messageKey: BannerMessageKey;
  /**
   * All three are always populated, so the message key can vary without the
   * call site having to vary its argument shape. `until` and `from` are the
   * empty string for the keys that do not interpolate them.
   */
  readonly values: { readonly month: string; readonly until: string; readonly from: string };
}

/**
 * The banner above the lot.
 *
 * There is always one: `overview.day` always carries a `window`, and each of
 * its three states has exactly one true sentence. See `doc/decision/0122-*`
 * for why the design's `showLockState` prototype prop is not a hiding rule.
 *
 * `windowFrom`/`windowTo` are only spoken under `lockMode: 'AUTO'`. Under
 * `FORCE_OPEN`/`FORCE_LOCKED` they are the range the automatic rule *would*
 * have produced and have no bearing on the state, so quoting a date from them
 * would be a false statement — `monthWindowOverviewSchema` says exactly this.
 */
export function toBannerView(
  window: MonthWindowOverview,
  isAdmin: boolean,
  /** Passed in rather than imported: this module is not a component and the locale is not global. */
  formatters: DateFormatters
): BannerView {
  const month = formatters.monthName(parseDateOnly(startOfYearMonth(window.month)).month);
  const isAuto = window.lockMode === 'AUTO';
  const values = {
    month,
    until: isAuto ? formatters.dayAndMonth(window.windowTo) : '',
    from: isAuto ? formatters.dayAndMonth(window.windowFrom) : '',
  };

  switch (window.state) {
    case 'OPEN':
      return {
        tone: 'success',
        messageKey: isAuto ? 'bannerOpen' : 'bannerOpenForced',
        values,
      };
    case 'LOCKED':
      return {
        tone: 'warning',
        messageKey: isAdmin ? 'bannerLockedAdmin' : 'bannerLockedUser',
        values,
      };
    case 'NOT_YET_OPEN':
      return {
        tone: 'warning',
        messageKey: isAuto ? 'bannerNotYetOpen' : 'bannerNotYetOpenForced',
        values,
      };
  }
}

/**
 * Which realtime notice, if any, sits above the map.
 *
 * - `rejected` — the gateway refused the handshake and the automatic retries
 *   are spent. There is something for the user to *do*, so this one carries
 *   the "Připojit znovu" button.
 * - `dropped` — the socket went away and is coming back on its own. Same
 *   sentence, no button: offering a control that duplicates what is already
 *   happening invites a click that changes nothing.
 * - `none` — live, or not live yet.
 */
export type RealtimeNoticeView = 'none' | 'dropped' | 'rejected';

/**
 * Whether to say that the board has stopped updating.
 *
 * `lot-header.tsx` already argues that a silently-frozen grid is the failure
 * worth naming, and the screen used to draw that argument for exactly one of
 * the four statuses — `rejected`. `disconnected` and `connecting` are the far
 * more common way to end up looking at a board that stopped four minutes ago
 * (an API restart, a proxy idle timeout, a laptop resume), and neither was
 * drawn anywhere.
 *
 * **`hasEverConnected` is the whole subtlety.** `RealtimeProvider` starts at
 * `disconnected` and stays there until the handshake finishes — and longer
 * still for a visitor whose session has not resolved, because `RealtimeBoundary`
 * holds the socket closed until then. A rule that read the status alone would
 * therefore flash "Živé aktualizace jsou odpojené" on every single page load,
 * which is worse than saying nothing: a warning that is usually wrong is a
 * warning nobody reads. Before the first `connected` there is no stale data to
 * warn about — the grid has not gone stale, it has not arrived.
 *
 * `rejected` is exempt from that rule and reported whenever it happens. It is
 * terminal by construction (`doc/decision/0061-*`), so there is no later state
 * that would correct it, and it is refused *credentials* rather than a slow
 * start.
 */
export function toRealtimeNoticeView(
  status: RealtimeStatus,
  hasEverConnected: boolean
): RealtimeNoticeView {
  if (status === 'rejected') return 'rejected';
  if (status === 'connected') return 'none';
  return hasEverConnected ? 'dropped' : 'none';
}

/** Which `lot` message the day bar's second line renders. */
export type DayNoteKey = 'holiday' | 'weekend' | 'workday';

export interface DayNoteView {
  readonly key: DayNoteKey;
  /** The holiday's official Czech name; the empty string otherwise. */
  readonly name: string;
  /** Whether the sticky bar takes its yellow "not an ordinary day" treatment. */
  readonly highlighted: boolean;
}

/**
 * The line under the date in the sticky day bar.
 *
 * The design has two cases — a public holiday, or "Pracovní den". A Saturday
 * would therefore be labelled a working day, which is false, and it matters
 * here rather than being pedantry: a weekend is one of the days
 * `isBusinessDay` refuses, so it is a day whose tiles will all be
 * `window-locked`, and the bar is the only place that says why.
 */
export function toDayNoteView(date: DateOnly): DayNoteView {
  const holiday = czechPublicHolidayOn(date);
  if (holiday !== null) {
    return { key: 'holiday', name: holiday.name, highlighted: true };
  }
  if (isWeekend(date)) {
    return { key: 'weekend', name: '', highlighted: true };
  }
  return { key: 'workday', name: '', highlighted: false };
}

/**
 * `admin.user.list`'s rows, as `SpotDialog`'s holder picker needs them.
 *
 * Used for both the holder picker (`LotScreen`'s `holderQuery`) and the
 * queue-target picker (`queueTargetQuery`) — the two queries differ in their
 * `enabled` condition and input, but the response shape and what a picker
 * wants from it are identical, so this mapping is shared rather than written
 * twice (`use-admin-user-options.ts` calls it once per query).
 */
export function toHolderOptions(users: readonly AdminUser[]): readonly HolderOption[] {
  return users.map((row) => ({
    userId: row.id,
    name: row.name,
    licensePlate: row.licensePlate,
  }));
}
