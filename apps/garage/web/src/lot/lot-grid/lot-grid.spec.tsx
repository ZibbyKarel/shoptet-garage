import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from '@garage/i18n';
import cs from '../../../messages/cs.json';
import { LotGrid } from './lot-grid';
import type { SpotGroupView, SpotView } from '../lot-view';

/**
 * The real `IntlProvider` and the real primitives, not doubles: what is under
 * test is what the composition draws and what it reports back, and the Czech
 * copy is part of that — a screen whose strings had drifted out of
 * `libs/shared/i18n` would still pass a suite that stubbed the translator.
 */

function spot(overrides: Partial<SpotView> = {}): SpotView {
  return {
    spotId: 'spot-a',
    label: 'E2.92',
    appearance: 'free',
    action: 'reserve',
    holderName: null,
    holderPlate: null,
    carColorClass: null,
    editorName: null,
    waitlistCount: 0,
    isMine: false,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    showAdminMenu: false,
    hidden: false,
    holderIsGuest: false,
    infoReason: null,
    timedBlocks: [],
    ...overrides,
  };
}

function group(spots: SpotView[], overrides: Partial<SpotGroupView> = {}): SpotGroupView {
  return {
    group: 'IT',
    spots,
    freeCount: spots.filter((one) => one.appearance === 'free').length,
    totalCount: spots.length,
    ...overrides,
  };
}

function renderGrid(groups: SpotGroupView[]) {
  const onOpenSpot = jest.fn();
  const onAdminOpenSpot = jest.fn();

  render(
    <IntlProvider locale="cs" messages={cs}>
      <LotGrid groups={groups} onOpenSpot={onOpenSpot} onAdminOpenSpot={onAdminOpenSpot} />
    </IntlProvider>
  );

  return { onOpenSpot, onAdminOpenSpot, user: userEvent.setup() };
}

describe('LotGrid', () => {
  it('labels each band with its group and its free count', () => {
    renderGrid([
      group([spot(), spot({ spotId: 'b', label: 'E2.93' })], { freeCount: 1, totalCount: 4 }),
    ]);

    expect(screen.getByRole('heading', { level: 2, name: 'IT' })).toBeInTheDocument();
    expect(screen.getByText('groupFree: free=1,total=4')).toBeInTheDocument();
  });

  it('renders the groups it is given, in the order it is given them', () => {
    renderGrid([
      group([spot()], { group: 'IT' }),
      group([spot({ spotId: 'b', label: 'E2.65' })], { group: 'SHARED' }),
    ]);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(['IT', 'SHARED']);
  });

  it('draws a free bay as bookable and reports the click', async () => {
    const { onOpenSpot, user } = renderGrid([group([spot()])]);

    expect(screen.getByText('free')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'reserveSpotAction: label=E2.92, free' }));
    expect(onOpenSpot).toHaveBeenCalledWith('spot-a');
  });

  it('draws an occupied bay with the holder and the plate', () => {
    renderGrid([
      group([
        spot({
          appearance: 'taken',
          action: 'queue',
          holderName: 'Petr Novák',
          holderPlate: '8SC 9012',
          carColorClass: 'text-car-2',
        }),
      ]),
    ]);

    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.getByText('8SC 9012')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'openSpotAction: label=E2.92, Petr Novák, 8SC 9012' })
    ).toBeEnabled();
  });

  it('shows a blank line rather than saying so when a holder has no plate', () => {
    renderGrid([
      group([
        spot({
          appearance: 'taken',
          action: 'queue',
          holderName: 'Petr Novák',
          holderPlate: null,
          carColorClass: 'text-car-2',
        }),
      ]),
    ]);

    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.queryByText('SPZ neuvedena')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'openSpotAction: label=E2.92, Petr Novák'
    );
  });

  it('draws a window-locked bay and still lets it be opened for the explanation', async () => {
    const { onOpenSpot, user } = renderGrid([
      group([spot({ appearance: 'window-locked', action: 'info' })]),
    ]);

    expect(screen.getByText('tileLocked')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'openSpotAction: label=E2.92, tileLocked' })
    );
    expect(onOpenSpot).toHaveBeenCalledWith('spot-a');
  });

  it('disables a bay somebody else is editing, and names them', async () => {
    // Genuinely `disabled`, not merely ignoring clicks: that is what keeps it
    // out of the tab order too, which the design's pointer-only early return
    // does not.
    const { onOpenSpot, user } = renderGrid([
      group([spot({ appearance: 'editing', action: 'none', editorName: 'Jana Dvořáková' })]),
    ]);

    const tile = screen.getByRole('button', {
      name: 'openSpotAction: label=E2.92, tileEditing Jana Dvořáková',
    });
    expect(tile).toBeDisabled();
    expect(screen.getByText('tileEditing')).toBeInTheDocument();
    expect(screen.getByText('Jana Dvořáková')).toBeInTheDocument();

    await user.click(tile);
    expect(onOpenSpot).not.toHaveBeenCalled();
  });

  /**
   * What a screen reader is actually told.
   *
   * The suite used to *appear* to cover this: "draws an occupied bay with the
   * holder and the plate" asserts `getByText('Petr Novák')` and, on the very
   * next line, that the accessible name is `Otevřít místo E2.92` — pinning the
   * holder as present in the DOM while simultaneously pinning that it is not in
   * the name. `getByText` passes on DOM presence; `aria-label` replaces the
   * button's contents as its name and a `<button>` is one node to a screen
   * reader, so everything asserted by `getByText` above was announced to
   * nobody.
   *
   * These four are the same four states asked the other question, and they are
   * the reason `toHaveAccessibleName` appears in this file at all. Each has to
   * be *distinguishable* from the others — that is the user-facing property,
   * not the exact wording.
   */
  describe('what a screen reader is told about a bay', () => {
    it('announces a free bay as free and bookable', () => {
      renderGrid([group([spot()])]);
      expect(screen.getByRole('button')).toHaveAccessibleName(
        'reserveSpotAction: label=E2.92, free'
      );
    });

    it('announces who holds a taken bay, and in what', () => {
      renderGrid([
        group([
          spot({
            appearance: 'taken',
            action: 'queue',
            holderName: 'Petr Novák',
            holderPlate: '8SC 9012',
            carColorClass: 'text-car-2',
          }),
        ]),
      ]);
      expect(screen.getByRole('button')).toHaveAccessibleName(
        'openSpotAction: label=E2.92, Petr Novák, 8SC 9012'
      );
    });

    it('announces that a window-locked bay is locked rather than merely openable', () => {
      renderGrid([group([spot({ appearance: 'window-locked', action: 'info' })])]);
      expect(screen.getByRole('button')).toHaveAccessibleName(
        'openSpotAction: label=E2.92, tileLocked'
      );
    });

    it('announces who is editing a hatched bay', () => {
      renderGrid([
        group([spot({ appearance: 'editing', action: 'none', editorName: 'Jana Dvořáková' })]),
      ]);
      expect(screen.getByRole('button')).toHaveAccessibleName(
        'openSpotAction: label=E2.92, tileEditing Jana Dvořáková'
      );
    });

    it('gives four bays in four states four names that do not collide', () => {
      // The regression this guards is not a wording change — it is any change
      // that collapses two states back onto one announcement, which is what
      // shipped. All four are rendered together on purpose: `getByRole` throws
      // on more than one match, so a collision fails here rather than being
      // something a reader has to notice by comparing four literals.
      renderGrid([
        group([
          spot({ spotId: 'a', label: 'E2.90' }),
          spot({
            spotId: 'b',
            label: 'E2.91',
            appearance: 'taken',
            action: 'queue',
            holderName: 'Petr Novák',
            holderPlate: '8SC 9012',
            carColorClass: 'text-car-2',
          }),
          spot({ spotId: 'c', label: 'E2.92', appearance: 'window-locked', action: 'info' }),
          spot({
            spotId: 'd',
            label: 'E2.93',
            appearance: 'editing',
            action: 'none',
            editorName: 'Jana Dvořáková',
          }),
        ]),
      ]);

      const names = screen
        .getAllByRole('button')
        .map((node) => node.getAttribute('aria-label') ?? '');

      expect(names).toEqual([
        'reserveSpotAction: label=E2.90, free',
        'openSpotAction: label=E2.91, Petr Novák, 8SC 9012',
        'openSpotAction: label=E2.92, tileLocked',
        'openSpotAction: label=E2.93, tileEditing Jana Dvořáková',
      ]);
      expect(new Set(names).size).toBe(4);
    });
  });

  it('shows the waitlist pill when somebody is queued', () => {
    renderGrid([group([spot({ waitlistCount: 2 })])]);
    expect(screen.getByText('waiting: count=2')).toBeInTheDocument();
  });

  it('draws no waitlist pill for an empty queue', () => {
    renderGrid([group([spot({ waitlistCount: 0 })])]);
    expect(screen.queryByText(/ve frontě/u)).not.toBeInTheDocument();
  });

  it('draws a timed bay with its blocks, capped at two lines plus a count', () => {
    const timedBlocks = [
      {
        id: 't1',
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'A',
        licensePlate: null,
        createdAt: '',
      },
      {
        id: 't2',
        startTime: '13:00',
        endTime: '14:00',
        guestName: 'B',
        licensePlate: null,
        createdAt: '',
      },
      {
        id: 't3',
        startTime: '15:00',
        endTime: '15:30',
        guestName: 'C',
        licensePlate: null,
        createdAt: '',
      },
    ];
    renderGrid([group([spot({ appearance: 'timed', action: 'info', timedBlocks })])]);

    expect(screen.getByText('9:00–10:30')).toBeInTheDocument();
    expect(screen.getByText('13:00–14:00')).toBeInTheDocument();
    expect(screen.queryByText('15:00–15:30')).not.toBeInTheDocument();
    expect(screen.getByText('tileMoreBlocks: count=1')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'tileTimedLabel: label=E2.92,times=9:00–10:30, 13:00–14:00, 15:00–15:30'
    );
  });

  it('routes the ⋯ menu to its own callback, not to the tile’s', async () => {
    // A separate callback because it is a different intent, and a sibling
    // button because a button inside a button is invalid HTML.
    const { onOpenSpot, onAdminOpenSpot, user } = renderGrid([
      group([
        spot({
          appearance: 'taken',
          action: 'queue',
          holderName: 'Petr Novák',
          carColorClass: 'text-car-2',
          showAdminMenu: true,
        }),
      ]),
    ]);

    await user.click(screen.getByRole('button', { name: 'spotMenu: label=E2.92' }));
    expect(onAdminOpenSpot).toHaveBeenCalledWith('spot-a');
    expect(onOpenSpot).not.toHaveBeenCalled();
  });

  it('draws no ⋯ menu when the view says not to', () => {
    renderGrid([
      group([
        spot({
          appearance: 'taken',
          action: 'queue',
          holderName: 'Petr Novák',
          carColorClass: 'text-car-2',
          showAdminMenu: false,
        }),
      ]),
    ]);

    expect(screen.queryByRole('button', { name: 'spotMenu: label=E2.92' })).not.toBeInTheDocument();
  });

  it('draws the legend once, below the groups', () => {
    renderGrid([group([spot()]), group([spot({ spotId: 'b' })], { group: 'SHARED' })]);

    expect(screen.getByText('legendTaken')).toBeInTheDocument();
    expect(screen.getByText('legendFree')).toBeInTheDocument();
    expect(screen.getByText('legendWaitlist')).toBeInTheDocument();
  });
});
