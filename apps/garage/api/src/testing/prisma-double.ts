/**
 * An in-memory stand-in for `PrismaService`, for the domain services' unit
 * tests.
 *
 * Nothing **in this file** ever speaks to a real Postgres — that is what makes
 * it a double, not a statement about the project. The `*.db.spec.ts` suites do,
 * against PostgreSQL 17, under `nx run api:test-db` and in CI's own job
 * (`doc/decision/0206-*`), and they are where anything resting on the database's
 * actual behaviour belongs. This double is deliberately narrow: it implements
 * only the query shapes the Task 12 services actually issue, and it **fails
 * loudly** on anything else rather than quietly returning `[]`. A double that
 * silently answers a query it does not understand is how a test passes while the
 * code it covers is wrong.
 *
 * Two behaviours are modelled rather than stubbed, because a loose fake of
 * either would make the test that depends on it worthless:
 *
 * - **Unique constraints.** `ParkingSpot.label` and `User.icsToken` raise a real
 *   `Prisma.PrismaClientKnownRequestError` P2002 — in the shape this project's
 *   **driver adapter** produces, which is *not* the documented `meta.target`.
 *   See {@link uniqueViolation}: assuming `meta.target` is precisely the bug
 *   that shipped `SPOT_ALREADY_RESERVED` unreachable. `MeService`'s ICS-token
 *   retry loop exists for exactly that error.
 * - **`@db.Date` comparison.** A reservation's day is compared as the UTC
 *   midnight `Date` the pg adapter produces, so `date: { gte }` behaves the way
 *   `SpotsService.deactivate` assumes.
 *
 * What it cannot prove is stated in the task report: this is a faithful model of
 * the constraints, not the constraints.
 *
 * Spec-only support code, excluded from `tsconfig.app.json`.
 */

import { randomUUID } from 'node:crypto';
import type {
  AuditLog as AuditLogRow,
  ParkingSpot as ParkingSpotRow,
  Reservation as ReservationRow,
  ReservationLimitSettings as LimitSettingsRow,
  ReservationWindowSettings as WindowSettingsRow,
  TimedReservation as TimedReservationRow,
  User as UserRow,
  WaitlistEntry as WaitlistEntryRow,
} from '@garage/database';
import { Prisma } from '@garage/database';
import type { PrismaService } from '../database/prisma.service';

const CLIENT_VERSION = '7.10.0';

/**
 * A `P2002` in the shape `@prisma/adapter-pg` actually produces.
 *
 * This function used to emit `meta: { target: [...] }`, which is what Prisma
 * *documents* and what the query-engine client emits — but not what this
 * project's driver adapter emits. Nothing here failed; the filter's mapping was
 * green against a shape reality never sends, so every real unique violation
 * degraded to `CONFLICT` and `SPOT_ALREADY_RESERVED` could not fire at all.
 *
 * The shape below is transcribed from a live PostgreSQL 17 and is re-asserted
 * against one on every `nx run api:test-db`
 * (`src/database/database-contract.db.spec.ts`). If Prisma changes it, that
 * suite fails and this constructor is what has to be corrected — which is the
 * arrangement that was missing.
 */
function uniqueViolation(table: string, column: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${column}\`)`,
    {
      code: 'P2002',
      clientVersion: CLIENT_VERSION,
      meta: {
        modelName: table,
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index: `${table}_${column}_key` },
            table,
          },
        },
      },
    }
  );
}

function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
    code: 'P2025',
    clientVersion: CLIENT_VERSION,
  });
}

/**
 * Applies the one `orderBy` shape this double understands —
 * `[{ date: 'asc' }, { id: 'asc' }]` — and **only** when it was asked for.
 *
 * Anything else is refused rather than silently ignored: an unrecognised
 * ordering that quietly fell back to "sorted anyway" is how a missing `orderBy`
 * in production code goes unnoticed.
 */
function sortedByDateThenId<T extends { date: Date; id: string }>(
  rows: T[],
  orderBy: unknown
): T[] {
  if (orderBy === undefined) {
    return rows;
  }
  const expected = JSON.stringify([{ date: 'asc' }, { id: 'asc' }]);
  if (JSON.stringify(orderBy) !== expected) {
    return unsupported('this reservation ordering', orderBy);
  }
  return [...rows].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
}

/**
 * Orders spots the way the requested `orderBy` says, and refuses an ordering
 * it was not taught.
 *
 * The double used to sort by group-then-label unconditionally, whatever the
 * caller asked for. That is the same silent answer {@link sortedByDateThenId}
 * exists to prevent: `SlackNotificationService` asks for `{ label: 'asc' }`,
 * and a double that answered it in group order would let a test assert an
 * order production does not produce.
 */
function sortedSpots(rows: ParkingSpotRow[], orderBy: unknown): ParkingSpotRow[] {
  const requested = JSON.stringify(orderBy);
  if (requested === JSON.stringify([{ group: 'asc' }, { label: 'asc' }])) {
    return [...rows].sort(
      (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label)
    );
  }
  if (requested === JSON.stringify({ label: 'asc' })) {
    return [...rows].sort((a, b) => a.label.localeCompare(b.label));
  }
  if (orderBy === undefined) {
    return rows;
  }
  return unsupported('this parking spot ordering', orderBy);
}

/** Anything this double was not taught is a bug in the test, not an empty result. */
function unsupported(what: string, args: unknown): never {
  throw new Error(`PrismaDouble does not model ${what}: ${JSON.stringify(args)}`);
}

/**
 * Rows come out of a real Prisma client as fresh objects deserialised from the
 * driver, never as a live handle on stored state. Copying on the way out matters
 * for more than tidiness: a service that reads a row, mutates it and then
 * compares "before" against "after" would compare an object with itself if the
 * two were the same reference — and the test that caught this was asserting an
 * audit payload's before/after pair.
 */
function copy<T>(row: T): T {
  return { ...row };
}

export interface SpotSeed {
  id?: string;
  label: string;
  group?: ParkingSpotRow['group'];
  active?: boolean;
}

export interface UserSeed {
  id?: string;
  oktaId?: string;
  email?: string;
  name?: string;
  role?: UserRow['role'];
  active?: boolean;
  licensePlate?: string | null;
  icsToken?: string;
  preferredParkingSpotId?: string | null;
}

export interface ReservationSeed {
  id?: string;
  parkingSpotId: string;
  userId: string | null;
  guestName?: string | null;
  licensePlate?: string | null;
  /** `YYYY-MM-DD`. */
  date: string;
  createdAt?: Date;
}

export interface WaitlistSeed {
  id?: string;
  parkingSpotId: string;
  userId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  createdAt?: Date;
}

export interface TimedReservationSeed {
  id?: string;
  parkingSpotId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  startMinute: number;
  endMinute: number;
  guestName?: string;
  licensePlate?: string | null;
  createdAt?: Date;
}

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * The only id `ReservationWindowSettings` ever has — the table is a singleton,
 * and `RESERVATION_WINDOW_SETTINGS_ID` in the service is this same 1. Spelled
 * out here rather than imported so the double keeps depending on nothing it
 * stands in for.
 */
const WINDOW_SETTINGS_ID = 1;

/**
 * The only id `ReservationLimitSettings` ever has. Its own constant rather than
 * a reuse of {@link WINDOW_SETTINGS_ID}: the two tables happen to share the
 * number 1, and a single constant would make one table's id depend on the
 * other's. Spelled out here for the same reason the window one is.
 */
const LIMIT_SETTINGS_ID = 1;

export class PrismaDouble {
  readonly spots: ParkingSpotRow[] = [];
  readonly users: UserRow[] = [];
  readonly reservations: ReservationRow[] = [];
  readonly waitlist: WaitlistEntryRow[] = [];
  readonly timedReservations: TimedReservationRow[] = [];
  readonly auditLogs: AuditLogRow[] = [];
  /**
   * How many `auditLog.createMany` statements were issued.
   *
   * `AuditLogService.recordMany` promises one statement rather than one per
   * row — that is its whole reason to exist — and promises *no* statement for
   * an empty list. Neither claim is visible in {@link auditLogs}, so it is
   * counted here.
   */
  auditLogCreateManyCalls = 0;
  windowSettings: WindowSettingsRow | null = null;
  limitSettings: LimitSettingsRow | null = null;

  /**
   * How many of the next `user.update` calls carrying an `icsToken` should be
   * rejected with P2002.
   *
   * A generated token cannot be made to collide from the outside — that is the
   * point of 32 bytes of `randomBytes` — so the collision has to be induced at
   * the layer that would actually detect it: the unique index. This is the same
   * error Postgres raises, at the same moment, which is what `MeService`'s retry
   * loop is written against.
   */
  icsTokenCollisions = 0;

  /**
   * Empties every collection and counter the double owns, so one spec's rows
   * cannot reach the next test.
   *
   * It exists so a caller does not have to know the complete list of tables
   * modelled here — the three specs that used to clear five arrays by hand
   * would each have silently kept a sixth. `RecordingPublisher.reset()` in
   * `testing/database/reservation-harness.ts` is the same idiom. Seeding stays
   * the caller's job: reset says what is *not* there, never what is.
   */
  reset(): void {
    this.spots.length = 0;
    this.users.length = 0;
    this.reservations.length = 0;
    this.waitlist.length = 0;
    this.timedReservations.length = 0;
    this.auditLogs.length = 0;
    this.auditLogCreateManyCalls = 0;
    this.windowSettings = null;
    this.limitSettings = null;
    this.icsTokenCollisions = 0;
  }

  // --- seeding ------------------------------------------------------------

  seedSpot(seed: SpotSeed): ParkingSpotRow {
    const row: ParkingSpotRow = {
      id: seed.id ?? randomUUID(),
      label: seed.label,
      group: seed.group ?? 'SHARED',
      active: seed.active ?? true,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    };
    this.spots.push(row);
    return row;
  }

  seedUser(seed: UserSeed = {}): UserRow {
    const id = seed.id ?? randomUUID();
    const row: UserRow = {
      id,
      email: seed.email ?? `${id}@example.test`,
      name: seed.name ?? `User ${id.slice(0, 4)}`,
      licensePlate: seed.licensePlate ?? null,
      role: seed.role ?? 'USER',
      oktaId: seed.oktaId ?? `okta-${id}`,
      active: seed.active ?? true,
      icsToken: seed.icsToken ?? `token-${id}`,
      preferredParkingSpotId: seed.preferredParkingSpotId ?? null,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    };
    this.users.push(row);
    return row;
  }

  seedReservation(seed: ReservationSeed): ReservationRow {
    const row: ReservationRow = {
      id: seed.id ?? randomUUID(),
      parkingSpotId: seed.parkingSpotId,
      userId: seed.userId,
      // A guest seed is `{ userId: null, guestName: '…' }`; the defaults keep
      // every existing caller seeding exactly what it seeded before.
      guestName: seed.guestName ?? null,
      licensePlate: seed.licensePlate ?? null,
      date: new Date(`${seed.date}T00:00:00.000Z`),
      createdAt: seed.createdAt ?? EPOCH,
    };
    this.reservations.push(row);
    return row;
  }

  seedWaitlistEntry(seed: WaitlistSeed): WaitlistEntryRow {
    const row: WaitlistEntryRow = {
      id: seed.id ?? randomUUID(),
      parkingSpotId: seed.parkingSpotId,
      userId: seed.userId,
      date: new Date(`${seed.date}T00:00:00.000Z`),
      createdAt: seed.createdAt ?? EPOCH,
    };
    this.waitlist.push(row);
    return row;
  }

  seedTimedReservation(seed: TimedReservationSeed): TimedReservationRow {
    const row: TimedReservationRow = {
      id: seed.id ?? randomUUID(),
      parkingSpotId: seed.parkingSpotId,
      date: new Date(`${seed.date}T00:00:00.000Z`),
      startMinute: seed.startMinute,
      endMinute: seed.endMinute,
      guestName: seed.guestName ?? 'Guest',
      licensePlate: seed.licensePlate ?? null,
      createdAt: seed.createdAt ?? EPOCH,
    };
    this.timedReservations.push(row);
    return row;
  }

  seedWindowSettings(settings: Partial<Omit<WindowSettingsRow, 'id'>> = {}): WindowSettingsRow {
    this.windowSettings = {
      id: WINDOW_SETTINGS_ID,
      openDaysBefore: settings.openDaysBefore ?? 7,
      lockMode: settings.lockMode ?? 'AUTO',
      updatedAt: EPOCH,
    };
    return this.windowSettings;
  }

  seedLimitSettings(settings: Partial<Omit<LimitSettingsRow, 'id'>> = {}): LimitSettingsRow {
    this.limitSettings = {
      id: LIMIT_SETTINGS_ID,
      monthlyReservationCap: settings.monthlyReservationCap ?? 5,
      updatedAt: EPOCH,
    };
    return this.limitSettings;
  }

  /** Drop it in with `{ provide: PrismaService, useValue: double.asPrismaService() }`. */
  asPrismaService(): PrismaService {
    return { client: this.client() } as unknown as PrismaService;
  }

  // --- delegates ----------------------------------------------------------

  private client() {
    return {
      parkingSpot: this.parkingSpotDelegate(),
      user: this.userDelegate(),
      reservation: this.reservationDelegate(),
      waitlistEntry: this.waitlistDelegate(),
      timedReservation: this.timedReservationDelegate(),
      reservationWindowSettings: this.windowSettingsDelegate(),
      reservationLimitSettings: this.limitSettingsDelegate(),
      auditLog: this.auditLogDelegate(),
    };
  }

  private parkingSpotDelegate() {
    return {
      findMany: async (
        args: {
          where?: { active?: boolean; group?: ParkingSpotRow['group'] };
          orderBy?: unknown;
          /**
           * Accepted and deliberately ignored: the double returns whole rows
           * where Prisma would return the projection. A superset is safe for
           * every current caller (they read a subset of the columns they
           * asked for), and refusing `select` would refuse two queries the
           * services genuinely issue — `bulk-reservation.service.ts` and
           * `slack-notification.service.ts` both project here.
           */
          select?: unknown;
        } = {}
      ) => {
        const { active, group, ...rest } = args.where ?? {};
        if (Object.keys(rest).length > 0) {
          return unsupported('this parking spot filter', args.where);
        }
        const rows = this.spots
          .filter((row) => active === undefined || row.active === active)
          .filter((row) => group === undefined || row.group === group);
        return sortedSpots(rows, args.orderBy).map(copy);
      },
      findUnique: async (args: { where: { id?: string; label?: string } }) => {
        const { id, label } = args.where;
        const row = this.spots.find(
          (candidate) =>
            (id !== undefined && candidate.id === id) ||
            (label !== undefined && candidate.label === label)
        );
        return row === undefined ? null : copy(row);
      },
      create: async (args: { data: { label: string; group: ParkingSpotRow['group'] } }) => {
        if (this.spots.some((row) => row.label === args.data.label)) {
          throw uniqueViolation('ParkingSpot', 'label');
        }
        return copy(this.seedSpot({ label: args.data.label, group: args.data.group }));
      },
      update: async (args: {
        where: { id: string };
        data: Partial<Pick<ParkingSpotRow, 'label' | 'group' | 'active'>>;
      }) => {
        const row = this.spots.find((candidate) => candidate.id === args.where.id);
        if (row === undefined) {
          throw recordNotFound();
        }
        if (
          args.data.label !== undefined &&
          this.spots.some(
            (candidate) => candidate.label === args.data.label && candidate.id !== row.id
          )
        ) {
          throw uniqueViolation('ParkingSpot', 'label');
        }
        Object.assign(row, args.data, { updatedAt: new Date() });
        return copy(row);
      },
    };
  }

  private userDelegate() {
    return {
      findMany: async (args: { where?: UserWhere; orderBy?: unknown } = {}) =>
        this.users
          .filter((row) => matchesUserWhere(row, args.where ?? {}))
          .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
          .map(copy),
      findUnique: async (args: { where: { id?: string; email?: string; oktaId?: string } }) => {
        const { id, email, oktaId } = args.where;
        if (id === undefined && email === undefined && oktaId === undefined) {
          return unsupported('a user lookup without id, email or oktaId', args.where);
        }
        const row = this.users.find(
          (candidate) =>
            (id !== undefined && candidate.id === id) ||
            (email !== undefined && candidate.email === email) ||
            (oktaId !== undefined && candidate.oktaId === oktaId)
        );
        return row === undefined ? null : copy(row);
      },
      // The ICS feed's token lookup (`CalendarService`). It is a `findFirst`
      // and not a `findUnique` because `active` is not part of the unique key —
      // which is deliberate there, so an unknown token and a deactivated user's
      // token take one and the same path. Modelled with the same `active`
      // filter for that reason: a double that ignored it would let this
      // project's only unauthenticated endpoint pass its tests while serving
      // offboarded employees.
      findFirst: async (args: { where: { icsToken?: string; active?: boolean } }) => {
        const { icsToken, active } = args.where;
        if (icsToken === undefined) {
          return unsupported('a user findFirst without an icsToken', args.where);
        }
        const row = this.users.find(
          (candidate) =>
            candidate.icsToken === icsToken && (active === undefined || candidate.active === active)
        );
        return row === undefined ? null : copy(row);
      },
      // Just-in-time provisioning (`AuthUserService`) creates a row for a
      // subject the database has never seen; the oRPC pipeline test goes through
      // the real guard, so it goes through this.
      create: async (args: {
        data: { oktaId: string; email: string; name: string; icsToken: string };
      }) => {
        for (const [column, value] of [
          ['oktaId', args.data.oktaId],
          ['email', args.data.email],
          ['icsToken', args.data.icsToken],
        ] as const) {
          if (this.users.some((row) => row[column] === value)) {
            throw uniqueViolation('User', column);
          }
        }
        return copy(
          this.seedUser({
            oktaId: args.data.oktaId,
            email: args.data.email,
            name: args.data.name,
            icsToken: args.data.icsToken,
          })
        );
      },
      count: async (args: { where?: UserWhere } = {}) =>
        this.users.filter((row) => matchesUserWhere(row, args.where ?? {})).length,
      update: async (args: { where: { id: string }; data: UserUpdateData }) => {
        const row = this.users.find((candidate) => candidate.id === args.where.id);
        if (row === undefined) {
          throw recordNotFound();
        }
        const { preferredParkingSpot, ...scalars } = args.data;
        if (scalars.icsToken !== undefined) {
          if (this.icsTokenCollisions > 0) {
            this.icsTokenCollisions -= 1;
            throw uniqueViolation('User', 'icsToken');
          }
          if (
            this.users.some(
              (candidate) => candidate.icsToken === scalars.icsToken && candidate.id !== row.id
            )
          ) {
            throw uniqueViolation('User', 'icsToken');
          }
        }
        Object.assign(row, scalars, { updatedAt: new Date() });
        if (preferredParkingSpot !== undefined) {
          row.preferredParkingSpotId =
            'disconnect' in preferredParkingSpot ? null : preferredParkingSpot.connect.id;
        }
        return copy(row);
      },
    };
  }

  private reservationDelegate() {
    return {
      findMany: async (args: {
        where: { date: Date | { gte: Date; lte?: Date }; userId?: string };
        include?: { parkingSpot?: unknown; user?: unknown };
        select?: unknown;
        orderBy?: unknown;
      }) => {
        // The ICS feed's query (`CalendarService`): one user's reservations
        // from a lower date bound, with the spot's label joined in, ordered by
        // date then id. `myMonth` (`ReservationsService`) shares this branch
        // but also bounds the range from above, hence the optional `lte`, and
        // passes `select: { date: true }` instead of an `include` — accepted
        // here and silently ignored, since every row is returned in full
        // (with the joined `parkingSpot`) and `myMonth`'s caller only reads
        // `row.date`, so the difference from a real narrowed `select` is
        // harmless for what this double is used to test.
        if (args.where.userId !== undefined) {
          const bound = args.where.date;
          if (bound === undefined || !(bound instanceof Object) || !('gte' in bound)) {
            return unsupported(
              'a per-user reservation query without a `date.gte` bound',
              args.where
            );
          }
          const gte = bound.gte.getTime();
          const lte = bound.lte?.getTime();
          const rows = this.reservations
            .filter(
              (row) =>
                row.userId === args.where.userId &&
                row.date.getTime() >= gte &&
                (lte === undefined || row.date.getTime() <= lte)
            )
            .map((row) => ({ ...row, parkingSpot: copy(this.requireSpot(row.parkingSpotId)) }));
          // Ordering is applied **only when the caller asked for it**. An
          // earlier version of this delegate always sorted by date, which made
          // `CalendarService`'s `orderBy` dead weight: deleting it changed
          // nothing and every test still passed. A real Postgres returns rows
          // in whatever order it likes without an ORDER BY, and insertion order
          // is the closest honest stand-in.
          return sortedByDateThenId(rows, args.orderBy);
        }
        if (!(args.where.date instanceof Date)) {
          return unsupported('a reservation filter other than an exact date', args.where);
        }
        const target = args.where.date.getTime();
        return this.reservations
          .filter((row) => row.date.getTime() === target)
          .map((row): ReservationRow & { user: UserRow | null } => {
            const holder = this.findHolder(row.userId);
            // `copy(null)` is `{ ...null }`, which is `{}` — not `null` — so a
            // guest row must not go through `copy` at all here. A real Prisma
            // `include`/`select` on a `User?` relation returns a genuine
            // `null`, and this double has to match that or `toPublicReservation`'s
            // callers (Task 3) never see the guest holder they now project.
            //
            // The return-type annotation documents this branch's actual shape
            // (the other return path, above, joins `parkingSpot`, never
            // `user`). A caller's own `row.user` type-checks independently of
            // this annotation: calls go through `asPrismaService(): PrismaService`,
            // so the caller sees the real generated `findMany` overloads and
            // needs `include: { user: true }`, as `day-overview.service.ts`
            // does.
            return { ...row, user: holder === null ? null : copy(holder) };
          });
      },
      count: async (args: { where: { parkingSpotId: string; date: { gte: Date } } }) => {
        const gte = args.where.date?.gte;
        if (!(gte instanceof Date)) {
          return unsupported('a reservation count without a `date.gte` bound', args.where);
        }
        return this.reservations.filter(
          (row) =>
            row.parkingSpotId === args.where.parkingSpotId && row.date.getTime() >= gte.getTime()
        ).length;
      },
    };
  }

  private waitlistDelegate() {
    return {
      findMany: async (args: { where: { date: Date }; orderBy?: unknown; select?: unknown }) => {
        const target = args.where.date.getTime();
        return this.waitlist
          .filter((row) => row.date.getTime() === target)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
          .map(copy);
      },
      // `SpotsService.requireNoFutureCommitments`, which counts queues for a
      // spot as well as reservations on it. Same `date.gte` shape as the
      // reservation count, and refused the same way if it is missing.
      count: async (args: { where: { parkingSpotId: string; date: { gte: Date } } }) => {
        const gte = args.where.date?.gte;
        if (!(gte instanceof Date)) {
          return unsupported('a waitlist count without a `date.gte` bound', args.where);
        }
        return this.waitlist.filter(
          (row) =>
            row.parkingSpotId === args.where.parkingSpotId && row.date.getTime() >= gte.getTime()
        ).length;
      },
    };
  }

  private timedReservationDelegate() {
    return {
      findMany: async (args: {
        where: { date: Date; parkingSpotId?: string };
        orderBy?: unknown;
      }) => {
        const target = args.where.date.getTime();
        const rows = this.timedReservations
          .filter((row) => row.date.getTime() === target)
          .filter(
            (row) =>
              args.where.parkingSpotId === undefined ||
              row.parkingSpotId === args.where.parkingSpotId
          );
        const requested = JSON.stringify(args.orderBy);
        if (args.orderBy === undefined) {
          return rows.map(copy);
        }
        if (requested !== JSON.stringify({ startMinute: 'asc' })) {
          return unsupported('this timed reservation ordering', args.orderBy);
        }
        return [...rows].sort((a, b) => a.startMinute - b.startMinute).map(copy);
      },
    };
  }

  private windowSettingsDelegate() {
    return {
      findUnique: async (args: { where: { id?: number } }) => {
        const { id, ...rest } = args.where ?? {};
        if (Object.keys(rest).length > 0) {
          return unsupported('this window settings lookup', args.where);
        }
        // The table is a singleton keyed on id 1. Answering a lookup for any
        // other id with the singleton's row is the same silent lie a missing
        // filter is: the caller asked for a row that does not exist and would
        // be handed one that does.
        if (id !== WINDOW_SETTINGS_ID) {
          return unsupported('a window settings row other than the singleton', args.where);
        }
        return this.windowSettings === null ? null : copy(this.windowSettings);
      },
      upsert: async (args: {
        create: { id: number; openDaysBefore: number; lockMode: WindowSettingsRow['lockMode'] };
        update: { openDaysBefore: number; lockMode: WindowSettingsRow['lockMode'] };
      }) => {
        if (this.windowSettings === null) {
          this.windowSettings = { ...args.create, updatedAt: new Date() };
        } else {
          this.windowSettings = { ...this.windowSettings, ...args.update, updatedAt: new Date() };
        }
        return copy(this.windowSettings);
      },
    };
  }

  private limitSettingsDelegate() {
    return {
      findUnique: async (args: { where: { id?: number }; select?: unknown }) => {
        const { id, ...rest } = args.where ?? {};
        if (Object.keys(rest).length > 0) {
          return unsupported('this limit settings lookup', args.where);
        }
        // Same singleton rule as the window settings above: answering a lookup
        // for any other id with the singleton's row would be a silent lie.
        if (id !== LIMIT_SETTINGS_ID) {
          return unsupported('a limit settings row other than the singleton', args.where);
        }
        // `select` is accepted and ignored — `readMonthlyReservationCap`
        // projects `monthlyReservationCap`, and a whole row is a safe superset
        // for every current reader, exactly as `parkingSpot.findMany` argues.
        return this.limitSettings === null ? null : copy(this.limitSettings);
      },
      upsert: async (args: {
        create: { id: number; monthlyReservationCap: number };
        update: { monthlyReservationCap: number };
      }) => {
        if (this.limitSettings === null) {
          this.limitSettings = { ...args.create, updatedAt: new Date() };
        } else {
          this.limitSettings = { ...this.limitSettings, ...args.update, updatedAt: new Date() };
        }
        return copy(this.limitSettings);
      },
    };
  }

  private auditLogDelegate() {
    const append = (data: Omit<AuditLogRow, 'id' | 'createdAt'>): AuditLogRow => {
      const row: AuditLogRow = { id: randomUUID(), createdAt: new Date(), ...data };
      this.auditLogs.push(row);
      return row;
    };

    return {
      create: async (args: { data: Omit<AuditLogRow, 'id' | 'createdAt'> }) =>
        copy(append(args.data)),
      /**
       * Prisma's `createMany` returns a count, not the rows — which is exactly
       * the difference `AuditLogService.recordMany` exists for, and the reason
       * the double models it separately rather than looping `create`: a test
       * that wants to know "was this one statement or several?" can count the
       * calls to this one.
       */
      createMany: async (args: { data: readonly Omit<AuditLogRow, 'id' | 'createdAt'>[] }) => {
        this.auditLogCreateManyCalls += 1;
        for (const data of args.data) append(data);
        return { count: args.data.length };
      },
    };
  }

  private requireSpot(id: string): ParkingSpotRow {
    const spot = this.spots.find((row) => row.id === id);
    if (spot === undefined) {
      throw new Error(`PrismaDouble: reservation references an unseeded spot ${id}`);
    }
    return spot;
  }

  private requireUser(id: string): UserRow {
    const user = this.users.find((row) => row.id === id);
    if (user === undefined) {
      throw new Error(`PrismaDouble: reservation references an unseeded user ${id}`);
    }
    return user;
  }

  /**
   * Mirrors a Prisma `include: { user: true }` on `Reservation.user`, which is
   * a `User?` relation (`doc/decision/0303-*`): `null` when the reservation is
   * a guest's, {@link requireUser} otherwise.
   */
  private findHolder(userId: string | null): UserRow | null {
    return userId === null ? null : this.requireUser(userId);
  }
}

interface UserWhere {
  role?: UserRow['role'];
  active?: boolean;
  id?: { not: string };
  OR?: { name?: { contains: string; mode: string }; email?: { contains: string; mode: string } }[];
}

type UserUpdateData = Partial<
  Pick<UserRow, 'role' | 'active' | 'licensePlate' | 'icsToken' | 'name' | 'oktaId'>
> & {
  preferredParkingSpot?: { disconnect: true } | { connect: { id: string } };
};

function matchesUserWhere(row: UserRow, where: UserWhere): boolean {
  if (where.role !== undefined && row.role !== where.role) {
    return false;
  }
  if (where.active !== undefined && row.active !== where.active) {
    return false;
  }
  if (where.id !== undefined && row.id === where.id.not) {
    return false;
  }
  if (where.OR !== undefined) {
    const matches = where.OR.some((clause) => {
      const name = clause.name?.contains;
      const email = clause.email?.contains;
      return (
        (name !== undefined && row.name.toLowerCase().includes(name.toLowerCase())) ||
        (email !== undefined && row.email.toLowerCase().includes(email.toLowerCase()))
      );
    });
    if (!matches) {
      return false;
    }
  }
  return true;
}
