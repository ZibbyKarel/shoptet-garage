# Design system – tokens, primitives and compounds

Tasks 6, 7, 8 and 22 from `doc/implementation-plan.md`. This document describes
all three layers of the design system:

1. **tokens** (`libs/shared/design-system/src/tokens`) – values,
2. **primitives** (`libs/shared/design-system/src/primitives`) – the smallest
   components, built exclusively from those values,
3. **compounds** (`libs/shared/design-system/src/compounds`) – compositions of
   primitives, e.g. DataTable; documented at the end of this file.

All three are directories of the single Nx project `design-system`, not
separate projects — see
`doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`.
The dependency direction `tokens → primitives → compounds` is enforced by
path-scoped `no-restricted-imports` rules in
`libs/shared/design-system/eslint.config.mjs`, which catch both the alias and a
relative escape; **compounds may import primitives, never the other way
around**.

The design system is **domain-free**: nothing in `libs/shared/design-system/**` may
know about `ParkingSpot`/`Reservation`/users – not in prop names, not in
stories. Tokens are purely presentational values; primitives are purely
presentational components.

## Source of truth

`doc/design/ds/colors_and_type.css` ("Shoptet Design System — Foundations").
Every color, `--fs-*`, `--lh-*`, `--tracking-*`, `--space-*`, `--radius-*`,
`--shadow-*`, `--dur-*`, `--ease-*`, and `--container*` in the TS source is a
**1:1** copy of this file – no rounding, renaming, or "improving" the values.
The triple `#fcaf00`/`#00e25a`/`#3b88ff` (colors of cars on occupied spots) is
from `plan.md` / `doc/design/README.md` – it's a separate group of tokens and
is **not** part of the general palette (see below).

Three token groups are **derived, not copied**, from `colors_and_type.css`, and
their file headers say so: `BREAKPOINTS` in `layout.ts`
(`doc/decision/0011-breakpoints-are-derived.md`), `CONTROLS` in
`controls.ts` – control heights and switch geometry, read from the exported
design (`doc/decision/0011-derived-control-tokens-and-rounding.md`) – and
`OVERLAYS` in `overlays.ts`: the layering scale, the scrim, and the dimensions
of dialogs, menus, the tooltip and the toast
(`doc/decision/0052-overlay-tokens-and-one-layering-scale.md`). `overlays.ts`
additionally records, for **every** entry, whether it comes from the design or
was invented – neither the tooltip nor the toast appears in the design at all.

## How the tokens are put together

```
libs/shared/design-system/
  src/
    tokens/
      lib/
      colors.ts          – brand, neutrals, semantic surface/fg/line/status
      car-palette.ts      – CAR_COLOR_PALETTE (car color only, a separate namespace)
      typography.ts        – font families, @font-face metadata, type scale, lh, tracking
      spacing.ts            – --space-*
      radius.ts              – --radius-*
      controls.ts             – --control-h-*, --switch-* (DERIVED, see 0011)
      shadows.ts               – --shadow-*
      motion.ts                 – --ease-*, --dur-*
      layout.ts                  – --container*, BREAKPOINTS (derived, see 0011)
      overlays.ts                 – --z-*, --scrim, --modal-w-*, ... (DERIVED, see 0052)
      tokens.ts                   – DESIGN_TOKENS = everything above, combined
      generate-css.ts               – generateTokensCss(tokens) -> CSS text (a pure function)
      generate-css.spec.ts           – test that the committed tokens.css == generateTokensCss(...)
    index.ts                          – public API (@garage/design-system/tokens)
  scripts/
    build-tokens-css.ts                 – writes generateTokensCss(...) into assets/tokens.css
  assets/
    tokens.css                            – GENERATED (see below), committed
    theme.css                              – HAND-WRITTEN Tailwind v4 bridge
    fonts/*.otf                             – Neue Haas Grotesk Display Pro (8 weights)
```

**The single source of truth in code is TS** (`DESIGN_TOKENS` in `tokens.ts`).
Everything else (`tokens.css`, the mapping in `theme.css`) is derived from it.

## Why `tokens.css` is generated and committed

See `doc/decision/0010-generated-tokens-css-is-committed.md`. In short: it's
committed so the app works right after `npm ci` with no extra build step, and
it's excluded from Prettier because it faithfully copies the style of the
source `colors_and_type.css` (uppercase hex, no spaces in `rgba()`), which
Prettier would otherwise rewrite.

### Aliases are preserved

`colors_and_type.css` defines part of the tokens not as a value, but as a
reference (`--bg: var(--neutral-0)`, `--fg: var(--text)`,
`--success: var(--brand-green)`, `--radius-pill: var(--radius-cta)`,
`--brand-blue-100: var(--brand-light)`). The generator does **not** flatten
this chain into a literal – it writes it out as `var(...)`, because this is
exactly how future theming works (redirect the target and every consumer
moves with it).

The TS objects, however, hold already-resolved values (`SURFACE_COLORS.bg` is
the string `#FFFFFF`, not a reference), so the data and the emitted alias
could drift apart. This is guarded by the `alias()` function in
`generate-css.ts`: at generation time it compares the token's value against
the target's value and, on a mismatch, **throws** instead of writing
`--bg: var(--neutral-0)` for a token that no longer holds white.

The **drift test** (`generate-css.spec.ts`) guards against the TS source and
the committed file drifting apart: it reads `assets/tokens.css` from disk and
compares it with `toBe()` against what `generateTokensCss(DESIGN_TOKENS)`
would generate right now. Change a token in TS without running
`nx run design-system:generate-css`, and the test fails in CI.

## How to add a new token

1. Add the value to the relevant `src/lib/*.ts` file (or create a new one for
   a new category) and wire it into `DESIGN_TOKENS` in `tokens.ts`.
2. Add the corresponding line to `generateTokensCss` in `generate-css.ts` (the
   same `--custom-property` name it should have in `colors_and_type.css` /
   the design).
3. Run `npx nx run design-system:generate-css` and commit the changed
   `assets/tokens.css`.
4. If the token makes sense as a Tailwind utility (color, spacing, radius,
   shadow, font, tracking/leading, ease/duration), add a mapping line to
   `assets/theme.css` (`@theme inline { --tailwind-namespace-*: var(--your-token); }`).
   The namespace follows Tailwind's documentation (`--color-*`, `--spacing-*`,
   `--radius-*`, `--shadow-*`, `--font-*`, `--text-*`, `--leading-*`,
   `--tracking-*`, `--ease-*`, `--duration-*`, `--breakpoint-*`).
5. `npm run test` (runs the drift test) + `npm run lint` + `npm run typecheck`.

Never write a value by hand in two places (TS **and** CSS) – one must always
be derived from the other (the generator), or you get exactly the drift the
test exists to catch.

## Wiring into Tailwind v4

`assets/theme.css` is the entry CSS file for consumers. The first consumer is
the primitives' Storybook, which imports it via a **relative path** –
`@import '../../tokens/assets/theme.css'` in `.storybook/preview.css`. Reason:
`@garage/design-system/tokens` is only a TS `tsconfig` path alias for
module resolution in JS/TS; neither CSS `@import` nor bundlers understand it
automatically. How `theme.css` reaches `apps/garage/web`'s output CSS (a relative
path vs. an `exports` mapping in the lib's `package.json`) is decided by
whichever task first styles the web app:

```css
@import 'tailwindcss';
@import './tokens.css';

@theme {
  /* breakpoints – literal values, Tailwind needs them for @media */
  --breakpoint-sm: 640px;
  /* ... */
}

@theme inline {
  /* every line is a var() reference to a custom property from tokens.css,
     never a duplicated literal value */
  --color-brand-blue: var(--brand-blue);
  /* ... */
}
```

- `@import "tailwindcss"` + `@theme inline` is the current (Tailwind v4)
  CSS-first syntax – no `tailwind.config.js` (verified via Context7/official
  docs, not from memory, per global constraint 10).
- `@theme inline` maps custom properties from `tokens.css` onto Tailwind theme
  variables (`--color-*`, `--text-*`, `--spacing-*`, ...), so Tailwind
  generates utilities (`bg-brand-blue`, `text-fg-2`, `rounded-md`,
  `shadow-lg`, `duration-base`, ...) with the same value the CSS variable
  has. `inline` is required because `--theme-*` variables otherwise cannot
  reference other custom properties defined outside a `@theme` block
  (without `inline`, Tailwind would freeze the value at parse time, not
  runtime).
- `--breakpoint-*` sits in the (non-`inline`) `@theme` block, because
  Tailwind needs breakpoints as literal values to generate `@media` –
  `var()` can't be substituted into a media query.
- `--container` / `--container-wide` (content max-width, not container
  queries) **are not** mapped into Tailwind's `--container-*` namespace –
  that's reserved for `@container` query breakpoints, a different concept.
  Use them directly as a CSS variable, e.g. `max-w-[var(--container)]`.
- `tailwindcss` and `@tailwindcss/vite` are already in the repo (added by
  Task 7 for Storybook). The PostCSS/Next.js pipeline in `apps/garage/web` is still
  outside the scope of this document – it belongs to the task that touches
  `apps/garage/web`.

## The occupied-spot car color – why it lives elsewhere

`CAR_COLOR_PALETTE` (`car-palette.ts`) and `--palette-car-1/2/3` in
`tokens.css` / `--color-car-1/2/3` in `theme.css` are **deliberately**
separated from the general palette (`COLORS`). The design
(`doc/design/README.md`) defines them only for the color of a car on an
occupied parking spot – no other UI component (button, badge, status) should
use them. The tokens carry only the raw data (three colors); the
deterministic choice of "which user gets which color" is domain logic (it
needs the concept of a "user"), so it doesn't live in the design system.

## Fonts and licensing

The 8 weights of Neue Haas Grotesk Display Pro (`.otf`) are copied into
`assets/fonts/` and used in the generated `@font-face` blocks. **The
production-deployment license is not verified** (see `doc/design/README.md`
and `doc/decision/0012-otf-fonts-committed-without-verified-license.md`) –
which is why `FONT_FAMILIES.sans` always has a working fallback (`Neue Haas Grotesk` → `Helvetica Neue` → `Inter` → `Arial`
→ `system-ui` → `sans-serif`), so the app still looks reasonable even if the
`.otf` files had to be dropped from a production build.

---

# Primitives (`libs/shared/design-system/src/primitives`)

The entry point `@garage/design-system/primitives`, in the `design-system`
project (tags `type:ui`, `scope:web`). **Fourteen components** in two batches – nine
form controls (Task 7) and five overlay/navigation ones (Task 8) – each with a
**story alongside the component** and a Jest + Testing Library test (187 tests
across 17 suites).

```
libs/shared/design-system/
  .storybook/           – one Storybook for all layers (see below)
  src/
    primitives/
      lib/
      cx.ts               – a class-name joiner (no clsx, three lines)
      control-size.ts     – the shared sm|md|lg|xl scale + FOCUS_RING, INSET_FOCUS_RING, PRESS_FEEDBACK
      field.tsx           – useFieldIds() + <Field> (label / hint / error around an element)
      dismissable-layer.tsx – the page-wide layer tree + the single Escape listener (see 0056)
      use-focus-trap.ts   – focus trap + focus restoration (Modal only; see 0053)
      button.tsx    badge.tsx    avatar.tsx
      input.tsx     select.tsx   checkbox.tsx   radio.tsx
      switch.tsx    stepper.tsx
      modal.tsx     dropdown.tsx tabs.tsx       tooltip.tsx    toast.tsx
      box.tsx       card.tsx     container.tsx  divider.tsx    grid.tsx
      spacer.tsx    stack.tsx
      text.tsx      visually-hidden.tsx          list.tsx       chip.tsx
      icon-circle.tsx                            toggle-tile.tsx
      link.tsx      callout.tsx  spinner.tsx
      *.stories.tsx        – a story for every component
      *.spec.tsx            – a test for every component
    index.ts                 – the public API
```

The last three rows above (`text.tsx` through `spinner.tsx`) and `list.tsx`
were added, and `Badge`/`Box`/`Stack`/`Card`/`Input`/`Select` extended, while
removing every Tailwind class-name string from `apps/garage/web/src` –
`doc/decision/0311-the-application-layer-carries-no-tailwind.md`. The
"Fourteen components" count and the two-batch (Task 7 / Task 8) history above
predate that work and predate the layout primitives (`Box`, `Stack`, `Card`,
`Container`, `Divider`, `Grid`, `Spacer`) as well; neither count has been kept
current since.

## Rules that apply across every primitive

- **No hand-written value.** Colors, spacing, radii, and font sizes come from
  tokens via Tailwind utilities (`bg-brand-blue`, `px-4`, `rounded-cta`,
  `text-sm`); control heights via `h-[var(--control-h-lg)]`. Rounding
  dimensions from the design is covered in
  `doc/decision/0011-derived-control-tokens-and-rounding.md`.
- **Native elements.** Input/Select/Checkbox/Radio are real `<input>` /
  `<select>` elements, only restyled. Keyboard behavior comes from the
  platform, not our code
  (`doc/decision/0012-focus-ring-and-native-elements-in-primitives.md`).
- **A uniform focus ring** (`FOCUS_RING`) on every focusable element – 2px
  `--brand-blue` via `:focus-visible`. The design doesn't specify one, see
  `doc/decision/0012-focus-ring-and-native-elements-in-primitives.md`.
- **A state's look is swapped in, not layered on.** Two utilities that
  set the same property (`bg-bg` and `bg-bg-muted`, `text-fg` and
  `text-fg-3`) have the same specificity – whichever Tailwind emits later in
  the stylesheet wins, not whichever comes later in `className`. Adding
  disabled colors *on top of* the enabled ones therefore works by luck for
  any given pair, or silently doesn't. Enabled-state colors therefore belong
  in the enabled branch of a ternary, so an element never carries both halves
  of a pair at once. The same applies to `checked:` – that variant overrides
  both plain utilities, so a disabled, checked Checkbox has to recolor its
  `checked:` fill too, or it lights up brand blue. And it is not only about
  `disabled`: **variants** have the same problem – an active vs. an inactive
  tab, an open vs. a closed trigger.
  jsdom applies no stylesheet at all, so no render test catches this – the
  invariant is guarded by `disabled-styling.spec.tsx`. That spec doesn't check
  a list of known-bad pairs but the rule itself: **no element may carry two
  unconditional color utilities that set the same property**
  (`bg-*` / `text-*` / `border-*`). Classification goes by the *token name*,
  not by the prefix, so that `text-sm` (a font size) or `border-2` (a width)
  don't fall into a color group.
- **The error state is a message.** The `error` prop doesn't exist as a
  boolean: the error text *is* the state. It sets `aria-invalid`, the red
  border, and `role="alert"` together, so they can't drift apart. When an
  element is `disabled` at the same time, **the disabled state wins**: a field
  the user cannot edit shouldn't also be shouting at them through a red
  border.
- **UI copy in Czech** (e.g. the Stepper's default button labels),
  **identifiers and comments in English.**

## Inventory and API

Shared types: `ControlSize = 'sm' | 'md' | 'lg' | 'xl'` (36/40/48/56 px). Form
elements additionally accept `label`, `hint`, `error` (the `FieldOwnProps`
type).

### `Button`

| prop | type | default | description |
| --- | --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'outline' \| 'danger' \| 'ghost'` | `'primary'` | visual weight |
| `size` | `ControlSize` | `'md'` | height |
| `loading` | `boolean` | `false` | spinner + `aria-busy` + `disabled` |
| `fullWidth` | `boolean` | `false` | stretches to the parent's width |
| `startAdornment` / `endAdornment` | `ReactNode` | – | content before/after the label |
| `type` | `'button' \| 'submit' \| 'reset'` | `'button'` | defaults to `button`, so it never accidentally submits a form |

Plus every native `<button>` attribute. `ref` points at the `<button>`.

The variants are derived from the design: `primary` is the blue pill CTA
(hover `--brand-blue-700` + `--shadow-blue`), `secondary` is white with a
border, `outline` is transparent with a dark border (hover inverts to solid
dark), `danger` is the "Delete" style – light red, solid red on hover.

### `Input`

`size`, `fullWidth` (default `true`), `label`, `hint`, `error`,
`wrapperClassName`, plus every native `<input>` attribute except `size`
(overridden by the scale – a character-count `size` has no place in the
design system). `ref` points at the `<input>`.

### `Select`

Same props as `Input` (`size` overridden again), `children` are `<option>`
elements. The arrow is an `aria-hidden` SVG; the element stays a native
`<select>`.

### `Checkbox`

`label`, `hint`, `error`, `indeterminate`, `wrapperClassName`, plus every
native `<input>` attribute except `type` and `size`. `indeterminate` is set
via a ref, since it exists only on the DOM node, not as an HTML attribute.

### `Radio` and `RadioGroup`

`Radio` has the same props as `Checkbox` (minus `indeterminate`).
**It deliberately has no `aria-invalid`** – `role="radio"` doesn't support it;
the group carries validity instead.

`RadioGroup` is a `<fieldset role="radiogroup">`: `legend` (required, the
group's accessible name), `hint`, `error`, `horizontal`. The explicit
`role="radiogroup"` is both a more precise mapping than the default `group` and
the only one of the two that supports `aria-invalid` on the group at all.

### `Badge`

`tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'` (default
`neutral`) plus `<span>` attributes. No role – it's a label, not a control.
When a badge carries information not present in the surrounding text, the
caller must expose it itself.

### `Avatar`

| prop | type | default |
| --- | --- | --- |
| `initials` | `string` | – (required) |
| `label` | `string` | – |
| `tone` | `'dark' \| 'info' \| 'neutral' \| 'warning'` | `'neutral'` |
| `size` | `'sm' \| 'md' \| 'lg'` (24/32/40 px) | `'md'` |

With `label` it's `role="img"` with an accessible name; without it,
`aria-hidden` – the assumption is that a name is written next to it.
**The application computes the initials**, not the design system: that
requires knowing what the name is, which is domain logic.

### `Switch`

`checked` / `defaultChecked` / `onCheckedChange`, `label`, `aria-label`,
`tone: 'info' | 'success'`, `disabled`, `id`, `name`. Both controlled and
uncontrolled modes. It's a `<button type="button" role="switch">`, so Enter
and Space work by virtue of the element itself, and it never submits a form.

### `Stepper`

| prop | type | default |
| --- | --- | --- |
| `value` / `defaultValue` / `onValueChange` | `number` / `(v: number) => void` | uncontrolled, starting at `min` |
| `min` / `max` / `step` | `number` | `0` / `MAX_SAFE_INTEGER` / `1` |
| `label` | `string` | – (required) |
| `formatValue` | `(v: number) => string` | – |
| `decrementLabel` / `incrementLabel` | `string` | `'Snížit'` ("Decrease") / `'Zvýšit'` ("Increase") |
| `size` | `ControlSize` | `'lg'` (the only size the design draws) |

The value has `role="spinbutton"`, so it's reachable via Tab and operable
with the arrow keys, Home, and End – the buttons are a mouse convenience, not
the only way in. `formatValue` also becomes `aria-valuetext`, so the unit
gets read out too.

### `Badge`, `Box`, `Stack`, `Card`, `Input`, `Select` – what grew

Added by `doc/decision/0311-*`, alongside the app-layer Tailwind ban:

- `Badge` – `size?: 'sm' | 'md'` (default `'md'`), `tone` gained `'tag'`,
  `transform?: 'none' | 'uppercase'` (forces uppercase + caps tracking).
- `Box` – `as` (one of the tags `StackAs` below lists), `position?: 'static' |
  'relative' | 'absolute' | 'sticky'`, `placement?:` one of six
  corner/edge-centre positions (implies `position="absolute"`),
  `interactive?: 'none'` (`pointer-events-none`), `radius` gained `'cta'`
  (the fully-rounded pill step), `inset?: 'top'`, `layer?: 'sticky' |
  'dropdown' | 'overlay'`, `height?: 'bar'`, `minHeight?: 'viewport'`,
  `shadow?: 'sm' | 'md' | 'lg'`, and `border` widened from `boolean` to
  `boolean | 'bottom' | 'top'`.
- `Stack` – `as?: 'div' | 'section' | 'header' | 'footer' | 'main' | 'nav' |
  'aside' | 'article' | 'span'`, `spacingX`/`spacingY` (override `spacing`
  per axis), `minHeight?: 'viewport'`, `height?: 'full'`.
- `Card` – `fillHeight?: boolean` (`h-full`, for cards stretched to a `Grid`
  row's tallest sibling).
- `Input`/`Select` – `width?: ControlWrapperWidth`, spent on the outer
  wrapper alongside `wrapperClassName`.

### `Text`

The one primitive most of the app-layer Tailwind ban moved onto. `as` (a
heading level, `p`, `span`, …), `size` (`xs` through `3xl`), `weight`
(`normal | medium | bold`), `tone` (including `faint`, pinned below AA on
purpose – see `doc/decision/0311-*`), `tracking`, `leading` (`tight | snug |
normal | loose` – no `relaxed` step; `loose` is `1.6` in this workspace's
token, not stock Tailwind's `2`), `transform` (`none | uppercase`), `align`,
`display`.

### `VisuallyHidden`

`as?: 'span' | 'div' | 'caption' | 'h1' | 'h2' | 'legend'`. Screen-reader-only
content with no visual footprint – an accessible name for a control the
design draws with no visible label.

### `List` and `ListItem`

`List`: `as?: 'ul' | 'ol'`, `marker?: 'none' | 'disc'`, `divider?: 'none' |
'line'` (a context-driven `border-b border-divider last:border-b-0` on every
`ListItem`, replacing what call sites used to put on the `<li>` itself).
Needs `"use client"` – it uses React context for the divider mechanism, and
its absence fails `web:build`, not a test or `typecheck`. `ListItem` takes
ordinary `<li>` attributes plus the padding/flex props most primitives here
share.

### `Chip`

A small pill of text – `size` (`sm | md | lg`), `tone` (`outline | muted`),
`weight`, `dot?: 'none' | 'green' | 'blue'` (a small status dot before the
label), `as?: 'span' | 'div' | 'p'`.

### `IconCircle`

A round-or-square badge holding one glyph or character. `size` (`xs` through
`lg`), `shape` (`square | circle`), `tone` (`yellow | green | blue |
translucent | translucent-light`), `fontSize`, `weight`, `leading?: 'none'`.
`tone="green"` deliberately pairs `--brand-dark` rather than
`--fg-on-green` – the latter measured 1.88:1 on `--brand-green` (see
`doc/decision/0311-*`). Decorative by default (`aria-hidden`).

### `BoltIcon`

A lightning bolt, drawn as an SVG. `size` is `sm` (16px, the default) or `md`
(20px). `label` makes it an image with that accessible name; without a label
it is decorative (`aria-hidden`). It has a green fill (`--brand-green`) and a
dark outline (`--brand-dark`): the fill is what clears 3:1 on the lot asphalt,
and the outline is what clears it on white. `contrast.spec.tsx` pins both.
The web app uses it for the EV-charger mark
(`doc/decision/0317-the-ev-charger-flag-is-informational-and-shown-to-everyone`).

### `ToggleTile`

One option of a selected/selectable-unselected/not-interactive button group –
a day cell in a calendar grid, or a pill in a segmented control. `shape`
(`cell | pill`), `selected`, `selectable` (the calendar's "blocked day"
state, distinct from merely unselected), `transition` (`none | base | fast`).
Always a real `<button>`. Replaces three previously hand-rolled call sites
(two day-pickers, one segmented control) with one primitive.

### `Link`

`size` (`sm | base`), `weight`, `tone` (`link | plain`). A styled `<a>`, no
routing behaviour of its own.

### `Callout`

A bordered notice band. `tone` (`warning | success`), `align` (`start |
center`).

### `Spinner`

`size` (`sm | md`), `tone` (`brand`). Presentational only – no timer, no
imperative API; see `Button`'s own `loading` prop for the control that uses
it.

## Overlay and navigation primitives

The five components of the second batch. They are the riskiest pieces from an
accessibility standpoint, so two further rules apply to them:

- **The keyboard is first class.** The focus trap, Escape, the arrow keys and
  Home/End are not "nice to have" – they are the only ways anyone without a
  mouse operates these components. They are therefore tested as **behavior**
  (`user-event`, a real Tab and real focus), not as the presence of an
  attribute.
- **Layering comes from one scale**, `--z-*`
  (`doc/decision/0052-overlay-tokens-and-one-layering-scale.md`). No component
  invents a `z-index` of its own.

These components also have more conditional states than the form controls (an
active vs. an inactive tab, an open vs. a closed trigger, five toast tones), so
the swap-don't-layer rule above bites here hardest: every state supplies the
**whole** set of colors for every property it sets.

### Escape and the layer tree

Every overlay here that Escape can dismiss – `Modal` (through `useFocusTrap`),
`Dropdown` and `Tooltip` – registers with **one page-wide layer tree**
(`dismissable-layer.tsx`) while it is open. That tree owns the single `keydown`
listener on `document`; no overlay binds an Escape listener of its own. `Tabs`
and `Toast` are not Escape-dismissable and are not in it.

Nesting is established at registration time from React context, **not** from
DOM containment: `Modal` portals to `document.body`, so two modals nested in
JSX are DOM siblings and `element.contains()` cannot see the nesting at all.

One press dismisses **exactly one** layer: the deepest one on the path the user
is in; among unrelated sibling leaves, whichever holds `document.activeElement`;
and failing both, the last registered. The layer beneath is reached by pressing
Escape again. The focus trap is layer-aware for the same reason – an outer trap
pauses while another trapping layer is registered above it. The full reasoning,
including the three earlier attempts this replaced, is in
`doc/decision/0056-escape-goes-to-the-innermost-open-layer.md`.

### `Modal`

| prop | type | default |
| --- | --- | --- |
| `open` | `boolean` | – (required) |
| `onClose` | `() => void` | – (required) |
| `title` | `ReactNode` | – (required; it is also the accessible name) |
| `description` | `ReactNode` | – (wired to `aria-describedby`) |
| `eyebrow` | `ReactNode` | – (a pill above the title) |
| `footer` | `ReactNode` | – (right-aligned) |
| `size` | `'sm' \| 'md'` | `'sm'` (460 / 620 px) |
| `closeOnScrimClick` | `boolean` | `true` |
| `closeLabel` | `string` | `'Zavřít'` ("Close") |
| `hideCloseButton` | `boolean` | `false` |

A `<div role="dialog" aria-modal="true">` in a portal on `document.body`.
**It never closes itself** – the caller owns `open`, and `onClose` is called for
all three ways out (Escape, the scrim, the ×).

What it does for accessibility:

- **A real focus trap.** Tab and Shift+Tab cycle inside; if focus ends up
  outside, the next Tab pulls it back. A dialog with no controls at all focuses
  itself (`tabIndex={-1}`), so a screen reader isn't left on the page behind it.
- **Focus restoration** to the element that opened the dialog.
- **Escape closes it** – as the layer tree's chosen target, so a dropdown or
  tooltip open inside the dialog takes the press first.
- **It locks the page's scroll** underneath – scrolling is the one way a pointer
  can still reach content the scrim is covering.
- "Content behind is inert" is handled by the trio of `aria-modal` + trap +
  covering scrim, not by mutating sibling nodes; **why**, along with why this is
  not a native `<dialog>`, is in
  `doc/decision/0053-modal-focus-trap-is-manual-not-native-dialog.md`.

### `Dropdown`

| prop | type | default |
| --- | --- | --- |
| `trigger` | `ReactNode` | – (content of the button the component owns) |
| `triggerLabel` | `string` | – (the trigger's name, when it isn't self-describing) |
| `items` | `DropdownItem[]` | – (required) |
| `onSelect` | `(id: string) => void` | – |
| `header` | `ReactNode` | – (a non-focusable block above the items) |
| `label` | `string` | the trigger's name |
| `align` | `'start' \| 'end'` | `'end'` |

`DropdownItem`: `id`, `separator?`, `label`, `trailing?`, `danger?`,
`disabled?`. With `separator: true` the other fields are ignored and the item
renders as a `DropdownSeparator` (a thin rule, `role="separator"`) instead of a
`menuitem` — the arrow keys skip it just as they skip disabled items.

The trigger carries `aria-haspopup="menu"` + `aria-expanded` +
`aria-controls`, the panel is `role="menu"`, the items `role="menuitem"`.
Keyboard: `ArrowDown` opens on the first item, `ArrowUp` on the last; inside,
the arrows wrap, `Home`/`End` jump to the ends, `Enter`/Space selects, `Escape`
closes and returns focus to the trigger, `Tab` closes and moves past the
trigger. Disabled items are skipped. A click outside closes.

**Roving tabindex** – only ever one item is in the tab order, so the menu is one
stop rather than N. **Type-ahead is deliberately absent**
(`doc/decision/0054-keyboard-navigation-for-dropdown-and-tabs.md`).

It is not a portal (unlike `Modal`), so `z-[var(--z-dropdown)]` applies locally,
within the trigger's stacking context.

### `Tabs`

| prop | type | default |
| --- | --- | --- |
| `items` | `TabItem[]` | – (required) |
| `value` / `defaultValue` / `onValueChange` | `string` / `(id: string) => void` | uncontrolled, from the first enabled tab |
| `label` | `string` | – (the strip's name) |

`TabItem`: `id`, `label`, `content?`, `disabled?`.

`role="tablist"` / `tab` / `tabpanel`, with `aria-selected` on **every** tab
(including `false`), and `aria-controls` and `aria-labelledby` binding tab to
panel in both directions. Keyboard: `←`/`→` move focus **and the selection**
(automatic activation), `Home`/`End` jump to the ends, `↑`/`↓` are left to the
page. Roving tabindex, so `Tab` out of the strip goes straight into the panel;
the panel has `tabIndex={0}` so it is reachable even when it contains nothing
focusable. The decisions are in
`doc/decision/0054-keyboard-navigation-for-dropdown-and-tabs.md`.

The selected tab's underline is a `border-bottom` of `--tab-indicator-h` (3px)
on **every** tab – the unselected ones use `border-transparent` – so nothing
shifts when the selection changes.

### `Tooltip`

| prop | type | default |
| --- | --- | --- |
| `content` | `ReactNode` | – (required) |
| `children` | `ReactElement` | – (exactly one focusable element) |
| `placement` | `'top' \| 'bottom'` | `'top'` |

It opens on **focus as well as hover**, and closes on blur, pointer leave and
`Escape` (without moving focus). Because Escape goes through the layer tree, a
bubble merely hovered while the keyboard is in an unrelated menu does not take
the press away from that menu – it closes on the press after.
`aria-describedby` is written **onto the child itself** via `cloneElement`,
merged with whatever the caller already set – on a wrapper it would describe
nothing, because a screen reader reads the description off the focused element.

It is a **description, not a name**: an element whose only name would come from
its tooltip needs an `aria-label`. The bubble is mounted on demand, so while
hidden it is not in the accessibility tree either, and it adds no stop of its
own to the tab order.

### `Toast` and `ToastRegion`

| prop (`Toast`) | type | default |
| --- | --- | --- |
| `children` | `ReactNode` | – (required; the message itself) |
| `title` | `ReactNode` | – (a bold first line) |
| `tone` | `'neutral' \| 'info' \| 'success' \| 'warning' \| 'danger'` | `'info'` |
| `icon` | `ReactNode` | – (decorative, `aria-hidden`) |
| `onDismiss` | `() => void` | – (only this makes the × button appear) |
| `dismissLabel` | `string` | `'Zavřít'` ("Close") |

| prop (`ToastRegion`) | type | default |
| --- | --- | --- |
| `children` | `ReactNode` | – (`Toast` elements; none is fine) |
| `placement` | `'top-right' \| 'bottom-right' \| 'bottom-center'` | `'top-right'` |
| `label` | `string` | – (the region's name) |

**It announces without stealing focus** – that is the whole point of a toast.
The live region is the **`Toast` itself**: `role="status"` (polite) for every
tone but `danger`, which gets `role="alert"` (assertive) – the same shape common
toast libraries use. Render `ToastRegion` **unconditionally, empty if need
be** – not for the sake of the live region (`role="region"` is deliberately not
live itself, so a message isn't read twice), but so the application has a stable
node to insert toasts into. Whether a real screen reader actually reads it is
something this test suite cannot verify – jsdom has no accessibility tree to
consume it.

A queue, a timer and an imperative `toast.success(...)` are **not** here and
will not be: that is application state, not design-system state
(`doc/decision/0055-toast-and-tooltip-are-presentational.md`).

## Storybook

```bash
npx nx run design-system:storybook         # dev server, port 4400
npx nx run design-system:build-storybook   # static build into dist/
```

The configuration is written by hand, without `@nx/storybook` and without
addons – why, is covered in
`doc/decision/0013-storybook-10-without-nx-storybook-and-without-addons.md`.
`build-storybook` **is** part of `npm run build`
(`nx run-many -t build,build-storybook`) and of `npm run affected`, so a broken
story fails in CI rather than only on a manual run.

One Storybook serves all three layers, on port 4400. `.storybook/preview.css`
imports `assets/theme.css` (not `tokens.css` – that alone gives variables but no
Tailwind utilities) and adds `@source '../src'` so Tailwind scans the
components; it looks starting from the directory of the CSS file that contains
`@import "tailwindcss"`, which is `assets/theme.css`. One `@source` line now
covers both component layers, because they share a `src/`.

## How to add a primitive

1. `src/lib/<name>.tsx` – the component. Dimensions from the scale in
   `control-size.ts`, colors from Tailwind utilities wired to tokens. A
   native element, whenever one exists.
2. `src/lib/<name>.stories.tsx` – **at the same time**, not afterward. States
   that make sense: default, variants, sizes, disabled, error, loading.
3. `src/lib/<name>.spec.tsx` – **at the same time**. Tests `role`, accessible
   name, Tab reachability, keyboard, and interaction; not appearance.
4. Export it from `src/index.ts`.
5. `npm run lint && npm run typecheck && npm run test` and
   `npx nx run design-system:build-storybook`.

An overlay that has to be dismissable by Escape has one extra step: register it
with the layer tree (`useDismissableLayer`, passing `active` and its outermost
node) and render a `DismissableLayerProvider` with the returned node around its
own content. Binding an Escape listener of its own instead is the defect
`doc/decision/0056-escape-goes-to-the-innermost-open-layer.md` exists to
prevent.

---

# Compounds (`libs/shared/design-system/src/compounds`)

The entry point `@garage/design-system/compounds`, in the `design-system`
project (tags `type:ui`, `scope:web`). **Three components** (Task 22), each with a story and a Jest +
Testing Library spec alongside it (47 tests across 3 suites).

This is the third layer: it composes primitives into larger, still
**domain-free** pieces. Compounds may import primitives; primitives must never
import compounds. The path-scoped `no-restricted-imports` blocks in
`libs/shared/design-system/eslint.config.mjs` enforce the direction.

```
libs/shared/design-system/
  src/
    compounds/
      lib/
      data-table.tsx      – the admin table; the workspace's only @tanstack/react-table importer
      empty-state.tsx     – "there is nothing here"
      confirm-dialog.tsx  – Modal narrowed to one question and two answers
      *.stories.tsx        – a story for every compound
      *.spec.tsx            – a spec for every compound
    index.ts                 – the public API
```

## Rules that apply across every compound

- **Everything a primitive already decided stays decided.** A compound picks
  primitives and arranges them; it does not restyle them. `ConfirmDialog` sets
  no colors at all — it chooses a `Button` variant.
- **Domain-free, in stories and specs too.** No parking spot, reservation or
  user appears in this lib, including in fixtures. The sample rows are generic
  items, even though the screens these were drawn for are exactly those tables.
- **Czech UI copy arrives as a required prop**, never as a hardcoded literal
  and never as a default — `emptyTitle`, `confirmLabel`, `cancelLabel`. The
  primitives do not yet follow this rule: `Modal`'s `closeLabel` is still
  optional with a `'Zavřít'` default (`modal.tsx:45,78`), and is the next
  candidate. These three used to default to
  `'Žádná data'` / `'Potvrdit'` / `'Zrušit'`, which put user-visible Czech
  outside `libs/shared/i18n` at any call site that omitted them; nothing here may
  call `useTranslations`, so requiring the prop is what keeps the copy in app
  code, and the compiler asks for it.
- **The swap-don't-layer rule from the primitives still applies.** A sorted vs.
  an unsorted column header supplies its *whole* color set in one branch of the
  ternary; two unconditional `text-*` utilities would resolve by Tailwind's emit
  order, not by the order they appear in `className`.
- **The Storybook `preview.css` names two `@source` directories.** A compound
  renders primitives, so Tailwind has to scan `../../primitives/src` as well —
  otherwise every `Button` inside a `ConfirmDialog` renders unstyled.

## Inventory and API

### `DataTable<TData>`

The design's admin table (`doc/design/screens/03-admin-users.png`,
`04-admin-spots.png`): a bordered card with a title band, an optional filter
band, and a sortable list.

It is the **wrapper lib** for `@tanstack/react-table` — the single place in the
workspace allowed to import it (`WRAPPED_LIBRARIES` in `eslint.config.mjs`).
No TanStack type crosses its props.

| prop | type | default |
| --- | --- | --- |
| `columns` | `DataTableColumn<TData>[]` | – (required) |
| `data` | `TData[]` | – (required) |
| `getRowId` | `(row: TData) => string` | – (required) |
| `title` | `string` | – (required; visible card title **and** the table's accessible name) |
| `description` | `ReactNode` | – |
| `actions` | `ReactNode` | – (right of the header band: a search field, or a button) |
| `toolbar` | `ReactNode` | – (a band under the header, for filters) |
| `minWidth` | `string` | – (below it the card scrolls sideways) |
| `defaultSort` / `sort` / `onSortChange` | `DataTableSort` / `DataTableSort \| null` / `(s) => void` | uncontrolled |
| `emptyTitle` | `string` | – (required; the empty state's title, the caller's copy) |
| `emptyDescription` / `emptyAction` | `ReactNode` | – |
| `className` | `string` | – (merged onto the card's outer `<section>`) |

`DataTableColumn<TData>`: `id`, `header`, `cell: (row) => ReactNode`,
`sortValue?`, `align?: 'start' | 'end'`, `width?`.

- **`sortValue` is both the sort accessor and the sortability flag.** Omit it
  and the column cannot be sorted — its header is plain text rather than a
  button and carries no `aria-sort`. There is no second boolean that could
  disagree with it. This mirrors the design, where `Jméno`/`E-mail` are buttons
  and `Štítek`/`Kategorie`/`Stav dnes` are labels.
- **Sorting is a two-state toggle**: a new column starts ascending, a press on
  the sorted column flips it, and there is no third "unsorted" press — that is
  the design's own `sortDir` logic, and TanStack's opposite defaults
  (`enableSortingRemoval`, `sortDescFirst`) are pinned explicitly. See
  `doc/decision/0072-sorting-is-a-two-state-toggle-behind-a-wrapper-type.md`.
- **It renders a real `<table>`**, not the design's grid of `<div>`s — same
  picture, but the roles, `aria-sort` and table navigation come from the
  elements. See `doc/decision/0070-datatable-is-a-real-table-not-a-grid.md`.
- **`getRowId` is required** rather than defaulting to the array index: an index
  key re-uses the wrong DOM node the moment the table is re-sorted.
- With no rows it renders an `EmptyState` in a cell spanning every column, and
  **keeps the column headers**, so the shape of the table is still readable.

### `EmptyState`

| prop | type | default |
| --- | --- | --- |
| `title` | `ReactNode` | – (required) |
| `description` | `ReactNode` | – |
| `icon` | `ReactNode` | – (decorative, `aria-hidden`) |
| `action` | `ReactNode` | – (usually one `Button`) |
| `size` | `'sm' \| 'md'` | `'md'` (`sm` is what `DataTable` uses) |
| `headingLevel` | `2 \| 3 \| 4` | – (a `<p>` when omitted) |
| `className` | `string` | – (merged onto the root `<div>`) |

**`headingLevel` is deliberately undefaulted.** Only the page knows its own
outline, and a component that guesses a level produces the skipped-heading
defect screen-reader users navigate straight into.

### `ConfirmDialog`

| prop | type | default |
| --- | --- | --- |
| `open` | `boolean` | – (required) |
| `title` | `ReactNode` | – (required; the dialog's accessible name) |
| `description` | `ReactNode` | – (wired to `aria-describedby`) |
| `onConfirm` / `onCancel` | `() => void` | – (both required) |
| `confirmLabel` | `string` | – (required; the caller's copy) |
| `cancelLabel` | `string` | – (required; the caller's copy) |
| `tone` | `'default' \| 'danger'` | `'default'` |
| `loading` | `boolean` | `false` |

- **Every way out that is not confirmation calls `onCancel`** — the cancel
  button, Escape, the scrim and the ×, all through one guard, so there is no
  fourth code path that could forget the `loading` check.
- **`loading` blocks all four of them.** Cancelling a request that has already
  left is a promise this component cannot keep.
- **Focus never starts on the confirming button** (it lands on `Modal`'s ×), so
  a destructive dialog does not open with the destructive action under the
  user's Enter key.

`EmptyState` and `ConfirmDialog` have **no model in the design** and are derived
from its language; what was invented and what was not is recorded in
`doc/decision/0071-empty-state-and-confirm-dialog-are-invented.md`.

## Storybook

```bash
npx nx run design-system:storybook         # dev server, port 4400
npx nx run design-system:build-storybook   # static build into dist/
```

The same single Storybook the primitives use — there is one, and it is the
project's, not a layer's. It was two, on ports 4400 and 4401, while the layers
were two Nx projects with separate `lint`, `typecheck` and `build-storybook`
targets; merging the projects removed the boundary that argument rested on, and
port 4401 is free again. Hand-written configuration, without `@nx/storybook`
and without addons, for the reasons in
`doc/decision/0013-storybook-10-without-nx-storybook-and-without-addons.md`.

## How to add a compound

1. `src/lib/<name>.tsx` – composed from primitives. If it needs a value no
   primitive and no token supplies, that value is *invented*: say so in a
   decision record, the way `0071` does.
2. `src/lib/<name>.stories.tsx` and `src/lib/<name>.spec.tsx` – **at the same
   time**, not afterward. Fixtures stay domain-free.
3. Export it from `src/index.ts`.
4. `npx nx run-many -t lint,typecheck,test -p design-system` and
   `npx nx run design-system:build-storybook`.

If the compound needs a primitive that does not exist, that primitive belongs in
`libs/shared/design-system/src/primitives` — not built locally here and left. Building it
here is acceptable only as a deliberate, recorded step, with promotion flagged.
