'use client';

/**
 * `AdminWindowScreen`, connected to the API. Wiring only.
 *
 * One query feeds both cards: `admin.window.months` returns the month rows
 * **and** the settings they were derived under, which is exactly why the
 * contract puts `settings` in that response
 * (`libs/garage/contract/src/api/reservation-window.ts`). Reading the settings from a
 * second call would let the form and the list disagree about the same moment.
 */

import { useState } from 'react';
import type { ReservationLockMode } from '@garage/contract';
import { useRequireAuth } from '@garage/auth/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonths, startOfMonth, todayInPrague, toYearMonth } from '@garage/i18n';
import { useApi } from '../api-provider/api-provider';
import { screenDataOf } from '../screen-state/screen-state';
import { AdminWindowScreen } from './admin-window-screen/admin-window-screen';

/**
 * How many months the list shows, counting the current one.
 *
 * Four, because that is what the design draws (srpen–listopad from a day in
 * August) and because it spans every state `AUTO` produces: the current month
 * is running (`OPEN`, no cap), the next is the one whose window is opening, and
 * the two after it are `NOT_YET_OPEN`. Well inside the contract's
 * `MAX_MONTH_WINDOW_SPAN`.
 */
const MONTHS_LISTED = 4;

export function AdminWindowPanel() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { status } = useRequireAuth();

  const today = todayInPrague();
  const from = toYearMonth(today);
  const to = toYearMonth(addMonths(startOfMonth(today), MONTHS_LISTED - 1));

  // `true` only between a successful save and the next change, so the "uloženo"
  // confirmation appears for the save that just happened and not for one from
  // five minutes ago.
  const [isSaved, setIsSaved] = useState(false);

  const monthsQuery = useQuery({
    ...api.admin.window.months.queryOptions({ input: { from, to } }),
    enabled: status === 'authenticated',
  });

  const updateWindow = useMutation({
    ...api.admin.window.update.mutationOptions(),
    onSuccess: () => {
      setIsSaved(true);
      // Every month's state is derived from these two fields, so the list next
      // to the form is stale the moment the form is saved.
      queryClient.invalidateQueries({ queryKey: api.admin.window.key() });
      // The day overview embeds the window state of its own month, and the
      // banner on the parking screen is drawn from it.
      queryClient.invalidateQueries({ queryKey: api.overview.key() });
    },
  });

  return (
    <AdminWindowScreen
      reservationWindow={screenDataOf(monthsQuery)}
      onRetry={() => void monthsQuery.refetch()}
      today={today}
      onChange={(next: { openDaysBefore: number; lockMode: ReservationLockMode }) => {
        setIsSaved(false);
        updateWindow.reset();
        updateWindow.mutate(next);
      }}
      isSaving={updateWindow.isPending}
      saveError={updateWindow.error}
      isSaved={isSaved}
    />
  );
}
