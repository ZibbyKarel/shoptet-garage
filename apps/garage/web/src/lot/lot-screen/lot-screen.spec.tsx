import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiQueryUtils } from '@garage/api-client';
import { createQueryClient } from '../../shell/query/query-client';
import { createDateFormatters } from '@garage/i18n';
import type { AdminUser, DayOverviewOutput, DaySpotOverview, MyProfile } from '@garage/contract';
import { profile, T0 } from '../../testing/fixtures';
import { failureWithCode } from '../../testing/contract-failure';
import { createProviderWrapper } from '../../testing/providers';
import { LotScreen } from './lot-screen';

const cs = createDateFormatters('cs');

/**
 * The connected half of the screen — Task 24's fix round, Important-1.
 *
 * `lot-view.ts`, `day-overview-cache.ts`, `use-cell-locks.ts` and
 * `use-lot-realtime.ts` all have their own suites and are exercised for real
 * here, unmocked. What this file adds is what only exists in `lot-screen.tsx`
 * itself and nowhere else: the session gate on the day query, `showBulk`
 * reading `canReserve` rather than re-deriving it, the four mutations all
 * closing the dialog and invalidating the day the same way, the lookup that
 * turns an open spot back into a reservation id, `withMonth`/`withYear`'s date
 * arithmetic, and the loading/error/empty branches.
 *
 * Doubled at the wrapper boundary, same as `use-lot-realtime.spec.tsx`:
 * `@garage/api-client` (so `ApiProvider` needs no live transport) and
 * `@garage/auth/client` / `@garage/realtime-client` (so no session and
 * no socket are required). The real `QueryClient` is used, for the same reason it
 * is real there — a stubbed client would let a wrong query key pass unnoticed.
 * `@garage/i18n` is real except for `todayInPrague`, pinned so the initial
 * day is deterministic without touching the system clock.
 */

const FIXED_TODAY = '2026-01-31';

jest.mock('@garage/i18n', () => {
  const actual = jest.requireActual('@garage/i18n');
  return { ...actual, todayInPrague: () => '2026-01-31' };
});

/**
 * `useDateInUrl` (`use-date-in-url.ts`) reads/writes the `date` query param —
 * doubled here the same way as everywhere else in this file: no router exists
 * in a unit test, and this suite's own day-navigation assertions only care
 * that `date` state moves, not that the URL replace call happened (that's
 * `use-date-in-url.spec.ts`'s job).
 */
const routerReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(''),
}));

let sessionStatusValue: 'authenticated' | 'unauthenticated' | 'loading' = 'authenticated';
function currentSessionStatus() {
  return sessionStatusValue;
}

jest.mock('@garage/auth/client', () => ({
  // A stable function reference, not `() => async () => 'irrelevant'` — that
  // form hands `ApiProvider` a *new* function every render, which keeps its
  // `useMemo([url, getAccessToken])` from ever settling and defeats any
  // assertion that depends on `api`'s identity staying put across a rerender
  // (`doc/decision/0141-*`). Same fix as `api-provider.spec.tsx`.
  useAccessTokenProvider: () => mockGetAccessToken,
  useSession: () => ({ status: currentSessionStatus() }),
}));

const mockGetAccessToken = async () => 'irrelevant';

const useCellLockMock = jest.fn();
function callUseCellLockMock(options: unknown) {
  return useCellLockMock(options);
}

/**
 * The connection status the screen sees, and the `reconnect` it is handed.
 * Module-level rather than a prop for the same reason as in
 * `use-lot-realtime.spec.tsx`: the real `useRealtime()` reads a context the
 * provider owns, so a status change is something that happens *to* this
 * screen.
 */
type MockRealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'rejected';
let realtimeStatusValue: MockRealtimeStatus = 'connected';
const reconnectMock = jest.fn();
function currentRealtime() {
  return { status: realtimeStatusValue, reconnect: reconnectMock };
}

jest.mock('@garage/realtime-client', () => ({
  // Room-joining and raw events are `use-lot-realtime.spec.tsx` and
  // `use-cell-locks.spec.tsx`'s to cover; this suite only needs the calls to
  // exist and do nothing, so `jest.fn()` stands in rather than an
  // `@typescript-eslint/no-empty-function`-tripping empty arrow.
  useDayRoom: jest.fn(),
  useRealtime: () => currentRealtime(),
  useRealtimeEvent: jest.fn(),
  useCellLock: (options: unknown) => callUseCellLockMock(options),
}));

/**
 * One stable set of jest.fn()s, referenced by both the mocked
 * `@garage/api-client` and this file's own key derivation — unlike
 * `use-lot-realtime.spec.tsx`'s per-call `mockApiClient()`, this suite asserts
 * *call counts and arguments*, so the functions the screen calls and the ones
 * a test inspects must be the same objects.
 */
const apiMocks = {
  overviewDay: jest.fn(),
  reservationCreate: jest.fn(),
  reservationCancel: jest.fn(),
  waitlistJoin: jest.fn(),
  waitlistLeave: jest.fn(),
  meGet: jest.fn(),
  spotList: jest.fn(),
  previewBulk: jest.fn(),
  confirmBulk: jest.fn(),
  myMonth: jest.fn(),
  adminUserList: jest.fn(),
  adminReservationMonth: jest.fn(),
  timedReservationCreate: jest.fn(),
  timedReservationCancel: jest.fn(),
};

function buildClient() {
  return {
    overview: { day: apiMocks.overviewDay },
    reservation: {
      create: apiMocks.reservationCreate,
      cancel: apiMocks.reservationCancel,
      previewBulk: apiMocks.previewBulk,
      confirmBulk: apiMocks.confirmBulk,
      myMonth: apiMocks.myMonth,
    },
    waitlist: { join: apiMocks.waitlistJoin, leave: apiMocks.waitlistLeave },
    me: { get: apiMocks.meGet },
    spot: { list: apiMocks.spotList },
    admin: {
      user: { list: apiMocks.adminUserList },
      reservation: { month: apiMocks.adminReservationMonth },
      timedReservation: {
        create: apiMocks.timedReservationCreate,
        cancel: apiMocks.timedReservationCancel,
      },
    },
  };
}

jest.mock('@garage/api-client', () => ({
  ...jest.requireActual('@garage/api-client'),
  createApiClient: () => buildClient(),
}));

const DATE = FIXED_TODAY;
const VIEWER = 'user-viewer';
const OTHER_USER = 'user-other';

function dayKey(date: string) {
  return createApiQueryUtils(buildClient() as never).overview.day.queryOptions({
    input: { date },
  }).queryKey;
}

function meKey() {
  return createApiQueryUtils(buildClient() as never).me.get.queryOptions().queryKey;
}

function myMonthKey(month: string) {
  return createApiQueryUtils(buildClient() as never).reservation.myMonth.queryOptions({
    input: { month },
  }).queryKey;
}

function holderMonthBranchKey() {
  return createApiQueryUtils(buildClient() as never).admin.reservation.month.key();
}

function freeSpot(overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id: 'spot-free',
      label: 'E2.93',
      group: 'IT',
      active: true,
      createdAt: T0,
      updatedAt: T0,
    },
    reservation: null,
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
    ...overrides,
  };
}

function takenSpot(overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id: 'spot-taken',
      label: 'E2.92',
      group: 'IT',
      active: true,
      createdAt: T0,
      updatedAt: T0,
    },
    reservation: {
      id: 'res-other',
      createdAt: T0,
      holder: { kind: 'USER', userId: OTHER_USER, name: 'Petr Novák', licensePlate: '8SC 9012' },
    },
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
    ...overrides,
  };
}

/** No full-day holder, but one or more guest blocks — `toSpotView`'s `'timed'` appearance. */
function timedSpot(overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id: 'spot-timed',
      label: 'E2.95',
      group: 'IT',
      active: true,
      createdAt: T0,
      updatedAt: T0,
    },
    reservation: null,
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [
      {
        id: 'block-1',
        startTime: '09:00',
        endTime: '10:30',
        guestName: 'Jan Host',
        licensePlate: null,
        createdAt: T0,
      },
    ],
    ...overrides,
  };
}

function mineSpot(overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id: 'spot-mine',
      label: 'E2.94',
      group: 'IT',
      active: true,
      createdAt: T0,
      updatedAt: T0,
    },
    reservation: {
      id: 'res-mine',
      createdAt: T0,
      holder: { kind: 'USER', userId: VIEWER, name: 'Karel Zíbar', licensePlate: '4AB 1234' },
    },
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
    ...overrides,
  };
}

function dayOverview(overrides: Partial<DayOverviewOutput> = {}): DayOverviewOutput {
  return {
    date: DATE,
    window: {
      month: '2026-01',
      windowFrom: '2025-12-25',
      windowTo: '2025-12-31',
      state: 'OPEN',
      lockMode: 'AUTO',
    },
    canReserve: true,
    canReserveMonth: true,
    spots: [freeSpot(), takenSpot(), mineSpot()],
    // Not `'res-mine'` by default, even though `mineSpot()` is in `spots`:
    // most tests here exercise reserving `freeSpot`/queueing `takenSpot` and
    // are not about the "viewer already holds a reservation elsewhere" rule,
    // which would otherwise block both. Tests for that rule (and for `mine`'s
    // own cancel flow, which reads the row's holder, not this field) set it
    // explicitly.
    viewerReservationId: null,
    ...overrides,
  };
}

function setup(
  options: {
    sessionStatus?: 'authenticated' | 'unauthenticated' | 'loading';
    profile?: MyProfile;
    day?: DayOverviewOutput | null;
    seedDay?: boolean;
    dayImpl?: () => Promise<DayOverviewOutput>;
    realtimeStatus?: MockRealtimeStatus;
    /** Only fetched by an admin; overrides the empty-list default. */
    adminUsers?: readonly AdminUser[];
    /** Overrides the resolved default, for pending/error states. */
    adminUsersImpl?: () => Promise<{ users: readonly AdminUser[] }>;
  } = {}
) {
  Object.values(apiMocks).forEach((fn) => {
    fn.mockReset();
  });
  useCellLockMock.mockReset();
  reconnectMock.mockReset();
  routerReplace.mockReset();
  // `connected` is the resting state; a screen that has never connected is a
  // separate case, exercised by its own test below.
  realtimeStatusValue = options.realtimeStatus ?? 'connected';
  apiMocks.reservationCreate.mockResolvedValue(undefined);
  apiMocks.reservationCancel.mockResolvedValue(undefined);
  apiMocks.waitlistJoin.mockResolvedValue(undefined);
  apiMocks.waitlistLeave.mockResolvedValue(undefined);
  apiMocks.timedReservationCreate.mockResolvedValue(undefined);
  apiMocks.timedReservationCancel.mockResolvedValue(undefined);
  // The bulk modal reads the spot list for its preferred-spot label. Its own
  // behaviour is `bulk-modal.spec.tsx`'s; here it only has to not fail.
  apiMocks.spotList.mockResolvedValue({ spots: [] });
  // Same for the viewer's monthly reservation summary — the cap and the
  // reserved-day highlight are `bulk-modal.spec.tsx`'s concern, not this
  // file's; here the query only has to resolve.
  apiMocks.myMonth.mockResolvedValue({ month: '2026-09', reservedDates: [], count: 0 });
  // Same for the admin-only holder-month query the bulk modal fires when
  // booking for somebody else — its behaviour is also `bulk-modal.spec.tsx`'s
  // concern; here it only has to resolve so the modal (rendered unconditionally
  // by `LotScreen`) does not hang on a pending query.
  apiMocks.adminReservationMonth.mockResolvedValue({
    month: '2026-09',
    reservedDates: [],
    count: 0,
  });
  // Only fetched by an admin (`holderQuery`'s `enabled`), but harmless to seed
  // unconditionally — a case that cares about its contents passes `adminUsers`.
  if (options.adminUsersImpl) {
    apiMocks.adminUserList.mockImplementation(options.adminUsersImpl);
  } else {
    apiMocks.adminUserList.mockResolvedValue({ users: options.adminUsers ?? [] });
  }

  sessionStatusValue = options.sessionStatus ?? 'authenticated';

  const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  const person = options.profile ?? profile();
  client.setQueryData(meKey(), person);
  apiMocks.meGet.mockResolvedValue(person);

  const shouldSeed = options.seedDay ?? options.day !== null;
  const day = options.day === undefined ? dayOverview() : options.day;

  if (options.dayImpl) {
    apiMocks.overviewDay.mockImplementation(options.dayImpl);
  } else if (shouldSeed && day !== null) {
    apiMocks.overviewDay.mockResolvedValue(day);
  } else {
    // Never resolves — the loading/gate tests need `isPending` to stay true
    // rather than flip to `isError` on an unmocked `undefined` return. An
    // expression-bodied arrow (rather than `() => {}`) so the executor that
    // deliberately does nothing with `resolve`/`reject` isn't an empty block
    // `@typescript-eslint/no-empty-function` would flag.
    apiMocks.overviewDay.mockReturnValue(new Promise(() => undefined));
  }

  if (shouldSeed && day !== null) {
    client.setQueryData(dayKey(DATE), day);
  }

  const invalidate = jest.spyOn(client, 'invalidateQueries');

  const Wrapper = createProviderWrapper(client);

  const utils = render(<LotScreen />, { wrapper: Wrapper });

  return { ...utils, client, invalidate, user: userEvent.setup() };
}

describe('LotScreen — the session gate on the day query', () => {
  /**
   * This used to also assert `screen.getByRole('status')` reads "Načítá se…"
   * for an `unauthenticated` session — i.e. it pinned the spinner as the
   * **resting** state for a session that had ended, which is the dead end the
   * final review caught: no redirect, no `signIn()`, no message, forever.
   *
   * The gate itself is right and stays: firing before the session exists
   * spends a request the API answers 401, and a 401 is not retried. What is
   * wrong is treating the spinner as an outcome. Nothing on this screen
   * recovers a lost session and nothing on it should — `AppTopBar`, which the
   * `(app)` layout renders above every signed-in route, calls `useRequireAuth`
   * and navigates away. That is asserted in `app/(app)/layout.spec.tsx`, where
   * the guard actually lives; asserting the spinner here as well would pin the
   * old behaviour back in from a second file.
   */
  it('does not fetch the day before the session exists', () => {
    setup({ sessionStatus: 'unauthenticated', seedDay: false });

    expect(apiMocks.overviewDay).not.toHaveBeenCalled();
  });

  it('fires the day query once the session exists, without a remount', async () => {
    const { rerender } = setup({ sessionStatus: 'unauthenticated', seedDay: false });
    expect(apiMocks.overviewDay).not.toHaveBeenCalled();

    sessionStatusValue = 'authenticated';
    rerender(<LotScreen />);

    await waitFor(() => expect(apiMocks.overviewDay).toHaveBeenCalledTimes(1));
  });
});

describe('LotScreen — loading, error and empty', () => {
  it('shows the loading state while the day has not arrived', () => {
    setup({ seedDay: false });
    expect(screen.getByRole('status')).toHaveTextContent('loading');
  });

  it('shows a retry-capable error, and retry goes through the same query', async () => {
    const { user } = setup({ seedDay: false, dayImpl: () => Promise.reject(new Error('boom')) });

    await screen.findByRole('button', { name: 'retry' });
    expect(screen.getByText('errorUnknown')).toBeInTheDocument();

    apiMocks.overviewDay.mockImplementation(() => Promise.resolve(dayOverview()));
    await user.click(screen.getByRole('button', { name: 'retry' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u })
      ).toBeInTheDocument()
    );
  });

  it('shows the empty state when the lot has no active spots', () => {
    setup({ day: dayOverview({ spots: [] }) });
    expect(screen.getByText('emptyTitle')).toBeInTheDocument();
  });
});

describe('LotScreen — the bulk modal', () => {
  it('opens on the header button, anchored to the day on screen', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: 'bulkReservation' }));

    expect(await screen.findByRole('dialog', { name: 'title' })).toBeInTheDocument();
    // The month of `FIXED_TODAY` (2026-01-31), in the locative — proof the
    // grid is anchored to the screen's day rather than to "now".
    expect(screen.getByText(/description: month=/)).toBeInTheDocument();
  });

  it('hands the modal the backend’s own canReserveMonth, so a window closing under it is refused', async () => {
    // Hiding the header button covers "do not invite this"; it cannot cover a
    // window that closes while the modal is already open, and this is the
    // wiring that does (`doc/decision/0173-*`). A modal handed a hard-coded
    // `true` would keep offering the flow here.
    const { user, client } = setup();

    await user.click(screen.getByRole('button', { name: 'bulkReservation' }));
    expect(await screen.findByRole('dialog', { name: 'title' })).toBeInTheDocument();

    act(() => {
      client.setQueryData(dayKey(DATE), dayOverview({ canReserveMonth: false }));
    });

    expect(await screen.findByRole('dialog', { name: 'lockedTitle' })).toBeInTheDocument();
  });

  it('offers bulk reservation on a day that is itself unbookable, when the month is open', async () => {
    // `canReserve` is per-day: a weekend, a Czech holiday and any past day all
    // make it false while leaving the month wide open. Reading it here switched
    // the feature off on roughly a third of the calendar — including 28
    // September 2026, the holiday the design's own screenshot shows the modal
    // open on (`doc/decision/0175-*`).
    const { user } = setup({
      day: dayOverview({ canReserve: false, canReserveMonth: true }),
    });

    await user.click(screen.getByRole('button', { name: 'bulkReservation' }));

    expect(await screen.findByRole('dialog', { name: 'title' })).toBeInTheDocument();
  });

  it('closes again when the day changes', async () => {
    // The selection belongs to one month; carrying it across a day change
    // would be a batch the contract refuses.
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: 'bulkReservation' }));
    expect(await screen.findByRole('dialog', { name: 'title' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'nextDay' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'title' })).not.toBeInTheDocument()
    );
  });
});

describe('LotScreen — showBulk reads canReserveMonth, not the window state and not canReserve', () => {
  it('shows the button when canReserveMonth is true', () => {
    setup({ day: dayOverview({ canReserveMonth: true }) });
    expect(screen.getByRole('button', { name: 'bulkReservation' })).toBeInTheDocument();
  });

  it('hides the button when canReserveMonth is false, even though the window is OPEN', () => {
    // The exact re-derivation the review names as a live hazard: reading
    // `window.state === 'OPEN'` instead of the backend's answer would get this
    // wrong, because an admin is not bound by the window at all.
    setup({
      day: dayOverview({
        canReserve: false,
        canReserveMonth: false,
        window: {
          month: '2026-01',
          windowFrom: '2025-12-25',
          windowTo: '2025-12-31',
          state: 'OPEN',
          lockMode: 'AUTO',
        },
      }),
    });
    expect(screen.queryByRole('button', { name: 'bulkReservation' })).not.toBeInTheDocument();
  });

  it('keeps the button on a weekend or holiday of an open month, where canReserve is false', () => {
    setup({ day: dayOverview({ canReserve: false, canReserveMonth: true }) });
    expect(screen.getByRole('button', { name: 'bulkReservation' })).toBeInTheDocument();
  });
});

describe('LotScreen — every write closes the dialog and invalidates the day', () => {
  it('reserving a free spot', async () => {
    const { user, invalidate } = setup();

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(apiMocks.reservationCreate.mock.calls[0]?.[0]).toEqual({
        parkingSpotId: 'spot-free',
        date: DATE,
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dayKey(DATE) }));
  });

  it('explains rather than reserving a free spot when the viewer already holds a reservation elsewhere that day', async () => {
    const { user } = setup({ day: dayOverview({ viewerReservationId: 'res-mine' }) });

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));

    expect(
      await screen.findByRole('heading', { name: 'titleInfoAlreadyReserved' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaReserve' })).not.toBeInTheDocument();
    expect(apiMocks.reservationCreate).not.toHaveBeenCalled();
  });

  it('explains rather than queueing on a taken spot when the viewer already holds a reservation elsewhere that day', async () => {
    const { user } = setup({ day: dayOverview({ viewerReservationId: 'res-mine' }) });

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));

    expect(
      await screen.findByRole('heading', { name: 'titleInfoAlreadyReserved' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaQueue' })).not.toBeInTheDocument();
    expect(apiMocks.waitlistJoin).not.toHaveBeenCalled();
  });

  it('joining the waitlist on a spot somebody else holds', async () => {
    const { user, invalidate } = setup();

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaQueue' }));

    await waitFor(() =>
      expect(apiMocks.waitlistJoin.mock.calls[0]?.[0]).toEqual({
        parkingSpotId: 'spot-taken',
        date: DATE,
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dayKey(DATE) }));
  });

  it('leaving a queue the caller is already in', async () => {
    const { user, invalidate } = setup({
      day: dayOverview({
        spots: [
          freeSpot(),
          takenSpot({ viewerWaitlistEntryId: 'entry-1', viewerWaitlistPosition: 2 }),
          mineSpot(),
        ],
      }),
    });

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));
    await user.click(await screen.findByRole('button', { name: 'leaveQueue' }));

    await waitFor(() =>
      expect(apiMocks.waitlistLeave.mock.calls[0]?.[0]).toEqual({ waitlistEntryId: 'entry-1' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dayKey(DATE) }));
  });

  it('an admin booking a guest time block on a timed spot', async () => {
    const { user, invalidate } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot(), takenSpot(), mineSpot(), timedSpot()] }),
    });

    await user.click(screen.getByRole('button', { name: /^tileTimedLabel: label=E2\.95,/u }));
    await user.type(await screen.findByLabelText('guestNameField'), 'Petr Nový');
    await user.selectOptions(screen.getByLabelText('startTimeField'), '11:00');
    await user.selectOptions(screen.getByLabelText('endTimeField'), '11:30');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(apiMocks.timedReservationCreate.mock.calls[0]?.[0]).toEqual({
        parkingSpotId: 'spot-timed',
        date: DATE,
        guestName: 'Petr Nový',
        licensePlate: null,
        startTime: '11:00',
        endTime: '11:30',
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dayKey(DATE) }));
  });

  it('an admin cancelling a guest block leaves the dialog open, and still invalidates the day', async () => {
    const { user, invalidate } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot(), takenSpot(), mineSpot(), timedSpot()] }),
    });

    await user.click(screen.getByRole('button', { name: /^tileTimedLabel: label=E2\.95,/u }));
    await user.click(await screen.findByRole('button', { name: 'timedBlockCancel' }));

    await waitFor(() =>
      expect(apiMocks.timedReservationCancel.mock.calls[0]?.[0]).toEqual({
        timedReservationId: 'block-1',
      })
    );
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dayKey(DATE) }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a create failure on a guest time block behaves like any other create failure', async () => {
    const { user, invalidate } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot(), takenSpot(), mineSpot(), timedSpot()] }),
    });
    apiMocks.timedReservationCreate.mockRejectedValue(
      await failureWithCode('SPOT_ALREADY_RESERVED')
    );

    await user.click(screen.getByRole('button', { name: /^tileTimedLabel: label=E2\.95,/u }));
    await user.type(await screen.findByLabelText('guestNameField'), 'Petr Nový');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(await screen.findByText('SPOT_ALREADY_RESERVED')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates reservation.myMonth for the day’s month too (I6)', async () => {
    // Otherwise cancelling/creating here and then opening the bulk modal for
    // the same month can show a stale cap/highlight state, because nothing
    // else in this screen's own write paths ever invalidates that query.
    const { user, invalidate } = setup();

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: myMonthKey('2026-01') })
      )
    );
  });

  it('invalidates the holder-scoped month summaries too, since the write may have been for somebody else', async () => {
    // This screen's writes can name a holder (`SpotDialog`'s own form), and
    // this callback never learns which — so the branch key, not an exact one.
    // Without it, an admin reserving for a colleague here and then opening the
    // bulk modal shows that colleague's budget from before the write.
    const { user, invalidate } = setup();

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: holderMonthBranchKey() })
      )
    );
  });

  it('does not close the dialog, or invalidate, when a write fails', async () => {
    const { user, invalidate } = setup();
    // After `setup()`, which is what resets and re-arms every mock — setting
    // this up first would just be discarded by `setup()`'s own reset.
    apiMocks.reservationCreate.mockRejectedValue(new Error('boom'));

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    await waitFor(() => expect(apiMocks.reservationCreate).toHaveBeenCalled());
    // onError, not onSettled: the dialog stays open so the caller can see why.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('shows the plain self-facing copy — never the holder-scoped one — when a self-booking create hits RESERVATION_LIMIT_REACHED', async () => {
    const { user } = setup();
    apiMocks.reservationCreate.mockRejectedValue(
      await failureWithCode('RESERVATION_LIMIT_REACHED')
    );

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    expect(await screen.findByText('RESERVATION_LIMIT_REACHED')).toBeInTheDocument();
    expect(screen.queryByText('errHolderLimitReached')).not.toBeInTheDocument();
  });

  it('shows the plain self-facing copy — never the holder-scoped one — when waitlist.join hits RESERVATION_LIMIT_REACHED', async () => {
    // The regression this fix exists for: the caller themselves is the one
    // already holding a bay that day, so the sweep's "this user already has a
    // reservation" phrasing would read as being about the spot's holder, not
    // about the reader — the reader would never realise *they* must cancel
    // their own reservation first. This must render byte-identical to what a
    // normal user has always seen.
    const { user } = setup();
    apiMocks.waitlistJoin.mockRejectedValue(await failureWithCode('RESERVATION_LIMIT_REACHED'));

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaQueue' }));

    expect(await screen.findByText('RESERVATION_LIMIT_REACHED')).toBeInTheDocument();
    expect(screen.queryByText('errHolderLimitReached')).not.toBeInTheDocument();
  });

  it('does not carry a holder-scoped message over from an earlier failed create into a later waitlist.join failure', async () => {
    // Not the byte-identical assertion above — this one carries state across
    // two dialogs. An admin first fails a named-holder create (which *does*
    // set the holder-scoped message), closes that dialog, then opens a
    // different spot and fails to join its waitlist: `holderLimitMessage`
    // must not have survived the trip.
    //
    // What this pins, measured rather than assumed: the clears in
    // `closeDialog` and `openDialog`. Removing the one in `onWriteError`
    // instead leaves all 686 tests green, and that is not a gap in this test —
    // a single dialog is either a free bay offering Rezervovat or a taken one
    // offering the queue, never both, so a create failure followed by a
    // waitlist failure *without* closing is unreachable. That clear is
    // defence-in-depth against a future dialog that offers both, and there is
    // deliberately no test asserting it.
    const other: AdminUser = {
      id: OTHER_USER,
      email: 'jana@firma.cz',
      name: 'Jana Nováková',
      licensePlate: null,
      role: 'USER',
      oktaId: 'okta-2',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };
    // The admin themselves, alongside `other` — needed since the queue-target
    // form now defaults to the first eligible option when the viewer isn't
    // among them (see `defaultQueueTargetId`), and this test's second half
    // relies on "Přidat se do fronty" joining the admin themselves, not
    // `other`.
    const self: AdminUser = {
      id: VIEWER,
      email: 'karel.zibar@firma.cz',
      name: 'Karel Zíbar',
      licensePlate: '4AB 1234',
      role: 'ADMIN',
      oktaId: 'okta-1',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      adminUsers: [self, other],
    });
    apiMocks.reservationCreate.mockRejectedValue(
      await failureWithCode('RESERVATION_LIMIT_REACHED')
    );

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));
    await user.selectOptions(await screen.findByLabelText('holderField'), OTHER_USER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));
    expect(await screen.findByText('errHolderLimitReached')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'close' }));
    apiMocks.waitlistJoin.mockRejectedValue(await failureWithCode('RESERVATION_LIMIT_REACHED'));

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));
    await user.click(await screen.findByRole('button', { name: 'ctaQueue' }));

    expect(await screen.findByText('RESERVATION_LIMIT_REACHED')).toBeInTheDocument();
    expect(screen.queryByText('errHolderLimitReached')).not.toBeInTheDocument();
  });

  it('invalidates the day now on screen, not the one it left, after a day change', async () => {
    const NEXT_DATE = '2026-02-02';
    const { user, invalidate } = setup();
    // `overview.day` has to answer for whichever date is actually on screen
    // once the day changes, or the screen would be stuck loading — set
    // directly on the mock (rather than through `setup()`'s single-date
    // `dayImpl`, typed as a zero-argument function) so it can follow the
    // input it was actually called with.
    apiMocks.overviewDay.mockImplementation((input: { date: string }) =>
      Promise.resolve(dayOverview({ date: input.date, spots: [freeSpot()] }))
    );

    await user.click(screen.getByRole('button', { name: 'nextDay' }));
    await user.click(
      await screen.findByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u })
    );
    await user.click(await screen.findByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(apiMocks.reservationCreate.mock.calls[0]?.[0]).toEqual({
        parkingSpotId: 'spot-free',
        date: NEXT_DATE,
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The write happened on the day now on screen — the invalidation has to
    // target that key, not the one `invalidateDay` was first created with.
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: dayKey(NEXT_DATE) })
    );
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: dayKey(DATE) })
    );
  });
});

describe('LotScreen — day navigation skips weekends', () => {
  it('jumps from Friday straight to Monday on "next day"', async () => {
    apiMocks.overviewDay.mockImplementation((input: { date: string }) =>
      Promise.resolve(dayOverview({ date: input.date }))
    );
    const { user } = setup();

    // Saturday 2026-01-31 -> Friday 2026-01-30 (an ordinary one-day step back).
    await user.click(screen.getByRole('button', { name: 'previousDay' }));
    await waitFor(() => {
      expect(apiMocks.overviewDay).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-01-30' }),
        expect.anything()
      );
    });

    // Friday 2026-01-30 -> the actual skip, straight to Monday 2026-02-02.
    await user.click(screen.getByRole('button', { name: 'nextDay' }));
    await waitFor(() => {
      expect(apiMocks.overviewDay).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-02-02' }),
        expect.anything()
      );
    });
  });

  it('jumps from Monday straight back to Friday on "previous day"', async () => {
    apiMocks.overviewDay.mockImplementation((input: { date: string }) =>
      Promise.resolve(dayOverview({ date: input.date }))
    );
    const { user } = setup();

    // Saturday 2026-01-31 -> Monday 2026-02-02 (already the skip, since the
    // starting Saturday itself is a weekend — asserted here only as a stepping
    // stone to reach the Monday, not as this test's point).
    await user.click(screen.getByRole('button', { name: 'nextDay' }));
    await waitFor(() => {
      expect(apiMocks.overviewDay).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-02-02' }),
        expect.anything()
      );
    });

    // Monday 2026-02-02 -> the actual skip, straight back to Friday 2026-01-30.
    await user.click(screen.getByRole('button', { name: 'previousDay' }));
    await waitFor(() => {
      expect(apiMocks.overviewDay).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-01-30' }),
        expect.anything()
      );
    });
  });
});

describe('LotScreen — onCancelReservation looks the id up off day.spots', () => {
  it('cancels the reservation on the spot whose dialog is open — an admin, on someone else’s', async () => {
    const { user } = setup({ profile: profile({ role: 'ADMIN' }) });

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.92,/u }));
    await user.click(await screen.findByRole('button', { name: 'cancelReservation' }));

    await waitFor(() =>
      expect(apiMocks.reservationCancel.mock.calls[0]?.[0]).toEqual({ reservationId: 'res-other' })
    );
  });

  it('cancels the reservation on the spot whose dialog is open — a caller, on their own', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.94,/u }));
    await user.click(await screen.findByRole('button', { name: 'cancelReservation' }));

    await waitFor(() =>
      expect(apiMocks.reservationCancel.mock.calls[0]?.[0]).toEqual({ reservationId: 'res-mine' })
    );
  });
});

describe('LotScreen — the header date picker', () => {
  it('browses to another month without moving the day, until one is picked', async () => {
    // FIXED_TODAY is 2026-01-31; February 2026 has 28 days, so day 31 cannot
    // be clicked there — proof that browsing the grid does not commit a date
    // on its own. 2026-02-28 is a Saturday and thus unpickable under the
    // weekend rule, so the target is 2026-02-27 (Friday) instead — still the
    // last selectable day of that February, illustrating the same point.
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: cs.fullDate(DATE) }));
    const dialog = screen.getByRole('dialog', { name: 'datePickerTitle' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'monthLabel' }), '2');
    await user.click(
      within(dialog).getByRole('button', { name: `dayCell: date=${cs.fullDate('2026-02-27')}` })
    );

    expect(screen.queryByRole('dialog', { name: 'datePickerTitle' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: cs.fullDate('2026-02-27') })).toBeInTheDocument();
  });

  it('browses to another year, then commits whichever day is picked', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: cs.fullDate(DATE) }));
    const dialog = screen.getByRole('dialog', { name: 'datePickerTitle' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'yearLabel' }), '2027');
    await user.click(
      within(dialog).getByRole('button', { name: `dayCell: date=${cs.fullDate('2027-01-29')}` })
    );

    expect(screen.getByRole('button', { name: cs.fullDate('2027-01-29') })).toBeInTheDocument();
  });
});

describe('LotScreen — the cell lock is not held for a dialog that cannot write', () => {
  function lastCellLockEnabled() {
    const call = useCellLockMock.mock.calls.at(-1)?.[0] as { enabled: boolean } | undefined;
    return call?.enabled;
  }

  it('takes the hold when opening a free spot to reserve it', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: /^reserveSpotAction: label=E2\.93,/u }));

    expect(lastCellLockEnabled()).toBe(true);
  });

  it('does not take the hold for the read-only explanation on a window-locked spot', async () => {
    const { user } = setup({ day: dayOverview({ canReserve: false }) });

    await user.click(screen.getByRole('button', { name: /^openSpotAction: label=E2\.93,/u }));

    expect(lastCellLockEnabled()).toBe(false);
  });
});

/**
 * What the user is told about the connection.
 *
 * The screen used to draw a notice for exactly one of the four statuses —
 * `rejected` — so the far more common way to end up looking at a frozen board
 * (`disconnected`, and `connecting` while the transport retries) was invisible.
 * The rule itself is `toRealtimeNoticeView` and is unit-tested in
 * `lot-view.spec.ts`; what these assert is that the screen actually *draws* it,
 * and which affordance comes with which state.
 *
 * The notice is found by its Czech sentence rather than by `role="status"`:
 * `WindowBanner` is also a `status` and is always present, so a role query
 * would match the wrong node — the exact way this could pass while showing
 * nothing.
 */
describe('LotScreen — telling the user the board has stopped updating', () => {
  const NOTICE = 'realtimeRejected';
  const RECONNECT = 'realtimeReconnect';

  it('says nothing while the board is live', () => {
    setup();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('names a dropped connection, without a button that would do nothing', () => {
    const { rerender } = setup();

    realtimeStatusValue = 'disconnected';
    rerender(<LotScreen />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RECONNECT })).not.toBeInTheDocument();
  });

  it('keeps saying so while the transport is retrying', () => {
    const { rerender } = setup();

    realtimeStatusValue = 'connecting';
    rerender(<LotScreen />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('clears the notice when the connection comes back', () => {
    const { rerender } = setup();

    realtimeStatusValue = 'disconnected';
    rerender(<LotScreen />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();

    realtimeStatusValue = 'connected';
    rerender(<LotScreen />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('does not flash the notice on a page load that has not connected yet', () => {
    // `RealtimeProvider` starts at `disconnected`. A rule reading the status
    // alone would warn on every load, about data that has not gone stale
    // because it has not arrived.
    setup({ realtimeStatus: 'disconnected' });
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('offers the reconnect button for a refused handshake, and wires it to the connection', async () => {
    const { user } = setup({ realtimeStatus: 'rejected' });

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: RECONNECT }));

    expect(reconnectMock).toHaveBeenCalledTimes(1);
  });

  it('reports a refused handshake even before the board was ever live', () => {
    // Terminal by construction (`doc/decision/0061-*`): no later state
    // corrects it, so the "has it ever connected" guard must not swallow it.
    setup({ realtimeStatus: 'rejected' });
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RECONNECT })).toBeInTheDocument();
  });
});

describe('LotScreen — an admin naming a holder', () => {
  it('reserves a free bay for another user, and asks only for active ones', async () => {
    const other: AdminUser = {
      id: OTHER_USER,
      email: 'jana@firma.cz',
      name: 'Jana Nováková',
      licensePlate: null,
      role: 'USER',
      oktaId: 'okta-2',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };
    const admin: AdminUser = {
      id: VIEWER,
      email: 'karel.zibar@firma.cz',
      name: 'Karel Zíbar',
      licensePlate: '4AB 1234',
      role: 'ADMIN',
      oktaId: 'okta-1',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };

    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      adminUsers: [admin, other],
    });

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));
    await user.selectOptions(await screen.findByLabelText('holderField'), OTHER_USER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    await waitFor(() =>
      expect(apiMocks.reservationCreate.mock.calls[0]?.[0]).toEqual({
        parkingSpotId: 'spot-free',
        date: DATE,
        holder: { kind: 'USER', userId: OTHER_USER, licensePlate: null },
      })
    );
    // `active: true`, not a client-side filter: `adminListUsersInputSchema`
    // carries the flag (`libs/garage/contract/src/api/users.ts:64-66`).
    expect(apiMocks.adminUserList.mock.calls[0]?.[0]).toEqual({ active: true });
  });

  it('shows the holder-scoped copy — never the plain self-facing one — when naming a colleague who already holds a bay hits RESERVATION_LIMIT_REACHED', async () => {
    const other: AdminUser = {
      id: OTHER_USER,
      email: 'jana@firma.cz',
      name: 'Jana Nováková',
      licensePlate: null,
      role: 'USER',
      oktaId: 'okta-2',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };

    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      adminUsers: [other],
    });
    apiMocks.reservationCreate.mockRejectedValue(
      await failureWithCode('RESERVATION_LIMIT_REACHED')
    );

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));
    await user.selectOptions(await screen.findByLabelText('holderField'), OTHER_USER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(await screen.findByText('errHolderLimitReached')).toBeInTheDocument();
    expect(screen.queryByText('RESERVATION_LIMIT_REACHED')).not.toBeInTheDocument();
  });

  it('shows the holder-scoped copy — never the plain self-facing one — when naming a colleague who is at their monthly cap hits MONTHLY_RESERVATION_LIMIT_REACHED', async () => {
    // The same wrong-audience problem as the case above, one code along: the
    // catalogue string says "Vyčerpali jste měsíční limit rezervací" — second
    // person, addressed to the admin about somebody else's budget.
    const other: AdminUser = {
      id: OTHER_USER,
      email: 'jana@firma.cz',
      name: 'Jana Nováková',
      licensePlate: null,
      role: 'USER',
      oktaId: 'okta-2',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };

    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      adminUsers: [other],
    });
    apiMocks.reservationCreate.mockRejectedValue(
      await failureWithCode('MONTHLY_RESERVATION_LIMIT_REACHED')
    );

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));
    await user.selectOptions(await screen.findByLabelText('holderField'), OTHER_USER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(await screen.findByText('errHolderMonthlyLimitReached')).toBeInTheDocument();
    expect(screen.queryByText('MONTHLY_RESERVATION_LIMIT_REACHED')).not.toBeInTheDocument();
  });

  it('switches back to the plain copy on a retry that renames the holder to the admin themselves', async () => {
    // The failure-mode a stale substitution would be most visible in: the
    // holder-scoped message is set by the first attempt, the admin corrects
    // the form to book for themselves instead, and the retry fails with the
    // same code. `createReservation`'s `onError` recomputes `namedOther` from
    // that retry's own `variables` every time, so this must self-correct
    // rather than keep showing a sentence about a "user" who is now the admin.
    const other: AdminUser = {
      id: OTHER_USER,
      email: 'jana@firma.cz',
      name: 'Jana Nováková',
      licensePlate: null,
      role: 'USER',
      oktaId: 'okta-2',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };
    const admin: AdminUser = {
      id: VIEWER,
      email: 'karel.zibar@firma.cz',
      name: 'Karel Zíbar',
      licensePlate: '4AB 1234',
      role: 'ADMIN',
      oktaId: 'okta-1',
      active: true,
      preferredParkingSpotId: null,
      createdAt: T0,
      updatedAt: T0,
    };

    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      adminUsers: [admin, other],
    });
    apiMocks.reservationCreate.mockRejectedValue(
      await failureWithCode('RESERVATION_LIMIT_REACHED')
    );

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));
    await user.selectOptions(await screen.findByLabelText('holderField'), OTHER_USER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));
    expect(await screen.findByText('errHolderLimitReached')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('holderField'), VIEWER);
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(await screen.findByText('RESERVATION_LIMIT_REACHED')).toBeInTheDocument();
    expect(screen.queryByText('errHolderLimitReached')).not.toBeInTheDocument();
  });

  it('disables the reserve button while admin.user.list is still in flight, instead of letting one click book for the admin unnoticed', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      // Never resolves — `holderQuery.isPending` stays true for the life of
      // the test, the same shape `holderPending` is meant to catch.
      adminUsersImpl: () => new Promise(() => undefined),
    });

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));

    expect(screen.getByRole('button', { name: 'ctaReserve' })).toBeDisabled();
  });

  it('shows why the holder selector is missing when admin.user.list fails', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview({ spots: [freeSpot()] }),
      adminUsersImpl: () => Promise.reject(new Error('boom')),
    });

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));

    expect(await screen.findByText('errorUnknown')).toBeInTheDocument();
  });
});

describe('LotScreen — an admin adding somebody to the queue', () => {
  it('fetches the queue-target list scoped to the open spot and day, excluding it for the reserve flow', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview(),
      adminUsers: [],
    });

    // `/E2\.92/` alone is ambiguous here: an admin viewing a taken spot also
    // gets the `⋯` admin-menu button (`Možnosti místa E2.92`) — the same
    // `/^openSpotAction: label=E2\.92,/u` disambiguation the other describe blocks
    // in this file already use.
    await user.click(
      await screen.findByRole('button', { name: /^openSpotAction: label=E2\.92,/u })
    );

    await waitFor(() => {
      const call = apiMocks.adminUserList.mock.calls.find(
        (args) => args[0]?.excludingReservedOrQueuedFor !== undefined
      );
      expect(call?.[0]).toEqual({
        active: true,
        excludingReservedOrQueuedFor: { parkingSpotId: 'spot-taken', date: DATE },
      });
    });
  });

  it('does not fetch the queue-target list while a free spot’s reserve dialog is open', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview(),
      adminUsers: [],
    });

    await user.click(await screen.findByRole('button', { name: /E2\.93/ }));

    await waitFor(() => expect(apiMocks.adminUserList).toHaveBeenCalled());
    expect(
      apiMocks.adminUserList.mock.calls.some(
        (args) => args[0]?.excludingReservedOrQueuedFor !== undefined
      )
    ).toBe(false);
  });

  it('disables the queue button while the queue-target list is still loading', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview(),
      // Every call to admin.user.list hangs — both the reserve-holder query
      // (which resolves the dialog's other affordances) and this one.
      adminUsersImpl: () => new Promise(() => undefined),
    });

    await user.click(
      await screen.findByRole('button', { name: /^openSpotAction: label=E2\.92,/u })
    );

    expect(await screen.findByRole('button', { name: 'ctaQueue' })).toBeDisabled();
  });

  it('shows why the queue-target selector is missing when the filtered admin.user.list fails', async () => {
    const { user } = setup({
      profile: profile({ role: 'ADMIN' }),
      day: dayOverview(),
      adminUsers: [],
    });
    // `holderQuery` and `queueTargetQuery` both call `admin.user.list`, told
    // apart only by whether the input carries `excludingReservedOrQueuedFor`
    // (`lot-screen.tsx`'s `queueTargetQuery`). Only the filtered call is made
    // to fail, so this pins `queueTargetError` specifically — leaving the
    // reserve-holder fetch failing too would show the same message for the
    // wrong reason.
    apiMocks.adminUserList.mockImplementation(
      (input: { excludingReservedOrQueuedFor?: unknown }) =>
        input?.excludingReservedOrQueuedFor === undefined
          ? Promise.resolve({ users: [] })
          : Promise.reject(new Error('boom'))
    );

    await user.click(
      await screen.findByRole('button', { name: /^openSpotAction: label=E2\.92,/u })
    );

    expect(await screen.findByText('errorUnknown')).toBeInTheDocument();
  });
});
