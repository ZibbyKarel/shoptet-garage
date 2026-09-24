'use client';

import {
  Badge,
  Box,
  IconCircle,
  INSET_FOCUS_RING,
  Stack,
  Text,
  cx,
} from '@garage/design-system/primitives';
import { useTranslations } from '@garage/i18n';
import { formatTimeRange, type SpotView } from '../lot-view';
import { CarGlyph } from './car-glyph';

export interface SpotTileProps {
  readonly spot: SpotView;
  /** Opening the spot's modal. Not called for an `editing` tile. */
  readonly onOpen: (spotId: string) => void;
  /**
   * The `⋯` button, admins only, on a taken spot. It opens the **same**
   * dialog `onOpen` does, deliberately: the contract exposes no procedure to
   * edit somebody else's reservation (only create-for-self and cancel), so
   * there is no second surface to route to. `SpotDialog` already renders the
   * admin-flavoured copy (`titleEdit`/`subAdmin`) and the cancel button off
   * `isAdmin` alone, regardless of which button opened it. What `⋯` adds is
   * discoverability that matches the design's own affordance
   * (`01-lot-admin.png`) — not a different modal. See `doc/decision/0125-*`.
   */
  readonly onAdminOpen: (spotId: string) => void;
}

/**
 * One parking bay.
 *
 * A **real `<button>`**, not a clickable `<div>`: Enter and Space, the focus
 * ring and the disabled state all come from the platform that way. An
 * `editing` tile is genuinely `disabled` rather than merely ignoring clicks,
 * which is also what keeps it out of the tab order — the design's `if
 * (locked) return;` is a pointer-only version of the same rule.
 *
 * The `⋯` button is a sibling button rather than a nested one: a button
 * inside a button is invalid HTML and browsers recover from it
 * unpredictably. It is not a menu — see {@link SpotTileProps.onAdminOpen}.
 */
export function SpotTile({ spot, onOpen, onAdminOpen }: SpotTileProps) {
  const t = useTranslations('lot');
  const inert = spot.action === 'none';

  /**
   * The bay's whole state, in its accessible name.
   *
   * `aria-label` **replaces** the button's contents as its accessible name,
   * and a screen reader treats a `<button>` as a single node — so everything
   * rendered inside it below ("Volné", the holder's name and plate,
   * "rezervace uzamčeny", "právě upravuje" and the editor) used to be
   * announced to nobody. A taken bay, a window-locked bay and a bay somebody
   * else is editing all read as "Otevřít místo E2.93", with no way to tell
   * them apart; the only state that survived was the waitlist `Badge`, which
   * happens to sit outside the button. See `doc/decision/0257-*`.
   *
   * Built from the **same keys the tile draws**, not from a second set written
   * for screen readers. Two catalogues saying nearly the same thing is how
   * they drift, and the visible text is already the true statement of the
   * state — an alternative wording could only ever be a worse copy of it.
   *
   * The waitlist pill is deliberately left out: it is a sibling of this
   * button, not a child, so it already has its own place in the reading order.
   */
  const stateWords: readonly (string | null)[] =
    spot.appearance === 'free'
      ? [t('free')]
      : spot.appearance === 'taken'
        ? [spot.holderName, spot.holderPlate]
        : spot.appearance === 'window-locked'
          ? [t('tileLocked')]
          : spot.appearance === 'timed'
            ? // `tileTimedLabel` builds the whole accessible name below rather
              // than joining onto the "Rezervovat/Otevřít místo" prefix — see
              // `accessibleName`.
              []
            : // "právě upravuje Jana Dvořáková" reads as one clause and is joined
              // with a space; the tile draws the same two strings on two lines.
              [
                spot.editorName === null
                  ? t('tileEditing')
                  : `${t('tileEditing')} ${spot.editorName}`,
              ];

  const accessibleName =
    spot.appearance === 'timed'
      ? t('tileTimedLabel', {
          label: spot.label,
          times: spot.timedBlocks.map((block) => formatTimeRange(block)).join(', '),
        })
      : [
          spot.appearance === 'free'
            ? t('reserveSpotAction', { label: spot.label })
            : t('openSpotAction', { label: spot.label }),
          ...stateWords,
        ]
          .filter((word): word is string => word !== null && word !== '')
          .join(', ');

  return (
    // eslint-disable-next-line no-restricted-syntax -- `.lot-bay`: the painted divider lines between bays and at the kerb (`--lot-line-w`/`--lot-kerb-w`), plus the bay's own stretch/max-width pair — domain geometry, no `Box` prop for either.
    <div className="lot-bay">
      <button
        type="button"
        disabled={inert}
        onClick={() => {
          onOpen(spot.spotId);
        }}
        aria-label={accessibleName}
        // eslint-disable-next-line no-restricted-syntax -- `.lot-bay-button` is the bay's own native-button chrome (height, gap, hover/disabled paint); `INSET_FOCUS_RING` is the design system's exported focus-ring constant, not a hand-picked utility.
        className={cx('lot-bay-button', INSET_FOCUS_RING)}
      >
        <Text as="span" size="sm" weight="bold" tracking="wide" tone="inverse-80">
          {spot.label}
        </Text>

        {spot.appearance === 'free' ? (
          // `Stack` now takes `as="span"`, so the flex layout (column,
          // centred, `gap-3`) moves onto it — `.lot-bay-free` shrinks to
          // just the dashed outline, the width/flex-sizing pair, and the
          // inherited caption/icon colour (`IconCircle`'s `translucent` tone
          // sets no foreground of its own), none of which `Stack` reaches.
          <Stack
            as="span"
            direction="column"
            align="center"
            justify="center"
            spacing={3}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-bay-free`: dashed outline, width/flex-sizing and inherited colour — see the comment above.
            className="lot-bay-free"
          >
            <IconCircle
              size="md"
              shape="circle"
              tone="translucent"
              fontSize="xl"
              weight="bold"
              leading="none"
            >
              +
            </IconCircle>
            <Text as="span" size="sm" weight="medium">
              {t('free')}
            </Text>
          </Stack>
        ) : null}

        {spot.appearance === 'timed' ? (
          // Same frame as `'free'` — dashed outline, width/flex-sizing,
          // inherited caption colour — with the blocks' time ranges in place
          // of "Volné" and no car glyph.
          <Stack
            as="span"
            direction="column"
            align="center"
            justify="center"
            spacing={1}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-bay-free`: reused as-is for this appearance too, see the comment above.
            className="lot-bay-free"
          >
            {spot.timedBlocks.slice(0, 2).map((block) => (
              <Text key={block.id} as="span" size="xs" weight="medium" align="center">
                {formatTimeRange(block)}
              </Text>
            ))}
            {spot.timedBlocks.length > 2 ? (
              <Text as="span" size="xs" align="center">
                {t('tileMoreBlocks', { count: spot.timedBlocks.length - 2 })}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        {spot.appearance === 'taken' && spot.carColorClass !== null ? (
          // Same move as `.lot-bay-free`: the flex layout is now `Stack`'s
          // job (`justify="start"` — the design starts this group at the top
          // of the bay, not centred, unlike the other three states).
          // `.lot-bay-taken` shrinks to the width/flex-sizing pair alone; it
          // never carried a border or colour of its own.
          <Stack
            as="span"
            direction="column"
            align="center"
            justify="start"
            spacing={2}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-bay-taken`: the width/flex-sizing pair only — see the comment above.
            className="lot-bay-taken"
          >
            <CarGlyph colorVar={spot.carColorClass} />
            <Text as="span" display="block" size="sm" weight="bold" tone="inverse" align="center">
              {spot.holderName}
            </Text>
            {spot.holderPlate === null ? null : (
              <Text
                as="span"
                display="block"
                size="xs"
                tracking="normal"
                tone="inverse-60"
                align="center"
              >
                {spot.holderPlate}
              </Text>
            )}
          </Stack>
        ) : null}

        {spot.appearance === 'window-locked' ? (
          // Same move as `.lot-bay-free`. `.lot-bay-locked` shrinks to the
          // solid tinted outline, the width/flex-sizing pair and the
          // inherited caption/icon colour.
          <Stack
            as="span"
            direction="column"
            align="center"
            justify="center"
            spacing={3}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-bay-locked`: solid tinted outline, width/flex-sizing and inherited colour — see the comment above.
            className="lot-bay-locked"
          >
            <IconCircle size="md" shape="circle" tone="translucent">
              ⊘
            </IconCircle>
            <Box padding={[0, 2]}>
              <Text as="span" size="xs" leading="snug" align="center">
                {t('tileLocked')}
              </Text>
            </Box>
          </Stack>
        ) : null}

        {spot.appearance === 'editing' ? (
          // Same move as `.lot-bay-free`. `.lot-bay-editing` shrinks to its
          // own yellow outline and the width/flex-sizing pair;
          // `.lot-hatch` (the hatched fill, Task 24's painted-surface class)
          // is unrelated to this move and stays exactly as it was.
          <Stack
            as="span"
            direction="column"
            align="center"
            justify="center"
            spacing={3}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-hatch`/`.lot-bay-editing`: the hatched fill plus this state's own yellow outline and width/flex-sizing pair — see the comment above.
            className={cx('lot-hatch', 'lot-bay-editing')}
          >
            <IconCircle size="md" shape="circle" tone="yellow" fontSize="base" weight="bold">
              ✎
            </IconCircle>
            <Box padding={[0, 2]}>
              <Text as="span" size="xs" leading="snug" align="center" tone="inverse">
                {t('tileEditing')}
                <br />
                <Text as="strong" weight="bold">
                  {spot.editorName}
                </Text>
              </Text>
            </Box>
          </Stack>
        ) : null}
      </button>

      {spot.hidden ? (
        <Box placement="top-left" interactive="none">
          <Badge size="sm" tone="neutral">
            {t('hiddenSpot')}
          </Badge>
        </Box>
      ) : null}

      {spot.waitlistCount > 0 ? (
        <Box placement="bottom-center" interactive="none">
          <Badge tone="warning">{t('waiting', { count: spot.waitlistCount })}</Badge>
        </Box>
      ) : null}

      {spot.showAdminMenu ? (
        <Box placement="top-right">
          <button
            type="button"
            onClick={() => {
              onAdminOpen(spot.spotId);
            }}
            aria-label={t('spotMenu', { label: spot.label })}
            // eslint-disable-next-line no-restricted-syntax -- `.lot-spot-menu`: the admin `⋯` control's own chrome (size, translucent fill, hover inversion) — no icon-button primitive exists for it, see the report.
            className="lot-spot-menu"
          >
            ⋯
          </button>
        </Box>
      ) : null}
    </div>
  );
}
