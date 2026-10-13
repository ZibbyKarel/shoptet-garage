# 0011 – Derived control tokens and rounding dimensions from the design

## What

A new, **deliberately separate** token module was created,
`libs/shared/design-system/tokens/src/lib/controls.ts`, with its own group of CSS
variables:

- `--control-h-sm|md|lg|xl` = `36px | 40px | 48px | 56px` – a shared height scale
  for Button, Input, Select and Stepper,
- `--switch-w|h|pad|knob|knob-shadow` – the switch's geometry (46×26, a 20px knob).

At the same time, a **rounding rule** applies: dimensions and font sizes from the
design that don't land on an existing scale are snapped to the nearest token,
never copied literally.

| in the design | in the primitive | token |
| --- | --- | --- |
| heights 32 / 44 / 52 px | 36 / 40 / 48 px | `--control-h-*` |
| `font-size` 13 / 15 / 17 px | 14 / 16 / 18 px | `--fs-sm` / `--fs-base` / `--fs-md` |
| padding 14 / 18 / 22 / 26 / 34 px | 12 / 16 / 20 / 24 / 32 px | `--space-3..8` |
| avatar 22 / 30 / 34 px | 24 / 32 / 40 px | `--space-6/8/10` |
| badge height 24 and 26 px | 24 px | `--space-6` |
| stepper button 44×48 | 48×48 | `--control-h-lg` |

## Why

Global constraint 5 forbids hand-written color and spacing values outside the
tokens layer. The design (`doc/design/garage-design.dc.html`), however, is
written with inline styles and uses **seven different button heights** and five
font sizes, most of which don't land on the `--space-*` or `--fs-*` scale at all
(36, 44, 52, 56 px; 13, 15, 17 px).

There were three options:

1. Hard-code the values into the primitives → violates constraint 5.
2. Skip them and use only what's on the scale → the primitives would visibly
   diverge from the design (missing both the 56 px hero CTA and the 36 px compact
   row).
3. Add the missing category to the tokens layer and round the rest.

Option 3 was chosen. It's also reasonable for an interactive element's height to
have **its own semantic category** – it isn't spacing or radius, it's a control
dimension, and the design system needs to share it across four components.

Rounding solves the other half of the problem: if every value from the design were
turned into a token, the result would be a seven-step scale nobody could keep
consistent. A difference of 1–4 px is visually imperceptible; a fragmented scale
is noticeable immediately.

## How

- `controls.ts`'s header **explicitly states it is DERIVED**, not a 1:1 copy of
  `colors_and_type.css` – the same way `BREAKPOINTS` in `layout.ts` is marked (see
  `doc/decision/0011-breakpoints-are-derived.md`). The other token modules
  (`colors.ts`, `shadows.ts`, `spacing.ts`) remain byte-for-byte faithful to the
  source – which is why the switch knob's shadow
  (`0 1px 2px rgba(35,34,31,0.24)`, darker than any `--shadow-*`) lives in
  `controls.ts`, not `shadows.ts`.
- `generateTokensCss` gained a `/* --- Controls --- */` section;
  `assets/tokens.css` was regenerated, and the drift test passed.
- `--control-*` is **not** mapped into `assets/theme.css`. Tailwind v4 has no
  namespace for height (it draws heights from `--spacing-*`), and forcing them
  through `--spacing-*` would produce nonsensical utilities like `w-control-lg` /
  `p-control-lg`. The primitives consume them as an arbitrary value:
  `h-[var(--control-h-lg)]`.
- The step → padding → font-size mapping lives in a single place
  (`libs/shared/design-system/primitives/src/lib/control-size.ts`), so the four
  components can't drift apart.

## Risk

- **Deviation from the design.** Buttons in modals are 48 px, matching the
  design's 48 px, but e.g. "Přidat místo" ("Add spot") will be 40 or 48 instead of
  44. The difference is within 4 px. If a visual review calls for it, adding a
  fifth step is one line in `controls.ts` plus regenerating the CSS.
- **Dual nature of the tokens.** This one lib now holds two token groups with
  different sources of truth (`colors_and_type.css` vs. the exported design).
  Whoever adds the next token needs to know which group it belongs to – that's
  why `controls.ts` states it in its header, and `doc/design-system.md` covers it
  in the "How to add a new token" section.
- **Rounding is one-directional.** Once an updated design arrives, it won't be
  automatically obvious whether a 4 px difference is deliberate rounding or a new
  value. The table above is therefore part of this decision record.
