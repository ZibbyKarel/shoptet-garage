'use client';

/**
 * The bar every signed-in screen sits under: the logo on the left, the
 * identity and its menu on the right.
 *
 * Drawn from `doc/design/screens/02-avatar-menu.png` and the markup behind it
 * (`doc/design/garage-design.dc.html`, the `isApp` branch). Composition
 * only — `Avatar`, `Badge` and `Dropdown` are design-system primitives, and
 * nothing presentational is invented here. The menu's keyboard behaviour,
 * roving tabindex, click-outside and Escape handling all come from `Dropdown`.
 *
 * It takes what it draws as props and reports what was chosen through two
 * callbacks; `../app-top-bar.tsx` is the half that reads the session and the
 * profile. The split is not ceremony: every rule this file encodes — when the
 * `ADMIN` badge appears, when `Správa` appears, what the initials are, which
 * entry is destructive — is then a pure function of its input, and a test can
 * ask about all of them without a router, a session or a network.
 */

import { Avatar, Badge, Box, Dropdown, Link, Stack, Text } from '@garage/design-system/primitives';
import type { DropdownItem } from '@garage/design-system/primitives';
import type { UserRole } from '@garage/contract';
import { LOCALES, LOCALE_LABELS, isLocale, useTranslations, type Locale } from '@garage/i18n';
import NextLink from 'next/link';
import { ADMIN_ROUTE, LOT_ROUTE, SETTINGS_ROUTE } from '../../routes';
import { Brand } from '../brand';
import { initialsOf } from '../initials';

/** Menu entry ids. `Dropdown.onSelect` reports one of these back. */
export const MENU_SETTINGS = 'settings';
export const MENU_ADMIN = 'administration';
export const MENU_SIGN_OUT = 'sign-out';

/** Prefix of the `Dropdown` item id for a language choice: `locale:cs`, `locale:en`. */
export const MENU_LOCALE_PREFIX = 'locale:';

export interface TopBarProps {
  /** Display name. Empty while neither the session nor the profile has one. */
  readonly name: string;
  /** Shown under the name inside the menu. */
  readonly email: string;
  /**
   * The caller's role, or `undefined` while `me.get` is in flight or after it
   * failed. Anything other than `ADMIN` — `undefined` included — hides both the
   * badge and the `Správa` entry: unknown is not an admin.
   */
  readonly role?: UserRole | undefined;
  /** Called with {@link ADMIN_ROUTE} or {@link SETTINGS_ROUTE}. */
  readonly onNavigate: (route: string) => void;
  readonly onSignOut: () => void;
  /** The active locale, so the menu can mark it. */
  readonly locale: Locale;
  /** Called with the locale the user picked. Never called for the active one. */
  readonly onLocaleChange: (locale: Locale) => void;
}

export function TopBar({
  name,
  email,
  role,
  onNavigate,
  onSignOut,
  locale,
  onLocaleChange,
}: TopBarProps) {
  const t = useTranslations('nav');
  const isAdmin = role === 'ADMIN';

  // A labelled group of radio-style entries rather than a submenu: two
  // languages do not earn a nested panel, and `Dropdown` has no submenu to
  // nest into. The header is a disabled item, which is how `Dropdown` renders
  // text the arrow keys skip.
  const languageItems: DropdownItem[] = [
    { id: 'language-separator', separator: true },
    { id: 'language-header', label: t('language'), disabled: true },
    ...LOCALES.map((candidate) => ({
      id: `${MENU_LOCALE_PREFIX}${candidate}`,
      label: LOCALE_LABELS[candidate],
      checked: candidate === locale,
    })),
  ];

  const items: DropdownItem[] = [
    { id: 'identity-separator', separator: true },
    { id: MENU_SETTINGS, label: t('settings') },
    ...(isAdmin
      ? [
          {
            id: MENU_ADMIN,
            label: t('administration'),
            // The design draws a right arrow on this entry alone, marking it
            // as the one that leaves the current screen.
            trailing: <span aria-hidden="true">→</span>,
          },
        ]
      : []),
    ...languageItems,
    { id: 'sign-out-separator', separator: true },
    { id: MENU_SIGN_OUT, label: t('signOut'), danger: true },
  ];

  const onSelect = (id: string) => {
    if (id === MENU_SETTINGS) {
      onNavigate(SETTINGS_ROUTE);
    } else if (id === MENU_ADMIN) {
      onNavigate(ADMIN_ROUTE);
    } else if (id.startsWith(MENU_LOCALE_PREFIX)) {
      const picked = id.slice(MENU_LOCALE_PREFIX.length);
      // Re-picking the active language is a no-op rather than a reload: the
      // cookie is already set and `router.refresh()` would repaint for nothing.
      if (isLocale(picked) && picked !== locale) {
        onLocaleChange(picked);
      }
    } else if (id === MENU_SIGN_OUT) {
      onSignOut();
    }
  };

  return (
    // `Box` supplies the sticky positioning (`position="sticky"`, `inset="top"`),
    // the `--z-sticky` layer (`layer="sticky"`), the fixed bar height
    // (`height="bar"`, i.e. `h-16`), the bottom-only rule (`border="bottom"`,
    // i.e. `border-b border-border` — matching the original single-element
    // markup exactly, not the four-sided `border border-border` a bare
    // `border` boolean would emit) and the horizontal padding. `Stack` is the
    // `flex items-center justify-between gap-4` row inside it, with
    // `height="full"` (`h-full`) so it fills the bar's fixed 64px instead of
    // sizing to its own content — `align="center"` then centres against that
    // real height, matching the original `flex h-16 items-center`.
    <Box
      as="header"
      position="sticky"
      inset="top"
      layer="sticky"
      height="bar"
      border="bottom"
      background="bg"
      padding={[0, 4]}
    >
      <Stack direction="row" height="full" align="center" justify="between" spacing={4}>
        <Link tone="plain" as={NextLink} href={LOT_ROUTE}>
          <Brand />
        </Link>

        <Stack direction="row" align="center" spacing={3}>
          {isAdmin ? (
            <Badge tone="info" transform="uppercase">
              {t('adminBadge')}
            </Badge>
          ) : null}

          <Dropdown
            triggerLabel={t('userMenu')}
            label={t('userMenu')}
            trigger={
              <>
                <Avatar tone="dark" initials={initialsOf(name)} />
                <Text as="span" weight="medium">
                  {name}
                </Text>
                <Text as="span" size="xs" tone="subtle" aria-hidden="true">
                  ▾
                </Text>
              </>
            }
            header={
              <div>
                <Text weight="bold">{name}</Text>
                <Text size="xs" tone="subtle">
                  {email}
                </Text>
              </div>
            }
            items={items}
            onSelect={onSelect}
          />
        </Stack>
      </Stack>
    </Box>
  );
}
