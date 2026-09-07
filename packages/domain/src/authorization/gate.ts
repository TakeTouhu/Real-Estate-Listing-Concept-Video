import { deepFreeze } from "@app/shared";
import type { PricingErrorReason } from "../pricing/errors";
import { evaluatePaidSubmissionPricingEligibility } from "../pricing/pricing-eligibility";
import {
  evaluateUnitEconomics,
  worstCaseSceneProviderCostYen,
} from "../pricing/profitability";
import { evaluateSafetyGuard, type SafetyGuardDecision } from "../pricing/safety-guard";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { yen, type EpochMillis, type Yen } from "../pricing/units";
import type {
  GenerationAttemptState,
  GenerationQualityTier,
  GenerationReservationState,
  SubmissionCertainty,
} from "../orchestration/types";
import { authorizeRoute, type RouteAuthorizationFacts } from "./routing";
import {
  totalProviderCostExposureYen,
  type ProviderCostExposure,
} from "./exposure";
import type {
  AttemptArmabilityFailure,
  PaidSubmissionAuthorizationOutcome,
  PricingAuthorizationFailure,
  ReservationAuthorizationFailure,
} from "./types";

/**
 * The paid submission gate, as one pure decision.
 *
 * Everything here is a function of validated facts. It holds no database
 * handle, no provider client and no clock — which is what makes it possible to
 * test the rule that decides whether money may be spent without spending any,
 * and to mutate every branch of it deterministically.
 *
 * The evaluator answers *may this proceed*. It does not arm anything: the
 * authorization service runs this, and only if it permits does it call the
 * compare-and-set that actually moves the attempt. Splitting them means a
 * policy bug cannot half-authorize, and a lost CAS cannot be mistaken for a
 * policy pass.
 */

/** What the attempt itself must look like. */
export interface AttemptGateFacts {
  readonly attemptId: string;
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly stateVersion: number;
  readonly generationJobId: string;
  readonly qualityTier: GenerationQualityTier;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string | null;
  readonly requestNativeGenerationResolution: string | null;
  readonly requestTargetOutputResolution: string | null;
  readonly requestDurationSeconds: number | null;
  readonly pricingContractKey: string | null;
}

/** The hold that must stand behind the paid call. */
export interface ReservationGateFacts {
  readonly generationJobId: string;
  readonly state: GenerationReservationState;
  readonly reservedTotalVideoUnits: number;
  readonly reservedHighQualityUnits: number;
}

/** The job's immutable entitlement arithmetic, for reservation coherence. */
export interface JobGateFacts {
  readonly id: string;
  readonly qualityTier: GenerationQualityTier;
  readonly requiredVideoUnits: number;
  readonly requiredHighQualityUnits: number;
}

/** The persisted cost decision, already converted to yen by the loader. */
export interface PricingGateFacts {
  readonly snapshotBoundToAttempt: boolean;
  readonly bindingValid: boolean;
  readonly contract: ProviderPricingContract | null;
  readonly identityGenerationMode: string;
  readonly identityAudioMode: string;
  /** `null` when a required FX snapshot was absent or failed validation. */
  readonly plannedCostYen: Yen | null;
  readonly fxFailure: "MISSING" | "INVALID" | null;
}

/**
 * The commercial context a Safety Guard decision needs.
 *
 * `billingCycleRevenueYen` is `null` when no authoritative revenue figure
 * exists for this organization and cycle. That is a refusal, not a zero: a zero
 * revenue would make every threshold the absolute floor and quietly authorize
 * against a number nobody published.
 */
export interface CommercialGateFacts {
  readonly billingCycleRevenueYen: Yen | null;
  readonly exposure: ProviderCostExposure;
  /** Revenue attributable to the scene this attempt renders. */
  readonly sceneRevenueYen: Yen;
}

export interface PaidSubmissionGateFacts {
  readonly authorizationInstant: EpochMillis;
  readonly attempt: AttemptGateFacts;
  readonly job: JobGateFacts;
  readonly reservation: ReservationGateFacts | null;
  readonly pricing: PricingGateFacts;
  readonly commercial: CommercialGateFacts;
}

/** Permission to arm, plus what the caller must carry into the CAS. */
export type PaidSubmissionGateDecision =
  | {
      readonly kind: "PERMITTED";
      readonly attemptId: string;
      readonly expectedStateVersion: number;
      readonly safetyGuardWarning: SafetyGuardDecision | null;
    }
  | {
      readonly kind: "REFUSED";
      readonly outcome: Exclude<
        PaidSubmissionAuthorizationOutcome,
        { kind: "AUTHORIZED" } | { kind: "LOST_CONCURRENCY" }
      >;
    };

/**
 * States from which no authorization is possible, with the reason each is
 * refused for.
 *
 * Written as an exhaustive mapping rather than a negated allowlist so adding a
 * state to `GenerationAttemptState` fails to compile here instead of silently
 * inheriting whichever default the last branch happened to be.
 */
const NON_ARMABLE_STATE_REASON: Record<
  Exclude<GenerationAttemptState, "QUEUED">,
  AttemptArmabilityFailure
> = deepFreeze({
  SUBMITTING: "ATTEMPT_ALREADY_SUBMITTED",
  PROCESSING: "ATTEMPT_ALREADY_SUBMITTED",
  PROVIDER_SUCCEEDED: "ATTEMPT_ALREADY_SUBMITTED",
  OUTPUT_INGESTING: "ATTEMPT_ALREADY_SUBMITTED",
  OUTPUT_VERIFIED: "ATTEMPT_ALREADY_SUBMITTED",
  // Uncertainty is named separately: it is the one state where trying again is
  // most tempting and most expensive.
  RECONCILIATION_PENDING: "ATTEMPT_SUBMISSION_UNCERTAIN",
  RECONCILIATION_EXHAUSTED: "ATTEMPT_SUBMISSION_UNCERTAIN",
  FAILED_RETRYABLE: "ATTEMPT_STATE_NOT_QUEUED",
  FAILED_TERMINAL: "ATTEMPT_STATE_NOT_QUEUED",
  CANCELLED_PRE_SUBMISSION: "ATTEMPT_STATE_NOT_QUEUED",
} as const);

/** Certainties from which no authorization is possible. */
const NON_ARMABLE_CERTAINTY_REASON: Record<
  Exclude<SubmissionCertainty, "PRE_SUBMISSION">,
  AttemptArmabilityFailure
> = deepFreeze({
  ACCEPTED: "ATTEMPT_ALREADY_SUBMITTED",
  DEFINITIVELY_REJECTED: "ATTEMPT_CERTAINTY_NOT_PRE_SUBMISSION",
  // The invariant this gate exists to protect. An attempt whose fate is unknown
  // may never become a second POST: the provider may already have been paid,
  // and no local state can establish that it was not.
  SUBMISSION_UNKNOWN: "ATTEMPT_SUBMISSION_UNCERTAIN",
} as const);

function refuse(
  outcome: Extract<PaidSubmissionGateDecision, { kind: "REFUSED" }>["outcome"],
): PaidSubmissionGateDecision {
  return { kind: "REFUSED", outcome };
}

/** Reservation states that cannot stand behind a new paid attempt. */
const NON_AUTHORIZING_RESERVATION_REASON: Record<
  Exclude<GenerationReservationState, "RESERVED">,
  ReservationAuthorizationFailure
> = deepFreeze({
  // Still being created: the hold is not established yet.
  RESERVING: "RESERVATION_NOT_HELD",
  // The customer's units are already spent on delivered work.
  CONSUMED: "RESERVATION_CONSUMED",
  // Given back. Nothing is held to pay for this.
  RELEASED: "RESERVATION_RELEASED",
  // An unresolved uncertainty is exactly why the hold exists. Authorizing an
  // unrelated new POST while it stands would spend against a reservation the
  // platform has already flagged as possibly owed elsewhere.
  RECONCILIATION_HOLD: "RESERVATION_ON_RECONCILIATION_HOLD",
} as const);

/**
 * Which pricing-eligibility reason maps to which gate reason.
 *
 * Partial on purpose. `PricingErrorReason` is a wider vocabulary than
 * eligibility can currently produce, and a reason with no entry falls through
 * to `PRICING_CONTRACT_NOT_ELIGIBLE` rather than to permission.
 */
const PRICING_ELIGIBILITY_REASON: Partial<
  Record<PricingErrorReason, PricingAuthorizationFailure>
> = deepFreeze({
  PRICING_CONTRACT_MISSING: "PRICING_CONTRACT_MISSING",
  PRICING_CONTRACT_UNVERIFIED: "PRICING_CONTRACT_UNVERIFIED",
  PRICING_CONTRACT_EXPIRED: "PRICING_CONTRACT_EXPIRED",
  PRICING_CONTRACT_PROMOTIONAL_ONLY: "PRICING_CONTRACT_PROMOTIONAL_ONLY",
  PRICING_CONTRACT_NOT_YET_EFFECTIVE: "PRICING_CONTRACT_NOT_YET_EFFECTIVE",
} as const);

export function evaluatePaidSubmissionGate(
  facts: PaidSubmissionGateFacts,
): PaidSubmissionGateDecision {
  const { attempt, job, reservation, pricing, commercial } = facts;

  // ---- 1. The attempt must be in the one shape that can cross ------------
  if (attempt.orchestrationState !== "QUEUED") {
    return refuse({
      kind: "ATTEMPT_NOT_ARMABLE",
      reason: NON_ARMABLE_STATE_REASON[attempt.orchestrationState],
    });
  }
  if (attempt.submissionCertainty !== "PRE_SUBMISSION") {
    return refuse({
      kind: "ATTEMPT_NOT_ARMABLE",
      reason: NON_ARMABLE_CERTAINTY_REASON[attempt.submissionCertainty],
    });
  }
  // A V1 or half-populated row cannot be routed or priced. Fail closed rather
  // than defaulting any of these to a plausible value.
  if (
    attempt.requestModelKey === null ||
    attempt.requestNativeGenerationResolution === null ||
    attempt.requestTargetOutputResolution === null ||
    attempt.requestDurationSeconds === null ||
    attempt.pricingContractKey === null
  ) {
    return refuse({ kind: "ATTEMPT_NOT_ARMABLE", reason: "ATTEMPT_FACTS_INCOMPLETE" });
  }

  // ---- 2. A valid hold must stand behind the call -------------------------
  if (reservation === null) {
    return refuse({ kind: "RESERVATION_INVALID", reason: "RESERVATION_MISSING" });
  }
  if (reservation.generationJobId !== job.id || attempt.generationJobId !== job.id) {
    // A hold belonging to another job cannot pay for this one, however valid it
    // looks on its own.
    return refuse({ kind: "RESERVATION_INVALID", reason: "RESERVATION_JOB_MISMATCH" });
  }
  if (reservation.state !== "RESERVED") {
    return refuse({
      kind: "RESERVATION_INVALID",
      reason: NON_AUTHORIZING_RESERVATION_REASON[reservation.state],
    });
  }
  if (reservation.reservedTotalVideoUnits !== job.requiredVideoUnits) {
    return refuse({ kind: "RESERVATION_INVALID", reason: "RESERVATION_UNDER_RESERVED" });
  }
  // High quality is a property of units already reserved, never an addition, so
  // the job's figure is the exact expectation in both directions.
  if (reservation.reservedHighQualityUnits !== job.requiredHighQualityUnits) {
    return refuse({
      kind: "RESERVATION_INVALID",
      reason: "RESERVATION_HIGH_QUALITY_MISMATCH",
    });
  }

  // ---- 3. The cost decision must be eligible and bound to this attempt ----
  if (!pricing.snapshotBoundToAttempt) {
    return refuse({
      kind: "PRICING_INELIGIBLE",
      reason: "PRICING_SNAPSHOT_NOT_FOR_ATTEMPT",
    });
  }
  // Defence in depth: admission and `armProviderBoundary` both enforce this,
  // and persisted corruption between them must not authorize a paid call.
  if (!pricing.bindingValid) {
    return refuse({
      kind: "PRICING_INELIGIBLE",
      reason: "PRICING_SNAPSHOT_BINDING_INVALID",
    });
  }
  const eligibility = evaluatePaidSubmissionPricingEligibility(
    pricing.contract,
    facts.authorizationInstant,
  );
  if (!eligibility.ok) {
    // An unmapped pricing reason is a new failure mode; it must not read as
    // "fine", and must not be relabelled as one of the reasons it is not.
    const reason =
      PRICING_ELIGIBILITY_REASON[eligibility.error.reason] ?? "PRICING_CONTRACT_NOT_ELIGIBLE";
    return refuse({ kind: "PRICING_INELIGIBLE", reason });
  }
  if (pricing.fxFailure !== null) {
    return refuse({
      kind: "PRICING_INELIGIBLE",
      reason:
        pricing.fxFailure === "MISSING"
          ? "PRICING_FX_SNAPSHOT_MISSING"
          : "PRICING_FX_SNAPSHOT_INVALID",
    });
  }
  if (pricing.plannedCostYen === null) {
    return refuse({ kind: "PRICING_INELIGIBLE", reason: "PRICING_SNAPSHOT_MISSING" });
  }

  // ---- 4. The route must be one the product sells ------------------------
  const routeFacts: RouteAuthorizationFacts = {
    qualityTier: job.qualityTier,
    providerName: attempt.providerName,
    providerModelId: attempt.providerModelId,
    requestModelKey: attempt.requestModelKey,
    nativeGenerationResolution: attempt.requestNativeGenerationResolution,
    // Validated by the loader against the closed product vocabulary.
    targetOutputResolution: attempt.requestTargetOutputResolution as "720p" | "1080p",
    generationMode: pricing.identityGenerationMode,
    audioMode: pricing.identityAudioMode,
  };
  const route = authorizeRoute(routeFacts);
  if (!route.ok) {
    return refuse({ kind: "ROUTING_NOT_AUTHORIZED", reason: route.reason });
  }

  // ---- 5. NO_NEGATIVE_UNIT_ECONOMICS -------------------------------------
  //
  // The worst case this scene is contractually obliged to honour: the initial
  // paid attempt plus the two user regenerations the entitlement sells. That
  // is a count of *paid provider attempts*, derived from the frozen policy —
  // not a stored counter, and not the number of attempt rows that happen to
  // exist, which would let a provider outage make a scene look unsellable.
  const worstCaseProviderCost = worstCaseSceneProviderCostYen(pricing.plannedCostYen);
  const economics = evaluateUnitEconomics({
    totalRevenueYen: commercial.sceneRevenueYen,
    providerCostEstimateYen: worstCaseProviderCost,
    unknownCostExposureYen: yen(0),
    reservedProviderCostYen: yen(0),
    paymentProcessingCostYen: yen(0),
    customerVariableInfrastructureCostYen: yen(0),
    supportReserveYen: yen(0),
    salesCacAllocationYen: yen(0),
    otherDirectCostReserveYen: yen(0),
  });
  // Only *negative* blocks. A margin below the internal target is a pricing
  // review, never a refusal to render work a customer already bought — the
  // 75% target and 70% floor in `PROFITABILITY_TARGETS` are read by nothing
  // here, deliberately.
  if (economics.isNegativeUnitEconomics) {
    return refuse({
      kind: "PROFITABILITY_REJECTED",
      reason: "NEGATIVE_WORST_CASE_UNIT_ECONOMICS",
    });
  }

  // ---- 6. The abnormal-cost Safety Guard ---------------------------------
  if (commercial.billingCycleRevenueYen === null) {
    return refuse({
      kind: "SAFETY_GUARD_HARD_PAUSE",
      reason: "BILLING_CYCLE_REVENUE_UNAVAILABLE",
      decision: evaluateSafetyGuard(yen(0), yen(0)),
    });
  }
  // Projected contribution profit for the cycle: revenue less every provider
  // cost already exposed, *including* the one this authorization would add.
  // Excluding the candidate is how two concurrent authorizations each look
  // affordable and jointly are not.
  const projectedProfit = yen(
    commercial.billingCycleRevenueYen - totalProviderCostExposureYen(commercial.exposure),
  );
  const guard = evaluateSafetyGuard(commercial.billingCycleRevenueYen, projectedProfit);
  if (guard.state === "HARD_PAUSE") {
    return refuse({
      kind: "SAFETY_GUARD_HARD_PAUSE",
      reason: "HARD_PAUSE_PROJECTED_PROFIT_BELOW_FLOOR",
      decision: guard,
    });
  }

  // WARNING continues. Normal contractual usage is not restricted because the
  // month is thin; the decision is carried out so it can be recorded.
  return {
    kind: "PERMITTED",
    attemptId: attempt.attemptId,
    expectedStateVersion: attempt.stateVersion,
    safetyGuardWarning: guard.state === "WARNING" ? guard : null,
  };
}
