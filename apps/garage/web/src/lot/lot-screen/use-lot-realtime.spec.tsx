import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createApiQueryUtils } from '@garage/api-client';
import { createQueryClient } from '../../shell/query/query-client';
import type { DayOverviewOutput, DaySpotOverview } from '@garage/contract';
import type { ServerToClientEventName } from '@garage/contract/realtime';
import { ApiProvider } from '../../shell/api-provider/api-provider';
import { useLotRealtime } from './use-lot-realtime';

/**
 * What this suite is actually for.
 *
 * The defect it exists to catch is **a query key that does not match the one
 * the screen reads**. A patch written under a key nothing renders is
 * indistinguishable, from the outside, from a broadcast that never arrived —
 * and it is the exact shape of the bug that made every request 404 in Task
 * 23's first live run. So the key here is **not** written down: the hook
 * derives it from the contract through `createApiQueryUtils`, and this file
 * derives its own the same way, from a second instance. If the hook ever
 * hand-writes a key, or reaches for a different procedure, every assertion
 * below stops finding data.
 *
 * That is also why the real `QueryClient` and `createApiQueryUtils` are used
 * here — a stubbed query client would let a wrong key pass. Only two things
 * are doubled, and both at the wrapper boundary the app is allowed to name:
 *
 * - `@garage/api-client` / `@garage/auth/client`, so `ApiProvider` can be
 *   built without a running Auth.js. Note the client itself is never called:
 *   `createApiQueryUtils` derives keys from the *path* of the property access,
 *   not from anything the transport does.
 * - `@garage/realtime-client`, replaced by a registry that hands the test a
 *   handle on each subscribed handler. Task 21 already proves a real socket
 *   delivers a parsed payload to that handler (`connection.spec.tsx`, 69
 *   tests); re-proving it here would test their code, not this hook's.
 */

/**
 * `createApiQueryUtils` walks the *client's own shape* to build its proxy, so
 * the stub has to carry the procedures this screen calls. Nothing here is ever
 * invoked — a query key is derived from the path of the property access, not
 * from what the transport does — but a missing branch would make the key
 * underivable, which is exactly the failure this suite is meant to notice.
 * One factory feeds both the provider and `dayKey`, so the two cannot drift.
 */
function mockApiClient() {
  return {
    overview: { day: jest.fn() },
    reservation: { create: jest.fn(), cancel: jest.fn() },
    waitlist: { join: jest.fn(), leave: jest.fn() },
  };
}

jest.mock('@garage/api-client', () => ({
  ...jest.requireActual('@garage/api-client'),
  createApiClient: () => mockApiClient(),
}));

jest.mock('@garage/auth/client', () => ({
  // A stable function reference, not `() => async () => 'irrelevant'` — see
  // `doc/decision/0141-*` for why that form defeats `api`'s identity staying
  // put across a rerender. Same fix as `api-provider.spec.tsx`.
  useAccessTokenProvider: () => mockGetAccessToken,
}));

const mockGetAccessToken = async () => 'irrelevant';

const handlers = new Map<string, (payload: unknown) => void>();

/**
 * One join-or-leave, in the order it happened. A bare `jest.fn()` recording
 * calls would not do here: Task 25's risk is that changing the day on screen
 * leaves the *old* room subscribed, and a mock that only ever "joins" cannot
 * fail that way no matter what `useLotRealtime` does with the date it is
 * given. `roomEvent` is instead a faithful-enough stand-in for the real
 * `useDayRoom` (`libs/garage/realtime-client/src/lib/connection.tsx`, whose own
 * `connection.spec.tsx` proves the socket-level unsubscribe): an effect keyed
 * on `date` that joins on mount, joins again on every date it is handed, and
 * — through the effect's own cleanup — leaves whatever date it is leaving
 * behind. That makes the "leave the old room" defence a property of *this*
 * hook actually forwarding the current date, not of React's effect machinery
 * in isolation.
 */
type RoomEvent = { readonly type: 'join' | 'leave'; readonly date: string | null };
const roomEvents: RoomEvent[] = [];

/**
 * The connection status the hook sees. A module-level `let` rather than a
 * prop, because the real `useRealtime()` reads a context the *provider* owns —
 * a status change is something that happens **to** this hook, not something
 * its caller passes it, and a test that handed it in as a prop would be
 * testing a different shape of hook.
 */
type MockRealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'rejected';

let realtimeStatus: MockRealtimeStatus = 'connected';

jest.mock('@garage/realtime-client', () => {
  const react = jest.requireActual('react');
  return {
    useDayRoom: (date: string | null) => {
      react.useEffect(() => {
        roomEvents.push({ type: 'join', date });
        return () => {
          roomEvents.push({ type: 'leave', date });
        };
      }, [date]);
    },
    useRealtime: () => ({ status: realtimeStatus, reconnect: jest.fn() }),
    useRealtimeEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
});

const DATE = '2026-09-28';
const OTHER_DATE = '2026-09-29';
const VIEWER = 'user-viewer';
const STRANGER = 'user-stranger';

function row(id: string, overrides: Partial<DaySpotOverview> = {}): DaySpotOverview {
  return {
    spot: {
      id,
      label: id.toUpperCase(),
      group: 'IT',
      active: true,
      hidden: false,
      evCharger: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    reservation: null,
    waitlistCount: 0,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    timedReservations: [],
    ...overrides,
  };
}

function publicReservation(id: string, userId: string) {
  return {
    id,
    createdAt: '2026-09-01T08:00:00.000Z',
    holder: { kind: 'USER' as const, userId, name: 'Petr Novák', licensePlate: '8SC 9012' },
  };
}

function dayOverview(overrides: Partial<DayOverviewOutput> = {}): DayOverviewOutput {
  return {
    date: DATE,
    window: {
      month: '2026-09',
      windowFrom: '2026-08-25',
      windowTo: '2026-08-31',
      state: 'OPEN',
      lockMode: 'AUTO',
    },
    canReserve: true,
    canReserveMonth: true,
    spots: [row('spot-a'), row('spot-b')],
    viewerReservationId: null,
    ...overrides,
  };
}

/**
 * The day-overview key, derived from the contract exactly as the hook derives
 * its own — from a *separate* `createApiQueryUtils` instance, so the two only
 * agree if both go through the contract.
 */
function dayKey(date: string) {
  return createApiQueryUtils(mockApiClient() as never).overview.day.queryOptions({
    input: { date },
  }).queryKey;
}

function Harness({ date, viewerUserId }: { date: string | null; viewerUserId: string | null }) {
  useLotRealtime({ date, viewerUserId });
  return null;
}

function setup(
  options: {
    date?: string | null;
    viewerUserId?: string | null;
    seed?: DayOverviewOutput | null;
    status?: MockRealtimeStatus;
  } = {}
) {
  if (options.status !== undefined) realtimeStatus = options.status;
  const date = options.date === undefined ? DATE : options.date;
  const client = createQueryClient();
  const seed = options.seed === undefined ? dayOverview() : options.seed;
  if (seed !== null && date !== null) {
    client.setQueryData(dayKey(date), seed);
  }

  const invalidate = jest.spyOn(client, 'invalidateQueries');

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ApiProvider url="http://localhost:3000/api">{children}</ApiProvider>
      </QueryClientProvider>
    );
  }

  // `??` would be wrong here: `viewerUserId: null` is a case under test — the
  // profile query still in flight — not an omitted option.
  const viewerUserId = options.viewerUserId === undefined ? VIEWER : options.viewerUserId;

  const utils = render(<Harness date={date} viewerUserId={viewerUserId} />, { wrapper });

  /**
   * Moves the connection to another status, the way the provider would: the
   * context value changes and every consumer re-renders. `act` so the effect
   * that watches the status has run by the time the call returns.
   */
  function flipStatus(next: MockRealtimeStatus, nextDate: string | null = date) {
    realtimeStatus = next;
    act(() => {
      utils.rerender(<Harness date={nextDate} viewerUserId={viewerUserId} />);
    });
  }

  return { ...utils, client, invalidate, date, viewerUserId, flipStatus };
}

function emit(event: ServerToClientEventName, payload: unknown) {
  const handler = handlers.get(event);
  if (handler === undefined) {
    throw new Error(`no handler subscribed for "${event}"`);
  }
  act(() => {
    handler(payload);
  });
}

function readDay(client: QueryClient, date = DATE): DayOverviewOutput | undefined {
  return client.getQueryData<DayOverviewOutput>(dayKey(date));
}

beforeEach(() => {
  handlers.clear();
  roomEvents.length = 0;
  // `connected` is the resting state, and the one every test that is not about
  // the connection wants: a hook mounting under a socket that is already up
  // has missed nothing, so it must not refetch, and none of the invalidation
  // counts below have to account for one.
  realtimeStatus = 'connected';
});

describe('useLotRealtime', () => {
  it('joins the room of the day it was given', () => {
    setup();
    expect(roomEvents).toEqual([{ type: 'join', date: DATE }]);
  });

  it('joins no room while there is no day', () => {
    setup({ date: null, seed: null });
    expect(roomEvents).toEqual([{ type: 'join', date: null }]);
  });

  it('subscribes to every event the screen depends on, and no sixth one', () => {
    setup();
    expect([...handlers.keys()].sort()).toEqual([
      'reservation:cancelled',
      'reservation:created',
      'reservation:reassigned',
      'timed-reservations:updated',
      'waitlist:updated',
    ]);
  });

  it('patches guest blocks into the key the screen reads', () => {
    const { client } = setup();

    emit('timed-reservations:updated', {
      date: DATE,
      parkingSpotId: 'spot-a',
      timedReservations: [
        {
          id: 'timed-1',
          startTime: '09:00',
          endTime: '10:30',
          guestName: 'Jan Host',
          licensePlate: null,
          createdAt: '2026-09-01T08:00:00.000Z',
        },
      ],
    });

    const cached = client.getQueryData<DayOverviewOutput>(dayKey(DATE));
    expect(cached?.spots[0]?.timedReservations).toHaveLength(1);
  });

  it('patches a created reservation into the key the screen reads', () => {
    const { client } = setup();

    emit('reservation:created', {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', STRANGER),
    });

    expect(readDay(client)?.spots[0]?.reservation?.id).toBe('res-1');
  });

  it('patches a cancellation, a reassignment and a waitlist count', () => {
    const { client } = setup({
      seed: dayOverview({
        spots: [
          row('spot-a', { reservation: publicReservation('res-1', STRANGER) }),
          row('spot-b', { reservation: publicReservation('res-2', STRANGER), waitlistCount: 1 }),
        ],
      }),
    });

    emit('reservation:cancelled', {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservationId: 'res-1',
    });
    expect(readDay(client)?.spots[0]?.reservation).toBeNull();

    emit('reservation:reassigned', {
      date: DATE,
      parkingSpotId: 'spot-b',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-2',
      reservation: publicReservation('res-3', STRANGER),
      fromWaitlistEntryId: 'wait-1',
    });
    expect(readDay(client)?.spots[1]?.reservation?.id).toBe('res-3');

    emit('waitlist:updated', { date: DATE, parkingSpotId: 'spot-b', waitlistCount: 4 });
    expect(readDay(client)?.spots[1]?.waitlistCount).toBe(4);
  });

  it('leaves another day’s cache entry alone', () => {
    const { client } = setup();
    client.setQueryData(dayKey(OTHER_DATE), dayOverview({ date: OTHER_DATE }));

    emit('reservation:created', {
      date: OTHER_DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', STRANGER),
    });

    // The hook is watching DATE. An event for another day — which a client in
    // several rooms genuinely receives — must not be written under this key…
    expect(readDay(client)?.spots[0]?.reservation).toBeNull();
    // …nor under the other one, which this hook does not own.
    expect(readDay(client, OTHER_DATE)?.spots[0]?.reservation).toBeNull();
  });

  it('does nothing at all when the day is not cached', () => {
    const { client, invalidate } = setup({ seed: null });

    emit('reservation:created', {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', VIEWER),
    });

    expect(readDay(client)).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

/**
 * Task 25's named risk: changing the day on screen moves **both** the
 * realtime room and the query-cache key, and a client that forgets the first
 * half quietly keeps listening — and keeps a socket-side room membership —
 * for a day nobody is looking at any more.
 */
describe('useLotRealtime — the room and the query key both follow the day', () => {
  it('unsubscribes from the old room when the day changes', () => {
    const { rerender, viewerUserId } = setup();

    rerender(<Harness date={OTHER_DATE} viewerUserId={viewerUserId} />);

    expect(roomEvents).toEqual([
      { type: 'join', date: DATE },
      { type: 'leave', date: DATE },
      { type: 'join', date: OTHER_DATE },
    ]);
  });

  it('patches the new day’s cache entry after the day changes, not the old one', () => {
    const { client, rerender, viewerUserId } = setup();
    client.setQueryData(
      dayKey(OTHER_DATE),
      dayOverview({ date: OTHER_DATE, spots: [row('spot-c')] })
    );

    rerender(<Harness date={OTHER_DATE} viewerUserId={viewerUserId} />);

    emit('reservation:created', {
      date: OTHER_DATE,
      parkingSpotId: 'spot-c',
      reservation: publicReservation('res-9', STRANGER),
    });

    // The event lands under the day now on screen…
    expect(readDay(client, OTHER_DATE)?.spots[0]?.reservation?.id).toBe('res-9');
    // …and the entry for the day the client left behind is untouched.
    expect(readDay(client, DATE)?.spots[0]?.reservation).toBeNull();
  });
});

describe('useLotRealtime — when a patch is not enough', () => {
  function invalidationsOfDay(invalidate: jest.SpyInstance) {
    return invalidate.mock.calls.filter(
      (call) =>
        JSON.stringify((call[0] as { queryKey?: unknown } | undefined)?.queryKey) ===
        JSON.stringify(dayKey(DATE))
    );
  }

  it('refetches when the caller becomes the holder, because canReserve moved', () => {
    const { invalidate } = setup();

    emit('reservation:created', {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', VIEWER),
    });

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('does not refetch when a stranger takes a spot — the patch said everything', () => {
    const { invalidate } = setup();

    emit('reservation:created', {
      date: DATE,
      parkingSpotId: 'spot-a',
      reservation: publicReservation('res-1', STRANGER),
    });

    expect(invalidationsOfDay(invalidate)).toHaveLength(0);
  });

  it('refetches when the caller is merely queued for a cell whose queue moved', () => {
    // Nothing in `waitlist:updated` says where the caller now stands — the
    // contract forbids it from saying so — and the patch cannot invent it.
    const { invalidate } = setup({
      seed: dayOverview({
        spots: [row('spot-a', { viewerWaitlistEntryId: 'wait-7', viewerWaitlistPosition: 2 })],
      }),
    });

    emit('waitlist:updated', { date: DATE, parkingSpotId: 'spot-a', waitlistCount: 5 });

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('does not refetch a queue the caller is not in', () => {
    const { invalidate } = setup();
    emit('waitlist:updated', { date: DATE, parkingSpotId: 'spot-a', waitlistCount: 5 });
    expect(invalidationsOfDay(invalidate)).toHaveLength(0);
  });

  it('refetches for the caller who lost a spot to auto-promotion', () => {
    const { invalidate } = setup({
      seed: dayOverview({
        viewerReservationId: 'res-1',
        spots: [row('spot-a', { reservation: publicReservation('res-1', VIEWER) })],
      }),
    });

    emit('reservation:reassigned', {
      date: DATE,
      parkingSpotId: 'spot-a',
      cause: 'WAITLIST_PROMOTION',
      previousReservationId: 'res-1',
      reservation: publicReservation('res-2', STRANGER),
      fromWaitlistEntryId: 'wait-1',
    });

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('refetches when the caller’s own reservation is cancelled elsewhere', () => {
    const { invalidate } = setup({
      seed: dayOverview({
        viewerReservationId: 'res-1',
        spots: [row('spot-a', { reservation: publicReservation('res-1', VIEWER) })],
      }),
    });

    emit('reservation:cancelled', { date: DATE, parkingSpotId: 'spot-a', reservationId: 'res-1' });

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });
});

/**
 * The gap nothing used to close.
 *
 * The four handlers above patch the cache from broadcasts. A broadcast
 * published while the socket is down is not queued anywhere and never
 * arrives — and `libs/query` sets `refetchOnWindowFocus: false` and a 30 s
 * `staleTime`, while TanStack's `refetchOnReconnect` keys off
 * `navigator.onLine`, which says nothing about an API restart, a proxy idle
 * timeout or a laptop resume. So the grid kept drawing spots as free that had
 * been taken during the gap, silently, until the user changed the date.
 *
 * Every assertion here is about `invalidateQueries` because that *is* the
 * behaviour: the hook does not fetch, it tells the cache the entry is stale
 * and lets the screen's own query re-run. Counting them against the
 * contract-derived key (`invalidationsOfDay`) is what makes an invalidation
 * under some other key fail rather than pass.
 */
describe('useLotRealtime — reconciling after the socket comes back', () => {
  function invalidationsOfDay(invalidate: jest.SpyInstance, date = DATE) {
    return invalidate.mock.calls.filter(
      (call) =>
        JSON.stringify((call[0] as { queryKey?: unknown } | undefined)?.queryKey) ===
        JSON.stringify(dayKey(date))
    );
  }

  it('refetches the day when the connection is regained after a drop', () => {
    const { invalidate, flipStatus } = setup();
    expect(invalidationsOfDay(invalidate)).toHaveLength(0);

    flipStatus('disconnected');
    expect(invalidationsOfDay(invalidate)).toHaveLength(0);

    flipStatus('connected');
    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('refetches after a refused handshake is recovered, not only after a transport drop', () => {
    // `rejected` is a different thing to *tell the user* — it has a reconnect
    // button — but the same thing for the cache: broadcasts were missed.
    const { invalidate, flipStatus } = setup();

    flipStatus('rejected');
    flipStatus('connecting');
    flipStatus('connected');

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('refetches once per reconnect, not once per render while connected', () => {
    const { invalidate, flipStatus } = setup();

    flipStatus('disconnected');
    flipStatus('connected');
    flipStatus('connected');
    flipStatus('connected');

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('refetches again on a second drop', () => {
    const { invalidate, flipStatus } = setup();

    flipStatus('disconnected');
    flipStatus('connected');
    flipStatus('disconnected');
    flipStatus('connected');

    expect(invalidationsOfDay(invalidate)).toHaveLength(2);
  });

  it('closes the page-load gap: a cold mount refetches once the socket is up', () => {
    // `RealtimeProvider` starts at `disconnected`, so this is what an ordinary
    // page load looks like. The overview is fetched before the handshake
    // finishes, and anything broadcast in between would otherwise be lost —
    // the same hole as any later drop, just at the start.
    const { invalidate, flipStatus } = setup({ status: 'disconnected' });
    expect(invalidationsOfDay(invalidate)).toHaveLength(0);

    flipStatus('connecting');
    flipStatus('connected');

    expect(invalidationsOfDay(invalidate)).toHaveLength(1);
  });

  it('does not refetch when it mounts under a socket that is already connected', () => {
    // Navigating from `/settings` back to `/`: the provider's socket never
    // went anywhere, so nothing was missed and a refetch would be waste.
    const { invalidate } = setup({ status: 'connected' });
    expect(invalidationsOfDay(invalidate)).toHaveLength(0);
  });

  it('refetches the day now on screen, not the one that was on screen when the socket dropped', () => {
    const { invalidate, flipStatus, client } = setup();
    client.setQueryData(dayKey(OTHER_DATE), dayOverview({ date: OTHER_DATE }));

    flipStatus('disconnected');
    flipStatus('connected', OTHER_DATE);

    expect(invalidationsOfDay(invalidate, OTHER_DATE)).toHaveLength(1);
    expect(invalidationsOfDay(invalidate, DATE)).toHaveLength(0);
  });

  it('invalidates nothing while there is no day on screen', () => {
    const { invalidate, flipStatus } = setup({ date: null, seed: null });

    flipStatus('disconnected', null);
    flipStatus('connected', null);

    expect(invalidate).not.toHaveBeenCalled();
  });
});
