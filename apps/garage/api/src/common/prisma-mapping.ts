/**
 * Turning database rows into the shapes the contract declares.
 *
 * The two representations differ in exactly the ways `doc/database.md` lists
 * under "Where storage differs from the contract", and this is the single place
 * that crosses that gap:
 *
 * | column | contract |
 * | --- | --- |
 * | `DateTime @db.Timestamptz(3)` | ISO 8601 string (`doc/decision/0015-*`) |
 * | `DateTime @db.Date` | `YYYY-MM-DD` (`doc/decision/0003-*`) |
 *
 * Every function below returns a value typed by `z.infer` from
 * `libs/garage/contract` — never a hand-written interface — so a field added to an
 * entity schema stops compiling here until it is mapped.
 *
 * ## The `@db.Date` convention
 *
 * A `DATE` column has no time and no zone. Postgres hands `@prisma/adapter-pg`
 * the text `YYYY-MM-DD` (its `normalize_date` is the identity function), and
 * Prisma turns that into a `Date` at **UTC** midnight. {@link toDateOnly} reads
 * it back with UTC getters for that reason: using local getters would move the
 * day by one for any process running west of Greenwich. No time-zone conversion
 * should happen at all here — the calendar day is already the value.
 *
 * `toDateOnlyInPrague` would in fact return the same day for every `@db.Date`,
 * and an earlier version of this comment claiming otherwise was wrong: Prague is
 * UTC+1 or UTC+2, always *ahead* of UTC, so UTC midnight is 01:00 or 02:00 on
 * the **same** Prague day and is never moved forward. (Measured across both DST
 * Sundays, a leap day, a new year and both offsets; the two functions diverge
 * only for instants that are not midnight UTC, which a `@db.Date` never is.)
 * `toDateOnly` is the right call because it is the one that says what this value
 * is, not because the other would give a wrong date.
 *
 * Task 13 exercised this against a real PostgreSQL 17 rather than leaving it as
 * an argument: `reservations.db.spec.ts` writes a reservation through
 * {@link toDateColumn} and asserts the stored column reads back as
 * `YYYY-MM-DDT00:00:00.000Z` — the same calendar day, not the one either side of
 * it.
 */

import type {
  AdminUser,
  ParkingSpot,
  PublicReservation,
  PublicTimedReservation,
  Reservation,
  TimedReservation,
  User,
  UserSummary,
  WaitlistEntry,
} from '@garage/contract';
import type {
  ParkingSpot as ParkingSpotRow,
  Reservation as ReservationRow,
  TimedReservation as TimedReservationRow,
  User as UserRow,
  WaitlistEntry as WaitlistEntryRow,
  ReservationLimitSettings as ReservationLimitSettingsRow,
  ReservationWindowSettings as ReservationWindowSettingsRow,
} from '@garage/database';
import { minutesToTimeOfDay } from '@garage/shared-types';
import type { DateOnly } from '@garage/shared-types';
import { fromUtcMidnight, toUtcMidnight } from '@garage/shared-types';
import type { ReservationLimitSettings, ReservationWindowSettings } from '@garage/contract';

/** A `@db.Timestamptz` column as the contract's ISO 8601 string. */
export function toTimestamp(value: Date): string {
  return value.toISOString();
}

/** A `@db.Date` column as the contract's `YYYY-MM-DD`. See the note above. */
export function toDateOnly(value: Date): DateOnly {
  return fromUtcMidnight(value);
}

/**
 * A `YYYY-MM-DD` as the value to write into (or compare against) a `@db.Date`
 * column: UTC midnight, the same convention {@link toDateOnly} reads.
 */
export function toDateColumn(value: DateOnly): Date {
  // `toUtcMidnight` parses, so an invalid `YYYY-MM-DD` still throws here rather
  // than reaching the driver as a silently wrong day.
  return toUtcMidnight(value);
}

export function toContractSpot(row: ParkingSpotRow): ParkingSpot {
  return {
    id: row.id,
    label: row.label,
    group: row.group,
    active: row.active,
    hidden: row.hidden,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  };
}

/** The caller's own record. `icsToken` is included — see `myProfileSchema`. */
export function toContractUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    licensePlate: row.licensePlate,
    role: row.role,
    oktaId: row.oktaId,
    active: row.active,
    icsToken: row.icsToken,
    preferredParkingSpotId: row.preferredParkingSpotId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  };
}

/**
 * How a user appears to an **admin**: everything except `icsToken`.
 *
 * Built by removing the token from the full projection rather than by listing
 * the remaining fields, so that a field added to `userSchema` reaches the admin
 * table by default. `adminUserSchema` is an `omit` for the same reason.
 */
export function toAdminUser(row: UserRow): AdminUser {
  const { icsToken: _icsToken, ...rest } = toContractUser(row);
  return rest;
}

/** How a user appears to **another user**: three fields, never the token. */
export function toUserSummary(row: Pick<UserRow, 'id' | 'name' | 'licensePlate'>): UserSummary {
  return { id: row.id, name: row.name, licensePlate: row.licensePlate };
}

/** A reservation row, whole. What `reservation.create` answers with. */
export function toContractReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    parkingSpotId: row.parkingSpotId,
    userId: row.userId,
    guestName: row.guestName,
    licensePlate: row.licensePlate,
    date: toDateOnly(row.date),
    createdAt: toTimestamp(row.createdAt),
  };
}

/**
 * A reservation as everybody who can see the day sees it: the reservation, and
 * its holder — a user, or the guest an admin booked it for.
 *
 * The holder is taken as a **separate argument** rather than joined back in,
 * because `publicReservationSchema` deliberately carries neither the spot nor
 * the day and every caller already has the joined row in hand. `null` means
 * "this is a guest reservation"; the row's own `guestName` supplies the name.
 *
 * The plate is the row's override where there is one, and the holder's stored
 * plate otherwise — a consumer never has to know the override exists
 * (`doc/decision/0304-the-reservation-holder-projection-is-a-discriminated-union`).
 */
export function toPublicReservation(
  row: ReservationRow,
  holder: Pick<UserRow, 'id' | 'name' | 'licensePlate'> | null
): PublicReservation {
  const createdAt = toTimestamp(row.createdAt);

  if (holder !== null) {
    if (row.userId !== holder.id) {
      // Louder than fabricating a holder that does not match the row: a
      // caller passing a holder alongside a row it does not belong to is a
      // bug at the call site, and one that would otherwise reach a broadcast
      // and a screen silently, naming the wrong person.
      throw new Error(
        `Reservation ${row.id} has userId ${String(row.userId)}, but was mapped with holder ${holder.id}.`
      );
    }
    return {
      id: row.id,
      createdAt,
      holder: {
        kind: 'USER',
        userId: holder.id,
        name: holder.name,
        licensePlate: row.licensePlate ?? holder.licensePlate,
      },
    };
  }

  if (row.guestName !== null) {
    return {
      id: row.id,
      createdAt,
      holder: { kind: 'GUEST', name: row.guestName, licensePlate: row.licensePlate },
    };
  }

  // `Reservation_holder_check` makes this unreachable from the database. Louder
  // than a fabricated holder, which would reach a broadcast and a screen.
  throw new Error(
    `Reservation ${row.id} has neither a user nor a guest name; Reservation_holder_check should have refused it.`
  );
}

/** A waitlist row, whole. What `waitlist.join` answers with. */
export function toContractWaitlistEntry(row: WaitlistEntryRow): WaitlistEntry {
  return {
    id: row.id,
    parkingSpotId: row.parkingSpotId,
    userId: row.userId,
    date: toDateOnly(row.date),
    createdAt: toTimestamp(row.createdAt),
  };
}

/** A timed-reservation row, whole. What `admin.timedReservation.create` answers with. */
export function toContractTimedReservation(row: TimedReservationRow): TimedReservation {
  return {
    id: row.id,
    parkingSpotId: row.parkingSpotId,
    date: toDateOnly(row.date),
    startTime: minutesToTimeOfDay(row.startMinute),
    endTime: minutesToTimeOfDay(row.endMinute),
    guestName: row.guestName,
    licensePlate: row.licensePlate,
    createdAt: toTimestamp(row.createdAt),
  };
}

/**
 * A timed block as everybody who can see the day sees it: neither the spot nor
 * the day, for the same reason {@link toPublicReservation}'s output carries
 * neither — every caller already knows both from its surrounding context (the
 * spot row of the day overview, the realtime event's `cellRef`).
 */
export function toPublicTimedReservation(row: TimedReservationRow): PublicTimedReservation {
  const { parkingSpotId: _parkingSpotId, date: _date, ...rest } = toContractTimedReservation(row);
  return rest;
}

/**
 * The singleton settings row. `id` and `updatedAt` are storage-only — the
 * contract's `reservationWindowSettingsSchema` has neither.
 */
export function toContractWindowSettings(
  row: ReservationWindowSettingsRow
): ReservationWindowSettings {
  return { openDaysBefore: row.openDaysBefore, lockMode: row.lockMode };
}

/**
 * The limits singleton row. Like its neighbour above, `id` and `updatedAt` are
 * storage-only — the contract's `reservationLimitSettingsSchema` has neither.
 */
export function toContractLimitSettings(
  row: ReservationLimitSettingsRow
): ReservationLimitSettings {
  return { monthlyReservationCap: row.monthlyReservationCap };
}
