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
  scaleYenByRate,
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
 * The **one** check an exchange rate must pass to be used for provider cost.
 *
 * Both call sites — the conversion itself and the pricing snapshot that names a
 * rate — go through here, and neither carries its own copy. Two
 * implementations of "is this rate usable?" would eventually disagree, and the
 * disagreement would surface as a snapshot naming a rate the conversion would
 * have refused: an audit record pointing at a rate that could never have
 * produced it.
 *
 * Direction is part of usability, not a separate concern. This domain converts
 * USD to JPY and nothing else, so a JPY→USD snapshot is not a rate with a
 * different sign — it is a rate for a conversion this module cannot perform,
 * and applying it would be a hundredfold error that still looks like a number.
 *
 * A rate is also a fraction, and only a strictly positive one is a rate at all.
 * A zero numerator converts every provider cost to ¥0 and a negative one makes
 * it negative — both *improve* every margin, so the failure hides in exactly
 * the place a margin review looks. A zero denominator was worse: it reached
 * `mulDiv` and threw, turning a bad input into an unhandled defect.
 *
 * Both components must be safe integers, which excludes `NaN`, `Infinity` and
 * fractional rates. A rate is expressed as a rational precisely so no float
 * enters the calculation; admitting one here would defeat that at the boundary.
 *
 * Every failure is a returned `PricingResult`, and the reason names the
 * category without echoing the values: an error is not a place to restate
 * inputs.
 */
export function validateFxSnapshot(fx: FxSnapshot): PricingResult<FxSnapshot> {
  if (fx.baseCurrency !== "USD" || fx.quoteCurrency !== "JPY") {
    return pricingFailure("FX_SNAPSHOT_CURRENCY_MISMATCH");
  }
  if (!Number.isSafeInteger(fx.rateNumerator) || !Number.isSafeInteger(fx.rateDenominator)) {
    return pricingFailure("FX_SNAPSHOT_RATE_INVALID");
  }
  if (fx.rateNumerator <= 0) {
    return pricingFailure("FX_SNAPSHOT_RATE_INVALID");
  }
  if (fx.rateDenominator <= 0) {
    return pricingFailure("FX_SNAPSHOT_RATE_INVALID");
  }
  return pricingOk(fx);
}

/** Micro-USD per USD. The denominator this rate is scaled by. */
const MICRO_USD_PER_USD = 1_000_000;

/**
 * Convert micro-USD to yen through an explicitly supplied, validated rate.
 *
 * The scaling denominator is composed in `BigInt` rather than as
 * `rateDenominator * 1_000_000`. A positive safe-integer denominator can leave
 * the safe-integer range once multiplied by a million, and the old expression
 * would then have thrown from inside the arithmetic on an input validation had
 * already accepted.
 */
export function convertMicroUsdToYen(amount: MicroUsd, fx: FxSnapshot): PricingResult<Yen> {
  const validated = validateFxSnapshot(fx);
  if (!validated.ok) return validated;
  // micro-USD → USD → JPY, as one exact fraction so the millionth never rounds twice.
  return pricingOk(
    scaleYenByRate(yen(amount), fx.rateNumerator, fx.rateDenominator, MICRO_USD_PER_USD),
  );
}
