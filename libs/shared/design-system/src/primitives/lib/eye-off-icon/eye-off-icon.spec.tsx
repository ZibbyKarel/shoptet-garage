import { render, screen } from '@testing-library/react';

import { EyeOffIcon, type EyeOffIconSize } from './eye-off-icon';

describe('EyeOffIcon', () => {
  it('is an image named by its label', () => {
    render(<EyeOffIcon label="Skryté" />);

    const icon = screen.getByRole('img', { name: 'Skryté' });
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon).not.toHaveAttribute('aria-hidden');
  });

  it('is decorative without a label', () => {
    const { container } = render(<EyeOffIcon />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each<[EyeOffIconSize, string]>([
    ['sm', 'size-4'],
    ['md', 'size-5'],
  ])('applies the %s size class', (size, expected) => {
    const { container } = render(<EyeOffIcon size={size} />);

    expect(container.querySelector('svg')).toHaveClass(expected);
  });

  it('defaults to sm, no fill and a light stroke', () => {
    const { container } = render(<EyeOffIcon />);

    expect(container.querySelector('svg')).toHaveClass('size-4', 'fill-none', 'stroke-neutral-0');
  });

  it('renders a title when a label is given', () => {
    const { container } = render(<EyeOffIcon label="Skryté" />);

    const title = container.querySelector('svg > title');
    expect(title).toHaveTextContent('Skryté');
  });

  it('renders no title without a label', () => {
    const { container } = render(<EyeOffIcon />);

    expect(container.querySelector('title')).not.toBeInTheDocument();
  });

  it('passes attributes and caller classes through', () => {
    const { container } = render(<EyeOffIcon className="custom-class" data-testid="eye" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('custom-class');
    expect(svg).toHaveAttribute('data-testid', 'eye');
  });
});
