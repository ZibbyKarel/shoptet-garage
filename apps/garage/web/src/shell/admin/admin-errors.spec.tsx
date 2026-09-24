import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { contract, ERROR_CODES } from '@garage/contract';
import type { ErrorCode } from '@garage/contract';
import { IntlProvider } from '@garage/i18n';
import cs from '../../../messages/cs.json';
import { failureWithCode } from '../../testing/contract-failure';
import { ADMIN_WRITE_MESSAGES, useAdminWriteError, type AdminWrite } from './admin-errors';

/**
 * Failures come from {@link failureWithCode} — a **real** `RPCLink` with only
 * `fetch` replaced. A hand-built `ORPCError` would assert this file's idea of
 * the wire shape instead of the transport's, and `apps/garage/web` may not import
 * `@orpc/client` at all to build one directly.
 */

function wrapper({ children }: { children: ReactNode }) {
  return (
    <IntlProvider locale="cs" messages={cs}>
      {children}
    </IntlProvider>
  );
}

function describeWith(): (write: AdminWrite, failure: unknown) => string | null {
  const { result } = renderHook(() => useAdminWriteError(), { wrapper });
  return result.current;
}

describe('useAdminWriteError', () => {
  it('says nothing when nothing failed', () => {
    const describe_ = describeWith();

    expect(describe_('userUpdate', null)).toBeNull();
    expect(describe_('userUpdate', undefined)).toBeNull();
  });

  describe('the same code, a different sentence per operation', () => {
    it('reads CONFLICT as the last-admin rule on a user change', async () => {
      const describe_ = describeWith();

      expect(describe_('userUpdate', await failureWithCode('CONFLICT'))).toBe('errUserConflict');
    });

    it('reads CONFLICT as a duplicate label when creating a spot', async () => {
      const describe_ = describeWith();

      expect(describe_('spotCreate', await failureWithCode('CONFLICT'))).toBe(
        'spotsDuplicateLabel'
      );
    });

    it('reads CONFLICT as a live reservation when retiring a spot', async () => {
      const describe_ = describeWith();

      expect(describe_('spotRetire', await failureWithCode('CONFLICT'))).toBe(
        'spotsDeleteConflict'
      );
    });

    it('refuses to guess a cause for CONFLICT when switching a spot back on', async () => {
      // Reviving collides with nothing — `SpotsService.update` only checks
      // reservations on the way *off*, and the label is unchanged. Claiming a
      // duplicate label here would be inventing a reason.
      const describe_ = describeWith();

      expect(describe_('spotRevive', await failureWithCode('CONFLICT'))).toBe('errFallbackSpot');
    });

    it('never reuses the reservation wording for VALIDATION_FAILED', async () => {
      // `errors.VALIDATION_FAILED` is "Požadavek porušuje pravidlo rezervací
      // (např. víkend nebo svátek)." — true of a booking, nonsense on a role
      // change, a spot rename or a stepper.
      const describe_ = describeWith();
      const failure = await failureWithCode('VALIDATION_FAILED');

      for (const write of Object.keys(ADMIN_WRITE_MESSAGES) as AdminWrite[]) {
        expect(describe_(write, failure)).not.toBe(cs.errors.VALIDATION_FAILED);
      }

      expect(describe_('userUpdate', failure)).toBe('errUserValidation');
      expect(describe_('spotRename', failure)).toBe('errSpotValidation');
      expect(describe_('windowUpdate', failure)).toBe('errWindowValidation');
    });
  });

  describe('the fallback', () => {
    it('is used for a transport failure, which carries no code at all', () => {
      const describe_ = describeWith();

      expect(describe_('spotCreate', new Error('connection refused'))).toBe('errFallbackSpot');
      expect(describe_('windowUpdate', new Error('connection refused'))).toBe('errFallbackWindow');
    });

    it('never leaks the thrown error’s own message', () => {
      const describe_ = describeWith();

      expect(describe_('userUpdate', new Error('ECONNREFUSED 127.0.0.1:3000'))).not.toMatch(
        /ECONNREFUSED/u
      );
    });

    it('is used for every code the operation has no sentence for', async () => {
      const describe_ = describeWith();

      // `SPOT_ALREADY_RESERVED` is a booking failure; no admin write declares
      // it, so every operation must fall back rather than translate it.
      const failure = await failureWithCode('SPOT_ALREADY_RESERVED');
      expect(describe_('userUpdate', failure)).toBe('errFallbackUser');
      expect(describe_('spotRetire', failure)).toBe('errFallbackSpot');
    });
  });

  describe('the table itself', () => {
    it('answers a non-empty Czech sentence for every operation and every code', async () => {
      const describe_ = describeWith();

      for (const code of ERROR_CODES) {
        const failure = await failureWithCode(code);
        for (const write of Object.keys(ADMIN_WRITE_MESSAGES) as AdminWrite[]) {
          const message = describe_(write, failure);
          expect(message).toBeTruthy();
          // A missing catalog key would come back as the key name; next-intl
          // does not throw for one.
          expect(message).not.toMatch(/^admin\./u);
        }
      }
    });

    it('names only codes the contract actually declares', () => {
      const declared = new Set<string>(ERROR_CODES);

      for (const { byCode } of Object.values(ADMIN_WRITE_MESSAGES)) {
        for (const code of Object.keys(byCode)) {
          expect(declared.has(code)).toBe(true);
        }
      }
    });

    it('covers every code the admin procedures can raise', () => {
      // The point of the table is that the *declared* failures each get a
      // sentence of their own; anything else is allowed to fall back. Read off
      // the contract rather than restated, so adding an error code to a
      // procedure fails here until the copy is written.
      const declaredOn = (procedure: unknown): ErrorCode[] =>
        Object.keys(
          (procedure as { '~orpc': { errorMap: Record<string, unknown> } })['~orpc'].errorMap
        ) as ErrorCode[];

      // Every write, including the ones that map nothing new. Leaving one out
      // of this list is how a gap becomes invisible.
      const expectations: [AdminWrite, ErrorCode[]][] = [
        ['userUpdate', declaredOn(contract.admin.user.update)],
        ['spotCreate', declaredOn(contract.admin.spot.create)],
        ['spotRename', declaredOn(contract.admin.spot.update)],
        ['spotRetire', declaredOn(contract.admin.spot.deactivate)],
        ['spotRevive', declaredOn(contract.admin.spot.update)],
        ['spotVisibility', declaredOn(contract.admin.spot.update)],
        ['windowUpdate', declaredOn(contract.admin.window.update)],
      ];

      /**
       * Codes a write deliberately leaves to the fallback, because it has no
       * true sentence for them. Declared rather than quietly skipped: an
       * exemption that has to be written down is one somebody can argue with.
       */
      const unmapped: Partial<Record<AdminWrite, readonly ErrorCode[]>> = {
        // Switching a spot back on collides with nothing (`SpotsService.update`
        // only checks reservations on the way off) and sends neither a label
        // nor a group, so neither code has a cause to name.
        spotRevive: ['CONFLICT', 'VALIDATION_FAILED'],
        // Hiding or unhiding sends neither a label nor a group and runs no
        // commitment check (`SpotsService.update`), so neither code has a cause.
        spotVisibility: ['CONFLICT', 'VALIDATION_FAILED'],
      };

      for (const [write, codes] of expectations) {
        expect(codes.length).toBeGreaterThan(0);
        const exempt = unmapped[write] ?? [];
        for (const code of codes) {
          if (exempt.includes(code)) {
            expect(ADMIN_WRITE_MESSAGES[write].byCode[code]).toBeUndefined();
          } else {
            expect(ADMIN_WRITE_MESSAGES[write].byCode[code]).toBeDefined();
          }
        }
        // An exemption for a code the procedure no longer declares is dead
        // text, and dead text is how a stale reason outlives its reason.
        for (const code of exempt) {
          expect(codes).toContain(code);
        }
      }
    });
  });
});
