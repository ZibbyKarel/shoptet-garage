'use client';

/**
 * Everything above the map. All presentational.
 *
 * - {@link LotHeader} — the date pill (prev/next day, and a button that opens
 *   `./date-picker-dialog`'s `DatePickerDialog`), the "Dnes" shortcut, the
 *   occupancy pill and the bulk-reservation button. This is where
 *   `./date-nav-bar`'s sticky footer bar moved to
 *   (`doc/design/garage-design.dc.html`'s current `isLot` header row) —
 *   there is no footer left on this screen (Task 25 revisited).
 * - {@link WindowBanner} — the one true sentence about the month's window;
 * - {@link RealtimeNotice} — the affordance for a refused socket.
 */

import {
  Box,
  Button,
  Callout,
  Chip,
  IconCircle,
  Spacer,
  Stack,
  Text,
  VisuallyHidden,
} from '@garage/design-system/primitives';
import { useDateFormatters, useTranslations } from '@garage/i18n';
import type { DateOnly } from '@garage/i18n';
import type { BannerView, DayNoteView, LotCounts } from '../lot-view';

export interface LotHeaderProps {
  readonly date: DateOnly;
  readonly note: DayNoteView;
  readonly counts: LotCounts;
  /** Accessible page title. Not shown — the design has no visible heading. */
  readonly sectionTitle: string;
  /**
   * `windowOpen || admin` — the design's `batchAllowed`. When it is false the
   * button is **absent**, not disabled: a normal user in a locked month has no
   * bulk action to take, and a greyed-out control invites a click that will
   * only ever be refused.
   */
  readonly showBulk: boolean;
  readonly onBulk: () => void;
  readonly onPreviousDay: () => void;
  readonly onNextDay: () => void;
  readonly onToday: () => void;
  /** Opens `./date-picker-dialog`'s `DatePickerDialog`, owned by `../lot-screen/lot-screen.tsx`. */
  readonly onOpenDatePicker: () => void;
}

export function LotHeader({
  date,
  note,
  counts,
  sectionTitle,
  showBulk,
  onBulk,
  onPreviousDay,
  onNextDay,
  onToday,
  onOpenDatePicker,
}: LotHeaderProps) {
  const t = useTranslations('lot');
  const f = useDateFormatters();

  return (
    // `mb-6` on the row below is caller spacing, not part of `Stack` — expressed
    // as a wrapping `Box margin=` (a bottom-only quad, since `Stack` has no
    // margin prop of its own).
    <Box margin={[0, 0, 6, 0]}>
      <Stack direction="row" wrap align="center" justify="between" spacing={6}>
        {/* The design has no visible page title — the date pill is the heading
            now — but the document still needs one `h1` for assistive tech. */}
        <VisuallyHidden as="h1">{sectionTitle}</VisuallyHidden>

        <Stack direction="row" wrap align="center" spacing={3}>
          {/* `Box`'s radius scale now includes `cta`, the fully-rounded pill
              step every other pill-shaped control in the design uses. */}
          <Box border background="bg" padding={1} radius="cta">
            <Stack direction="row" align="center" spacing={1}>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('previousDay')}
                onClick={onPreviousDay}
              >
                <Text size="lg">‹</Text>
              </Button>
              <Button variant="ghost" size="sm" onClick={onOpenDatePicker}>
                {f.fullDate(date)}
              </Button>
              <Button variant="ghost" size="sm" aria-label={t('nextDay')} onClick={onNextDay}>
                <Text size="lg">›</Text>
              </Button>
            </Stack>
          </Box>
          <Text
            size="xs"
            weight="bold"
            transform="uppercase"
            tracking="caps"
            tone={note.highlighted ? 'default' : 'subtle'}
          >
            {t(note.key, { name: note.name })}
          </Text>
        </Stack>

        <Stack direction="row" wrap align="center" spacing={3}>
          <Button variant="outline" size="sm" onClick={onToday}>
            {t('today')}
          </Button>
          {/* Byte-for-byte `Chip`'s `md` size + `outline` tone, rendered as the
              `<p>` this call site has always used — see `chip.tsx`'s own
              `ChipAs` doc comment, which names this exact spot. */}
          <Chip size="md" tone="outline" as="p">
            {t('occupiedCount', { taken: counts.taken, total: counts.free + counts.taken })}
          </Chip>
          {showBulk ? (
            <Button size="sm" onClick={onBulk}>
              {t('bulkReservation')}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}

/**
 * The status banner above the map.
 *
 * There is always exactly one: `overview.day` always carries a `window`, and
 * each of its three states has one true sentence. See `doc/decision/0122-*`
 * for why the design's `showLockState` prototype prop is not a hiding rule.
 *
 * `role="status"` so a screen reader is told when the window changes under a
 * page that is already open — which an admin flipping `lockMode` does, through
 * a refetch, without the user navigating anywhere.
 */
export function WindowBanner({ banner }: { readonly banner: BannerView }) {
  const t = useTranslations('lot');
  const isSuccess = banner.tone === 'success';

  return (
    // `mb-5` was baked into the panel's own className before `Callout` existed;
    // it is caller placement, not chrome, so it moves to a wrapping `Box`.
    <Box margin={[0, 0, 5, 0]}>
      <Callout
        tone={isSuccess ? 'success' : 'warning'}
        align="center"
        role="status"
        icon={
          // `tone="green"` reads `text-brand-dark` here, not white — a
          // deliberate contrast fix (`doc/decision/0266`) that changes this
          // glyph's colour on the green banner.
          <IconCircle size="sm" shape="square" tone={isSuccess ? 'green' : 'yellow'} weight="bold">
            {isSuccess ? '✓' : '⊘'}
          </IconCircle>
        }
      >
        <Text size="base" leading="snug">
          {t(banner.messageKey, banner.values)}
        </Text>
      </Callout>
    </Box>
  );
}

/**
 * The board has stopped updating itself.
 *
 * Two states reach here and the sentence is the same for both, because it is
 * the true one for both: live updates are off, so the overview may not refresh
 * on its own. What differs is whether there is anything for the user to do.
 *
 * - **Refused** (`doc/decision/0061-*` makes a refused handshake terminal for
 *   that socket and bounds the automatic retries, precisely so a page cannot
 *   sit forever presenting a credential the gateway has already rejected).
 *   Nothing will happen without the user, so `onReconnect` is passed and the
 *   button — the intended caller of the connection's unconditional
 *   `reconnect()` — is drawn.
 * - **Dropped**, and reconnecting on its own. `onReconnect` is omitted and the
 *   notice is the quieter, buttonless variant: a control that duplicates what
 *   is already in progress invites a click that changes nothing.
 *
 * One `realtimeRejected` string covers both. The key is named for the state it
 * was written for, but the sentence names neither — it says the connection is
 * down and what that means for the screen — and inventing a second, identical
 * string so the two keys could differ would be catalogue noise.
 */
export function RealtimeNotice({
  onReconnect,
}: {
  /** Omitted for a drop the connection is already recovering from. */
  readonly onReconnect?: (() => void) | undefined;
}) {
  const t = useTranslations('lot');

  return (
    <Box margin={[0, 0, 5, 0]}>
      {/* No `icon` slot here, so `Callout` imposes no layout of its own — the
          text-plus-button row is this caller's own `Stack`, exactly as
          `callout.tsx`'s doc comment names this call site. */}
      <Callout tone="warning" role="status">
        <Stack direction="row" wrap align="center" spacing={3}>
          <Text size="base" leading="snug">
            {t('realtimeRejected')}
          </Text>
          {onReconnect === undefined ? null : (
            <>
              {/* Grows to fill the row, pushing the button to the trailing edge —
                  the same job the original `<p className="flex-1">` did. */}
              <Spacer />
              <Button variant="secondary" size="sm" onClick={onReconnect}>
                {t('realtimeReconnect')}
              </Button>
            </>
          )}
        </Stack>
      </Callout>
    </Box>
  );
}
