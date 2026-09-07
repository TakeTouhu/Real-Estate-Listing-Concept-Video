import { deepFreeze } from "@app/shared";
import type { PricingErrorReason } from "../pricing/errors";
import { evaluatePaidSubmissionPricingEligibility } from "../pricing/pricing-eligibility";
import { evaluateSafetyGuard, type SafetyGuardDecision } from "../pricing/safety-guard";
import type { ProviderPricingContract } from "../pricing/provider-pricing-contract";
import { yen, type EpochMillis, type Yen } from "../pricing/units";
import type {
  GenerationAttemptState,
  GenerationQualityTier,
  GenerationReservationState,
  SceneGenerationRequestKind,
  SubmissionCertainty,
} from "../orchestration/types";
import { authorizeRoute, type RouteAuthorizationFacts } from "./routing";
import { totalProviderCostExposureYen, type ProviderCostExposure } from "./exposure";
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
 *
 * **What this gate deliberately does not decide.** Whether a route is
 * profitable to sell is not asked here. `NO_NEGATIVE_UNIT_ECONOMICS` is a
 * configuration-admission rule — it belongs to commercial certification of a
 * route and to plan configuration, before anything is offered to a customer —
 * and running it at submission time would convert a margin that moved after the
 * sale into a refusal to render work the customer already bought. The frozen
 * principle is that normal contractual usage is not restricted by short-term
 * internal cost pressure, and the Safety Guard is the only cost lever that
 * survives it, because it fires on abnormal cost rather than on thin margin.
 */

/**
 * The version of the policy this module implements.
 *
 * Persisted with every authorization event, so a decision found in the
 * transition history can be read against the rules that were in force when it
 * was made rather than against whatever the code says today.
 */
export const AUTHORIZATION_POLICY_VERSION = "2026-09-07.1";

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
  /**
   * The parent request's kind, read from persistence and never supplied by a
   * caller. It decides which reservation states may stand behind this attempt,
   * so a caller able to assert it could claim a regeneration and spend against
   * a reservation that is already consumed.
   */
  readonly requestKind: SceneGenerationRequestKind;
  /** `null` for `INITIAL`; 1 or 2 for `USER_REGENERATION`. */
  readonly requestUserRegenerationOrdinal: number | null;
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

/** The persisted cost decision, already verified and converted by the loader. */
export interface PricingGateFacts {
  readonly snapshotBoundToAttempt: boolean;
  readonly bindingValid: boolean;
  readonly contract: ProviderPricingContract | null;
  readonly identityGenerationMode: string;
  readonly identityAudioMode: string;
  /**
   * Why the persisted snapshot failed re-derivation, or `null` when it
   * reproduced exactly. See `verifyPersistedPricingSnapshot`.
   */
  readonly integrityFailure: PricingAuthorizationFailure | null;
  /** The re-derived planning cost in yen, never the stored amount as-is. */
  readonly plannedCostYen: Yen | null;
  readonly fxFailure: "MISSING" | "INVALID" | null;
  /** Opaque identifier of the snapshot row, for the audit record. */
  readonly pricingSnapshotId: string | null;
}

/**
 * The commercial context a Safety Guard decision needs.
 *
 * `billingCycleRevenueYen` is `null` when no authoritative revenue figure
 * exists for this organization and cycle. That is a refusal, not a zero: a zero
 * revenue would make every threshold the absolute floor and quietly authorize
 * against a number nobody published.
 *
 * There is no per-scene revenue here. The only question this gate asks of money
 * is the abnormal-cost one.
 */
export interface CommercialGateFacts {
  readonly billingCycleRevenueYen: Yen | null;
  readonly exposure: ProviderCostExposure;
  /**
   * Whether every cost-bearing attempt already contributing to this cycle
   * reproduced from its own persisted snapshot.
   *
   * `false` means the exposure total below is known to be wrong by an unknown
   * amount, which makes the guard's comparison meaningless. It is a refusal,
   * not a smaller number.
   */
  readonly exposureVerified: boolean;
}

export interface PaidSubmissionGateFacts {
  /** Read from the authorization clock, after the cost lock — never a caller's. */
  readonly authorizationInstant: EpochMillis;
  readonly attempt: AttemptGateFacts;
  readonly job: JobGateFacts;
  readonly reservation: ReservationGateFacts | null;
  readonly pricing: PricingGateFacts;
  readonly commercial: CommercialGateFacts;
}

/**
 * The financial facts one authorization was decided on, for the durable record.
 *
 * Carried out of the gate so the service can write them into the transition
 * event *before* the compare-and-set commits. A guard state that lives only in
 * the returned object is lost the moment the process handling the call dies,
 * and the one question an incident asks of a paid boundary is "under what
 * conditions did we let this through" — which persistence has to be able to
 * answer alone.
 */
export interface PaidSubmissionAuthorizationAudit {
  readonly authorizationPolicyVersion: string;
  readonly safetyGuard: SafetyGuardDecision;
  readonly billingCycleRevenueYen: Yen;
  readonly exposure: ProviderCostExposure;
  readonly pricingSnapshotId: string | null;
}

/** Permission to arm, plus what the caller must carry into the CAS. */
export type PaidSubmissionGateDecision =
  | {
      readonly kind: "PERMITTED";
      readonly attemptId: string;
      readonly expectedStateVersion: number;
      readonly audit: PaidSubmissionAuthorizationAudit;
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

/**
 * What each reservation state permits, before the request's kind is considered.
 *
 * `CONSUMED` is the interesting one, and getting it wrong in either direction is
 * expensive. Refusing it universally denies a customer the post-delivery
 * regeneration they bought with the original video — the reservation is
 * *supposed* to be consumed by then, because the unit was spent on the delivery
 * that the regeneration revises. Accepting it universally would let a fresh
 * `INITIAL` request render against units that are already gone.
 *
 * So the state alone does not decide; it names which requests may stand on it.
 */
type ReservationAdmissibility =
  | { readonly kind: "ANY_REQUEST" }
  | { readonly kind: "REGENERATION_ONLY"; readonly otherwise: ReservationAuthorizationFailure }
  | { readonly kind: "REFUSED"; readonly reason: ReservationAuthorizationFailure };

const RESERVATION_ADMISSIBILITY: Record<
  GenerationReservationState,
  ReservationAdmissibility
> = deepFreeze({
  RESERVED: { kind: "ANY_REQUEST" },
  // Spent on the delivered video. A regeneration of that same video consumes no
  // further customer unit — its provider cost is internal — so this is the
  // expected state for post-delivery regeneration, and only for it.
  CONSUMED: { kind: "REGENERATION_ONLY", otherwise: "RESERVATION_CONSUMED" },
  // Still being created: the hold is not established yet.
  RESERVING: { kind: "REFUSED", reason: "RESERVATION_NOT_HELD" },
  // Given back. Nothing stands behind this job at all any more, and a
  // regeneration right cannot outlive the entitlement it was sold with.
  RELEASED: { kind: "REFUSED", reason: "RESERVATION_RELEASED" },
  // An unresolved uncertainty is exactly why the hold exists. Authorizing a new
  // POST while it stands would spend against a reservation the platform has
  // already flagged as possibly owed elsewhere.
  RECONCILIATION_HOLD: { kind: "REFUSED", reason: "RESERVATION_ON_RECONCILIATION_HOLD" },
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
  // The kind decides which reservation states are acceptable below, so an
  // incoherent kind/ordinal pair must not be allowed to select the permissive
  // branch. The database CHECK enforces the same pairing; this refuses rather
  // than assumes it held.
  const ordinalCoherent =
    attempt.requestKind === "USER_REGENERATION"
      ? attempt.requestUserRegenerationOrdinal !== null
      : attempt.requestUserRegenerationOrdinal === null;
  if (!ordinalCoherent) {
    return refuse({
      kind: "ATTEMPT_NOT_ARMABLE",
      reason: "REQUEST_REGENERATION_ORDINAL_INVALID",
    });
  }

  // ---- 2. A valid hold must stand behind the call -------------------------
  if (reservation === null) {
    return refuse({ kind: "RESERVATION_INVALID", reason: "RESERVATION_MISSING" });
  }
  if (reservation.generationJobId !== job.id || attempt.generationJobId !== job.id) {
    // A hold belonging to another job cannot pay for this one, however valid it
    // looks on its own. This is what keeps a post-delivery regeneration on its
    // *own* consumed reservation rather than on any consumed reservation.
    return refuse({ kind: "RESERVATION_INVALID", reason: "RESERVATION_JOB_MISMATCH" });
  }
  const admissibility = RESERVATION_ADMISSIBILITY[reservation.state];
  if (admissibility.kind === "REFUSED") {
    return refuse({ kind: "RESERVATION_INVALID", reason: admissibility.reason });
  }
  if (
    admissibility.kind === "REGENERATION_ONLY" &&
    attempt.requestKind !== "USER_REGENERATION"
  ) {
    return refuse({ kind: "RESERVATION_INVALID", reason: admissibility.otherwise });
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
  // The whole persisted snapshot re-derived from its own frozen inputs. A
  // tampered amount is caught here and nowhere earlier: every binding field can
  // be perfectly consistent while the cost is a fabrication.
  if (pricing.integrityFailure !== null) {
    return refuse({ kind: "PRICING_INELIGIBLE", reason: pricing.integrityFailure });
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

  // ---- 5. The abnormal-cost Safety Guard ---------------------------------
  //
  // Every term of the exposure sum must have reproduced, not just the
  // candidate's. Verifying one price and trusting the rest leaves the equation
  // as forgeable as it was: understate one in-flight sibling and the guard sees
  // headroom that does not exist.
  if (!commercial.exposureVerified) {
    return refuse({
      kind: "PRICING_INELIGIBLE",
      reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
    });
  }
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
  // month is thin; the decision is carried out so it can be *recorded* — and
  // the audit block below is what makes recording it possible from persistence
  // rather than from this return value.
  return {
    kind: "PERMITTED",
    attemptId: attempt.attemptId,
    expectedStateVersion: attempt.stateVersion,
    audit: {
      authorizationPolicyVersion: AUTHORIZATION_POLICY_VERSION,
      safetyGuard: guard,
      billingCycleRevenueYen: commercial.billingCycleRevenueYen,
      exposure: commercial.exposure,
      pricingSnapshotId: pricing.pricingSnapshotId,
    },
    safetyGuardWarning: guard.state === "WARNING" ? guard : null,
  };
}
