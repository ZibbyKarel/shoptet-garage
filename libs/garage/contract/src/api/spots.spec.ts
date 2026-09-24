import { NOT_A_UUID, UUID_B, parkingSpotFixture } from '../__fixtures__/fixtures';
import {
  adminListSpotsInputSchema,
  createSpotInputSchema,
  deactivateSpotInputSchema,
  spotListOutputSchema,
  updateSpotInputSchema,
} from './spots';

describe('spotListOutputSchema', () => {
  it('accepts a list of spots and an empty lot', () => {
    expect(spotListOutputSchema.safeParse({ spots: [parkingSpotFixture] }).success).toBe(true);
    expect(spotListOutputSchema.safeParse({ spots: [] }).success).toBe(true);
  });

  it('rejects a spot with an unknown group', () => {
    expect(
      spotListOutputSchema.safeParse({ spots: [{ ...parkingSpotFixture, group: 'VIP' }] }).success
    ).toBe(false);
  });

  it('requires the hidden flag on every spot', () => {
    expect(
      spotListOutputSchema.safeParse({ spots: [{ ...parkingSpotFixture, hidden: undefined }] })
        .success
    ).toBe(false);
  });

  it('requires the evCharger flag on every spot', () => {
    expect(
      spotListOutputSchema.safeParse({ spots: [{ ...parkingSpotFixture, evCharger: undefined }] })
        .success
    ).toBe(false);
  });
});

describe('adminListSpotsInputSchema', () => {
  it('defaults to active spots only', () => {
    expect(adminListSpotsInputSchema.parse({})).toEqual({ includeInactive: false });
  });

  it('accepts an explicit filter', () => {
    expect(adminListSpotsInputSchema.parse({ includeInactive: true, group: 'IT' })).toEqual({
      includeInactive: true,
      group: 'IT',
    });
  });

  it('rejects an unknown group and a non-boolean flag', () => {
    expect(adminListSpotsInputSchema.safeParse({ group: 'VIP' }).success).toBe(false);
    expect(adminListSpotsInputSchema.safeParse({ includeInactive: 'yes' }).success).toBe(false);
  });
});

describe('createSpotInputSchema', () => {
  const valid = { label: 'E2.92', group: 'SHARED' };

  it('accepts a label and a group', () => {
    expect(createSpotInputSchema.parse(valid)).toEqual(valid);
  });

  it('does not let the client set id, active, hidden or evCharger', () => {
    expect(
      createSpotInputSchema.parse({
        ...valid,
        id: UUID_B,
        active: false,
        hidden: true,
        evCharger: true,
      })
    ).toEqual(valid);
  });

  it('rejects an empty label and a missing group', () => {
    expect(createSpotInputSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
    expect(createSpotInputSchema.safeParse({ label: 'E2.92' }).success).toBe(false);
  });
});

describe('updateSpotInputSchema', () => {
  it('accepts an id alone — every other field is optional', () => {
    expect(updateSpotInputSchema.parse({ id: UUID_B })).toEqual({ id: UUID_B });
  });

  it('accepts a partial change', () => {
    expect(updateSpotInputSchema.parse({ id: UUID_B, group: 'IT' })).toEqual({
      id: UUID_B,
      group: 'IT',
    });
  });

  it('rejects a missing id and an invalid one', () => {
    expect(updateSpotInputSchema.safeParse({ label: 'E2.93' }).success).toBe(false);
    expect(updateSpotInputSchema.safeParse({ id: NOT_A_UUID }).success).toBe(false);
  });

  it('rejects null for a field that has no "clear" meaning', () => {
    expect(updateSpotInputSchema.safeParse({ id: UUID_B, label: null }).success).toBe(false);
  });

  it('accepts hiding and unhiding a spot', () => {
    expect(updateSpotInputSchema.parse({ id: UUID_B, hidden: true })).toEqual({
      id: UUID_B,
      hidden: true,
    });
    expect(updateSpotInputSchema.safeParse({ id: UUID_B, hidden: 'yes' }).success).toBe(false);
  });

  it('accepts setting and clearing the EV charger flag', () => {
    expect(updateSpotInputSchema.parse({ id: UUID_B, evCharger: true })).toEqual({
      id: UUID_B,
      evCharger: true,
    });
    expect(updateSpotInputSchema.safeParse({ id: UUID_B, evCharger: 'yes' }).success).toBe(false);
  });
});

describe('deactivateSpotInputSchema', () => {
  it('accepts an id', () => {
    expect(deactivateSpotInputSchema.parse({ id: UUID_B })).toEqual({ id: UUID_B });
  });

  it('rejects a non-uuid id', () => {
    expect(deactivateSpotInputSchema.safeParse({ id: NOT_A_UUID }).success).toBe(false);
  });
});
