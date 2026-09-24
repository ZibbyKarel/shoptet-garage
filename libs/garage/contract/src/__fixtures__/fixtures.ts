/**
 * Shared fixtures for the contract's own unit tests.
 *
 * Not part of the public API surface — `src/api/index.ts` does not re-export
 * this file. It exists so that thirty procedure tests do not each invent their
 * own uuid and end up asserting against typos.
 *
 * It lives in `__fixtures__/` because `tsconfig.lib.json` excludes that folder:
 * being unreferenced was not enough, the file was still inside the library's
 * compilation program and would have been emitted into a build (Task 4 review,
 * N4). The spec tsconfig includes it explicitly.
 */

/** Valid UUIDs. The contract accepts any version (`doc/decision/0016-*`). */
export const UUID_A = '11111111-1111-4111-8111-111111111111';
export const UUID_B = '22222222-2222-4222-8222-222222222222';
export const UUID_C = '33333333-3333-4333-8333-333333333333';

/** Not a UUID — used as the invalid-input case wherever an id is expected. */
export const NOT_A_UUID = 'nope';

/** A weekday in an open month, and an ISO timestamp. */
export const DATE_A = '2026-09-15';
export const DATE_B = '2026-09-16';
export const TIMESTAMP = '2026-08-28T09:15:00.000Z';

/** Calendar-invalid, so `z.iso.date()` rejects it even though it looks fine. */
export const INVALID_DATE = '2026-02-30';

export const userSummaryFixture = {
  id: UUID_A,
  name: 'Jana Nováková',
  licensePlate: '1AB 2345',
};

export const parkingSpotFixture = {
  id: UUID_B,
  label: 'E2.92',
  group: 'SHARED',
  active: true,
  hidden: false,
  evCharger: false,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

export const userFixture = {
  ...userSummaryFixture,
  email: 'jana.novakova@example.com',
  role: 'USER',
  oktaId: 'okta|123',
  active: true,
  icsToken: 'ics-token-abc',
  preferredParkingSpotId: UUID_B,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
