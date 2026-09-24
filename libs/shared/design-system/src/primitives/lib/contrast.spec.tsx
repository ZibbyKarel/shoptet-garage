import { render, screen } from '@testing-library/react';

import { COLOR_UTILITIES } from '@garage/design-system/tokens';

import { Avatar, type AvatarTone } from './avatar/avatar';
import { Badge, type BadgeTone } from './badge/badge';
import { BoltIcon } from './bolt-icon/bolt-icon';
import { Button, type ButtonVariant } from './button/button';
import { Callout, type CalloutTone } from './callout/callout';
import { Chip, type ChipTone } from './chip/chip';
import { EyeOffIcon } from './eye-off-icon/eye-off-icon';
import { IconCircle, type IconCircleTone } from './icon-circle/icon-circle';
import { Input } from './input/input';
import { Link } from './link/link';
import { Modal } from './modal/modal';
import { Stepper } from './stepper/stepper';
import { Text, type TextTone } from './text/text';
import { Toast, type ToastTone } from './toast/toast';
import { ToggleTile } from './toggle-tile/toggle-tile';

/**
 * Colour-contrast guard for the pairings this lib chooses.
 *
 * The `--brand-*` hexes are the design's and are not negotiable here; which
 * foreground is drawn on which background **is** this lib's own decision, and
 * it is the decision that was wrong. Six pairings were measured below AA at
 * body sizes in the final review — the success badge at 2.31:1 and the toast's
 * success glyph at 1.88:1 among them.
 *
 * Every ratio below is computed from `COLOR_UTILITIES` — the tokens lib's own
 * derived name→value map, which `theme-css.spec.ts` holds equal to the
 * `--color-*` block of `theme.css` — not asserted as a literal. The classes are
 * read off the **rendered** element rather than out of the component's source,
 * so a tone map that changes without its contrast being rechecked fails here,
 * and a test cannot pass on a pairing the component no longer uses.
 *
 * Two pairings are deliberately still failing and are pinned rather than
 * fixed; see `KNOWN_EXEMPTIONS` below.
 */

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const raw = parseInt(hex.slice(offset, offset + 2), 16) / 255;

    return raw <= 0.04045 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  };

  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexOf(token: string): string {
  const value = COLOR_UTILITIES[token];
  if (value === undefined) {
    throw new Error(`'${token}' is not a colour utility — see COLOR_UTILITIES in the tokens lib.`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    // Only `--scrim` is not an opaque hex, and nothing draws text on it. If
    // that changes, the ratio has to account for what shows through.
    throw new Error(
      `'${token}' is ${value}, not an opaque hex — contrast is undefined against it.`
    );
  }

  return value;
}

function ratioOf(foregroundToken: string, backgroundToken: string): number {
  return contrastRatio(hexOf(foregroundToken), hexOf(backgroundToken));
}

/**
 * The colour tokens an element carries *unconditionally*. Variant classes
 * (`hover:`, `checked:`, ...) apply in a different state and are excluded, the
 * same way `disabled-styling.spec.tsx` excludes them.
 *
 * `bg-transparent` and an element with no background at all both resolve to
 * `bg`: every one of these primitives is drawn on the page surface.
 */
function colorsOf(element: HTMLElement): { foreground: string; background: string } {
  const classes = element.className.split(/\s+/).filter((cls) => cls && !cls.includes(':'));
  const tokenAfter = (prefix: string) =>
    classes
      .filter((cls) => cls.startsWith(prefix))
      .map((cls) => cls.slice(prefix.length))
      .find((token) => token in COLOR_UTILITIES);

  return {
    foreground: tokenAfter('text-') ?? 'fg',
    background: tokenAfter('bg-') ?? 'bg',
  };
}

function ratioFor(element: HTMLElement): number {
  const { foreground, background } = colorsOf(element);

  return ratioOf(foreground, background);
}

/** WCAG 2.1 AA for text below 18px (or below 14px bold) — everything here. */
const AA_NORMAL_TEXT = 4.5;

/**
 * The two colour pairs the design owns, both still below AA and both left
 * alone on purpose: `plan.md` makes the visual design the source of truth
 * where it and this lib disagree, so changing either is a designer's call, not
 * a fix.
 *
 * Keyed on the two **hexes**, not on the token names, because each pair is
 * spelled more than one way and reaches the screen in more than one place —
 * white-on-red is `--fg-on-dark` on `--danger` in the toast's danger glyph and
 * on the danger button's hover, and red-on-white is `--danger` on `--bg` in
 * every form error message; all three are the same #E5484D/#FFFFFF pair at the
 * same 3.91:1. A name-keyed list would have caught one of them and quietly
 * missed the others.
 *
 * They are pinned to their measured ratio rather than merely skipped, so a
 * token edit that changes the number breaks this test and forces the record to
 * be revisited. See
 * `doc/decision/0265-two-below-aa-pairings-the-design-owns-are-pinned-not-fixed.md`,
 * which carries the alternative (`--brand-blue-700`, 4.90:1 on white) and what
 * the designer is being asked to decide.
 */
const KNOWN_EXEMPTIONS: { label: string; hexes: [string, string]; ratio: number }[] = [
  {
    label: '--fg-on-blue on --brand-blue (primary CTA, toast info glyph)',
    hexes: ['#FFFFFF', '#008FFF'],
    ratio: 3.3,
  },
  {
    label: '--danger against --bg, either way round (form errors, toast danger glyph)',
    hexes: ['#E5484D', '#FFFFFF'],
    ratio: 3.91,
  },
];

const isExempt = (element: HTMLElement) => {
  const { foreground, background } = colorsOf(element);
  const drawn = [hexOf(foreground).toUpperCase(), hexOf(background).toUpperCase()].sort();

  return KNOWN_EXEMPTIONS.some((pair) => {
    const known = pair.hexes.map((hex) => hex.toUpperCase()).sort();

    return known[0] === drawn[0] && known[1] === drawn[1];
  });
};

describe('colour contrast of the pairings this lib chooses', () => {
  it('agrees with the values the review measured, so the formula itself is not the thing under test', () => {
    // Three of the six failures the final review reported, recomputed here.
    expect(ratioOf('brand-green-700', 'brand-green-100')).toBeCloseTo(2.31, 2);
    expect(ratioOf('brand-blue', 'brand-blue-100')).toBeCloseTo(2.88, 2);
    expect(ratioOf('fg-on-green', 'brand-green')).toBeCloseTo(1.88, 2);
  });

  it.each<BadgeTone>(['neutral', 'info', 'success', 'warning', 'danger', 'tag'])(
    'Badge tone=%s clears AA',
    (tone) => {
      render(<Badge tone={tone}>Volno</Badge>);

      expect(ratioFor(screen.getByText('Volno'))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  );

  it.each<AvatarTone>(['dark', 'info', 'neutral', 'warning'])(
    'Avatar tone=%s clears AA',
    (tone) => {
      render(<Avatar tone={tone} initials="KZ" label="Karel Zíbar" />);

      expect(ratioFor(screen.getByRole('img', { name: 'Karel Zíbar' }))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT
      );
    }
  );

  it.each<ToastTone>(['neutral', 'info', 'success', 'warning', 'danger'])(
    'Toast tone=%s clears AA, glyph chip included',
    (tone) => {
      const { container } = render(
        <Toast tone={tone} icon="!">
          Rezervace potvrzena
        </Toast>
      );
      const glyph = screen.getByText('!');
      const surface = container.firstElementChild as HTMLElement;

      expect(ratioFor(surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      // The glyph sits on its own chip, so it does not inherit the surface.
      // `info` and `danger` draw theirs on the saturated brand blue and the
      // danger red — the two pinned pairs, reached here by a second route.
      if (!isExempt(glyph)) {
        expect(ratioFor(glyph)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  );

  it("Modal's eyebrow clears AA", () => {
    // Its tint is spelled `--brand-light`, which is the same #E2F2FF as
    // `--brand-blue-100`. Blue-on-it was the same 2.88:1 as the `info` badge,
    // under a different token name — which is why this test resolves colours to
    // values rather than comparing names.
    render(
      <Modal open onClose={() => undefined} title="Nastavení" eyebrow="Otevřeno" hideCloseButton>
        <p>Obsah</p>
      </Modal>
    );

    expect(ratioFor(screen.getByText('Otevřeno'))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each<ButtonVariant>(['primary', 'secondary', 'outline', 'danger', 'ghost'])(
    'Button variant=%s clears AA, unless it is a pinned exemption',
    (variant) => {
      render(<Button variant={variant}>Uložit</Button>);
      const button = screen.getByRole('button', { name: 'Uložit' });

      if (isExempt(button)) {
        expect(variant).toBe('primary');

        return;
      }

      expect(ratioFor(button)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  );

  it('the pinned exemptions still measure exactly what the decision record says', () => {
    for (const pair of KNOWN_EXEMPTIONS) {
      expect({
        label: pair.label,
        ratio: Number(contrastRatio(pair.hexes[0], pair.hexes[1]).toFixed(2)),
      }).toEqual({ label: pair.label, ratio: pair.ratio });
    }
  });

  it('names the alternative the decision record asks the designer to rule on', () => {
    // `--brand-blue-700` #0070D6 would carry the CTA at 4.90:1 on white, in
    // both directions. The review's report says 4.72:1; recomputed here.
    expect(ratioOf('brand-blue-700', 'bg')).toBeCloseTo(4.9, 2);
    expect(ratioOf('fg-on-blue', 'brand-blue-700')).toBeCloseTo(4.9, 2);
  });

  it('the form error message is the exempt pairing, and nothing else about it changed', () => {
    render(<Input label="SPZ" error="Vyplňte SPZ" />);

    expect(isExempt(screen.getByRole('alert'))).toBe(true);
  });

  /**
   * Disabled text is exempt from WCAG 1.4.3, so AA does not apply — but a label
   * nobody can read is still a defect, and at `--border-strong` on `--bg-muted`
   * it measured 1.38:1. The floor here is 3:1, the AA threshold for non-text
   * user-interface components, which `--fg-3` (4.40:1) clears comfortably while
   * still reading as inactive.
   */
  const DISABLED_FLOOR = 3;

  it('a disabled Button stays readable', () => {
    render(<Button disabled>Uložit</Button>);

    expect(ratioFor(screen.getByRole('button', { name: 'Uložit' }))).toBeGreaterThanOrEqual(
      DISABLED_FLOOR
    );
  });

  it('a disabled Stepper keeps its value and both step buttons readable', () => {
    render(<Stepper label="Počet" min={0} max={10} defaultValue={5} disabled />);

    for (const name of ['Snížit', 'Zvýšit']) {
      expect(ratioFor(screen.getByRole('button', { name }))).toBeGreaterThanOrEqual(DISABLED_FLOOR);
    }
    expect(ratioFor(screen.getByRole('spinbutton', { name: 'Počet' }))).toBeGreaterThanOrEqual(
      DISABLED_FLOOR
    );
  });

  describe('Text', () => {
    it.each<TextTone>(['default', 'muted', 'subtle'])('tone=%s clears AA on --bg', (tone) => {
      render(<Text tone={tone}>Volno</Text>);

      expect(ratioFor(screen.getByText('Volno'))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    /**
     * `faint` (`text-neutral-400` on `--bg`) does **not** clear AA — 2.56:1,
     * measured below. Left pinned rather than folded into the blanket check
     * above: `text.tsx`'s own comment says this tone exists for exactly one
     * call site, the recessed weekend column heads in `bulk-modal.tsx`, whose
     * own spec (`bulk-modal.spec.tsx`) already asserts the literal class
     * `text-neutral-400` — this predates `Text` and is a decorative label
     * doing the same job it did before this component wrapped it, not a
     * regression this batch introduced. Reported per `0265`'s pinning
     * approach; no ruling exists on it yet.
     */
    it('tone=faint is BELOW AA on --bg — pinned, pre-existing, not fixed here', () => {
      render(<Text tone="faint">SO</Text>);

      expect(ratioFor(screen.getByText('SO'))).toBeCloseTo(2.56, 2);
    });

    /**
     * `on-yellow`/`on-green`/`on-blue` are **not** drawn on the `--brand-*-100`
     * tints — `fg-on-green`/`fg-on-blue` are white, which only reads on a
     * *solid* fill. The real call sites (`lot-header.tsx`: `bg-brand-green
     * text-fg-on-green` / `bg-brand-yellow text-fg-on-yellow`; `bulk-modal.tsx`,
     * `date-picker-dialog.tsx`, `lock-mode-choice.tsx`: `bg-brand-blue
     * text-fg-on-blue`) all pair the tone with the matching *solid* brand
     * background, so that is what is checked here — not the tint the initial
     * recommendation for this test named.
     */
    it.each<[TextTone, string]>([['on-yellow', 'brand-yellow']])(
      'tone=%s clears AA on its real solid %s surface',
      (tone, backgroundToken) => {
        render(<Text tone={tone}>Volno</Text>);
        const { foreground } = colorsOf(screen.getByText('Volno'));

        expect(ratioOf(foreground, backgroundToken)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    );

    it('tone=on-blue on its real solid brand-blue surface is the already-pinned exemption', () => {
      render(<Text tone="on-blue">Volno</Text>);
      const { foreground } = colorsOf(screen.getByText('Volno'));

      expect(ratioOf(foreground, 'brand-blue')).toBeCloseTo(3.3, 2);
    });

    /**
     * `on-green` on its real solid `brand-green` surface is **not** exempt —
     * it is the exact `--fg-on-green`/`--brand-green` pairing (1.88:1) that
     * `0266` already fixed in `toast.tsx` and that `icon-circle.tsx`'s
     * `green` tone was fixed to avoid here too (see that file's comment).
     * `lot-header.tsx` still draws this pairing at its `isSuccess` state
     * (outside this lib's reach — `apps/` is not touched from here), so it is
     * reported rather than silently weakened, same as `faint` above.
     */
    it('tone=on-green on its real solid brand-green surface is BELOW AA — pinned, reported, not fixed here', () => {
      render(<Text tone="on-green">Volno</Text>);
      const { foreground } = colorsOf(screen.getByText('Volno'));

      expect(ratioOf(foreground, 'brand-green')).toBeCloseTo(1.88, 2);
    });

    /**
     * The `inverse-*` family sets `text-neutral-0/NN` — an alpha-modified
     * utility. `colorsOf`/`ratioFor` cannot see it: they match a class's
     * token against `COLOR_UTILITIES` verbatim, and `neutral-0/90` is not a
     * key in that map (nor should it be — `theme-css.spec.ts` only derives
     * opaque tokens). `0265`'s own risk section already names this as a
     * blind spot ("a pairing produced by opacity ... is outside what the
     * test can see"), so this block computes the composited colour itself
     * rather than pretending the existing helpers cover it.
     *
     * The real background is `lot-grid.tsx`'s `<Box className="... bg-neutral-600">`
     * — the map's asphalt, not `--bg`. Nested group headers sit on a further
     * darkened overlay (`bg-brand-dark/10` on top of that), so `neutral-600`
     * is the *lighter* of the two real surfaces this family is drawn on —
     * checking against it is the harder case, and passing it implies passing
     * the darker one too.
     */
    function compositeOverNeutral600(alpha: number): string {
      const onto = hexOf('neutral-600');
      const channel = (offset: number) => parseInt('FFFFFF'.slice(offset, offset + 2), 16);
      const ontoChannel = (offset: number) => parseInt(onto.slice(offset + 1, offset + 3), 16);
      const mix = (offset: number) =>
        Math.round(channel(offset) * alpha + ontoChannel(offset) * (1 - alpha));

      return `#${[0, 2, 4].map((offset) => mix(offset).toString(16).padStart(2, '0')).join('')}`;
    }

    it.each<[TextTone, number, number]>([
      ['inverse', 1, 7.73],
      ['inverse-90', 0.9, 6.67],
      ['inverse-80', 0.8, 5.64],
      ['inverse-70', 0.7, 4.78],
    ])(
      'tone=%s clears AA on the dark parking-map surface (bg-neutral-600)',
      (_tone, alpha, expected) => {
        const composited = compositeOverNeutral600(alpha);
        const ratio = contrastRatio(composited, hexOf('neutral-600'));

        expect(ratio).toBeCloseTo(expected, 2);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    );

    /**
     * `inverse-60` and `inverse-50` do **not** clear AA on the real surface
     * — 3.99:1 and 3.30:1 against the 4.5:1 floor. Left alone rather than
     * silently weakened here (per `0265`'s pinning approach), because these
     * are new failures this test run found, not an accepted design
     * decision recorded anywhere yet: unlike `0265`'s two pinned pairs,
     * nothing has ruled on these. Reported to the owner with the measured
     * ratios; a designer call (widen the floor, or stop using these two
     * steps for body-sized text on the map) is still needed.
     */
    it.each<[TextTone, number, number]>([
      ['inverse-60', 0.6, 3.99],
      ['inverse-50', 0.5, 3.3],
    ])(
      'tone=%s is BELOW AA on the dark parking-map surface — pinned, not fixed',
      (_tone, alpha, expected) => {
        const composited = compositeOverNeutral600(alpha);
        const ratio = contrastRatio(composited, hexOf('neutral-600'));

        expect(ratio).toBeCloseTo(expected, 2);
        expect(ratio).toBeLessThan(AA_NORMAL_TEXT);
      }
    );
  });

  describe('Callout', () => {
    // `text-fg` on `bg-brand-yellow-100`/`bg-brand-green-100` — the same tint
    // pair `Toast` and `Badge`'s `tone="tag"` already draw text on. Both
    // clear AA comfortably: 16.19:1 and 15.41:1, recomputed here.
    it.each<CalloutTone>(['warning', 'success'])('tone=%s clears AA', (tone) => {
      render(<Callout tone={tone}>Zamčeno pro tento měsíc.</Callout>);

      expect(ratioFor(screen.getByText('Zamčeno pro tento měsíc.'))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT
      );
    });

    it('measures the exact ratios named in its own comment', () => {
      expect(ratioOf('fg', 'brand-yellow-100')).toBeCloseTo(16.19, 2);
      expect(ratioOf('fg', 'brand-green-100')).toBeCloseTo(15.41, 2);
    });
  });

  describe('Chip', () => {
    it.each<ChipTone>(['outline', 'muted'])('tone=%s clears AA', (tone) => {
      render(<Chip tone={tone}>3 volná</Chip>);

      expect(ratioFor(screen.getByText('3 volná'))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  });

  describe('IconCircle', () => {
    // Only the three solid-fill tones carry their own foreground; `translucent`
    // and `translucent-light` set no text colour at all and inherit whatever
    // the surrounding context sets, so there is no pairing here to measure in
    // isolation — see `icon-circle.tsx`'s own comment on `TONE_CLASSES`.
    it.each<IconCircleTone>(['yellow', 'green'])('tone=%s clears AA', (tone) => {
      render(<IconCircle tone={tone}>!</IconCircle>);

      expect(ratioFor(screen.getByText('!'))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    // `blue` is `bg-brand-blue text-fg-on-blue` — the same hex pair as the
    // already-pinned primary-CTA exemption (`0265`), reached by a second
    // route rather than a new failure.
    it('tone=blue is the already-pinned --fg-on-blue/--brand-blue exemption', () => {
      render(<IconCircle tone="blue">!</IconCircle>);

      expect(isExempt(screen.getByText('!'))).toBe(true);
    });
  });

  describe('ToggleTile', () => {
    it('shape=cell, unselected clears AA', () => {
      render(<ToggleTile shape="cell">1</ToggleTile>);

      expect(ratioFor(screen.getByRole('button', { name: '1' }))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT
      );
    });

    it('shape=cell, inactive clears AA even though disabled text is exempt from it', () => {
      render(
        <ToggleTile shape="cell" selectable={false}>
          1
        </ToggleTile>
      );

      expect(ratioFor(screen.getByRole('button', { name: '1' }))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT
      );
    });

    it('shape=pill, unselected clears AA', () => {
      render(<ToggleTile shape="pill">Ráno</ToggleTile>);

      expect(ratioFor(screen.getByRole('button', { name: 'Ráno' }))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT
      );
    });

    it('shape=pill, inactive clears the disabled floor (fixed: was text-border-strong, 1.38:1)', () => {
      render(
        <ToggleTile shape="pill" disabled>
          Ráno
        </ToggleTile>
      );

      expect(ratioFor(screen.getByRole('button', { name: 'Ráno' }))).toBeGreaterThanOrEqual(
        DISABLED_FLOOR
      );
    });

    it.each<'cell' | 'pill'>(['cell', 'pill'])(
      'shape=%s, selected is the already-pinned --fg-on-blue/--brand-blue exemption',
      (shape) => {
        render(
          <ToggleTile shape={shape} selected>
            1
          </ToggleTile>
        );
        const tile = screen.getByRole('button', { name: '1' });

        expect(isExempt(tile)).toBe(true);
      }
    );

    /**
     * `BulkModal`'s already-reserved-day highlight (`accentColor`): the tile
     * carries its own inline background, so `colorsOf`/`ratioFor` (which read
     * `bg-*`/`text-*` classes) cannot see it — this measures the actual pairing
     * directly, the same `contrastRatio` helper everything above resolves to.
     * All three car colours (`car-palette.ts`) must clear the same 3:1 disabled
     * floor `CELL_INACTIVE`'s `--fg-3` clears for the plain blocked-day chrome,
     * so a future car-colour change cannot silently reintroduce I2/I3's failure
     * (raw `--fg-3` on `--color-car-3` measured 1.42:1).
     */
    it.each<[string, string]>([
      ['car-1', '#fcaf00'],
      ['car-2', '#00e25a'],
      ['car-3', '#3b88ff'],
    ])('shape=cell, inactive with accentColor=%s clears the disabled floor', (_name, hex) => {
      render(
        <ToggleTile shape="cell" selectable={false} accentColor={hex}>
          1
        </ToggleTile>
      );
      const tile = screen.getByRole('button', { name: '1' });

      expect(tile.style.backgroundColor).not.toBe('');
      // `--fg` — asserted here as the literal hex it resolves to, matching how
      // every other test in this file reads a foreground token.
      expect(contrastRatio(hexOf('fg'), hex)).toBeGreaterThanOrEqual(DISABLED_FLOOR);
    });
  });

  describe('Link', () => {
    it('is the already-pinned --brand-blue/--bg exemption, not a new failure', () => {
      render(<Link href="/">Zpět na parkoviště</Link>);
      const link = screen.getByRole('link', { name: 'Zpět na parkoviště' });

      expect(isExempt(link)).toBe(true);
    });
  });

  describe('BoltIcon', () => {
    /** WCAG 2.1 SC 1.4.11: a graphic that carries information needs 3:1 against its surroundings. */
    const NON_TEXT = 3;

    it('stays visible on the lot asphalt through its fill and on a white surface through its outline', () => {
      render(<BoltIcon label="Nabíječka" />);
      // An SVG's `className` is an `SVGAnimatedString`, so read the attribute.
      const classes = (
        screen.getByRole('img', { name: 'Nabíječka' }).getAttribute('class') ?? ''
      ).split(/\s+/);
      const tokenAfter = (prefix: string) =>
        classes
          .filter((cls) => cls.startsWith(prefix))
          .map((cls) => cls.slice(prefix.length))
          .find((token) => token in COLOR_UTILITIES) ?? `no ${prefix}* colour`;

      expect(ratioOf(tokenAfter('fill-'), 'neutral-600')).toBeGreaterThanOrEqual(NON_TEXT);
      expect(ratioOf(tokenAfter('stroke-'), 'bg')).toBeGreaterThanOrEqual(NON_TEXT);
    });
  });

  describe('EyeOffIcon', () => {
    /** WCAG 2.1 SC 1.4.11: a graphic that carries information needs 3:1 against its surroundings. */
    const NON_TEXT = 3;

    it('stays visible on the lot asphalt through its stroke', () => {
      render(<EyeOffIcon label="Skryté" />);
      const classes = (
        screen.getByRole('img', { name: 'Skryté' }).getAttribute('class') ?? ''
      ).split(/\s+/);
      const stroke =
        classes
          .filter((cls) => cls.startsWith('stroke-'))
          .map((cls) => cls.slice('stroke-'.length))
          .find((token) => token in COLOR_UTILITIES) ?? 'no stroke-* colour';

      expect(ratioOf(stroke, 'neutral-600')).toBeGreaterThanOrEqual(NON_TEXT);
    });
  });
});
