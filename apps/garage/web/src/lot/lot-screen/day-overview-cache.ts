/**
 * How a realtime broadcast becomes a change to the day overview in the query
 * cache.
 *
 * `plan.md` (Fáze 6) requires **one** mechanism — "realtime events
 * invalidate/patch the query cache, no ad-hoc local state" — and this module
 * is the whole of it. The rule it implements, in one sentence:
 *
 * > **Patch the shared fields the payload determines; additionally invalidate
 * > when the event can move a viewer-relative field the broadcast is
 * > forbidden to carry.**
 *
 * The second half is not defensiveness, it is the contract. A day room is
 * shared by everybody looking at that day, so a payload may not say anything
 * viewer-relative — `waitlistUpdatedEventSchema` spells this out: "there is no
 * way to broadcast 'your position is now 2' to a room without telling everyone
 * else who is in the queue". `viewerWaitlistPosition`,
 * `viewerWaitlistEntryId`, `viewerReservationId` and `canReserve` therefore
 * cannot be patched from an event, and the only honest way to learn their new
 * values is to ask for the day again.
 *
 * Patching *and* invalidating is not redundant work: the patch repaints the
 * grid on the same tick the event arrived, and the refetch corrects the four
 * viewer fields a moment later. Invalidating alone would leave the tile stale
 * for a round trip; patching alone would leave "you are 2nd in the queue"
 * wrong indefinitely.
 *
 * Every function here is pure and returns the **same object reference** when
 * nothing changed, so an event for another day — a client is typically in
 * several day rooms, and Socket.io does not tell a handler which room a
 * message arrived through — costs one comparison and no re-render.
 */

import type { DayOverviewOutput, DaySpotOverview, ReservationHolder } from '@garage/contract';
// The realtime half of the contract is a **separate** entry point, on purpose:
// it must stay free of `@orpc/contract` (`libs/garage/contract/src/realtime/index.ts`).
// Importing these from `@garage/contract` would not even compile.
import type {
  CellRef,
  ReservationCancelledEvent,
  ReservationCreatedEvent,
  ReservationReassignedEvent,
  TimedReservationsUpdatedEvent,
  WaitlistUpdatedEvent,
} from '@garage/contract/realtime';

/**
 * Whether an event describes the day this cache entry holds.
 *
 * Both halves matter. The date guard is the one that keeps a second open day
 * from corrupting this one. The spot guard catches an event for a spot that
 * was deactivated, or added, since this overview was fetched — mapping over
 * the rows would then silently produce an identical array and a pointless
 * re-render.
 *
 * `CellRef` is the contract's own name for the pair, and the one every event
 * below is built on; the server calls the same shape `LockCell`
 * (`apps/garage/api/src/realtime/lock.service.ts`). Re-declaring it structurally here
 * would be a second definition of a shape the contract owns.
 */
function locate(day: DayOverviewOutput, event: CellRef): number {
  if (day.date !== event.date) return -1;
  return day.spots.findIndex((row) => row.spot.id === event.parkingSpotId);
}

/** Replaces one row, preserving the array's identity when nothing moved. */
function replaceRow(
  day: DayOverviewOutput,
  index: number,
  next: DaySpotOverview
): DayOverviewOutput {
  // `day.spots[index]` is `DaySpotOverview | undefined` only because
  // `noUncheckedIndexedAccess` cannot see that `locate` already bounds
  // `index` — every real caller here builds `next` with a fresh object
  // spread, so `current === next` can never be true and is not checked.
  const current = day.spots[index];
  if (current === undefined) return day;

  const spots = day.spots.slice();
  spots[index] = next;
  return { ...day, spots };
}

/**
 * `reservation:created` — a free cell is now taken.
 *
 * The whole `publicReservation` travels with the event precisely so this can
 * be a patch rather than a refetch (`reservationCreatedEventSchema`: "a client
 * that had to re-fetch the day to learn them would defeat the point of the
 * broadcast").
 */
export function applyReservationCreated(
  day: DayOverviewOutput,
  event: ReservationCreatedEvent
): DayOverviewOutput {
  const index = locate(day, event);
  if (index === -1) return day;

  const row = day.spots[index];
  if (row === undefined || row.reservation?.id === event.reservation.id) return day;

  return replaceRow(day, index, { ...row, reservation: event.reservation });
}

/**
 * `reservation:cancelled` — a taken cell is now free, and **stays** free.
 *
 * A cancellation that promoted somebody arrives as `reservation:reassigned`
 * instead, never as a cancel followed by a create
 * (`doc/decision/0022-*`) — so clearing the holder here cannot flash a cell
 * empty that is about to be refilled.
 *
 * Guarded on the id: a cancel for a reservation this client no longer shows
 * (it has already been replaced by a newer one) must not blank a cell
 * somebody else now holds.
 */
export function applyReservationCancelled(
  day: DayOverviewOutput,
  event: ReservationCancelledEvent
): DayOverviewOutput {
  const index = locate(day, event);
  if (index === -1) return day;

  const row = day.spots[index];
  if (row === undefined || row.reservation === null) return day;
  if (row.reservation.id !== event.reservationId) return day;

  return replaceRow(day, index, { ...row, reservation: null });
}

/**
 * `reservation:reassigned` — the cell changed hands inside one transaction.
 *
 * Deliberately a different event from `created` (`doc/decision/0022-*`):
 * auto-promotion is a system action exempt from the reservation-window lock,
 * so a `created` arriving in a locked month would look like a violated window.
 * For the cache the effect is the same — the new holder replaces the old.
 */
export function applyReservationReassigned(
  day: DayOverviewOutput,
  event: ReservationReassignedEvent
): DayOverviewOutput {
  const index = locate(day, event);
  if (index === -1) return day;

  const row = day.spots[index];
  if (row === undefined || row.reservation?.id === event.reservation.id) return day;

  return replaceRow(day, index, { ...row, reservation: event.reservation });
}

/**
 * `waitlist:updated` — the queue for one cell got longer or shorter.
 *
 * Only `waitlistCount` is patched, because only `waitlistCount` is in the
 * payload. The caller's own position is a viewer-relative field and is
 * corrected by the invalidation that {@link waitlistUpdatedTouchesViewer}
 * asks for.
 */
export function applyWaitlistUpdated(
  day: DayOverviewOutput,
  event: WaitlistUpdatedEvent
): DayOverviewOutput {
  const index = locate(day, event);
  if (index === -1) return day;

  const row = day.spots[index];
  if (row === undefined || row.waitlistCount === event.waitlistCount) return day;

  return replaceRow(day, index, { ...row, waitlistCount: event.waitlistCount });
}

/**
 * `timed-reservations:updated` — the guest blocks on one cell changed (a
 * create or a cancel).
 *
 * The **whole current list** replaces what was cached, same as `waitlistCount`
 * above and for the same reason: a client that missed one event self-heals on
 * the next rather than drifting. No viewer-relative field depends on a guest
 * block — a block has no `userId` and no queue position — so there is nothing
 * for a `touchesViewer` predicate to catch and none is exported for this event.
 */
export function applyTimedReservationsUpdated(
  day: DayOverviewOutput,
  event: TimedReservationsUpdatedEvent
): DayOverviewOutput {
  const index = locate(day, event);
  if (index === -1) return day;

  const row = day.spots[index];
  if (row === undefined) return day;

  return replaceRow(day, index, { ...row, timedReservations: event.timedReservations });
}

/** The row this event is about, or `null` if it is about another day or spot. */
function rowFor(day: DayOverviewOutput, event: CellRef): DaySpotOverview | null {
  const index = locate(day, event);
  return index === -1 ? null : (day.spots[index] ?? null);
}

/**
 * Whether a `reservation:created` / `reservation:reassigned` payload's holder is
 * this viewer. A guest holder never is — the `GUEST` member has no `userId`.
 */
function holderIsViewer(holder: ReservationHolder, viewerUserId: string | null): boolean {
  return holder.kind === 'USER' && viewerUserId !== null && holder.userId === viewerUserId;
}

/**
 * Does this `reservation:created` change something only a refetch can tell us?
 *
 * Yes when the caller is the new holder: `viewerReservationId` gains a value,
 * and `canReserve` flips to `false` for the rest of the day under the
 * one-reservation-per-user-and-day rule. That happens on this client's own
 * mutation (already invalidated) but also when the same user books from a
 * second tab, which is the case this covers.
 */
export function reservationCreatedTouchesViewer(
  event: ReservationCreatedEvent,
  viewerUserId: string | null
): boolean {
  return holderIsViewer(event.reservation.holder, viewerUserId);
}

/**
 * Yes when the reservation that went away was the caller's own —
 * `viewerReservationId` clears and `canReserve` may come back.
 *
 * Read off `day.viewerReservationId` rather than off the payload, because the
 * payload carries only an id and no holder: `reservationCancelledEventSchema`
 * says "who *used* to be editing is of no use to anybody once they have
 * stopped", and the same reasoning applies to the former holder.
 */
export function reservationCancelledTouchesViewer(
  day: DayOverviewOutput,
  event: ReservationCancelledEvent
): boolean {
  return day.viewerReservationId !== null && day.viewerReservationId === event.reservationId;
}

/**
 * Yes in three separate situations, all of which move a viewer field:
 *
 * - the caller was **promoted** into the cell — they gain a reservation and
 *   lose a queue entry;
 * - the caller was the **previous** holder (an admin cancelled for them, and
 *   the cell went straight to the queue) — they lose one;
 * - the caller is **queued** for this cell — the entry ahead of them was
 *   consumed, so `viewerWaitlistPosition` moved even though their own entry
 *   did not change.
 *
 * The third subsumes checking `fromWaitlistEntryId`, which is why that field
 * is not read here.
 */
export function reservationReassignedTouchesViewer(
  day: DayOverviewOutput,
  event: ReservationReassignedEvent,
  viewerUserId: string | null
): boolean {
  if (holderIsViewer(event.reservation.holder, viewerUserId)) return true;
  if (day.viewerReservationId !== null && day.viewerReservationId === event.previousReservationId) {
    return true;
  }
  return rowFor(day, event)?.viewerWaitlistEntryId != null;
}

/**
 * Yes when the caller is in this cell's queue: somebody ahead of or behind
 * them joined or left, so their 1-based position may have moved even though
 * their entry did not.
 */
export function waitlistUpdatedTouchesViewer(
  day: DayOverviewOutput,
  event: WaitlistUpdatedEvent
): boolean {
  return rowFor(day, event)?.viewerWaitlistEntryId != null;
}
