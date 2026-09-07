import type { SafetyGuardDecision } from "../pricing/safety-guard";
import type { RoutingAuthorizationFailure } from "./routing";

/**
 * Why a reservation cannot authorize a new paid attempt.
 *
 * Each value names a distinct commercial situation, because "invalid" is not
 * something an operator can act on. A missing hold and a consumed one are
 * different bugs.
 */
export type ReservationAuthorizationFailure =
  | "RESERVATION_MISSING"
  | "RESERVATION_NOT_HELD"
  | "RESERVATION_CONSUMED"
  | "RESERVATION_RELEASED"
  | "RESERVATION_ON_RECONCILIATION_HOLD"
  | "RESERVATION_JOB_MISMATCH"
  | "RESERVATION_UNDER_RESERVED"
  | "RESERVATION_HIGH_QUALITY_MISMATCH";

/**
 * Why the persisted pricing cannot authorize a paid submission.
 *
 * `PRICING_CONTRACT_*` mirror the Phase 4C-3B-2D eligibility vocabulary rather
 * than re-deriving it; `SNAPSHOT_*` are this gate's re-checks of the binding
 * that admission already enforced.
 */
export type PricingAuthorizationFailure =
  | "PRICING_CONTRACT_MISSING"
  | "PRICING_CONTRACT_UNVERIFIED"
  | "PRICING_CONTRACT_EXPIRED"
  | "PRICING_CONTRACT_PROMOTIONAL_ONLY"
  | "PRICING_CONTRACT_NOT_YET_EFFECTIVE"
  /**
   * The pricing domain refused for a reason this gate has no mapping for.
   *
   * The fail-closed arm. A new `PricingErrorReason` must never arrive here as
   * silence, and mapping it to a specific existing reason would be a guess
   * printed as a fact.
   */
  | "PRICING_CONTRACT_NOT_ELIGIBLE"
  | "PRICING_SNAPSHOT_MISSING"
  | "PRICING_SNAPSHOT_NOT_FOR_ATTEMPT"
  | "PRICING_SNAPSHOT_BINDING_INVALID"
  | "PRICING_FX_SNAPSHOT_MISSING"
  | "PRICING_FX_SNAPSHOT_INVALID";

/** Why the worst case this attempt commits to is not sellable. */
export type ProfitabilityAuthorizationFailure = "NEGATIVE_WORST_CASE_UNIT_ECONOMICS";

/** Why the abnormal-cost guard refuses. */
export type SafetyGuardAuthorizationFailure =
  | "HARD_PAUSE_PROJECTED_PROFIT_BELOW_FLOOR"
  | "BILLING_CYCLE_REVENUE_UNAVAILABLE";

export type { RoutingAuthorizationFailure };

/**
 * The result of asking whether one persisted attempt may cross into
 * `SUBMITTING`.
 *
 * Closed and provider-neutral. No arm carries a database error, a provider
 * message, or a free-form string: a caller that can only `switch` on a known
 * set cannot accidentally treat an unrecognized refusal as permission, and a
 * refusal reason that leaked a raw error would put provider or tenant detail
 * into whatever logs it.
 *
 * `AUTHORIZED` deliberately carries no token. What it reports is the state the
 * database already committed — the attempt is `SUBMITTING` at this version —
 * because a reusable capability object handed to a caller is a second source of
 * truth, and the one that can authorize a POST twice.
 */
export type PaidSubmissionAuthorizationOutcome =
  | {
      readonly kind: "AUTHORIZED";
      readonly attemptId: string;
      readonly armedStateVersion: number;
      /**
       * Present when the guard was in `WARNING`. Authorization continued —
       * warning is not a block — and this is how that fact reaches an operator
       * instead of being swallowed.
       */
      readonly safetyGuardWarning: SafetyGuardDecision | null;
    }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | {
      readonly kind: "ATTEMPT_NOT_ARMABLE";
      readonly reason: AttemptArmabilityFailure;
    }
  | {
      readonly kind: "RESERVATION_INVALID";
      readonly reason: ReservationAuthorizationFailure;
    }
  | {
      readonly kind: "PRICING_INELIGIBLE";
      readonly reason: PricingAuthorizationFailure;
    }
  | {
      readonly kind: "PROFITABILITY_REJECTED";
      readonly reason: ProfitabilityAuthorizationFailure;
    }
  | {
      readonly kind: "SAFETY_GUARD_HARD_PAUSE";
      readonly reason: SafetyGuardAuthorizationFailure;
      readonly decision: SafetyGuardDecision;
    }
  | {
      readonly kind: "ROUTING_NOT_AUTHORIZED";
      readonly reason: RoutingAuthorizationFailure;
    }
  | { readonly kind: "LOST_CONCURRENCY" };

/** Why an attempt is not in a shape that could cross the boundary. */
export type AttemptArmabilityFailure =
  | "ATTEMPT_STATE_NOT_QUEUED"
  | "ATTEMPT_ALREADY_SUBMITTED"
  | "ATTEMPT_SUBMISSION_UNCERTAIN"
  | "ATTEMPT_CERTAINTY_NOT_PRE_SUBMISSION"
  | "ATTEMPT_FACTS_INCOMPLETE";
