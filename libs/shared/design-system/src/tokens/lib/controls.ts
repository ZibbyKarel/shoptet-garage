/**
 * Interactive-control geometry.
 *
 * DERIVED, not sourced from `colors_and_type.css` — that file has no notion of
 * a control height, and every other token module in this lib is a byte-faithful
 * copy of it. The values below are read off the finished visual design
 * (`doc/design/garage-design.dc.html`), which sizes its buttons, inputs and
 * selects with literal pixel heights. Keeping them here — rather than inline in
 * the primitives — is what lets `libs/shared/design-system/src/primitives` stay free of
 * hand-written pixel values.
 *
 * They are their own token group rather than aliases onto `--space-*` because
 * two of the four (36px, 56px) are not on that scale at all, and because a
 * control height is not a spacing value even where the numbers coincide —
 * 40px and 48px do land on `--space-10` and `--space-12`, and routing them
 * through the spacing namespace would also mint `w-control-lg` and
 * `p-control-lg`, which mean nothing (see the note in `assets/theme.css`).
 *
 * See `doc/decision/0011-derived-control-tokens-and-rounding.md` for why the
 * design's seven distinct heights collapse to four steps.
 */

/**
 * Shared height scale for buttons, inputs, selects and the stepper. The design
 * uses 32/36/40/44/48/52/56px; those cluster into four steps, and the four
 * chosen values are all literally present in the design.
 */
export const CONTROL_HEIGHTS = {
  /** Compact toolbar / table-row controls. */
  sm: '36px',
  /** Default. Day navigation, filter selects, month/year pickers. */
  md: '40px',
  /** Modal and settings forms. */
  lg: '48px',
  /** Hero call-to-action. */
  xl: '56px',
} as const;

/**
 * Toggle-switch geometry. A switch is not on the height scale above — the
 * design draws it as one fixed 46x26 track with a 20px knob, at every size it
 * appears in.
 */
export const SWITCH_GEOMETRY = {
  trackWidth: '46px',
  trackHeight: '26px',
  /** Inset between track edge and knob. */
  trackPadding: '3px',
  knobSize: '20px',
  /**
   * Tighter and darker than any `--shadow-*` step (those top out at 0.12
   * opacity); the knob needs to read as lifted off a saturated track.
   */
  knobShadow: '0 1px 2px rgba(35,34,31,0.24)',
} as const;

export const CONTROLS = {
  height: CONTROL_HEIGHTS,
  switch: SWITCH_GEOMETRY,
} as const;
