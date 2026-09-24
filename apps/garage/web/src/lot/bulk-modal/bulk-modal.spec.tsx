import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiQueryUtils } from '@garage/api-client';
import { createQueryClient } from '../../shell/query/query-client';
import { ERROR_DEFINITIONS } from '@garage/contract';
import type {
  ConfirmBulkOutput,
  ErrorCode,
  MyProfile,
  ParkingSpot,
  PreviewBulkOutput,
} from '@garage/contract';
import type { HolderOption } from '../spot-dialog/holder-input';
import { profile as sharedProfile, T0 } from '../../testing/fixtures';
import { createProviderWrapper } from '../../testing/providers';
import { BulkReservationModal } from './bulk-modal';

/**
 * The bulk modal, wired.
 *
 * `./bulk-view.spec.ts` already covers every decision the flow makes with no
 * DOM at all — the grid's arithmetic, the selectability rule, the
 * preferred-spot label's four cases, the proposal/result comparison and the
 * error-code mapping. What this file adds is only what lives in the component:
 * the three steps and the order they run in, the copy each outcome renders,
 * the cache invalidation, and the two halves of the locked-month block.
 *
 * Doubled at the wrapper boundary the same way `lot-screen.spec.tsx` does:
 * `@garage/api-client`'s transport and `@garage/auth/client`'s session.
 * The real `QueryClient` and `@garage/i18n` are used, so a wrong query key or a
 * missing message would fail rather than pass silently; only `todayInPrague`
 * is pinned, so the grid does not depend on the wall clock.
 */

/**
 * Mid-September, with "today" pinned to the 1st: the whole month is in the
 * future, so nothing is blocked for being in the past and every weekday cell
 * is selectable. The literal is repeated inside the `jest.mock` factory
 * because a factory is hoisted above every `const` in the file.
 */
const ANCHOR = '2026-09-15';

jest.mock('@garage/i18n', () => {
  const actual = jest.requireActual('@garage/i18n');
  return { ...actual, todayInPrague: () => '2026-09-01' };
});

jest.mock('@garage/auth/client', () => ({
  useAccessTokenProvider: () => async () => 'irrelevant',
  useSession: () => ({ status: 'authenticated' }),
}));

const apiMocks = {
  meGet: jest.fn(),
  spotList: jest.fn(),
  previewBulk: jest.fn(),
  confirmBulk: jest.fn(),
  myMonth: jest.fn(),
  overviewDay: jest.fn(),
  adminReservationMonth: jest.fn(),
};

function buildClient() {
  return {
    me: { get: apiMocks.meGet },
    spot: { list: apiMocks.spotList },
    reservation: {
      previewBulk: apiMocks.previewBulk,
      confirmBulk: apiMocks.confirmBulk,
      myMonth: apiMocks.myMonth,
    },
    overview: { day: apiMocks.overviewDay },
    admin: { reservation: { month: apiMocks.adminReservationMonth } },
  };
}

jest.mock('@garage/api-client', () => ({
  ...jest.requireActual('@garage/api-client'),
  createApiClient: () => buildClient(),
}));

/**
 * The unmocked transport, used only to *manufacture* a rejection.
 *
 * Same reasoning as `screen-state.spec.tsx`: a failure the component has to
 * read must come off a real `RPCLink`, because a hand-built error would assert
 * this file's idea of the wire shape instead of the transport's.
 */
const realApiClient = jest.requireActual<typeof import('@garage/api-client')>('@garage/api-client');

/**
 * The status is **derived**, never passed: `ContractExceptionFilter` answers
 * with `ERROR_DEFINITIONS[code].status` and nothing else, so a hand-picked
 * status manufactures a wire shape the server cannot produce — a test that
 * cannot fail for the reason it claims to check. Three call sites here and in
 * `spot-dialog.spec.tsx` did exactly that, and disagreed with each other on
 * the same code.
 *
 * `apps/garage/web/src/testing/contract-failure.ts` is the shared version. This file
 * cannot use it: it `jest.mock`s `@garage/api-client` wholesale, so a helper
 * importing the module normally would get the mock.
 */
async function contractFailure(code: ErrorCode): Promise<unknown> {
  const status = ERROR_DEFINITIONS[code].status;
  const client = realApiClient.createApiClient({
    url: 'https://api.test/rpc',
    fetch: async () =>
      new Response(
        JSON.stringify({
          json: { defined: false, code, status, message: 'developer-facing' },
          meta: [],
        }),
        { status, headers: { 'content-type': 'application/json' } }
      ),
  });
  const marker = Symbol('resolved');
  const outcome = await client.reservation.confirmBulk({ dates: [ANCHOR] }).then(
    () => marker,
    (error: unknown) => error
  );
  if (outcome === marker) {
    throw new Error('expected the call to reject, but it resolved');
  }
  return outcome;
}

const PREFERRED_SPOT_ID = 'spot-preferred';

function spot(id: string, label: string): ParkingSpot {
  return { id, label, group: 'IT', active: true, createdAt: T0, updatedAt: T0 };
}

/**
 * The shared viewer, but holding {@link PREFERRED_SPOT_ID} — the one field this
 * file's subject is about, and the one field the two copies of this fixture
 * ever disagreed on.
 */
function profile(overrides: Partial<MyProfile> = {}): MyProfile {
  return sharedProfile({ preferredParkingSpotId: PREFERRED_SPOT_ID, ...overrides });
}

function preview(overrides: Partial<PreviewBulkOutput> = {}): PreviewBulkOutput {
  return {
    month: '2026-09',
    preferredParkingSpotId: PREFERRED_SPOT_ID,
    days: [
      {
        outcome: 'SPOT_ASSIGNED',
        date: '2026-09-01',
        parkingSpotId: PREFERRED_SPOT_ID,
        parkingSpotLabel: 'E2.92',
        isPreferredSpot: true,
      },
      {
        outcome: 'SPOT_ASSIGNED',
        date: '2026-09-02',
        parkingSpotId: 'spot-other',
        parkingSpotLabel: 'E2.93',
        isPreferredSpot: false,
      },
    ],
    summary: { assigned: 2, queued: 0, unavailable: 0, preferredSpotHits: 1 },
    ...overrides,
  };
}

function confirmed(overrides: Partial<ConfirmBulkOutput> = {}): ConfirmBulkOutput {
  return {
    month: '2026-09',
    preferredParkingSpotId: PREFERRED_SPOT_ID,
    days: [
      {
        outcome: 'SPOT_ASSIGNED',
        date: '2026-09-01',
        parkingSpotId: PREFERRED_SPOT_ID,
        parkingSpotLabel: 'E2.92',
        isPreferredSpot: true,
        reservationId: 'res-1',
      },
      {
        outcome: 'SPOT_ASSIGNED',
        date: '2026-09-02',
        parkingSpotId: 'spot-other',
        parkingSpotLabel: 'E2.93',
        isPreferredSpot: false,
        reservationId: 'res-2',
      },
    ],
    summary: { assigned: 2, queued: 0, unavailable: 0, preferredSpotHits: 1 },
    ...overrides,
  };
}

function dayKey(date: string) {
  return createApiQueryUtils(buildClient() as never).overview.day.queryOptions({ input: { date } })
    .queryKey;
}

function meKey() {
  return createApiQueryUtils(buildClient() as never).me.get.queryOptions().queryKey;
}

function myMonthKey(month: string) {
  return createApiQueryUtils(buildClient() as never).reservation.myMonth.queryOptions({
    input: { month },
  }).queryKey;
}

function holderMonthKey(userId: string, month: string) {
  return createApiQueryUtils(buildClient() as never).admin.reservation.month.queryOptions({
    input: { userId, month },
  }).queryKey;
}

interface MyMonthOutput {
  readonly month: string;
  readonly reservedDates: readonly string[];
  readonly count: number;
  readonly cap: number | null;
}

interface SetupOptions {
  readonly canReserveMonth?: boolean;
  readonly profile?: MyProfile;
  readonly spots?: readonly ParkingSpot[];
  /** `setup` resets every mock, so a canned answer has to be passed in here. */
  readonly previewOutput?: PreviewBulkOutput;
  readonly confirmOutput?: ConfirmBulkOutput;
  readonly previewFailure?: unknown;
  /** Makes `spot.list` reject, so the query settles into `isError`. */
  readonly spotListFails?: boolean;
  /** `reservation.myMonth`'s answer — defaults to no reservations this month. */
  readonly myMonthOutput?: MyMonthOutput;
  /** Makes `reservation.myMonth` reject, so the summary never loads. */
  readonly myMonthFails?: boolean;
  /** `admin.reservation.month`'s answer — defaults to no reservations this month. */
  readonly holderMonthOutput?: MyMonthOutput;
  readonly isAdmin?: boolean;
  readonly viewerUserId?: string | null;
  readonly holderOptions?: readonly HolderOption[];
  readonly holderPending?: boolean;
}

function setup(options: SetupOptions = {}) {
  Object.values(apiMocks).forEach((fn) => {
    fn.mockReset();
  });
  if (options.previewFailure === undefined) {
    apiMocks.previewBulk.mockResolvedValue(options.previewOutput ?? preview());
  } else {
    apiMocks.previewBulk.mockRejectedValue(options.previewFailure);
  }
  apiMocks.confirmBulk.mockResolvedValue(options.confirmOutput ?? confirmed());
  if (options.myMonthFails === true) {
    apiMocks.myMonth.mockRejectedValue(new TypeError('Failed to fetch'));
  } else {
    apiMocks.myMonth.mockResolvedValue(
      options.myMonthOutput ?? { month: '2026-09', reservedDates: [], count: 0, cap: 5 }
    );
  }
  apiMocks.adminReservationMonth.mockResolvedValue(
    options.holderMonthOutput ?? { month: '2026-09', reservedDates: [], count: 0, cap: 5 }
  );
  if (options.spotListFails === true) {
    apiMocks.spotList.mockRejectedValue(new TypeError('Failed to fetch'));
  } else {
    apiMocks.spotList.mockResolvedValue({
      spots: options.spots ?? [spot(PREFERRED_SPOT_ID, 'E2.92'), spot('spot-other', 'E2.93')],
    });
  }

  const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  const person = options.profile ?? profile();
  client.setQueryData(meKey(), person);
  apiMocks.meGet.mockResolvedValue(person);

  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const onClose = jest.fn();

  const Wrapper = createProviderWrapper(client);

  const utils = render(
    <BulkReservationModal
      open
      onClose={onClose}
      anchorDate={ANCHOR}
      canReserveMonth={options.canReserveMonth ?? true}
      isAdmin={options.isAdmin ?? false}
      viewerUserId={options.viewerUserId ?? null}
      holderOptions={options.holderOptions ?? []}
      holderPending={options.holderPending ?? false}
    />,
    { wrapper: Wrapper }
  );

  return { ...utils, client, invalidate, onClose, user: userEvent.setup() };
}

/** Selects two working days and moves on to the proposal. */
async function reachSchedule(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
  await user.click(screen.getByRole('button', { name: 'dayCell: date=středa 2. září 2026' }));
  await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=2' }));
  return screen.findByRole('button', { name: 'ctaConfirm' });
}

describe('BulkReservationModal — step 1, choosing the days', () => {
  it('draws the month grid with Czech column heads, Monday first', () => {
    setup();
    const heads = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(heads).toEqual([
      'weekdayMon',
      'weekdayTue',
      'weekdayWed',
      'weekdayThu',
      'weekdayFri',
      'weekdaySat',
      'weekdaySun',
    ]);
  });

  it('recesses the SO and NE column heads, and only those', () => {
    // "Víkendy vizuálně v zákrytu vpravo" — the design draws the two weekend
    // heads a step lighter, which is what makes the boundary readable when the
    // cells below are grey for three different reasons.
    //
    // `Text` now renders `as="th"` directly (see `bulk-modal.tsx`), so the
    // tone class lands on the `<th>` itself rather than on a nested `<span>` —
    // this queries the head element directly. The asserted class strings are
    // unchanged, only what carries them.
    setup();
    const heads = screen.getAllByRole('columnheader');
    for (const head of heads.slice(0, 5)) {
      expect(head).toHaveClass('text-fg-3');
    }
    for (const head of heads.slice(5)) {
      expect(head).toHaveClass('text-neutral-400');
      expect(head).not.toHaveClass('text-fg-3');
    }
  });

  it('names the month in the locative in its own description', () => {
    setup();
    expect(screen.getByText('description: month=září')).toBeInTheDocument();
  });

  it('leaves weekends and Czech public holidays unselectable, and says so', () => {
    setup();
    expect(
      screen.getByRole('button', { name: 'dayCellBlocked: date=sobota 5. září 2026' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'dayCellBlocked: date=neděle 6. září 2026' })
    ).toBeDisabled();
    // 28 September — Den české státnosti, a Monday in 2026.
    expect(
      screen.getByRole('button', { name: 'dayCellBlocked: date=pondělí 28. září 2026' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' })).toBeEnabled();
    expect(screen.getByText('nonSelectableNote')).toBeInTheDocument();
  });

  it('names the preferred spot under the grid', async () => {
    setup();
    // The label needs `spot.list`, so it says "načítá se…" until that lands —
    // never a blank, and never the raw id.
    expect(screen.getByText('preferredSpotLoading: label=')).toBeInTheDocument();
    expect(await screen.findByText('preferredSpot: label=E2.92')).toBeInTheDocument();
  });

  it('says the preferred spot is gone rather than rendering a blank label', async () => {
    // The stored id is not among the active spots — it was deactivated after
    // the user chose it. A blank would let the display and the stored value
    // disagree without the user ever seeing it.
    setup({ spots: [spot('spot-other', 'E2.93')] });
    expect(await screen.findByText('preferredSpotUnavailable: label=')).toBeInTheDocument();
    expect(screen.queryByText(/Preferované místo: E2\.92/)).not.toBeInTheDocument();
  });

  it('says there is no preference when the profile stores none', () => {
    setup({ profile: profile({ preferredParkingSpotId: null }) });
    expect(screen.getByText('preferredSpotNone: label=')).toBeInTheDocument();
  });

  it('stops promising a resolution when the spot list fails to load', async () => {
    // `data` stays `undefined` after an error exactly as it is while in
    // flight, so "načítá se…" would sit there for the whole flow and the user
    // would never learn the allocator ran without a preference.
    const { user } = setup({ spotListFails: true });

    expect(await screen.findByText('preferredSpotUnknown: label=')).toBeInTheDocument();
    expect(screen.queryByText('preferredSpotLoading: label=')).not.toBeInTheDocument();

    // And the flow is still usable — a missing preference is not a blocker.
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=1' })).toBeEnabled();
  });

  it('offers no way forward until a day is picked', () => {
    setup();
    expect(screen.getByRole('button', { name: 'ctaSelectDays' })).toBeDisabled();
  });

  it('counts the selection into the call to action', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=1' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'dayCell: date=středa 2. září 2026' }));
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=2' })).toBeEnabled();
  });

  it('un-picks a day that is picked again', async () => {
    const { user } = setup();
    const first = screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' });

    await user.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');

    await user.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'ctaSelectDays' })).toBeDisabled();
  });

  it('forgets the selection between two openings', async () => {
    // The component stays mounted while the modal is shut (`Modal` renders
    // null), so nothing resets this for us — and a selection carried into
    // another month would be a batch the contract refuses.
    const { user, rerender, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=1' })).toBeEnabled();

    rerender(
      <BulkReservationModal
        open={false}
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );
    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    expect(screen.getByRole('button', { name: 'ctaSelectDays' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not carry an in-flight proposal request into the next opening', async () => {
    // The reset used to be a `useEffect` on `[open, month]`, which reset the
    // four `useState`s and nothing else — the *mutation* stayed pending, so a
    // modal closed mid-request reopened with its primary button already
    // spinning and every day locked, and nothing would ever land to clear it.
    // Keying the subtree on `open` drops the mutation with everything else.
    //
    // This is also the closest a jsdom test can get to the flash the review
    // named: a passive effect resetting after paint is invisible here, because
    // `act` flushes render and effects together, but the state it *failed* to
    // reset is not.
    const { user, rerender, onClose } = setup();
    apiMocks.previewBulk.mockReturnValue(new Promise(() => undefined));

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ctaGenerate: count=1' })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    rerender(
      <BulkReservationModal
        open={false}
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );
    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    const primary = screen.getByRole('button', { name: 'ctaSelectDays' });
    expect(primary).not.toHaveAttribute('aria-busy');
    // Disabled because nothing is selected yet, which is step 1's resting
    // state — not because a request from the previous opening is still out.
    expect(primary).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=1' })).toBeEnabled();
  });

  it('asks for the proposal with the picked days in ascending order', async () => {
    const { user } = setup();
    // Picked out of order on purpose.
    await user.click(screen.getByRole('button', { name: 'dayCell: date=čtvrtek 3. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=2' }));

    await waitFor(() => {
      expect(apiMocks.previewBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-01', '2026-09-03'] },
        expect.anything()
      );
    });
  });
});

describe('BulkReservationModal — the monthly cap and the reserved-day highlight', () => {
  it('highlights a day the viewer already holds a reservation on', async () => {
    setup({
      viewerUserId: 'user-1',
      myMonthOutput: { month: '2026-09', reservedDates: ['2026-09-16'], count: 1, cap: 5 },
    });

    const cell = await screen.findByRole('button', {
      name: 'dayCellReserved: date=středa 16. září 2026',
    });
    expect(cell).toBeDisabled();
    expect(cell).toHaveStyle({
      backgroundColor: expect.stringContaining('--color-car-') as string,
    });
  });

  it('disables further day selection once the viewer would exceed the monthly cap', async () => {
    // 4 existing reservations + up to 1 more selectable = cap of 5.
    const { user } = setup({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 4, cap: 5 },
    });

    const firstSelectable = await screen.findByRole('button', {
      name: 'dayCell: date=čtvrtek 17. září 2026',
    });
    await user.click(firstSelectable);

    const secondSelectable = screen.getByRole('button', {
      name: 'dayCellCapped: date=pátek 18. září 2026',
    });
    expect(secondSelectable).toBeDisabled();
    // The already-selected one must stay clickable, so it can be deselected.
    expect(firstSelectable).not.toBeDisabled();
  });

  it('does not disable any day when the viewer is well under the cap', async () => {
    setup({ myMonthOutput: { month: '2026-09', reservedDates: [], count: 1, cap: 5 } });

    const day = await screen.findByRole('button', { name: 'dayCell: date=čtvrtek 17. září 2026' });
    expect(day).not.toBeDisabled();
  });

  it('shows the cap note in the same session it is first hit, even with zero existing reservations (I5)', async () => {
    // `existingCount` stays 0 all along — only `selected.length` moves — so a
    // guard of `existingCount > 0` alone would never show this note, even
    // though day 6 onward greys out mid-session.
    const { user } = setup({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
    });

    expect(screen.queryByText(/^capNote:/)).not.toBeInTheDocument();

    for (const label of [
      'dayCell: date=úterý 1. září 2026',
      'dayCell: date=středa 2. září 2026',
      'dayCell: date=čtvrtek 3. září 2026',
      'dayCell: date=pátek 4. září 2026',
      'dayCell: date=pondělí 7. září 2026',
    ]) {
      await user.click(screen.getByRole('button', { name: label }));
    }

    expect(screen.getByText('capNote: count=0,cap=5')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'dayCellCapped: date=úterý 8. září 2026' })
    ).toBeDisabled();
  });

  it('renders errorMonthlyCapReached with the real cap value, not a hardcoded literal (I4)', async () => {
    const { user } = setup({
      previewFailure: await contractFailure('MONTHLY_RESERVATION_LIMIT_REACHED'),
    });

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    expect(await screen.findByText('errorMonthlyCapReached: cap=5')).toBeInTheDocument();
  });

  it('greys out day cells against the configured cap, not a hard-coded five', async () => {
    const { user } = setup({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 2 },
    });

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'dayCell: date=středa 2. září 2026' }));

    expect(
      await screen.findByRole('button', { name: 'dayCellCapped: date=čtvrtek 3. září 2026' })
    ).toBeDisabled();
    expect(screen.getByText('capNote: count=0,cap=2')).toBeInTheDocument();
  });

  it('interpolates the configured cap into the cap-reached error', async () => {
    const { user } = setup({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 8 },
      previewFailure: await contractFailure('MONTHLY_RESERVATION_LIMIT_REACHED'),
    });

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    expect(await screen.findByText('errorMonthlyCapReached: cap=8')).toBeInTheDocument();
  });

  it('bounds nothing when the server says no cap applies (cap: null)', async () => {
    // Five already held: under a cap of 5 every free day would be greyed out.
    setup({ myMonthOutput: { month: '2026-09', reservedDates: [], count: 5, cap: null } });

    const day = await screen.findByRole('button', { name: 'dayCell: date=čtvrtek 17. září 2026' });
    expect(day).not.toBeDisabled();
    expect(screen.queryByText(/^capNote:/)).not.toBeInTheDocument();
  });

  it('still bounds the selection at the default cap when the month summary fails to load', async () => {
    const { user } = setup({ myMonthFails: true });

    for (const label of [
      'dayCell: date=úterý 1. září 2026',
      'dayCell: date=středa 2. září 2026',
      'dayCell: date=čtvrtek 3. září 2026',
      'dayCell: date=pátek 4. září 2026',
      'dayCell: date=pondělí 7. září 2026',
    ]) {
      await user.click(screen.getByRole('button', { name: label }));
    }

    expect(
      screen.getByRole('button', { name: 'dayCellCapped: date=úterý 8. září 2026' })
    ).toBeDisabled();
  });
});

describe('BulkReservationModal — the cap follows the holder, not the viewer', () => {
  const ADMIN_OPTIONS: readonly HolderOption[] = [
    { userId: 'admin-1', name: 'Dev Admin', licensePlate: null },
    { userId: 'user-1', name: 'Dev User', licensePlate: '1AB 2345' },
  ];

  function asAdminBookingFor(options: Partial<SetupOptions> = {}) {
    return setup({
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: ADMIN_OPTIONS,
      ...options,
    });
  }

  it('reads the holder’s month, not the admin’s, once a colleague is selected', async () => {
    const { user } = asAdminBookingFor({
      myMonthOutput: { month: '2026-09', reservedDates: ['2026-09-16'], count: 5, cap: 5 },
      holderMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');

    await waitFor(() => {
      expect(apiMocks.adminReservationMonth).toHaveBeenCalledWith(
        { userId: 'user-1', month: '2026-09' },
        expect.anything()
      );
    });
  });

  it('keeps the grid open for a colleague with room, even when the admin is at their own cap', async () => {
    const { user } = asAdminBookingFor({
      // The admin is at the cap and already holds the 16th. Neither fact may
      // reach the grid once the holder is somebody else — this is the working
      // admin flow the previous suppression hack existed to protect, and it
      // still has to work now that the cap is real for the holder.
      myMonthOutput: { month: '2026-09', reservedDates: ['2026-09-16'], count: 5, cap: 5 },
      holderMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');

    const previouslyReserved = await screen.findByRole('button', {
      name: 'dayCell: date=středa 16. září 2026',
    });
    expect(previouslyReserved).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' })
    ).not.toBeDisabled();
  });

  it('caps the grid at the holder’s remaining slots and names them in the note', async () => {
    const { user } = asAdminBookingFor({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
      holderMonthOutput: { month: '2026-09', reservedDates: ['2026-09-16'], count: 4, cap: 5 },
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');

    // The holder's own reserved day is blocked, and named as theirs — but not
    // painted in the viewer's own car colour, which would claim it as theirs.
    const holderReserved = await screen.findByRole('button', {
      name: 'dayCellReservedHolder: date=středa 16. září 2026',
    });
    expect(holderReserved).toBeDisabled();
    expect(holderReserved.style.backgroundColor).toBe('');

    // One slot left: the first pick is allowed, the rest of the month locks.
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    expect(
      await screen.findByRole('button', { name: 'dayCellCappedHolder: date=středa 2. září 2026' })
    ).toBeDisabled();
    expect(screen.getByText('capNoteHolder: count=4,cap=5')).toBeInTheDocument();
  });

  it('clears the selection when the holder changes, so days picked for one person cannot be booked for another', async () => {
    const { user } = asAdminBookingFor({
      myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
      holderMonthOutput: { month: '2026-09', reservedDates: [], count: 4, cap: 5 },
    });

    // Five days for the admin themselves — allowed, they start the month empty.
    for (const label of [
      'dayCell: date=úterý 1. září 2026',
      'dayCell: date=středa 2. září 2026',
      'dayCell: date=čtvrtek 3. září 2026',
      'dayCell: date=pátek 4. září 2026',
      'dayCell: date=pondělí 7. září 2026',
    ]) {
      await user.click(screen.getByRole('button', { name: label }));
    }
    expect(screen.getByRole('button', { name: 'ctaGenerate: count=5' })).toBeInTheDocument();

    // Switching the holder to somebody with one slot left must not carry the
    // five days over — the server would reject the whole batch, which is the
    // defect this change exists to remove.
    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');

    expect(await screen.findByRole('button', { name: 'ctaSelectDays' })).toBeInTheDocument();
  });

  it('restores the viewer’s own cap the moment the holder is switched back to the admin', async () => {
    const { user } = asAdminBookingFor({
      myMonthOutput: { month: '2026-09', reservedDates: ['2026-09-16'], count: 5, cap: 5 },
      holderMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 },
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');
    expect(
      screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' })
    ).not.toBeDisabled();

    await user.selectOptions(screen.getByLabelText('holderField'), 'admin-1');
    expect(
      await screen.findByRole('button', { name: 'dayCellCapped: date=úterý 1. září 2026' })
    ).toBeDisabled();
  });

  it('does not ask for a holder month at all while the admin books for themselves', async () => {
    asAdminBookingFor({ myMonthOutput: { month: '2026-09', reservedDates: [], count: 0, cap: 5 } });
    // Give the modal a real window to have made the call, so this negative
    // assertion could actually fail: wait for the query that *should* fire
    // (the viewer's own month) before asserting the one that must not.
    await waitFor(() => {
      expect(apiMocks.myMonth).toHaveBeenCalled();
    });
    expect(apiMocks.adminReservationMonth).not.toHaveBeenCalled();
  });

  it('never fires a holder-month query while `holderForm` still holds the empty default (I5)', async () => {
    // `holderOptions: []` reproduces exactly what `LotScreen` passes while its
    // own `admin.user.list` fetch is still in flight: `showHolderForm` is
    // `false` and `holderForm`'s `userId` is seeded to `''`
    // (`defaultBulkHolderId`, empty options). The options then "arrive" —
    // the parent re-renders with a real list, without remounting this
    // component (`BulkReservationModal`'s `key` is `open`+month only) — which
    // is the one moment `holderId !== ''` guards: `showHolderForm` flips to
    // `true` on this render before the reset effect has caught the form up.
    const { rerender } = asAdminBookingFor({ holderOptions: [] });
    expect(screen.queryByLabelText('holderField')).not.toBeInTheDocument();

    rerender(
      <BulkReservationModal
        open
        onClose={jest.fn()}
        anchorDate={ANCHOR}
        canReserveMonth
        isAdmin
        viewerUserId="admin-1"
        holderOptions={ADMIN_OPTIONS}
        holderPending={false}
      />
    );

    // Give the modal a real window to have fired the query, so this negative
    // assertion could actually fail: wait for the holder selector — driven by
    // the same now-populated `holderOptions` — to appear before asserting
    // that no call with an empty `userId` ever went out.
    await screen.findByLabelText('holderField');
    expect(apiMocks.adminReservationMonth).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: '' }),
      expect.anything()
    );
  });
});

describe('BulkReservationModal — the admin holder selector', () => {
  const ADMIN_OPTIONS: readonly HolderOption[] = [
    { userId: 'admin-1', name: 'Dev Admin', licensePlate: null },
    { userId: 'user-1', name: 'Dev User', licensePlate: '1AB 2345' },
  ];

  it('shows no holder selector for a normal user', () => {
    setup();
    expect(screen.queryByLabelText('holderField')).not.toBeInTheDocument();
  });

  it('offers a holder selector for an admin, defaulting to the admin themselves', () => {
    setup({ isAdmin: true, viewerUserId: 'admin-1', holderOptions: ADMIN_OPTIONS });
    expect(screen.getByLabelText('holderField')).toHaveValue('admin-1');
  });

  it('previews for the selected holder, not the admin', async () => {
    const { user } = setup({
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: ADMIN_OPTIONS,
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    await waitFor(() => {
      expect(apiMocks.previewBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-01'], holderId: 'user-1' },
        expect.anything()
      );
    });
  });

  it('confirms for the same holder the preview was generated for', async () => {
    // A single-day `previewOutput`, not the fixture's default two-day one:
    // `SchedulePreviewModal` confirms exactly the days of the proposal on
    // screen, so a two-day proposal here would make the assertion below
    // disagree with itself rather than with the holder id under test.
    const { user } = setup({
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: ADMIN_OPTIONS,
      previewOutput: preview({
        days: [
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            isPreferredSpot: true,
          },
        ],
        summary: { assigned: 1, queued: 0, unavailable: 0, preferredSpotHits: 1 },
      }),
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');
    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));
    await user.click(await screen.findByRole('button', { name: 'ctaConfirm' }));

    await waitFor(() => {
      expect(apiMocks.confirmBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-01'], holderId: 'user-1' },
        expect.anything()
      );
    });
  });

  it('omits holderId entirely for a normal user', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    await waitFor(() => {
      expect(apiMocks.previewBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-01'] },
        expect.anything()
      );
    });
  });
});

describe('BulkReservationModal — step 2, the proposed schedule', () => {
  it('lists every day as date, weekday, spot and badge', async () => {
    const { user } = setup();
    await reachSchedule(user);

    expect(screen.getByText('1. září · úterý')).toBeInTheDocument();
    expect(screen.getByText('2. září · středa')).toBeInTheDocument();
    expect(screen.getByText('badgeAssignedPreferred: position=0')).toBeInTheDocument();
    expect(screen.getByText('badgeAssigned: position=0')).toBeInTheDocument();
    expect(screen.getByText('E2.92')).toBeInTheDocument();
    expect(screen.getByText('E2.93')).toBeInTheDocument();
  });

  it('badges a queued day with its position and an impossible day with its reason', async () => {
    const { user } = setup({
      previewOutput: preview({
        days: [
          {
            outcome: 'QUEUED',
            date: '2026-09-01',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            waitlistPosition: 3,
          },
          { outcome: 'UNAVAILABLE', date: '2026-09-02', reason: 'ALREADY_HAS_RESERVATION' },
        ],
        summary: { assigned: 0, queued: 1, unavailable: 1, preferredSpotHits: 0 },
      }),
    });
    await reachSchedule(user);

    expect(screen.getByText('badgeQueued: position=3')).toBeInTheDocument();
    expect(screen.getByText('badgeAlreadyReserved: position=0')).toBeInTheDocument();
  });

  it('summarises the proposal in days with a spot and days in a queue', async () => {
    const { user } = setup({
      previewOutput: preview({
        days: [
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            isPreferredSpot: true,
          },
          {
            outcome: 'QUEUED',
            date: '2026-09-02',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            waitlistPosition: 1,
          },
        ],
        summary: { assigned: 1, queued: 1, unavailable: 0, preferredSpotHits: 1 },
      }),
    });
    await reachSchedule(user);

    expect(screen.getByText('scheduleSummary: assigned=1,queued=1')).toBeInTheDocument();
  });

  it('quotes the server’s summary rather than counting the rows itself', async () => {
    // The proposal and the result must print counts from the same authority.
    // If step 2 re-derived them from `days`, a server whose summary ever meant
    // something slightly different would make the two steps disagree and the
    // comparison panel would have nothing to explain, because no day moved.
    // The fixture's `summary` deliberately disagrees with its own `days`.
    const { user } = setup({
      previewOutput: preview({
        days: [
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            isPreferredSpot: true,
          },
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-02',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            isPreferredSpot: false,
          },
        ],
        summary: { assigned: 7, queued: 3, unavailable: 0, preferredSpotHits: 1 },
      }),
    });
    await reachSchedule(user);

    expect(screen.getByText('scheduleSummary: assigned=7,queued=3')).toBeInTheDocument();
    expect(screen.queryByText('scheduleSummary: assigned=2,queued=0')).not.toBeInTheDocument();
  });

  it('paints each badge in the tone the brief names — green, blue, yellow', async () => {
    // Crosses three files rather than restating one: the brief's colour →
    // `BADGE_TONES` → `badge.tsx`'s token classes. A tone swap, a `Badge` tone
    // rename or a token remap all fail here, and none of them is visible in a
    // diff of `bulk-modal.tsx` alone.
    const { user } = setup({
      previewOutput: preview({
        days: [
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            isPreferredSpot: true,
          },
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-02',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            isPreferredSpot: false,
          },
          {
            outcome: 'QUEUED',
            date: '2026-09-03',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            waitlistPosition: 1,
          },
        ],
      }),
    });
    await reachSchedule(user);

    expect(screen.getByText('badgeAssignedPreferred: position=0')).toHaveClass(
      'bg-brand-green-100'
    );
    expect(screen.getByText('badgeAssigned: position=0')).toHaveClass('bg-brand-blue-100');
    expect(screen.getByText('badgeQueued: position=1')).toHaveClass('bg-brand-yellow-100');
  });

  it('goes back to the grid with the selection intact', async () => {
    const { user } = setup();
    await reachSchedule(user);

    await user.click(screen.getByRole('button', { name: 'ctaBack' }));

    expect(await screen.findByRole('button', { name: 'ctaGenerate: count=2' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('confirms with the same days it previewed', async () => {
    const { user } = setup();
    const confirm = await reachSchedule(user);
    await user.click(confirm);

    await waitFor(() => {
      expect(apiMocks.confirmBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-01', '2026-09-02'] },
        expect.anything()
      );
    });
  });

  it('confirms the days of the schedule on screen, not the days that were clicked', async () => {
    // "We confirm exactly what you were shown" is the invariant. The two lists
    // agree in production today — both procedures answer one entry per
    // requested day — so the only way to state it is a preview whose response
    // differs from the selection, which is what this fixture is.
    const { user } = setup({
      previewOutput: preview({
        days: [
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-03',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            isPreferredSpot: true,
          },
        ],
        summary: { assigned: 1, queued: 0, unavailable: 0, preferredSpotHits: 1 },
      }),
    });
    await user.click(await reachSchedule(user));

    await waitFor(() => {
      expect(apiMocks.confirmBulk).toHaveBeenCalledWith(
        { dates: ['2026-09-03'] },
        expect.anything()
      );
    });
  });
});

describe('BulkReservationModal — the confirmed result against the proposal', () => {
  it('says so plainly when nothing moved', async () => {
    const { user } = setup();
    await user.click(await reachSchedule(user));

    expect(await screen.findByText('resultUnchanged')).toBeInTheDocument();
    expect(screen.queryByText('resultChangedTitle')).not.toBeInTheDocument();
  });

  it('floats a success toast top-right once the batch is confirmed', async () => {
    const { user } = setup();
    await user.click(await reachSchedule(user));

    // `role="status"` takes no accessible name from content (ARIA `status` is
    // `nameFrom: author`), so the toast is located via the notifications
    // region's own `aria-label` instead. Asserting via the `status` role
    // (rather than plain text) confirms this is a success/status toast and
    // not a `danger` one, which renders `role="alert"` instead; the exact
    // text is checked on top of that.
    const region = await screen.findByRole('region', { name: 'notificationsRegion' });
    const toast = await within(region).findByRole('status');
    expect(toast).toHaveTextContent('resultSuccessToast');
  });

  it('shows the difference when a promised spot turned into a queue place', async () => {
    // The race `doc/decision/0092-*` deliberately leaves open. Confirming
    // something quietly different from the proposal is the failure this whole
    // two-step flow exists to prevent.
    const { user } = setup({
      confirmOutput: confirmed({
        days: [
          {
            outcome: 'QUEUED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            waitlistPosition: 2,
            waitlistEntryId: 'wl-1',
          },
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-02',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            isPreferredSpot: false,
            reservationId: 'res-2',
          },
        ],
        summary: { assigned: 1, queued: 1, unavailable: 0, preferredSpotHits: 0 },
      }),
    });
    await user.click(await reachSchedule(user));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('resultChangedTitle');
    expect(alert).toHaveTextContent('1. září · úterý');
    expect(alert).toHaveTextContent(
      'resultChangedProposed: badgeAssignedPreferred: position=0 · E2.92'
    );
    expect(alert).toHaveTextContent('resultChangedActual: badgeQueued: position=2 · E2.92');
    // The day that did not move stays out of the difference list.
    expect(alert).not.toHaveTextContent('2. září');
    expect(screen.queryByText('resultUnchanged')).not.toBeInTheDocument();
  });

  it('does not close itself on a successful confirmation, so the comparison cannot be skipped', async () => {
    const { user, onClose } = setup();
    await user.click(await reachSchedule(user));

    await screen.findByText('resultUnchanged');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'ctaDone' })).toBeInTheDocument();
  });

  it('invalidates the day overview for every day in the batch', async () => {
    const { user, invalidate } = setup();
    await user.click(await reachSchedule(user));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: dayKey('2026-09-01') });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dayKey('2026-09-02') });
  });

  it('invalidates reservation.myMonth for the batch month too (I6)', async () => {
    // Otherwise a reopened modal can show the pre-write cap/highlight state
    // for up to `reservation.myMonth`'s stale time.
    const { user, invalidate } = setup();
    await user.click(await reachSchedule(user));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: myMonthKey('2026-09') });
    });
  });

  it('invalidates the holder’s month after confirming for somebody else, not only the viewer’s', async () => {
    const { user, invalidate } = setup({
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: [
        { userId: 'admin-1', name: 'Dev Admin', licensePlate: null },
        { userId: 'user-1', name: 'Dev User', licensePlate: '1AB 2345' },
      ],
    });

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-1');
    const confirm = await reachSchedule(user);
    await user.click(confirm);

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: holderMonthKey('user-1', '2026-09') });
    });
  });

  it('invalidates a day even when nothing could be done for it', async () => {
    // Over-invalidating is nearly free; deciding client-side which days the
    // server actually touched would be the re-derivation `doc/decision/0120-*`
    // rules out.
    const { user, invalidate } = setup({
      confirmOutput: confirmed({
        days: [
          { outcome: 'UNAVAILABLE', date: '2026-09-01', reason: 'NO_SPOTS_AVAILABLE' },
          { outcome: 'UNAVAILABLE', date: '2026-09-02', reason: 'NO_SPOTS_AVAILABLE' },
        ],
        summary: { assigned: 0, queued: 0, unavailable: 2, preferredSpotHits: 0 },
      }),
    });
    await user.click(await reachSchedule(user));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: dayKey('2026-09-01') });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dayKey('2026-09-02') });
  });
});

describe('BulkReservationModal — what each typed failure says', () => {
  it('tells the user nothing was written when the batch lost a race', async () => {
    const { user } = setup();
    const confirm = await reachSchedule(user);
    apiMocks.confirmBulk.mockRejectedValue(await contractFailure('CONFLICT'));

    await user.click(confirm);

    expect(await screen.findByText('errorConflict')).toBeInTheDocument();
    // Still on the proposal — there is no result to show.
    expect(screen.getByRole('button', { name: 'ctaConfirm' })).toBeInTheDocument();
  });

  it('does not reuse the single-day reservation copy for a rejected batch', async () => {
    // `errors.VALIDATION_FAILED` says "weekend or holiday", which for a bulk
    // request is never the reason: a weekend is a per-day fact inside a
    // *successful* response (`doc/decision/0090-*`).
    const { user } = setup({
      previewFailure: await contractFailure('VALIDATION_FAILED'),
    });

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    expect(await screen.findByText('errorValidation')).toBeInTheDocument();
    expect(
      screen.queryByText('Požadavek porušuje pravidlo rezervací (např. víkend nebo svátek).')
    ).not.toBeInTheDocument();
  });

  it('renders the preview failure through the Toast primitive, not a bare paragraph', async () => {
    const { user } = setup({
      previewFailure: await contractFailure('VALIDATION_FAILED'),
    });

    await user.click(screen.getByRole('button', { name: 'dayCell: date=úterý 1. září 2026' }));
    await user.click(screen.getByRole('button', { name: 'ctaGenerate: count=1' }));

    // A `Toast` wraps its message in a `<div role="alert">`; the bare `<p
    // role="alert">` it replaces would fail this on tag name alone.
    const alert = await screen.findByRole('alert');
    expect(alert.tagName).toBe('DIV');
  });

  it('says the month is locked when the API refuses the confirmation', async () => {
    const { user } = setup();
    const confirm = await reachSchedule(user);
    apiMocks.confirmBulk.mockRejectedValue(await contractFailure('RESERVATIONS_LOCKED'));

    await user.click(confirm);

    expect(await screen.findByText('errorLocked')).toBeInTheDocument();
  });

  it('falls back to the generic sentence for a failure that carries no contract code', async () => {
    const { user } = setup();
    const confirm = await reachSchedule(user);
    apiMocks.confirmBulk.mockRejectedValue(new TypeError('Failed to fetch'));

    await user.click(confirm);

    expect(await screen.findByText('errorUnknown')).toBeInTheDocument();
  });
});

describe('BulkReservationModal — the locked month is blocked, not merely hidden', () => {
  it('refuses the whole flow when the caller may not reserve in this month', () => {
    // The header hides its button in this case, but hiding a control is not
    // enforcement: this is the modal refusing on its own.
    setup({ canReserveMonth: false });

    expect(screen.getByRole('dialog', { name: 'lockedTitle' })).toBeInTheDocument();
    expect(screen.getByText('lockedDescription')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaSelectDays' })).not.toBeInTheDocument();
    expect(apiMocks.previewBulk).not.toHaveBeenCalled();
  });

  it('does not let a stray scrim click be how the user loses a selection', async () => {
    // The refusal can replace a step that was holding a month's worth of picked
    // days, and going back is not offered. Every one of the four panels sets
    // `closeOnScrimClick={false}` for that reason; without this the refusal was
    // the one that did not, and nothing said so.
    const { user, rerender, onClose } = setup();
    await reachSchedule(user);

    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth={false}
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'lockedTitle' });
    await user.click(dialog.parentElement as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'lockedTitle' })).toBeInTheDocument();
  });

  it('stops a confirmation whose window closed while the modal was open', async () => {
    // The case a hidden header button cannot cover: the user reached the
    // proposal, then the day query refetched and `canReserveMonth` flipped.
    const { user, rerender, onClose } = setup();
    await reachSchedule(user);

    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth={false}
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    expect(screen.getByRole('dialog', { name: 'lockedTitle' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaConfirm' })).not.toBeInTheDocument();
    expect(apiMocks.confirmBulk).not.toHaveBeenCalled();
  });

  it('keeps the comparison on screen when the window closes after the confirmation', async () => {
    // The gate guards *writing*, never the display of writes that already
    // happened. Confirming invalidates `overview.day` for every day in the
    // batch, so a refetch lands within milliseconds — if the month locked in
    // between, `canReserveMonth` comes back false while the reservations exist.
    // Refusing here would replace the difference panel with "hromadnou
    // rezervaci teď založit nelze" over bookings the user just made: the exact
    // silent difference this flow exists to prevent (`doc/decision/0176-*`).
    const { user, rerender, onClose } = setup({
      confirmOutput: confirmed({
        days: [
          {
            outcome: 'QUEUED',
            date: '2026-09-01',
            parkingSpotId: PREFERRED_SPOT_ID,
            parkingSpotLabel: 'E2.92',
            waitlistPosition: 2,
            waitlistEntryId: 'wl-1',
          },
          {
            outcome: 'SPOT_ASSIGNED',
            date: '2026-09-02',
            parkingSpotId: 'spot-other',
            parkingSpotLabel: 'E2.93',
            isPreferredSpot: false,
            reservationId: 'res-2',
          },
        ],
        summary: { assigned: 1, queued: 1, unavailable: 0, preferredSpotHits: 0 },
      }),
    });
    await user.click(await reachSchedule(user));
    await screen.findByRole('alert');

    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth={false}
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    expect(screen.getByRole('dialog', { name: 'resultTitle' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('resultChangedTitle');
    expect(screen.queryByText('lockedDescription')).not.toBeInTheDocument();
  });

  it('keeps an unchanged result on screen too, not only a differing one', async () => {
    const { user, rerender, onClose } = setup();
    await user.click(await reachSchedule(user));
    await screen.findByText('resultUnchanged');

    rerender(
      <BulkReservationModal
        open
        onClose={onClose}
        anchorDate={ANCHOR}
        canReserveMonth={false}
        isAdmin={false}
        viewerUserId={null}
        holderOptions={[]}
        holderPending={false}
      />
    );

    expect(screen.getByRole('dialog', { name: 'resultTitle' })).toBeInTheDocument();
    expect(screen.getByText('resultUnchanged')).toBeInTheDocument();
  });
});
