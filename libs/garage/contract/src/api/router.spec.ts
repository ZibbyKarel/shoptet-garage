import { type AnyContractProcedure, isContractProcedure } from '@orpc/contract';
import {
  DEFAULT_MONTHLY_RESERVATION_CAP,
  MAX_MONTHLY_RESERVATION_CAP,
  MIN_MONTHLY_RESERVATION_CAP,
} from '@garage/shared-types';
import { DATE_A, TIMESTAMP, UUID_A, UUID_B, UUID_C } from '../__fixtures__/fixtures';
import { AUDIT_LOG_ACTIONS } from '../schemas/entities';
import { ERROR_CODES } from '../schemas/errors';
import { reservationLimitSettingsSchema } from '../schemas/reservation-limits';
import { noInputSchema } from './builder';
import {
  getReservationLimitSettingsContract,
  updateReservationLimitSettingsContract,
} from './reservation-limits';
import type { ContractClient } from './router';
import { contract } from './router';
import {
  adminUserMonthReservationsInputSchema,
  getMyMonthReservationsContract,
  getUserMonthReservationsContract,
  monthReservationsOutputSchema,
  myMonthReservationsInputSchema,
} from './reservations';

/** Flattens the router into `['a.b.c', procedure]` pairs. */
function flatten(
  node: unknown,
  path: readonly string[] = []
): readonly (readonly [string, AnyContractProcedure])[] {
  if (isContractProcedure(node)) {
    return [[path.join('.'), node]];
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) => flatten(child, [...path, key]));
}

const procedures = flatten(contract);
const procedurePaths = procedures.map(([path]) => path);

/**
 * The authoritative list. A procedure added, removed or renamed shows up in the
 * diff here, which is the contract-first guarantee: nothing may be implemented
 * on the backend or called from the frontend unless it is on this list.
 */
const EXPECTED_PROCEDURES = [
  'overview.day',
  'reservation.create',
  'reservation.cancel',
  'reservation.previewBulk',
  'reservation.confirmBulk',
  'reservation.myMonth',
  'waitlist.join',
  'waitlist.leave',
  'spot.list',
  'me.get',
  'me.updateSettings',
  'me.regenerateIcsToken',
  'admin.reservation.month',
  'admin.reservationLimits.get',
  'admin.reservationLimits.update',
  'admin.spot.list',
  'admin.spot.create',
  'admin.spot.update',
  'admin.spot.deactivate',
  'admin.timedReservation.create',
  'admin.timedReservation.cancel',
  'admin.user.list',
  'admin.user.update',
  'admin.window.get',
  'admin.window.update',
  'admin.window.months',
];

/**
 * The error codes each procedure declares.
 *
 * `FORBIDDEN` is on every one of them, from the shared `authed` base: a
 * deactivated user is rejected before any handler runs, and the admin subtree
 * additionally rejects a non-admin.
 *
 * The two window codes follow ruling window-1 / window-3 exactly:
 * `OUT_OF_HORIZON` means the target month is `NOT_YET_OPEN`,
 * `RESERVATIONS_LOCKED` means it is `LOCKED`. Note what is **absent**:
 * `reservation.cancel` declares neither, because cancelling your own
 * reservation is allowed in a locked month.
 */
const EXPECTED_ERROR_CODES: Record<string, readonly string[]> = {
  'overview.day': ['FORBIDDEN'],
  'reservation.create': [
    'FORBIDDEN',
    'NOT_FOUND',
    'SPOT_ALREADY_RESERVED',
    'RESERVATION_LIMIT_REACHED',
    'MONTHLY_RESERVATION_LIMIT_REACHED',
    'PAST_DATE',
    'OUT_OF_HORIZON',
    'RESERVATIONS_LOCKED',
    'VALIDATION_FAILED',
    'CONFLICT',
  ],
  'reservation.cancel': ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'],
  'reservation.previewBulk': [
    'FORBIDDEN',
    'NOT_FOUND',
    'PAST_DATE',
    'OUT_OF_HORIZON',
    'RESERVATIONS_LOCKED',
    'VALIDATION_FAILED',
  ],
  'reservation.confirmBulk': [
    'FORBIDDEN',
    'NOT_FOUND',
    'PAST_DATE',
    'OUT_OF_HORIZON',
    'RESERVATIONS_LOCKED',
    'MONTHLY_RESERVATION_LIMIT_REACHED',
    'VALIDATION_FAILED',
    'CONFLICT',
  ],
  'reservation.myMonth': ['FORBIDDEN'],
  'waitlist.join': [
    'FORBIDDEN',
    'NOT_FOUND',
    'ALREADY_IN_WAITLIST',
    'CANNOT_WAITLIST_OWN_SPOT',
    'SPOT_NOT_OCCUPIED',
    'RESERVATION_LIMIT_REACHED',
    'PAST_DATE',
    'OUT_OF_HORIZON',
    'RESERVATIONS_LOCKED',
    'VALIDATION_FAILED',
    'CONFLICT',
  ],
  // `waitlist.leave` deliberately carries neither window error. Leaving a queue
  // is not gated by the reservation window — see
  // `doc/decision/0233-leaving-a-waitlist-is-exempt-from-the-reservation-window`,
  // which amends `doc/decision/0004-*`'s "enforcing the lock on
  // create/join/leave". Under the shipped `AUTO`/`openDaysBefore=7` defaults the
  // old rule made leaving impossible for the whole month a queue is live in.
  'waitlist.leave': ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'],
  'spot.list': ['FORBIDDEN'],
  'me.get': ['FORBIDDEN'],
  'me.updateSettings': ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  'me.regenerateIcsToken': ['FORBIDDEN'],
  'admin.reservation.month': ['FORBIDDEN'],
  'admin.reservationLimits.get': ['FORBIDDEN'],
  'admin.reservationLimits.update': ['FORBIDDEN', 'VALIDATION_FAILED', 'CONFLICT'],
  'admin.spot.list': ['FORBIDDEN'],
  'admin.spot.create': ['FORBIDDEN', 'CONFLICT', 'VALIDATION_FAILED'],
  'admin.spot.update': ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'],
  'admin.spot.deactivate': ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'],
  'admin.timedReservation.create': [
    'FORBIDDEN',
    'NOT_FOUND',
    'SPOT_ALREADY_RESERVED',
    'PAST_DATE',
    'VALIDATION_FAILED',
    'CONFLICT',
  ],
  'admin.timedReservation.cancel': ['FORBIDDEN', 'NOT_FOUND'],
  'admin.user.list': ['FORBIDDEN'],
  'admin.user.update': ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'],
  'admin.window.get': ['FORBIDDEN'],
  'admin.window.update': ['FORBIDDEN', 'VALIDATION_FAILED', 'CONFLICT'],
  'admin.window.months': ['FORBIDDEN'],
};

describe('contract router', () => {
  it('exposes exactly the expected procedures', () => {
    expect([...procedurePaths].sort()).toEqual([...EXPECTED_PROCEDURES].sort());
  });

  it('declares an output schema on every procedure', () => {
    for (const [path, procedure] of procedures) {
      expect([path, procedure['~orpc'].outputSchema !== undefined]).toEqual([path, true]);
    }
  });

  it('declares an input schema on every procedure', () => {
    // No exceptions: the four argument-less procedures declare `noInputSchema`
    // rather than omitting `.input()`, so nothing can accept an unvalidated
    // payload by accident.
    const withoutInput = procedures
      .filter(([, procedure]) => procedure['~orpc'].inputSchema === undefined)
      .map(([path]) => path);
    expect(withoutInput).toEqual([]);
  });

  it('uses the shared no-input schema on the argument-less procedures', () => {
    for (const path of ['admin.window.get', 'me.get', 'me.regenerateIcsToken', 'spot.list']) {
      const procedure = procedures.find(([candidate]) => candidate === path)?.[1];
      expect([path, procedure?.['~orpc'].inputSchema]).toEqual([path, noInputSchema]);
    }
  });

  it('accepts an argument-less call and rejects a stray payload', () => {
    // Both shapes an argument-less call can arrive as: `undefined` over RPC,
    // `{}` over an OpenAPI GET with no parameters.
    expect(noInputSchema.safeParse(undefined).success).toBe(true);
    expect(noInputSchema.safeParse({}).success).toBe(true);
    expect(noInputSchema.safeParse({ unexpected: 1 }).success).toBe(false);
    expect(noInputSchema.safeParse(null).success).toBe(false);
  });

  it('declares at least one error code on every procedure', () => {
    for (const [path, procedure] of procedures) {
      expect([path, Object.keys(procedure['~orpc'].errorMap).length > 0]).toEqual([path, true]);
    }
  });

  it('declares only codes from the closed ERROR_CODES enum', () => {
    for (const [path, procedure] of procedures) {
      for (const code of Object.keys(procedure['~orpc'].errorMap)) {
        expect([path, ERROR_CODES.includes(code as (typeof ERROR_CODES)[number])]).toEqual([
          path,
          true,
        ]);
      }
    }
  });

  it('declares exactly the documented error codes per procedure', () => {
    for (const [path, procedure] of procedures) {
      expect([path, Object.keys(procedure['~orpc'].errorMap).sort()]).toEqual([
        path,
        [...(EXPECTED_ERROR_CODES[path] ?? [])].sort(),
      ]);
    }
  });

  it('never declares a window error on cancelling a reservation', () => {
    // Ruling window-1: a normal user may cancel their own reservation at any
    // time, including in a locked month. A regression here would be invisible
    // in types but wrong in behaviour.
    const cancel = contract.reservation.cancel['~orpc'].errorMap;
    expect(cancel).not.toHaveProperty('RESERVATIONS_LOCKED');
    expect(cancel).not.toHaveProperty('OUT_OF_HORIZON');
  });

  it('declares both window errors on every write gated by the window', () => {
    // `waitlist.leave` is absent on purpose, and its absence is asserted
    // separately below rather than left implicit: taking a place is gated by the
    // window, giving one back is not. `doc/decision/0233-*`.
    for (const path of [
      'reservation.create',
      'waitlist.join',
      'reservation.previewBulk',
      'reservation.confirmBulk',
    ]) {
      const codes = EXPECTED_ERROR_CODES[path] ?? [];
      expect([path, codes.includes('OUT_OF_HORIZON')]).toEqual([path, true]);
      expect([path, codes.includes('RESERVATIONS_LOCKED')]).toEqual([path, true]);
    }
  });

  it('gates taking a place on the window and giving one back on nothing', () => {
    // The pair that `reservation.cancel` and `waitlist.leave` form is the whole
    // point of `doc/decision/0233-*`, so assert it against the real `errorMap`
    // rather than against `EXPECTED_ERROR_CODES` — a table this file maintains
    // by hand would otherwise be asserting against itself.
    for (const giveBack of [contract.reservation.cancel, contract.waitlist.leave]) {
      const errorMap = giveBack['~orpc'].errorMap;
      expect(errorMap).not.toHaveProperty('RESERVATIONS_LOCKED');
      expect(errorMap).not.toHaveProperty('OUT_OF_HORIZON');
    }

    for (const take of [contract.reservation.create, contract.waitlist.join]) {
      const errorMap = take['~orpc'].errorMap;
      expect(errorMap).toHaveProperty('RESERVATIONS_LOCKED');
      expect(errorMap).toHaveProperty('OUT_OF_HORIZON');
    }
  });

  it('exports ContractClient covering every procedure with contract-derived types', () => {
    // `ContractClient` is what `libs/shared/api-client` types its client as, so that
    // `@orpc/contract` stays allow-listed for `type:contract` alone
    // (`doc/decision/0040-*`). It is a type, so the check is a compile-time one:
    // each assignment below stops compiling if the client stops mirroring the
    // router, or if its input/output stop coming from the Zod schemas.
    type Client = ContractClient;

    // Same shape as the router: a nested branch resolves to a callable leaf.
    const createReservation: Client['reservation']['create'] = (() => {
      throw new Error('not called — this is a type-level assertion');
    }) as Client['reservation']['create'];
    const listAdminSpots: Client['admin']['spot']['list'] = (() => {
      throw new Error('not called — this is a type-level assertion');
    }) as Client['admin']['spot']['list'];

    // Input and output are the contract's own inferred types, not `any`.
    type CreateInput = Parameters<typeof createReservation>[0];
    type CreateOutput = Awaited<ReturnType<typeof createReservation>>;
    const input: CreateInput = { parkingSpotId: UUID_A, date: DATE_A };
    const output: CreateOutput = {
      id: UUID_B,
      parkingSpotId: UUID_A,
      userId: UUID_C,
      guestName: null,
      licensePlate: null,
      date: DATE_A,
      createdAt: TIMESTAMP,
    };

    expect(typeof createReservation).toBe('function');
    expect(typeof listAdminSpots).toBe('function');
    expect(input.date).toBe(DATE_A);
    expect(output.parkingSpotId).toBe(UUID_A);
  });

  it('exposes the admin month-summary procedure at admin.reservation.month', () => {
    expect(contract.admin.reservation.month).toBe(getUserMonthReservationsContract);
  });

  it('scopes the admin month summary to a named user, unlike the caller-scoped myMonth', () => {
    expect(
      adminUserMonthReservationsInputSchema.parse({ userId: UUID_A, month: '2026-09' })
    ).toEqual({ userId: UUID_A, month: '2026-09' });
    // `myMonth` must stay caller-scoped: a `userId` is not one of its inputs.
    expect(Object.keys(myMonthReservationsInputSchema.shape)).toEqual(['month']);
  });

  it('answers the admin month summary in the same shape as myMonth', () => {
    expect(getUserMonthReservationsContract['~orpc'].outputSchema).toBe(
      getMyMonthReservationsContract['~orpc'].outputSchema
    );
  });

  it('puts every admin-only procedure under the admin subtree', () => {
    // Grouping is the authorization boundary Task 12 implements against.
    expect(procedurePaths.filter((path) => path.startsWith('admin.')).sort()).toEqual(
      [
        'admin.reservation.month',
        'admin.reservationLimits.get',
        'admin.reservationLimits.update',
        'admin.spot.create',
        'admin.spot.deactivate',
        'admin.spot.list',
        'admin.spot.update',
        'admin.timedReservation.cancel',
        'admin.timedReservation.create',
        'admin.user.list',
        'admin.user.update',
        'admin.window.get',
        'admin.window.months',
        'admin.window.update',
      ].sort()
    );
  });

  it('exposes the admin reservation-limit settings at admin.reservationLimits', () => {
    expect(contract.admin.reservationLimits.get).toBe(getReservationLimitSettingsContract);
    expect(contract.admin.reservationLimits.update).toBe(updateReservationLimitSettingsContract);
  });

  it('defaults the monthly cap so a partial settings payload is accepted', () => {
    expect(reservationLimitSettingsSchema.parse({})).toEqual({
      monthlyReservationCap: DEFAULT_MONTHLY_RESERVATION_CAP,
    });
  });

  it('bounds the monthly cap the way the migration will', () => {
    expect(
      reservationLimitSettingsSchema.safeParse({
        monthlyReservationCap: MIN_MONTHLY_RESERVATION_CAP - 1,
      }).success
    ).toBe(false);
    expect(
      reservationLimitSettingsSchema.safeParse({
        monthlyReservationCap: MAX_MONTHLY_RESERVATION_CAP + 1,
      }).success
    ).toBe(false);
    expect(reservationLimitSettingsSchema.safeParse({ monthlyReservationCap: 12 }).success).toBe(
      true
    );
  });

  it('carries the effective cap on the month summary both procedures answer', () => {
    // The client cannot import a constant for this any more — the cap is a
    // setting, and this is the one field that tells it what is in force. One
    // schema shared by `reservation.myMonth` and `admin.reservation.month`, so
    // the two cannot disagree.
    expect(
      monthReservationsOutputSchema.parse({
        month: '2026-09',
        reservedDates: [],
        count: 0,
        cap: 5,
      })
    ).toEqual({ month: '2026-09', reservedDates: [], count: 0, cap: 5 });
    expect(
      monthReservationsOutputSchema.safeParse({ month: '2026-09', reservedDates: [], count: 0 })
        .success
    ).toBe(false);
  });

  it('declares an audit action for a limits change, because no existing member describes it', () => {
    expect(AUDIT_LOG_ACTIONS).toContain('RESERVATION_LIMITS_UPDATED');
  });
});
