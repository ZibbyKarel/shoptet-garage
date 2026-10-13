import { cx } from '@garage/design-system/primitives';
import type { ReactNode } from 'react';

export type EmptyStateSize = 'sm' | 'md';

/**
 * Vertical breathing room. The compact step exists for an empty state inside a
 * card that already has its own padding — a `DataTable` body, most of all —
 * where the roomy one would leave the card looking broken rather than empty.
 */
const SIZE_PADDING: Record<EmptyStateSize, string> = {
  sm: 'px-6 py-8 gap-2',
  md: 'px-6 py-16 gap-3',
};

/** Heading levels a caller may opt into. See `headingLevel` below. */
export type EmptyStateHeadingLevel = 2 | 3 | 4;

export interface EmptyStateProps {
  /** The one line that says what is not here. */
  title: ReactNode;
  /** Optional second line: why it is empty, or what to do about it. */
  description?: ReactNode | undefined;
  /**
   * Decorative mark above the title — rendered `aria-hidden`, because the
   * title already says everything the icon does.
   */
  icon?: ReactNode | undefined;
  /** Usually a single `Button`. Rendered below the description. */
  action?: ReactNode | undefined;
  /** Vertical size step. Defaults to `md`. */
  size?: EmptyStateSize | undefined;
  /**
   * Renders the title as `<h2>` / `<h3>` / `<h4>` instead of a `<p>`.
   *
   * Deliberately opt-in and deliberately not defaulted to a heading: only the
   * page knows its own outline, and a component that guesses a level produces
   * the skipped-level defect that screen-reader users navigate straight into.
   * A `DataTable`'s empty body passes nothing, because a heading inside a table
   * cell is not a section title.
   */
  headingLevel?: EmptyStateHeadingLevel | undefined;
  className?: string | undefined;
}

/**
 * The "there is nothing here" block: a centred title, an optional explanation,
 * an optional call to action.
 *
 * **Invented, not drawn.** No screen in `doc/design/garage-design.dc.html`
 * shows an empty list — every mock ships with sample rows — so the layout and
 * the spacing steps here are derived from the design's language (centred,
 * `--fg-3` for secondary text, the card's own 24px gutter) rather than copied
 * from it. See `doc/decision/0071-empty-state-and-confirm-dialog-are-invented.md`.
 *
 * Domain-free: it carries no default copy about parking, users or reservations.
 * The `title` is required precisely so that nothing generic gets shipped by
 * accident.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'md',
  headingLevel,
  className,
}: EmptyStateProps) {
  const Title = headingLevel === undefined ? 'p' : (`h${headingLevel}` as const);

  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        SIZE_PADDING[size],
        className
      )}
    >
      {icon !== undefined && (
        <span aria-hidden="true" className="text-fg-3 [&>svg]:size-8">
          {icon}
        </span>
      )}
      <Title className="text-base font-bold text-fg">{title}</Title>
      {description !== undefined && (
        <p className="max-w-[46ch] text-sm leading-normal text-fg-3">{description}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
