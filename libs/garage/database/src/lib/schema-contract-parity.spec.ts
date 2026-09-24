/**
 * Ruling `preflight-1`: the Prisma schema follows the contract's entity shape.
 *
 * This is the executable half of that rule. It compares the **generated Prisma
 * Client** — not the text of `schema.prisma` — with the contract's Zod schemas,
 * so a renamed field, a dropped field, a changed nullability or an added enum
 * member fails here instead of surfacing as a hand-written mapping type six
 * tasks later.
 *
 * Two mechanisms, because neither alone is enough:
 *
 * - **Runtime**, from the client's `*ScalarFieldEnum` constants: the set of
 *   column names must equal the set of keys in the contract schema.
 * - **Compile time**, from the generated model types: which fields are nullable
 *   must equal which fields the contract marks `.nullable()`. Nullability does
 *   not exist at runtime, and it is exactly where drift hides.
 *
 * What is deliberately *not* asserted is type equality of the fields
 * themselves: storage legitimately differs from the wire (`Date` vs ISO string,
 * `Date` vs `YYYY-MM-DD`, `JsonValue` vs `Record<string, unknown>`). Those
 * differences are listed in `doc/database.md`.
 */

import type {
  AuditLog as ContractAuditLog,
  ParkingSpot as ContractParkingSpot,
  Reservation as ContractReservation,
  TimedReservation as ContractTimedReservation,
  User as ContractUser,
  WaitlistEntry as ContractWaitlistEntry,
} from '@garage/contract';
import {
  AUDIT_LOG_ACTIONS,
  auditLogSchema,
  parkingSpotSchema,
  reservationLimitSettingsSchema,
  reservationSchema,
  reservationWindowSettingsSchema,
  timedReservationSchema,
  userSchema,
  waitlistEntrySchema,
} from '@garage/contract';
import { PARKING_GROUPS, RESERVATION_LOCK_MODES, USER_ROLES } from '@garage/shared-types';
import type {
  AuditLog as PrismaAuditLog,
  ParkingSpot as PrismaParkingSpot,
  Reservation as PrismaReservation,
  TimedReservation as PrismaTimedReservation,
  User as PrismaUser,
  WaitlistEntry as PrismaWaitlistEntry,
} from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import {
  AuditLogAction,
  ParkingGroup,
  ReservationLockMode,
  UserRole,
} from '../generated/prisma/enums';

// --- compile-time parity ----------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type Expect<T extends true> = T;

/** Invariant type equality — `any` and unions do not sneak through. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Keys whose type admits `null`. */
type NullableKeys<T> = {
  [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];

const nullabilityMatches: [
  Expect<Equal<NullableKeys<PrismaUser>, NullableKeys<ContractUser>>>,
  Expect<Equal<NullableKeys<PrismaParkingSpot>, NullableKeys<ContractParkingSpot>>>,
  Expect<Equal<NullableKeys<PrismaReservation>, NullableKeys<ContractReservation>>>,
  Expect<Equal<NullableKeys<PrismaWaitlistEntry>, NullableKeys<ContractWaitlistEntry>>>,
  // `payload` is excluded on both sides: the column is `JSONB NOT NULL` (see
  // migration-sql.spec.ts), but Prisma types a non-optional `Json` field as
  // `Prisma.JsonValue`, which admits the JSON value `null`. That is a property
  // of JSON, not a nullable column, and comparing it here would be comparing
  // two different notions of "null".
  Expect<
    Equal<
      NullableKeys<Omit<PrismaAuditLog, 'payload'>>,
      NullableKeys<Omit<ContractAuditLog, 'payload'>>
    >
  >,
  // `startTime`/`endTime` are excluded on the contract side and
  // `startMinute`/`endMinute` on the storage side: neither is nullable on
  // either side, but they are different field names for the same value (see
  // the field-name test below), and `NullableKeys` compares by name.
  Expect<
    Equal<
      NullableKeys<Omit<PrismaTimedReservation, 'startMinute' | 'endMinute'>>,
      NullableKeys<Omit<ContractTimedReservation, 'startTime' | 'endTime'>>
    >
  >,
] = [true, true, true, true, true, true];

// --- runtime parity ---------------------------------------------------------

describe('Prisma enums mirror the domain enumerations', () => {
  it('ParkingGroup', () => {
    expect(Object.values(ParkingGroup)).toEqual([...PARKING_GROUPS]);
  });

  it('UserRole', () => {
    expect(Object.values(UserRole)).toEqual([...USER_ROLES]);
  });

  it('ReservationLockMode', () => {
    expect(Object.values(ReservationLockMode)).toEqual([...RESERVATION_LOCK_MODES]);
  });

  it('AuditLogAction matches the closed list from decision 0016', () => {
    expect(Object.values(AuditLogAction)).toEqual([...AUDIT_LOG_ACTIONS]);
  });
});

describe('Prisma models mirror the contract entities', () => {
  it.each([
    ['User', Prisma.UserScalarFieldEnum, userSchema],
    ['ParkingSpot', Prisma.ParkingSpotScalarFieldEnum, parkingSpotSchema],
    ['Reservation', Prisma.ReservationScalarFieldEnum, reservationSchema],
    ['WaitlistEntry', Prisma.WaitlistEntryScalarFieldEnum, waitlistEntrySchema],
    ['AuditLog', Prisma.AuditLogScalarFieldEnum, auditLogSchema],
  ] as const)('%s stores exactly the contract fields', (_name, scalarFields, schema) => {
    expect(Object.keys(scalarFields).sort()).toEqual(Object.keys(schema.shape).sort());
  });

  it('the nullable columns are the ones the contract marks nullable', () => {
    // Enforced by `tsc`; asserted here so the check is visible in the run.
    expect(nullabilityMatches).toEqual([true, true, true, true, true, true]);
  });

  it('TimedReservation stores the contract fields, minutes where the contract stores HH:MM', () => {
    // Not the generic `%s stores exactly the contract fields` check above:
    // storage uses `startMinute`/`endMinute` (`Int`) where the contract uses
    // `startTime`/`endTime` (`HH:MM` strings) — see `doc/database.md`
    // (§"Where storage differs from the contract"). Every other field name is
    // identical.
    const TIME_FIELDS: Record<string, string> = { startTime: 'startMinute', endTime: 'endMinute' };
    const contractFields = Object.keys(timedReservationSchema.shape)
      .map((field) => TIME_FIELDS[field] ?? field)
      .sort();
    expect(Object.keys(Prisma.TimedReservationScalarFieldEnum).sort()).toEqual(contractFields);
  });

  it('ReservationWindowSettings adds only storage-local columns', () => {
    // The contract schema has no `id`: the singleton is never addressed by id
    // over the wire. `updatedAt` is bookkeeping. Everything else must match.
    expect(Object.keys(Prisma.ReservationWindowSettingsScalarFieldEnum).sort()).toEqual(
      [...Object.keys(reservationWindowSettingsSchema.shape), 'id', 'updatedAt'].sort()
    );
  });

  it('ReservationLimitSettings adds only storage-local columns', () => {
    // Same arrangement as the window singleton beside it: the contract schema
    // has no `id`, because the row is never addressed by id over the wire, and
    // `updatedAt` is bookkeeping.
    expect(Object.keys(Prisma.ReservationLimitSettingsScalarFieldEnum).sort()).toEqual(
      [...Object.keys(reservationLimitSettingsSchema.shape), 'id', 'updatedAt'].sort()
    );
  });

  it('has no models beyond the ones the contract knows about', () => {
    expect(Object.values(Prisma.ModelName).sort()).toEqual([
      'AuditLog',
      'ParkingSpot',
      'Reservation',
      'ReservationLimitSettings',
      'ReservationWindowSettings',
      'TimedReservation',
      'User',
      'WaitlistEntry',
    ]);
  });
});

describe('storage types that are deliberately not the wire types', () => {
  it('AuditLog.payload is JSON, not a structured column', () => {
    // `Prisma.JsonValue` on the storage side, `Record<string, unknown>` on the
    // wire — the known, documented divergence (doc/database.md).
    const payloadIsJson: Expect<Equal<PrismaAuditLog['payload'], Prisma.JsonValue>> = true;
    expect(payloadIsJson).toBe(true);
  });

  it('the reservation day is a Date in storage and a YYYY-MM-DD string on the wire', () => {
    // Task 10 owns the conversion; this pins that a conversion is needed at all,
    // so nobody hands a `Date` straight to a contract-typed response. The column
    // being `DATE` and not `TIMESTAMP` is asserted in migration-sql.spec.ts.
    const storage: [
      Expect<Equal<PrismaReservation['date'], Date>>,
      Expect<Equal<PrismaWaitlistEntry['date'], Date>>,
      Expect<Equal<ContractReservation['date'], string>>,
      Expect<Equal<ContractWaitlistEntry['date'], string>>,
    ] = [true, true, true, true];
    expect(storage).toEqual([true, true, true, true]);
  });

  it('timestamps are Date in storage and ISO strings on the wire (decision 0015)', () => {
    const timestamps: [
      Expect<Equal<PrismaUser['createdAt'], Date>>,
      Expect<Equal<ContractUser['createdAt'], string>>,
    ] = [true, true];
    expect(timestamps).toEqual([true, true]);
  });

  it('a timed block is minutes-since-midnight in storage and HH:MM strings on the wire', () => {
    // Task 3 owns the conversion (`timeOfDayToMinutes`/`minutesToTimeOfDay`,
    // `@garage/shared-types`). The column being `SMALLINT`, not `TEXT`, is
    // asserted in `migration-sql.spec.ts`.
    const storage: [
      Expect<Equal<PrismaTimedReservation['startMinute'], number>>,
      Expect<Equal<PrismaTimedReservation['endMinute'], number>>,
      Expect<Equal<ContractTimedReservation['startTime'], string>>,
      Expect<Equal<ContractTimedReservation['endTime'], string>>,
    ] = [true, true, true, true];
    expect(storage).toEqual([true, true, true, true]);
  });
});
