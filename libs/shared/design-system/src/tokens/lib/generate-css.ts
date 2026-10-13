import { fontStack } from './typography';
import type { DesignTokens } from './tokens';

/**
 * Emits `var(--target)` for a token that `colors_and_type.css` defines as an
 * alias of another token rather than as a literal value.
 *
 * The TS token objects hold resolved values (`SURFACE_COLORS.bg` is the string
 * `#FFFFFF`, not a reference), so without this the generator would flatten the
 * source's alias chains to literals. The chains are semantically load-bearing —
 * re-pointing `--bg` at a different neutral is how a future theme is built, and
 * that only works if consumers inherit the reference. So the alias is emitted,
 * and this guard proves the two sides still agree: if someone changes
 * `SURFACE_COLORS.bg` without changing `NEUTRAL_COLORS[0]`, generation throws
 * instead of silently writing `--bg: var(--neutral-0)` for a token that no
 * longer holds that value.
 *
 * @param targetProperty the aliased custom property, e.g. `--neutral-0`
 * @param targetValue    the current TS value of that property
 * @param aliasValue     the current TS value of the token being emitted
 */
function alias(targetProperty: string, targetValue: string, aliasValue: string): string {
  if (targetValue !== aliasValue) {
    throw new Error(
      `Token alias drift: colors_and_type.css defines this token as ` +
        `var(${targetProperty}), but its TS value ${JSON.stringify(aliasValue)} no longer ` +
        `equals ${JSON.stringify(targetValue)}. Either restore the values or stop ` +
        `emitting it as an alias.`
    );
  }

  return `var(${targetProperty})`;
}

/**
 * Renders `DESIGN_TOKENS` to the CSS custom-property file the design system
 * ships (`assets/tokens.css`). Every `--name` here is written out explicitly
 * (no reflection over object keys) so a reviewer can diff this function
 * against `colors_and_type.css` line by line.
 *
 * This is a pure function of its input — no filesystem access — so it can be
 * called both by `scripts/build-tokens-css.ts` (to write the file) and by
 * `generate-css.spec.ts` (to prove the written file is still current).
 */
export function generateTokensCss(tokens: DesignTokens): string {
  const {
    colors,
    carColorPalette,
    typography,
    spacing,
    radius,
    shadows,
    motion,
    layout,
    controls,
    overlays,
  } = tokens;
  const { brand, neutral, surface, fg, line, status } = colors;
  const { families, faces, fontSize, lineHeight, letterSpacing } = typography;

  const fontFaceBlocks = faces
    .map(
      (face) => `@font-face {
  font-family: "NHaasGroteskDS";
  font-weight: ${face.weight};
  font-style: ${face.style};
  font-display: swap;
  src: url("./fonts/${face.file}") format("opentype");
}`
    )
    .join('\n');

  const fontSansValue = fontStack(families.sans);
  const fontMonoValue = fontStack(families.mono);

  const rootBlock = `:root {
  /* --- Brand color palette --- */
  --brand-blue: ${brand.blue};
  --brand-green: ${brand.green};
  --brand-yellow: ${brand.yellow};
  --brand-light: ${brand.light};
  --brand-dark: ${brand.dark};
  --brand-black: ${brand.black};

  --text: ${brand.text};

  --brand-blue-700: ${brand.blue700};
  --brand-green-700: ${brand.green700};
  --brand-yellow-700: ${brand.yellow700};

  --brand-blue-100: ${alias('--brand-light', brand.light, brand.blue100)};
  --brand-green-100: ${brand.green100};
  --brand-yellow-100: ${brand.yellow100};

  /* --- Neutrals --- */
  --neutral-0: ${neutral[0]};
  --neutral-50: ${neutral[50]};
  --neutral-100: ${neutral[100]};
  --neutral-200: ${neutral[200]};
  --neutral-300: ${neutral[300]};
  --neutral-400: ${neutral[400]};
  --neutral-500: ${neutral[500]};
  --neutral-600: ${neutral[600]};
  --neutral-700: ${neutral[700]};
  --neutral-800: ${neutral[800]};
  --neutral-900: ${neutral[900]};
  --neutral-950: ${neutral[950]};

  /* --- Semantic surfaces --- */
  --bg: ${alias('--neutral-0', neutral[0], surface.bg)};
  --bg-soft: ${alias('--neutral-50', neutral[50], surface.bgSoft)};
  --bg-muted: ${alias('--neutral-100', neutral[100], surface.bgMuted)};
  --bg-inverse: ${alias('--brand-dark', brand.dark, surface.bgInverse)};

  /* --- Semantic foreground --- */
  --fg: ${alias('--text', brand.text, fg.fg)};
  --fg-2: ${alias('--neutral-700', neutral[700], fg.fg2)};
  --fg-3: ${alias('--neutral-500', neutral[500], fg.fg3)};
  --fg-on-yellow: ${alias('--brand-dark', brand.dark, fg.onYellow)};
  --fg-on-green: ${alias('--neutral-0', neutral[0], fg.onGreen)};
  --fg-on-blue: ${alias('--neutral-0', neutral[0], fg.onBlue)};
  --fg-on-light: ${alias('--brand-dark', brand.dark, fg.onLight)};
  --fg-on-dark: ${alias('--neutral-0', neutral[0], fg.onDark)};

  /* --- Lines --- */
  --border: ${alias('--neutral-200', neutral[200], line.border)};
  --border-strong: ${alias('--neutral-300', neutral[300], line.borderStrong)};
  --divider: ${alias('--neutral-100', neutral[100], line.divider)};

  /* --- Status --- */
  --success: ${alias('--brand-green', brand.green, status.success)};
  --info: ${alias('--brand-blue', brand.blue, status.info)};
  --warning: ${alias('--brand-yellow', brand.yellow, status.warning)};
  --danger: ${status.danger};
  --danger-100: ${status.danger100};

  /* --- Car color palette ---
     Scoped ONLY to the repeating glyphs on the app's map surface — see
     car-palette.ts. Deliberately namespaced away from the general palette. */
  --palette-car-1: ${carColorPalette[0]};
  --palette-car-2: ${carColorPalette[1]};
  --palette-car-3: ${carColorPalette[2]};

  /* --- Type families --- */
  --font-sans: ${fontSansValue};
  --font-mono: ${fontMonoValue};

  /* --- Type scale --- */
  --fs-xs: ${fontSize.xs};
  --fs-sm: ${fontSize.sm};
  --fs-base: ${fontSize.base};
  --fs-md: ${fontSize.md};
  --fs-lg: ${fontSize.lg};
  --fs-xl: ${fontSize.xl};
  --fs-2xl: ${fontSize['2xl']};
  --fs-3xl: ${fontSize['3xl']};
  --fs-4xl: ${fontSize['4xl']};
  --fs-5xl: ${fontSize['5xl']};
  --fs-6xl: ${fontSize['6xl']};

  /* --- Line heights --- */
  --lh-tight: ${lineHeight.tight};
  --lh-snug: ${lineHeight.snug};
  --lh-normal: ${lineHeight.normal};
  --lh-loose: ${lineHeight.loose};

  /* --- Letter spacing --- */
  --tracking-tight: ${letterSpacing.tight};
  --tracking-snug: ${letterSpacing.snug};
  --tracking-normal: ${letterSpacing.normal};
  --tracking-wide: ${letterSpacing.wide};
  --tracking-caps: ${letterSpacing.caps};

  /* --- Spacing scale (4px base) --- */
  --space-1: ${spacing[1]};
  --space-2: ${spacing[2]};
  --space-3: ${spacing[3]};
  --space-4: ${spacing[4]};
  --space-5: ${spacing[5]};
  --space-6: ${spacing[6]};
  --space-8: ${spacing[8]};
  --space-10: ${spacing[10]};
  --space-12: ${spacing[12]};
  --space-16: ${spacing[16]};
  --space-20: ${spacing[20]};
  --space-24: ${spacing[24]};
  --space-32: ${spacing[32]};

  /* --- Radii --- */
  --radius-photos: ${radius.photos};
  --radius-xs: ${radius.xs};
  --radius-sm: ${radius.sm};
  --radius-md: ${radius.md};
  --radius-lg: ${radius.lg};
  --radius-xl: ${radius.xl};
  --radius-cta: ${radius.cta};
  --radius-pill: ${alias('--radius-cta', radius.cta, radius.pill)};

  /* --- Shadows --- */
  --shadow-xs: ${shadows.xs};
  --shadow-sm: ${shadows.sm};
  --shadow-md: ${shadows.md};
  --shadow-lg: ${shadows.lg};
  --shadow-blue: ${shadows.blue};
  --shadow-yellow: ${shadows.yellow};

  /* --- Motion --- */
  --ease-out: ${motion.easing.out};
  --ease-in-out: ${motion.easing.inOut};
  --dur-fast: ${motion.duration.fast};
  --dur-base: ${motion.duration.base};
  --dur-slow: ${motion.duration.slow};

  /* --- Layout --- */
  --container: ${layout.container.base};
  --container-wide: ${layout.container.wide};

  /* --- Controls ---
     DERIVED from garage-design.dc.html, NOT from colors_and_type.css —
     see controls.ts and doc/decision/0011-derived-control-tokens-and-rounding.md. */
  --control-h-sm: ${controls.height.sm};
  --control-h-md: ${controls.height.md};
  --control-h-lg: ${controls.height.lg};
  --control-h-xl: ${controls.height.xl};

  --switch-w: ${controls.switch.trackWidth};
  --switch-h: ${controls.switch.trackHeight};
  --switch-pad: ${controls.switch.trackPadding};
  --switch-knob: ${controls.switch.knobSize};
  --switch-knob-shadow: ${controls.switch.knobShadow};

  /* --- Overlays and layering ---
     DERIVED from garage-design.dc.html where the design draws the thing,
     invented where it does not — see overlays.ts and doc/decision/0052-*. */
  --z-sticky: ${overlays.z.sticky};
  --z-bar: ${overlays.z.bar};
  --z-overlay: ${overlays.z.overlay};
  --z-dropdown: ${overlays.z.dropdown};
  --z-toast: ${overlays.z.toast};

  --scrim: ${overlays.scrim};

  --modal-w-sm: ${overlays.size.modalWidth.sm};
  --modal-w-md: ${overlays.size.modalWidth.md};
  --menu-min-w: ${overlays.size.menuMinWidth};
  --tab-indicator-h: ${overlays.size.tabIndicator};
  --toast-w: ${overlays.size.toastWidth};
}`;

  return `/* ============================================================
   GENERATED FILE — do not hand-edit.
   Source: libs/shared/design-system/src/tokens/lib/*.ts (DESIGN_TOKENS).
   Regenerate with: npx nx run design-system:generate-css
   ============================================================ */

/* ---------- Web fonts (Neue Haas Grotesk Display Pro) ---------- */
${fontFaceBlocks}

/* ---------- Tokens ---------- */
${rootBlock}
`;
}
