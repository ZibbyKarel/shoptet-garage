'use client';

/**
 * Hromadná rezervace — the two-step bulk-booking modal
 * (`doc/design/screens/10-modal-bulk.png`, `doc/bulk-reservation-modal.md`).
 *
 * Step 1 picks days out of a month grid; step 2 shows the schedule
 * `reservation.previewBulk` proposes; confirming runs
 * `reservation.confirmBulk` and lands on a third, non-skippable step that
 * compares what happened against what was proposed.
 *
 * **The third step is the point.** `confirmBulk` deliberately leaves a race
 * open between its read and its write (`doc/decision/0092-*`), so a day the
 * preview promised a spot for can come back as a queue position. A modal that
 * proposed one thing and quietly confirmed another would be worse than one
 * with no proposal at all, because the user would believe they got what they
 * saw. See `doc/decision/0170-*`.
 *
 * Everything this file decides lives in `./bulk-view.ts`; everything it fetches
 * goes through `@tanstack/react-query` and `@garage/api-client`. Nothing
 * here names a wrapped package (`doc/wrappers.md`).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  parseDateOnly,
  todayInPrague,
  toYearMonth,
  useDateFormatters,
  useTranslations,
  type DateOnly,
} from '@garage/i18n';
import { DEFAULT_MONTHLY_RESERVATION_CAP } from '@garage/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Callout,
  List,
  ListItem,
  Modal,
  Stack,
  Text,
  ToggleTile,
  VisuallyHidden,
} from '@garage/design-system/primitives';
import type { ConfirmBulkOutput, PreviewBulkOutput } from '@garage/contract';
import { FormProvider, useAppForm } from '@garage/form';
import { useApi } from '../../shell/api-provider/api-provider';
import { useCurrentUser } from '../../shell/use-current-user';
import { useNotify } from '../../shell/notifications/toast-provider';
import type { HolderOption } from '../spot-dialog/holder-input';
import { carColorVar } from '../lot-view';
import {
  buildMonthGrid,
  diffBulkSchedule,
  toBadge,
  toBulkErrorMessageKey,
  toPreferredSpotMessage,
  toPreferredSpotView,
  weekendColumns,
  type BulkDayCell,
  type BulkDayOutcomeView,
} from './bulk-view';
import { CalendarTable, badgeLabel } from './calendar-table';
import { BulkHolderFields } from './holder-fields';
import { bulkHolderFormSchema, defaultBulkHolderId } from './holder-input';
import type { BulkHolderFormValues } from './holder-input';
import { SchedulePreviewModal } from './schedule-preview-modal';

export interface BulkReservationModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Any day of the month the grid shows — the lot screen's own day. */
  readonly anchorDate: DateOnly;
  /**
   * `overview.day.canReserveMonth` for {@link anchorDate}'s month: the
   * backend's answer to "may this caller create reservations anywhere in this
   * month", never a re-derivation of it (`doc/decision/0120-*`).
   *
   * **`canReserve` is the wrong field here and was the wrong field once.** That
   * one is per-**day** — a past day, a weekend and a Czech public holiday all
   * make it `false` while leaving the month wide open — so reading it switched
   * bulk booking off on roughly a third of the calendar, including the very
   * holiday the design's own screenshot shows the modal open on
   * (`doc/decision/0175-*`).
   *
   * **This is the block, not a hint.** The header hides its button when it is
   * `false`, but hiding a control is not enforcement — the window can also
   * close while the modal is already open, and then this prop is the only
   * thing standing between the user and a request the API will refuse. What it
   * must never block is the *result* step: see `doc/decision/0176-*`.
   */
  readonly canReserveMonth: boolean;
  /** Whether the caller is an admin — gates the holder selector, same as `SpotDialog`'s. */
  readonly isAdmin: boolean;
  /** `null` while the profile is still loading. */
  readonly viewerUserId: string | null;
  /** `LotScreen`'s own `admin.user.list` fetch — not refetched here. */
  readonly holderOptions: readonly HolderOption[];
  readonly holderPending: boolean;
  /** Set when `LotScreen`'s `admin.user.list` fetch failed. */
  readonly holderError?: unknown;
}

/** Monday-first column heads, in the message catalog's key order. */
const WEEKDAY_KEYS = [
  'weekdayMon',
  'weekdayTue',
  'weekdayWed',
  'weekdayThu',
  'weekdayFri',
  'weekdaySat',
  'weekdaySun',
] as const;

/**
 * The modal, with its state tied to one opening.
 *
 * The reset used to be a `useEffect` on `[open, month]` inside the component
 * below. Passive effects run **after paint**, so the render in which `open`
 * flips back to `true` still saw the previous run's `result` and took the
 * result branch — the user reopening the modal got a frame of the last batch's
 * outcome before the day grid appeared. See `doc/decision/0258-*`.
 *
 * A `key` fixes it by construction rather than by ordering: React discards the
 * whole subtree and mounts a fresh one, so there is no state left to flash and
 * no effect whose timing has to be right. The month is in the key as well as
 * `open` because the contract refuses a batch spanning two months — a stale
 * day from the previous month would turn the next confirmation into
 * `VALIDATION_FAILED`. (`LotScreen` also closes the modal when the day moves,
 * so that half is belt and braces; it is cheap and it is the rule this file
 * actually depends on.)
 */
export function BulkReservationModal(props: BulkReservationModalProps) {
  return (
    <BulkReservationModalContent
      key={`${String(props.open)}-${props.anchorDate.slice(0, 7)}`}
      {...props}
    />
  );
}

function BulkReservationModalContent({
  open,
  onClose,
  anchorDate,
  canReserveMonth,
  isAdmin,
  viewerUserId,
  holderOptions,
  holderPending,
  holderError,
}: BulkReservationModalProps) {
  const t = useTranslations('bulk');
  const f = useDateFormatters();
  const api = useApi();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<readonly DateOnly[]>([]);
  // The **whole** preview output, not just its days: its `summary` is the
  // server's own count and is what step 2 prints, so the two steps quote the
  // same authority instead of one of them re-deriving it from `days`.
  const [proposal, setProposal] = useState<PreviewBulkOutput | null>(null);
  const [result, setResult] = useState<ConfirmBulkOutput | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  // No reset effect here on purpose — the wrapper above keys this component on
  // `open` and the month, so every opening is a fresh mount and the four
  // `useState`s start at their initial values. An effect could only ever undo
  // the previous run's state *after* the reopening render had already used it.

  const showHolderForm = isAdmin && holderOptions.length > 0;
  const holderForm = useAppForm<BulkHolderFormValues>({
    schema: bulkHolderFormSchema,
    defaultValues: { userId: defaultBulkHolderId(viewerUserId, holderOptions) },
  });

  // `holderForm`'s `defaultValues` are captured once, at mount, by
  // react-hook-form — unlike the `useState`s above, a `key`-based remount
  // cannot re-seed them a second time, because a remount only re-evaluates
  // the *original* `defaultValues` expression at the render where it happens.
  // If the modal is opened while `LotScreen`'s `admin.user.list` fetch is
  // still in flight, that expression sees an empty `holderOptions` and mounts
  // with `userId: ''`; the fetch then resolves in a **later** render, with no
  // remount in between, and nothing would otherwise tell the form about it.
  // Left alone, the `<select>` shows its first real option (native fallback
  // for a value with no match) while the form still holds `''`, so
  // `bulkHolderFormSchema` rejects the submit and "Generate" does nothing.
  // Same problem, same fix as `spot-dialog.tsx`'s `queueForm.reset` effect.
  useEffect(() => {
    holderForm.reset({ userId: defaultBulkHolderId(viewerUserId, holderOptions) });
  }, [holderOptions, viewerUserId, holderForm]);

  // Live, not `getValues` — the cap-disable and reserved-day highlight below
  // have to react to the admin changing the holder `<select>` *before* they
  // submit, not just at submit time (the one place `getValues` was already
  // enough, further down at `onConfirm`).
  const holderId = holderForm.watch('userId');

  /**
   * A holder switch starts the selection over.
   *
   * The days already picked were measured against the previous holder's
   * remaining slots, and `selectedSet.has(day.date)` deliberately keeps an
   * already-selected cell clickable even once the cap is reached — so without
   * this, five days chosen for an empty month would survive a switch to a
   * colleague with one slot left, stay selectable, and be confirmed straight
   * into the `MONTHLY_RESERVATION_LIMIT_REACHED` this change exists to stop.
   *
   * Keyed on the id rather than on a change event because `holderId` comes
   * from `watch`, and the first render after a `reset` reports the new value
   * with no event of its own.
   */
  const [selectionHolderId, setSelectionHolderId] = useState(holderId);
  if (selectionHolderId !== holderId) {
    setSelectionHolderId(holderId);
    setSelected([]);
  }

  const profile = useCurrentUser();
  const spotList = useQuery({ ...api.spot.list.queryOptions(), enabled: open });
  const monthSummary = useQuery({
    ...api.reservation.myMonth.queryOptions({ input: { month: toYearMonth(anchorDate) } }),
    enabled: open,
  });

  /**
   * The month budget this booking actually spends.
   *
   * The cap is enforced server-side against the **holder**
   * (`assertWithinMonthlyReservationCap`, called with `holderId` from
   * `bulk-reservation.service.ts`), who can be somebody else entirely while
   * `showHolderForm` is open. `reservation.myMonth` is caller-scoped and can
   * only ever answer for the viewer, so a second, admin-only query
   * (`admin.reservation.month`) answers for the holder, and the grid reads
   * whichever of the two matches who this batch is for.
   *
   * This used to drop the cap altogether while booking for somebody else
   * (`remainingSlots = Infinity`, `reservedDates = ∅`). That protected a real
   * admin flow — an admin near their *own* cap must still be able to book for
   * a colleague with room — but it also let an admin pick a sixth day for
   * somebody who only had one left, and hear about it first from the server
   * rejecting the entire batch. Reading the holder's own month keeps the flow
   * and removes the surprise.
   *
   * `viewerUserId === null` (the profile still loading) does not count as
   * "someone else": there is nothing to compare `holderId` against yet, and
   * defaulting to "someone else" would fire a holder query for the admin
   * themselves for one render for no reason.
   */
  const bookingForSomeoneElse =
    showHolderForm && viewerUserId !== null && holderId !== viewerUserId;
  const holderSummary = useQuery({
    ...api.admin.reservation.month.queryOptions({
      input: { userId: holderId, month: toYearMonth(anchorDate) },
    }),
    enabled: open && bookingForSomeoneElse && holderId !== '',
  });

  /**
   * Whichever month summary this batch is measured against, or `undefined`
   * when it is not loaded — in flight, or failed. TanStack Query leaves
   * `data` as `undefined` after a failed fetch, not only while pending, so
   * this is not a proxy for "in flight" and must not be treated as one.
   *
   * The two queries are never both authoritative, and "not loaded" is kept
   * distinct from "loaded, and empty" on purpose: treating an unloaded
   * holder query as zero would show `capNoteHolder: count=0` and a full grid
   * for a holder who is in fact at their cap, i.e. it would flash the exact
   * wrong answer before showing the right one.
   */
  const activeSummary = bookingForSomeoneElse ? holderSummary.data : monthSummary.data;
  const reservedDates = new Set(activeSummary?.reservedDates ?? []);
  const existingCount = activeSummary?.count ?? 0;
  /**
   * The cap **in force** for whoever this batch is for, as the server reported
   * it alongside their count.
   *
   * Not `DEFAULT_MONTHLY_RESERVATION_CAP` — that is only the value a workspace
   * starts with, and an admin can change it.
   *
   * **Not loaded** (pending *or* errored — TanStack Query leaves `data`
   * `undefined` permanently after a failed fetch) falls back to the **bounded**
   * default, equal to what the server answers for an unwritten settings row.
   * That conflation is what produced the bug fixed in `5b2287a`, where the
   * fallback was unbounded and a user whose month query had failed could
   * select without limit — do not reintroduce it. `null` is different: it is
   * the server saying, explicitly, that no cap applies to this month today
   * (outside the AUTO window or under an admin override,
   * `doc/decision/0315-*`), and only then is the selection unbounded.
   */
  const cap = activeSummary === undefined ? DEFAULT_MONTHLY_RESERVATION_CAP : activeSummary.cap;
  const remainingSlots = cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - existingCount);
  const preferredSpot = toPreferredSpotView(
    profile.data === undefined ? undefined : profile.data.preferredParkingSpotId,
    spotList.data?.spots,
    // `data` is `undefined` both in flight and after a failure, so the error
    // flags are the only thing that tells the two apart.
    profile.isError || spotList.isError
  );

  const previewBulk = useMutation({
    ...api.reservation.previewBulk.mutationOptions(),
    onSuccess: (output) => {
      setFailure(null);
      setProposal(output);
    },
    onError: setFailure,
  });

  /**
   * Every day in the batch gets its `overview.day` entry invalidated, not just
   * the days that were written.
   *
   * Over-invalidating is nearly free — an unmounted query is only marked
   * stale — and the alternative needs the client to decide which days the
   * server changed, which is exactly the kind of re-derivation
   * `doc/decision/0120-*` rules out. A day reported `UNAVAILABLE` may still
   * have moved for another reason since the overview was read.
   *
   * The refetch is not redundant with the realtime broadcast: `canReserve` and
   * `viewerReservationId` are viewer-relative, and no broadcast can carry them
   * (the same reasoning as `LotScreen`'s `onMutationSuccess`).
   *
   * `reservation.myMonth` is invalidated too, once per distinct month among
   * `dates` (a batch can only ever span one month, by contract rule, so this
   * is one invalidation in practice) — otherwise a reopened modal can show the
   * cap/highlight state from before this write for up to the query's stale
   * time, because nothing else in this flow ever invalidates that query.
   *
   * `admin.reservation.month` gets the same treatment, for the same reason,
   * but by exact key rather than by prefix: this callback knows exactly whose
   * month it just changed (`holderForm`'s current value), so invalidating
   * that one key is enough, and a prefix invalidation would refetch every
   * other holder an admin had looked at in this session for nothing.
   */
  const invalidateDays = useCallback(
    (dates: readonly DateOnly[]) => {
      for (const date of dates) {
        void queryClient.invalidateQueries({
          queryKey: api.overview.day.queryOptions({ input: { date } }).queryKey,
        });
      }
      const months = new Set(dates.map((date) => toYearMonth(date)));
      for (const month of months) {
        void queryClient.invalidateQueries({
          queryKey: api.reservation.myMonth.queryOptions({ input: { month } }).queryKey,
        });
        void queryClient.invalidateQueries({
          queryKey: api.admin.reservation.month.queryOptions({
            input: { userId: holderForm.getValues('userId'), month },
          }).queryKey,
        });
      }
    },
    [api, queryClient, holderForm]
  );

  const confirmBulk = useMutation({
    ...api.reservation.confirmBulk.mutationOptions(),
    onSuccess: (output) => {
      setFailure(null);
      setResult(output);
      invalidateDays(output.days.map((day) => day.date));
    },
    onError: setFailure,
  });

  const grid = buildMonthGrid(anchorDate, todayInPrague(), reservedDates);
  const weekendHeads = weekendColumns(grid);
  const selectedSet = new Set(selected);

  const toggleDay = (cell: BulkDayCell) => {
    setSelected((current) =>
      current.includes(cell.date)
        ? current.filter((date) => date !== cell.date)
        : [...current, cell.date].sort()
    );
  };

  /** One side of a difference, as one readable phrase. */
  function describeOutcome(day: BulkDayOutcomeView | null): string {
    if (day === null) {
      return t('resultChangedMissing');
    }
    const label = badgeLabel(toBadge(day), t);
    return day.outcome === 'UNAVAILABLE' ? label : `${label} · ${day.parkingSpotLabel}`;
  }

  function preferredSpotNote(): string {
    const message = toPreferredSpotMessage(preferredSpot);
    return t(message.messageKey, message.values);
  }

  // `holderError` is optional (existing test call sites never pass it), so
  // fold its `undefined` into `null` explicitly rather than leaning on `==`.
  const displayedError = failure ?? (isAdmin ? (holderError ?? null) : null);
  const displayedErrorKey = displayedError === null ? null : toBulkErrorMessageKey(displayedError);
  // `cap` is only ever interpolated into `errorMonthlyCapReached`'s copy —
  // passing it unconditionally for every key would also feed it to keys with
  // no `{cap}` placeholder at all.
  // ponytail: `cap` is `null` here only if the summary said "uncapped" and the
  // server then enforced a cap anyway (an admin switched the mode in between);
  // the default is the best number the client has for that one stale toast.
  const displayedErrorValues =
    displayedErrorKey === 'errorMonthlyCapReached'
      ? { cap: cap ?? DEFAULT_MONTHLY_RESERVATION_CAP }
      : undefined;
  // Gated on `open`, matching what the removed local `<ToastRegion>` got for
  // free: it was a descendant of `<Modal open={open}>`, which renders nothing
  // at all while closed (`modal.tsx`'s own early return). This component is
  // always mounted regardless of `open` — `LotScreen` renders it unconditionally
  // and relies on `Modal` to hide it — so without this guard `holderError`
  // (shared with `SpotDialog`, which shows it unconditionally) would publish a
  // second, duplicate toast for the same failure while this modal is closed.
  useNotify(
    open && displayedErrorKey !== null ? t(displayedErrorKey, displayedErrorValues) : null,
    'danger'
  );
  useNotify(open && result !== null ? t('resultSuccessToast') : null, 'success');

  const pending = previewBulk.isPending || confirmBulk.isPending;

  // ----------------------------------------------------------------- result
  //
  // **First, ahead of the locked-month refusal below.** A result is a record of
  // writes that already happened; there is nothing left here for a closed
  // window to block, and refusing at this point would replace the comparison
  // with "hromadnou rezervaci teď založit nelze" over reservations that exist —
  // the exact silent difference the whole two-step flow is built to prevent.
  // The confirm button does not exist on this step, so nothing is weakened by
  // letting it through. See `doc/decision/0176-*`.
  if (result !== null) {
    const differences = diffBulkSchedule(proposal?.days ?? [], result.days);
    return (
      <Modal
        open={open}
        onClose={onClose}
        size="md"
        title={t('resultTitle')}
        description={t('resultDescription')}
        closeLabel={t('close')}
        closeOnScrimClick={false}
        footer={<Button onClick={onClose}>{t('ctaDone')}</Button>}
      >
        <Stack spacing={4}>
          {/*
            The two visible children below (the status/alert panel and the
            calendar table) sit a `gap-5` apart, one step wider than the
            `gap-4` between the table and the summary line — the same two
            steps `mb-5`/`mt-4` expressed by hand before. `Stack.spacing` is
            uniform, so the only way to keep both steps is to nest one.
          */}
          <Stack spacing={5}>
            {differences.length === 0 ? (
              <Text as="p" role="status" tone="subtle" size="base">
                {t('resultUnchanged')}
              </Text>
            ) : (
              <Callout tone="warning" role="alert">
                <Stack spacing={3}>
                  <Stack spacing={1}>
                    <Text as="p" size="base" weight="bold" tone="default">
                      {t('resultChangedTitle')}
                    </Text>
                    <Text as="p" size="base" tone="muted" leading="loose">
                      {t('resultChangedDescription')}
                    </Text>
                  </Stack>
                  <List spacing={2}>
                    {differences.map((difference) => (
                      <ListItem key={difference.date}>
                        <Text as="span" size="base" weight="bold" tone="default">
                          {f.dayAndMonth(difference.date)} · {f.weekdayName(difference.date)}
                        </Text>
                        <Text as="span" size="base" display="block" tone="muted">
                          {t('resultChangedProposed')}: {describeOutcome(difference.proposed)}
                        </Text>
                        <Text as="span" size="base" display="block" tone="muted">
                          {t('resultChangedActual')}: {describeOutcome(difference.confirmed)}
                        </Text>
                      </ListItem>
                    ))}
                  </List>
                </Stack>
              </Callout>
            )}

            <CalendarTable days={result.days} t={t} />
          </Stack>

          <Text as="p" size="base" tone="muted">
            {t('scheduleSummary', {
              assigned: result.summary.assigned,
              queued: result.summary.queued,
            })}
          </Text>
        </Stack>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- blocked
  //
  // Ahead of the two steps that can still *write* — picking days and
  // confirming — so it catches both a modal opened in a locked month and a
  // window that closes while the modal is open, which is the case a hidden
  // header button cannot cover. Deliberately **after** the result step above.
  if (!canReserveMonth) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        size="md"
        title={t('lockedTitle')}
        closeLabel={t('close')}
        // Consistent with the three flow steps: whichever of them this replaced
        // was holding a selection, and a stray click on the scrim should not be
        // how the user finds that out.
        closeOnScrimClick={false}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
        }
      >
        <Text as="p" size="base" leading="loose" tone="subtle">
          {t('lockedDescription')}
        </Text>
      </Modal>
    );
  }

  // --------------------------------------------------------------- schedule
  if (proposal !== null) {
    return (
      <SchedulePreviewModal
        open={open}
        onClose={onClose}
        t={t}
        proposal={proposal}
        pending={pending}
        onBack={() => {
          setProposal(null);
          setFailure(null);
        }}
        confirmPending={confirmBulk.isPending}
        onConfirm={() => {
          // The days of the **proposal on screen**, not of `selected`. They
          // agree today, because both procedures answer one entry per
          // requested day — but "we confirm exactly what you were shown" is
          // the invariant, and reading it off the thing that was shown is
          // the only way to state it.
          confirmBulk.mutate({
            dates: proposal.days.map((day) => day.date),
            ...(showHolderForm ? { holderId: holderForm.getValues('userId') } : {}),
          });
        }}
      />
    );
  }

  // ----------------------------------------------------------------- select
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('title')}
      description={t('description', {
        month: f.monthLocative(parseDateOnly(anchorDate).month),
      })}
      closeLabel={t('close')}
      closeOnScrimClick={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            loading={previewBulk.isPending}
            disabled={selected.length === 0 || pending || (isAdmin && holderPending)}
            onClick={
              showHolderForm
                ? holderForm.handleSubmit((values) => {
                    previewBulk.mutate({ dates: [...selected], holderId: values.userId });
                  })
                : () => {
                    previewBulk.mutate({ dates: [...selected] });
                  }
            }
          >
            {selected.length === 0
              ? t('ctaSelectDays')
              : t('ctaGenerate', { count: selected.length })}
          </Button>
        </>
      }
    >
      {showHolderForm ? (
        <FormProvider {...holderForm}>
          <BulkHolderFields options={holderOptions} />
        </FormProvider>
      ) : null}

      {/*
        `border-spacing` has no Tailwind utility that takes a token, so the
        grid chrome lives in the named `.calendar-grid` class in
        `app/global.css` (owned by another agent in this rewrite) rather than
        as an inline utility string here.
      */}
      {/* eslint-disable-next-line no-restricted-syntax -- `.calendar-grid` is the one class the design system cannot express (border-spacing has no token utility); see global.css */}
      <table className="calendar-grid">
        <VisuallyHidden as="caption">{t('gridLabel')}</VisuallyHidden>
        <thead>
          <tr>
            {WEEKDAY_KEYS.map((key, column) => (
              // `Text` now renders `as="th"` with a `scope` prop, so the
              // `<th>`/inner-`<span>` pair collapses into one element. `Text`
              // deliberately has no padding prop (no spacing surface was in
              // scope for it), so the bottom padding is carried by
              // `.calendar-grid th` in `global.css` instead.
              <Text
                key={key}
                as="th"
                scope="col"
                size="xs"
                weight="bold"
                transform="uppercase"
                tracking="caps"
                tone={weekendHeads[column] === true ? 'faint' : 'subtle'}
              >
                {t(key)}
              </Text>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.weeks.map((week) => (
            <tr key={week.key}>
              {week.slots.map(({ key, day }) =>
                day === null ? (
                  <td key={key} />
                ) : (
                  <td key={key}>
                    <ToggleTile
                      shape="cell"
                      transition="base"
                      selected={day.selectable ? selectedSet.has(day.date) : false}
                      selectable={
                        day.selectable &&
                        (selectedSet.has(day.date) || selected.length < remainingSlots)
                      }
                      aria-pressed={day.selectable ? selectedSet.has(day.date) : undefined}
                      aria-label={
                        !day.selectable && day.block === 'ALREADY_RESERVED'
                          ? t(bookingForSomeoneElse ? 'dayCellReservedHolder' : 'dayCellReserved', {
                              date: f.fullDate(day.date),
                            })
                          : day.selectable &&
                              !(selectedSet.has(day.date) || selected.length < remainingSlots)
                            ? // Distinct from `dayCellBlocked`: this day is a perfectly
                              // good business day (`day.selectable`) that only can't be
                              // picked *right now* because the batch would exceed the
                              // monthly cap — a weekend/holiday/past-day cell never
                              // reaches this branch. Reachable for a holder too since the
                              // cap follows them rather than being suppressed, which is
                              // why the copy has a holder-scoped variant.
                              t(bookingForSomeoneElse ? 'dayCellCappedHolder' : 'dayCellCapped', {
                                date: f.fullDate(day.date),
                              })
                            : day.selectable
                              ? t('dayCell', { date: f.fullDate(day.date) })
                              : t('dayCellBlocked', { date: f.fullDate(day.date) })
                      }
                      accentColor={
                        !day.selectable &&
                        day.block === 'ALREADY_RESERVED' &&
                        !bookingForSomeoneElse &&
                        viewerUserId !== null
                          ? carColorVar(viewerUserId)
                          : undefined
                      }
                      onClick={() => {
                        toggleDay(day);
                      }}
                    >
                      {day.dayOfMonth}
                    </ToggleTile>
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        `Stack` now exposes `spacingX`/`spacingY` (separate `gap-x-*`/`gap-y-*`)
        alongside `spacing`, so the original `gap-x-4 gap-y-1` is reproduced
        exactly rather than widened to `gap-4` on both axes.
      */}
      <Stack direction="row" wrap spacingX={4} spacingY={1}>
        <Text as="span" size="sm" tone="subtle">
          {t('nonSelectableNote')}
        </Text>
        <Text as="span" size="sm" weight="bold" tone="default">
          {preferredSpotNote()}
        </Text>
        {/*
          Shown whenever the cap is a live fact for this booking: the subject
          already has reservations this month (`existingCount > 0`, so the
          count itself is worth showing), OR this session's own selection has
          reached the cap together with what already existed
          (`existingCount + selected.length >= cap`, `cap` being whatever the
          server reported alongside `existingCount` — not a hard-coded five) —
          the case a subject starting the month at zero and picking as many
          days as the cap allows in this one session hits, where
          `existingCount` alone would stay `0` and the note would never appear
          even though the day after the last pick is greying out.

          The subject is the holder whenever an admin is booking for one, so
          the note names them (`capNoteHolder`) rather than saying "you".

          No note at all when the server reports no cap in force (`cap === null`).
        */}
        {cap !== null && (existingCount > 0 || existingCount + selected.length >= cap) ? (
          <Text as="span" size="sm" tone="subtle">
            {t(bookingForSomeoneElse ? 'capNoteHolder' : 'capNote', {
              count: existingCount,
              cap,
            })}
          </Text>
        ) : null}
      </Stack>
    </Modal>
  );
}
