/**
 * Day eligibility, which is the one part of Task 13 that is pure.
 *
 * Everything else in this task — the transaction, the row lock, the retry, the
 * `P2002` mapping — is a property of PostgreSQL and is tested against a real one
 * in `*.db.spec.ts`. This file is what is left when the database is taken away:
 * which rule applies to whom, and which contract code each failure carries.
 */

import type { ReservationWindowSettings } from '@garage/contract';
import type { DateOnly } from '@garage/shared-types';
import { isBusinessDay } from '@garage/shared-types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DomainError } from '../common/errors/domain-error';
import { ReservationPolicy } from './reservation-policy';

const AUTO: ReservationWindowSettings = { openDaysBefore: 7, lockMode: 'AUTO' };
const FORCE_LOCKED: ReservationWindowSettings = { openDaysBefore: 7, lockMode: 'FORCE_LOCKED' };
const FORCE_OPEN: ReservationWindowSettings = { openDaysBefore: 7, lockMode: 'FORCE_OPEN' };

const USER: AuthenticatedUser = {
  id: 'user-1',
  oktaId: 'okta-1',
  email: 'user@example.test',
  name: 'User',
  role: 'USER',
  active: true,
};
const ADMIN: AuthenticatedUser = { ...USER, id: 'admin-1', role: 'ADMIN' };

const TODAY = '2026-09-02' as DateOnly;
/**
 * A "today" inside October's automatic window. With `openDaysBefore: 7` that
 * window is 2026-09-24 … 2026-09-30 inclusive, so `TODAY` above is *before* it —
 * which is what makes `TODAY` useful for the `NOT_YET_OPEN` cases.
 */
const OPEN_WINDOW_TODAY = '2026-09-25' as DateOnly;
/** A Monday in October, the month `OPEN_WINDOW_TODAY` has open. */
const OPEN_MONTH_DAY = '2026-10-05' as DateOnly;
const YESTERDAY = '2026-09-01' as DateOnly;
const SATURDAY = '2026-10-03' as DateOnly;
/** Far enough out that `AUTO` has not opened its month yet. */
const DISTANT_DAY = '2027-05-03' as DateOnly;
/** In the current month, which `AUTO` keeps open once it has begun. */
const THIS_MONTH_DAY = '2026-09-30' as DateOnly;

/** The code of the `DomainError` `work` throws, or a failure if it throws nothing. */
function codeOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('Expected the policy to reject this, but it allowed it.');
}

describe('ReservationPolicy', () => {
  const policy = new ReservationPolicy();

  it('uses dates the surrounding tests assume — otherwise every case below is vacuous', () => {
    // A wrong pick here would silently turn "rejected for the weekend" into
    // "rejected for the window", and the assertions would still pass.
    expect(isBusinessDay(OPEN_MONTH_DAY)).toBe(true);
    expect(isBusinessDay(DISTANT_DAY)).toBe(true);
    expect(isBusinessDay(THIS_MONTH_DAY)).toBe(true);
    expect(isBusinessDay(SATURDAY)).toBe(false);
  });

  describe('a day that has already gone', () => {
    it('is PAST_DATE for a normal user', () => {
      expect(codeOf(() => policy.assertNotInThePast(YESTERDAY, TODAY))).toBe('PAST_DATE');
    });

    it('is PAST_DATE for an admin too — the exemption is about the window, not the past', () => {
      expect(codeOf(() => policy.assertMayTakeDay(YESTERDAY, ADMIN, FORCE_OPEN, TODAY))).toBe(
        'PAST_DATE'
      );
    });

    it('allows today itself', () => {
      expect(() => policy.assertNotInThePast(TODAY, TODAY)).not.toThrow();
    });
  });

  describe('a weekend or a public holiday', () => {
    it('is VALIDATION_FAILED, with the reason in the details', () => {
      let thrown: DomainError | undefined;
      try {
        policy.assertBusinessDay(SATURDAY);
      } catch (error) {
        thrown = error as DomainError;
      }

      expect(thrown?.code).toBe('VALIDATION_FAILED');
      expect(thrown?.details).toEqual({ date: SATURDAY, reason: 'NOT_A_BUSINESS_DAY' });
    });

    it('is refused for an admin as well — the lot is shut, not locked', () => {
      expect(codeOf(() => policy.assertMayTakeDay(SATURDAY, ADMIN, FORCE_OPEN, TODAY))).toBe(
        'VALIDATION_FAILED'
      );
    });

    it('is reported ahead of the window, so the user is told the durable fact first', () => {
      // A Saturday in a locked month is still a Saturday next month.
      expect(codeOf(() => policy.assertMayTakeDay(SATURDAY, USER, FORCE_LOCKED, TODAY))).toBe(
        'VALIDATION_FAILED'
      );
    });
  });

  describe('the reservation window', () => {
    it('maps NOT_YET_OPEN to OUT_OF_HORIZON', () => {
      expect(codeOf(() => policy.assertMayTakeDay(DISTANT_DAY, USER, AUTO, TODAY))).toBe(
        'OUT_OF_HORIZON'
      );
    });

    it('maps LOCKED to RESERVATIONS_LOCKED', () => {
      expect(codeOf(() => policy.assertMayTakeDay(THIS_MONTH_DAY, USER, FORCE_LOCKED, TODAY))).toBe(
        'RESERVATIONS_LOCKED'
      );
    });

    it('lets a normal user book the running month under AUTO — leftovers are free for all', () => {
      expect(() => policy.assertMayTakeDay(THIS_MONTH_DAY, USER, AUTO, TODAY)).not.toThrow();
    });

    it('lets a normal user through an open month', () => {
      expect(() =>
        policy.assertMayTakeDay(OPEN_MONTH_DAY, USER, AUTO, OPEN_WINDOW_TODAY)
      ).not.toThrow();
    });

    it('refuses that same user and day one day before the window opens', () => {
      // The pair with the case above is the assertion: the only thing that
      // changed is `today`, so the window really is what decided.
      expect(codeOf(() => policy.assertMayTakeDay(OPEN_MONTH_DAY, USER, AUTO, TODAY))).toBe(
        'OUT_OF_HORIZON'
      );
    });

    it('does not apply to an admin, in either direction', () => {
      expect(() => policy.assertMayTakeDay(DISTANT_DAY, ADMIN, AUTO, TODAY)).not.toThrow();
      expect(() => policy.assertMayTakeDay(THIS_MONTH_DAY, ADMIN, AUTO, TODAY)).not.toThrow();
      expect(() =>
        policy.assertMayTakeDay(OPEN_MONTH_DAY, ADMIN, FORCE_LOCKED, TODAY)
      ).not.toThrow();
    });

    it('honours the admin override in both directions for a normal user', () => {
      expect(() => policy.assertWindowOpen(DISTANT_DAY, USER, FORCE_OPEN, TODAY)).not.toThrow();
      expect(codeOf(() => policy.assertWindowOpen(OPEN_MONTH_DAY, USER, FORCE_LOCKED, TODAY))).toBe(
        'RESERVATIONS_LOCKED'
      );
    });
  });

  describe('assertMayNameHolder', () => {
    it('allows an omitted holder for anybody — booking for yourself', () => {
      expect(() => policy.assertMayNameHolder(undefined, USER)).not.toThrow();
      expect(() => policy.assertMayNameHolder(undefined, ADMIN)).not.toThrow();
    });

    it('allows a user to name themselves, plate override included', () => {
      expect(() =>
        policy.assertMayNameHolder(
          { kind: 'USER', userId: USER.id, licensePlate: '9XY 8765' },
          USER
        )
      ).not.toThrow();
    });

    it('refuses a non-admin naming another user', () => {
      expect(
        codeOf(() =>
          policy.assertMayNameHolder({ kind: 'USER', userId: ADMIN.id, licensePlate: null }, USER)
        )
      ).toBe('FORBIDDEN');
    });

    it('refuses a non-admin naming a guest', () => {
      expect(
        codeOf(() =>
          policy.assertMayNameHolder({ kind: 'GUEST', name: 'Jan Host', licensePlate: null }, USER)
        )
      ).toBe('FORBIDDEN');
    });

    it('allows an admin to name another user, a guest, and themselves', () => {
      expect(() =>
        policy.assertMayNameHolder({ kind: 'USER', userId: USER.id, licensePlate: null }, ADMIN)
      ).not.toThrow();
      expect(() =>
        policy.assertMayNameHolder({ kind: 'GUEST', name: 'Jan Host', licensePlate: null }, ADMIN)
      ).not.toThrow();
      expect(() =>
        policy.assertMayNameHolder({ kind: 'USER', userId: ADMIN.id, licensePlate: null }, ADMIN)
      ).not.toThrow();
    });
  });
});
