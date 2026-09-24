'use client';

/**
 * The parking overview — the application's main screen.
 *
 * This is the **connected** half: it owns the day on screen, reads
 * `overview.day` through `@tanstack/react-query`, wires the day room's
 * broadcasts onto that cache entry, holds the cell lock while the dialog is
 * open, and hands plain data to the presentational pieces beside it.
 * Everything it decides is a pure function in `./lot-view`; everything it
 * draws is `./lot-grid`, `./lot-header`, `./date-picker-dialog` and
 * `./spot-dialog`.
 *
 * Nothing here names `socket.io-client`, `next-intl`, `next-auth` or
 * `@orpc/client` — the wrapper rule, enforced by `no-restricted-imports`
 * (`doc/wrappers.md`). `@tanstack/react-query` is no longer one of the wrapped
 * packages (`doc/decision/0308-*`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  nextWeekday,
  parseDateOnly,
  previousWeekday,
  todayInPrague,
  toYearMonth,
  useDateFormatters,
  useTranslations,
} from '@garage/i18n';
import { useSession } from '@garage/auth/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCellLock, useRealtime } from '@garage/realtime-client';
import { EmptyState } from '@garage/design-system/compounds';
import { toContractError } from '@garage/api-client';
import { useApi } from '../../shell/api-provider/api-provider';
import { useCurrentUser } from '../../shell/use-current-user';
import { ScreenError, ScreenLoading } from '../../shell/screen-state/screen-state';
import { LotHeader, RealtimeNotice, WindowBanner } from '../lot-header/lot-header';
import { DatePickerDialog } from '../date-picker-dialog/date-picker-dialog';
import { LotGrid } from '../lot-grid/lot-grid';
import { BulkReservationModal } from '../bulk-modal/bulk-modal';
import { SpotDialog } from '../spot-dialog/spot-dialog';
import { useCellLocks } from './use-cell-locks';
import { useDateInUrl } from './use-date-in-url';
import { useLotRealtime } from './use-lot-realtime';
import { useAdminUserOptions } from '../use-admin-user-options';
import {
  toBannerView,
  toDayNoteView,
  toGroupViews,
  toLotCounts,
  toRealtimeNoticeView,
} from '../lot-view';

/** How far the date-picker's year selector reaches either side of the day on screen. */
const YEAR_PICKER_RADIUS = 1;

/**
 * Contract error codes whose catalogue copy is written in the second person,
 * and the `lot.*` key to use instead when the reservation was created for
 * somebody other than the viewer. Every other code — and every self-booking —
 * keeps the catalogue string; see `createReservation`'s `onError`.
 */
const HOLDER_LIMIT_MESSAGE_KEYS: Record<
  string,
  'errHolderLimitReached' | 'errHolderMonthlyLimitReached'
> = {
  RESERVATION_LIMIT_REACHED: 'errHolderLimitReached',
  MONTHLY_RESERVATION_LIMIT_REACHED: 'errHolderMonthlyLimitReached',
};

export function LotScreen() {
  const t = useTranslations('lot');
  const sections = useTranslations('sections');
  const f = useDateFormatters();
  const api = useApi();
  const queryClient = useQueryClient();
  const { status: realtimeStatus, reconnect } = useRealtime();

  // A ref, not state: it only ever goes false → true, and it is read while
  // deciding what to draw in the same render that sets it. Writing it during
  // render is safe for exactly that reason — no subscriber to wake, no second
  // commit, and `useRealtime()` is what re-renders this component when the
  // status moves. See `toRealtimeNoticeView` for why "has it ever connected"
  // is the question at all.
  const hasEverConnected = useRef(false);
  if (realtimeStatus === 'connected') hasEverConnected.current = true;
  const realtimeNotice = toRealtimeNoticeView(realtimeStatus, hasEverConnected.current);

  const [date, setDate] = useDateInUrl();
  const [openSpotId, setOpenSpotId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  /**
   * The substitution for `actionError`'s code-mapped copy — see `SpotDialog`'s
   * `errorMessage` doc comment. `null` for every failure except a
   * `reservation.create` that named someone other than the viewer and came
   * back with one of {@link HOLDER_LIMIT_MESSAGE_KEYS}'s second-person codes,
   * so a self-booking create and every `waitlist`/`cancel` failure keep the
   * plain catalogue string untouched.
   */
  const [holderLimitMessage, setHolderLimitMessage] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // The modal's grid is the month of `date`, and its selection belongs to that
  // month — the contract refuses a batch spanning two. Moving the day is
  // deliberate enough to treat as leaving the flow.
  useEffect(() => {
    setBulkOpen(false);
  }, [date]);

  const profile = useCurrentUser();
  const viewerUserId = profile.data?.id ?? null;
  // Unknown means not an admin, which is the only safe direction for this to
  // fail in. Nothing is authorised here — the API's `RolesGuard` is.
  const isAdmin = profile.data?.role === 'ADMIN';

  const { status: sessionStatus } = useSession();
  const dayQuery = useQuery({
    ...api.overview.day.queryOptions({ input: { date } }),
    // Firing before the session exists spends a request the API answers 401,
    // and a 401 is not retried (`shouldRetryQuery`) — the screen would settle
    // into an error state a signed-in user never leaves. Same reasoning, and
    // the same gate, as `useCurrentUser`.
    enabled: sessionStatus === 'authenticated',
  });
  const day = dayQuery.data ?? null;

  // Only an admin may name a holder, so only an admin fetches the list. Filtered
  // server-side: `adminListUsersInputSchema` carries `active`, and a deactivated
  // colleague is not somebody to book a bay for.
  const {
    options: holderOptions,
    pending: holderPending,
    error: holderError,
  } = useAdminUserOptions({ input: { active: true }, enabled: isAdmin });

  useLotRealtime({ date, viewerUserId });
  const locks = useCellLocks(date);

  const context = useMemo(
    () => ({
      canReserve: day?.canReserve ?? false,
      isAdmin,
      viewerUserId,
      locks,
      viewerReservationId: day?.viewerReservationId ?? null,
    }),
    [day?.canReserve, day?.viewerReservationId, isAdmin, viewerUserId, locks]
  );

  const groups = useMemo(
    () => (day === null ? [] : toGroupViews(day.spots, context)),
    [day, context]
  );
  const openSpot = useMemo(
    () => groups.flatMap((group) => group.spots).find((spot) => spot.spotId === openSpotId) ?? null,
    [groups, openSpotId]
  );

  // Only an admin adding somebody to a spot's queue fetches this — scoped to
  // that spot and day so the excluded set (`excludingReservedOrQueuedFor`) is
  // right for the bay actually open, and refetched whenever either changes.
  const {
    options: queueTargetOptions,
    pending: queueTargetPending,
    error: queueTargetError,
  } = useAdminUserOptions({
    input: {
      active: true,
      ...(openSpot === null
        ? {}
        : { excludingReservedOrQueuedFor: { parkingSpotId: openSpot.spotId, date } }),
    },
    enabled: isAdmin && openSpot !== null && openSpot.action === 'queue',
  });

  // This client's own hold, taken while the dialog is open and released by the
  // same effect when it closes (`doc/realtime.md`, §"The cell lock"). It is a
  // courtesy, not an authorisation step: skipping it would get a `CONFLICT`
  // from `reservation.create` rather than a double booking — which is also
  // why `info` is excluded: it is the **only** action `SpotDialog` can never
  // write from (`showCancel`/`showPrimary` are both false for it, since the
  // spot is free and unbookable). `reserve` and `mine` write directly, and
  // `queue` can too — joining or leaving the waitlist, or an admin's cancel —
  // so all three still take the hold; only the pure explanation does not.
  useCellLock({
    date,
    parkingSpotId: openSpotId ?? '',
    enabled: openSpot !== null && openSpot.action !== 'info',
  });

  /**
   * `reservation.myMonth` is invalidated alongside `overview.day` — a create
   * or cancel here changes the viewer's own monthly count/reserved-dates the
   * same way a bulk batch does, and `BulkReservationModal` reads that query
   * whenever it opens. Without this, cancelling (or creating) a reservation
   * here and then opening the bulk modal for the same month could show a
   * stale count/highlight for up to that query's stale time — the same defect
   * `bulk-modal.tsx`'s own `invalidateDays` fixes for its own writes.
   *
   * `admin.reservation.month` needs the same treatment, and gets it by
   * **prefix**: an admin's create or cancel on this screen can be for any
   * holder, and this callback never learns which — the holder lives inside
   * `SpotDialog`'s own form. Invalidating the branch refetches only the
   * holder months this session has actually looked at, which is at most a
   * handful, and is the only option that cannot miss the one that moved.
   */
  const invalidateDay = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: api.overview.day.queryOptions({ input: { date } }).queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: api.reservation.myMonth.queryOptions({ input: { month: toYearMonth(date) } })
        .queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: api.admin.reservation.month.key(),
    });
  }, [api, queryClient, date]);

  /**
   * Every **successful** write ends the same way: close the dialog and
   * refetch the day. Named for `onSuccess`, not TanStack's `onSettled` (which
   * also fires on error) — wired only there, below; a failure goes to
   * `setActionError` and deliberately leaves the dialog open so the caller
   * can see why.
   *
   * The refetch is not belt-and-braces on top of the broadcast — a client
   * cannot patch its own viewer-relative fields from an event it may not even
   * receive (the gateway need not echo to the sender), and `canReserve` and
   * `viewerReservationId` both move on a successful write.
   */
  const onMutationSuccess = useCallback(() => {
    setOpenSpotId(null);
    setActionError(null);
    setHolderLimitMessage(null);
    invalidateDay();
  }, [invalidateDay]);

  /**
   * `waitlist.leave`/`reservation.cancel` report a failure the same plain
   * way — clear whatever `holderLimitMessage` a previous write left behind
   * and fall back to the code-mapped catalogue string. `createReservation`
   * and `joinWaitlist` each carry their own `onError` instead, because both
   * can substitute a named-target message for a code that otherwise reads as
   * a false statement about the caller — see their own doc comments.
   *
   * Defence-in-depth, and measured to be exactly that: deleting this clear
   * leaves the whole web suite green, because one dialog is either a free bay
   * offering Rezervovat or a taken one offering the queue — never both — so
   * the two failures cannot follow each other without `closeDialog` or
   * `openDialog` (which clear it too) running in between. It stays for the
   * dialog that offers both one day; see `lot-screen.spec.tsx`'s
   * carry-over test, which pins those two clears rather than this one.
   */
  const onWriteError = useCallback((error: unknown) => {
    setHolderLimitMessage(null);
    setActionError(error);
  }, []);

  const createReservation = useMutation({
    ...api.reservation.create.mutationOptions(),
    onSuccess: onMutationSuccess,
    /**
     * The one place that can tell the limit errors *this* call got back apart
     * from every other caller of the same codes: `variables` is what this call
     * actually submitted. A named holder other than the viewer — a `GUEST`, or
     * a `USER` whose id isn't the viewer's — reads the catalogue's
     * second-person copy as false, because the limit belongs to the person
     * being booked for and not to the admin doing the booking. Two codes are
     * addressed that way, and {@link HOLDER_LIMIT_MESSAGE_KEYS} gives each its
     * own holder-scoped string; an admin naming *themselves*, a plain
     * self-booking create, and every other code all fall through to the plain
     * catalogue string via `holderLimitMessage` staying `null`.
     *
     * Neither code can reach the `GUEST` branch of `namedOther` today, for two
     * different reasons — both of which come back to a guest holder being
     * written with `userId: null`
     * (`apps/garage/api/src/reservations/reservations.service.ts`). For
     * `RESERVATION_LIMIT_REACHED` that null is exempt from the
     * `Reservation(userId, date)` constraint the code comes from
     * (`doc/decision/0303-*`). For `MONTHLY_RESERVATION_LIMIT_REACHED` there is
     * no constraint at all: the cap is a per-user budget, and a guest has no
     * `userId`, so `assertWithinMonthlyReservationCap` is never called for one
     * (`apps/garage/api/src/reservations/monthly-reservation-cap.ts`). Both branches
     * are left in because they are the correct answer if that ever changes, not
     * because they are reachable now.
     */
    onError: (error, variables) => {
      const holder = variables.holder;
      const namedOther =
        holder !== undefined && (holder.kind === 'GUEST' || holder.userId !== viewerUserId);
      const key = HOLDER_LIMIT_MESSAGE_KEYS[toContractError(error)?.code ?? ''];
      setHolderLimitMessage(namedOther && key !== undefined ? t(key) : null);
      setActionError(error);
    },
  });
  const cancelReservation = useMutation({
    ...api.reservation.cancel.mutationOptions(),
    onSuccess: onMutationSuccess,
    onError: onWriteError,
  });
  const joinWaitlist = useMutation({
    ...api.waitlist.join.mutationOptions(),
    onSuccess: onMutationSuccess,
    /**
     * Mirrors `createReservation`'s `onError`, for the same reason: a
     * `holderId` naming somebody other than the viewer makes three of
     * `waitlist.join`'s codes read false as the plain catalogue string — "you
     * already have a reservation", "you are already queued", "you already
     * hold this spot" — all really about the *target*, not the admin who
     * submitted the selector. A self-join, and every other code, fall through
     * to the plain catalogue string via `holderLimitMessage` staying `null`.
     */
    onError: (error, variables) => {
      const namedOther = variables.holderId !== undefined && variables.holderId !== viewerUserId;
      const code = namedOther ? toContractError(error)?.code : undefined;
      setHolderLimitMessage(
        code === 'RESERVATION_LIMIT_REACHED'
          ? t('errQueueLimitReached')
          : code === 'ALREADY_IN_WAITLIST'
            ? t('errQueueAlreadyQueued')
            : code === 'CANNOT_WAITLIST_OWN_SPOT'
              ? t('errQueueOwnSpot')
              : null
      );
      setActionError(error);
    },
  });
  const leaveWaitlist = useMutation({
    ...api.waitlist.leave.mutationOptions(),
    onSuccess: onMutationSuccess,
    onError: onWriteError,
  });

  const createTimedReservation = useMutation({
    ...api.admin.timedReservation.create.mutationOptions(),
    onSuccess: onMutationSuccess,
    onError: onWriteError,
  });
  /**
   * Unlike every other write here, success does **not** close the dialog: a
   * `'timed'` spot can carry several guest blocks, and cancelling one should
   * leave the admin looking at the rest, not bounced back to the grid.
   */
  const cancelTimedReservation = useMutation({
    ...api.admin.timedReservation.cancel.mutationOptions(),
    onSuccess: invalidateDay,
    onError: onWriteError,
  });

  const counts = useMemo(() => toLotCounts(day?.spots ?? []), [day?.spots]);

  const parts = parseDateOnly(date);
  const years = Array.from(
    { length: YEAR_PICKER_RADIUS * 2 + 1 },
    (_unused, index) => parts.year - YEAR_PICKER_RADIUS + index
  );

  const closeDialog = useCallback(() => {
    setOpenSpotId(null);
    setActionError(null);
    setHolderLimitMessage(null);
  }, []);

  const openDialog = useCallback((spotId: string) => {
    setActionError(null);
    setHolderLimitMessage(null);
    setOpenSpotId(spotId);
  }, []);

  if (dayQuery.isPending) {
    return <ScreenLoading />;
  }
  if (dayQuery.isError || day === null) {
    return (
      <ScreenError
        error={dayQuery.error}
        onRetry={() => {
          void dayQuery.refetch();
        }}
      />
    );
  }

  const banner = toBannerView(day.window, isAdmin, f);
  const pending =
    createReservation.isPending ||
    cancelReservation.isPending ||
    joinWaitlist.isPending ||
    leaveWaitlist.isPending ||
    createTimedReservation.isPending ||
    cancelTimedReservation.isPending;

  return (
    <>
      <LotHeader
        date={date}
        note={toDayNoteView(date)}
        counts={counts}
        sectionTitle={sections('lot')}
        // The design's `batchAllowed = windowOpen || admin`, expressed through
        // the field the contract tells us to read instead of re-deriving it.
        // Absent rather than disabled: a normal user in a locked month has no
        // bulk action to take.
        //
        // `canReserveMonth`, **not** `canReserve`: the bulk modal's subject is
        // the month, and `canReserve` is per-day — reading it hid this button
        // on every weekend, holiday and past day of an open month
        // (`doc/decision/0175-*`).
        showBulk={day.canReserveMonth}
        onBulk={() => {
          setBulkOpen(true);
        }}
        onPreviousDay={() => {
          setDate(previousWeekday(date));
        }}
        onNextDay={() => {
          setDate(nextWeekday(date));
        }}
        onToday={() => {
          setDate(todayInPrague());
        }}
        onOpenDatePicker={() => {
          setDatePickerOpen(true);
        }}
      />

      {/*
        `canReserveMonth` is passed as well as consulted by `showBulk` above,
        because hiding a control is not enforcement: the window can close
        while the modal is already open, and the modal is what refuses then
        (`doc/decision/0173-*`).
      */}
      <BulkReservationModal
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false);
        }}
        anchorDate={date}
        canReserveMonth={day.canReserveMonth}
        isAdmin={isAdmin}
        viewerUserId={viewerUserId}
        holderOptions={holderOptions}
        holderPending={holderPending}
        holderError={holderError}
      />

      <DatePickerDialog
        open={datePickerOpen}
        onClose={() => {
          setDatePickerOpen(false);
        }}
        selectedDate={date}
        years={years}
        onSelect={(selected) => {
          setDate(selected);
          setDatePickerOpen(false);
        }}
      />

      <WindowBanner banner={banner} />
      {/*
        Both non-live states are drawn, not just the terminal one. `dropped`
        gets no button because the connection is already retrying; `rejected`
        gets one because it is not. `none` covers a live board *and* a board
        that has not connected for the first time yet — see
        `toRealtimeNoticeView`.
      */}
      {realtimeNotice === 'none' ? null : (
        <RealtimeNotice onReconnect={realtimeNotice === 'rejected' ? reconnect : undefined} />
      )}

      {day.spots.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <LotGrid groups={groups} onOpenSpot={openDialog} onAdminOpenSpot={openDialog} />
      )}

      <SpotDialog
        spot={openSpot}
        date={date}
        canReserve={day.canReserve}
        isAdmin={isAdmin}
        monthName={f.monthName(parts.month)}
        error={actionError ?? holderError ?? queueTargetError}
        {...(holderLimitMessage === null ? {} : { errorMessage: holderLimitMessage })}
        pending={pending}
        viewerUserId={viewerUserId}
        holderOptions={holderOptions}
        holderPending={holderPending}
        queueTargetOptions={queueTargetOptions}
        queueTargetPending={queueTargetPending}
        onClose={closeDialog}
        onReserve={(holder) => {
          if (openSpot === null) return;
          createReservation.mutate({
            parkingSpotId: openSpot.spotId,
            date,
            ...(holder === undefined ? {} : { holder }),
          });
        }}
        onJoinWaitlist={(holderId) => {
          if (openSpot === null) return;
          joinWaitlist.mutate({
            parkingSpotId: openSpot.spotId,
            date,
            ...(holderId === undefined ? {} : { holderId }),
          });
        }}
        onLeaveWaitlist={() => {
          const entryId = openSpot?.viewerWaitlistEntryId;
          if (entryId === null || entryId === undefined) return;
          leaveWaitlist.mutate({ waitlistEntryId: entryId });
        }}
        onCancelReservation={() => {
          const reservationId = day.spots.find((row) => row.spot.id === openSpotId)?.reservation
            ?.id;
          if (reservationId === undefined) return;
          cancelReservation.mutate({ reservationId });
        }}
        onReserveTimed={(block) => {
          if (openSpot === null) return;
          createTimedReservation.mutate({ parkingSpotId: openSpot.spotId, date, ...block });
        }}
        onCancelTimedReservation={(timedReservationId) => {
          cancelTimedReservation.mutate({ timedReservationId });
        }}
      />
    </>
  );
}
