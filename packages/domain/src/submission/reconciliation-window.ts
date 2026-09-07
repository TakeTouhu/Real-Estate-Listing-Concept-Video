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
 * useless on its own — nothing in this phase consumes it, and it exists only to
 * name the shape a caller hands to the validator.
 */
export interface ReconciliationPolicyConfig {
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
  | "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE";

/**
 * A policy that has been checked, and whose authority cannot be copied.
 *
 * Two earlier attempts at this boundary each failed one step short, and the
 * second failure is the one worth recording.
 *
 * The first consumed a plain structural type, so an unchecked object literal
 * with the right two fields reached the service without ever meeting the
 * validator.
 *
 * The second added a phantom `unique symbol` brand. That stopped a *literal*
 * from claiming to be a policy — but a phantom brand is only a type-level
 * property, and TypeScript's spread type copies it along with everything else:
 *
 * ```ts
 * const corrupted = { ...policy, reconciliationWindowMs: 86_400_001 };
 * const accepted: ReconciliationPolicy = corrupted;   // compiled, no cast
 * ```
 *
 * So the brand proved only that *some* value had once passed the validator, not
 * that the numbers being consumed were still the validated ones. A ceiling that
 * a spread can raise is not a ceiling.
 *
 * This is a class with ECMAScript private state instead, because that makes the
 * invalid state hard to *represent* rather than repeatedly detected:
 *
 * - `#validated` is a real private field, not a phantom property. It is not an
 *   own enumerable property, so `{ ...policy }` does not copy it — at runtime it
 *   copies nothing at all, since the accessors live on the prototype — and
 *   TypeScript's spread type omits it too. A reconstructed object is therefore
 *   not a `ReconciliationPolicy`, and no cast was needed to find that out.
 * - the constructor is `private`, so the only construction site is
 *   `validateReconciliationPolicy` below.
 * - the numbers are readable and unwritable, through getters over private
 *   fields, so consumers read validated values and nobody can assign new ones.
 *
 * The invariant, stated plainly: **copying the policy's public values does not
 * copy its validation authority.**
 */
export class ReconciliationPolicy {
  /**
   * The nominal identity. Its type is irrelevant; its privacy is the point.
   *
   * A `#` field is part of the class's identity to TypeScript and absent from
   * every structural copy, which is exactly the property the phantom brand
   * lacked.
   */
  readonly #validated: true;

  readonly #reconciliationWindowMs: number;
  readonly #staleSubmittingAfterMs: number;

  private constructor(reconciliationWindowMs: number, staleSubmittingAfterMs: number) {
    this.#validated = true;
    this.#reconciliationWindowMs = reconciliationWindowMs;
    this.#staleSubmittingAfterMs = staleSubmittingAfterMs;
  }

  get reconciliationWindowMs(): number {
    return this.#reconciliationWindowMs;
  }

  get staleSubmittingAfterMs(): number {
    return this.#staleSubmittingAfterMs;
  }

  /**
   * The runtime nominal check, asked of the private field itself.
   *
   * `#validated in value` is the ergonomic-brand idiom: it is true only for
   * objects this class constructed, cannot be faked by any structural copy, and
   * — unlike `instanceof` — does not quietly fail when two realms each load
   * their own copy of the module.
   */
  static isPolicy(value: unknown): value is ReconciliationPolicy {
    return typeof value === "object" && value !== null && #validated in value;
  }

  /**
   * Validate a configured policy, returning a result rather than throwing.
   *
   * The only construction site in the codebase. It is a static member rather
   * than a free function so that the constructor can stay `private`;
   * `validateReconciliationPolicy` below is the name callers use, and it
   * delegates here.
   *
   * Configuration arrives from outside the process and a bad value is an
   * operator mistake, not a programming defect — so it is answerable, and the
   * caller decides whether to refuse startup or fall back. Throwing here would
   * turn a typo in an environment variable into a crash with no closed outcome.
   */
  static validate(input: ReconciliationPolicyConfig): ReconciliationPolicyResult {
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
    // enters is already expired — a window that exists only as an instant.
    // Beyond equality is worse still. Both are the same defect, both refused.
    if (staleSubmittingAfterMs >= reconciliationWindowMs) {
      return { ok: false, reason: "STALE_THRESHOLD_NOT_BEFORE_RECONCILIATION_DEADLINE" };
    }
    // Values are passed through unchanged. Nothing is clamped and nothing is
    // defaulted: silently repairing an operator's number would hide the mistake
    // rather than report it, and would make the persisted deadline disagree
    // with the configuration somebody believes is in force.
    return {
      ok: true,
      policy: new ReconciliationPolicy(reconciliationWindowMs, staleSubmittingAfterMs),
    };
  }
}

/**
 * The canonical validator, and the only way to obtain a `ReconciliationPolicy`.
 *
 * A thin delegation so callers keep one obvious entry point while construction
 * stays sealed inside the class.
 */
export function validateReconciliationPolicy(
  input: ReconciliationPolicyConfig,
): ReconciliationPolicyResult {
  return ReconciliationPolicy.validate(input);
}

/**
 * A runtime nominal check, for the one thing types cannot stop.
 *
 * An explicit `as unknown as ReconciliationPolicy` defeats any compile-time
 * boundary, so the service construction boundary asks at runtime as well. This
 * is defence in depth and **not** the validation itself: it proves the value was
 * built by the class, and the class only builds values that passed `validate`.
 * Identity plus provenance, rather than re-deriving the numbers — which would
 * be a second validator to drift from the first.
 */
export function isReconciliationPolicy(value: unknown): value is ReconciliationPolicy {
  return ReconciliationPolicy.isPolicy(value);
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
