/**
 * The whole API contract, assembled.
 *
 * This object is the binding list of what the backend may implement and what
 * the frontend may call. `apps/garage/api` (Task 12) implements it, `libs/shared/api-client`
 * (Task 11) types the client from it, and nothing outside it may exist.
 *
 * Grouping follows who calls it, not which table it touches: everything under
 * `admin` requires `role: 'ADMIN'`, everything else is available to any active
 * user. That is why spot reads appear twice — `spot.list` for the settings
 * picker, `admin.spot.list` for the management table with its filters.
 */

import type { ContractRouterClient } from '@orpc/contract';
import { confirmBulkContract, previewBulkContract } from './bulk';
import { getMyProfileContract, regenerateIcsTokenContract, updateMySettingsContract } from './me';
import { getDayOverviewContract } from './overview';
import {
  getReservationLimitSettingsContract,
  updateReservationLimitSettingsContract,
} from './reservation-limits';
import {
  cancelReservationContract,
  createReservationContract,
  getMyMonthReservationsContract,
  getUserMonthReservationsContract,
} from './reservations';
import {
  getReservationWindowSettingsContract,
  listMonthWindowsContract,
  updateReservationWindowSettingsContract,
} from './reservation-window';
import {
  adminListSpotsContract,
  createSpotContract,
  deactivateSpotContract,
  listSpotsContract,
  updateSpotContract,
} from './spots';
import {
  cancelTimedReservationContract,
  createTimedReservationContract,
} from './timed-reservations';
import { adminListUsersContract, adminUpdateUserContract } from './users';
import { joinWaitlistContract, leaveWaitlistContract } from './waitlist';

export const contract = {
  overview: {
    /** Spots, reservations, queue counts and the window state for one day. */
    day: getDayOverviewContract,
  },
  reservation: {
    create: createReservationContract,
    cancel: cancelReservationContract,
    /** Read-only proposal for a set of days in one month. Writes nothing. */
    previewBulk: previewBulkContract,
    /** Same input, real writes, real result. */
    confirmBulk: confirmBulkContract,
    /** The caller's own reserved dates and count for one calendar month. */
    myMonth: getMyMonthReservationsContract,
  },
  waitlist: {
    join: joinWaitlistContract,
    leave: leaveWaitlistContract,
  },
  spot: {
    /** Active spots, for the preferred-spot picker. Any user. */
    list: listSpotsContract,
  },
  me: {
    get: getMyProfileContract,
    updateSettings: updateMySettingsContract,
    regenerateIcsToken: regenerateIcsTokenContract,
  },
  admin: {
    reservation: {
      /**
       * One named user's reserved dates and count for one calendar month.
       * The holder-scoped counterpart of `reservation.myMonth`, for the bulk
       * modal's cap when an admin books on somebody else's behalf.
       */
      month: getUserMonthReservationsContract,
    },
    reservationLimits: {
      /** The singleton reservation limits — today just the monthly cap. */
      get: getReservationLimitSettingsContract,
      /** Full replacement of the singleton. Audited. */
      update: updateReservationLimitSettingsContract,
    },
    spot: {
      list: adminListSpotsContract,
      create: createSpotContract,
      update: updateSpotContract,
      deactivate: deactivateSpotContract,
    },
    timedReservation: {
      /** Book a spot for a guest for a half-hour-granular block of one day. */
      create: createTimedReservationContract,
      /** Remove one block. */
      cancel: cancelTimedReservationContract,
    },
    user: {
      list: adminListUsersContract,
      update: adminUpdateUserContract,
    },
    window: {
      get: getReservationWindowSettingsContract,
      update: updateReservationWindowSettingsContract,
      /** Per-month state table for the "Rezervační okno" admin tab. */
      months: listMonthWindowsContract,
    },
  },
};

export type Contract = typeof contract;

/**
 * The whole contract as a **callable client**: every procedure above, with its
 * input, output and declared error codes derived from the Zod schemas.
 *
 * This alias lives here rather than in `libs/shared/api-client` on purpose.
 * `ContractRouterClient` comes from `@orpc/contract`, and that package is
 * allow-listed for the `type:contract` tag **only** (`NPM_ALLOWLIST.contract` in
 * `eslint.config.mjs`, which is deliberately narrow — see
 * `doc/decision/0007-*`). Applying it here means `libs/shared/api-client` can type its
 * client without `@orpc/contract` being opened up to every `type:util` lib,
 * which would also have handed it to `libs/shared/form`, `libs/shared/i18n` and every wrapper
 * still to come.
 *
 * It is a **type**, so nothing of `@orpc/contract` reaches the runtime through
 * it: the transport still comes from `@orpc/client`, which only
 * `libs/shared/api-client` may import. Exporting a type from the contract lib is also
 * what this lib is for — `Contract` itself is already exported the same way.
 *
 * `TClientContext` stays at its default (`Record<never, never>`): every request
 * carries the same bearer token, resolved by the client's own token provider,
 * so there is nothing a call site needs to thread through.
 */
export type ContractClient = ContractRouterClient<Contract>;
