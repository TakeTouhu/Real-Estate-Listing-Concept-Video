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
  /**
   * The customer's units are already spent, and this request is not entitled to
   * spend nothing.
   *
   * Only an `INITIAL` request is refused for this. A post-delivery
   * `USER_REGENERATION` runs against a `CONSUMED` reservation *by design* — the
   * regeneration right was sold with the original video and consumes no further
   * customer unit — so refusing it here would deny a customer work they have
   * already paid for.
   */
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
  /**
   * A contract with this exact seven-dimensional identity exists, and it is not
   * the contract this snapshot was priced against. Price, verification,
   * duration policy, promotion or effective window has changed underneath a
   * stable identity — the case `contractFingerprint` exists to catch.
   */
  | "PRICING_CONTRACT_FINGERPRINT_MISMATCH"
  /**
   * The persisted row cannot be reproduced by re-running the pricing
   * calculation over its own frozen inputs. Some immutable commercial fact —
   * most consequentially a stored cost amount — no longer matches what the
   * contract it names would produce.
   */
  | "PRICING_SNAPSHOT_NOT_REPRODUCIBLE"
  /**
   * A persisted `BIGINT` money column is outside the range that can be
   * represented exactly. Refused as a corrupt financial fact rather than
   * narrowed into a wrong number or thrown as an arithmetic defect.
   */
  | "PRICING_AMOUNT_UNREPRESENTABLE"
  | "PRICING_FX_SNAPSHOT_MISSING"
  | "PRICING_FX_SNAPSHOT_INVALID";

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
 *
 * There is deliberately **no** `PROFITABILITY_REJECTED` arm. `NO_NEGATIVE_UNIT_
 * ECONOMICS` is a sellability decision — it belongs to route commercial
 * certification and plan configuration, before a customer is ever offered the
 * work — and not a runtime lever for refusing a rendition somebody has already
 * bought. Turning a per-scene margin calculation into a customer-facing refusal
 * would restrict normal contractual usage on internal cost pressure, which the
 * frozen business principle forbids.
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
  | "ATTEMPT_FACTS_INCOMPLETE"
  /**
   * The parent request's kind and regeneration ordinal contradict each other:
   * an `INITIAL` request carrying an ordinal, or a `USER_REGENERATION` carrying
   * none. The reservation rule below branches on that kind, so an incoherent
   * pair must refuse before it can select the more permissive branch.
   */
  | "REQUEST_REGENERATION_ORDINAL_INVALID";
