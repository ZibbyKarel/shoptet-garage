import type { ParkingSpot } from '@garage/contract';
import {
  failureSurfaceOf,
  isDialogSaving,
  shouldShowFailureIn,
  toCategoryCounts,
} from './spots-view';

function aSpot(overrides: Partial<ParkingSpot> = {}): ParkingSpot {
  return {
    id: 'spot-1',
    label: 'E2.92',
    group: 'IT',
    active: true,
    hidden: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('failureSurfaceOf', () => {
  it('is the table when no dialog is open', () => {
    expect(failureSurfaceOf(null)).toBe('table');
  });

  it('is the dialog for every one of the three dialogs', () => {
    // Three homes, one surface: a modal covers the table, so all three print
    // in the same place.
    expect(failureSurfaceOf('create')).toBe('dialog');
    expect(failureSurfaceOf('edit')).toBe('dialog');
    expect(failureSurfaceOf('delete')).toBe('dialog');
  });
});

describe('shouldShowFailureIn', () => {
  it('shows a create failure in the create dialog and not above the table', () => {
    expect(shouldShowFailureIn('spotCreate', 'create', 'dialog')).toBe(true);
    expect(shouldShowFailureIn('spotCreate', 'create', 'table')).toBe(false);
  });

  it('shows a rename failure above the table when the rename came from the row', () => {
    // The inline category picker renames without opening anything.
    expect(shouldShowFailureIn('spotRename', null, 'table')).toBe(true);
    expect(shouldShowFailureIn('spotRename', null, 'dialog')).toBe(false);
  });

  it('shows a rename failure inside the edit dialog when that dialog is open', () => {
    expect(shouldShowFailureIn('spotRename', 'edit', 'dialog')).toBe(true);
    expect(shouldShowFailureIn('spotRename', 'edit', 'table')).toBe(false);
  });

  it('shows a retire failure in either of its two origins', () => {
    expect(shouldShowFailureIn('spotRetire', 'delete', 'dialog')).toBe(true);
    expect(shouldShowFailureIn('spotRetire', null, 'table')).toBe(true);
  });

  it('shows nothing when the open dialog could not have produced the write', () => {
    // The guard that survives a missed discard: nothing in the "Nové
    // parkovací místo" form can retire or revive a spot, so a failure from
    // one has no route into it.
    expect(shouldShowFailureIn('spotRetire', 'create', 'dialog')).toBe(false);
    expect(shouldShowFailureIn('spotRevive', 'edit', 'dialog')).toBe(false);
    expect(shouldShowFailureIn('spotCreate', 'edit', 'dialog')).toBe(false);
  });

  it('shows nothing for a revive failure while a dialog is open', () => {
    // Only the row's switch can revive; with a dialog open the admin is not
    // looking at the row, and no dialog is an origin for it.
    expect(shouldShowFailureIn('spotRevive', null, 'table')).toBe(true);
    expect(shouldShowFailureIn('spotRevive', 'delete', 'dialog')).toBe(false);
    expect(shouldShowFailureIn('spotVisibility', null, 'table')).toBe(true);
    expect(shouldShowFailureIn('spotVisibility', 'edit', 'dialog')).toBe(false);
  });

  it('shows nothing at all for a write that never reaches this screen', () => {
    // `userUpdate` and `windowUpdate` have no entry: silence is the right
    // direction for a sentence whose origin this screen cannot account for.
    expect(shouldShowFailureIn('userUpdate', null, 'table')).toBe(false);
    expect(shouldShowFailureIn('windowUpdate', null, 'table')).toBe(false);
    expect(shouldShowFailureIn('windowUpdate', 'edit', 'dialog')).toBe(false);
  });
});

describe('isDialogSaving', () => {
  const SPOT = aSpot({ id: 'spot-a' });

  it('is false with no dialog open, whatever is in flight', () => {
    expect(isDialogSaving(true, null, 'spot-a')).toBe(false);
  });

  it('is false when nothing is in flight at all', () => {
    expect(isDialogSaving(false, { kind: 'edit', spot: SPOT }, null)).toBe(false);
  });

  it('claims a write on the spot the open dialog is about', () => {
    expect(isDialogSaving(true, { kind: 'edit', spot: SPOT }, 'spot-a')).toBe(true);
    expect(isDialogSaving(true, { kind: 'delete', spot: SPOT }, 'spot-a')).toBe(true);
  });

  it('disowns a write on some other row', () => {
    // The defect this exists for: a row switch mid-flight used to put the open
    // dialog's "Uložit" into its loading state and disable "Zrušit".
    expect(isDialogSaving(true, { kind: 'edit', spot: SPOT }, 'spot-b')).toBe(false);
  });

  it('claims the write with no id, which is the create', () => {
    expect(isDialogSaving(true, { kind: 'create' }, null)).toBe(true);
  });

  it('disowns a row write while the create dialog is open', () => {
    expect(isDialogSaving(true, { kind: 'create' }, 'spot-a')).toBe(false);
  });
});

describe('toCategoryCounts', () => {
  it('counts each category, listing every one the enum has', () => {
    expect(
      toCategoryCounts([
        aSpot({ id: '1' }),
        aSpot({ id: '2', group: 'SHARED' }),
        aSpot({ id: '3' }),
      ])
    ).toEqual([
      { group: 'IT', count: 2 },
      { group: 'SHARED', count: 1 },
    ]);
  });

  it('counts retired spots too, because the table still lists them', () => {
    // The band sits above the rows; a count that disagreed with what is
    // underneath it would be worse than no count.
    expect(toCategoryCounts([aSpot({ active: false })])).toEqual([
      { group: 'IT', count: 1 },
      { group: 'SHARED', count: 0 },
    ]);
  });

  it('still names every category for an empty lot', () => {
    expect(toCategoryCounts([])).toEqual([
      { group: 'IT', count: 0 },
      { group: 'SHARED', count: 0 },
    ]);
  });
});
