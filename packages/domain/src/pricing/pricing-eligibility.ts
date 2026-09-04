import { pricingFailure, pricingOk, type PricingResult } from "./errors";
import type { EvaluationInstant, ProviderPricingContract } from "./provider-pricing-contract";

/**
 * May a pricing contract authorize a future paid submission?
 *
 * A pure decision, and **only** a decision: nothing in this phase wires it into
 * provider execution (§15). It answers a pricing question and no other one —
 * in particular, an eligible price says nothing about whether the model is
 * executable. Pricing verification and model verification are separate concerns,
 * and a verified rate card for a model with no adapter is still unrunnable (§2).
 *
 * The default answer is refusal. Every state that is not positively a verified
 * stable contract, in force at the evaluation instant, is refused — because the
 * cost of wrongly refusing is a request a human can re-authorize, and the cost
 * of wrongly allowing is an unpriced charge.
 */
export function evaluatePaidSubmissionPricingEligibility(
  contract: ProviderPricingContract | null | undefined,
  at: EvaluationInstant,
): PricingResult<ProviderPricingContract> {
  if (contract === null || contract === undefined) {
    return pricingFailure("PRICING_CONTRACT_MISSING");
  }
  if (contract.verification === "UNVERIFIED") {
    return pricingFailure("PRICING_CONTRACT_UNVERIFIED");
  }
  if (contract.verification === "EXPIRED") {
    return pricingFailure("PRICING_CONTRACT_EXPIRED");
  }
  // A promotion is never sufficient on its own. Without a verified stable
  // contract behind it there is no price to fall back to when it ends, and the
  // system would be committing to work it could not cost afterwards (§15).
  if (contract.verification === "VERIFIED_PROMOTIONAL" || contract.stableRule === null) {
    return pricingFailure("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  }
  if (at.getTime() < contract.effectiveFrom.getTime()) {
    return pricingFailure("PRICING_CONTRACT_NOT_YET_EFFECTIVE");
  }
  // A window that has closed is expired regardless of the recorded state: the
  // stored label can lag, the clock cannot.
  if (contract.effectiveUntil !== null && at.getTime() >= contract.effectiveUntil.getTime()) {
    return pricingFailure("PRICING_CONTRACT_EXPIRED");
  }
  return pricingOk(contract);
}
