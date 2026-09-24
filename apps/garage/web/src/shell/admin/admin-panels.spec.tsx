import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { AdminUser, MyProfile, ParkingSpot, ReservationHolder } from '@garage/contract';
import { IntlProvider, todayInPrague } from '@garage/i18n';
import cs from '../../../messages/cs.json';
import { failureWithCode } from '../../testing/contract-failure';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../query/query-client';
import { LOT_ROUTE } from '../../routes';
import { ToastProvider } from '../notifications/toast-provider';
import { AdminDayPanel } from './admin-day-panel';
import { AdminSpotsPanel } from './admin-spots-panel';
import { AdminUsersPanel } from './admin-users-panel';
import { AdminWindowPanel } from './admin-window-panel';
import { AdminLimitsPanel } from './admin-limits-panel';

/**
 * The five connected halves of the administration tabs.
 *
 * The screens are covered exhaustively by their own specs, which hand them
 * props. Everything *between* a screen and the contract is only here: which
 * procedure a control calls, what input it sends, which `AdminWrite` a failure
 * is attributed to, what gets invalidated afterwards, and where `viewerId`
 * comes from. None of that is reachable from a props-driven test, and a wrong
 * answer in any of it is invisible on the screen side — swapping
 * `startWrite('spotRetire', …)` for `'spotRename'` leaves every screen test
 * green and tells an admin their retire was refused for a duplicate label.
 *
 * The seams are stubbed one layer out, not further in: `useApi` returns a fake
 * whose procedures resolve or reject, but the real `QueryClient` with this
 * project's retry policy, and the real screens, all run. So an assertion here
 * is about what an admin would see.
 */

/** The fake `api` the panels are given. Reassigned per test, before render. */
let mockApi: FakeApi;
let mockRouterPush: jest.Mock;
let mockViewer: MyProfile | undefined;

jest.mock('../api-provider/api-provider', () => ({
  useApi: () => mockApi,
}));

jest.mock('@garage/auth/client', () => ({
  useRequireAuth: () => ({ session: null, status: 'authenticated' }),
  useSession: () => ({ data: null, status: 'authenticated' }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

const TIMESTAMP = '2026-08-28T09:15:00.000Z';

// --- the fake API -----------------------------------------------------------

/** One recorded call: which procedure, and exactly what it was sent. */
interface ApiCall {
  readonly procedure: string;
  readonly input: unknown;
}

type Responder = (input: unknown) => unknown;

interface FakeApi {
  readonly me: { readonly get: FakeProcedure };
  readonly spot: { readonly key: () => string[] };
  readonly overview: { readonly key: () => string[]; readonly day: FakeProcedure };
  readonly reservation: { readonly key: () => string[] };
  readonly admin: {
    readonly user: {
      readonly key: () => string[];
      readonly list: FakeProcedure;
      readonly update: FakeProcedure;
    };
    readonly spot: {
      readonly key: () => string[];
      readonly list: FakeProcedure;
      readonly create: FakeProcedure;
      readonly update: FakeProcedure;
      readonly deactivate: FakeProcedure;
    };
    readonly window: {
      readonly key: () => string[];
      readonly months: FakeProcedure;
      readonly update: FakeProcedure;
    };
    readonly reservationLimits: {
      readonly key: () => string[];
      readonly get: FakeProcedure;
      readonly update: FakeProcedure;
    };
    readonly reservation: { readonly key: () => string[] };
  };
}

interface FakeProcedure {
  queryOptions: (options?: { input?: unknown }) => {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
  };
  mutationOptions: () => { mutationFn: (input: unknown) => Promise<unknown> };
}

/**
 * Builds the fake.
 *
 * Query keys are the procedure path spread into an array, so the namespace
 * `key()` a panel passes to `invalidateQueries` is a genuine **prefix** of the
 * keys its queries are stored under — which is what makes "did it invalidate
 * the right thing" observable as a refetch rather than as a spy call.
 */
function makeApi(responders: Record<string, Responder>) {
  const calls: ApiCall[] = [];

  function respond(procedure: string, input: unknown): Promise<unknown> {
    calls.push({ procedure, input });
    const responder = responders[procedure];
    if (responder === undefined) {
      throw new Error(`the panel called ${procedure}, which this test did not stub`);
    }
    return Promise.resolve(responder(input));
  }

  function procedure(name: string): FakeProcedure {
    return {
      queryOptions: (options = {}) => ({
        queryKey: [...name.split('.'), options.input],
        queryFn: () => respond(name, options.input),
      }),
      mutationOptions: () => ({ mutationFn: (input: unknown) => respond(name, input) }),
    };
  }

  const api: FakeApi = {
    me: { get: procedure('me.get') },
    spot: { key: () => ['spot'] },
    overview: { key: () => ['overview'], day: procedure('overview.day') },
    reservation: { key: () => ['reservation'] },
    admin: {
      user: {
        key: () => ['admin', 'user'],
        list: procedure('admin.user.list'),
        update: procedure('admin.user.update'),
      },
      spot: {
        key: () => ['admin', 'spot'],
        list: procedure('admin.spot.list'),
        create: procedure('admin.spot.create'),
        update: procedure('admin.spot.update'),
        deactivate: procedure('admin.spot.deactivate'),
      },
      window: {
        key: () => ['admin', 'window'],
        months: procedure('admin.window.months'),
        update: procedure('admin.window.update'),
      },
      reservationLimits: {
        key: () => ['admin', 'reservationLimits'],
        get: procedure('admin.reservationLimits.get'),
        update: procedure('admin.reservationLimits.update'),
      },
      reservation: { key: () => ['admin', 'reservation'] },
    },
  };

  return {
    api,
    calls,
    /** Every input sent to one procedure, oldest first. */
    inputsTo: (name: string) => calls.filter((call) => call.procedure === name).map((c) => c.input),
    countOf: (name: string) => calls.filter((call) => call.procedure === name).length,
  };
}

function renderPanel(node: ReactNode) {
  render(
    <IntlProvider locale="cs" messages={cs}>
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </IntlProvider>
  );
  return userEvent.setup();
}

// --- fixtures ---------------------------------------------------------------

const VIEWER: MyProfile = {
  id: 'u-viewer',
  name: 'Karel Zíbar',
  email: 'karel@example.com',
  role: 'ADMIN',
  active: true,
  licensePlate: null,
  oktaId: 'okta-viewer',
  preferredParkingSpotId: null,
  icsToken: 'irrelevant',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const OTHER_USER: AdminUser = {
  id: 'u-other',
  name: 'Jana Dvořáková',
  email: 'jana@example.com',
  role: 'USER',
  active: true,
  licensePlate: null,
  oktaId: 'okta-other',
  preferredParkingSpotId: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const VIEWER_ROW: AdminUser = {
  ...OTHER_USER,
  id: VIEWER.id,
  name: VIEWER.name,
  email: VIEWER.email,
  role: 'ADMIN',
};

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

const SPOT = aSpot({ id: 's1', label: 'E2.92' });
const RETIRED = aSpot({ id: 's2', label: 'E2.99', active: false });

/** `overview.day`, with `SPOT` held by somebody and `RETIRED` absent from it. */
const DAY_OVERVIEW = {
  date: todayInPrague(),
  window: {
    month: todayInPrague().slice(0, 7),
    windowFrom: '2026-07-25',
    windowTo: '2026-07-31',
    state: 'OPEN' as const,
    lockMode: 'AUTO' as const,
  },
  canReserve: true,
  viewerReservationId: null,
  spots: [
    {
      spot: SPOT,
      reservation: {
        id: 'r1',
        createdAt: TIMESTAMP,
        holder: {
          kind: 'USER',
          userId: OTHER_USER.id,
          name: OTHER_USER.name,
          licensePlate: '4AB 1234',
        } satisfies ReservationHolder,
      },
      waitlistCount: 0,
      viewerWaitlistEntryId: null,
      viewerWaitlistPosition: null,
      timedReservations: [],
    },
  ],
};

const WINDOW_MONTHS = {
  settings: { openDaysBefore: 7, lockMode: 'AUTO' as const },
  months: [
    {
      month: '2026-08',
      windowFrom: '2026-07-25',
      windowTo: '2026-07-31',
      state: 'LOCKED' as const,
      lockMode: 'AUTO' as const,
    },
  ],
};

beforeEach(() => {
  mockRouterPush = jest.fn();
  mockViewer = VIEWER;
});

// --- the day tab ------------------------------------------------------------

describe('AdminDayPanel', () => {
  it('asks for today in Europe/Prague, and shows what comes back', async () => {
    const fake = makeApi({ 'overview.day': () => DAY_OVERVIEW });
    mockApi = fake.api;

    renderPanel(<AdminDayPanel />);

    expect(await screen.findByText(`dayStatusTaken: name=${OTHER_USER.name}`)).toBeInTheDocument();
    expect(fake.inputsTo('overview.day')).toEqual([{ date: todayInPrague() }]);
  });

  it('sends "Otevřít parkoviště" to the lot screen, not somewhere invented', async () => {
    const fake = makeApi({ 'overview.day': () => DAY_OVERVIEW });
    mockApi = fake.api;

    const user = renderPanel(<AdminDayPanel />);
    await user.click(await screen.findByRole('button', { name: 'dayOpenLot' }));

    expect(mockRouterPush).toHaveBeenCalledWith(LOT_ROUTE);
  });
});

// --- the users tab ----------------------------------------------------------

describe('AdminUsersPanel', () => {
  const listing = () => ({ users: [VIEWER_ROW, OTHER_USER] });

  it('fetches the whole list, unfiltered — the search happens in the browser', async () => {
    const fake = makeApi({ 'admin.user.list': listing, 'me.get': () => mockViewer });
    mockApi = fake.api;

    renderPanel(<AdminUsersPanel />);

    await screen.findByText(OTHER_USER.email);
    expect(fake.inputsTo('admin.user.list')).toEqual([{}]);
  });

  it('takes the viewer’s own id from the profile, which is what protects their row', async () => {
    // The screen decides "this row is mine" from `viewerId`. Its own spec
    // injects that as a prop, so nothing there notices if the panel stops
    // supplying it — and the self-deactivation guard silently disappears.
    const fake = makeApi({ 'admin.user.list': listing, 'me.get': () => mockViewer });
    mockApi = fake.api;

    renderPanel(<AdminUsersPanel />);

    const ownSwitch = await screen.findByRole('switch', {
      name: `usersSelfActiveToggleLabel: name=${VIEWER.name}`,
    });
    expect(ownSwitch).toBeDisabled();

    const otherSwitch = screen.getByRole('switch', {
      name: `usersActiveToggleLabel: name=${OTHER_USER.name}`,
    });
    expect(otherSwitch).toBeEnabled();
  });

  it('sends the role the switch moved to, and refetches the list afterwards', async () => {
    const fake = makeApi({
      'admin.user.list': listing,
      'me.get': () => mockViewer,
      'admin.user.update': () => ({ ...OTHER_USER, role: 'ADMIN' }),
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminUsersPanel />);
    await screen.findByText(OTHER_USER.email);
    const before = fake.countOf('admin.user.list');

    await user.click(
      screen.getByRole('switch', {
        name: `usersAdminToggleLabel: name=${OTHER_USER.name}`,
      })
    );

    await waitFor(() => expect(fake.inputsTo('admin.user.update')).toHaveLength(1));
    expect(fake.inputsTo('admin.user.update')[0]).toEqual({ id: OTHER_USER.id, role: 'ADMIN' });
    // The API is the authority on what a change did — it can refuse the
    // last-admin cases — so the row has to come back from it.
    await waitFor(() => expect(fake.countOf('admin.user.list')).toBeGreaterThan(before));
  });

  it('explains a refused change as the last-admin rule, not as a lost race', async () => {
    const failure = await failureWithCode('CONFLICT');
    const fake = makeApi({
      'admin.user.list': listing,
      'me.get': () => mockViewer,
      'admin.user.update': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminUsersPanel />);
    await screen.findByText(OTHER_USER.email);

    await user.click(
      screen.getByRole('switch', {
        name: `usersAdminToggleLabel: name=${OTHER_USER.name}`,
      })
    );

    expect(await screen.findByText('errUserConflict')).toBeInTheDocument();
  });
});

// --- the spots tab ----------------------------------------------------------

describe('AdminSpotsPanel', () => {
  const listing = () => ({ spots: [SPOT, RETIRED] });

  function spotsApi(extra: Record<string, Responder> = {}) {
    return makeApi({
      'admin.spot.list': listing,
      'overview.day': () => DAY_OVERVIEW,
      ...extra,
    });
  }

  it('asks for retired spots too — this is the screen that revives them', async () => {
    const fake = spotsApi();
    mockApi = fake.api;

    renderPanel(<AdminSpotsPanel />);

    await screen.findByText(RETIRED.label);
    expect(fake.inputsTo('admin.spot.list')).toEqual([{ includeInactive: true }]);
  });

  it('joins today’s overview onto the rows by spot id', async () => {
    const fake = spotsApi();
    mockApi = fake.api;

    renderPanel(<AdminSpotsPanel />);

    const held = within(await findRow(SPOT.id));
    expect(held.getByText(`dayStatusTaken: name=${OTHER_USER.name}`)).toBeInTheDocument();
    // A retired spot is not in the day overview at all, so there is nothing
    // true to say about it — and "Volné" would be a claim.
    const retired = within(await findRow(RETIRED.id));
    expect(retired.getByText('spotsTodayUnknown')).toBeInTheDocument();
  });

  describe('which failure sentence a row switch earns', () => {
    /**
     * The attribution that has no other test. One procedure,
     * `admin.spot.update`, backs three intents whose `CONFLICT` means three
     * different things, and only the caller knows which was asked for.
     */
    async function failSwitch(spot: ParkingSpot) {
      const failure = await failureWithCode('CONFLICT');
      const fake = spotsApi({
        'admin.spot.update': () => {
          throw failure;
        },
      });
      mockApi = fake.api;

      const user = renderPanel(<AdminSpotsPanel />);
      await screen.findByText(spot.label);
      await user.click(
        within(await findRow(spot.id)).getByRole('switch', {
          name: `spotsActiveToggleLabel: label=${spot.label}`,
        })
      );
    }

    it('reads switching a spot off as a live reservation', async () => {
      await failSwitch(SPOT);

      expect(await screen.findByText('spotsDeleteConflict')).toBeInTheDocument();
      expect(screen.queryByText('spotsDuplicateLabel')).not.toBeInTheDocument();
    });

    it('refuses to name a cause for switching one back on', async () => {
      // Reviving collides with nothing, so the honest answer is "it did not
      // save", never a duplicate label and never a live reservation.
      await failSwitch(RETIRED);

      expect(await screen.findByText('errFallbackSpot')).toBeInTheDocument();
      expect(screen.queryByText('spotsDeleteConflict')).not.toBeInTheDocument();
    });
  });

  it('reads a failed category change as a duplicate label', async () => {
    const failure = await failureWithCode('CONFLICT');
    const fake = spotsApi({
      'admin.spot.update': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminSpotsPanel />);
    await screen.findByText(SPOT.label);

    await user.selectOptions(
      within(await findRow(SPOT.id)).getByRole('combobox', {
        name: `spotsGroupSelectLabel: label=${SPOT.label}`,
      }),
      'SHARED'
    );

    expect(await screen.findByText('spotsDuplicateLabel')).toBeInTheDocument();
    // The label is sent unchanged: `admin.spot.update` replaces the fields it
    // is given, so omitting it would be a rename to nothing.
    expect(fake.inputsTo('admin.spot.update')).toEqual([
      { id: SPOT.id, label: SPOT.label, group: 'SHARED' },
    ]);
  });

  it('does not report a later, successful write with an earlier one’s error', async () => {
    // This is the `.reset()` calls, and nothing else.
    //
    // `writeError` reads whichever of the three mutations still holds an error
    // (`deactivateSpot.error ?? updateSpot.error ?? createSpot.error`), so a
    // create that failed keeps poisoning every later write until it is cleared
    // — and the `writeFailure` built from it pairs that stale error with
    // `lastWrite`, which by then names whatever was asked for last. Clearing
    // `lastWrite` cannot help: the next write sets it again, and it is set to
    // the operation that *succeeded*.
    //
    // So: a failed create, abandoned, followed by a retire that the API
    // accepts. Nothing failed, and nothing may be reported.
    const failure = await failureWithCode('CONFLICT');
    const fake = spotsApi({
      'admin.spot.create': () => {
        throw failure;
      },
      'admin.spot.update': () => ({ ...SPOT, active: false }),
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminSpotsPanel />);
    await screen.findByText(SPOT.label);

    await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('spotsLabelField'), 'E2.93');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'spotsSave' }));
    expect(await screen.findByText('spotsDuplicateLabel')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'spotsCancel' })
    );

    await user.click(
      within(await findRow(SPOT.id)).getByRole('switch', {
        name: `spotsActiveToggleLabel: label=${SPOT.label}`,
      })
    );
    await waitFor(() =>
      expect(fake.inputsTo('admin.spot.update')).toEqual([{ id: SPOT.id, active: false }])
    );

    // "Na tomto místě jsou rezervace ode dneška dál." over a retire that
    // worked is the sentence this test exists to keep off the screen.
    expect(screen.queryByText('spotsDeleteConflict')).not.toBeInTheDocument();
    expect(screen.queryByText('spotsDuplicateLabel')).not.toBeInTheDocument();
  });

  it('forgets a failure rather than hiding it, so the same dialog reopens clean', async () => {
    // The cross-dialog case below is caught by `WRITE_ORIGINS` even if nothing
    // is reset, which is precisely why this one exists: create → create is the
    // same surface twice, so only a real `reset()` can clear it.
    const failure = await failureWithCode('CONFLICT');
    const fake = spotsApi({
      'admin.spot.create': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminSpotsPanel />);
    await screen.findByText(SPOT.label);

    await user.click(screen.getByRole('button', { name: 'spotsAdd' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('spotsLabelField'), 'E2.93');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'spotsSave' }));
    expect(await screen.findByText('spotsDuplicateLabel')).toBeInTheDocument();

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'spotsCancel' })
    );
    await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

    expect(screen.queryByText('spotsDuplicateLabel')).not.toBeInTheDocument();
  });

  it('forgets a failure when the admin opens a dialog', async () => {
    // The panel half of the same guard `admin-spots-screen.spec.tsx` pins:
    // `onDiscardFailure` has to actually reset the mutations, or the sentence
    // survives in TanStack's state and reappears under the next dialog.
    const failure = await failureWithCode('CONFLICT');
    const fake = spotsApi({
      'admin.spot.update': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminSpotsPanel />);
    await screen.findByText(SPOT.label);
    await user.click(
      within(await findRow(SPOT.id)).getByRole('switch', {
        name: `spotsActiveToggleLabel: label=${SPOT.label}`,
      })
    );
    expect(await screen.findByText('spotsDeleteConflict')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'spotsAdd' }));

    expect(screen.queryByText('spotsDeleteConflict')).not.toBeInTheDocument();
  });

  it('refetches the table and today’s overview after a spot is retired', async () => {
    const fake = spotsApi({ 'admin.spot.deactivate': () => ({ ...SPOT, active: false }) });
    mockApi = fake.api;

    const user = renderPanel(<AdminSpotsPanel />);
    await screen.findByText(SPOT.label);
    const spotsBefore = fake.countOf('admin.spot.list');
    const dayBefore = fake.countOf('overview.day');

    await user.click(within(await findRow(SPOT.id)).getByRole('button', { name: 'spotsDelete' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'spotsDeleteConfirm' })
    );

    await waitFor(() => expect(fake.inputsTo('admin.spot.deactivate')).toEqual([{ id: SPOT.id }]));
    await waitFor(() => expect(fake.countOf('admin.spot.list')).toBeGreaterThan(spotsBefore));
    // The lot loses a cell when a spot is retired, so its own view is stale too.
    await waitFor(() => expect(fake.countOf('overview.day')).toBeGreaterThan(dayBefore));
  });
});

// --- the reservation window tab --------------------------------------------

describe('AdminWindowPanel', () => {
  it('feeds both cards from one call, over the four months the design lists', async () => {
    const fake = makeApi({ 'admin.window.months': () => WINDOW_MONTHS });
    mockApi = fake.api;

    renderPanel(<AdminWindowPanel />);

    await screen.findByText('srpen 2026');
    const [input] = fake.inputsTo('admin.window.months') as [{ from: string; to: string }];
    const month = Number(input.from.slice(5, 7));
    const span =
      Number(input.to.slice(5, 7)) -
      month +
      (Number(input.to.slice(0, 4)) - Number(input.from.slice(0, 4))) * 12;
    expect(input.from).toBe(todayInPrague().slice(0, 7));
    expect(span).toBe(3);
    // Both cards, one request: the stepper's value comes from the same response
    // as the month rows, so the form and the list cannot disagree.
    expect(screen.getByText('windowDaysValue: count=7')).toBeInTheDocument();
  });

  it('sends both fields on a change, because the contract replaces rather than patches', async () => {
    const fake = makeApi({
      'admin.window.months': () => WINDOW_MONTHS,
      'admin.window.update': () => WINDOW_MONTHS.settings,
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminWindowPanel />);
    await screen.findByText('windowDaysValue: count=7');

    await user.click(screen.getByRole('radio', { name: 'windowLockFORCE_OPEN' }));

    await waitFor(() =>
      expect(fake.inputsTo('admin.window.update')).toEqual([
        { openDaysBefore: 7, lockMode: 'FORCE_OPEN' },
      ])
    );
  });

  it('does not confirm a save that is still in flight', async () => {
    // "Uloženo" is a statement about the past. Moving it to the start of the
    // request would print it while the API is still deciding — and while the
    // API can still refuse.
    let settle: () => void = () => undefined;
    const fake = makeApi({
      'admin.window.months': () => WINDOW_MONTHS,
      'admin.window.update': () =>
        new Promise((resolve) => {
          settle = () => resolve(WINDOW_MONTHS.settings);
        }),
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminWindowPanel />);
    await screen.findByText('windowDaysValue: count=7');

    await user.click(screen.getByRole('radio', { name: 'windowLockFORCE_OPEN' }));
    await waitFor(() => expect(fake.inputsTo('admin.window.update')).toHaveLength(1));

    expect(screen.queryByText('windowSaved')).not.toBeInTheDocument();

    await act(async () => {
      settle();
    });

    expect(await screen.findByText('windowSaved')).toBeInTheDocument();
  });

  it('confirms a save only once it has actually happened, and refetches the months', async () => {
    const fake = makeApi({
      'admin.window.months': () => WINDOW_MONTHS,
      'admin.window.update': () => WINDOW_MONTHS.settings,
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminWindowPanel />);
    await screen.findByText('windowDaysValue: count=7');
    const before = fake.countOf('admin.window.months');
    expect(screen.queryByText('windowSaved')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'windowLockFORCE_OPEN' }));

    expect(await screen.findByText('windowSaved')).toBeInTheDocument();
    await waitFor(() => expect(fake.countOf('admin.window.months')).toBeGreaterThan(before));
  });

  it('explains a refused save rather than confirming it', async () => {
    const failure = await failureWithCode('VALIDATION_FAILED');
    const fake = makeApi({
      'admin.window.months': () => WINDOW_MONTHS,
      'admin.window.update': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const user = renderPanel(<AdminWindowPanel />);
    await screen.findByText('windowDaysValue: count=7');

    await user.click(screen.getByRole('radio', { name: 'windowLockFORCE_LOCKED' }));

    expect(await screen.findByText('errWindowValidation')).toBeInTheDocument();
    expect(screen.queryByText('windowSaved')).not.toBeInTheDocument();
  });
});

// --- the reservation limits tab ---------------------------------------------

/**
 * Renders the panel with its own `QueryClient`, exposed so a test can spy on
 * `invalidateQueries` directly — the window panel's tests infer invalidation
 * from an observable refetch, but nothing here subscribes to
 * `reservation.key()`/`admin.reservation.key()` (no other panel is mounted
 * alongside this one), so there is no refetch to observe. The panel's own
 * query still refetches, as `renderPanel`'s tests would show it doing.
 */
function renderLimitsPanel() {
  const client = createQueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  render(
    <IntlProvider locale="cs" messages={cs}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <AdminLimitsPanel />
        </ToastProvider>
      </QueryClientProvider>
    </IntlProvider>
  );
  return { user: userEvent.setup(), invalidate };
}

describe('AdminLimitsPanel', () => {
  it('renders the stored cap', async () => {
    const fake = makeApi({
      'admin.reservationLimits.get': () => ({ monthlyReservationCap: 7 }),
    });
    mockApi = fake.api;

    renderLimitsPanel();

    expect(await screen.findByText('limitsCapValue: count=7')).toBeInTheDocument();
  });

  it('sends the new cap to admin.reservationLimits.update, and invalidates the month summaries too', async () => {
    const fake = makeApi({
      'admin.reservationLimits.get': () => ({ monthlyReservationCap: 7 }),
      'admin.reservationLimits.update': () => ({ monthlyReservationCap: 8 }),
    });
    mockApi = fake.api;

    const { user, invalidate } = renderLimitsPanel();
    await screen.findByText('limitsCapValue: count=7');

    await user.click(screen.getByRole('button', { name: 'limitsCapIncrement' }));

    await waitFor(() =>
      expect(fake.inputsTo('admin.reservationLimits.update')).toEqual([
        { monthlyReservationCap: 8 },
      ])
    );
    expect(await screen.findByText('limitsSaved')).toBeInTheDocument();

    // Every month summary carries the cap, and the bulk modal's greyed-out
    // cells are derived from it, so all three are stale the moment it changes
    // — not just the panel's own query.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'reservationLimits'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reservation'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'reservation'] });
  });

  it('explains a refused save rather than confirming it', async () => {
    const failure = await failureWithCode('VALIDATION_FAILED');
    const fake = makeApi({
      'admin.reservationLimits.get': () => ({ monthlyReservationCap: 7 }),
      'admin.reservationLimits.update': () => {
        throw failure;
      },
    });
    mockApi = fake.api;

    const { user } = renderLimitsPanel();
    await screen.findByText('limitsCapValue: count=7');

    await user.click(screen.getByRole('button', { name: 'limitsCapIncrement' }));

    expect(await screen.findByText('errLimitsValidation')).toBeInTheDocument();
    expect(screen.queryByText('limitsSaved')).not.toBeInTheDocument();
  });
});

/** The `<tr>` `DataTable` stamps with a row id, once it has been rendered. */
async function findRow(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector(`[data-row-id="${id}"]`);
    if (!(row instanceof HTMLElement)) {
      throw new Error(`no row rendered for ${id}`);
    }
    return row;
  });
}
