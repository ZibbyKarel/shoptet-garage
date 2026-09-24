'use client';

/**
 * The "Přehled parkoviště" tab: an admin's read of one day
 * (`doc/design/screens/06-admin-overview.png`).
 *
 * ## What this renders, and what it deliberately does not
 *
 * The design for this tab is the **lot screen** — a page of its own, with the
 * painted car grid, the date bar along the bottom and no tab strip on it. That
 * screen belongs to Task 24 and is the only place the grid is drawn; building a
 * second one here would give the product two implementations of the same canvas
 * that could disagree about the same day. See
 * `doc/decision/0161-the-admin-day-tab-summarises-the-lot-it-does-not-redraw-it.md`.
 *
 * What is here instead is the part of that screen an admin actually needs while
 * they are in `/admin`, drawn out of pieces that already exist: the date, the
 * free/taken counts, the window banner, and one `DataTable` row per spot saying
 * who holds it and how many people are queued. The link at the top opens the lot
 * screen for the grid itself.
 *
 * Presentational: every value arrives as a prop, and nothing here fetches. The
 * connected half is `../admin-day-panel.tsx`, the same split as
 * `settings-screen.tsx` / `settings-page.tsx`.
 */

import type { DayOverviewOutput, DaySpotOverview } from '@garage/contract';
import { Badge, Button, Chip, Stack, Text } from '@garage/design-system/primitives';
import { DataTable } from '@garage/design-system/compounds';
import type { DataTableColumn } from '@garage/design-system/compounds';
import { useDateFormatters, useTranslations } from '@garage/i18n';
import type { DateOnly } from '@garage/i18n';
import { formatTimeRange } from '../../../lot/lot-view';
import { ScreenDataGuard } from '../../screen-state/screen-state';
import type { ScreenData } from '../../screen-state/screen-state';
import { WindowBanner } from '../window-banner/window-banner';

export interface AdminDayScreenProps {
  /** The day being shown, `YYYY-MM-DD` in Europe/Prague. */
  readonly date: DateOnly;
  /** The day itself, or the reason it is not on screen yet. */
  readonly day: ScreenData<DayOverviewOutput>;
  readonly onRetry: () => void;
  /**
   * Navigates to the lot screen, where the painted grid lives. A callback
   * rather than an `href` because this component stays free of the router —
   * see the split described at the top of the file.
   */
  readonly onOpenLot: () => void;
}

export function AdminDayScreen({ date, day, onRetry, onOpenLot }: AdminDayScreenProps) {
  const t = useTranslations('admin');
  const f = useDateFormatters();
  // `guestHolder` lives in the `lot` catalogue — the same badge the spot
  // dialog renders — because that is where the guest concept was introduced;
  // this table reuses the key rather than duplicating the copy under a second
  // one, in both catalogues.
  const tLot = useTranslations('lot');

  const columns: DataTableColumn<DaySpotOverview>[] = [
    {
      id: 'label',
      header: t('dayColumnLabel'),
      sortValue: (row) => row.spot.label,
      cell: (row) => (
        <Stack direction="row" align="center" spacing={2}>
          <Text as="span" weight="bold">
            {row.spot.label}
          </Text>
          {row.spot.hidden ? (
            <Badge size="sm" tone="neutral">
              {tLot('hiddenSpot')}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      id: 'group',
      header: t('dayColumnGroup'),
      sortValue: (row) => row.spot.group,
      cell: (row) => (
        <Text as="span" tone="muted">
          {row.spot.group}
        </Text>
      ),
    },
    {
      id: 'status',
      header: t('dayColumnStatus'),
      // Free sorts first, then a spot with guest blocks but no full-day
      // reservation, then taken rows sorted by holder — a plain boolean
      // would put every occupied-or-blocked spot in one undifferentiated
      // block.
      sortValue: (row) =>
        row.reservation !== null
          ? `2 ${row.reservation.holder.name.toLocaleLowerCase('cs-CZ')}`
          : row.timedReservations.length > 0
            ? '1'
            : '',
      cell: (row) =>
        row.reservation !== null ? (
          // The `ml-2` on the hand-rolled guest tag was the gap between the
          // holder's name and the tag next to it — a row `Stack` with that
          // same gap replaces both the margin and the tag's own markup.
          <Stack direction="row" align="center" spacing={2}>
            <Text as="span">{t('dayStatusTaken', { name: row.reservation.holder.name })}</Text>
            {row.reservation.holder.kind === 'GUEST' ? (
              <Badge size="sm" tone="tag">
                {tLot('guestHolder')}
              </Badge>
            ) : null}
          </Stack>
        ) : row.timedReservations.length > 0 ? (
          <Text as="span">
            {t('dayStatusTimed', {
              times: row.timedReservations.map((block) => formatTimeRange(block)).join(', '),
            })}
          </Text>
        ) : (
          <Text as="span" tone="subtle">
            {t('dayStatusFree')}
          </Text>
        ),
    },
    {
      id: 'queue',
      header: t('dayColumnQueue'),
      align: 'end',
      sortValue: (row) => row.waitlistCount,
      cell: (row) =>
        row.waitlistCount === 0 ? (
          <Text as="span" tone="subtle">
            {t('dayQueueNone')}
          </Text>
        ) : (
          <Badge tone="warning">{t('dayQueueCount', { count: row.waitlistCount })}</Badge>
        ),
    },
  ];

  return (
    <ScreenDataGuard state={day} onRetry={onRetry} headingLevel={3}>
      {(overview) => {
        const free = overview.spots.filter(
          (row) => row.reservation === null && row.timedReservations.length === 0
        ).length;
        const taken = overview.spots.length - free;

        return (
          <Stack spacing={6}>
            <Stack direction="row" wrap align="center" justify="between" spacing={4}>
              <Stack spacing={1}>
                <Text size="xs" weight="bold" tone="subtle" tracking="caps" transform="uppercase">
                  {t('dayEyebrow')}
                </Text>
                <Text as="h3" size="2xl" weight="bold" tracking="tight">
                  {f.fullDate(date)}
                </Text>
              </Stack>
              <Stack direction="row" wrap align="center" spacing={3}>
                <Chip size="lg" dot="green">
                  {t('dayFree', { count: free })}
                </Chip>
                <Chip size="lg" dot="blue">
                  {t('dayTaken', { count: taken })}
                </Chip>
                <Button variant="primary" onClick={onOpenLot}>
                  {t('dayOpenLot')}
                </Button>
              </Stack>
            </Stack>

            <WindowBanner window={overview.window} />

            <DataTable
              columns={columns}
              data={overview.spots}
              getRowId={(row) => row.spot.id}
              title={t('dayTableTitle')}
              description={t('dayTableDescription')}
              defaultSort={{ columnId: 'label', direction: 'asc' }}
              minWidth="640px"
              emptyTitle={t('dayEmpty')}
              emptyDescription={t('dayEmptyDescription')}
            />
          </Stack>
        );
      }}
    </ScreenDataGuard>
  );
}
