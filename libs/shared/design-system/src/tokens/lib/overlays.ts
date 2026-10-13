/**
 * Overlay and layering tokens.
 *
 * DERIVED, not sourced from `colors_and_type.css` — that file describes a flat
 * page and has no notion of a stacking order, a scrim or a dialog width. Like
 * `controls.ts`, the values below are read off the finished visual design
 * (`doc/design/garage-design.dc.html`) wherever the design draws the thing
 * at all, and invented where it does not. Which is which is marked per entry.
 *
 * Keeping them here — rather than inline in the primitives — is what lets
 * `libs/shared/design-system/src/primitives` stay free of hand-written pixel and rgba
 * values.
 *
 * See `doc/decision/0052-overlay-tokens-and-one-layering-scale.md`.
 */

/**
 * Stacking order. One shared scale, so no two overlays can quietly disagree
 * about which of them is on top.
 *
 * SOURCED: 40, 50 and 60 are the three `z-index` values the design actually
 * uses — sticky page header, fixed bottom action bar, modal scrim.
 * INVENTED: the three above 60. Their *order* is the load-bearing part:
 *
 * - a menu opens from a trigger and must clear the bars around it,
 * - a toast must clear a menu, because it can appear while one is open.
 *
 * The 10-point gaps leave room to insert a layer without renumbering.
 */
export const Z_LAYERS = {
  /** Sticky page header. SOURCED. */
  sticky: '40',
  /** Fixed bottom action bar. SOURCED. */
  bar: '50',
  /** Modal scrim and the dialog on it. SOURCED. */
  overlay: '60',
  /** Dropdown menu panel. INVENTED. */
  dropdown: '70',
  /** Toast region. INVENTED. */
  toast: '80',
} as const;

/**
 * The dimmed sheet behind a modal. SOURCED, verbatim: the design writes
 * `background:rgba(10,10,10,0.6)` on all three of its overlays.
 *
 * Not on the neutral scale and not expressible as one of its entries — it is a
 * translucent black, whereas every `--neutral-*` is opaque.
 */
export const SCRIM = 'rgba(10,10,10,0.6)';

/**
 * Overlay panel geometry.
 */
export const OVERLAY_SIZES = {
  /**
   * Dialog widths. SOURCED: the design writes `width:min(460px,100%)` on its
   * form and detail dialogs and `width:min(620px,100%)` on the wide one.
   * Consumed as `w-full max-w-[var(--modal-w-sm)]`, which is the same
   * `min()` behaviour spelled with utilities.
   */
  modalWidth: {
    sm: '460px',
    md: '620px',
  },
  /**
   * Minimum width of a dropdown menu panel. SOURCED: the design's avatar menu
   * is `width:246px`. A minimum rather than a fixed width, so a longer item
   * grows the panel instead of being clipped.
   */
  menuMinWidth: '246px',
  /**
   * Thickness of the selected-tab underline. SOURCED: the design writes
   * `border-bottom:3px solid`. Not on the `--space-*` scale (which starts at
   * 4px) and not one of Tailwind's `border-b-*` steps (1/2/4/8), so it needs a
   * token rather than an inline `border-b-[3px]`.
   */
  tabIndicator: '3px',
  /**
   * Width of a toast. INVENTED — the design has no toast. Narrower than the
   * small dialog on purpose: a toast is a notice, not a task.
   */
  toastWidth: '380px',
} as const;

export const OVERLAYS = {
  z: Z_LAYERS,
  scrim: SCRIM,
  size: OVERLAY_SIZES,
} as const;
