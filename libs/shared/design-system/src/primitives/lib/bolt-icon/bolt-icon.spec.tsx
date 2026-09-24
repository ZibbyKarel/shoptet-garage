import { render, screen } from '@testing-library/react';

import { BoltIcon, type BoltIconSize } from './bolt-icon';

describe('BoltIcon', () => {
  it('is an image named by its label', () => {
    render(<BoltIcon label="Nabíječka pro elektromobily" />);

    const icon = screen.getByRole('img', { name: 'Nabíječka pro elektromobily' });
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon).not.toHaveAttribute('aria-hidden');
  });

  it('is decorative without a label', () => {
    const { container } = render(<BoltIcon />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each<[BoltIconSize, string]>([
    ['sm', 'size-4'],
    ['md', 'size-5'],
  ])('applies the %s size class', (size, expected) => {
    const { container } = render(<BoltIcon size={size} />);

    expect(container.querySelector('svg')).toHaveClass(expected);
  });

  it('defaults to sm, a green fill and a dark outline', () => {
    const { container } = render(<BoltIcon />);

    expect(container.querySelector('svg')).toHaveClass(
      'size-4',
      'fill-brand-green',
      'stroke-brand-dark'
    );
  });

  it('passes attributes and caller classes through', () => {
    const { container } = render(<BoltIcon className="custom-class" data-testid="bolt" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('custom-class');
    expect(svg).toHaveAttribute('data-testid', 'bolt');
  });
});
