import { deepFreeze } from "@app/shared";
import { pricingOk, type PricingResult } from "./errors";
import {
  estimateProviderCost,
  validateFxSnapshot,
  type ProviderCostEstimate,
} from "./provider-cost-calculator";
import type {
  CostRiskProfile,
  FxSnapshot,
  ProviderPricingContract,
  ProviderPricingIdentity,
} from "./provider-pricing-contract";
import { providerPricingContractFingerprint } from "./provider-pricing-contract";
import type { Bps, EpochMillis, MicroUsd } from "./units";

/**
 * The pricing decision as it stood when a generation was admitted.
 *
 * A snapshot exists so that "what did we think this would cost?" has an answer
 * that survives the catalog changing. Prices move; a record that moves with
 * them is not a record. This is the same discipline ADR-0034 applied to the
 * request snapshot, for the same reason: a later correction must not silently
 * restate what an already-admitted attempt promised.
 *
 * Estimated and actual cost are separate concepts. This type carries only the
 * estimate — what was *planned*. What a provider actually billed is a different
 * fact, learned later, and conflating them would make the plan unfalsifiable.
 *
 * No persistence here (§45). This is a domain value; storing it is a later
 * phase's problem.
 */
export interface PricingSnapshot {
  readonly pricingVersion: string;
  readonly provider: string;
  readonly identity: ProviderPricingIdentity;
  /** The opaque key of the exact contract identity this decision priced against. */
  readonly contractKey: string;
  /**
   * The complete commercial content of that contract, encoded.
   *
   * The key alone names only the identity, and two contracts can share an
   * identity while differing in price, verification, duration policy, promotion
   * or effective window. Without this, a record cannot prove which of them
   * produced its numbers.
   */
  readonly contractFingerprint: string;
  /** How the stable price was expressed, so the estimate can be re-derived. */
  readonly stablePriceReference: ProviderPricingContract["stable"]["rule"];
  readonly riskProfileKey: ProviderCostEstimate["riskProfileKey"];
  readonly riskBufferBps: Bps;
  readonly requestedSeconds: number;
  readonly billableSeconds: number;
  readonly estimatedStableCostMicroUsd: MicroUsd;
  readonly estimatedPlanningCostMicroUsd: MicroUsd;
  readonly pricingEffectiveAt: EpochMillis;
  /** Present only when a rate was supplied, naming the rate that was validated. */
  readonly fxSnapshotId: string | null;
}

/**
 * The facts a pricing decision is made from. Deliberately the *only* inputs.
 *
 * There is no `estimate` field and no `riskBufferBps` field, and their absence
 * is the correctness property. When a caller supplied a pre-computed estimate
 * alongside a contract, the two could disagree — a Veo cost filed under an H3
 * Max identity, or a cost computed from a doctored same-identity contract — and
 * validating identity alone could not detect it. Separately, an estimate's
 * `riskProfileKey` and a hand-supplied `riskBufferBps` could contradict each
 * other: a cost computed at the 30% normal buffer, recorded as though it
 * carried the 50% high-quality one.
 *
 * Removing the inputs removes both classes outright. A mismatch is not
 * detected here, because there are no longer two things that can differ:
 * everything is derived from one contract, one risk profile and one duration,
 * through the same calculation ordinary pricing uses.
 */
export interface PricingSnapshotInput {
  readonly contract: ProviderPricingContract;
  readonly riskProfile: CostRiskProfile;
  readonly requestedSeconds: number;
  readonly pricingEffectiveAt: EpochMillis;
  readonly fx?: FxSnapshot | null;
}

/**
 * Freeze a pricing decision, derived in one calculation.
 *
 * Returns a result rather than throwing, because the reasons this can fail are
 * ordinary pricing outcomes a caller must handle: a promotional-only contract
 * has no stable rule to plan against, a duration the provider will not generate
 * has no cost, and an unusable exchange rate is a bad input rather than a
 * defect. The mismatch this used to throw on is gone — not because it is
 * tolerated, but because the inputs that could disagree no longer exist.
 *
 * The effective instant is an `EpochMillis` number, not a `Date`. Freezing an
 * object protects the reference, not the object behind it, so a snapshot
 * holding a `Date` would still hand every consumer something they could rewrite
 * with `setTime` — and a past decision whose instant can be moved is not a
 * record. A number closes that off for the caller's copy and the stored value
 * alike.
 */
export function createPricingSnapshot(
  input: PricingSnapshotInput,
): PricingResult<PricingSnapshot> {
  // The same calculation ordinary pricing uses. A snapshot that computed its
  // own costs could drift from the figures the product actually quotes.
  const estimate = estimateProviderCost(
    input.contract,
    input.riskProfile,
    input.requestedSeconds,
  );
  if (!estimate.ok) return estimate;

  // A rate is recorded only once it is usable. Naming an fx snapshot whose rate
  // is zero, negative or non-integral would document a conversion that could
  // never have been performed.
  if (input.fx !== undefined && input.fx !== null) {
    const fx = validateFxSnapshot(input.fx);
    if (!fx.ok) return fx;
  }

  return pricingOk(
    deepFreeze({
      pricingVersion: input.contract.identity.pricingVersion,
      provider: input.contract.identity.provider,
      identity: input.contract.identity,
      contractKey: estimate.value.contractKey,
      contractFingerprint: providerPricingContractFingerprint(input.contract),
      stablePriceReference: input.contract.stable.rule,
      riskProfileKey: input.riskProfile.key,
      riskBufferBps: input.riskProfile.bufferBps,
      requestedSeconds: estimate.value.requestedSeconds,
      billableSeconds: estimate.value.billableSeconds,
      estimatedStableCostMicroUsd: estimate.value.stableCostMicroUsd,
      estimatedPlanningCostMicroUsd: estimate.value.planningCostMicroUsd,
      pricingEffectiveAt: input.pricingEffectiveAt,
      fxSnapshotId: input.fx?.id ?? null,
    }),
  );
}
