/**
 * Named, not a star. The tools a procedure is *defined* with — `authed`,
 * `contractErrors`, `noInputSchema`, `NoInput` in `./builder`, and
 * `errorDataSchema` in `./errors` — are deliberately not among them:
 * publishing them from `@garage/contract` makes "define a procedure outside
 * `libs/garage/contract`" a supported move, which is the one thing the contract-first
 * rule exists to make impossible. They stay inside the lib, where every module
 * that defines a procedure reaches the builders through `./builder`, as do
 * `builder.spec.ts` and `router.spec.ts`.
 *
 * `ERROR_DEFINITIONS` is different in kind: it is the code→status→message
 * table a consumer legitimately reads, and both apps do
 * (`ContractExceptionFilter`, `DomainError`, `toContractError`).
 *
 * `./bulk` is named rather than starred for the same reason: its day-member
 * and summary schemas exist only to compose `bulkDayPlanSchema` /
 * `bulkDayResultSchema` and stay behind the barrel, while the types
 * consumers actually annotate with (down to `BulkBookingSummary`, the one
 * whose schema stays private but whose inferred type does not) are still
 * published.
 */
export { ERROR_DEFINITIONS } from './errors';
export * from './ics';
export * from './overview';
export * from './reservations';
export * from './waitlist';
export {
  bulkDayOutcomeKindSchema,
  bulkUnavailableReasonSchema,
  bulkBookingInputSchema,
  bulkDayPlanSchema,
  bulkDayResultSchema,
  previewBulkOutputSchema,
  confirmBulkOutputSchema,
  previewBulkContract,
  confirmBulkContract,
  type BulkDayOutcomeKind,
  type BulkUnavailableReason,
  type BulkBookingInput,
  type BulkDayPlan,
  type BulkDayResult,
  type BulkBookingSummary,
  type PreviewBulkOutput,
  type ConfirmBulkOutput,
} from './bulk';
export * from './spots';
export * from './timed-reservations';
export * from './users';
export * from './me';
export * from './reservation-limits';
export * from './reservation-window';
export * from './router';
