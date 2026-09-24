import type { ParkingSpot } from '@garage/contract';
import { NO_PREFERRED_SPOT, shouldClearPreferredSpot, toIcsFeedView } from './settings-view';

describe('toIcsFeedView', () => {
  it('builds the feed URL from an origin and a token', () => {
    expect(toIcsFeedView('https://api.test', 'ics-token-abc')).toEqual({
      kind: 'ready',
      url: 'https://api.test/api/calendar/ics-token-abc.ics',
    });
  });

  it('is unavailable when the API origin could not be derived', () => {
    // An empty origin is what `apiOriginOf` returns when it has nothing to
    // work with; building a link from it would produce a broken one.
    expect(toIcsFeedView('', 'ics-token-abc')).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable before the profile has brought a token', () => {
    expect(toIcsFeedView('https://api.test', undefined)).toEqual({ kind: 'unavailable' });
  });
});

describe('shouldClearPreferredSpot', () => {
  function spot(id: string): ParkingSpot {
    return {
      id,
      label: id.toUpperCase(),
      group: 'IT',
      active: true,
      hidden: false,
      evCharger: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
  }

  const SPOTS = [spot('a'), spot('b')];

  it('clears a preference for a spot that is no longer selectable', () => {
    // `spot.deactivate` never clears anyone's stored preference, so a retired
    // spot's id outlives it in every profile that named it.
    expect(shouldClearPreferredSpot('gone', SPOTS, false, false)).toBe(true);
  });

  it('leaves a preference that is still on offer alone', () => {
    expect(shouldClearPreferredSpot('b', SPOTS, false, false)).toBe(false);
  });

  it('leaves "no preference" alone — there is nothing to clear', () => {
    expect(shouldClearPreferredSpot(NO_PREFERRED_SPOT, SPOTS, false, false)).toBe(false);
  });

  it('never clears while the spot list is still in flight', () => {
    // The failure this guard exists for: an empty `spots` means "not loaded"
    // here, and clearing on it would throw away a perfectly valid preference.
    expect(shouldClearPreferredSpot('a', [], true, false)).toBe(false);
  });

  it('never clears when the spot list failed', () => {
    expect(shouldClearPreferredSpot('a', [], false, true)).toBe(false);
  });

  it('clears once the list has genuinely resolved to nothing', () => {
    expect(shouldClearPreferredSpot('a', [], false, false)).toBe(true);
  });
});
