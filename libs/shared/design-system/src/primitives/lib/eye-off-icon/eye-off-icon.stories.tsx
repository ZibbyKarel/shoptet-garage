import type { Meta, StoryObj } from '@storybook/react-vite';

import { EyeOffIcon, type EyeOffIconSize } from './eye-off-icon';

const SIZES: EyeOffIconSize[] = ['sm', 'md'];

const meta: Meta<typeof EyeOffIcon> = {
  title: 'Primitives/EyeOffIcon',
  component: EyeOffIcon,
  args: { size: 'sm', label: 'Skryté' },
  argTypes: {
    size: { control: 'inline-radio', options: SIZES },
  },
  decorators: [
    (Story) => (
      <div className="bg-neutral-600 p-3">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof EyeOffIcon>;

export const Default: Story = {};

export const Decorative: Story = { args: { label: undefined } };

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {SIZES.map((size) => (
        <EyeOffIcon key={size} {...args} size={size} />
      ))}
    </div>
  ),
};
