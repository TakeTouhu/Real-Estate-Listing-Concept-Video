import { epochMillis, type EpochMillis } from "../pricing/units";
import { DEFAULT_RECONCILIATION_WINDOW_MS } from "../orchestration/certainty";

/**
 * How long uncertainty is allowed to stay open, and when a silent attempt
 * becomes one.
 *
 * Both figures are anchored to the same instant — `submissionBoundaryEnteredAt`,
 * the moment the attempt committed to crossing — and that choice is what makes
 * the rest of this phase well behaved. Two workers can enter uncertainty for
 * the same attempt by different routes (one observing a timeout directly,
 * another sweeping up a stale row hours later) and both compute **the same
 * deadline**, because neither derives it from when it happened to look. The
 * race between them is therefore benign: whichever commits first, the second
 * sees durable state identical to what it would have written, and replays.
 *
 * Deriving from "now" would have made those two paths disagree, made replay
 * non-idempotent, and — worst — let a retry quietly extend a deadline that was
 * supposed to bound how long the platform carries an unresolved charge.
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
 * How long an attempt may sit in `SUBMITTING` before it is presumed lost.
 *
 * Fifteen minutes. Long enough that an ordinary slow provider response is never
 * mistaken for a dead worker, short enough that a genuinely crashed submission
 * does not hold its reservation hostage for a day. It is deliberately far
 * shorter than the reconciliation window: becoming *uncertain* should happen
 * quickly, while *resolving* that uncertainty is what gets the long budget.
 */
export const DEFAULT_STALE_SUBMITTING_AFTER_MS = 15 * 60 * 1000;

export interface ReconciliationPolicy {
  readonly reconciliationWindowMs: number;
  readonly staleSubmittingAfterMs: number;
}

export type ReconciliationPolicyResult =
  | { readonly ok: true; readonly policy: ReconciliationPolicy }
  | { readonly ok: false; readonly reason: ReconciliationPolicyFailure };

export type ReconciliationPolicyFailure =
  | "RECONCILIATION_WINDOW_NOT_POSITIVE"
  | "RECONCILIATION_WINDOW_TOO_LONG"
  | "STALE_THRESHOLD_NOT_POSITIVE"
  | "STALE_THRESHOLD_EXCEEDS_WINDOW";

/**
 * Validate a configured policy, returning a result rather than throwing.
 *
 * Configuration arrives from outside the process and a bad value is an
 * operator mistake, not a programming defect — so it is answerable, and the
 * caller decides whether to refuse startup or fall back. Throwing here would
 * turn a typo in an environment variable into a crash with no closed outcome.
 */
export function validateReconciliationPolicy(input: {
  readonly reconciliationWindowMs: number;
  readonly staleSubmittingAfterMs: number;
}): ReconciliationPolicyResult {
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
  // A stale threshold beyond the window would declare an attempt lost after the
  // deadline it is supposed to be given — uncertainty that expires before it
  // begins.
  if (staleSubmittingAfterMs > reconciliationWindowMs) {
    return { ok: false, reason: "STALE_THRESHOLD_EXCEEDS_WINDOW" };
  }
  return { ok: true, policy: { reconciliationWindowMs, staleSubmittingAfterMs } };
}

/** The default policy, already validated. */
export function defaultReconciliationPolicy(): ReconciliationPolicy {
  return {
    reconciliationWindowMs: DEFAULT_RECONCILIATION_WINDOW_MS,
    staleSubmittingAfterMs: DEFAULT_STALE_SUBMITTING_AFTER_MS,
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
