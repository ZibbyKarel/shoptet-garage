/**
 * The routing table and the contract must not drift.
 *
 * Each contract procedure is mounted on its own Nest route so that `@Roles()`
 * and `@CurrentUser()` keep working (`rpc-route-handler.ts`). The price of that
 * is a path written out in a decorator, and a path written by hand is a path
 * that can be wrong. This file is what makes it not be:
 *
 * - every registered RPC route names a procedure that exists in `libs/garage/contract`;
 * - every procedure Task 12 implements has exactly one route;
 * - every procedure it does not implement has **none** — so a half-added Task 13
 *   procedure fails here rather than answering 404 in production;
 * - every `admin.*` route carries `@Roles('ADMIN')` and no other route does;
 * - and, separately, that **the compiled application** registers no HTTP route
 *   at all beyond those procedures and a named allow-list.
 *
 * The `@Roles()` one is the reason this file is worth more than a lint rule. The
 * authorization of this API is a list of decorators; nothing else in the
 * codebase would notice one going missing.
 *
 * ## Why the last bullet is a separate describe
 *
 * Everything above it reads {@link CONTROLLERS}, a hand-maintained literal. That
 * is right for "every procedure has exactly one route" — the claim is about
 * those controllers — but the final review found a test titled *"registers no
 * route that the contract does not declare"* making a **global** claim off that
 * same list, and the Nx scaffold's `AppController` (`GET /api` →
 * `{"message":"Hello API"}`) sailed through it for not being in the list. The
 * controller is gone (`doc/decision/0239-*`); the missing check is the part that
 * would have caught the next one, and it can only come from the composed
 * application, so `the compiled application` below boots `AppModule` and
 * enumerates what Nest actually registered.
 */

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { NestContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { isContractProcedure } from '@orpc/contract';
import { contract } from '@garage/contract';
import type { UserRole } from '@garage/contract';
import { ROLES_KEY } from '../auth/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { MeController } from '../me/me.controller';
import { OverviewController } from '../overview/overview.controller';
import { ReservationLimitsController } from '../reservation-limits/reservation-limits.controller';
import { ReservationWindowController } from '../reservation-window/reservation-window.controller';
import { BulkReservationController } from '../reservations/bulk-reservation.controller';
import { ReservationsController } from '../reservations/reservations.controller';
import { WaitlistController } from '../reservations/waitlist.controller';
import { SpotsController } from '../spots/spots.controller';
import { TimedReservationsController } from '../timed-reservations/timed-reservations.controller';
import { UsersController } from '../users/users.controller';
import { RPC_ROUTE_PREFIX } from './rpc-route';

/**
 * The procedures still to come. Listing them here rather than deriving
 * "everything else" is deliberate: a task that lands shrinks this list in the
 * same commit that adds its routes, and the assertions below force that to
 * happen together.
 *
 * Task 13 removed the four single-day procedures; Task 30 removed the bulk pair.
 * The list is empty, and that is a state the assertions have to keep working in
 * — "every procedure has exactly one route" is now the whole claim.
 */
const NOT_YET_IMPLEMENTED: string[] = [];

const CONTROLLERS = [
  SpotsController,
  UsersController,
  MeController,
  ReservationWindowController,
  ReservationLimitsController,
  OverviewController,
  ReservationsController,
  WaitlistController,
  BulkReservationController,
  TimedReservationsController,
];

interface RegisteredRoute {
  /** Dotted procedure name, e.g. `admin.spot.list`. */
  procedure: string;
  method: RequestMethod;
  roles: readonly UserRole[] | undefined;
}

/** Every procedure in the contract, as a dotted name. */
function contractProcedures(node: unknown, prefix: string[] = []): string[] {
  if (isContractProcedure(node)) {
    return [prefix.join('.')];
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    contractProcedures(child, [...prefix, key])
  );
}

/** Every route the five controllers register, read off Nest's own metadata. */
function registeredRoutes(): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];

  for (const controller of CONTROLLERS) {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string;
    expect(controllerPath).toBe(RPC_ROUTE_PREFIX);

    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (typeof handler !== 'function' || name === 'constructor') {
        continue;
      }
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) {
        continue;
      }
      routes.push({
        procedure: path.split('/').join('.'),
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        roles: Reflect.getMetadata(ROLES_KEY, handler) as readonly UserRole[] | undefined,
      });
    }
  }

  return routes;
}

describe('the RPC routing table', () => {
  const procedures = contractProcedures(contract);
  const routes = registeredRoutes();

  it('finds the contract’s procedures — otherwise every assertion below is vacuous', () => {
    // Without this, a walker that returned `[]` would make the set comparisons
    // trivially true against an equally empty route list.
    expect(procedures).toContain('admin.spot.list');
    expect(procedures.length).toBeGreaterThan(15);
    expect(routes.length).toBeGreaterThan(10);
  });

  it('registers no RPC route that the contract does not declare', () => {
    expect(routes.map((route) => route.procedure).sort()).toEqual(
      routes
        .map((route) => route.procedure)
        .filter((name) => procedures.includes(name))
        .sort()
    );
  });

  it('registers exactly one route per implemented procedure, and none per pending one', () => {
    const expected = procedures.filter((name) => !NOT_YET_IMPLEMENTED.includes(name)).sort();

    expect(routes.map((route) => route.procedure).sort()).toEqual(expected);
  });

  it('lists only procedures that exist as not-yet-implemented', () => {
    for (const pending of NOT_YET_IMPLEMENTED) {
      expect(procedures).toContain(pending);
    }
  });

  it('mounts every procedure as POST, which is what RPCLink sends', () => {
    for (const route of routes) {
      expect(route.method).toBe(RequestMethod.POST);
    }
  });

  /**
   * The routing table above says a path is mounted. It cannot say the path runs
   * the procedure it names.
   *
   * `RPCHandler` dispatches on the URL, so what a request actually executes is
   * whatever sits at that key in the controller's router object — the delegating
   * method's name is decorative. Move `implementer.admin.spot.create.handler(…)`
   * one line up, into the `list` slot, and every assertion above still passes
   * while `admin.spot.list` creates spots.
   *
   * What distinguishes two sibling implementations is the contract procedure
   * each was built from. `implement()` carries the contract's own schema objects
   * through by reference, so identity comparison settles it with no machinery:
   * the leaf at `admin.spot.list` must hold the *same* schema objects as
   * `contract.admin.spot.list`.
   *
   * Limit worth stating: two procedures that share both schema objects — several
   * share `noInputSchema` — are indistinguishable to this check on their input
   * alone, which is why both schemas are compared and not just one.
   */
  describe('every route runs the procedure it names', () => {
    /** The `~orpc` definition both a contract procedure and an implemented one carry. */
    function definitionOf(node: unknown): { inputSchema?: unknown; outputSchema?: unknown } {
      const def = (node as Record<string, unknown> | null)?.['~orpc'];
      if (typeof def !== 'object' || def === null) {
        throw new Error('Not an oRPC procedure: no `~orpc` definition.');
      }
      return def as { inputSchema?: unknown; outputSchema?: unknown };
    }

    /** Every leaf of an implemented router, as a dotted name. */
    function routerLeaves(node: unknown, prefix: string[] = []): [string, unknown][] {
      if (typeof node !== 'object' || node === null) {
        return [];
      }
      if ('~orpc' in node) {
        return [[prefix.join('.'), node]];
      }
      return Object.entries(node).flatMap(([key, child]) => routerLeaves(child, [...prefix, key]));
    }

    /**
     * Builds each controller with stub collaborators and reads its router.
     *
     * Safe because nothing here calls a handler: the constructors only close
     * over the service, and `RpcRouteHandler` only uses the logger inside an
     * error interceptor. A real Nest context would prove nothing extra and would
     * need a database.
     */
    function implementedProcedures(): [string, unknown][] {
      const stub = undefined as never;
      return CONTROLLERS.flatMap((Controller) => {
        // The controllers do not all take the same number of collaborators, and
        // the list is going to keep growing, so the constructor is called
        // through a widened type with a stub per longest arity. Extra arguments
        // to a shorter constructor are simply ignored by JavaScript, and none of
        // these constructors reads what it is handed — see the note above.
        const construct = Controller as unknown as new (...args: never[]) => {
          rpc: { router: unknown };
        };
        const instance = new construct(stub, stub, stub);
        return routerLeaves(instance.rpc.router);
      });
    }

    const implemented = implementedProcedures();

    it('finds an implementation for every route, and no extras', () => {
      expect(implemented.map(([name]) => name).sort()).toEqual(
        routes.map((route) => route.procedure).sort()
      );
    });

    it.each(implemented.map(([name]) => name).sort())(
      '%s is built from its own contract procedure',
      (name) => {
        const [, implementation] = implemented.find(([candidate]) => candidate === name) ?? [];
        const declared = name
          .split('.')
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], contract);

        expect(definitionOf(implementation).inputSchema).toBe(definitionOf(declared).inputSchema);
        expect(definitionOf(implementation).outputSchema).toBe(definitionOf(declared).outputSchema);
      }
    );
  });

  /**
   * The global property the hand-maintained list above cannot state.
   *
   * `AppModule` is compiled for real — the same module `main.ts` boots — and
   * every controller Nest ended up with is read out of its container, rather
   * than out of a literal somebody has to remember to update. A route that
   * appears in neither the contract nor {@link NON_CONTRACT_ROUTES} fails here,
   * which is what "contract-first" means at the HTTP layer.
   *
   * The database is stubbed exactly as `app.module.spec.ts` stubs it:
   * `compile()` resolves the provider graph without running `onModuleInit`, so
   * nothing opens a connection, and the routing table is fully decided by then.
   */
  describe('the compiled application', () => {
    /**
     * The routes that legitimately exist outside the oRPC contract.
     *
     * Deliberately a literal, and deliberately *here*: these are exemptions,
     * and an exemption that is not visible is a hole. The ICS feed is a
     * browser/calendar-client subscription URL and cannot be an RPC POST
     * (`doc/decision/0080-*`); the two probes are excluded from the global
     * prefix so an orchestrator can reach them without knowing it.
     */
    const NON_CONTRACT_ROUTES = ['calendar/:icsToken.ics', 'health/live', 'health/ready'];

    const ENV = {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://garage:garage@localhost:5432/garage',
      AUTH_OKTA_ISSUER: 'http://localhost:8080/default',
      AUTH_OKTA_AUDIENCE: 'api://default',
      CORS_ALLOWED_ORIGINS: 'http://localhost:4200',
      LOG_LEVEL: 'fatal',
    };

    let registered: string[];
    const originalEnv = { ...process.env };
    let moduleRef: TestingModule | undefined;

    beforeAll(async () => {
      // `ConfigModule.forRoot({ validate })` runs at *import* time, so the
      // environment has to be in place before `AppModule` is loaded — the same
      // dynamic import `app.module.spec.ts` does, for the same reason.
      Object.assign(process.env, ENV);
      const { AppModule } = await import('../app/app.module');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue({ ping: jest.fn(), onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
        .compile();

      registered = routesOf(moduleRef);
    });

    afterAll(async () => {
      await moduleRef?.close();
      process.env = originalEnv;
    });

    /**
     * Every `method path` Nest registered, read from the compiled container.
     *
     * `getModules()` is how Nest itself walks what it built; the alternative —
     * digging into Express's router stack — is both more private and less
     * informative, because it has already lost which controller a path came
     * from.
     */
    function routesOf(compiled: TestingModule): string[] {
      const container = (compiled as unknown as { container: NestContainer }).container;
      const paths: string[] = [];

      for (const module of container.getModules().values()) {
        for (const wrapper of module.controllers.values()) {
          const controller = wrapper.metatype;
          if (typeof controller !== 'function') {
            continue;
          }
          const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
          const prototype = controller.prototype as Record<string, unknown>;
          for (const name of Object.getOwnPropertyNames(prototype)) {
            const handler = prototype[name];
            if (typeof handler !== 'function' || name === 'constructor') {
              continue;
            }
            const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
            if (path === undefined) {
              continue;
            }
            paths.push([base, path].filter((part) => part !== '' && part !== '/').join('/'));
          }
        }
      }
      return paths.sort();
    }

    it('found a routing table at all', () => {
      // The vacuity guard: an enumeration that returns nothing satisfies every
      // set assertion below for free.
      expect(registered.length).toBeGreaterThan(15);
      expect(registered).toContain('health/live');
      expect(registered).toContain(`${RPC_ROUTE_PREFIX}/admin/spot/list`);
    });

    it('registers no HTTP route the contract does not declare, bar a named allow-list', () => {
      const expected = [
        ...procedures.map((name) => `${RPC_ROUTE_PREFIX}/${name.split('.').join('/')}`),
        ...NON_CONTRACT_ROUTES,
      ].sort();

      expect(registered).toEqual(expected);
    });
  });

  describe('authorization', () => {
    it('guards every admin procedure with @Roles(ADMIN)', () => {
      const adminRoutes = routes.filter((route) => route.procedure.startsWith('admin.'));

      expect(adminRoutes.length).toBeGreaterThan(0);
      for (const route of adminRoutes) {
        expect(route.roles).toEqual(['ADMIN']);
      }
    });

    it('leaves every non-admin procedure open to any authenticated caller', () => {
      // `@Roles()` on, say, `overview.day` would lock the parking screen to
      // admins. Undecorated is the correct state, and it has to be asserted for
      // the same reason the decorated one does.
      const otherRoutes = routes.filter((route) => !route.procedure.startsWith('admin.'));

      expect(otherRoutes.length).toBeGreaterThan(0);
      for (const route of otherRoutes) {
        expect(route.roles).toBeUndefined();
      }
    });
  });
});
