import type { SVGAttributes } from 'react';

import { cx } from '../cx';

/**
 * A lightning bolt: the green "electric" mark.
 *
 * An SVG, not the `⚡` character. The emoji renders in each platform's own
 * colours (yellow almost everywhere) and cannot be tinted, and the mark has to
 * be green.
 *
 * **Green fill, dark outline, on purpose.** `--brand-green` alone is 4.12:1 on
 * `--neutral-600` (the lot's asphalt), which clears WCAG 1.4.11's 3:1 for a
 * meaningful graphic, but it is only 1.88:1 on `--bg`, where it would fade into
 * a white table row. The `--brand-dark` outline carries it there instead.
 * `contrast.spec.tsx` holds both numbers.
 *
 * Presentation-only. With a `label` it is an image with that accessible name.
 * Without one it is decorative and hidden from assistive technology, as
 * `IconCircle` is by default.
 */
export type BoltIconSize = 'sm' | 'md';

const SIZE_CLASSES: Record<BoltIconSize, string> = {
  sm: 'size-4',
  md: 'size-5',
};

export interface BoltIconProps
  extends Omit<SVGAttributes<SVGSVGElement>, 'children' | 'role' | 'aria-label'> {
  /** Glyph size. Defaults to `sm` (16px). */
  size?: BoltIconSize | undefined;
  /** Accessible name. Omitted, the glyph is decorative (`aria-hidden`). */
  label?: string | undefined;
}

export function BoltIcon({ size = 'sm', label, className, ...rest }: BoltIconProps) {
  const a11y =
    label === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img' as const, 'aria-label': label };

  return (
    <svg
      {...rest}
      {...a11y}
      viewBox="0 0 24 24"
      focusable="false"
      className={cx('shrink-0 fill-brand-green stroke-brand-dark', SIZE_CLASSES[size], className)}
    >
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
