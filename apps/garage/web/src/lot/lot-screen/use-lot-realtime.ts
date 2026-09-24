'use client';

/**
 * Wires the day room's broadcasts onto the day overview in the query cache.
 *
 * The decisions all live in `./day-overview-cache` as pure functions; this
 * file is only the plumbing that reads the current cache entry, applies one,
 * writes it back and — when the event can have moved a viewer-relative field
 * — asks for a refetch. See that module's header for why both halves exist.
 *
 * Joining the room is here too, so a screen has exactly one call to make:
 * `useDayRoom` and the four listeners are the same subscription seen from two
 * angles, and splitting them across two hooks would make it possible to listen
 * without joining.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDayRoom, useRealtime, useRealtimeEvent } from '@garage/realtime-client';
import { useQueryClient } from '@tanstack/react-query';
import type { DayOverviewOutput } from '@garage/contract';
import type { DateOnly } from '@garage/i18n';
import { useApi } from '../../shell/api-provider/api-provider';
import {
  applyReservationCancelled,
  applyReservationCreated,
  applyReservationReassigned,
  applyTimedReservationsUpdated,
  applyWaitlistUpdated,
  reservationCancelledTouchesViewer,
  reservationCreatedTouchesViewer,
  reservationReassignedTouchesViewer,
  waitlistUpdatedTouchesViewer,
} from './day-overview-cache';

/** No viewer-relative field ever depends on a guest block — see `applyTimedReservationsUpdated`. */
function neverTouchesViewer(): boolean {
  return false;
}

export interface LotRealtimeOptions {
  /** The day on screen. `null` while there is none — no room is joined. */
  readonly date: DateOnly | null;
  /** From `me.get`; `null` while it is in flight. */
  readonly viewerUserId: string | null;
}

export function useLotRealtime({ date, viewerUserId }: LotRealtimeOptions): void {
  const api = useApi();
  const queryClient = useQueryClient();

  useDayRoom(date);

  // Derived from the contract through `createApiQueryUtils`, never spelled out
  // — a hand-written key that differed by one character would patch a cache
  // entry nothing reads, and the screen would look like the events had never
  // arrived. Memoised because `queryOptions()` mints a fresh array per call
  // and the callbacks below depend on it.
  const queryKey = useMemo(
    () => (date === null ? null : api.overview.day.queryOptions({ input: { date } }).queryKey),
    [api, date]
  );

  /**
   * One event, handled the one way: patch what the payload determines, then
   * invalidate if it may have moved something the payload is not allowed to
   * carry.
   *
   * `touches` is evaluated against the state the event arrived at, not the
   * patched one. Today the two agree — no patch writes a viewer field — and
   * evaluating against the pre-patch state keeps that a property of this
   * function rather than a coincidence of the four patches.
   */
  const handle = useCallback(
    <E>(
      event: E,
      apply: (day: DayOverviewOutput, event: E) => DayOverviewOutput,
      touchesViewer: (day: DayOverviewOutput, event: E) => boolean
    ) => {
      if (queryKey === null) return;

      const current = queryClient.getQueryData<DayOverviewOutput>(queryKey);
      // Nothing cached for this day: there is no stale render to correct and
      // nothing to refetch into. Whatever mounts next fetches it fresh.
      if (current === undefined) return;

      const next = apply(current, event);
      if (next !== current) queryClient.setQueryData(queryKey, next);
      if (touchesViewer(current, event)) void queryClient.invalidateQueries({ queryKey });
    },
    [queryClient, queryKey]
  );

  useRealtimeEvent(
    'reservation:created',
    useCallback(
      (event) => {
        handle(event, applyReservationCreated, (_day, created) =>
          reservationCreatedTouchesViewer(created, viewerUserId)
        );
      },
      [handle, viewerUserId]
    )
  );

  useRealtimeEvent(
    'reservation:cancelled',
    useCallback(
      (event) => {
        handle(event, applyReservationCancelled, reservationCancelledTouchesViewer);
      },
      [handle]
    )
  );

  useRealtimeEvent(
    'reservation:reassigned',
    useCallback(
      (event) => {
        handle(event, applyReservationReassigned, (day, reassigned) =>
          reservationReassignedTouchesViewer(day, reassigned, viewerUserId)
        );
      },
      [handle, viewerUserId]
    )
  );

  useRealtimeEvent(
    'waitlist:updated',
    useCallback(
      (event) => {
        handle(event, applyWaitlistUpdated, waitlistUpdatedTouchesViewer);
      },
      [handle]
    )
  );

  useRealtimeEvent(
    'timed-reservations:updated',
    useCallback(
      (event) => {
        handle(event, applyTimedReservationsUpdated, neverTouchesViewer);
      },
      [handle]
    )
  );

  useReconnectReconciliation(queryKey);
}

/**
 * Refetches the day the moment the socket comes back.
 *
 * **Why anything is needed at all.** The four handlers above patch the cache
 * from broadcasts. A broadcast published while the socket is down is not
 * queued anywhere — it is gone — and nothing else brings the entry back in
 * line: `libs/query` sets `refetchOnWindowFocus: false` and a 30 s
 * `staleTime`, and TanStack's `refetchOnReconnect` keys off `navigator.onLine`,
 * which says nothing about a socket that dropped for a reason other than the
 * network (an API restart, a proxy idle timeout, a laptop resume). Without
 * this the grid keeps drawing spots as free that somebody took during the gap,
 * until the user changes the date or writes something themselves.
 *
 * `use-cell-locks.ts` already handles the same event for locks — it empties the
 * map on a drop, because "unknown" must not be drawn as "nobody is editing".
 * This is the counterpart for the overview, where the honest recovery is to
 * ask the server again rather than to blank the screen.
 *
 * **An edge, not a level.** `useRealtime()` reports the current status only, so
 * the transition is derived here with a ref: any status other than `connected`
 * arms it, and the next `connected` fires and disarms it. A level check would
 * invalidate on every render while connected.
 *
 * The ref starts **disarmed**, and that is the whole difference between one
 * refetch and two on a page load. A hook mounting under an already-connected
 * socket (navigating between `/` and `/settings`, say) has missed nothing and
 * refetches nothing. A hook mounting on a cold page starts at `disconnected` —
 * `RealtimeProvider`'s initial status — which arms it, so the first `connected`
 * does fire: the window between the overview being fetched and the socket
 * finishing its handshake is a real gap, the same gap as any later one, and
 * this is the only thing that closes it.
 */
function useReconnectReconciliation(queryKey: readonly unknown[] | null): void {
  const queryClient = useQueryClient();
  const { status } = useRealtime();
  const missedBroadcasts = useRef(false);

  useEffect(() => {
    if (status !== 'connected') {
      // `connecting`, `disconnected` and `rejected` are all windows in which a
      // broadcast can be published and never delivered here. They differ in
      // what the *user* should be told (`RealtimeNotice`), not in what the
      // cache has to do about it.
      missedBroadcasts.current = true;
      return;
    }
    if (!missedBroadcasts.current) return;
    missedBroadcasts.current = false;
    if (queryKey === null) return;

    void queryClient.invalidateQueries({ queryKey });
  }, [status, queryKey, queryClient]);
}
