# 0071 – `EmptyState` and `ConfirmDialog` are invented, not drawn

## What

Two of the three compounds have **no model in the design**:

- **`EmptyState`** – no screen in `doc/design/garage-design.dc.html` shows a
  list with nothing in it. Every mock ships with sample rows.
- **`ConfirmDialog`** – the design draws the `Smazat` ("Delete") button that
  would open one (`doc/design/screens/04-admin-spots.png`) but never the
  confirmation step itself.

Both are therefore derived from the design's existing language rather than
copied from it, and this record says so explicitly — the same discipline
`libs/shared/design-system/tokens/src/lib/overlays.ts` applies per token
(`doc/decision/0052-overlay-tokens-and-one-layering-scale.md`).

## Why

- **The brief names all three compounds**, and the admin screens (Tasks 26–27)
  need a delete confirmation and a "no rows yet" state whether or not the mock
  drew them. Building them here keeps that composition out of feature code,
  which is where `plan.md` forbids new design-system pieces from being founded.
- **Inventing is only safe when it is recorded.** An undocumented invented value
  is indistinguishable from a value read off the design, so the next person
  cannot tell which ones are safe to change. Naming them makes them cheap to
  revisit if the design is ever extended.
- **`ConfirmDialog` invents almost nothing.** It is `Modal` + two `Button`s,
  both already fixed by the design; what is new is the composition and the two
  default labels. `EmptyState` invents more — the spacing steps and the centred
  arrangement — because it has no antecedent at all.

## How

### `EmptyState`

- Centred column, `--fg-3` for the secondary line, the card's own 24px gutter,
  and two vertical steps: `md` (64px) for a page-level empty region and `sm`
  (32px) for one inside a card that already has padding — which is what
  `DataTable` renders.
- **The title is a `<p>` unless a caller opts into a heading.** `headingLevel`
  takes 2, 3 or 4 and is deliberately undefaulted: only the page knows its own
  outline, and a component that guesses a level produces the skipped-heading
  defect screen-reader users navigate straight into. `DataTable` passes nothing,
  because a heading inside a table cell is not a section title.
- **The icon is `aria-hidden`.** The title already says what the icon says.
- `title` is **required**, so nothing generic ever ships by accident.

### `ConfirmDialog`

- `Modal` at `size="sm"` (460px), footer of `secondary` + (`primary` |
  `danger`). `danger` is the design's own `Smazat` style — `--danger-100` fill,
  solid `--danger` on hover.
- **Every way out that is not confirmation goes through one function.** The
  cancel button, Escape, the scrim and the × all call the same `handleCancel`.
  A dialog where Escape did something other than cancel is a trap, and a fourth
  code path is a fourth chance to forget the `loading` check.
- **`loading` blocks all four of them**, Escape and the scrim included:
  cancelling a request that has already left is a promise this component cannot
  keep. `closeOnScrimClick={!loading}` covers the pointer; the shared guard
  covers the rest.
- **Focus does not start on the confirming button.** `Modal`'s trap focuses the
  first tabbable element, which is its × — so a destructive dialog never opens
  with the destructive action armed under the user's Enter key. This is a
  property of `Modal`'s DOM order rather than of this component, so there is a
  test pinning it here.
- Default labels are the generic Czech verbs `Potvrdit` / `Zrušit`, both
  overridable — UI copy stays Czech
  (`doc/decision/0029-documentation-is-english-ui-copy-stays-czech.md`), and a
  compound must not hardcode copy about deleting a parking spot.

## Risk

- **The empty-state spacing is only checked at visual review**, like every other
  invented dimension in the design system.
- **If the design is later extended with a real empty state or confirmation
  step, these will need reconciling.** They are small and centrally used, so the
  cost is contained — but the design, not this file, wins that disagreement
  (`doc/decision/0004-mvp-scope-includes-design-features.md`).
- **`ConfirmDialog` has no "in flight" affordance beyond the button spinner.**
  A long-running confirm shows a busy button and nothing else.
