'use client';

/**
 * `AdminSpotsScreen`, connected to the API. Wiring only.
 *
 * Two queries feed one table: `admin.spot.list` for the rows (retired spots
 * included — this is the screen that un-retires them) and `overview.day` for
 * the "Stav dnes" column. The join is by spot id and is done here rather than
 * on the backend, because no contract procedure returns the pair and inventing
 * one for a single column would be a wider change than the column is worth.
 */

import { useMemo, useState } from 'react';
import type { CreateSpotInput, ParkingGroup } from '@garage/contract';
import { useRequireAuth } from '@garage/auth/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todayInPrague } from '@garage/i18n';
import { useApi } from '../api-provider/api-provider';
import { screenDataOf } from '../screen-state/screen-state';
import type { AdminWrite, AdminWriteFailure } from './admin-errors';
import { AdminSpotsScreen, type SpotToday } from './admin-spots-screen/admin-spots-screen';

export function AdminSpotsPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { status } = useRequireAuth();
  const enabled = status === 'authenticated';

  const [pendingSpotId, setPendingSpotId] = useState<string | null>(null);
  /**
   * Which write was asked for last.
   *
   * `admin.spot.update` backs three of them and its `CONFLICT` means something
   * different in each — a duplicate label when renaming, a spot somebody still
   * holds when switching one off, and nothing at all when switching one on. The
   * response cannot say which was intended, so the intent is recorded when the
   * call is made. See `./admin-errors.ts`.
   */
  const [lastWrite, setLastWrite] = useState<AdminWrite | null>(null);

  const spotsQuery = useQuery({
    ...api.admin.spot.list.queryOptions({ input: { includeInactive: true } }),
    enabled,
  });

  const dayQuery = useQuery({
    ...api.overview.day.queryOptions({ input: { date: todayInPrague() } }),
    enabled,
  });

  /**
   * Invalidates everything a spot change can be seen through: the admin table,
   * the plain `spot.list` behind the settings picker, and today's overview,
   * whose grid loses or gains a cell when a spot is retired, revived, hidden
   * or shown.
   */
  function invalidateSpotViews() {
    queryClient.invalidateQueries({ queryKey: api.admin.spot.key() });
    queryClient.invalidateQueries({ queryKey: api.spot.key() });
    queryClient.invalidateQueries({ queryKey: api.overview.key() });
  }

  const settled = () => {
    setPendingSpotId(null);
    invalidateSpotViews();
  };

  const createSpot = useMutation({
    ...api.admin.spot.create.mutationOptions(),
    onSettled: settled,
  });
  const updateSpot = useMutation({
    ...api.admin.spot.update.mutationOptions(),
    onSettled: settled,
  });
  const deactivateSpot = useMutation({
    ...api.admin.spot.deactivate.mutationOptions(),
    onSettled: settled,
  });

  const todayBySpotId = useMemo(() => {
    const map = new Map<string, SpotToday>();
    for (const row of dayQuery.data?.spots ?? []) {
      map.set(row.spot.id, {
        holderName: row.reservation?.holder.name ?? null,
        holderIsGuest: row.reservation?.holder.kind === 'GUEST',
      });
    }
    return map;
  }, [dayQuery.data]);

  // The last failure of whichever write ran most recently, paired with the
  // intent it came from. Only one write is ever in flight (the row and the
  // dialogs are disabled while one is), so "most recent" is unambiguous, and
  // `lastWrite` is always set by `startWrite` before any of the three can fail.
  const writeError = deactivateSpot.error ?? updateSpot.error ?? createSpot.error;
  const writeFailure: AdminWriteFailure | null =
    writeError == null || lastWrite === null ? null : { error: writeError, from: lastWrite };

  /**
   * Clears the previous failure and records what is being attempted now.
   *
   * The discard here is **defence in depth, and currently unobservable**: every
   * route from one write to a *different* one passes through a dialog change,
   * which already discards, and TanStack clears a mutation's own error when it
   * runs again. Deleting this call fails no test in the web suite (277). It is
   * kept because without it the panel's correctness would depend on the screen
   * never growing a dialog transition that bypasses `changeDialog` — an
   * invariant of a different file. Said plainly here so that nobody later
   * "proves" this line with a test that is really passing on something else,
   * which is exactly how the `reset()` calls below went unpinned.
   */
  function startWrite(write: AdminWrite, spotId: string | null) {
    discardFailure();
    setLastWrite(write);
    setPendingSpotId(spotId);
  }

  /**
   * Forgets the last failure entirely.
   *
   * A mutation keeps its `error` until it is cleared, and all three are cleared
   * rather than only the one about to run, because `writeError` reads whichever
   * of them is non-null. The screen calls this whenever its dialog changes: a
   * failure describes one attempt, and an attempt the admin has walked away
   * from must not follow them into the next dialog and be read as its own. See
   * `doc/decision/0167-*`.
   *
   * Clearing the *error* is what matters, and it matters beyond the dialogs: a
   * mutation that failed keeps answering for every later write, so a create
   * that was refused would report a retire that succeeded. Pinned by "does not
   * report a later, successful write with an earlier one's error".
   *
   * `lastWrite` is deliberately **not** cleared. It reads as tidy and it is
   * not: it is only ever read while a mutation holds an error — and after this
   * function none does. A `setLastWrite(null)` here survived the whole web
   * suite, and worse, it let a test pass on the intent going missing instead of
   * on the error being cleared.
   */
  function discardFailure() {
    createSpot.reset();
    updateSpot.reset();
    deactivateSpot.reset();
  }

  return (
    <AdminSpotsScreen
      onRetry={() => void spotsQuery.refetch()}
      spots={screenDataOf(spotsQuery)}
      todayBySpotId={todayBySpotId}
      onCreate={async (input: CreateSpotInput) => {
        startWrite('spotCreate', null);
        await createSpot.mutateAsync(input);
      }}
      onSave={async (input: { id: string; label: string; group: ParkingGroup }) => {
        startWrite('spotRename', input.id);
        await updateSpot.mutateAsync(input);
      }}
      onActiveChange={(id, active) => {
        startWrite(active ? 'spotRevive' : 'spotRetire', id);
        updateSpot.mutate({ id, active });
      }}
      onHiddenChange={(id, hidden) => {
        startWrite('spotVisibility', id);
        updateSpot.mutate({ id, hidden });
      }}
      onEvChargerChange={(id, evCharger) => {
        startWrite('spotEvCharger', id);
        updateSpot.mutate({ id, evCharger });
      }}
      onDeactivate={async (id) => {
        startWrite('spotRetire', id);
        await deactivateSpot.mutateAsync({ id });
      }}
      pendingSpotId={pendingSpotId}
      isSaving={createSpot.isPending || updateSpot.isPending || deactivateSpot.isPending}
      writeFailure={writeFailure}
      onDiscardFailure={discardFailure}
    />
  );
}
