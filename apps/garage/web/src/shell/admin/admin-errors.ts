'use client';

/**
 * What a failed admin **write** says, per operation.
 *
 * ## Why not `t('errors.' + code)`
 *
 * Because the same contract code means different things on different
 * procedures, and a sentence that is true for one is a false explanation on the
 * other. `CONFLICT` is the clearest case:
 *
 * | procedure                | what `CONFLICT` actually is                       |
 * | ------------------------ | ------------------------------------------------- |
 * | `admin.user.update`      | the last active administrator would be gone       |
 * | `admin.spot.create`      | the label is already painted on another spot      |
 * | `admin.spot.update`      | a duplicate label **or** a spot still held today  |
 * | `admin.spot.deactivate`  | somebody holds the spot from today onwards        |
 * | `admin.window.update`    | nothing the client can cause; a concurrent write  |
 * | `admin.reservationLimits.update` | nothing the client can cause; a concurrent write |
 *
 * The `errors` namespace has one sentence per code, written for a reader with
 * no context — right for a screen that failed to load (`ScreenError`), wrong
 * here. Its `VALIDATION_FAILED` even says "weekend or holiday", which has
 * nothing to do with renaming a parking spot.
 *
 * So the mapping is by **(operation, code)** and it is a table, not a chain of
 * conditionals — a table can be read against the contract's `.errors(...)`
 * declarations to see what is missing.
 *
 * ## `admin.spot.update` is three operations, not one
 *
 * One procedure, three intents, and `CONFLICT` means something different in
 * each: renaming can collide with another label, switching a spot **off** can
 * collide with a live reservation, and switching one **on** can collide with
 * neither. The caller says which it asked for; nothing in the response could.
 *
 * ## The fallback never guesses
 *
 * A code with no entry (or a transport failure, which has no code at all) gets
 * the operation's `errFallback*`: "it did not save, try again". That is true of
 * anything unexpected. Falling through to a specific sentence would be the bug
 * this file exists to avoid.
 */

import { toContractError } from '@garage/api-client';
import type { ErrorCode } from '@garage/contract';
import { useTranslations } from '@garage/i18n';
// Type-only: the key space now lives in the catalog itself, not in a
// hand-written interface in `libs/shared/i18n` (`doc/i18n.md`).
import type cs from '../../../messages/cs.json';

/**
 * One admin write, as the screen that started it understands it — not as the
 * transport does. See the note above on `admin.spot.update`.
 */
export type AdminWrite =
  | 'userUpdate'
  | 'spotCreate'
  | 'spotRename'
  | 'spotRetire'
  | 'spotRevive'
  | 'spotVisibility'
  | 'spotEvCharger'
  | 'windowUpdate'
  | 'limitsUpdate';

/**
 * A write that failed, and which write it was.
 *
 * One value, not two props, because the two halves are one fact: a `where`
 * without an `error` describes nothing, and an `error` without a `where` has no
 * sentence to be printed as — {@link useAdminWriteError} needs both, and a
 * screen holding them apart has to re-check on every read that they agree.
 * `null` is "no failure", and it is the only way to say that.
 */
export interface AdminWriteFailure {
  /** Whatever the failing create/update/deactivate threw. */
  readonly error: unknown;
  /**
   * Which write it came from.
   *
   * Required, not derived: `admin.spot.update` backs three different intents
   * and its `CONFLICT` means something different in each, and the response
   * cannot say which one was asked for.
   */
  readonly from: AdminWrite;
}

/**
 * A key in the `admin` namespace.
 *
 * Derived from the catalogue rather than aliased to `string`: the alias
 * documented the intent and enforced nothing, so a typo in the table below
 * reached `t()` and printed the key itself. `apps/garage/web/messages/cs.json` owns
 * the key space, so this is the one honest way to say it — and it is the
 * same shape the rest of the app's view modules already use
 * (`BannerMessageKey`, `BulkErrorMessageKey`), spelled as a derivation
 * instead of by hand.
 */
type MessageKey = keyof (typeof cs)['admin'];

/**
 * `FORBIDDEN` is inherited by every authenticated procedure, so it is spread
 * into each row rather than repeated by hand. It also happens to be the one
 * code whose meaning does not change with the operation.
 */
const FORBIDDEN_ROW = { FORBIDDEN: 'errForbidden' } as const;

const MESSAGES: Record<
  AdminWrite,
  { readonly fallback: MessageKey; readonly byCode: Partial<Record<ErrorCode, MessageKey>> }
> = {
  userUpdate: {
    fallback: 'errFallbackUser',
    byCode: {
      ...FORBIDDEN_ROW,
      // The other `CONFLICT` case — deactivating yourself — is unreachable from
      // this screen: the switch on your own row is disabled. If that guard is
      // ever removed, this sentence becomes wrong and the test that pins the
      // disabled switch is what will say so.
      CONFLICT: 'errUserConflict',
      NOT_FOUND: 'errUserNotFound',
      VALIDATION_FAILED: 'errUserValidation',
    },
  },
  spotCreate: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      CONFLICT: 'spotsDuplicateLabel',
      VALIDATION_FAILED: 'errSpotValidation',
    },
  },
  spotRename: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      CONFLICT: 'spotsDuplicateLabel',
      NOT_FOUND: 'errSpotNotFound',
      VALIDATION_FAILED: 'errSpotValidation',
    },
  },
  spotRetire: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      CONFLICT: 'spotsDeleteConflict',
      NOT_FOUND: 'errSpotNotFound',
    },
  },
  spotRevive: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      // Deliberately **no** `CONFLICT`: turning a spot back on collides with
      // nothing (`SpotsService.update` only checks reservations when `active`
      // goes to `false`, and the label is unchanged). Claiming a duplicate
      // label here would be inventing a cause.
      NOT_FOUND: 'errSpotNotFound',
    },
  },
  spotVisibility: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      // No `CONFLICT` and no `VALIDATION_FAILED`: hiding is not retiring
      // (`SpotsService.update` checks commitments only when `active` goes to
      // `false`), and neither a label nor a group is sent.
      NOT_FOUND: 'errSpotNotFound',
    },
  },
  spotEvCharger: {
    fallback: 'errFallbackSpot',
    byCode: {
      ...FORBIDDEN_ROW,
      // No `CONFLICT` and no `VALIDATION_FAILED`: the charger flag is
      // information only (`SpotsService.update` checks commitments only when
      // `active` goes to `false`), and neither a label nor a group is sent.
      NOT_FOUND: 'errSpotNotFound',
    },
  },
  windowUpdate: {
    fallback: 'errFallbackWindow',
    byCode: {
      ...FORBIDDEN_ROW,
      CONFLICT: 'errWindowConflict',
      VALIDATION_FAILED: 'errWindowValidation',
    },
  },
  limitsUpdate: {
    fallback: 'errFallbackLimits',
    byCode: {
      ...FORBIDDEN_ROW,
      CONFLICT: 'errLimitsConflict',
      VALIDATION_FAILED: 'errLimitsValidation',
    },
  },
};

/**
 * Returns a formatter for admin write failures. `null` in, `null` out — so a
 * caller can hand it a mutation's `error` and render nothing when there is
 * nothing wrong.
 */
export function useAdminWriteError(): (write: AdminWrite, failure: unknown) => string | null {
  const t = useTranslations('admin');

  return (write: AdminWrite, failure: unknown): string | null => {
    if (failure == null) {
      return null;
    }
    const { fallback, byCode } = MESSAGES[write];
    const code = toContractError(failure)?.code;
    return t((code === undefined ? undefined : byCode[code]) ?? fallback);
  };
}

/** Exposed for the spec, which reads the table against the contract. */
export const ADMIN_WRITE_MESSAGES = MESSAGES;
