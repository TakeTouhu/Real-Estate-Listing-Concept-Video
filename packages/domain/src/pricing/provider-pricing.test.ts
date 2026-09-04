import { describe, expect, it } from "vitest";
import { evaluatePaidSubmissionPricingEligibility } from "./pricing-eligibility";
import { createPricingSnapshot, type PricingSnapshotInput } from "./pricing-snapshot";
import {
  convertMicroUsdToYen,
  estimateProviderCost,
  priceForBillableDuration,
  resolveBillableDurationSeconds,
  validateFxSnapshot,
} from "./provider-cost-calculator";
import { costRiskProfile, createProviderPricingCatalog } from "./provider-pricing-catalog";
import {
  providerPricingContractFingerprint,
  providerPricingContractKey,
  type CostRiskProfileKey,
  type DurationBillingRule,
  type ProviderPricingContract,
  type ProviderPricingIdentity,
} from "./provider-pricing-contract";
import { epochMillis, epochMillisFromDate, microUsd } from "./units";

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
    const taken = createPricingSnapshot({
      contract: h3Max(),
      riskProfileKey: "NORMAL_AI",
      requestedSeconds: 5,
      pricingEffectiveAt: AT,
    });
    if (!taken.ok) throw new Error("expected a snapshot");
    return taken.value;
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
    const taken = createPricingSnapshot({
      contract: h3Max(),
      riskProfileKey: "NORMAL_AI",
      requestedSeconds: 5,
      pricingEffectiveAt: epochMillisFromDate(at),
    });
    if (!taken.ok) throw new Error("expected a snapshot");
    at.setFullYear(2030);
    expect(taken.value.pricingEffectiveAt).toBe(Date.parse("2026-09-02T00:00:00.000Z"));
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

  it("records the exact contract it priced against", () => {
    const taken = snapshot();
    expect(taken.contractKey).toBe(providerPricingContractKey(H3_MAX_IDENTITY));
    expect(taken.contractFingerprint).toBe(providerPricingContractFingerprint(h3Max()));
  });

  it("does not change when a later snapshot uses different data", () => {
    const past = snapshot();
    createPricingSnapshot({
      contract: veoFast(),
      riskProfileKey: "HIGH_QUALITY_AI",
      requestedSeconds: 5,
      pricingEffectiveAt: AT,
    });
    expect(past.provider).toBe("fal");
    expect(past.estimatedPlanningCostMicroUsd).toBe(520_000);
  });
});

/**
 * The audit property this suite exists for: a snapshot's recorded numbers must
 * be re-derivable from the contract and risk profile it names, and no pair of
 * disagreeing facts may reach it.
 *
 * The previous constructor took `contract`, `estimate` and `riskBufferBps` as
 * three independent inputs, and validated only that the estimate's *identity*
 * key matched. That left two mismatch classes open: a same-identity contract
 * whose content differed, and a risk buffer contradicting the profile the
 * estimate was computed with. Both are now impossible by construction rather
 * than refused at runtime — the inputs that could disagree are gone — so the
 * type-level assertions below are load-bearing, not decorative.
 */
describe("a snapshot is bound to the exact facts it was computed from", () => {
  type Assert<T extends true> = T;
  type IsExactly<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false;

  /**
   * The five accepted inputs, pinned exactly.
   *
   * `Assert` fails to compile if a sixth appears, which is the only thing that
   * can hold "there is no `estimate` parameter". C5 taught this directly: an
   * optional parameter is invisible to a caller that never passes it, so a
   * runtime test cannot prove the absence of an input.
   */
  it("accepts no estimate, no risk profile object and no independent risk buffer", () => {
    type Accepted = keyof PricingSnapshotInput;
    type Expected =
      | "contract"
      | "riskProfileKey"
      | "requestedSeconds"
      | "pricingEffectiveAt"
      | "fx";
    const exact: Assert<IsExactly<Accepted, Expected>> = true;
    expect(exact).toBe(true);

    // Stated individually as well, so a failure names which input returned.
    type Rejects<K extends string> = K extends Accepted ? false : true;
    const noEstimate: Assert<Rejects<"estimate">> = true;
    const noProfile: Assert<Rejects<"riskProfile">> = true;
    const noBuffer: Assert<Rejects<"riskBufferBps">> = true;
    expect([noEstimate, noProfile, noBuffer]).toEqual([true, true, true]);
  });

  /**
   * A `CostRiskProfile` is structurally constructible, so accepting the object
   * rather than its key let a caller pair the `NORMAL_AI` key with the
   * high-quality buffer — a record that `costRiskProfile(riskProfileKey)`
   * cannot reproduce, which is exactly the re-derivation property asserted
   * below. The input is a key; the profile is resolved from the frozen catalog.
   */
  it("resolves the canonical profile for its key and cannot be told otherwise", () => {
    const key: keyof PricingSnapshotInput = "riskProfileKey";
    expect(key).toBe("riskProfileKey");

    const normal = take(h3Max(), "NORMAL_AI");
    const high = take(h3Max(), "HIGH_QUALITY_AI");
    if (!normal.ok || !high.ok) throw new Error("expected snapshots");

    // Each recorded buffer is the canonical one for the recorded key.
    expect(normal.value.riskBufferBps).toBe(costRiskProfile("NORMAL_AI").bufferBps);
    expect(high.value.riskBufferBps).toBe(costRiskProfile("HIGH_QUALITY_AI").bufferBps);
  });

  /** A same-identity contract whose commercial content has been altered. */
  function doctored(change: (base: ProviderPricingContract) => ProviderPricingContract) {
    return change(h3Max());
  }

  function take(contract: ProviderPricingContract, profile: CostRiskProfileKey) {
    return createPricingSnapshot({
      contract,
      riskProfileKey: profile,
      requestedSeconds: 5,
      pricingEffectiveAt: AT,
    });
  }

  it("cannot be given a cost computed from another provider's contract (case 1)", () => {
    // Veo and H3 Max differ in identity, so their fingerprints differ. There is
    // no input through which one's costs could be filed under the other.
    const h3 = take(h3Max(), "NORMAL_AI");
    const veo = take(veoFast(), "HIGH_QUALITY_AI");
    if (!h3.ok || !veo.ok) throw new Error("expected snapshots");
    expect(h3.value.contractFingerprint).not.toBe(veo.value.contractFingerprint);
    expect(h3.value.estimatedStableCostMicroUsd).toBe(400_000);
    expect(veo.value.estimatedStableCostMicroUsd).toBe(600_000);
  });

  it("distinguishes a same-identity contract whose stable price was modified (case 2)", () => {
    // The identity key is *identical*, which is exactly the gap the fingerprint
    // closes: at $0.09 the record must not be mistakable for the $0.08 one.
    const dearer = doctored((base) => ({
      ...base,
      stable: {
        ...base.stable,
        rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(90_000) },
      },
    }));
    expect(providerPricingContractKey(dearer.identity)).toBe(
      providerPricingContractKey(H3_MAX_IDENTITY),
    );

    const taken = take(dearer, "NORMAL_AI");
    if (!taken.ok) throw new Error("expected a snapshot");
    expect(taken.value.contractFingerprint).not.toBe(
      providerPricingContractFingerprint(h3Max()),
    );
    // The costs belong to the contract supplied, not to the catalogued one.
    expect(taken.value.estimatedStableCostMicroUsd).toBe(450_000);
  });

  it("refuses a same-identity contract whose stable rule is null (case 3)", () => {
    const promotionalOnly = doctored((base) => ({
      ...base,
      stable: { verification: "VERIFIED_STABLE", rule: null },
    }));
    const taken = take(promotionalOnly, "NORMAL_AI");
    expect(taken.ok).toBe(false);
    if (taken.ok) throw new Error("expected a refusal");
    expect(taken.error.reason).toBe("PRICING_CONTRACT_PROMOTIONAL_ONLY");
  });

  it("distinguishes a same-identity contract whose duration policy was modified (case 4)", () => {
    // A discrete policy bills 5 seconds as 6, so the same request costs more.
    const discrete = doctored((base) => ({
      ...base,
      billableDuration: { kind: "DISCRETE", supportedSeconds: [4, 6, 8] },
    }));
    const taken = take(discrete, "NORMAL_AI");
    if (!taken.ok) throw new Error("expected a snapshot");
    expect(taken.value.contractFingerprint).not.toBe(
      providerPricingContractFingerprint(h3Max()),
    );
    expect(taken.value.billableSeconds).toBe(6);
    expect(taken.value.estimatedStableCostMicroUsd).toBe(480_000);
  });

  it("cannot record a 50% buffer over a cost computed at 30% (case 5)", () => {
    const taken = take(h3Max(), "NORMAL_AI");
    if (!taken.ok) throw new Error("expected a snapshot");
    expect(taken.value.riskProfileKey).toBe("NORMAL_AI");
    expect(taken.value.riskBufferBps).toBe(3_000);
    // 400,000 × 1.30, which is the only planning cost consistent with both.
    expect(taken.value.estimatedPlanningCostMicroUsd).toBe(520_000);
  });

  it("cannot record a 30% buffer over a cost computed at 50% (case 6)", () => {
    const taken = take(h3Max(), "HIGH_QUALITY_AI");
    if (!taken.ok) throw new Error("expected a snapshot");
    expect(taken.value.riskProfileKey).toBe("HIGH_QUALITY_AI");
    expect(taken.value.riskBufferBps).toBe(5_000);
    expect(taken.value.estimatedPlanningCostMicroUsd).toBe(600_000);
  });

  it("re-derives its recorded buffer from its recorded key", () => {
    // The property the canonical resolution exists for, stated directly: the
    // stored buffer is whatever `costRiskProfile` says for the stored key.
    for (const key of ["NORMAL_AI", "HIGH_QUALITY_AI"] as const) {
      const taken = take(h3Max(), key);
      if (!taken.ok) throw new Error("expected a snapshot");
      const record = taken.value;
      expect(record.riskProfileKey).toBe(key);
      expect(costRiskProfile(record.riskProfileKey).bufferBps).toBe(record.riskBufferBps);
    }
  });

  it("re-derives exactly from the contract and risk profile it records", () => {
    // The whole point of an audit record: recompute from what it names and get
    // back what it stored, with nothing taken from the snapshot's own numbers.
    const taken = take(h3Max(), "NORMAL_AI");
    if (!taken.ok) throw new Error("expected a snapshot");
    const record = taken.value;

    const named = catalog.findByKey(record.contractKey);
    if (named === undefined) throw new Error("expected the named contract");
    expect(providerPricingContractFingerprint(named)).toBe(record.contractFingerprint);

    const rederived = estimateProviderCost(
      named,
      costRiskProfile(record.riskProfileKey),
      record.requestedSeconds,
    );
    if (!rederived.ok) throw new Error("expected an estimate");
    expect(rederived.value.billableSeconds).toBe(record.billableSeconds);
    expect(rederived.value.stableCostMicroUsd).toBe(record.estimatedStableCostMicroUsd);
    expect(rederived.value.planningCostMicroUsd).toBe(record.estimatedPlanningCostMicroUsd);
  });

  it("fingerprints every price-changing dimension", () => {
    // Each of these leaves the identity key untouched, so each is a collision
    // the identity alone could not have caught.
    const base = providerPricingContractFingerprint(h3Max());
    const variants: readonly ProviderPricingContract[] = [
      doctored((c) => ({ ...c, stable: { ...c.stable, verification: "UNVERIFIED" } })),
      doctored((c) => ({
        ...c,
        stable: {
          ...c.stable,
          rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(90_000) },
        },
      })),
      doctored((c) => ({
        ...c,
        billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 16 },
      })),
      doctored((c) => ({ ...c, effectiveFrom: epochMillis(0) })),
      doctored((c) => ({ ...c, effectiveUntil: epochMillis(4_102_444_800_000) })),
      doctored((c) => ({
        ...c,
        promotion: {
          verification: "VERIFIED_PROMOTIONAL",
          rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(20_000) },
          effectiveFrom: epochMillis(0),
          effectiveUntil: epochMillis(4_102_444_800_000),
        },
      })),
    ];
    for (const variant of variants) {
      expect(providerPricingContractKey(variant.identity)).toBe(
        providerPricingContractKey(H3_MAX_IDENTITY),
      );
      expect(providerPricingContractFingerprint(variant)).not.toBe(base);
    }
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

  const reversed = { ...fx, baseCurrency: "JPY", quoteCurrency: "USD" };

  it("refuses a conversion in the wrong currency direction", () => {
    const converted = convertMicroUsdToYen(microUsd(520_000), reversed);
    expect(converted.ok).toBe(false);
    if (converted.ok) throw new Error("expected a refusal");
    expect(converted.error.reason).toBe("FX_SNAPSHOT_CURRENCY_MISMATCH");
  });

  /**
   * Direction is validated on the *same* path as the rate components, and both
   * call sites use it.
   *
   * The earlier split was a real hole rather than a tidiness point: the
   * conversion checked direction and the snapshot did not, so a snapshot could
   * name a JPY→USD rate — a rate perfectly valid in itself, for a conversion
   * this domain cannot perform. The record would have pointed at a rate that
   * could never have produced it.
   */
  describe("one validation path serves the conversion and the snapshot", () => {
    function snapshotWith(rate: typeof fx) {
      return createPricingSnapshot({
        contract: h3Max(),
        riskProfileKey: "NORMAL_AI",
        requestedSeconds: 5,
        pricingEffectiveAt: AT,
        fx: rate,
      });
    }

    it("accepts USD→JPY and records the rate id", () => {
      const taken = snapshotWith(fx);
      if (!taken.ok) throw new Error("expected a snapshot");
      expect(taken.value.fxSnapshotId).toBe("fx-2026-09-02");
    });

    it("refuses to snapshot against a JPY→USD rate, however valid its components", () => {
      expect(validateFxSnapshot(reversed).ok).toBe(false);
      const taken = snapshotWith(reversed);
      expect(taken.ok).toBe(false);
      if (taken.ok) throw new Error("expected a refusal");
      expect(taken.error.reason).toBe("FX_SNAPSHOT_CURRENCY_MISMATCH");
    });

    it("agrees with the conversion on every rejected rate", () => {
      // Neither call site may develop its own opinion.
      for (const rate of [
        reversed,
        { ...fx, baseCurrency: "EUR" },
        { ...fx, quoteCurrency: "USD" },
        { ...fx, rateNumerator: 0 },
        { ...fx, rateDenominator: 0 },
        { ...fx, rateNumerator: 1.5 },
      ]) {
        const direct = convertMicroUsdToYen(microUsd(520_000), rate);
        const viaSnapshot = snapshotWith(rate);
        expect(direct.ok).toBe(false);
        expect(viaSnapshot.ok).toBe(false);
        if (direct.ok || viaSnapshot.ok) throw new Error("expected refusals");
        expect(viaSnapshot.error.reason).toBe(direct.error.reason);
      }
    });
  });

  /**
   * An unusable rate fails closed.
   *
   * This is the direction that matters: a zero numerator converts every
   * provider cost to ¥0 and a negative one converts it to a negative number,
   * and both *improve* every margin — so the corruption is invisible precisely
   * where a margin review would look for it. A zero denominator was worse than
   * wrong: it reached the arithmetic and threw, turning a bad input into an
   * unhandled defect rather than a pricing answer.
   */
  describe("an unusable rate is refused rather than silently applied", () => {
    it.each([
      ["zero numerator", { rateNumerator: 0 }],
      ["negative numerator", { rateNumerator: -150 }],
      ["zero denominator", { rateDenominator: 0 }],
      ["negative denominator", { rateDenominator: -1 }],
      ["fractional numerator", { rateNumerator: 150.5 }],
      ["fractional denominator", { rateDenominator: 1.5 }],
      ["NaN numerator", { rateNumerator: Number.NaN }],
      ["NaN denominator", { rateDenominator: Number.NaN }],
      ["infinite numerator", { rateNumerator: Number.POSITIVE_INFINITY }],
      ["infinite denominator", { rateDenominator: Number.POSITIVE_INFINITY }],
    ] as const)("refuses a %s", (_name, override) => {
      const converted = convertMicroUsdToYen(microUsd(520_000), { ...fx, ...override });
      expect(converted.ok).toBe(false);
      if (converted.ok) throw new Error("expected a refusal");
      expect(converted.error.reason).toBe("FX_SNAPSHOT_RATE_INVALID");
    });

    it("accepts a strictly positive integer rate", () => {
      expect(validateFxSnapshot(fx).ok).toBe(true);
      expect(validateFxSnapshot({ ...fx, rateNumerator: 1, rateDenominator: 1 }).ok).toBe(true);
    });

    it("never returns a zero or negative amount for a positive cost", () => {
      // The property behind the rule, stated independently of the checks.
      for (const override of [
        { rateNumerator: 0 },
        { rateNumerator: -150 },
        { rateDenominator: -1 },
      ]) {
        const converted = convertMicroUsdToYen(microUsd(520_000), { ...fx, ...override });
        if (converted.ok) throw new Error("expected a refusal, not an amount");
      }
    });

    /**
     * The denominator is scaled by a million to turn micro-USD into USD, and
     * `rateDenominator * 1_000_000` could leave the safe-integer range while
     * `rateDenominator` itself was an ordinary positive integer that validation
     * had just accepted. The arithmetic then threw, so an accepted input
     * produced an unhandled defect instead of a pricing answer. The whole
     * denominator is now composed in `BigInt` and never becomes a `number`.
     */
    it("survives the largest accepted rate components", () => {
      const extremes = [
        { rateNumerator: Number.MAX_SAFE_INTEGER, rateDenominator: 1 },
        { rateNumerator: 1, rateDenominator: Number.MAX_SAFE_INTEGER },
        { rateNumerator: Number.MAX_SAFE_INTEGER, rateDenominator: Number.MAX_SAFE_INTEGER },
        // The exact boundary: one more than this and the old expression's
        // `denominator * 1_000_000` stopped being a safe integer.
        { rateNumerator: 150, rateDenominator: 9_007_199_255 },
        { rateNumerator: 150, rateDenominator: 9_007_199_254_740_991 },
      ];
      for (const override of extremes) {
        const rate = { ...fx, ...override };
        expect(validateFxSnapshot(rate).ok).toBe(true);
        const converted = convertMicroUsdToYen(microUsd(520_000), rate);
        // No throw, and a real answer rather than a defect.
        if (!converted.ok) throw new Error("expected a conversion");
        expect(Number.isSafeInteger(converted.value)).toBe(true);
        expect(converted.value).toBeGreaterThanOrEqual(0);
      }
    });

    it("stays exact at a denominator that would have overflowed the old scaling", () => {
      // 1 million micro-USD is exactly $1; at 3/2 yen per USD that is ¥2 after
      // rounding half away from zero. The denominator here is large enough that
      // `× 1_000_000` exceeds Number.MAX_SAFE_INTEGER.
      const converted = convertMicroUsdToYen(microUsd(1_000_000), {
        ...fx,
        rateNumerator: 3 * 5_000_000_000,
        rateDenominator: 2 * 5_000_000_000,
      });
      if (!converted.ok) throw new Error("expected a conversion");
      expect(converted.value).toBe(2);
    });

    it("does not echo the rejected values", () => {
      const converted = convertMicroUsdToYen(microUsd(520_000), { ...fx, rateNumerator: -150 });
      if (converted.ok) throw new Error("expected a refusal");
      expect(Object.keys(converted.error)).toEqual(["reason"]);
      expect(JSON.stringify(converted.error)).not.toContain("150");
    });

    it("refuses to snapshot a decision against an unusable rate", () => {
      // A snapshot naming an fx id whose rate is unusable would document a
      // conversion that could never have been performed.
      const taken = createPricingSnapshot({
        contract: h3Max(),
        riskProfileKey: "NORMAL_AI",
        requestedSeconds: 5,
        pricingEffectiveAt: AT,
        fx: { ...fx, rateNumerator: 0 },
      });
      expect(taken.ok).toBe(false);
      if (taken.ok) throw new Error("expected a refusal");
      expect(taken.error.reason).toBe("FX_SNAPSHOT_RATE_INVALID");
    });

    it("records the rate it validated", () => {
      const taken = createPricingSnapshot({
        contract: h3Max(),
        riskProfileKey: "NORMAL_AI",
        requestedSeconds: 5,
        pricingEffectiveAt: AT,
        fx,
      });
      if (!taken.ok) throw new Error("expected a snapshot");
      expect(taken.value.fxSnapshotId).toBe("fx-2026-09-02");
    });
  });
});
