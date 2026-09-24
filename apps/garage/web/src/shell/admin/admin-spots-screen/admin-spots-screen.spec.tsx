import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ParkingSpot, SpotListOutput } from '@garage/contract';
import { IntlProvider } from '@garage/i18n';
import cs from '../../../../messages/cs.json';
import { failureWithCode } from '../../../testing/contract-failure';
import { ToastProvider } from '../../notifications/toast-provider';
import type { ScreenData } from '../../screen-state/screen-state';
import type { AdminWrite } from '../admin-errors';
import { AdminSpotsScreen, type SpotToday } from './admin-spots-screen';
import type { AdminSpotsScreenProps } from './admin-spots-screen';

const TIMESTAMP = '2026-08-28T09:15:00.000Z';

function aSpot(overrides: Partial<ParkingSpot> & { id: string; label: string }): ParkingSpot {
  return {
    group: 'IT',
    active: true,
    hidden: false,
    evCharger: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

const TAKEN = aSpot({ id: 's1', label: 'E2.92' });
const FREE = aSpot({ id: 's2', label: 'E2.93' });
const SHARED = aSpot({ id: 's3', label: 'E2.96', group: 'SHARED', evCharger: true });
const RETIRED = aSpot({ id: 's4', label: 'E2.99', active: false });
const HIDDEN = aSpot({ id: 's5', label: 'E2.98', hidden: true });

const TODAY: ReadonlyMap<string, SpotToday> = new Map([
  [TAKEN.id, { holderName: 'Karel Zíbar', holderIsGuest: false }],
  [FREE.id, { holderName: null, holderIsGuest: false }],
  [SHARED.id, { holderName: 'Lucie Marková', holderIsGuest: false }],
]);

/**
 * The screen's props, with the spot list given as plain rows.
 *
 * `spots` is a `ScreenData` union now, and almost every test in this file
 * varies the *rows*. Assembling the ready state here keeps those call sites
 * exactly as they were; `spotsState` is for the two that want the loading or
 * error state instead.
 */
type Overrides = Partial<Omit<AdminSpotsScreenProps, 'spots'>> & {
  readonly spots?: readonly ParkingSpot[];
  readonly spotsState?: ScreenData<SpotListOutput>;
};

function makeProps({ spots, spotsState, ...overrides }: Overrides = {}) {
  const spies = {
    onRetry: jest.fn(),
    onCreate: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    onSave: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    onActiveChange: jest.fn(),
    onHiddenChange: jest.fn(),
    onEvChargerChange: jest.fn(),
    onDeactivate: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    onDiscardFailure: jest.fn(),
  };

  const props: AdminSpotsScreenProps = {
    spots: spotsState ?? {
      kind: 'ready',
      data: { spots: [...(spots ?? [TAKEN, FREE, SHARED, RETIRED, HIDDEN])] },
    },
    todayBySpotId: TODAY,
    pendingSpotId: null,
    isSaving: false,
    writeFailure: null,
    ...spies,
    ...overrides,
  };

  return { props, spies };
}

function renderScreen(overrides: Overrides = {}) {
  const { props, spies } = makeProps(overrides);

  render(
    <IntlProvider locale="cs" messages={cs}>
      <ToastProvider>
        <AdminSpotsScreen {...props} />
      </ToastProvider>
    </IntlProvider>
  );

  return { ...spies, user: userEvent.setup() };
}

/**
 * The screen with the panel's failure bookkeeping stood up around it: a write
 * that fails records the failure, and `onDiscardFailure` really throws it away
 * — which is what `admin-spots-panel.tsx` does through `reset()`.
 *
 * Needed because the screen alone is a pure function of its props, and the
 * defect this exists to pin — a failure outliving the attempt it belongs to —
 * only takes shape across two clicks.
 */
function renderFailingWrites(failure: unknown) {
  const { props } = makeProps();

  function Harness() {
    const [live, setLive] = useState<{ error: unknown; from: AdminWrite } | null>(null);

    const fails = (from: AdminWrite) => async () => {
      setLive({ error: failure, from });
      throw failure;
    };

    return (
      <AdminSpotsScreen
        {...props}
        onCreate={fails('spotCreate')}
        onSave={fails('spotRename')}
        onDeactivate={fails('spotRetire')}
        writeFailure={live}
        onDiscardFailure={() => setLive(null)}
      />
    );
  }

  render(
    <IntlProvider locale="cs" messages={cs}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </IntlProvider>
  );

  return userEvent.setup();
}

/**
 * Scopes a query to the open dialog.
 *
 * "Kategorie" and "Štítek" each name two things on this screen — a column
 * header and a filter band outside the dialog, a form field inside it — so an
 * unscoped `getByLabelText` matches the wrong one.
 */
function inDialog() {
  return within(screen.getByRole('dialog'));
}

function rowOf(spot: ParkingSpot): HTMLElement {
  const row = document.querySelector(`[data-row-id="${spot.id}"]`);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no row rendered for ${spot.label}`);
  }
  return row;
}

describe('AdminSpotsScreen', () => {
  it('lists every spot, retired ones included — this is where they are revived', () => {
    renderScreen();

    expect(within(rowOf(TAKEN)).getByText('E2.92')).toBeInTheDocument();
    expect(within(rowOf(RETIRED)).getByText('E2.99')).toBeInTheDocument();
    expect(within(rowOf(RETIRED)).getByText('spotsInactive')).toBeInTheDocument();
    expect(within(rowOf(TAKEN)).queryByText('spotsInactive')).not.toBeInTheDocument();
  });

  describe('the "Stav dnes" column', () => {
    it('names the holder of a spot somebody parked on', () => {
      renderScreen();

      expect(
        within(rowOf(TAKEN)).getByText('dayStatusTaken: name=Karel Zíbar')
      ).toBeInTheDocument();
    });

    it('says a spot is free when the day overview says nobody holds it', () => {
      renderScreen();

      expect(within(rowOf(FREE)).getByText('dayStatusFree')).toBeInTheDocument();
    });

    it('says nothing about a spot the day overview does not carry', () => {
      // A retired spot is not in the day overview at all. Rendering "Volné"
      // for it would be a claim about a spot nobody can book.
      renderScreen();

      expect(within(rowOf(RETIRED)).getByText('spotsTodayUnknown')).toBeInTheDocument();
      expect(within(rowOf(RETIRED)).queryByText('dayStatusFree')).not.toBeInTheDocument();
    });

    it('badges a guest holder, so this table can tell one from an employee', () => {
      renderScreen({
        todayBySpotId: new Map([
          ...TODAY,
          [TAKEN.id, { holderName: 'Jan Novotný', holderIsGuest: true }],
        ]),
      });

      expect(
        within(rowOf(TAKEN)).getByText('dayStatusTaken: name=Jan Novotný')
      ).toBeInTheDocument();
      expect(within(rowOf(TAKEN)).getByText('guestHolder')).toBeInTheDocument();
      expect(within(rowOf(FREE)).queryByText('guestHolder')).not.toBeInTheDocument();
    });
  });

  describe('the category band', () => {
    it('counts every listed spot per category, retired ones included', () => {
      // Four IT (E2.92, E2.93, E2.99, E2.98) and one SHARED. A count that hid
      // the retired or hidden spot would disagree with the rows underneath it.
      renderScreen();

      const band = screen.getByRole('group', { name: 'spotsCategories' });
      expect(within(band).getByText('4')).toBeInTheDocument();
      expect(within(band).getByText('1')).toBeInTheDocument();
    });

    it('says the list of categories is fixed, and offers no way to add one', () => {
      renderScreen();

      expect(screen.getByText('spotsCategoriesFixed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Přidat kategorii/u })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/Nová kategorie/u)).not.toBeInTheDocument();
    });
  });

  describe('the inline category picker', () => {
    it('shows the spot’s current category, which is always one of the options', () => {
      renderScreen();

      expect(
        within(rowOf(SHARED)).getByRole('combobox', { name: 'spotsGroupSelectLabel: label=E2.96' })
      ).toHaveValue('SHARED');
    });

    it('offers exactly the closed enum, no more', () => {
      renderScreen();

      const select = within(rowOf(TAKEN)).getByRole('combobox', {
        name: 'spotsGroupSelectLabel: label=E2.92',
      });
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent)
      ).toEqual(['IT', 'SHARED']);
    });

    it('saves the label unchanged alongside the new category', async () => {
      const { onSave, user } = renderScreen();

      await user.selectOptions(
        within(rowOf(TAKEN)).getByRole('combobox', { name: 'spotsGroupSelectLabel: label=E2.92' }),
        'SHARED'
      );

      expect(onSave).toHaveBeenCalledWith({ id: TAKEN.id, label: 'E2.92', group: 'SHARED' });
    });
  });

  describe('the activity switch', () => {
    it('reflects the spot, and reports the state it moved to', async () => {
      const { onActiveChange, user } = renderScreen();

      expect(
        within(rowOf(TAKEN)).getByRole('switch', { name: 'spotsActiveToggleLabel: label=E2.92' })
      ).toBeChecked();

      await user.click(
        within(rowOf(TAKEN)).getByRole('switch', { name: 'spotsActiveToggleLabel: label=E2.92' })
      );
      expect(onActiveChange).toHaveBeenLastCalledWith(TAKEN.id, false);
    });

    it('brings a retired spot back', async () => {
      const { onActiveChange, user } = renderScreen();

      await user.click(
        within(rowOf(RETIRED)).getByRole('switch', { name: 'spotsActiveToggleLabel: label=E2.99' })
      );

      expect(onActiveChange).toHaveBeenLastCalledWith(RETIRED.id, true);
    });

    it('freezes only the row being written', () => {
      renderScreen({ pendingSpotId: TAKEN.id });

      expect(
        within(rowOf(TAKEN)).getByRole('switch', { name: 'spotsActiveToggleLabel: label=E2.92' })
      ).toBeDisabled();
      expect(
        within(rowOf(FREE)).getByRole('switch', { name: 'spotsActiveToggleLabel: label=E2.93' })
      ).toBeEnabled();
    });
  });

  describe('the hidden switch', () => {
    it('marks and reflects a hidden spot, and reports the state it moved to', async () => {
      const { onHiddenChange, user } = renderScreen();

      expect(within(rowOf(HIDDEN)).getByText('spotsHidden')).toBeInTheDocument();
      expect(within(rowOf(TAKEN)).queryByText('spotsHidden')).not.toBeInTheDocument();
      expect(
        within(rowOf(HIDDEN)).getByRole('switch', { name: 'spotsHiddenToggleLabel: label=E2.98' })
      ).toBeChecked();

      await user.click(
        within(rowOf(TAKEN)).getByRole('switch', { name: 'spotsHiddenToggleLabel: label=E2.92' })
      );
      expect(onHiddenChange).toHaveBeenLastCalledWith(TAKEN.id, true);

      await user.click(
        within(rowOf(HIDDEN)).getByRole('switch', { name: 'spotsHiddenToggleLabel: label=E2.98' })
      );
      expect(onHiddenChange).toHaveBeenLastCalledWith(HIDDEN.id, false);
    });

    it('freezes only the row being written', () => {
      renderScreen({ pendingSpotId: TAKEN.id });

      expect(
        within(rowOf(TAKEN)).getByRole('switch', { name: 'spotsHiddenToggleLabel: label=E2.92' })
      ).toBeDisabled();
      expect(
        within(rowOf(FREE)).getByRole('switch', { name: 'spotsHiddenToggleLabel: label=E2.93' })
      ).toBeEnabled();
    });
  });

  describe('the EV charger switch', () => {
    it('marks a spot with a charger, and reports the state it moved to', async () => {
      const { onEvChargerChange, user } = renderScreen();

      expect(within(rowOf(SHARED)).getByRole('img', { name: 'evCharger' })).toBeInTheDocument();
      expect(
        within(rowOf(TAKEN)).queryByRole('img', { name: 'evCharger' })
      ).not.toBeInTheDocument();
      expect(
        within(rowOf(SHARED)).getByRole('switch', {
          name: 'spotsEvChargerToggleLabel: label=E2.96',
        })
      ).toBeChecked();

      await user.click(
        within(rowOf(TAKEN)).getByRole('switch', {
          name: 'spotsEvChargerToggleLabel: label=E2.92',
        })
      );
      expect(onEvChargerChange).toHaveBeenLastCalledWith(TAKEN.id, true);

      await user.click(
        within(rowOf(SHARED)).getByRole('switch', {
          name: 'spotsEvChargerToggleLabel: label=E2.96',
        })
      );
      expect(onEvChargerChange).toHaveBeenLastCalledWith(SHARED.id, false);
    });

    it('freezes only the row being written', () => {
      renderScreen({ pendingSpotId: TAKEN.id });

      expect(
        within(rowOf(TAKEN)).getByRole('switch', {
          name: 'spotsEvChargerToggleLabel: label=E2.92',
        })
      ).toBeDisabled();
      expect(
        within(rowOf(FREE)).getByRole('switch', {
          name: 'spotsEvChargerToggleLabel: label=E2.93',
        })
      ).toBeEnabled();
    });
  });

  describe('adding a spot', () => {
    it('opens a form with the label and the category', async () => {
      const { user } = renderScreen();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      expect(screen.getByRole('dialog', { name: 'spotsCreateTitle' })).toBeInTheDocument();
      expect(inDialog().getByLabelText('spotsLabelField')).toHaveValue('');
    });

    it('sends the label and category that were typed', async () => {
      const { onCreate, user } = renderScreen();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      await user.type(inDialog().getByLabelText('spotsLabelField'), 'E2.10');
      await user.selectOptions(inDialog().getByLabelText('spotsGroupField'), 'SHARED');
      await user.click(inDialog().getByRole('button', { name: 'spotsSave' }));

      await waitFor(() =>
        expect(onCreate).toHaveBeenCalledWith({ label: 'E2.10', group: 'SHARED' })
      );
    });

    it('refuses an empty label without calling the API', async () => {
      const { onCreate, user } = renderScreen();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      await user.click(screen.getByRole('button', { name: 'spotsSave' }));

      expect(await screen.findByText('spotsLabelRequired')).toBeInTheDocument();
      expect(onCreate).not.toHaveBeenCalled();
    });

    it('closes once the spot exists', async () => {
      const { user } = renderScreen();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      await user.type(inDialog().getByLabelText('spotsLabelField'), 'E2.10');
      await user.click(inDialog().getByRole('button', { name: 'spotsSave' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('stays open, explaining a duplicate label rather than a lost race', async () => {
      const conflict = await failureWithCode('CONFLICT');
      const { user } = renderScreen({
        onCreate: jest.fn<Promise<void>, [unknown]>().mockRejectedValue(conflict),
        writeFailure: { error: conflict, from: 'spotCreate' },
      });

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      await user.type(inDialog().getByLabelText('spotsLabelField'), 'E2.92');
      await user.click(inDialog().getByRole('button', { name: 'spotsSave' }));

      // Scoped to the dialog on purpose. The dialog is a modal — it covers
      // the table — so a sentence rendered above the table would be present in
      // the DOM and invisible to the person who just pressed Save.
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(inDialog().getByText('spotsDuplicateLabel')).toBeInTheDocument();
      expect(screen.queryByText(cs.errors.CONFLICT)).not.toBeInTheDocument();
    });
  });

  describe('editing a spot', () => {
    it('opens seeded with the spot’s current values', async () => {
      const { user } = renderScreen();

      await user.click(within(rowOf(SHARED)).getByRole('button', { name: 'spotsEdit' }));

      expect(
        screen.getByRole('dialog', { name: 'spotsEditTitle: label=E2.96' })
      ).toBeInTheDocument();
      expect(inDialog().getByLabelText('spotsLabelField')).toHaveValue('E2.96');
      expect(inDialog().getByLabelText('spotsGroupField')).toHaveValue('SHARED');
    });

    it('sends the edited values with the spot’s id', async () => {
      const { onSave, user } = renderScreen();

      await user.click(within(rowOf(SHARED)).getByRole('button', { name: 'spotsEdit' }));
      await user.clear(inDialog().getByLabelText('spotsLabelField'));
      await user.type(inDialog().getByLabelText('spotsLabelField'), 'E2.97');
      await user.click(inDialog().getByRole('button', { name: 'spotsSave' }));

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({ id: SHARED.id, label: 'E2.97', group: 'SHARED' })
      );
    });
  });

  describe('"Smazat"', () => {
    it('asks first, and retires nothing until it is confirmed', async () => {
      const { onDeactivate, user } = renderScreen();

      await user.click(within(rowOf(FREE)).getByRole('button', { name: 'spotsDelete' }));

      expect(
        screen.getByRole('dialog', { name: 'spotsDeleteTitle: label=E2.93' })
      ).toBeInTheDocument();
      expect(onDeactivate).not.toHaveBeenCalled();
    });

    it('says the history survives — the row is never actually deleted', async () => {
      const { user } = renderScreen();

      await user.click(within(rowOf(FREE)).getByRole('button', { name: 'spotsDelete' }));

      expect(screen.getByText('spotsDeleteDescription')).toBeInTheDocument();
    });

    it('retires the spot on confirmation and closes', async () => {
      const { onDeactivate, user } = renderScreen();

      await user.click(within(rowOf(FREE)).getByRole('button', { name: 'spotsDelete' }));
      await user.click(screen.getByRole('button', { name: 'spotsDeleteConfirm' }));

      await waitFor(() => expect(onDeactivate).toHaveBeenCalledWith(FREE.id));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('changes nothing when it is cancelled', async () => {
      const { onDeactivate, user } = renderScreen();

      await user.click(within(rowOf(FREE)).getByRole('button', { name: 'spotsDelete' }));
      await user.click(screen.getByRole('button', { name: 'spotsCancel' }));

      expect(onDeactivate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('explains a live reservation instead of claiming a duplicate label', async () => {
      const conflict = await failureWithCode('CONFLICT');
      const { user } = renderScreen({
        onDeactivate: jest.fn<Promise<void>, [string]>().mockRejectedValue(conflict),
        writeFailure: { error: conflict, from: 'spotRetire' },
      });

      await user.click(within(rowOf(TAKEN)).getByRole('button', { name: 'spotsDelete' }));
      await user.click(screen.getByRole('button', { name: 'spotsDeleteConfirm' }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      // Rendered through the global `ToastProvider`, not inside the dialog —
      // `useNotify` publishes it to the app-wide toast region, not as the
      // dialog's own children.
      expect(screen.getByText('spotsDeleteConflict')).toBeInTheDocument();
      // Wrong on this procedure — that is the create/rename sentence.
      expect(screen.queryByText('spotsDuplicateLabel')).not.toBeInTheDocument();
      expect(screen.queryByText(cs.errors.CONFLICT)).not.toBeInTheDocument();
    });

    it('stays open after a refusal, so the sentence can be read', async () => {
      const conflict = await failureWithCode('CONFLICT');
      const { user } = renderScreen({
        onDeactivate: jest.fn<Promise<void>, [string]>().mockRejectedValue(conflict),
        writeFailure: { error: conflict, from: 'spotRetire' },
      });

      await user.click(within(rowOf(TAKEN)).getByRole('button', { name: 'spotsDelete' }));
      await user.click(screen.getByRole('button', { name: 'spotsDeleteConfirm' }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('a failure with no dialog open', () => {
    it('reads a failed inline switch as the live-reservation rule', async () => {
      renderScreen({
        writeFailure: { error: await failureWithCode('CONFLICT'), from: 'spotRetire' },
      });

      expect(screen.getByText('spotsDeleteConflict')).toBeInTheDocument();
      // No dialog is open, so the notice belongs above the table.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    it('refuses to invent a cause when switching a spot back on fails', async () => {
      renderScreen({
        writeFailure: { error: await failureWithCode('CONFLICT'), from: 'spotRevive' },
      });

      expect(screen.getByText('errFallbackSpot')).toBeInTheDocument();
      expect(screen.queryByText('spotsDuplicateLabel')).not.toBeInTheDocument();
    });

    it('shows nothing when the last write succeeded', () => {
      renderScreen({ writeFailure: null });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('a failure the admin has walked away from', () => {
    const RETIRE_REFUSED = 'spotsDeleteConflict';
    const DUPLICATE_LABEL = 'spotsDuplicateLabel';

    it('is discarded whenever the dialog changes, so it cannot outlive its own attempt', async () => {
      const { onDiscardFailure, user } = renderScreen();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      expect(onDiscardFailure).toHaveBeenCalledTimes(1);

      await user.click(inDialog().getByRole('button', { name: 'spotsCancel' }));
      expect(onDiscardFailure).toHaveBeenCalledTimes(2);

      await user.click(within(rowOf(TAKEN)).getByRole('button', { name: 'spotsDelete' }));
      expect(onDiscardFailure).toHaveBeenCalledTimes(3);
    });

    it('is gone when the same dialog is opened a second time', async () => {
      // The case the origin table cannot catch: create → create, where the
      // stale sentence and a fresh one would come from the very same surface.
      // Only actually forgetting the failure keeps the reopened form clean.
      const user = renderFailingWrites(await failureWithCode('CONFLICT'));

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
      await user.type(inDialog().getByLabelText('spotsLabelField'), 'E2.92');
      await user.click(inDialog().getByRole('button', { name: 'spotsSave' }));
      expect(await inDialog().findByText(DUPLICATE_LABEL)).toBeInTheDocument();

      await user.click(inDialog().getByRole('button', { name: 'spotsCancel' }));
      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      expect(inDialog().queryByText(DUPLICATE_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByText(DUPLICATE_LABEL)).not.toBeInTheDocument();
    });

    it('is gone from the next dialog after a refused "Smazat" — the reported defect', async () => {
      // An admin is refused a retire, cancels, then opens "Přidat místo".
      // The empty form used to greet them with "Na tomto místě jsou rezervace
      // ode dneška dál." before a character was typed.
      const user = renderFailingWrites(await failureWithCode('CONFLICT'));

      await user.click(within(rowOf(TAKEN)).getByRole('button', { name: 'spotsDelete' }));
      const confirm = inDialog().getByRole('button', { name: 'spotsDeleteConfirm' });
      await user.click(confirm);
      // Rendered through the global `ToastProvider`, not inside the dialog.
      expect(await screen.findByText(RETIRE_REFUSED)).toBeInTheDocument();

      await user.click(inDialog().getByRole('button', { name: 'spotsCancel' }));
      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      expect(inDialog().queryByText(RETIRE_REFUSED)).not.toBeInTheDocument();
      expect(screen.queryByText(RETIRE_REFUSED)).not.toBeInTheDocument();
    });

    it('never appears under a dialog that could not have caused it', async () => {
      // The second guard, tested where the first is deliberately inert: these
      // props never change, so the discard does nothing and only `WRITE_ORIGINS`
      // stands between a refused retire and the empty "Přidat místo" form.
      const { user } = renderScreen({
        writeFailure: { error: await failureWithCode('CONFLICT'), from: 'spotRetire' },
      });

      expect(await screen.findByText(RETIRE_REFUSED)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      expect(inDialog().queryByText(RETIRE_REFUSED)).not.toBeInTheDocument();
      expect(screen.queryByText(RETIRE_REFUSED)).not.toBeInTheDocument();
    });

    it('never appears in the delete confirmation when it came from the create form', async () => {
      const { user } = renderScreen({
        writeFailure: { error: await failureWithCode('CONFLICT'), from: 'spotCreate' },
      });

      // A create failure has no business above the table either: nothing
      // outside the form can create a spot.
      expect(screen.queryByText(DUPLICATE_LABEL)).not.toBeInTheDocument();

      await user.click(within(rowOf(TAKEN)).getByRole('button', { name: 'spotsDelete' }));

      expect(inDialog().queryByText(DUPLICATE_LABEL)).not.toBeInTheDocument();
    });
  });

  it('names the actions column for a screen reader while leaving it blank on screen', () => {
    // `04-admin-spots.png` draws that header empty. A column with no header is
    // still a column with no name to anyone reading the table through one, so
    // the name stays and only the pixels go.
    renderScreen();

    const header = screen.getByRole('columnheader', { name: 'spotsColumnActions' });
    expect(within(header).getByText('spotsColumnActions')).toHaveClass('sr-only');
  });

  describe('what a write in flight freezes', () => {
    it('disables the written row’s buttons, not only its switch', () => {
      renderScreen({ pendingSpotId: TAKEN.id });

      const written = within(rowOf(TAKEN));
      expect(written.getByRole('button', { name: 'spotsEdit' })).toBeDisabled();
      expect(written.getByRole('button', { name: 'spotsDelete' })).toBeDisabled();

      const untouched = within(rowOf(FREE));
      expect(untouched.getByRole('button', { name: 'spotsEdit' })).toBeEnabled();
      expect(untouched.getByRole('button', { name: 'spotsDelete' })).toBeEnabled();
    });

    it('leaves a dialog alone while some other row is being written', async () => {
      const { user } = renderScreen({ isSaving: true, pendingSpotId: TAKEN.id });

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      // "Zrušit" must stay live: an admin who cannot cancel a form they never
      // submitted is stuck on somebody else's request.
      expect(inDialog().getByRole('button', { name: 'spotsCancel' })).toBeEnabled();
    });

    it('does hold the dialog while the dialog’s own write is in flight', async () => {
      const { user } = renderScreen({ isSaving: true, pendingSpotId: null });

      await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

      expect(inDialog().getByRole('button', { name: 'spotsCancel' })).toBeDisabled();
    });
  });

  it('says the lot is empty rather than drawing a table of nothing', () => {
    renderScreen({ spots: [] });

    expect(screen.getByText('spotsEmpty')).toBeInTheDocument();
    expect(screen.getByText('spotsEmptyDescription')).toBeInTheDocument();
  });

  it('waits while the list is in flight', () => {
    renderScreen({ spotsState: { kind: 'loading' } });

    expect(screen.getByRole('status')).toHaveTextContent('loading');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the list could not be loaded', async () => {
    const { onRetry, user } = renderScreen({
      spotsState: { kind: 'error', error: new Error('connection refused') },
    });

    expect(screen.queryByText(/connection refused/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
