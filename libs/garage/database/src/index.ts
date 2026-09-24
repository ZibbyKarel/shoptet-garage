/**
 * `@garage/database` — the only way the backend reaches Postgres.
 *
 * Re-exports the generated Prisma Client so that no other project imports out
 * of `src/generated/**` directly: consumers see one stable entry point and the
 * generator's output path stays an implementation detail of this lib.
 *
 * The NestJS module and `PrismaService` that wrap this live in `apps/garage/api`
 * (Tasks 10 and 12); this lib deliberately knows nothing about Nest.
 */

export { createPrismaClient } from './lib/create-prisma-client';
export type { CreatePrismaClientOptions } from './lib/create-prisma-client';

export { Prisma, PrismaClient } from './generated/prisma/client';
export type {
  AuditLog,
  ParkingSpot,
  Reservation,
  ReservationLimitSettings,
  ReservationWindowSettings,
  TimedReservation,
  User,
  WaitlistEntry,
} from './generated/prisma/client';

export {
  AuditLogAction,
  ParkingGroup,
  ReservationLockMode,
  UserRole,
} from './generated/prisma/enums';

export { RESERVATION_LIMIT_SETTINGS_ID, RESERVATION_WINDOW_SETTINGS_ID } from './lib/seed-data';
