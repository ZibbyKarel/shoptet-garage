import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiClient } from '@garage/api-client';
import { IntlProvider } from '@garage/i18n';
import type { MyProfile, ParkingSpot } from '@garage/contract';
import cs from '../../../messages/cs.json';
import { ToastProvider } from '../notifications/toast-provider';
import { SettingsScreen } from './settings-screen';
import type { SettingsScreenProps } from './settings-screen';

/**
 * Every failure under test is produced by a **real** `RPCLink` — a client
 * built with `createApiClient`, one real procedure called on it, only `fetch`
 * replaced — exactly as `screen-state.spec.tsx` does, and for the same reason:
 * a hand-built `ORPCError` would assert this file's idea of the wire shape
 * instead of the transport's, and `apps/garage/web` may not import `@orpc/client` at
 * all to build one directly.
 */
const API_URL = 'https://api.test/rpc';

function transportAnswering(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

function rpcPayload(value: unknown) {
  return { json: value, meta: [] };
}

function contractErrorBody(code: string, status: number, message: string) {
  return { defined: false as const, code, status, message };
}

async function failureFrom(fetchImpl: () => Promise<Response>): Promise<unknown> {
  const client = createApiClient({ url: API_URL, fetch: fetchImpl });
  const marker = Symbol('resolved');
  const outcome = await client.me.get().then(
    () => marker,
    (error: unknown) => error
  );
  if (outcome === marker) {
    throw new Error('expected the call to reject, but it resolved');
  }
  return outcome;
}

const API_ORIGIN = 'https://api.test';

const PROFILE: MyProfile = {
  id: 'user-1',
  email: 'jana.novakova@example.com',
  name: 'Jana Nováková',
  licensePlate: '4AB 1234',
  role: 'USER',
  oktaId: 'okta|1',
  active: true,
  icsToken: 'ics-token-abc',
  preferredParkingSpotId: 'spot-1',
  createdAt: '2026-08-28T09:15:00.000Z',
  updatedAt: '2026-08-28T09:15:00.000Z',
};

const SPOT_A: ParkingSpot = {
  id: 'spot-1',
  label: 'E2.92',
  group: 'IT',
  active: true,
  hidden: false,
  evCharger: false,
  createdAt: '2026-08-28T09:15:00.000Z',
  updatedAt: '2026-08-28T09:15:00.000Z',
};

const SPOT_B: ParkingSpot = { ...SPOT_A, id: 'spot-2', label: 'E2.65', group: 'SHARED' };

/** A profile whose stored preference points at a spot `spot.list` no longer returns — e.g. retired. */
const PROFILE_WITH_RETIRED_PREFERENCE: MyProfile = {
  ...PROFILE,
  preferredParkingSpotId: 'spot-retired',
};

/**
 * The screen's own props, plus the five ICS ones written flat.
 *
 * `SettingsScreenProps.ics` groups those five into one value; a test that
 * varies exactly one of them should not have to restate the other four, so
 * this helper assembles the group and every call site below stays as it was.
 */
type ScreenOverrides = Partial<Omit<SettingsScreenProps, 'ics'>> & {
  readonly apiOrigin?: string;
  readonly icsToken?: string | undefined;
  readonly onRegenerateToken?: () => Promise<void>;
  readonly isRegenerating?: boolean;
  readonly regenerateError?: unknown;
};

function renderScreen(overrides: ScreenOverrides = {}) {
  const onRetry = jest.fn();
  const onSave = jest.fn();
  const onRegenerateToken = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();

  function propsFrom(next: ScreenOverrides): SettingsScreenProps {
    const merged = { ...overrides, ...next };
    const {
      apiOrigin,
      icsToken,
      onRegenerateToken: onRegenerate,
      isRegenerating,
      regenerateError,
      ...screenOverrides
    } = merged;

    return {
      isPending: false,
      isError: false,
      error: null,
      onRetry,
      profile: PROFILE,
      spots: [SPOT_A, SPOT_B],
      spotsPending: false,
      spotsError: false,
      onSave,
      isSaving: false,
      saveError: null,
      ics: {
        apiOrigin: apiOrigin ?? API_ORIGIN,
        // `icsToken: undefined` is itself a case under test ("no token yet"),
        // so the default applies only when the key is absent.
        token: 'icsToken' in merged ? icsToken : PROFILE.icsToken,
        onRegenerate: onRegenerate ?? onRegenerateToken,
        isRegenerating: isRegenerating ?? false,
        regenerateError: regenerateError ?? null,
      },
      onClose,
      ...screenOverrides,
    };
  }

  const view = render(
    <IntlProvider locale="cs" messages={cs}>
      <ToastProvider>
        <SettingsScreen {...propsFrom({})} />
      </ToastProvider>
    </IntlProvider>
  );

  function rerenderWith(next: ScreenOverrides) {
    view.rerender(
      <IntlProvider locale="cs" messages={cs}>
        <ToastProvider>
          <SettingsScreen {...propsFrom(next)} />
        </ToastProvider>
      </IntlProvider>
    );
  }

  return { onRetry, onSave, onRegenerateToken, onClose, user: userEvent.setup(), rerenderWith };
}

function stubClipboard(): { writeText: jest.Mock } {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return { writeText };
}

describe('SettingsScreen — loading and error', () => {
  it('shows the loading state and no form while the profile is in flight', () => {
    renderScreen({ isPending: true, profile: undefined });

    expect(screen.getByRole('status')).toHaveTextContent('loading');
    expect(screen.queryByLabelText('licensePlateLabel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });

  it('shows the error state with a retry, and no form', async () => {
    const { onRetry, user } = renderScreen({
      isError: true,
      error: new Error('boom'),
      profile: undefined,
    });

    expect(screen.getByText('errorTitle')).toBeInTheDocument();
    expect(screen.queryByLabelText('licensePlateLabel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides the form when isError is set, even if a stale profile is still present', () => {
    // Deliberately an unlikely combination — the point is that "ready" reads
    // `isError` for itself rather than relying on `profile` happening to be
    // `undefined` whenever `isError` is `true`.
    renderScreen({ isError: true, error: new Error('boom'), profile: PROFILE });

    expect(screen.queryByLabelText('licensePlateLabel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });

  it('hides the form while isPending is set, even if a stale profile is still present', () => {
    // Same shape as the `isError` test above, for the sibling clause: `ready`
    // must read `isPending` for itself. Pairing `isPending: true` with
    // `profile: undefined` (as the "shows the loading state" test above does)
    // would let `ready` stay false via the *other* clause alone, and never
    // prove this one (Task 26 review, I2).
    renderScreen({ isPending: true, profile: PROFILE });

    expect(screen.queryByLabelText('licensePlateLabel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });

  it('hides the form when the profile is undefined, even if isPending and isError are both false', () => {
    // The third clause of `ready`, isolated the same way. This combination
    // should not arise from real query state (`profile` is documented as
    // `undefined` exactly when `isPending || isError`), but `ready` itself
    // must not rely on that invariant holding — it reads `profile !== undefined`
    // directly (Task 26 review, I2).
    renderScreen({ isPending: false, isError: false, profile: undefined });

    expect(screen.queryByLabelText('licensePlateLabel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });
});

describe('SettingsScreen — the form', () => {
  it('pre-fills the licence plate and the preferred spot from the profile', () => {
    renderScreen();

    expect(screen.getByLabelText('licensePlateLabel')).toHaveValue('4AB 1234');
    expect(screen.getByLabelText('preferredSpotLabel')).toHaveValue('spot-1');
  });

  it('lists active spots as "label · group", plus a no-preference option', () => {
    renderScreen();

    const select = screen.getByLabelText('preferredSpotLabel') as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((option) => option.textContent);

    expect(optionTexts).toEqual(['preferredSpotNone', 'E2.92 · IT', 'E2.65 · SHARED']);
  });

  it('sends the trimmed licence plate and the selected spot on save', async () => {
    const { onSave, user } = renderScreen();

    await user.clear(screen.getByLabelText('licensePlateLabel'));
    await user.type(screen.getByLabelText('licensePlateLabel'), '  9ZZ 8888  ');
    await user.selectOptions(screen.getByLabelText('preferredSpotLabel'), 'spot-2');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).toHaveBeenCalledWith({
      licensePlate: '9ZZ 8888',
      preferredParkingSpotId: 'spot-2',
    });
  });

  it('sends null for an emptied licence plate — clearing it, not an empty string', async () => {
    const { onSave, user } = renderScreen();

    await user.clear(screen.getByLabelText('licensePlateLabel'));
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ licensePlate: null }));
  });

  it('sends null for the preferred spot when "Bez preference" is chosen', async () => {
    const { onSave, user } = renderScreen();

    await user.selectOptions(screen.getByLabelText('preferredSpotLabel'), '');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ preferredParkingSpotId: null }));
  });

  it('cancels without saving', async () => {
    const { onSave, onClose, user } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables Cancel and shows a spinner on Save while saving', () => {
    renderScreen({ isSaving: true });

    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(screen.getByTestId('button-spinner')).toBeInTheDocument();
  });

  it('shows no error toast when there is nothing to report', () => {
    renderScreen();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the generic Czech message when the failure is not a shaped contract error at all', () => {
    // A transport-level failure (network drop, a thrown plain `Error`) is not
    // an `ORPCError`-shaped payload, so `toContractError` returns `null` and
    // `describeError` falls back to the shell's generic sentence rather than
    // the settings-specific or catalogue ones.
    renderScreen({ saveError: new Error('network dropped') });

    expect(screen.getByText('errorUnknown')).toBeInTheDocument();
  });

  it('shows settings-specific copy for VALIDATION_FAILED, not the shared reservation-rule sentence', async () => {
    // `me.updateSettings` declares only `NOT_FOUND` and `VALIDATION_FAILED`,
    // and on this screen `VALIDATION_FAILED` means one thing: the stored
    // preferred spot has been retired. The shared error catalogue's sentence
    // for that code is about reservation-day rules (weekends, holidays), which
    // has nothing to do with this screen (Task 26 review, I3) — asserting the
    // catalogue string here would pin the bug, not catch it.
    const error = await failureFrom(
      transportAnswering(400, rpcPayload(contractErrorBody('VALIDATION_FAILED', 400, 'nope')))
    );

    renderScreen({ saveError: error });

    expect(screen.getByText('preferredSpotUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('VALIDATION_FAILED')).not.toBeInTheDocument();
  });

  it('still shows the shared catalogue sentence for a code other than VALIDATION_FAILED', async () => {
    const error = await failureFrom(
      transportAnswering(404, rpcPayload(contractErrorBody('NOT_FOUND', 404, 'nope')))
    );

    renderScreen({ saveError: error });

    expect(screen.getByText('NOT_FOUND')).toBeInTheDocument();
  });

  it('does not clobber an in-progress edit when the profile silently refetches', async () => {
    const { user, rerenderWith } = renderScreen();

    await user.clear(screen.getByLabelText('licensePlateLabel'));
    await user.type(screen.getByLabelText('licensePlateLabel'), '1XY 9999');

    // A background refetch (e.g. `me.get` invalidated after the ICS token
    // regenerates) hands down a new profile object — same person, new
    // reference. It must not silently overwrite what the user is mid-typing.
    rerenderWith({ profile: { ...PROFILE, icsToken: 'a-different-token' } });

    expect(screen.getByLabelText('licensePlateLabel')).toHaveValue('1XY 9999');
  });

  it('submits the form when Enter is pressed in a field, not just via the Save button', async () => {
    const { onSave, user } = renderScreen();

    await user.click(screen.getByLabelText('licensePlateLabel'));
    await user.keyboard('{Enter}');

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('rejects a licence plate over 16 characters with the Czech message, not the browser silently truncating it', async () => {
    // `maxLength` used to be set on the underlying `<input>`, which made this
    // path of the schema (`.max(16)`) — and its Czech message — unreachable
    // by construction (Task 26 review, m2). The browser attribute is gone, so
    // typing past the limit now reaches real Zod validation.
    const { onSave, user } = renderScreen();

    await user.clear(screen.getByLabelText('licensePlateLabel'));
    await user.type(screen.getByLabelText('licensePlateLabel'), '1234567890123456789');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(await screen.findByText('licensePlateTooLong')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a loading hint under the picker while spot.list is still in flight', () => {
    renderScreen({ spotsPending: true });

    expect(screen.getByText('preferredSpotLoading')).toBeInTheDocument();
  });

  it('shows an inline error when spot.list fails, instead of silently offering only "Bez preference"', () => {
    renderScreen({ spotsError: true, spots: [] });

    expect(screen.getByText('preferredSpotLoadError')).toBeInTheDocument();
  });

  it('sends null, not the retired id, when saving after a reconciled preference', async () => {
    // The stored id is not among the active spots — e.g. an admin retired it
    // after it was chosen as a preference (`spot.deactivate` never clears
    // anyone's `preferredParkingSpotId`). A real `<select>` falls back to
    // *displaying* "Bez preference" for such a value regardless of whether
    // this component does anything about it — jsdom does the same, which is
    // why that display alone is not asserted here as proof of the fix. What
    // only the fix explains is the *submitted* value: without it, Save would
    // silently resubmit the retired id nobody can see selected (Task 26
    // review, I1).
    const { onSave, user } = renderScreen({
      profile: PROFILE_WITH_RETIRED_PREFERENCE,
      spots: [SPOT_A, SPOT_B],
    });

    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ preferredParkingSpotId: null }));
  });

  it('does not reconcile away the preferred spot while spot.list is still pending — only once it is known', async () => {
    // While `spotsPending` is true, `spots` may still be `[]` for "not loaded"
    // rather than "no active spots" — reconciling against an empty list here
    // would wrongly clear a still-valid preference the moment the screen
    // opens, before `spot.list` has even answered.
    const { onSave, user } = renderScreen({
      profile: PROFILE_WITH_RETIRED_PREFERENCE,
      spots: [],
      spotsPending: true,
    });

    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ preferredParkingSpotId: 'spot-retired' })
    );
  });
});

describe('SettingsScreen — the modal chrome', () => {
  it('shows the pinned title and description, verbatim', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'title' })).toBeInTheDocument();
    expect(screen.getByText('description')).toBeInTheDocument();
  });

  it('hides the description while the form is not ready', () => {
    renderScreen({ isPending: true, profile: undefined });

    expect(screen.queryByText('description')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const { onClose, user } = renderScreen();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a scrim click, so a stray click cannot discard unsaved input', async () => {
    const { onClose, user } = renderScreen();

    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;
    await user.click(scrim);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders no × close button — the design draws none', () => {
    renderScreen();

    expect(screen.queryByRole('button', { name: 'Zavřít' })).not.toBeInTheDocument();
  });
});

describe('SettingsScreen — the ICS section', () => {
  it('shows the unavailable message when the API origin is unknown', () => {
    renderScreen({ apiOrigin: '' });

    expect(screen.getByText('icsUnavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('icsUrlLabel')).not.toBeInTheDocument();
  });

  it('shows the unavailable message when there is no token yet', () => {
    renderScreen({ icsToken: undefined });

    expect(screen.queryByLabelText('icsUrlLabel')).not.toBeInTheDocument();
  });

  it('builds the feed URL from the origin and the token', () => {
    renderScreen({ apiOrigin: API_ORIGIN, icsToken: 'abc' });

    expect(screen.getByLabelText('icsUrlLabel')).toHaveValue(
      'https://api.test/api/calendar/abc.ics'
    );
  });

  it('keeps the ICS URL field read-only, so the credential cannot be edited in place', () => {
    renderScreen();

    expect(screen.getByLabelText('icsUrlLabel')).toHaveAttribute('readonly');
  });

  it('copies the feed URL and shows confirmation', async () => {
    const { user } = renderScreen();
    // Stubbed *after* `renderScreen` — `userEvent.setup()` installs its own
    // clipboard polyfill the moment it runs, which would otherwise clobber a
    // stub defined any earlier.
    const { writeText } = stubClipboard();

    await user.click(screen.getByRole('button', { name: 'icsCopy' }));

    expect(writeText).toHaveBeenCalledWith('https://api.test/api/calendar/ics-token-abc.ics');
    expect(await screen.findByText('icsCopied')).toBeInTheDocument();
  });

  it('shows a failure message when the clipboard write rejects', async () => {
    const { user } = renderScreen();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: 'icsCopy' }));

    expect(await screen.findByText('icsCopyFailed')).toBeInTheDocument();
  });

  it('disables the regenerate trigger while a regeneration is already in flight', () => {
    renderScreen({ isRegenerating: true });

    expect(screen.getByRole('button', { name: 'icsRegenerate' })).toBeDisabled();
  });

  it('opens a confirmation before regenerating the token', async () => {
    const { user } = renderScreen();

    expect(screen.queryByText('icsRegenerateConfirmTitle')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));

    expect(screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' })).toBeInTheDocument();
  });

  it('warns, in the confirmation, that the old link stops working', async () => {
    // The entire reason this confirmation is meaningful for an irreversible
    // action is this sentence (Task 26 review, M9) — the title and confirm
    // label alone do not say what confirming actually does.
    const { user } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));

    expect(screen.getByText('icsRegenerateConfirmDescription')).toBeInTheDocument();
  });

  it('renders the confirming button with the destructive (danger) styling', async () => {
    const { user } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });

    expect(within(dialog).getByRole('button', { name: 'icsRegenerateConfirmButton' })).toHaveClass(
      'bg-danger-100'
    );
  });

  it('cancels the confirmation without calling back', async () => {
    const { onRegenerateToken, user } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));

    expect(onRegenerateToken).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'icsRegenerateConfirmTitle' })
    ).not.toBeInTheDocument();
  });

  it('clears the regenerate-failure toast on cancel, not just the dialog', async () => {
    // The toast is gated on `confirmOpen`, not just on `regenerateError` being
    // non-null (`ics.regenerateError` is caller-owned mutation state and is
    // not cleared by Cancel) — precisely so a stale error does not linger on
    // the settings screen once the confirmation that showed it is gone.
    const error = await failureFrom(
      transportAnswering(403, rpcPayload(contractErrorBody('FORBIDDEN', 403, 'nope')))
    );
    const { user } = renderScreen({ regenerateError: error });

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('FORBIDDEN'));

    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('regenerates the token and closes the dialog on success', async () => {
    const { onRegenerateToken, user } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'icsRegenerateConfirmButton' }));

    expect(onRegenerateToken).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'icsRegenerateConfirmTitle' })
      ).not.toBeInTheDocument()
    );
  });

  it('keeps the confirmation open when regeneration rejects, so the user can retry', async () => {
    const onRegenerateToken = jest.fn().mockRejectedValue(new Error('boom'));
    const { user } = renderScreen({ onRegenerateToken });

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });
    await user.click(within(dialog).getByRole('button', { name: 'icsRegenerateConfirmButton' }));

    await waitFor(() => expect(onRegenerateToken).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' })).toBeInTheDocument();
  });

  it('shows a translated toast while the confirmation is open after a previous regeneration failed', async () => {
    // The error toast now renders through the global `ToastProvider` — a
    // sibling of the confirmation dialog's DOM subtree, not a descendant of
    // it — so this asserts it is on screen (via its `role="alert"`, which
    // only the danger toast has — see `Toast`) while the dialog is open,
    // rather than scoping the query to `within(dialog)`.
    const error = await failureFrom(
      transportAnswering(403, rpcPayload(contractErrorBody('FORBIDDEN', 403, 'nope')))
    );
    const { user } = renderScreen({ regenerateError: error });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    expect(screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('FORBIDDEN'));
  });

  it('shows the confirm button as loading once a regeneration is in flight', async () => {
    const { user, rerenderWith } = renderScreen();

    await user.click(screen.getByRole('button', { name: 'icsRegenerate' }));
    rerenderWith({ isRegenerating: true });

    const dialog = screen.getByRole('dialog', { name: 'icsRegenerateConfirmTitle' });
    expect(within(dialog).getByTestId('button-spinner')).toBeInTheDocument();
  });
});
