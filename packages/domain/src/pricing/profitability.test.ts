import { describe, expect, it } from "vitest";
import {
  MAX_CONTRACTUAL_PAID_ATTEMPTS_PER_SCENE,
  PROFITABILITY_TARGETS,
  evaluateUnitEconomics,
  worstCaseSceneProviderCostYen,
  type UnitEconomicsInput,
} from "./profitability";
import { evaluateSafetyGuard, safetyGuardThresholds } from "./safety-guard";
import { yen } from "./units";

/** A configuration with every cost at zero, so each test states only what it varies. */
function costs(overrides: Partial<UnitEconomicsInput> = {}): UnitEconomicsInput {
  return {
    totalRevenueYen: yen(0),
    providerCostEstimateYen: yen(0),
    unknownCostExposureYen: yen(0),
    reservedProviderCostYen: yen(0),
    paymentProcessingCostYen: yen(0),
    customerVariableInfrastructureCostYen: yen(0),
    supportReserveYen: yen(0),
    salesCacAllocationYen: yen(0),
    otherDirectCostReserveYen: yen(0),
    ...overrides,
  };
}

describe("NO_NEGATIVE_UNIT_ECONOMICS", () => {
  it("reports a positive contribution", () => {
    const result = evaluateUnitEconomics(
      costs({ totalRevenueYen: yen(49_800), providerCostEstimateYen: yen(10_000) }),
    );
    expect(result.contributionProfitYen).toBe(39_800);
    expect(result.isNegativeUnitEconomics).toBe(false);
  });

  /**
   * Break-even is not a loss. Refusing a configuration that exactly covers its
   * costs would be a different rule from the one that was frozen, and the
   * boundary is precisely where a `<` / `<=` mutation would hide.
   */
  it("does not call exact break-even negative", () => {
    const result = evaluateUnitEconomics(
      costs({ totalRevenueYen: yen(30_000), providerCostEstimateYen: yen(30_000) }),
    );
    expect(result.contributionProfitYen).toBe(0);
    expect(result.isNegativeUnitEconomics).toBe(false);
  });

  it("reports a negative contribution as negative", () => {
    const result = evaluateUnitEconomics(
      costs({ totalRevenueYen: yen(30_000), providerCostEstimateYen: yen(30_001) }),
    );
    expect(result.contributionProfitYen).toBe(-1);
    expect(result.isNegativeUnitEconomics).toBe(true);
  });

  it("sums every direct cost rather than a single lumped figure", () => {
    const result = evaluateUnitEconomics(
      costs({
        totalRevenueYen: yen(100_000),
        providerCostEstimateYen: yen(10_000),
        unknownCostExposureYen: yen(1_000),
        reservedProviderCostYen: yen(2_000),
        paymentProcessingCostYen: yen(3_000),
        customerVariableInfrastructureCostYen: yen(4_000),
        supportReserveYen: yen(5_000),
        salesCacAllocationYen: yen(6_000),
        otherDirectCostReserveYen: yen(7_000),
      }),
    );
    expect(result.totalDirectCostYen).toBe(38_000);
    expect(result.contributionProfitYen).toBe(62_000);
    expect(result.contributionMarginBps).toBe(6_200);
  });

  it("reports an undefined margin on zero revenue rather than 0%", () => {
    // Reporting 0 bps would read as "breaking even" on a configuration that
    // earns nothing at all.
    const result = evaluateUnitEconomics(costs({ providerCostEstimateYen: yen(1_000) }));
    expect(result.contributionMarginBps).toBeNull();
    expect(result.isNegativeUnitEconomics).toBe(true);
  });

  it("returns a frozen result", () => {
    const result = evaluateUnitEconomics(costs({ totalRevenueYen: yen(1_000) }));
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("the contractual worst case is three paid attempts", () => {
  it("multiplies by 3, not by an average", () => {
    expect(MAX_CONTRACTUAL_PAID_ATTEMPTS_PER_SCENE).toBe(3);
    expect(worstCaseSceneProviderCostYen(yen(80))).toBe(240);
    // 1.25 attempts is a KPI, not the commitment. Pricing against it means
    // every customer who uses what they were sold is a loss.
    expect(worstCaseSceneProviderCostYen(yen(80))).not.toBe(100);
    expect(worstCaseSceneProviderCostYen(yen(80))).not.toBe(80);
  });

  it("can be evaluated without hiding the worst case", () => {
    const worst = worstCaseSceneProviderCostYen(yen(3_000));
    const result = evaluateUnitEconomics(
      costs({ totalRevenueYen: yen(8_000), providerCostEstimateYen: worst }),
    );
    expect(result.totalDirectCostYen).toBe(9_000);
    expect(result.isNegativeUnitEconomics).toBe(true);
  });

  it("keeps management targets inert", () => {
    // Targets exist to be measured against, not to gate anything. Nothing in
    // the evaluator reads them (§27).
    expect(PROFITABILITY_TARGETS.targetGrossMarginBps).toBe(7_500);
    expect(PROFITABILITY_TARGETS.acceptableGrossMarginFloorBps).toBe(7_000);
    const belowTarget = evaluateUnitEconomics(
      costs({ totalRevenueYen: yen(100_000), providerCostEstimateYen: yen(60_000) }),
    );
    expect(belowTarget.contributionMarginBps).toBe(4_000);
    expect(belowTarget.isNegativeUnitEconomics).toBe(false);
  });
});

describe("the Safety Guard classifies abnormal cost, not normal margin", () => {
  it.each([
    ["standard", 49_800, 20_000, 15_000],
    ["premium", 119_800, 29_950, 23_960],
    ["enterprise", 298_000, 74_500, 59_600],
  ] as const)("%s revenue ¥%i: warning ¥%i, hard pause ¥%i", (_name, revenue, warning, hard) => {
    const thresholds = safetyGuardThresholds(yen(revenue));
    expect(thresholds.warningFloorYen).toBe(warning);
    expect(thresholds.hardPauseFloorYen).toBe(hard);
  });

  /**
   * The boundaries are the whole rule. "Below", never "at or below": profit
   * exactly at a floor is the last acceptable value, not the first
   * unacceptable one.
   */
  it.each([
    [20_000, "SAFE"],
    [19_999, "WARNING"],
    [15_000, "WARNING"],
    [14_999, "HARD_PAUSE"],
  ] as const)("Standard revenue with profit ¥%i is %s", (profit, state) => {
    expect(evaluateSafetyGuard(yen(49_800), yen(profit)).state).toBe(state);
  });

  it.each([
    [29_950, "SAFE"],
    [29_949, "WARNING"],
    [23_960, "WARNING"],
    [23_959, "HARD_PAUSE"],
  ] as const)("Premium revenue with profit ¥%i is %s", (profit, state) => {
    expect(evaluateSafetyGuard(yen(119_800), yen(profit)).state).toBe(state);
  });

  it.each([
    [74_500, "SAFE"],
    [74_499, "WARNING"],
    [59_600, "WARNING"],
    [59_599, "HARD_PAUSE"],
  ] as const)("Enterprise revenue with profit ¥%i is %s", (profit, state) => {
    expect(evaluateSafetyGuard(yen(298_000), yen(profit)).state).toBe(state);
  });

  it("uses the absolute floor when the proportional one is thinner", () => {
    // 25% of ¥49,800 is ¥12,450 — a thinner cushion than the fixed ¥20,000.
    const thresholds = safetyGuardThresholds(yen(49_800));
    expect(thresholds.warningFloorYen).toBe(20_000);
    expect(thresholds.warningFloorYen).not.toBe(12_450);
  });

  it("uses the proportional floor once revenue is large enough", () => {
    const thresholds = safetyGuardThresholds(yen(298_000));
    expect(thresholds.hardPauseFloorYen).toBe(59_600);
    expect(thresholds.hardPauseFloorYen).not.toBe(15_000);
  });

  it("returns a frozen decision and blocks nothing", () => {
    const decision = evaluateSafetyGuard(yen(49_800), yen(14_999));
    expect(Object.isFrozen(decision)).toBe(true);
    // A state, not an action. Nothing here denies entitlement (§29).
    expect(Object.keys(decision).sort()).toEqual([
      "projectedContributionProfitYen",
      "state",
      "thresholds",
    ]);
  });
});
