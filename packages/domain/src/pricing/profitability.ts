import { deepFreeze } from "@app/shared";
import { bps, ratioToBps, yen, type Bps, type Yen } from "./units";

/**
 * `NO_NEGATIVE_UNIT_ECONOMICS` — the hard commercial rule.
 *
 * A configuration that loses money under the worst case it is contractually
 * obliged to honour is not sellable, regardless of how it performs on average.
 * The evaluator therefore takes every cost as an explicit input and averages
 * nothing: hiding a cost behind a mean is how a product looks profitable while
 * each contract that exercises its full rights loses.
 *
 * Pure validation only. Nothing here stops a customer (§25); it answers whether
 * a configuration *should have been sold*, which is a question for pricing
 * review, not for a request already in flight.
 */

/** The most paid attempts one scene can contractually require. */
export const MAX_CONTRACTUAL_PAID_ATTEMPTS_PER_SCENE = 3;

/**
 * Management targets, as metadata.
 *
 * Recorded so a review can be measured against something, and deliberately
 * inert: falling below the gross-margin target means an internal pricing or
 * routing review, never a customer entitlement denial (§27). Nothing in this
 * module reads them to make a decision.
 */
export const PROFITABILITY_TARGETS = deepFreeze({
  targetGrossMarginBps: bps(7_500),
  acceptableGrossMarginFloorBps: bps(7_000),
  acceptableGrossMarginCeilingBps: bps(8_000),
  operatingMarginTargetFloorBps: bps(2_000),
  operatingMarginTargetCeilingBps: bps(3_000),
} as const);

/**
 * Every cost that must be covered before a configuration is profitable.
 *
 * Enumerated rather than lumped into one number so a review can see which cost
 * moved. `unknownCostExposureYen` is deliberately a first-class input: the cost
 * a model cannot yet name is still a cost, and a zero there should be a stated
 * assumption rather than an omission.
 */
export interface UnitEconomicsInput {
  readonly totalRevenueYen: Yen;
  readonly providerCostEstimateYen: Yen;
  readonly unknownCostExposureYen: Yen;
  readonly reservedProviderCostYen: Yen;
  readonly paymentProcessingCostYen: Yen;
  readonly customerVariableInfrastructureCostYen: Yen;
  readonly supportReserveYen: Yen;
  readonly salesCacAllocationYen: Yen;
  readonly otherDirectCostReserveYen: Yen;
}

export interface UnitEconomicsResult {
  readonly totalRevenueYen: Yen;
  readonly totalDirectCostYen: Yen;
  readonly contributionProfitYen: Yen;
  /** `null` when revenue is zero — a margin on nothing is undefined, not 0%. */
  readonly contributionMarginBps: Bps | null;
  readonly isNegativeUnitEconomics: boolean;
}

/**
 * Evaluate one configuration.
 *
 * `isNegativeUnitEconomics` is true **only** below zero. Break-even is not a
 * loss: refusing a configuration that exactly covers its costs would be a
 * different rule than the one that was frozen, and the boundary is where a
 * mutation would hide.
 */
export function evaluateUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  const totalDirectCost = yen(
    input.providerCostEstimateYen +
      input.unknownCostExposureYen +
      input.reservedProviderCostYen +
      input.paymentProcessingCostYen +
      input.customerVariableInfrastructureCostYen +
      input.supportReserveYen +
      input.salesCacAllocationYen +
      input.otherDirectCostReserveYen,
  );
  const contributionProfit = yen(input.totalRevenueYen - totalDirectCost);

  return deepFreeze({
    totalRevenueYen: input.totalRevenueYen,
    totalDirectCostYen: totalDirectCost,
    contributionProfitYen: contributionProfit,
    contributionMarginBps: ratioToBps(contributionProfit, input.totalRevenueYen),
    isNegativeUnitEconomics: contributionProfit < 0,
  });
}

/**
 * The provider cost of a scene when every regeneration right is exercised.
 *
 * The contractual maximum is three paid attempts — the initial generation plus
 * two user regenerations — and that is the number a sellability decision must
 * survive. The observed average of roughly 1.25 attempts is a KPI, not the
 * commitment: pricing against the average means every customer who uses what
 * they were sold is a loss (§26, §41).
 */
export function worstCaseSceneProviderCostYen(
  singleAttemptCostYen: Yen,
  attempts: number = MAX_CONTRACTUAL_PAID_ATTEMPTS_PER_SCENE,
): Yen {
  return yen(singleAttemptCostYen * attempts);
}
