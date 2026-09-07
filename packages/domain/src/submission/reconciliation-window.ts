import { epochMillis, type EpochMillis } from "../pricing/units";
import { DEFAULT_RECONCILIATION_WINDOW_MS } from "../orchestration/certainty";

/**
 * How long uncertainty is allowed to stay open, and when a silent attempt
 * becomes one.
 *
 * Both figures here are measured **from the submission boundary** — the moment
 * the attempt committed to crossing — and that is what makes the deadline well
 * behaved. Two workers can enter uncertainty for the same attempt by different
 * routes (one observing a timeout directly, another sweeping up a stale row
 * hours later) and both compute **the same deadline**, because neither derives
 * it from when it happened to look. A retry therefore cannot extend the bound on
 * how long the platform carries an unresolved charge, and a delayed sweeper
 * simply inherits less remaining time rather than granting itself more.
 *
 * Note what is *not* derived here: `reconciliationStartedAt`. That is a record
 * of when the system first durably concluded it did not know, which for a stale
 * attempt is hours after the boundary. Deriving it from the boundary would have
 * backdated operational history — see ADR-0036 §2.
 */

/**
 * The longest a reconciliation window may be.
 *
 * The Phase 4C-3B-2E default *is* the ceiling — 24 hours — and this names it as
 * a ceiling rather than declaring a second constant that could drift from it.
 * A configured window may be shorter; none may be longer.
 *
 * The ceiling matters because an attempt in `RECONCILIATION_PENDING` holds
 * uncertain provider cost against its organization's Safety Guard for the whole
 * window, so a window measured in days would let one incident suppress a
 * tenant's throughput long after anyone could still find out what happened.
 */
export const MAX_RECONCILIATION_WINDOW_MS = DEFAULT_RECONCILIATION_WINDOW_MS;

/**
 * There is deliberately no default stale-`SUBMITTING` threshold, and no way to
 * skip validating one.
 *
 * How long an attempt may sit at the boundary before it is presumed lost is a
 * production-activation decision that depends on real provider latency
 * distributions nobody has measured yet, and shipping a plausible-looking
 * constant is how a guess becomes policy: the number gets quoted, then relied
 * on, and no one revisits where it came from. Too short and an ordinary slow
 * provider response is mistaken for a dead worker, converting a live paid
 * submission into permanent uncertainty; too long and a genuinely crashed
 * submission holds its reservation hostage.
 *
 * A caller therefore supplies a validated `ReconciliationPolicy`. Tests pick
 * whatever deterministic value is convenient; those are fixtures, not policy.
 * The unresolved production value is tracked in `docs/decisions/TODO.md`.
 */

/**
 * What an operator writes down: two numbers, unchecked.
 *
 * This is the *input* type. It is deliberately structural and deliberately
 * useless on its own — nothing in this phase accepts it, and it exists only to
 * name the shape a caller hands to the validator.
 */
export interface ReconciliationPolicyConfig {
  readonly reconciliationWindowMs: number;
  readonly staleSubmittingAfterMs: number;
}

declare const VALIDATED_RECONCILIATION_POLICY: unique symbol;

/**
 * The nominal marker that separates a checked policy from a plausible object.
 *
 * A `unique symbol` property that no literal can produce, so the only way to
 * obtain a `ReconciliationPolicy` is to pass through
 * `validateReconciliationPolicy`.
 */
export interface ValidatedReconciliationPolicyBrand {
  readonly [VALIDATED_RECONCILIATION_POLICY]: true;
}

/**
 * A policy that has been checked, and can prove it.
 *
 * Having a validator is not the same as enforcing one. While the consumed type
 * was structural, this compiled and ran:
 *
 * ```ts
 * { reconciliationWindowMs: 86_400_001, staleSubmittingAfterMs: 1_000 }
 * ```
 *
 * — a window past the 24-hour ceiling, reaching the service without ever meeting
 * the validator, because it happened to have the right two fields. The bounds
 * were documented rather than enforced, which is the same failure mode as
 * "we agreed not to do that".
 *
 * The brand makes the check unavoidable rather than conventional. Every consumer
 * in this phase — `SubmissionOutcomeDeps`, `decideSubmissionOutcome`,
 * `reconciliationDeadlineFor`, `staleSubmittingBoundary`, `isStaleSubmitting` —
 * takes this type, so a raw object is a compile error at the call site rather
 * than an out-of-range deadline discovered in production.
 */
export type ReconciliationPolicy = Readonly<{
  reconciliationWindowMs: number;
  staleSubmittingAfterMs: number;
}> &
  ValidatedReconciliationPolicyBrand;

export type ReconciliationPolicyResult =
  | { readonly ok: true; readonly policy: ReconciliationPolicy }
  | { readonly ok: false; readonly reason: ReconciliationPolicyFailure };

export type ReconciliationPolicyFailure =
  | "RECONCILIATION_WINDOW_NOT_POSITIVE"
  | "RECONCILIATION_WINDOW_TOO_LONG"
  | "STALE_THRESHOLD_NOT_POSITIVE"
  | "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE";

/**
 * Validate a configured policy, returning a result rather than throwing.
 *
 * Configuration arrives from outside the process and a bad value is an
 * operator mistake, not a programming defect — so it is answerable, and the
 * caller decides whether to refuse startup or fall back. Throwing here would
 * turn a typo in an environment variable into a crash with no closed outcome.
 */
export function validateReconciliationPolicy(
  input: ReconciliationPolicyConfig,
): ReconciliationPolicyResult {
  const { reconciliationWindowMs, staleSubmittingAfterMs } = input;
  if (!Number.isSafeInteger(reconciliationWindowMs) || reconciliationWindowMs <= 0) {
    return { ok: false, reason: "RECONCILIATION_WINDOW_NOT_POSITIVE" };
  }
  if (reconciliationWindowMs > MAX_RECONCILIATION_WINDOW_MS) {
    return { ok: false, reason: "RECONCILIATION_WINDOW_TOO_LONG" };
  }
  if (!Number.isSafeInteger(staleSubmittingAfterMs) || staleSubmittingAfterMs <= 0) {
    return { ok: false, reason: "STALE_THRESHOLD_NOT_POSITIVE" };
  }
  // Strictly before, not at-or-before. At equality the attempt becomes stale
  // exactly when its reconciliation deadline arrives, so the uncertainty it
  // enters is already expired — a window that exists only as an instant. Beyond
  // equality is worse still. Both are the same defect and both are refused.
  if (staleSubmittingAfterMs >= reconciliationWindowMs) {
    return { ok: false, reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE" };
  }
  // The one place the brand is applied, and the only reason this cast exists:
  // every path to it has just been checked. Values are passed through
  // unchanged — never clamped, never defaulted — because silently repairing an
  // operator's number would hide the mistake rather than report it.
  return {
    ok: true,
    policy: { reconciliationWindowMs, staleSubmittingAfterMs } as ReconciliationPolicy,
  };
}

/**
 * When uncertainty for this attempt must be resolved by.
 *
 * `submissionBoundaryEnteredAt + window`, and nothing else. Never `now`, never
 * the current time plus a window, never a value a caller supplies.
 */
export function reconciliationDeadlineFor(
  submissionBoundaryEnteredAt: EpochMillis,
  policy: ReconciliationPolicy,
): EpochMillis {
  return epochMillis(submissionBoundaryEnteredAt + policy.reconciliationWindowMs);
}

/**
 * The instant at or after which a `SUBMITTING` attempt is presumed lost.
 */
export function staleSubmittingBoundary(
  submissionBoundaryEnteredAt: EpochMillis,
  policy: ReconciliationPolicy,
): EpochMillis {
  return epochMillis(submissionBoundaryEnteredAt + policy.staleSubmittingAfterMs);
}

/**
 * Is this attempt stale *now*?
 *
 * At-or-after, not strictly after. The threshold is the first instant at which
 * the attempt counts as lost, so an attempt exactly at its boundary is stale.
 * The opposite reading would leave one instant in which nothing may act, which
 * is the kind of off-by-one that only ever shows up as a stuck row.
 */
export function isStaleSubmitting(input: {
  readonly submissionBoundaryEnteredAt: EpochMillis;
  readonly now: EpochMillis;
  readonly policy: ReconciliationPolicy;
}): boolean {
  return input.now >= staleSubmittingBoundary(input.submissionBoundaryEnteredAt, input.policy);
}
