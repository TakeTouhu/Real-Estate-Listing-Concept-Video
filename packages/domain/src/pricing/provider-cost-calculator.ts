import { pricingFailure, pricingOk, type PricingResult } from "./errors";
import {
  providerPricingContractKey,
  type BillableDurationPolicy,
  type CostRiskProfile,
  type DurationBillingRule,
  type FxSnapshot,
  type ProviderPricingContract,
} from "./provider-pricing-contract";
import {
  ONE_HUNDRED_PERCENT_BPS,
  applyBpsToMicroUsd,
  bps,
  multiplyMicroUsd,
  scaleYen,
  yen,
  type MicroUsd,
  type Yen,
} from "./units";

/**
 * Provider cost, from a requested scene length to a planning figure.
 *
 * Three separable questions, kept separable: how long the provider will
 * actually bill for, what that costs at the stable rate, and what to plan for
 * once risk is added.
 */

/**
 * The duration the provider will bill, which is not the customer's scene length.
 *
 * For a discrete provider the request is rounded **up** to the next supported
 * duration — never down, because down would be a shorter video than the
 * customer asked for, and the cost of the one that gets generated is the cost
 * that matters. A request above everything supported is refused rather than
 * quietly clamped (§19).
 */
export function resolveBillableDurationSeconds(
  policy: BillableDurationPolicy,
  requestedSeconds: number,
): PricingResult<number> {
  if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds <= 0) {
    return pricingFailure("DURATION_NOT_A_POSITIVE_INTEGER");
  }
  if (policy.kind === "CONTINUOUS") {
    if (requestedSeconds < policy.minSeconds || requestedSeconds > policy.maxSeconds) {
      return pricingFailure("DURATION_NOT_SUPPORTED_BY_PROVIDER");
    }
    return pricingOk(requestedSeconds);
  }
  const smallestSufficient = [...policy.supportedSeconds]
    .sort((a, b) => a - b)
    .find((candidate) => candidate >= requestedSeconds);
  return smallestSufficient === undefined
    ? pricingFailure("DURATION_NOT_SUPPORTED_BY_PROVIDER")
    : pricingOk(smallestSufficient);
}

/**
 * Apply a billing rule to a billable duration.
 *
 * Each arm is computed by its own rule. A `FIXED_DURATION` provider charges its
 * price for its one duration and nothing else; a `DURATION_BUCKET` provider
 * charges the first bucket whose bound the duration fits under. Neither is
 * multiplied by seconds, and an unsupported duration is a closed refusal rather
 * than a best-effort estimate (§18, §40).
 */
export function priceForBillableDuration(
  rule: DurationBillingRule,
  billableSeconds: number,
): PricingResult<MicroUsd> {
  if (!Number.isSafeInteger(billableSeconds) || billableSeconds <= 0) {
    return pricingFailure("DURATION_NOT_A_POSITIVE_INTEGER");
  }
  switch (rule.kind) {
    case "PER_SECOND":
      return pricingOk(multiplyMicroUsd(rule.unitPriceMicroUsdPerSecond, billableSeconds));
    case "FIXED_DURATION":
      return billableSeconds === rule.durationSeconds
        ? pricingOk(rule.priceMicroUsd)
        : pricingFailure("DURATION_NOT_SUPPORTED_BY_PROVIDER");
    case "DURATION_BUCKET": {
      const bucket = rule.buckets.find((candidate) => billableSeconds <= candidate.upToSeconds);
      return bucket === undefined
        ? pricingFailure("DURATION_NOT_SUPPORTED_BY_PROVIDER")
        : pricingOk(bucket.priceMicroUsd);
    }
  }
}

export interface ProviderCostEstimate {
  /**
   * The contract this estimate was computed from.
   *
   * Carried so a downstream audit record cannot pair one provider's contract
   * with another's numbers. Without it, `contract` and `estimate` are two
   * unrelated inputs and nothing can tell that a Veo cost was filed under an
   * H3 Max identity — which would produce a frozen record whose stored costs
   * cannot be re-derived from the price it claims to have used.
   */
  readonly contractKey: string;
  readonly requestedSeconds: number;
  /** What the provider bills for, which may exceed `requestedSeconds`. */
  readonly billableSeconds: number;
  /** At the stable/list rate, with no risk buffer. */
  readonly stableCostMicroUsd: MicroUsd;
  /** Stable cost × (1 + risk buffer). */
  readonly planningCostMicroUsd: MicroUsd;
  readonly riskProfileKey: CostRiskProfile["key"];
}

/**
 * Estimate what one generation will cost to plan for.
 *
 * The stable rule is the only base. A promotional rate is never consulted here:
 * planning against a discount that can end is how a margin becomes a loss
 * without any code changing (§16).
 */
export function estimateProviderCost(
  contract: ProviderPricingContract,
  riskProfile: CostRiskProfile,
  requestedSeconds: number,
): PricingResult<ProviderCostEstimate> {
  // The stable rule, and only the stable rule. `contract.promotion` is never
  // read here: a discount that can end is not a basis for a margin model.
  const stableRule = contract.stable.rule;
  if (stableRule === null) {
    return pricingFailure("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  }
  const billable = resolveBillableDurationSeconds(contract.billableDuration, requestedSeconds);
  if (!billable.ok) return billable;

  const stable = priceForBillableDuration(stableRule, billable.value);
  if (!stable.ok) return stable;

  const planning = applyBpsToMicroUsd(
    stable.value,
    bps(ONE_HUNDRED_PERCENT_BPS + riskProfile.bufferBps),
  );

  return pricingOk({
    contractKey: providerPricingContractKey(contract.identity),
    requestedSeconds,
    billableSeconds: billable.value,
    stableCostMicroUsd: stable.value,
    planningCostMicroUsd: planning,
    riskProfileKey: riskProfile.key,
  });
}

/**
 * Convert micro-USD to yen through an explicitly supplied rate.
 *
 * The snapshot's currencies are checked rather than assumed: a rate applied in
 * the wrong direction is a hundredfold error that still looks like a number.
 */
export function convertMicroUsdToYen(amount: MicroUsd, fx: FxSnapshot): PricingResult<Yen> {
  if (fx.baseCurrency !== "USD" || fx.quoteCurrency !== "JPY") {
    return pricingFailure("FX_SNAPSHOT_CURRENCY_MISMATCH");
  }
  // micro-USD → USD → JPY, as one exact fraction so the millionth never rounds twice.
  return pricingOk(
    scaleYen(yen(amount), fx.rateNumerator, fx.rateDenominator * 1_000_000),
  );
}
