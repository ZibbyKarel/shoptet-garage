# 0012 – An extra focus ring beyond the design, and native elements in the primitives

## What

Two accessibility decisions for the `libs/shared/design-system/primitives` layer:

1. **Every focusable primitive gets a uniform focus ring** –
   `outline: 2px var(--brand-blue)` with a 2px `outline-offset`, via
   `:focus-visible`. The design does not specify one.
2. **Input, Select, Checkbox and Radio are native HTML elements**, only
   restyled (`appearance-none` + tokens). None of them is a `div` with a
   `role=""`. Switch is a `<button role="switch">`; Stepper is a pair of
   `<button>` elements plus a value with `role="spinbutton"`.

## Why

**On point 1.** The design (`doc/design/garage-design.dc.html`) defines
`style-focus` **only for text fields and selects**, and only as a change of the
border color to `#008FFF`. For buttons, switches and the stepper it defines no
focus state at all – because it's written with inline styles for a static
demo, not as production CSS.

Taking that literally would mean:

- buttons with no visible focus at all (the browser would draw its default,
  which clashes with the design's pill shape and colors),
- for fields, the only focus signal would be a 1px border-color change, which is
  too low-contrast to be the sole indicator.

Keyboard accessibility is a functional requirement for this task, not cosmetics,
and an invisible focus state breaks it. The ring is therefore an **addition, not
a replacement** – fields keep the design's blue border too.

**On point 2.** A hand-rolled listbox / checkbox / radio built from `div`s would
have to reimplement type-ahead, Home/End, Alt+arrow keys, roving tabindex among
radios, the mobile picker, `:checked`, form submission, and the entire screen-
reader contract. That's exactly where accessibility bugs originate in design
systems. The native element already provides all of that, and the design itself
uses `<select>` and `<input>`, so there's no visual reason to abandon them
either.

## How

- `control-size.ts` exports `FOCUS_RING` as a single constant used by every
  primitive – it can't be forgotten in one place or defined differently
  elsewhere.
- Visual chrome is handled with `appearance-none` and an overlay: for Select the
  arrow is an `aria-hidden` SVG, for Checkbox the checkmark is an `aria-hidden`
  SVG layered over a `peer` input, for Radio it's an inner dot. **The element
  that carries the behavior is always the native one**, never its graphical
  sibling.
- The "invalid" state is carried by `aria-invalid` on whichever element supports
  it. For Radio, `role="radio"` doesn't support it, so the group carries it
  instead (`RadioGroup`, `<fieldset>`), not the individual option.
- For Switch, `disabled` is expressed with a token color (`--border`), not
  `opacity`, so the state stays described by a token.
- Tests (Jest + Testing Library) for each component verify `role`, the
  accessible name, Tab reachability and keyboard control – not appearance.

## Risk

- **Deviation from the visual brief.** The ring is a visible element that isn't
  in the design. If a designer wants it different (a different color, a
  `box-shadow` instead of `outline`), it's a change to one constant.
- **`role="spinbutton"` on the Stepper goes beyond the design**, where the value
  is just a non-editable box. It adds the value to tab order. Without it, though,
  the value could only be changed by the two buttons, and arrow keys would do
  nothing.
- **jsdom can't emulate keyboard handling for a native `<select>`.** The test
  therefore verifies that the element remains a `<select>` (i.e. that the
  platform supplies the behavior), not that an arrow key changes the selection –
  that's a claim only a browser-based e2e test (Phase 7) can verify.
