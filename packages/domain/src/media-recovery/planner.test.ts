import { describe, expect, it } from "vitest";
import {
  createProviderPricingCatalog,
  epochMillisFromDate,
  providerPricingContractKey,
  type FxSnapshot,
  type ProviderPricingCatalog,
  type ProviderPricingContract,
} from "../pricing/index";
import type { VideoModelCatalog, VideoModelEntry } from "../generation/model-catalog";
import { AutomaticMediaRecoveryPricingPlanner } from "./planner";
import type { AutomaticMediaRecoveryCandidate, FxRateSource } from "./ports";

/**
 * Same route, fresh price — and every reason the planner refuses instead.
 *
 * The real production catalogs are used wherever the question is "does the real
 * route still plan?". Narrow fakes appear only where a test must express a
 * catalog state production does not currently contain — a withdrawn model, a
 * duplicated contract, an expired rate card.
 */

const AT = new Date("2026-09-10T00:00:00.000Z");
const PLANNING_AT = epochMillisFromDate(AT);

const RATE: FxSnapshot = {
  id: "fx_plan",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: PLANNING_AT,
  sourceReference: null,
};

const fx = (rate: FxSnapshot | null = RATE): FxRateSource => ({ current: async () => rate });

/** The real WaveSpeed/OpenVideo route, exactly as an admitted attempt records it. */
const ROUTE = {
  providerName: "wavespeed",
  providerModelId: "wavespeed-ai/open-video/image-to-video",
  requestModelKey: "wavespeed-open-video",
  requestNativeGenerationResolution: "1080p",
  requestResolutionNormalization: "NONE",
  requestNativeMeetsTarget: true,
} as const;

const IDENTITY = {
  provider: "wavespeed",
  pricingModelKey: "wavespeed-open-video",
  generationMode: "image-to-video",
  nativeTier: "1080p",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
};

function candidate(
  overrides: Partial<AutomaticMediaRecoveryCandidate> = {},
): AutomaticMediaRecoveryCandidate {
  return {
    organizationId: "org_a",
    sourceValidationId: "momv_1",
    sourceAttemptId: "sgen_1",
    generationSceneRequestId: "genreq_1",
    mediaFailureKind: "INVALID_MEDIA",
    route: ROUTE,
    targetOutputResolution: "1080p",
    sceneDurationSeconds: 5,
    jobQualityTier: "HIGH_QUALITY",
    persistedPricingIdentity: IDENTITY,
    persistedPricingContractFingerprint: "fingerprint",
    ...overrides,
  };
}

/** The real model catalog, without importing the provider package into the domain. */
function realModels(): VideoModelCatalog {
  const entry = {
    key: "wavespeed-open-video",
    providerName: "wavespeed",
    providerModelId: "wavespeed-ai/open-video/image-to-video",
    displayName: "WaveSpeed OpenVideo",
    tier: "ECONOMY",
    recommended: false,
    availability: { kind: "SELECTABLE" },
    // The real OpenVideo descriptor's own duration policy, not an invented one:
    // the planner now asks the catalog whether the historical clip length is
    // still generatable, so a fixture of the wrong shape would prove nothing.
    capability: { durationSeconds: { kind: "RANGE", minSeconds: 3, maxSeconds: 20 } },
    nativeGeneration: {
      byTarget: {
        "1080p": {
          nativeGenerationResolution: { providerValue: "1080p" },
          normalization: "NONE",
          nativeMeetsTarget: true,
        },
      },
    },
    pricing: null,
  } as unknown as VideoModelEntry;
  return {
    list: () => [entry],
    default: () => entry as never,
    find: (key) => (key === "wavespeed-open-video" ? entry : undefined),
  };
}

function models(entry: VideoModelEntry | undefined): VideoModelCatalog {
  return {
    list: () => (entry === undefined ? [] : [entry]),
    default: () => entry as never,
    find: () => entry,
  };
}

function mutate(base: VideoModelEntry, patch: Record<string, unknown>): VideoModelEntry {
  return { ...(base as unknown as Record<string, unknown>), ...patch } as unknown as VideoModelEntry;
}

function catalogOf(contracts: readonly ProviderPricingContract[]): ProviderPricingCatalog {
  return {
    all: () => contracts,
    findByKey: (key) =>
      contracts.find((c) => providerPricingContractKey(c.identity) === key) ?? undefined,
    findByIdentity: (identity) =>
      contracts.find(
        (c) =>
          providerPricingContractKey(c.identity) === providerPricingContractKey(identity),
      ) ?? undefined,
  };
}

function plannerWith(
  overrides: {
    readonly models?: VideoModelCatalog;
    readonly pricing?: ProviderPricingCatalog;
    readonly fx?: FxRateSource;
    readonly clock?: () => number;
  } = {},
) {
  return new AutomaticMediaRecoveryPricingPlanner({
    models: overrides.models ?? realModels(),
    pricing: overrides.pricing ?? createProviderPricingCatalog(),
    clock: overrides.clock ?? (() => PLANNING_AT),
    fx: overrides.fx ?? fx(),
  });
}

/** The one real contract for this route, as a base for catalog-shape tests. */
function openVideoContract(): ProviderPricingContract {
  const found = createProviderPricingCatalog().findByIdentity(IDENTITY as never);
  if (found === undefined) throw new Error("expected the open-video contract");
  return found;
}

describe("the happy path: same route, fresh price", () => {
  it("prices the retry at the planning instant from the Job tier and Scene duration", async () => {
    const plan = await plannerWith().plan(candidate());
    if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);

    expect(plan.pricingSnapshot.pricingEffectiveAt).toBe(PLANNING_AT);
    expect(plan.pricingSnapshot.riskProfileKey).toBe("HIGH_QUALITY_AI");
    expect(plan.pricingSnapshot.requestedSeconds).toBe(5);
    expect(plan.pricingSnapshot.provider).toBe("wavespeed");
    expect(plan.pricingSnapshot.identity.pricingModelKey).toBe("wavespeed-open-video");
    // The rate is recorded, so the attempt can be armed later.
    expect(plan.pricingSnapshot.fxSnapshotId).toBe(RATE.id);
    expect(plan.fxSnapshot).toEqual(RATE);
  });

  it("uses the Job's own tier rather than a fixed profile", async () => {
    const plan = await plannerWith().plan(candidate({ jobQualityTier: "NORMAL" }));
    if (plan.kind !== "PLANNED") throw new Error("expected a plan");
    expect(plan.pricingSnapshot.riskProfileKey).toBe("NORMAL_AI");
  });

  it("uses the Scene's own duration rather than a fixed one", async () => {
    const plan = await plannerWith().plan(candidate({ sceneDurationSeconds: 8 }));
    if (plan.kind !== "PLANNED") throw new Error("expected a plan");
    expect(plan.pricingSnapshot.requestedSeconds).toBe(8);
  });
});

describe("the persisted identity is parsed, not trusted", () => {
  for (const [name, value] of [
    ["null", null],
    ["a string", "wavespeed"],
    ["an array", []],
    ["an empty object", {}],
    ["a partial identity", { provider: "wavespeed", pricingModelKey: "wavespeed-open-video" }],
    ["a non-string dimension", { ...IDENTITY, pricingVersion: 3 }],
    ["an empty dimension", { ...IDENTITY, audioMode: "" }],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const plan = await plannerWith().plan(
        candidate({ persistedPricingIdentity: value as unknown }),
      );
      expect(plan).toEqual({ kind: "NO_PLAN", code: "PERSISTED_PRICING_IDENTITY_MALFORMED" });
    });
  }

  it("refuses an identity that disagrees with the attempt's own route", async () => {
    const plan = await plannerWith().plan(
      candidate({ persistedPricingIdentity: { ...IDENTITY, nativeTier: "720p" } }),
    );
    expect(plan).toEqual({ kind: "NO_PLAN", code: "PERSISTED_PRICING_IDENTITY_MALFORMED" });
  });
});

describe("today's catalog must still deliver the same route", () => {
  it("refuses a model that no longer exists", async () => {
    const plan = await plannerWith({ models: models(undefined) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });

  it("refuses a model that is no longer selectable", async () => {
    const base = realModels().find("wavespeed-open-video");
    if (base === undefined) throw new Error("expected the entry");
    const withdrawn = mutate(base, { availability: { kind: "UNVERIFIED" } });
    const plan = await plannerWith({ models: models(withdrawn) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });

  it("refuses a model re-pointed at another provider or model id", async () => {
    const base = realModels().find("wavespeed-open-video");
    if (base === undefined) throw new Error("expected the entry");
    for (const patch of [{ providerName: "fal" }, { providerModelId: "other/model" }]) {
      const plan = await plannerWith({ models: models(mutate(base, patch)) }).plan(candidate());
      expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
    }
  });

  it("refuses a duration the model no longer generates", async () => {
    // Admitting this would spend the request's one automatic allowance on an
    // attempt execution preflight is certain to refuse, leaving nothing left to
    // retry with. The catalog answers before any money is priced.
    const plan = await plannerWith().plan(candidate({ sceneDurationSeconds: 25 }));
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });

  it("refuses a duration a narrowed policy no longer covers", async () => {
    const base = realModels().find("wavespeed-open-video");
    if (base === undefined) throw new Error("expected the entry");
    for (const policy of [
      { kind: "RANGE", minSeconds: 8, maxSeconds: 20 },
      { kind: "ENUMERATED", seconds: [4, 6, 8] },
    ]) {
      const narrowed = mutate(base, {
        capability: { durationSeconds: policy },
      });
      // The Scene asks for 5 seconds, which both narrowed policies exclude.
      const plan = await plannerWith({ models: models(narrowed) }).plan(candidate());
      expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
    }
  });

  it("plans a duration an enumerated policy still lists", async () => {
    const base = realModels().find("wavespeed-open-video");
    if (base === undefined) throw new Error("expected the entry");
    const enumerated = mutate(base, {
      capability: { durationSeconds: { kind: "ENUMERATED", seconds: [5, 10] } },
    });
    const plan = await plannerWith({ models: models(enumerated) }).plan(candidate());
    expect(plan.kind).toBe("PLANNED");
  });

  it("refuses a target the model no longer supports", async () => {
    const plan = await plannerWith().plan(candidate({ targetOutputResolution: "720p" }));
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });

  it("refuses a target that is not a product resolution at all", async () => {
    const plan = await plannerWith().plan(candidate({ targetOutputResolution: "4k" }));
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });

  it("refuses when the route's delivery semantics changed", async () => {
    const base = realModels().find("wavespeed-open-video");
    if (base === undefined) throw new Error("expected the entry");
    // Same model, same provider, but 1080p is now produced by upscaling.
    const changed = mutate(base, {
      nativeGeneration: {
        byTarget: {
          "1080p": {
            nativeGenerationResolution: { providerValue: "720p" },
            normalization: "UPSCALE",
            nativeMeetsTarget: false,
          },
        },
      },
    });
    const plan = await plannerWith({ models: models(changed) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_ROUTE" });
  });
});

describe("a currently eligible contract, or no plan", () => {
  it("refuses when no contract matches the route", async () => {
    const plan = await plannerWith({ pricing: catalogOf([]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });

  it("refuses an expired rate card", async () => {
    const base = openVideoContract();
    const expired: ProviderPricingContract = {
      ...base,
      effectiveUntil: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
    };
    const plan = await plannerWith({ pricing: catalogOf([expired]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });

  it("refuses a contract that is not yet effective", async () => {
    const base = openVideoContract();
    const future: ProviderPricingContract = {
      ...base,
      effectiveFrom: epochMillisFromDate(new Date("2027-01-01T00:00:00.000Z")),
    };
    const plan = await plannerWith({ pricing: catalogOf([future]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });

  it("refuses an unverified contract", async () => {
    const base = openVideoContract();
    const unverified: ProviderPricingContract = {
      ...base,
      stable: { ...base.stable, verification: "UNVERIFIED" },
    };
    const plan = await plannerWith({ pricing: catalogOf([unverified]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });

  it("refuses rather than choosing when two current contracts match the route", async () => {
    const base = openVideoContract();
    // Same five commercial dimensions, a newer rate card — both in force.
    const newer: ProviderPricingContract = {
      ...base,
      identity: { ...base.identity, pricingVersion: "2026-10-01.1" },
    };
    const plan = await plannerWith({ pricing: catalogOf([base, newer]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "AMBIGUOUS_CURRENT_PRICING" });
  });

  it("accepts a newer pricingVersion for the same commercial route", async () => {
    const base = openVideoContract();
    const newer: ProviderPricingContract = {
      ...base,
      identity: {
        ...base.identity,
        pricingVersion: "2026-10-01.1",
        durationBillingRuleId: "per-second-v2",
      },
    };
    // The historical snapshot still names the old version; the retry is priced
    // against the card in force now.
    const plan = await plannerWith({ pricing: catalogOf([newer]) }).plan(candidate());
    if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);
    expect(plan.pricingSnapshot.pricingVersion).toBe("2026-10-01.1");
  });
});

describe("a recovery that could never be armed is never planned", () => {
  it("refuses when no rate is available", async () => {
    const plan = await plannerWith({ fx: fx(null) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });

  it("refuses an unusable rate", async () => {
    for (const bad of [
      { ...RATE, rateNumerator: 0 },
      { ...RATE, rateDenominator: 0 },
      { ...RATE, rateNumerator: -1 },
      { ...RATE, quoteCurrency: "EUR" },
      { ...RATE, rateNumerator: 1.5 },
    ]) {
      const plan = await plannerWith({ fx: fx(bad) }).plan(candidate());
      expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
    }
  });

  it("refuses a duration the rate card will not bill", async () => {
    // Distinct from the catalog's duration gate: the model still generates five
    // seconds, but this rate card stops billing at four. A recovery nothing can
    // price is refused here rather than admitted and discovered later.
    const narrowed: ProviderPricingContract = {
      ...openVideoContract(),
      billableDuration: { kind: "CONTINUOUS", minSeconds: 3, maxSeconds: 4 },
    };
    const plan = await plannerWith({ pricing: catalogOf([narrowed]) }).plan(candidate());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" });
  });
});

describe("no external text escapes planning", () => {
  it("returns closed refusal codes and never a message", async () => {
    const refusals = [
      await plannerWith({ models: models(undefined) }).plan(candidate()),
      await plannerWith({ fx: fx(null) }).plan(candidate()),
      await plannerWith({ pricing: catalogOf([]) }).plan(candidate()),
      await plannerWith().plan(candidate({ persistedPricingIdentity: { bad: true } })),
    ];
    for (const refusal of refusals) {
      if (refusal.kind !== "NO_PLAN") throw new Error("expected a refusal");
      expect(Object.keys(refusal).sort()).toEqual(["code", "kind"]);
      expect(typeof refusal.code).toBe("string");
    }
  });
});
