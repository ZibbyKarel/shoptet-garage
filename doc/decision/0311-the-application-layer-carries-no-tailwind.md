# 0311 – The application layer carries no Tailwind

**Date:** 2026-09-11 · **Status:** accepted · **Task:** repository owner's request ·
**Builds on:** `doc/decision/0301-the-design-system-is-one-package-and-the-layer-rule-moved-to-lint-paths.md`

## What

`apps/garage/web/eslint.config.mjs` now bans `className` — and, by the same
selector, `wrapperClassName` — anywhere under `apps/garage/web/src`:

```js
'no-restricted-syntax': [
  'error',
  {
    selector: 'JSXAttribute[name.name=/[cC]lassName$/]',
    message: '…',
  },
  ...restrictWrappedLibrariesDynamically(),
],
```

Every Tailwind utility that used to sit in app markup has moved into either a
design-system primitive/compound or, for the handful of things no primitive
can express, hand-written CSS in `global.css`. `apps/garage/web/src/app/global.css`
no longer names its own `src` as a Tailwind source at all:

```css
@source '../../../../../libs/shared/design-system/src/primitives';
@source '../../../../../libs/shared/design-system/src/compounds';
```

Only the two design-system layers are scanned. The app's own `@source '../../src'`
line — the one the design system's Storybook still carries for the same reason
(`doc/design-system.md`, "Wiring into Tailwind v4") — is gone from this file,
and `global.css`'s own comment states why: with the rule enforced, no Tailwind
utility class-name string can exist under `apps/garage/web/src` any more,
so there is nothing left for the scanner to find there. Removing the line is
the stronger of the two proofs available — a utility that crept back into app
markup would simply not be emitted, rather than passing lint and quietly
working.

## Why `react/forbid-dom-props` was rejected

It was the obvious first candidate and it does not cover this. It only sees
native DOM elements, and `className` is also a prop `Badge`, `Box`, `Input`
and every other design-system component accept and spread onward. A rule that
enforced only the DOM half of this workspace's markup would read as if it
enforced the whole ban and would not — the exact "reads as enforcement,
enforces nothing" failure `doc/decision/0301-*` already named once for this
codebase. `no-restricted-syntax`'s `JSXAttribute` selector sees every element,
design-system component included, so it was used instead — the same
mechanism the root config already uses for the wrapper-library ban
(`restrictWrappedLibrariesDynamically`).

## Why the selector matches `wrapperClassName` too

The selector is `name.name=/[cC]lassName$/`, not a literal `='className'`
match. `Input` and `Select` expose `wrapperClassName` specifically so a caller
can hand raw Tailwind through to their outer wrapper element — two real call
sites did exactly that (`admin-users-screen.tsx`, `date-picker-dialog.tsx`).
It is the same violation, a Tailwind utility string written in app code,
under a different prop name. A selector that only caught the exact spelling
`className` would have left that escape hatch standing open the day this rule
landed.

## Why the block re-spreads `restrictWrappedLibrariesDynamically()`

Flat ESLint config replaces a rule's whole option array for a later matching
block; it does not merge it. A block that added the `className` selector
without repeating the root config's wrapper-library entries would have
silently turned that enforcement off for everything under
`apps/garage/web/src` — the dynamic-`import()` half of the wrapper ban that
a static read of the file cannot see is missing.

## How it was probed, not just read

Two probes, fired and reverted:

- A `className="text-sm"` planted on a JSX element in app code: lint exits 1,
  naming the attribute via the message above.
- A planted direct `react-hook-form` import in the same file, alongside the
  probe above: still reported — proof the wrapper-ban spread did not get
  dropped by adding the new rule.

**A known limitation, left as one.** The selector is `JSXAttribute`-shaped: it
cannot see a type declaration (`className?: string` in a props interface) or
a spread forwarding one along (`{...props}`). `shell/admin/window-banner/window-banner.tsx`
declares and forwards exactly such a `className` prop, and this rule does not
and cannot flag it — noted in the ESLint config's own comment, not hidden.

## The new and extended primitives this forced

Removing `className` from app code meant every ad-hoc composition it used to
express needed a real primitive. Nine are new, each with a spec and a story
alongside it: `Text`, `VisuallyHidden`, `List`/`ListItem`, `Chip`, `IconCircle`,
`ToggleTile`, `Link`, `Callout`, `Spinner`. Six existing ones grew:

- `Badge` — `size="sm"`, `tone="tag"`, `transform` (forces uppercase + caps
  tracking).
- `Box` — `as`, `position`, `placement`, `interactive`, `radius="cta"`,
  `inset`, `layer`, `height`, `minHeight`, `shadow`, and `border` widened from
  `boolean` to `boolean | 'bottom' | 'top'`.
- `Stack` — `as`, `spacingX`/`spacingY` (per-axis gap overrides), `minHeight`,
  `height="full"`.
- `Card` — `fillHeight`.
- `Input`/`Select` — `width`, spent on the outer wrapper alongside
  `wrapperClassName`.

## Two genuine contrast bugs, found while extending the registry

Adding cases to `contrast.spec.tsx`'s hand-written pairing checks — the same
mechanism `doc/decision/0266-*` established — surfaced two pairings the review
that produced 0265/0266 had not covered, because the components did not exist
yet:

| pairing | measured | fixed to | fix |
| --- | --- | --- | --- |
| `IconCircle tone="green"`: `--fg-on-green` (white) on `--brand-green` | **1.88:1** | **8.47:1** | `text-brand-dark` instead — the exact precedent `toast.tsx`'s `success` glyph already sets (`doc/decision/0266-*`) |
| `ToggleTile shape="pill"` disabled: `--border-strong` on `--bg-muted` | **1.38:1**, below even the 3:1 floor for non-text controls | **4.40:1** | `text-fg-3` instead — `ToggleTile`'s `cell` shape's own inactive state already used `text-fg-3` and was never wrong |

Both numbers are asserted in `contrast.spec.tsx`, computed from
`COLOR_UTILITIES` off the rendered element, the same way as every other case
in that file.

## Contrast findings left alone, and why that is not an oversight

Extending the registry also re-confirmed two pairings that are the existing
design, not something this work introduced or missed:

- `Text tone="faint"` (`text-neutral-400` on `--bg`) measures **2.56:1**,
  pinned by a test named for exactly what it is:
  `it('tone=faint is BELOW AA on --bg — pinned, pre-existing, not fixed here')`.
  It predates `Text` — the class existed at real call sites before this
  primitive did — and is a decorative label, the same category of exemption
  `doc/decision/0265-*` already reasons about for the two brand pairings that
  record pins.
- On the parking map's own surface, `bg-neutral-600` composited with the
  dark overlay `lot-grid.tsx` draws over it: `inverse-60` (60% neutral-0)
  measures **3.99:1** and `inverse-50` (50%) measures **3.30:1**, both below
  AA, both pinned by the same test file rather than silently weakened.

Neither pairing was introduced by this work; both were already in the
product. The registry now states the numbers instead of leaving them
unmeasured.

## What deliberately stayed as hand-written CSS

`global.css` still carries CSS that is not a Tailwind utility, on purpose: the
parking-bay geometry custom properties (`--lot-tile-h`, `--lot-tile-min-w`,
`--lot-tile-max-w`, `--lot-line-w`, `--lot-kerb-w`), `.lot-asphalt`,
`.lot-hatch`, the `.lot-group-panel`/`.lot-group-rule`/`.lot-swatch*`/`.lot-bay*`/
`.lot-spot-menu`/`.lot-car` family, and `.calendar-grid`/`.calendar-grid th`.
Each carries its own comment explaining what no primitive or Tailwind
arbitrary-value syntax can express for it — a parking bay's painted lines and
dot-grid asphalt are the physical shape from the design
(`doc/design/garage-design.dc.html`), not a step on the spacing scale, and
`border-spacing` has no token-aware utility at all. The reasoning is the one
`global.css` already states and `doc/decision/0310-*` echoes for the same
class of question: this is domain geometry, and the design system stays
domain-free by not absorbing it.

Where a class name genuinely could not be avoided in app TSX — a Tailwind
class-name string reaching from a design-system component's own exported
constant, not one written at the call site — the line carries
`// eslint-disable-next-line no-restricted-syntax` with a stated reason.
**17** such disables exist, across **5** files: `bulk-modal.tsx`, `spot-tile.tsx`,
`lot-grid.tsx`, `car-glyph.tsx`, `date-picker-dialog.tsx`.

## What was rejected

- **A `CalendarGrid` compound and a `SegmentedControl` compound.** Two
  hand-rolled day-pickers (`BulkModal`'s multi-day grid,
  `DatePickerDialog`'s single-day grid) and one hand-rolled segmented control
  (`LockModeChoice`) shared the same selected/selectable-but-unselected/
  not-interactive state shape and slightly different class strings. Rather
  than build two compounds, they collapsed onto one primitive,
  `ToggleTile`, with a `shape` prop (`'cell'` for the two calendars, `'pill'`
  for the segmented control) — one primitive covered all three call sites.
  Deduplicating the two calendars' date arithmetic into one component is a
  separate task from removing Tailwind from the app layer and was not done
  here; `ToggleTile` only unifies their chrome.
- **A `display="flex"` prop on `Box`.** It would have needed a parallel copy
  of `Stack`'s whole flex API (`direction`, `align`, `justify`, `wrap`,
  `spacing`) grafted onto a component whose job is everything `Stack` is not
  — the wrong seam.
- **A `Grid` `align` prop.** CSS grid's default `align-items: stretch`
  already stretches direct children to the tallest row — `Card`'s new
  `fillHeight` prop is what a `Grid` cell actually needed, and an `align`
  prop would have been a no-op on the one call site that prompted it
  (`admin-window-screen.tsx`'s two side-by-side cards).
- **A responsive-width vocabulary on `Input`/`Select`.** One call site
  (`admin-users-screen.tsx`'s search field) used `sm:w-80` — full width below
  the `sm` breakpoint, capped at 320px above it. No primitive here takes a
  breakpoint-keyed width, and inventing one for a single caller was rejected;
  see "Accepted visual changes" below for what happened instead.

## Accepted visual changes

Three call sites changed, in ways worth stating rather than smoothing over:

- **The admin users search field lost its 320px cap.** `width="full"` covers
  the base `w-full` step; the `sm:w-80` cap has no equivalent, since no
  primitive here takes a breakpoint-keyed width (see "What was rejected").
  The field is now full-width at every breakpoint, not only below `sm`.
- **The month row's `mt-0.5` (2px) is approximated, not matched.** `Stack`'s
  spacing scale starts at step `1` (4px) — `admin-window-screen.tsx`'s own
  comment states this is "the nearest step, used here as an approximation,
  not an exact match."
- **`leading-relaxed` (1.625) became `leading="loose"`.** `Text`'s `leading`
  scale has no `relaxed` step. `loose` in this workspace resolves to
  `--lh-loose: 1.6` — verified in
  `libs/shared/design-system/assets/theme.css` (`--leading-loose: var(--lh-loose)`)
  and `libs/shared/design-system/src/tokens/lib/typography.ts` (`loose: '1.6'`)
  — not stock Tailwind's `2`. `admin-window-screen.tsx`'s own comment does the
  arithmetic: within 1.5% of the original, so it is used rather than left
  unset.

## `"use client"` on `List`

`List` uses React context for its `divider="line"` mechanism (the same idiom
`Divider`'s tag-switch and `Stack`'s `divider` prop already use) and needed
the `"use client"` directive as a result. Its absence did not fail a test or
`typecheck` — it failed `web:build`. Nothing else in this workspace's
verification chain (`npm run lint`, `npm run typecheck`, `npm test`) would
have caught a missing directive here; only building the app does.

## How it was verified

`npx nx format:check --all` passes. `npm run lint`, `npm run typecheck`, and
`npm test` all pass across the design-system and web projects, including the
two probes above (fired and reverted) and the extended `contrast.spec.tsx`
registry. `npx nx run web:build` succeeds; `global.css`'s two remaining
`@source` lines are what makes the design-system's Tailwind utilities reach
the app's emitted stylesheet, and the app's own `src` contributing none is
the state this record documents, not an oversight to fix later.
