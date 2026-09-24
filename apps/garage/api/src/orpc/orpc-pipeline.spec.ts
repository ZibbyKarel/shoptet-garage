/**
 * The oRPC transport through the **assembled** application, driven with real
 * HTTP and real tokens.
 *
 * Everything worth asserting about this layer is a property of the composition
 * and invisible to a unit test that calls a service directly:
 *
 * - **The wire format.** Nest's body parser consumes the request stream before
 *   the route handler runs, so the oRPC codec has to read `req.body`. If that
 *   assumption is wrong the request hangs or decodes to nothing — and it cannot
 *   be checked by reasoning about `@orpc/standard-server-node`'s source, only by
 *   sending a real request.
 * - **`@Roles('ADMIN')`.** The guard is global, registered in `AppModule` after
 *   `JwtAuthGuard`; whether it actually fires for a procedure depends on the
 *   decorator being on the route that oRPC's handler sits behind.
 * - **The RPC envelope on a rejection.** A domain error raised inside a
 *   procedure is serialised by oRPC, and so is a `FORBIDDEN` from `RolesGuard`,
 *   which `ContractExceptionFilter` maps: both arrive in the `{ json, meta }`
 *   wrapper `@orpc/client` reads, and the 403 assertions below check that
 *   shape, not just the status.
 *
 *   A **401** does not. An unauthenticated request comes back as Nest's own
 *   `{"statusCode":401,"message":"Unauthorized"}`, with no `{ json, meta }`
 *   wrapper, so the client falls back to deriving a code from the HTTP status
 *   (`doc/decision/0039-*`). Stated here rather than glossed: this suite
 *   asserts the envelope for 403 and only the status for 401.
 *
 * The database is `PrismaDouble` and the issuer is the same in-process OIDC
 * server `auth-pipeline.spec.ts` uses, so this suite runs anywhere — what it is
 * testing is the composition, not the storage. What the *database* does is
 * `src/database/database-contract.db.spec.ts`, which needs a real PostgreSQL and
 * runs under a separate target. Nothing in `src` knows either exists.
 */

import { isContractProcedure } from '@orpc/contract';
import { contract } from '@garage/contract';
import { PrismaService } from '../database/prisma.service';
import type { OidcTestIssuer, TestSigningKey } from '../auth/testing/oidc-test-issuer';
import { createSigningKey, startOidcTestIssuer } from '../auth/testing/oidc-test-issuer';
import { signTestToken } from '../auth/testing/sign-test-token';
import { PrismaDouble } from '../testing/prisma-double';
import type { ApiTestApp } from '../testing/nest-test-app';
import { AUDIENCE, startApiTestApp } from '../testing/nest-test-app';

interface RpcResponse {
  status: number;
  body: { json?: unknown; meta?: unknown } & Record<string, unknown>;
}

/**
 * Every `admin.*` procedure in the contract, as a dotted name.
 *
 * Read off the contract rather than listed by hand, so the sweep below cannot
 * quietly stop covering a procedure that was added later. Same walker as
 * `orpc-route-parity.spec.ts`, restricted to the admin branch.
 */
function adminProcedureNames(node: unknown, prefix: string[] = []): string[] {
  if (isContractProcedure(node)) {
    return prefix[0] === 'admin' ? [prefix.join('.')] : [];
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    adminProcedureNames(child, [...prefix, key])
  );
}

describe('the oRPC transport through the assembled application', () => {
  let harness: ApiTestApp;
  let issuer: OidcTestIssuer;
  let signingKey: TestSigningKey;
  let double: PrismaDouble;
  const originalEnv = { ...process.env };

  function tokenFor(subject: string): string {
    return signTestToken({ key: signingKey, issuer: issuer.issuer, audience: AUDIENCE, subject });
  }

  /** Posts exactly what `RPCLink` posts: `{ json, meta }` to `/api/rpc/<path>`. */
  async function call(procedure: string, input: unknown, token?: string): Promise<RpcResponse> {
    const response = await fetch(`${harness.baseUrl}/api/rpc/${procedure.split('.').join('/')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ json: input, meta: [] }),
    });
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    signingKey = createSigningKey('key-1');
    issuer = await startOidcTestIssuer([signingKey]);

    double = new PrismaDouble();

    harness = await startApiTestApp({ issuer, store: double });
  });

  afterAll(async () => {
    await harness?.close();
    await issuer?.close();
    process.env = originalEnv;
  });

  beforeEach(() => {
    double.reset();
    double.seedWindowSettings({ openDaysBefore: 7, lockMode: 'AUTO' });
    double.seedLimitSettings({ monthlyReservationCap: 5 });
    double.seedUser({ oktaId: 'okta-admin', email: 'admin@example.test', role: 'ADMIN' });
    double.seedUser({ oktaId: 'okta-user', email: 'user@example.test' });
  });

  describe('a procedure any authenticated user may call', () => {
    it('decodes the RPC body, runs the handler and answers in the envelope', async () => {
      double.seedSpot({ label: 'A1', group: 'SHARED' });

      const response = await call('spot.list', undefined, tokenFor('okta-user'));

      expect(response.status).toBe(200);
      // No `meta` key: oRPC drops it when there are no type annotations to
      // carry, and the client defaults it back to `[]`.
      expect(response.body).toEqual({
        json: { spots: [expect.objectContaining({ label: 'A1', active: true })] },
      });
    });

    it('carries a real input through the contract’s schema into the handler', async () => {
      const response = await call('overview.day', { date: '2026-10-15' }, tokenFor('okta-user'));

      expect(response.status).toBe(200);
      expect(response.body.json).toMatchObject({
        date: '2026-10-15',
        window: { month: '2026-10', lockMode: 'AUTO' },
      });
    });

    it('rejects an input the contract’s schema refuses, without reaching the service', async () => {
      const response = await call('overview.day', { date: 'not-a-date' }, tokenFor('okta-user'));

      expect(response.status).toBe(400);
    });
  });

  describe('an unauthenticated call', () => {
    it('is refused before any handler runs', async () => {
      const response = await call('spot.list', undefined);

      expect(response.status).toBe(401);
    });
  });

  describe('@Roles(ADMIN) on an oRPC route', () => {
    it('refuses an ordinary user with the contract’s FORBIDDEN, in the RPC envelope', async () => {
      const response = await call(
        'admin.spot.list',
        { includeInactive: true },
        tokenFor('okta-user')
      );

      expect(response.status).toBe(403);
      // Written by `ContractExceptionFilter` (the guard runs before the oRPC
      // handler), and it has to be the same shape oRPC itself emits — the two
      // assertions above and below are the comparison.
      expect(response.body).toEqual({
        json: expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      });
    });

    it('never runs the handler for a refused caller', async () => {
      double.seedSpot({ label: 'A1' });

      await call('admin.spot.create', { label: 'B1', group: 'IT' }, tokenFor('okta-user'));

      expect(double.spots.map((spot) => spot.label)).toEqual(['A1']);
      expect(double.auditLogs).toHaveLength(0);
    });

    /**
     * The two assertions above pin `admin.spot.list` and `admin.spot.create`.
     * They say nothing about the other seven admin procedures, and the failure
     * this whole section exists to catch — one route whose `@Roles('ADMIN')`
     * was never written, or was lost in an edit — is by definition on a
     * procedure nobody thought to test.
     *
     * `orpc-route-parity.spec.ts` reads the decorator off Nest's metadata,
     * which is close but not the same claim: metadata being present is not the
     * guard running. This drives every one of them over real HTTP with a real
     * non-admin token and requires a real 403.
     *
     * The list is checked against the contract below, so an admin procedure
     * added without a row here fails rather than being silently skipped.
     */
    const ADMIN_CALLS: Record<string, () => unknown> = {
      'admin.spot.list': () => ({ includeInactive: true }),
      'admin.spot.create': () => ({ label: 'FORBIDDEN-1', group: 'IT' }),
      'admin.spot.update': () => ({ id: double.spots[0]?.id, label: 'FORBIDDEN-2' }),
      'admin.spot.deactivate': () => ({ id: double.spots[0]?.id }),
      'admin.user.list': () => ({}),
      'admin.user.update': () => ({ id: double.users[0]?.id, role: 'ADMIN' }),
      'admin.window.get': () => undefined,
      'admin.window.update': () => ({ openDaysBefore: 21, lockMode: 'FORCE_OPEN' }),
      'admin.window.months': () => ({ from: '2026-09', to: '2026-10' }),
      'admin.reservationLimits.get': () => undefined,
      'admin.reservationLimits.update': () => ({ monthlyReservationCap: 9 }),
      'admin.reservation.month': () => ({ userId: double.users[0]?.id, month: '2026-09' }),
      'admin.timedReservation.create': () => ({
        parkingSpotId: double.spots[0]?.id,
        date: '2026-10-05',
        startTime: '09:00',
        endTime: '10:00',
        guestName: 'FORBIDDEN',
        licensePlate: null,
      }),
      'admin.timedReservation.cancel': () => ({
        timedReservationId: '0192f5f0-0000-7000-8000-00000000abcd',
      }),
    };

    it('lists exactly the admin procedures the contract declares', () => {
      // Without this, adding `admin.something.new` and forgetting to add it
      // below would leave it untested while every assertion still passed.
      const declared = adminProcedureNames(contract);

      expect(declared.length).toBeGreaterThan(0);
      expect(Object.keys(ADMIN_CALLS).sort()).toEqual([...declared].sort());
    });

    it.each(Object.keys(ADMIN_CALLS).sort())(
      'refuses a non-admin on %s, over real HTTP',
      async (procedure) => {
        double.seedSpot({ label: 'A1', group: 'IT' });
        const before = {
          spots: double.spots.map((spot) => ({ ...spot })),
          users: double.users.map((user) => ({ ...user })),
          settings: { ...double.windowSettings },
          limits: { ...double.limitSettings },
        };

        const response = await call(procedure, ADMIN_CALLS[procedure]?.(), tokenFor('okta-user'));

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          json: expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
        });

        // A refused *read* returning data would be as bad as a refused write
        // landing, so the body is checked for the shape of an answer too.
        expect(response.body.json).not.toHaveProperty('spots');
        expect(response.body.json).not.toHaveProperty('users');

        // Nothing moved. `admin.window.update` in particular would otherwise
        // have flipped `lockMode` for every user in the company.
        expect(double.spots).toEqual(before.spots);
        expect(double.users).toEqual(before.users);
        expect(double.windowSettings).toEqual(before.settings);
        // `admin.reservationLimits.update` would otherwise have changed how
        // much every user in the company may book.
        expect(double.limitSettings).toEqual(before.limits);
        expect(double.auditLogs).toHaveLength(0);
      }
    );

    it('lets an admin through, and the mutation reaches the database and the audit log', async () => {
      const response = await call(
        'admin.spot.create',
        { label: 'E2.92', group: 'IT' },
        tokenFor('okta-admin')
      );

      expect(response.status).toBe(200);
      expect(response.body.json).toMatchObject({ label: 'E2.92', group: 'IT' });
      expect(double.spots.map((spot) => spot.label)).toEqual(['E2.92']);
      expect(double.auditLogs).toEqual([
        expect.objectContaining({ action: 'SPOT_UPDATED', entityType: 'ParkingSpot' }),
      ]);
    });
  });

  describe('a domain error raised inside a procedure', () => {
    it('comes back with its contract code, enveloped, not as a 500', async () => {
      const spot = double.seedSpot({ label: 'A1' });
      const holder = double.seedUser({ oktaId: 'okta-holder', email: 'holder@example.test' });
      double.seedReservation({
        parkingSpotId: spot.id,
        userId: holder.id,
        // Far enough ahead that this stays "from today onwards" for good.
        date: '2099-01-01',
      });

      const response = await call('admin.spot.deactivate', { id: spot.id }, tokenFor('okta-admin'));

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        json: expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      });
    });

    it('turns a unique-constraint violation into the contract code, not a 500', async () => {
      double.seedSpot({ label: 'E2.92' });

      const response = await call(
        'admin.spot.create',
        { label: 'E2.92', group: 'IT' },
        tokenFor('okta-admin')
      );

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ json: { code: 'CONFLICT' } });
    });
  });

  /**
   * "Stack traces are logged, never sent to the client" is a binding constraint,
   * and until now it was an observation rather than a test: the filter's own spec
   * proves it for errors the *filter* renders, but an error thrown inside a
   * procedure never reaches the filter — `implementer.ts` rethrows what it cannot
   * map, and oRPC writes the 500 itself. That body was unguarded.
   */
  describe('an unexpected failure inside a procedure', () => {
    const SECRET = 'connection to db-primary-7 refused for user garage';

    /** Replaces one delegate method with a thrower, and restores it after. */
    async function whileFailing<T>(run: () => Promise<T>): Promise<T> {
      const client = (
        harness.app.get(PrismaService) as unknown as { client: Record<string, never> }
      ).client as unknown as { parkingSpot: { findMany: unknown } };
      const original = client.parkingSpot.findMany;
      client.parkingSpot.findMany = () => {
        throw new TypeError(SECRET);
      };
      try {
        return await run();
      } finally {
        client.parkingSpot.findMany = original;
      }
    }

    it('answers 500 and tells the client nothing about the cause', async () => {
      const response = await whileFailing(() =>
        call('spot.list', undefined, tokenFor('okta-user'))
      );

      expect(response.status).toBe(500);
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain('db-primary-7');
      // No frames, no file paths, no class name of the thing that broke.
      expect(serialised).not.toContain('TypeError');
      expect(serialised).not.toContain('.ts:');
      expect(serialised).not.toContain('at ');
    });

    it('still speaks the RPC envelope, so the client can read it at all', async () => {
      const response = await whileFailing(() =>
        call('spot.list', undefined, tokenFor('okta-user'))
      );

      expect(response.body).toEqual({
        json: expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }),
      });
    });

    it('recovers — the thrower is not sticky', async () => {
      await whileFailing(() => call('spot.list', undefined, tokenFor('okta-user')));
      double.seedSpot({ label: 'A1' });

      const response = await call('spot.list', undefined, tokenFor('okta-user'));

      expect(response.status).toBe(200);
    });
  });

  describe('a route that is mounted really reaches its service', () => {
    it('a URL naming no procedure at all is a 404', async () => {
      // The contract's procedures are now all mounted (`NOT_YET_IMPLEMENTED` in
      // `orpc-route-parity.spec.ts` is empty), so the "declared but unmounted"
      // case this used to cover no longer exists. What still has to hold is the
      // other direction: an RPC path oRPC cannot match is a 404 rather than a
      // request Nest holds open forever, which is the throw in
      // `RpcRouteHandler.handle`.
      const response = await call('reservation.notAProcedure', {}, tokenFor('okta-user'));

      expect(response.status).toBe(404);
    });

    it('Task 30’s bulk route reaches the bulk service', async () => {
      // Same assertion as the case below, for the pair that was unmounted until
      // Task 30: a domain answer rather than a 404 proves the route exists, the
      // guard let an ordinary user through, oRPC decoded the body against
      // `bulkBookingInputSchema`, and `BulkReservationService` got as far as the
      // window rule.
      const response = await call(
        'reservation.previewBulk',
        { dates: ['2099-01-05'] },
        tokenFor('okta-user')
      );

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        json: expect.objectContaining({ code: 'OUT_OF_HORIZON' }),
      });
    });

    it('and so does Task 13’s reservation route', async () => {
      // A domain answer rather than a 404 is the whole assertion: the route
      // exists, the guard let an ordinary user through, oRPC decoded the body,
      // and `ReservationsService` got as far as the window rule. 2099-01 is
      // nowhere near the `openDaysBefore: 7` window seeded in `beforeEach`, so
      // the service answers `OUT_OF_HORIZON` (422) rather than reserving
      // anything — asserted on the exact status and code, not merely "not a
      // 404", so a regression to a 500 (unmapped error) fails this test too.
      const response = await call(
        'reservation.create',
        { parkingSpotId: '11111111-1111-4111-8111-111111111111', date: '2099-01-05' },
        tokenFor('okta-user')
      );

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        json: expect.objectContaining({ code: 'OUT_OF_HORIZON' }),
      });
    });
  });
});
