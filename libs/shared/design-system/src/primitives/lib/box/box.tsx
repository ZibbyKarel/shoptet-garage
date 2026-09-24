import { forwardRef, type HTMLAttributes, type Ref } from 'react';

import { cx } from '../cx';
import { type Padding, resolvePadding } from '../padding';

export type BoxBackground = 'bg' | 'bg-soft' | 'bg-muted';
export type BoxRadius = 'sm' | 'md' | 'lg' | 'cta';

/**
 * `bg-{name}` utility literals. These are utility names, not the `SURFACE_COLORS`
 * TS token object in `colors.ts` (whose keys are `bg`/`bgSoft`/`bgMuted`/`bgInverse`):
 * the "Colors" section of `theme.css` maps `--color-bg`/`--color-bg-soft`/
 * `--color-bg-muted` into Tailwind's `@theme`, so `bg-bg`/`bg-bg-soft`/`bg-bg-muted`
 * are the real utilities — there is no `bg-surface`.
 */
const BACKGROUND_CLASSES: Record<BoxBackground, string> = {
  bg: 'bg-bg',
  'bg-soft': 'bg-bg-soft',
  'bg-muted': 'bg-bg-muted',
};

/**
 * `rounded-{step}` utility literals for the subset of `RADIUS`
 * (`libs/shared/design-system/src/tokens/lib/radius.ts`) exposed here. The "Radius"
 * section of `theme.css` maps `--radius-sm`/`--radius-md`/`--radius-lg`/`--radius-cta`
 * into `@theme`, so each of these resolves to its token value, not Tailwind's
 * stock scale. `cta` is the fully-rounded (360px) pill radius the design
 * spends on every call-to-action control — `Chip` and `IconCircle` already
 * use it; the date-navigation pill in `lot-header.tsx` is the third spender.
 */
const RADIUS_CLASSES: Record<BoxRadius, string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  cta: 'rounded-cta',
};

export type BoxBorderSide = 'bottom' | 'top';

/**
 * `border` used to be a plain boolean (`border border-border`, all four
 * sides). The app shell's header (`top-bar.tsx`) needs a bottom rule only —
 * the original markup was `border-b border-border` — so `true` is kept
 * byte-identical to before and `'bottom'`/`'top'` are added alongside it,
 * rather than a second `borderBottom`-shaped prop. No caller in
 * `apps/garage/web/src` needs `'left'`/`'right'` yet (grepped before
 * adding these two) — add on demand, same as every other variant table here.
 */
const BORDER_CLASSES: Record<BoxBorderSide, string> = {
  bottom: 'border-b border-border',
  top: 'border-t border-border',
};

export type BoxPosition = 'static' | 'relative' | 'absolute' | 'sticky';

/**
 * `static` emits nothing — it is the browser default, and doing so keeps a
 * `<Box>` with no `position` prop byte-identical to before this prop existed.
 */
const POSITION_CLASSES: Record<BoxPosition, string> = {
  static: '',
  relative: 'relative',
  absolute: 'absolute',
  sticky: 'sticky',
};

export type BoxInset = 'top';

/** `top-0` — the only inset this covers so far; a `sticky` header pins here. */
const INSET_CLASSES: Record<BoxInset, string> = {
  top: 'top-0',
};

/**
 * Stacking layers, restricted to the `Z_LAYERS` entries
 * (`libs/shared/design-system/src/tokens/lib/overlays.ts`) a plain `Box` plausibly needs to
 * spend directly. The modal scrim/dialog pair is named `overlay` in `theme.css`
 * (`--z-overlay`), not `modal` — there is no `--z-modal`, so this follows the
 * token's real name rather than the more casual word for it. `bar`/`toast`
 * exist in the same scale but are not exposed here because nothing building a
 * plain `Box` has needed them yet; add on demand.
 */
export type BoxLayer = 'sticky' | 'dropdown' | 'overlay';

/**
 * `z-[var(--z-sticky)]`-shaped arbitrary-value literals. `theme.css` explains why the `--z-` scale
 * has no Tailwind theme namespace to map into (z-index has no `--z-index-*`
 * scale for Tailwind v4 to read) — these are spelled out per layer, same as
 * every other class table here, so the scanner sees each one verbatim.
 */
const LAYER_CLASSES: Record<BoxLayer, string> = {
  sticky: 'z-[var(--z-sticky)]',
  dropdown: 'z-[var(--z-dropdown)]',
  overlay: 'z-[var(--z-overlay)]',
};

export type BoxHeight = 'bar';

/**
 * `h-16` (64px) — the app shell's header height (`top-bar.tsx`). No token
 * expresses 64px: `CONTROL_HEIGHTS` (`tokens/lib/controls.ts`) tops out at
 * 56px and is for interactive controls, not the bar that contains them, so
 * this stays a plain Tailwind step rather than an invented token.
 */
const HEIGHT_CLASSES: Record<BoxHeight, string> = {
  bar: 'h-16',
};

export type BoxMinHeight = 'viewport';

/** `min-h-dvh` — a full-viewport centring wrapper (`login-screen.tsx`). */
const MIN_HEIGHT_CLASSES: Record<BoxMinHeight, string> = {
  viewport: 'min-h-dvh',
};

export type BoxShadow = 'sm' | 'md' | 'lg';

/**
 * `shadow-{step}` utility literals. `theme.css` maps `--shadow-sm`/`-md`/`-lg`
 * (`SHADOWS` in `tokens/lib/shadows.ts`) into `@theme`, so these resolve to
 * the token ramp, not Tailwind's stock shadows. `xs`/`blue`/`yellow` exist in
 * the same token scale but are left out here: `xs` has had no caller yet and
 * `blue`/`yellow` are CTA hover glows, not part of the plain elevation ramp.
 */
const SHADOW_CLASSES: Record<BoxShadow, string> = {
  sm: 'shadow-sm',
  md: 'shadow-md',
  lg: 'shadow-lg',
};

export type BoxPlacement =
  | 'top-left'
  | 'top-right'
  | 'top-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'bottom-center';

/**
 * Inset + translate utilities per corner/edge. `2` (`0.5rem`) is the one
 * offset the design uses for an overlay pinned to a tile's edge, kept as the
 * same step across every placement below rather than let each one drift.
 * Spelled out as literals, not built from a shared constant: Tailwind v4
 * scans source text statically, so `` `top-${x}` `` would never match
 * anything and emit no CSS.
 */
const PLACEMENT_CLASSES: Record<BoxPlacement, string> = {
  'top-left': 'left-2 top-2',
  'top-right': 'right-2 top-2',
  'top-center': 'top-2 left-1/2 -translate-x-1/2',
  'bottom-left': 'left-2 bottom-2',
  'bottom-right': 'right-2 bottom-2',
  'bottom-center': 'bottom-2 left-1/2 -translate-x-1/2',
};

/**
 * Elements a `Box` may render as, so it can carry semantic landmarks
 * (`<header>`, `<nav>`, …) instead of forcing callers to keep a native
 * element with hand-written classes around it. Follows `Divider`'s tag-switch
 * idiom, just over more tags — every one of these accepts the same
 * `HTMLAttributes` surface, so there is no per-tag branching to do beyond
 * picking which string JSX renders.
 */
export type BoxAs =
  | 'div'
  | 'section'
  | 'header'
  | 'footer'
  | 'main'
  | 'nav'
  | 'aside'
  | 'article'
  | 'span';

export interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  /** Which element to render. Defaults to `div`. */
  as?: BoxAs | undefined;
  /** `p-*`/`py-*`+`px-*`/`pt-*`+`pr-*`+`pb-*`+`pl-*`, see `Padding`. */
  padding?: Padding | undefined;
  /** Same shape as `padding`, applied as margin instead. */
  margin?: Padding | undefined;
  /** `bg-bg`/`bg-bg-soft`/`bg-bg-muted`. */
  background?: BoxBackground | undefined;
  /** `rounded-sm`/`rounded-md`/`rounded-lg`/`rounded-cta` (the fully-rounded pill radius). */
  radius?: BoxRadius | undefined;
  /**
   * `true` emits `border border-border` (all four sides, unchanged from
   * before this prop grew). `'bottom'`/`'top'` emit a single-sided rule
   * (`border-b`/`border-t border-border`) — the app shell's header wants a
   * bottom rule only, not the full box.
   */
  border?: boolean | BoxBorderSide | undefined;
  /**
   * `static`/`relative`/`absolute`/`sticky`. Defaults to `static` (no class
   * emitted). A tile that positions overlays inside itself sets this to
   * `relative` on the tile and `absolute` (or a `placement`, which implies
   * it) on each overlay; the app shell's header sets it to `sticky`.
   */
  position?: BoxPosition | undefined;
  /** `top-0`. Meant to pair with `position="sticky"` (the app shell's header pins to the viewport top). */
  inset?: BoxInset | undefined;
  /** `z-[var(--z-sticky)]`-shaped literal per layer — which layer of the shared stacking order this box sits on. */
  layer?: BoxLayer | undefined;
  /** `h-16` — the app shell's fixed bar height. */
  height?: BoxHeight | undefined;
  /** `min-h-dvh` — a full-viewport centring wrapper. */
  minHeight?: BoxMinHeight | undefined;
  /** `shadow-sm`/`shadow-md`/`shadow-lg`. */
  shadow?: BoxShadow | undefined;
  /**
   * Where on the parent to pin this box — inset + translate utilities for
   * one corner or edge-centre. **Implies `position="absolute"`** even if
   * `position` was left at its default or set to something else: a caller
   * asking to be pinned to a corner has no coherent reading of "static", so
   * rather than silently no-op this always wins.
   */
  placement?: BoxPlacement | undefined;
  /** `'none'` emits `pointer-events-none` — an overlay that must not block clicks through to what is beneath it. */
  interactive?: 'none' | undefined;
}

/**
 * General-purpose escape hatch for layout tweaks `Stack`/`Container`/`Card`/`Divider`
 * do not cover, so feature code never has to reach back for raw Tailwind.
 * Presentation-only, like every primitive here — no domain data.
 */
export const Box = forwardRef<HTMLElement, BoxProps>(function Box(
  {
    as: Component = 'div',
    padding,
    margin,
    background,
    radius,
    border = false,
    position = 'static',
    inset,
    layer,
    height,
    minHeight,
    shadow,
    placement,
    interactive,
    className,
    children,
    ...rest
  },
  ref
) {
  const resolvedPosition = placement !== undefined ? 'absolute' : position;

  return (
    <Component
      {...rest}
      // `Component` is a union of intrinsic tags, each with its own element
      // type for `ref` (an `<hr>`'s ref type has no overlap with a `<div>`'s,
      // for instance) — TS cannot narrow that union from a runtime-chosen
      // string, so the cast is unavoidable here, same as `Divider`'s two
      // branches each cast their own `ref`. `HTMLElement` is safely the
      // common supertype of every tag in `BoxAs`.
      ref={ref as Ref<HTMLDivElement>}
      className={cx(
        padding !== undefined && resolvePadding(padding, 'p'),
        margin !== undefined && resolvePadding(margin, 'm'),
        background && BACKGROUND_CLASSES[background],
        radius && RADIUS_CLASSES[radius],
        border === true && 'border border-border',
        (border === 'bottom' || border === 'top') && BORDER_CLASSES[border],
        POSITION_CLASSES[resolvedPosition],
        inset && INSET_CLASSES[inset],
        layer && LAYER_CLASSES[layer],
        height && HEIGHT_CLASSES[height],
        minHeight && MIN_HEIGHT_CLASSES[minHeight],
        shadow && SHADOW_CLASSES[shadow],
        placement !== undefined && PLACEMENT_CLASSES[placement],
        interactive === 'none' && 'pointer-events-none',
        className
      )}
    >
      {children}
    </Component>
  );
});
