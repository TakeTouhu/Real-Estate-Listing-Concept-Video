import { pricingFailure, pricingOk, type PricingResult } from "./errors";
import type { ProviderPricingCatalog } from "./provider-pricing-catalog";
import {
  providerPricingContractKey,
  type ProviderPricingContract,
  type ProviderPricingIdentity,
} from "./provider-pricing-contract";
import type { EpochMillis } from "./units";

/**
 * May a pricing contract authorize a future paid submission?
 *
 * A pure decision, and **only** a decision: nothing in this phase wires it into
 * provider execution. It answers a pricing question and no other one — in
 * particular, an eligible price says nothing about whether the model is
 * executable. Pricing verification and model verification are separate
 * concerns, and a verified rate card for a model with no adapter is still
 * unrunnable.
 *
 * The rule is about the **stable/list** price, never about whether a promotion
 * exists. A contract carrying a verified stable rule *and* a live verified
 * promotion is eligible, and plans against the stable rule; a contract with
 * only a promotion is not, because when the discount ends there is no verified
 * price to fall back to and the system would have committed to work it could
 * not cost afterwards.
 *
 * The default answer is refusal. Every state that is not positively a verified
 * stable contract in force at the evaluation instant is refused, because the
 * cost of wrongly refusing is a request a human can re-authorize and the cost
 * of wrongly allowing is an unpriced charge.
 */
export function evaluatePaidSubmissionPricingEligibility(
  contract: ProviderPricingContract | null | undefined,
  at: EpochMillis,
): PricingResult<ProviderPricingContract> {
  if (contract === null || contract === undefined) {
    return pricingFailure("PRICING_CONTRACT_MISSING");
  }
  if (contract.stable.verification === "UNVERIFIED") {
    return pricingFailure("PRICING_CONTRACT_UNVERIFIED");
  }
  if (contract.stable.verification === "EXPIRED") {
    return pricingFailure("PRICING_CONTRACT_EXPIRED");
  }
  // Verified as stable but carrying no rule is promotional-only in substance,
  // whatever else the record holds.
  if (contract.stable.rule === null) {
    return pricingFailure("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  }
  if (at < contract.effectiveFrom) {
    return pricingFailure("PRICING_CONTRACT_NOT_YET_EFFECTIVE");
  }
  // A window that has closed is expired regardless of the recorded state: the
  // stored label can lag, the clock cannot.
  if (contract.effectiveUntil !== null && at >= contract.effectiveUntil) {
    return pricingFailure("PRICING_CONTRACT_EXPIRED");
  }
  return pricingOk(contract);
}

/** The five dimensions of a route that say *what is being bought*. */
export type CommercialPricingRoute = Pick<
  ProviderPricingIdentity,
  "provider" | "pricingModelKey" | "generationMode" | "nativeTier" | "audioMode"
>;

/**
 * Every currently eligible contract for one commercial route.
 *
 * Matches the five dimensions that describe *what is being bought* and leaves
 * `pricingVersion` and `durationBillingRuleId` free, because those are exactly
 * what a new rate card changes. Eligibility is then the existing authority —
 * verified, stable, in force at this instant. Shared by the planners that price
 * a new attempt: a media recovery's (Phase 4C) and a launching job's (GS-7a).
 */
export function currentlyEligibleContractsForRoute(
  pricing: ProviderPricingCatalog,
  route: CommercialPricingRoute,
  at: EpochMillis,
): readonly ProviderPricingContract[] {
  const matches = pricing
    .all()
    .filter(
      (contract) =>
        contract.identity.provider === route.provider &&
        contract.identity.pricingModelKey === route.pricingModelKey &&
        contract.identity.generationMode === route.generationMode &&
        contract.identity.nativeTier === route.nativeTier &&
        contract.identity.audioMode === route.audioMode,
    )
    .filter((contract) => evaluatePaidSubmissionPricingEligibility(contract, at).ok);

  // Two catalog entries sharing a complete identity key are the same contract
  // listed twice; the catalog already refuses that at construction. De-duping
  // by key keeps this honest if that ever changes.
  const byKey = new Map<string, ProviderPricingContract>();
  for (const contract of matches) {
    byKey.set(providerPricingContractKey(contract.identity), contract);
  }
  return [...byKey.values()];
}
