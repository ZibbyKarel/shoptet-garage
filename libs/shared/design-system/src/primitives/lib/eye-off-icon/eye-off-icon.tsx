import type { SVGAttributes } from 'react';

import { cx } from '../cx';

/**
 * A crossed-out eye: the "hidden" mark.
 *
 * Drawn as a stroke in `--neutral-0`, because its one surface is the lot's
 * asphalt (`--neutral-600`); `contrast.spec.tsx` holds that ratio. Sized and
 * labelled exactly like `BoltIcon`, its sibling on the spot tile.
 *
 * Presentation-only. With a `label` it is an image with that accessible name.
 * Without one it is decorative and hidden from assistive technology.
 */
export type EyeOffIconSize = 'sm' | 'md';

const SIZE_CLASSES: Record<EyeOffIconSize, string> = {
  sm: 'size-4',
  md: 'size-5',
};

export interface EyeOffIconProps
  extends Omit<SVGAttributes<SVGSVGElement>, 'children' | 'role' | 'aria-label'> {
  /** Glyph size. Defaults to `sm` (16px). */
  size?: EyeOffIconSize | undefined;
  /** Accessible name. Omitted, the glyph is decorative (`aria-hidden`). */
  label?: string | undefined;
}

export function EyeOffIcon({ size = 'sm', label, className, ...rest }: EyeOffIconProps) {
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
      className={cx('shrink-0 fill-none stroke-neutral-0', SIZE_CLASSES[size], className)}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {label === undefined ? null : <title>{label}</title>}
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
