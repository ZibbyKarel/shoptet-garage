'use client';

/**
 * {@link DatePickerDialog} — the calendar the header's date pill opens
 * (`doc/design/garage-design.dc.html`'s `datePickerOpen` branch).
 *
 * The grid itself borrows `../bulk-modal/bulk-modal.tsx`'s table: a `<caption>` for the
 * accessible name, weekday heads, and a button per day. What differs is the
 * rule a cell obeys — since this dialog only navigates the lot screen and
 * never books, a past day or a Czech holiday is pickable here, with weekends
 * the one exception (see `./date-picker-view.ts`) — which is exactly why the
 * layout moved to `../calendar-grid.ts` rather than this file reaching into
 * `../bulk-modal/bulk-view.ts` for a grid shaped by booking rules that do not apply here.
 *
 * Picking a day calls `onSelect` with nothing further: the caller (`../lot-header/lot-header.tsx`
 * via `../lot-screen/lot-screen.tsx`) decides that choosing a day also closes the dialog,
 * the same way a click in `../bulk-modal/bulk-modal.tsx`'s grid never closes anything —
 * the two dialogs simply differ on that point, and neither should guess the
 * other's convention.
 */

import { useState } from 'react';
import {
  Box,
  Button,
  Modal,
  Select,
  Stack,
  Text,
  ToggleTile,
  VisuallyHidden,
} from '@garage/design-system/primitives';
import {
  addMonths,
  parseDateOnly,
  startOfMonth,
  useDateFormatters,
  useTranslations,
  type DateOnly,
} from '@garage/i18n';
import { buildDatePickerGrid } from './date-picker-view';

export interface DatePickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The lot screen's own day — seeds the month on open and marks its cell. */
  readonly selectedDate: DateOnly;
  /** Years offered in the year selector, ascending. */
  readonly years: readonly number[];
  readonly onSelect: (date: DateOnly) => void;
}

const MONTHS_IN_YEAR = 12;

/**
 * Keyed on `open` and `selectedDate` for the same reason
 * `BulkReservationModal` keys its content on opening: a passive effect
 * resetting the browsed month would still see the previous state in the
 * render where `open` flips back to `true`, and re-mounting avoids that class
 * of bug by construction instead of by effect ordering
 * (`doc/decision/0258-*`).
 */
export function DatePickerDialog(props: DatePickerDialogProps) {
  return <DatePickerDialogContent key={`${String(props.open)}-${props.selectedDate}`} {...props} />;
}

function DatePickerDialogContent({
  open,
  onClose,
  selectedDate,
  years,
  onSelect,
}: DatePickerDialogProps) {
  const t = useTranslations('lot');
  const f = useDateFormatters();
  const [viewAnchor, setViewAnchor] = useState<DateOnly>(() => startOfMonth(selectedDate));

  const grid = buildDatePickerGrid(viewAnchor, selectedDate);
  const parts = parseDateOnly(viewAnchor);

  const WEEKDAY_KEYS = [
    'weekdayMon',
    'weekdayTue',
    'weekdayWed',
    'weekdayThu',
    'weekdayFri',
    'weekdaySat',
    'weekdaySun',
  ] as const;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('datePickerTitle')}
      closeLabel={t('close')}
    >
      {/* `mb-4` is this row's own placement above the grid — `Stack` has no margin prop, hence the `Box` wrapper. */}
      <Box margin={[0, 0, 4, 0]}>
        <Stack direction="row" align="center" spacing={2}>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('previousDay')}
            onClick={() => {
              setViewAnchor((current) => addMonths(current, -1));
            }}
          >
            ‹
          </Button>
          {/*
            `Select` now takes `width="grow"`, which emits the wrapper's
            `flex-1` — filling the row between the two arrow buttons and the
            year select — through a real prop instead of `wrapperClassName`.
          */}
          <Select
            aria-label={t('monthLabel')}
            value={String(parts.month)}
            onChange={(event) => {
              setViewAnchor((current) =>
                addMonths(current, Number(event.target.value) - parts.month)
              );
            }}
            width="grow"
          >
            {Array.from({ length: MONTHS_IN_YEAR }, (_unused, index) => index + 1).map((month) => (
              <option key={month} value={month}>
                {f.monthName(month)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('yearLabel')}
            value={String(parts.year)}
            onChange={(event) => {
              setViewAnchor((current) =>
                addMonths(current, (Number(event.target.value) - parts.year) * MONTHS_IN_YEAR)
              );
            }}
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('nextDay')}
            onClick={() => {
              setViewAnchor((current) => addMonths(current, 1));
            }}
          >
            ›
          </Button>
        </Stack>
      </Box>

      {/* eslint-disable-next-line no-restricted-syntax -- `.calendar-grid` is the one class the design system cannot express (border-spacing has no token utility); see global.css */}
      <table className="calendar-grid">
        <VisuallyHidden as="caption">{t('gridLabel')}</VisuallyHidden>
        <thead>
          <tr>
            {WEEKDAY_KEYS.map((key) => (
              // `Text` renders `as="th"` with a `scope` prop, same as
              // `bulk-modal.tsx`'s weekday heads — collapses the `<th>`/inner
              // `<span>` pair into one element. This dialog has no weekend
              // recess to preserve, so the tone has no conditional. The
              // bottom padding is carried by `.calendar-grid th` in
              // `global.css`.
              <Text
                key={key}
                as="th"
                scope="col"
                size="xs"
                weight="bold"
                transform="uppercase"
                tracking="caps"
                tone="subtle"
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
                      selected={day.selected}
                      selectable={day.selectable}
                      aria-pressed={day.selectable ? day.selected : undefined}
                      aria-label={
                        day.selectable
                          ? t('dayCell', { date: f.fullDate(day.date) })
                          : t('dayCellBlocked', { date: f.fullDate(day.date) })
                      }
                      onClick={() => {
                        onSelect(day.date);
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
    </Modal>
  );
}
