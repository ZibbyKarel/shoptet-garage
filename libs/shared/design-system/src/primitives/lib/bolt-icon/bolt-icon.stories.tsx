import type { Meta, StoryObj } from '@storybook/react-vite';

import { BoltIcon, type BoltIconSize } from './bolt-icon';

const SIZES: BoltIconSize[] = ['sm', 'md'];

const meta: Meta<typeof BoltIcon> = {
  title: 'Primitives/BoltIcon',
  component: BoltIcon,
  args: { size: 'sm', label: 'Nabíječka pro elektromobily' },
  argTypes: {
    size: { control: 'inline-radio', options: SIZES },
  },
};

export default meta;
type Story = StoryObj<typeof BoltIcon>;

export const Default: Story = {};

export const Decorative: Story = { args: { label: undefined } };

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {SIZES.map((size) => (
        <BoltIcon key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

/** On the lot's asphalt the fill carries it; on a white table row the outline does. */
export const OnSurfaces: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <div className="bg-neutral-600 p-3">
        <BoltIcon {...args} />
      </div>
      <div className="border border-border bg-bg p-3">
        <BoltIcon {...args} />
      </div>
    </div>
  ),
};
