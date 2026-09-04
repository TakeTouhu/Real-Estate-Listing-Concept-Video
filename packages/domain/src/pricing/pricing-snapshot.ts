import { deepFreeze } from "@app/shared";
import type { ProviderCostEstimate } from "./provider-cost-calculator";
import type {
  EvaluationInstant,
  FxSnapshot,
  ProviderPricingContract,
  ProviderPricingIdentity,
} from "./provider-pricing-contract";
import type { Bps, MicroUsd } from "./units";

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
  /** How the stable price was expressed, so the estimate can be re-derived. */
  readonly stablePriceReference: ProviderPricingContract["stableRule"];
  readonly riskProfileKey: ProviderCostEstimate["riskProfileKey"];
  readonly riskBufferBps: Bps;
  readonly requestedSeconds: number;
  readonly billableSeconds: number;
  readonly estimatedStableCostMicroUsd: MicroUsd;
  readonly estimatedPlanningCostMicroUsd: MicroUsd;
  readonly pricingEffectiveAt: EvaluationInstant;
  /** Present only when a conversion actually happened, naming the rate used. */
  readonly fxSnapshotId: string | null;
}

/**
 * Freeze a pricing decision.
 *
 * Deep-frozen and detached: the `Date` is copied rather than aliased, because a
 * `Date` is mutable and a shared reference would let a caller move a snapshot's
 * effective time after the fact. Freezing the object would not have stopped
 * that — `Object.freeze` protects the reference, not the instant inside it.
 */
export function createPricingSnapshot(input: {
  readonly contract: ProviderPricingContract;
  readonly estimate: ProviderCostEstimate;
  readonly riskBufferBps: Bps;
  readonly pricingEffectiveAt: EvaluationInstant;
  readonly fx?: FxSnapshot | null;
}): PricingSnapshot {
  return deepFreeze({
    pricingVersion: input.contract.identity.pricingVersion,
    provider: input.contract.identity.provider,
    identity: input.contract.identity,
    stablePriceReference: input.contract.stableRule,
    riskProfileKey: input.estimate.riskProfileKey,
    riskBufferBps: input.riskBufferBps,
    requestedSeconds: input.estimate.requestedSeconds,
    billableSeconds: input.estimate.billableSeconds,
    estimatedStableCostMicroUsd: input.estimate.stableCostMicroUsd,
    estimatedPlanningCostMicroUsd: input.estimate.planningCostMicroUsd,
    pricingEffectiveAt: new Date(input.pricingEffectiveAt.getTime()),
    fxSnapshotId: input.fx?.id ?? null,
  });
}
