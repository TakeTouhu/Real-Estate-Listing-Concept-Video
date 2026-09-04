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
import {
  providerPricingContractKey,
  type DurationBillingRule,
  type ProviderPricingContract,
  type ProviderPricingIdentity,
} from "./provider-pricing-contract";
import { bps, epochMillis, epochMillisFromDate, microUsd } from "./units";

/**
 * Provider pricing, asserted against the frozen cost contract.
 *
 * Every micro-USD figure is a literal. The point of the phase is that these
 * numbers cannot drift silently, so a test that recomputed them from the
 * implementation would defeat it.
 */

const catalog = createProviderPricingCatalog();
const AT = epochMillisFromDate(new Date("2026-09-02T00:00:00.000Z"));

/** The complete identity of each catalogued contract, restated as literals. */
const H3_MAX_IDENTITY: ProviderPricingIdentity = {
  provider: "fal",
  pricingModelKey: "minimax-h3-max",
  generationMode: "image-to-video",
  nativeTier: "768P",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
};

// Veo 3.1 Fast is billed by fal, not by Google: the model is Google's, the
// invoice is fal's, and a pricing contract names whoever charges.
const VEO_FAST_IDENTITY: ProviderPricingIdentity = {
  ...H3_MAX_IDENTITY,
  pricingModelKey: "veo-3-1-fast",
  nativeTier: "1080p",
  audioMode: "off",
};

const OPEN_VIDEO_IDENTITY: ProviderPricingIdentity = {
  ...H3_MAX_IDENTITY,
  provider: "wavespeed",
  pricingModelKey: "wavespeed-open-video",
  nativeTier: "1080p",
};

function contract(identity: ProviderPricingIdentity): ProviderPricingContract {
  const found = catalog.findByIdentity(identity);
  if (found === undefined) throw new Error("missing pricing contract");
  return found;
}

const h3Max = () => contract(H3_MAX_IDENTITY);
const veoFast = () => contract(VEO_FAST_IDENTITY);
const openVideo = () => contract(OPEN_VIDEO_IDENTITY);

describe("stable provider prices are exactly as verified", () => {
  it.each([
    ["H3 Max", H3_MAX_IDENTITY, 80_000],
    ["Veo 3.1 Fast", VEO_FAST_IDENTITY, 100_000],
    ["OpenVideo", OPEN_VIDEO_IDENTITY, 60_000],
  ] as const)("%s is %i micro-USD per billable second", (_name, identity, price) => {
    const rule = contract(identity).stable.rule;
    if (rule === null || rule.kind !== "PER_SECOND") throw new Error("expected a per-second rule");
    expect(rule.unitPriceMicroUsdPerSecond).toBe(price);
  });

  it("bills Veo 3.1 Fast through fal, not through Google", () => {
    // The manufacturer is Google; the billing contract is fal's, and it must
    // match the model catalog's provider convention for this route.
    expect(veoFast().identity.provider).toBe("fal");
    expect(catalog.all().map((entry) => entry.identity.provider)).not.toContain("google-veo");
  });

  /**
   * The launch promotion is $0.02/sec. Planning against it would make the whole
   * margin model depend on a discount that can end without notice, so no
   * promotion record exists at all — its exact window is not known, and an
   * invented boundary is worse than an absent one.
   */
  it("does not carry the H3 Max launch promotion as a planning base", () => {
    const entry = h3Max();
    expect(entry.promotion).toBeNull();
    expect(entry.stable.verification).toBe("VERIFIED_STABLE");
    const rule = entry.stable.rule;
    if (rule === null || rule.kind !== "PER_SECOND") throw new Error("expected a per-second rule");
    expect(rule.unitPriceMicroUsdPerSecond).not.toBe(20_000);
  });

  it("is deeply immutable", () => {
    const entry = h3Max();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(catalog.all())).toBe(true);
    expect(() => {
      (entry.stable as { verification: string }).verification = "UNVERIFIED";
    }).toThrow();
    expect(h3Max().stable.verification).toBe("VERIFIED_STABLE");
  });

  it("exposes instants as immutable numbers, not Date objects", () => {
    // `Object.freeze` protects a reference, not the object behind it: a frozen
    // contract holding a Date still hands out something `setTime` can rewrite.
    const entry = h3Max();
    expect(typeof entry.effectiveFrom).toBe("number");
    expect(entry.effectiveFrom).not.toBeInstanceOf(Date);
    expect(() => {
      (entry as { effectiveFrom: number }).effectiveFrom = 0;
    }).toThrow();
    expect(h3Max().effectiveFrom).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
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

describe("lookup distinguishes every material billing dimension", () => {
  /**
   * Provider and model alone are not an identity. The same model at a different
   * tier, audio mode or billing rule is a different bill, and a partial match
   * would return one of those variants arbitrarily — the wrong price for a
   * request that looked identical.
   */
  it.each([
    ["native tier", { nativeTier: "1080p" }],
    ["audio mode", { audioMode: "on" }],
    ["generation mode", { generationMode: "text-to-video" }],
    ["billing rule", { durationBillingRuleId: "duration-bucket" }],
    ["pricing version", { pricingVersion: "2027-01-01.1" }],
  ] as const)("does not match H3 Max on a different %s", (_name, patch) => {
    expect(catalog.findByIdentity({ ...H3_MAX_IDENTITY, ...patch })).toBeUndefined();
  });

  it("does not match a different provider or model", () => {
    expect(catalog.findByIdentity({ ...H3_MAX_IDENTITY, provider: "wavespeed" })).toBeUndefined();
    expect(
      catalog.findByIdentity({ ...H3_MAX_IDENTITY, pricingModelKey: "veo-3-1-fast" }),
    ).toBeUndefined();
  });

  it("never returns a sibling variant of the same provider and model", () => {
    // Veo Fast and H3 Max are both fal, and both would satisfy a
    // provider-and-model-only lookup keyed on provider alone.
    const veoAtH3MaxTier = catalog.findByIdentity({
      ...VEO_FAST_IDENTITY,
      nativeTier: "768P",
      audioMode: "none",
    });
    expect(veoAtH3MaxTier).toBeUndefined();
    expect(veoFast().identity.pricingModelKey).toBe("veo-3-1-fast");
    expect(h3Max().identity.pricingModelKey).toBe("minimax-h3-max");
  });

  it("gives every catalogued contract a distinct key", () => {
    const keys = catalog.all().map((entry) => providerPricingContractKey(entry.identity));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cannot have one identity's key forged by another's values", () => {
    // Segments are escaped before joining, so a value containing the separator
    // cannot spell out a different identity.
    const forged = providerPricingContractKey({
      ...H3_MAX_IDENTITY,
      pricingModelKey: "minimax-h3-max|image-to-video|1080p",
    });
    expect(forged).not.toBe(providerPricingContractKey(H3_MAX_IDENTITY));
    expect(catalog.findByKey(forged)).toBeUndefined();
  });

  it("resolves by key exactly as it resolves by identity", () => {
    const key = providerPricingContractKey(VEO_FAST_IDENTITY);
    expect(catalog.findByKey(key)).toBe(catalog.findByIdentity(VEO_FAST_IDENTITY));
  });
});

describe("WaveSpeed OpenVideo bills 3 to 20 seconds inclusive", () => {
  it.each([
    [1, false],
    [2, false],
    [3, true],
    [20, true],
    [21, false],
  ])("%i seconds accepted: %s", (seconds, accepted) => {
    const result = resolveBillableDurationSeconds(openVideo().billableDuration, seconds);
    expect(result.ok).toBe(accepted);
  });

  /**
   * OpenVideo's capability descriptor permits 480p, 720p and 1080p, but only
   * the 1080p rate is verified. A lookup that ignored the tier would hand a
   * 480p request the 1080p price; the complete identity refuses instead, which
   * is the honest answer for a price nobody has confirmed.
   */
  it.each(["480p", "720p"])("has no verified contract for the %s tier", (tier) => {
    expect(catalog.findByIdentity({ ...OPEN_VIDEO_IDENTITY, nativeTier: tier })).toBeUndefined();
  });

  it("encodes the verified range on the contract itself", () => {
    const policy = openVideo().billableDuration;
    if (policy.kind !== "CONTINUOUS") throw new Error("expected a continuous policy");
    expect(policy.minSeconds).toBe(3);
    expect(policy.maxSeconds).toBe(20);
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
    // H3 Max is 5–15 seconds.
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

  /**
   * A `NaN` instant would make both window comparisons false and turn a
   * fail-closed check into a fail-open one. It cannot arrive: `epochMillis`
   * admits only safe integers, so an unparseable date is rejected at
   * construction rather than silently becoming "always in force".
   */
  it("cannot be reached with an invalid instant", () => {
    expect(() => epochMillisFromDate(new Date("not a date"))).toThrow();
    expect(() => epochMillis(Number.NaN)).toThrow();
    expect(() => epochMillis(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => epochMillis(1.5)).toThrow();
  });

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

  it("refuses UNVERIFIED stable pricing", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), { stable: { verification: "UNVERIFIED", rule: null } }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_UNVERIFIED");
  });

  it("refuses EXPIRED stable pricing", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), {
        stable: { verification: "EXPIRED", rule: h3Max().stable.rule },
      }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_EXPIRED");
  });

  it("refuses a contract whose effective window has closed, whatever it is labelled", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), {
        effectiveUntil: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
      }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_EXPIRED");
  });

  it("refuses a contract that is not yet in force", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), {
        effectiveFrom: epochMillisFromDate(new Date("2026-10-01T00:00:00.000Z")),
      }),
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
  const LIVE_PROMOTION = {
    verification: "VERIFIED_PROMOTIONAL",
    rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(20_000) },
    effectiveFrom: epochMillisFromDate(new Date("2026-08-01T00:00:00.000Z")),
    effectiveUntil: epochMillisFromDate(new Date("2026-12-01T00:00:00.000Z")),
  } as const;

  it("refuses promotional-only pricing, even while the promotion is live", () => {
    const promotionalOnly = withVerification(h3Max(), {
      stable: { verification: "UNVERIFIED", rule: null },
      promotion: LIVE_PROMOTION,
    });
    const result = evaluatePaidSubmissionPricingEligibility(promotionalOnly, AT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_UNVERIFIED");
  });

  /**
   * A verified *label* with no rule behind it is promotional-only in substance.
   * The label and the rule are separate fields, so they can disagree — and the
   * rule is the one that decides whether anything can be priced.
   */
  it("refuses a contract labelled verified-stable that carries no stable rule", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), {
        stable: { verification: "VERIFIED_STABLE", rule: null },
        promotion: LIVE_PROMOTION,
      }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  });

  /**
   * The correction that matters: a verified stable price is not disqualified by
   * the existence of a promotion. Eligibility asks about the list price; a
   * discount alongside it is irrelevant to that question, and planning still
   * uses the stable rule.
   */
  it("accepts a verified stable price that also carries a live verified promotion", () => {
    const both = withVerification(h3Max(), { promotion: LIVE_PROMOTION });
    const result = evaluatePaidSubmissionPricingEligibility(both, AT);
    expect(result.ok).toBe(true);

    const estimate = estimateProviderCost(both, costRiskProfile("NORMAL_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    // $0.08 stable, not the $0.02 promotion: 5 × 80,000, never 5 × 20,000.
    expect(estimate.value.stableCostMicroUsd).toBe(400_000);
    expect(estimate.value.stableCostMicroUsd).not.toBe(100_000);
  });

  it("refuses an expired stable price regardless of a live promotion", () => {
    const result = evaluatePaidSubmissionPricingEligibility(
      withVerification(h3Max(), {
        stable: { verification: "EXPIRED", rule: h3Max().stable.rule },
        promotion: LIVE_PROMOTION,
      }),
      AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.reason).toBe("PRICING_CONTRACT_EXPIRED");
  });

  it("refuses to estimate from a contract with no stable rule", () => {
    const estimate = estimateProviderCost(
      withVerification(h3Max(), { stable: { verification: "VERIFIED_STABLE", rule: null } }),
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

  it("cannot be moved through the caller's original time value", () => {
    const at = new Date("2026-09-02T00:00:00.000Z");
    const estimate = estimateProviderCost(h3Max(), costRiskProfile("NORMAL_AI"), 5);
    if (!estimate.ok) throw new Error("expected an estimate");
    const taken = createPricingSnapshot({
      contract: h3Max(),
      estimate: estimate.value,
      riskBufferBps: bps(3_000),
      pricingEffectiveAt: epochMillisFromDate(at),
    });
    at.setFullYear(2030);
    expect(taken.pricingEffectiveAt).toBe(Date.parse("2026-09-02T00:00:00.000Z"));
  });

  it("cannot be moved through the instant it exposes", () => {
    // The stored value is a number, so there is no `setTime` to reach for —
    // which is the half a frozen `Date` would have left open.
    const taken = snapshot();
    expect(typeof taken.pricingEffectiveAt).toBe("number");
    expect(taken.pricingEffectiveAt).not.toBeInstanceOf(Date);
    expect(() => {
      (taken as { pricingEffectiveAt: number }).pricingEffectiveAt = 0;
    }).toThrow();
    expect(taken.pricingEffectiveAt).toBe(Date.parse("2026-09-02T00:00:00.000Z"));
  });

  it("refuses an estimate computed from a different contract", () => {
    // Two unrelated inputs would otherwise produce a frozen record whose costs
    // cannot be re-derived from the identity it claims.
    const veoEstimate = estimateProviderCost(veoFast(), costRiskProfile("HIGH_QUALITY_AI"), 5);
    if (!veoEstimate.ok) throw new Error("expected an estimate");
    expect(() =>
      createPricingSnapshot({
        contract: h3Max(),
        estimate: veoEstimate.value,
        riskBufferBps: bps(3_000),
        pricingEffectiveAt: AT,
      }),
    ).toThrow(/does not belong/);
  });

  it("records the exact contract it priced against", () => {
    const taken = snapshot();
    expect(taken.contractKey).toBe(providerPricingContractKey(H3_MAX_IDENTITY));
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
