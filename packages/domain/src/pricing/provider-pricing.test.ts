import { describe, expect, it } from "vitest";
import { evaluatePaidSubmissionPricingEligibility } from "./pricing-eligibility";
import { createPricingSnapshot } from "./pricing-snapshot";
import {
  convertMicroUsdToYen,
  estimateProviderCost,
  priceForBillableDuration,
  resolveBillableDurationSeconds,
} from "./provider-cost-calculator";
import { costRiskProfile, createProviderPricingCatalog } from "./provider-pricing-catalog";
import type { DurationBillingRule, ProviderPricingContract } from "./provider-pricing-contract";
import { bps, microUsd } from "./units";

/**
 * Provider pricing, asserted against the frozen cost contract.
 *
 * Every micro-USD figure is a literal. The point of the phase is that these
 * numbers cannot drift silently, so a test that recomputed them from the
 * implementation would defeat it.
 */

const catalog = createProviderPricingCatalog();
const AT = new Date("2026-09-02T00:00:00.000Z");

function contract(provider: string, key: string): ProviderPricingContract {
  const found = catalog.find(provider, key);
  if (found === undefined) throw new Error(`missing pricing contract: ${provider}/${key}`);
  return found;
}

const h3Max = () => contract("fal", "minimax-h3-max");
const veoFast = () => contract("google-veo", "veo-3-1-fast");
const openVideo = () => contract("wavespeed", "wavespeed-open-video");

describe("stable provider prices are exactly as verified", () => {
  it.each([
    ["fal", "minimax-h3-max", 80_000],
    ["google-veo", "veo-3-1-fast", 100_000],
    ["wavespeed", "wavespeed-open-video", 60_000],
  ])("%s/%s is %i micro-USD per billable second", (provider, key, price) => {
    const rule = contract(provider, key).stableRule;
    if (rule === null || rule.kind !== "PER_SECOND") throw new Error("expected a per-second rule");
    expect(rule.unitPriceMicroUsdPerSecond).toBe(price);
  });

  /**
   * The launch promotion is $0.02/sec. Planning against it would make the whole
   * margin model depend on a discount that can end without notice, so no
   * promotion record exists at all — its exact window is not known, and an
   * invented boundary is worse than an absent one.
   */
  it("does not carry the H3 Max launch promotion as a planning base", () => {
    const entry = h3Max();
    expect(entry.promotional).toBeNull();
    expect(entry.verification).toBe("VERIFIED_STABLE");
    const rule = entry.stableRule;
    if (rule === null || rule.kind !== "PER_SECOND") throw new Error("expected a per-second rule");
    expect(rule.unitPriceMicroUsdPerSecond).not.toBe(20_000);
  });

  it("is deeply immutable", () => {
    const entry = h3Max();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(catalog.all())).toBe(true);
    expect(() => {
      (entry as { verification: string }).verification = "UNVERIFIED";
    }).toThrow();
    expect(h3Max().verification).toBe("VERIFIED_STABLE");
  });

  it("freezes nested duration policy, not just the outer record", () => {
    const policy = veoFast().billableDuration;
    if (policy.kind !== "DISCRETE") throw new Error("expected discrete durations");
    expect(Object.isFrozen(policy.supportedSeconds)).toBe(true);
    expect(() => {
      (policy.supportedSeconds as number[]).push(5);
    }).toThrow();
    expect(policy.supportedSeconds).toEqual([4, 6, 8]);
  });
});

describe("risk buffers are held apart from provider prices", () => {
  it("applies 30% to normal AI", () => {
    // 5 billable seconds × $0.08 = $0.40 stable; +30% = $0.52 planning.
    const estimate = estimateProviderCost(h3Max(), costRiskProfile("NORMAL_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    expect(estimate.value.billableSeconds).toBe(5);
    expect(estimate.value.stableCostMicroUsd).toBe(400_000);
    expect(estimate.value.planningCostMicroUsd).toBe(520_000);
  });

  it("applies 50% to high-quality AI", () => {
    // A 5-second product scene bills 6 seconds on Veo: 6 × $0.10 = $0.60; +50% = $0.90.
    const estimate = estimateProviderCost(veoFast(), costRiskProfile("HIGH_QUALITY_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    expect(estimate.value.billableSeconds).toBe(6);
    expect(estimate.value.stableCostMicroUsd).toBe(600_000);
    expect(estimate.value.planningCostMicroUsd).toBe(900_000);
  });

  it("keeps the buffer out of the stable price", () => {
    // The stable figure is identical under both profiles; only planning moves.
    const normal = estimateProviderCost(h3Max(), costRiskProfile("NORMAL_AI"), 5);
    const high = estimateProviderCost(h3Max(), costRiskProfile("HIGH_QUALITY_AI"), 5);
    if (!normal.ok || !high.ok) throw new Error("expected estimates");
    expect(normal.value.stableCostMicroUsd).toBe(high.value.stableCostMicroUsd);
    expect(normal.value.planningCostMicroUsd).toBe(520_000);
    expect(high.value.planningCostMicroUsd).toBe(600_000);
  });

  it("carries exactly 3,000 and 5,000 basis points", () => {
    expect(costRiskProfile("NORMAL_AI").bufferBps).toBe(3_000);
    expect(costRiskProfile("HIGH_QUALITY_AI").bufferBps).toBe(5_000);
  });
});

describe("provider billable duration is not the customer's scene length", () => {
  it("bills a 5-second Veo scene as 6 seconds", () => {
    const billable = resolveBillableDurationSeconds(veoFast().billableDuration, 5);
    if (!billable.ok) throw new Error("expected a duration");
    expect(billable.value).toBe(6);
    expect(billable.value).not.toBe(5);
  });

  it.each([
    [4, 4],
    [5, 6],
    [6, 6],
    [7, 8],
    [8, 8],
  ])("rounds a %i-second request up to %i supported seconds", (requested, billable) => {
    const result = resolveBillableDurationSeconds(veoFast().billableDuration, requested);
    if (!result.ok) throw new Error("expected a duration");
    expect(result.value).toBe(billable);
  });

  it("refuses a request longer than anything the provider supports", () => {
    const result = resolveBillableDurationSeconds(veoFast().billableDuration, 9);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("DURATION_NOT_SUPPORTED_BY_PROVIDER");
  });

  it("bills a continuous provider for exactly what was asked", () => {
    const result = resolveBillableDurationSeconds(openVideo().billableDuration, 7);
    if (!result.ok) throw new Error("expected a duration");
    expect(result.value).toBe(7);
  });

  it("refuses a continuous duration outside the supported range", () => {
    expect(resolveBillableDurationSeconds(h3Max().billableDuration, 4).ok).toBe(false);
    expect(resolveBillableDurationSeconds(h3Max().billableDuration, 16).ok).toBe(false);
  });
});

describe("duration billing rules are not all per-second", () => {
  const fixed: DurationBillingRule = {
    kind: "FIXED_DURATION",
    durationSeconds: 6,
    priceMicroUsd: microUsd(250_000),
  };
  const bucketed: DurationBillingRule = {
    kind: "DURATION_BUCKET",
    buckets: [
      { upToSeconds: 5, priceMicroUsd: microUsd(100_000) },
      { upToSeconds: 10, priceMicroUsd: microUsd(180_000) },
    ],
  };

  it("multiplies only for PER_SECOND", () => {
    const perSecond: DurationBillingRule = {
      kind: "PER_SECOND",
      unitPriceMicroUsdPerSecond: microUsd(80_000),
    };
    const priced = priceForBillableDuration(perSecond, 5);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value).toBe(400_000);
  });

  it("charges a FIXED_DURATION price flat, and never multiplies it", () => {
    const priced = priceForBillableDuration(fixed, 6);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value).toBe(250_000);
    // A per-second reading would have produced 1_500_000.
    expect(priced.value).not.toBe(1_500_000);
  });

  it("refuses a FIXED_DURATION request at any other duration", () => {
    const priced = priceForBillableDuration(fixed, 5);
    expect(priced.ok).toBe(false);
    if (priced.ok) throw new Error("expected a refusal");
    expect(priced.error.reason).toBe("DURATION_NOT_SUPPORTED_BY_PROVIDER");
  });

  it.each([
    [1, 100_000],
    [5, 100_000],
    [6, 180_000],
    [10, 180_000],
  ])("selects the bucket for %i seconds: %i micro-USD", (seconds, price) => {
    const priced = priceForBillableDuration(bucketed, seconds);
    if (!priced.ok) throw new Error("expected a price");
    expect(priced.value).toBe(price);
  });

  it("refuses a duration past the last bucket rather than extrapolating", () => {
    const priced = priceForBillableDuration(bucketed, 11);
    expect(priced.ok).toBe(false);
    if (priced.ok) throw new Error("expected a refusal");
    expect(priced.error.reason).toBe("DURATION_NOT_SUPPORTED_BY_PROVIDER");
  });

  it.each([0, -1, 2.5, Number.NaN])("refuses %s as a billable duration", (bad) => {
    expect(priceForBillableDuration(bucketed, bad).ok).toBe(false);
  });
});

describe("paid-submission pricing eligibility refuses by default", () => {
  function withVerification(
    base: ProviderPricingContract,
    patch: Partial<ProviderPricingContract>,
  ): ProviderPricingContract {
    return { ...base, ...patch };
  }

  it("accepts a verified stable contract in force", () => {
    const result = evaluatePaidSubmissionPricingEligibility(h3Max(), AT);
    expect(result.ok).toBe(true);
  });

  it.each([
    [null, "PRICING_CONTRACT_MISSING"],
    [undefined, "PRICING_CONTRACT_MISSING"],
  ] as const)("refuses %s pricing", (value, reason) => {
    const result = evaluatePaidSubmissionPricingEligibility(value, AT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe(reason);
  });

  it("refuses UNVERIFIED pricing", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), { verification: "UNVERIFIED" }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_UNVERIFIED");
  });

  it("refuses EXPIRED pricing", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), { verification: "EXPIRED" }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_EXPIRED");
  });

  it("refuses a contract whose effective window has closed, whatever it is labelled", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), { effectiveUntil: new Date("2026-09-01T00:00:00.000Z") }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_EXPIRED");
  });

  it("refuses a contract that is not yet in force", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), { effectiveFrom: new Date("2026-10-01T00:00:00.000Z") }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_NOT_YET_EFFECTIVE");
  });

  /**
   * The load-bearing refusal. A promotion alone can never authorize paid work:
   * when it ends there is no verified price to fall back to, so the system
   * would have committed to work it could not cost afterwards.
   */
  it("refuses promotional-only pricing, even while the promotion is live", () => {
    const promotionalOnly = withVerification(h3Max(), {
      verification: "VERIFIED_PROMOTIONAL",
      stableRule: null,
      promotional: {
        rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(20_000) },
        effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
        effectiveUntil: new Date("2026-12-01T00:00:00.000Z"),
      },
    });
    const result = evaluatePaidSubmissionPricingEligibility(promotionalOnly, AT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  });

  it("refuses to estimate from a contract with no stable rule", () => {
    const estimate = estimateProviderCost(
      withVerification(h3Max(), { stableRule: null }),
      costRiskProfile("NORMAL_AI"),
      5,
    );
    expect(estimate.ok).toBe(false);
    if (estimate.ok) throw new Error("expected a refusal");
    expect(estimate.error.reason).toBe("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  });

  /**
   * Pricing eligibility answers a pricing question and no other one. Veo has a
   * verified rate card and no adapter; a price cannot make a model runnable.
   */
  it("does not make an unexecutable model executable", () => {
    const result = evaluatePaidSubmissionPricingEligibility(veoFast(), AT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected eligibility");
    // The result carries a pricing contract and nothing resembling an
    // executable identity — no endpoint, no executable model id.
    expect(Object.keys(result.value.identity)).not.toContain("providerModelId");
    expect(JSON.stringify(result.value)).not.toContain("image-to-video/");
  });
});

describe("pricing snapshots are immutable and do not follow the catalog", () => {
  function snapshot() {
    const estimate = estimateProviderCost(h3Max(), costRiskProfile("NORMAL_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    return createPricingSnapshot({
      contract: h3Max(),
      estimate: estimate.value,
      riskBufferBps: bps(3_000),
      pricingEffectiveAt: AT,
    });
  }

  it("records the decision that was made", () => {
    const taken = snapshot();
    expect(taken.pricingVersion).toBe("2026-09-02.1");
    expect(taken.provider).toBe("fal");
    expect(taken.estimatedStableCostMicroUsd).toBe(400_000);
    expect(taken.estimatedPlanningCostMicroUsd).toBe(520_000);
    expect(taken.riskBufferBps).toBe(3_000);
    expect(taken.billableSeconds).toBe(5);
    expect(taken.fxSnapshotId).toBeNull();
  });

  it("is frozen", () => {
    const taken = snapshot();
    expect(Object.isFrozen(taken)).toBe(true);
    expect(() => {
      (taken as { estimatedPlanningCostMicroUsd: number }).estimatedPlanningCostMicroUsd = 1;
    }).toThrow();
    expect(taken.estimatedPlanningCostMicroUsd).toBe(520_000);
  });

  it("detaches its effective instant from the caller's Date", () => {
    // A frozen object holding a live Date is not immutable: freezing protects
    // the reference, not the instant inside it.
    const at = new Date("2026-09-02T00:00:00.000Z");
    const estimate = estimateProviderCost(h3Max(), costRiskProfile("NORMAL_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    const taken = createPricingSnapshot({
      contract: h3Max(),
      estimate: estimate.value,
      riskBufferBps: bps(3_000),
      pricingEffectiveAt: at,
    });
    at.setFullYear(2030);
    expect(taken.pricingEffectiveAt.getUTCFullYear()).toBe(2026);
  });

  it("does not change when a later estimate uses different data", () => {
    const past = snapshot();
    const laterEstimate = estimateProviderCost(veoFast(), costRiskProfile("HIGH_QUALITY_AI"), 5);
    if (!laterEstimate.ok) throw new Error("expected an estimate");
    createPricingSnapshot({
      contract: veoFast(),
      estimate: laterEstimate.value,
      riskBufferBps: bps(5_000),
      pricingEffectiveAt: AT,
    });
    expect(past.provider).toBe("fal");
    expect(past.estimatedPlanningCostMicroUsd).toBe(520_000);
  });
});

describe("FX conversion requires an explicit, audited rate", () => {
  const fx = {
    id: "fx-2026-09-02",
    baseCurrency: "USD",
    quoteCurrency: "JPY",
    rateNumerator: 150,
    rateDenominator: 1,
    effectiveAt: AT,
    sourceReference: "test-fixture",
  };

  it("converts micro-USD to yen through the supplied rate", () => {
    // $0.52 planning cost at ¥150/USD is ¥78.
    const converted = convertMicroUsdToYen(microUsd(520_000), fx);
    if (!converted.ok) throw new Error("expected a conversion");
    expect(converted.value).toBe(78);
  });

  it("refuses a snapshot in the wrong currency direction", () => {
    const converted = convertMicroUsdToYen(microUsd(520_000), {
      ...fx,
      baseCurrency: "JPY",
      quoteCurrency: "USD",
    });
    expect(converted.ok).toBe(false);
    if (converted.ok) throw new Error("expected a refusal");
    expect(converted.error.reason).toBe("FX_SNAPSHOT_CURRENCY_MISMATCH");
  });
});
