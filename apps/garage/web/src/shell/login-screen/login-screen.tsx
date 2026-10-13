'use client';

/**
 * The signed-out canvas: the logo, two lines of explanation, one button, one
 * footnote. Drawn from `doc/design/screens/canvas-default.png` and the markup
 * behind it (`doc/design/garage-design.dc.html`, the `isLogin` branch).
 *
 * The button is a `<form action={…}>` submit rather than an `onClick`, and that
 * is the point of splitting this file from its page: the action is a **Server
 * Action** that calls `libs/garage/auth`'s server-side `signIn`, so the redirect to
 * Okta is issued by the server and the page works with JavaScript disabled.
 * Nothing about the credential exchange happens in the browser — see
 * `doc/auth.md` §"The flow, end to end".
 */

import { Box, Button, IconCircle, Stack, Text } from '@garage/design-system/primitives';
import { useTranslations } from '@garage/i18n';
import { Brand } from '../brand';

export interface LoginScreenProps {
  /** Server Action that starts the Okta authorization-code flow. */
  readonly action: () => Promise<void>;
}

export function LoginScreen({ action }: LoginScreenProps) {
  const t = useTranslations('login');

  return (
    // Split across two layers: `Box` carries the background and the
    // horizontal-only padding (`px-4`), `Stack` the full-viewport height
    // (`minHeight="viewport"`, i.e. `min-h-dvh`) and the centring
    // (`align`/`justify`/`spacing`) that used to sit on one element together.
    // `text-center` had no single prop either — each text child below gets
    // its own `align="center"` instead of relying on inheritance.
    <Box background="bg" padding={[0, 4]}>
      <Stack minHeight="viewport" align="center" justify="center" spacing={8}>
        <Brand size="lg" asHeading />

        <Text size="md" leading="loose" tone="subtle" align="center">
          {t('tagline')}
          <br />
          {t('taglineSecondary')}
        </Text>

        <form action={action}>
          <Button
            type="submit"
            size="xl"
            startAdornment={
              // The design's inset "O" chip: a translucent square on the blue
              // fill, not an icon. `translucent-light` (`bg-bg/20`) is the
              // white surface token at the design's 22% alpha.
              <IconCircle
                aria-hidden="true"
                size="xs"
                shape="square"
                tone="translucent-light"
                fontSize="xs"
                weight="bold"
              >
                O
              </IconCircle>
            }
          >
            {t('signIn')}
          </Button>
        </form>

        <Text
          as="p"
          size="xs"
          weight="bold"
          transform="uppercase"
          tracking="caps"
          tone="faint"
          align="center"
        >
          {t('footnote')}
        </Text>
      </Stack>
    </Box>
  );
}
