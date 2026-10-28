import { describe, expect, it } from "vitest";
import { defineRoutePolicy, type AuthorizedRoute, type RoutePolicy } from "../authorization/routing";
import type { VerifiedModelEntry, VideoModelCatalog, VideoModelEntry } from "../generation/model-catalog";
import { renderPrompt } from "../generation/prompt-render";
import type { FxRateSource } from "../media-recovery/ports";
import {
  epochMillisFromDate,
  microUsd,
  providerPricingContractKey,
  type FxSnapshot,
  type ProviderPricingCatalog,
  type ProviderPricingContract,
} from "../pricing/index";
import { PRESERVATION_RULES, SYSTEM_NEGATIVE_CONSTRAINTS, type CompiledPrompt } from "../storyboard/index";
import { JobLaunchPlanner, type JobLaunchPlannerDeps } from "./planner";
import type { JobLaunchFacts, JobLaunchPlan, JobLaunchSceneFacts } from "./ports";

/**
 * Planning a waiting job's launch (ADR-0094): one route for the whole job, a
 * rendered prompt and a fresh price per scene, and every reason it plans
 * nothing instead. The catalogs are narrow fakes, so each test states exactly
 * the catalog it needs.
 */

const AT = new Date("2026-10-28T03:00:00.000Z");
const NOW = epochMillisFromDate(AT);

const RATE: FxSnapshot = {
  id: "fx_launch",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: NOW,
  sourceReference: null,
};

function compiled(roomType: string, durationSeconds: number): string {
  const prompt: CompiledPrompt = {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: {
      assetId: "ast_1",
      position: 1,
      roomType: roomType as CompiledPrompt["sceneFacts"]["roomType"],
      durationSeconds,
      cameraMotion: "SLOW_DOLLY_FORWARD",
    },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  };
  return JSON.stringify(prompt);
}

function scene(n: number, durationSeconds: number, prompt?: string | null): JobLaunchSceneFacts {
  return {
    generationSceneId: `gscn_${n}`,
    initialRequestId: `greq_${n}`,
    durationSeconds,
    compiledPrompt: prompt === undefined ? compiled(n === 1 ? "LIVING_ROOM" : "KITCHEN", durationSeconds) : prompt,
  };
}

function job(overrides: Partial<JobLaunchFacts> = {}): JobLaunchFacts {
  return {
    generationJobId: "gjob_1",
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    scenes: [scene(1, 5), scene(2, 12)],
    ...overrides,
  };
}

function model(key: string, overrides: Record<string, unknown> = {}): VerifiedModelEntry {
  return {
    key,
    providerName: "test",
    providerModelId: `test/${key}`,
    displayName: key,
    tier: "ECONOMY",
    recommended: false,
    availability: { kind: "SELECTABLE" },
    capability: {
      providerName: "test",
      providerModelId: `test/${key}`,
      durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
      nativeGenerationResolutions: ["720p", "1080p"],
      aspectRatios: { kind: "COMPOSITION_OWNED" },
      negativePrompt: { kind: "UNSUPPORTED" },
      cameraMotion: { kind: "PROMPT_RENDERED" },
    },
    nativeGeneration: {
      byTarget: {
        "720p": {
          nativeGenerationResolution: { providerValue: "720p" },
          normalization: "NONE",
          nativeMeetsTarget: true,
        },
        "1080p": {
          nativeGenerationResolution: { providerValue: "1080p" },
          normalization: "NONE",
          nativeMeetsTarget: true,
        },
      },
    },
    pricing: null,
    ...overrides,
  } as unknown as VerifiedModelEntry;
}

function catalog(entries: readonly VideoModelEntry[], defaultKey?: string): VideoModelCatalog {
  return {
    list: () => entries,
    default: () => (entries.find((e) => e.key === (defaultKey ?? entries[0]?.key)) ?? model("absent")) as never,
    find: (key) => entries.find((e) => e.key === key),
  };
}

function route(key: string, overrides: Partial<AuthorizedRoute> = {}): AuthorizedRoute {
  return {
    qualityTier: "NORMAL",
    providerName: "test",
    providerModelId: `test/${key}`,
    requestModelKey: key,
    nativeGenerationResolution: "720p",
    targetOutputResolutions: ["720p"],
    generationMode: "image-to-video",
    audioMode: "none",
    ...overrides,
  };
}

const HQ_ROUTE = route("alpha", {
  qualityTier: "HIGH_QUALITY",
  nativeGenerationResolution: "1080p",
  targetOutputResolutions: ["1080p"],
});

function policy(routes: readonly AuthorizedRoute[]): RoutePolicy {
  const tiers = [...new Set(routes.map((r) => r.qualityTier))];
  return defineRoutePolicy({ version: "launch-test.1", qualityTiers: tiers, routes });
}

function contract(
  key: string,
  overrides: Partial<ProviderPricingContract> = {},
  nativeTier = "720p",
): ProviderPricingContract {
  return {
    identity: {
      provider: "test",
      pricingModelKey: key,
      generationMode: "image-to-video",
      nativeTier,
      audioMode: "none",
      durationBillingRuleId: "per-second",
      pricingVersion: "launch-test.1",
    },
    stable: {
      verification: "VERIFIED_STABLE",
      rule: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: microUsd(10_000) },
    },
    promotion: null,
    billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 15 },
    effectiveFrom: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
    effectiveUntil: null,
    ...overrides,
  };
}

function prices(contracts: readonly ProviderPricingContract[]): ProviderPricingCatalog {
  const key = providerPricingContractKey;
  return {
    findByIdentity: (identity) => contracts.find((c) => providerPricingContractKey(c.identity) === key(identity)),
    findByKey: (k) => contracts.find((c) => providerPricingContractKey(c.identity) === k),
    all: () => contracts,
  };
}

/** A rate source that counts its reads, so a test can show when it is not read. */
function rates(answer: () => Promise<FxSnapshot | null> = async () => RATE): FxRateSource & { reads: number } {
  const source = {
    reads: 0,
    async current(): Promise<FxSnapshot | null> {
      source.reads += 1;
      return answer();
    },
  };
  return source;
}

function planner(overrides: Partial<JobLaunchPlannerDeps> = {}): JobLaunchPlanner {
  return new JobLaunchPlanner({
    routes: policy([route("alpha"), HQ_ROUTE]),
    models: catalog([model("alpha")]),
    pricing: prices([contract("alpha"), contract("alpha", {}, "1080p")]),
    fx: rates(),
    clock: () => NOW,
    ...overrides,
  });
}

function planned(plan: JobLaunchPlan): Extract<JobLaunchPlan, { kind: "PLANNED" }> {
  if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);
  return plan;
}

describe("a waiting job is planned whole", () => {
  it("sends every scene by one route, with its own prompt and its own price", async () => {
    const plan = planned(await planner().plan(job()));
    expect(plan.route).toEqual({
      providerName: "test",
      providerModelId: "test/alpha",
      requestModelKey: "alpha",
      requestNativeGenerationResolution: "720p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    });
    expect(plan.plannedAt).toBe(NOW);
    expect(plan.scenes.map((s) => [s.generationSceneId, s.generationSceneRequestId])).toEqual([
      ["gscn_1", "greq_1"],
      ["gscn_2", "greq_2"],
    ]);
    expect(plan.scenes.map((s) => s.requestRenderedPrompt)).toEqual([
      renderPrompt(compiled("LIVING_ROOM", 5)),
      renderPrompt(compiled("KITCHEN", 12)),
    ]);
    // Each scene priced for its own length, at the one instant, at the one rate.
    expect(plan.scenes.map((s) => s.pricingSnapshot.requestedSeconds)).toEqual([5, 12]);
    expect(plan.scenes.map((s) => s.pricingSnapshot.estimatedStableCostMicroUsd)).toEqual([50_000, 120_000]);
    for (const s of plan.scenes) {
      expect(s.pricingSnapshot.contractKey).toBe(providerPricingContractKey(contract("alpha").identity));
      expect(s.pricingSnapshot.riskProfileKey).toBe("NORMAL_AI");
      expect(s.pricingSnapshot.pricingEffectiveAt).toBe(NOW);
      expect(s.pricingSnapshot.fxSnapshotId).toBe("fx_launch");
      expect(s.fxSnapshot).toEqual(RATE);
    }
  });

  it("plans an HQ job at its own resolution and the HQ buffer", async () => {
    const plan = planned(await planner().plan(job({ qualityTier: "HIGH_QUALITY", targetOutputResolution: "1080p" })));
    expect(plan.route.requestNativeGenerationResolution).toBe("1080p");
    expect(plan.scenes.map((s) => s.pricingSnapshot.identity.nativeTier)).toEqual(["1080p", "1080p"]);
    expect(plan.scenes.map((s) => s.pricingSnapshot.riskProfileKey)).toEqual(["HIGH_QUALITY_AI", "HIGH_QUALITY_AI"]);
  });

  it("records how the catalog reaches the target, not an assumed native output", async () => {
    const downscaled = model("alpha", {
      nativeGeneration: {
        byTarget: {
          "720p": {
            nativeGenerationResolution: { providerValue: "1080p" },
            normalization: "DOWNSCALE",
            nativeMeetsTarget: false,
          },
        },
      },
    });
    const plan = planned(
      await planner({
        routes: policy([route("alpha", { nativeGenerationResolution: "1080p" })]),
        models: catalog([downscaled]),
        pricing: prices([contract("alpha", {}, "1080p")]),
      }).plan(job()),
    );
    expect(plan.route.requestNativeGenerationResolution).toBe("1080p");
    expect(plan.route.requestResolutionNormalization).toBe("DOWNSCALE");
    expect(plan.route.requestNativeMeetsTarget).toBe(false);
  });

  it("hands out a plan no caller can change", async () => {
    const plan = planned(await planner().plan(job()));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.scenes[0])).toBe(true);
  });
});

describe("the job's own facts are checked first", () => {
  it("refuses a resolution outside the product's vocabulary", async () => {
    const fx = rates();
    expect(await planner({ fx }).plan(job({ targetOutputResolution: "4k" }))).toEqual({
      kind: "NO_PLAN",
      code: "TARGET_RESOLUTION_UNKNOWN",
    });
    expect(fx.reads).toBe(0);
  });

  it("refuses a job with no scenes", async () => {
    expect(await planner().plan(job({ scenes: [] }))).toEqual({ kind: "NO_PLAN", code: "NO_SCENES" });
  });

  it("refuses when any scene has no prompt", async () => {
    const fx = rates();
    expect(await planner({ fx }).plan(job({ scenes: [scene(1, 5), scene(2, 5, null)] }))).toEqual({
      kind: "NO_PLAN",
      code: "SCENE_PROMPT_MISSING",
    });
    expect(fx.reads).toBe(0);
  });

  it("refuses when any scene's stored prompt does not render", async () => {
    expect(await planner().plan(job({ scenes: [scene(1, 5), scene(2, 5, "not a compiled prompt")] }))).toEqual({
      kind: "NO_PLAN",
      code: "SCENE_PROMPT_UNRENDERABLE",
    });
  });
});

describe("a route qualifies only when it can run the whole job", () => {
  async function codeFor(deps: Partial<JobLaunchPlannerDeps>, facts: JobLaunchFacts = job()): Promise<string> {
    const plan = await planner(deps).plan(facts);
    return plan.kind === "NO_PLAN" ? plan.code : "PLANNED";
  }

  it("needs the policy to sell the job's quality", async () => {
    const facts = job({ qualityTier: "HIGH_QUALITY", targetOutputResolution: "1080p" });
    expect(await codeFor({ routes: policy([route("alpha")]) }, facts)).toBe("NO_ROUTE");
  });

  it("needs the route to serve the job's resolution", async () => {
    expect(await codeFor({}, job({ targetOutputResolution: "1080p" }))).toBe("NO_ROUTE");
    // A 720p route at a native tier the catalog would reach 1080p from too.
    const native1080 = route("alpha", { nativeGenerationResolution: "1080p" });
    const pricing = prices([contract("alpha", {}, "1080p")]);
    const facts = job({ targetOutputResolution: "1080p" });
    expect(await codeFor({ routes: policy([native1080]), pricing }, facts)).toBe("NO_ROUTE");
    const serving = route("alpha", { nativeGenerationResolution: "1080p", targetOutputResolutions: ["720p", "1080p"] });
    expect(await codeFor({ routes: policy([serving]), pricing }, facts)).toBe("PLANNED");
  });

  it("takes only a route sold at the job's quality", async () => {
    // A Normal route serving 1080p beside the HQ route for the same model: an
    // HQ job is sent by the HQ route alone, not offered a choice of two.
    const normal = route("alpha", { nativeGenerationResolution: "1080p", targetOutputResolutions: ["720p", "1080p"] });
    const facts = job({ qualityTier: "HIGH_QUALITY", targetOutputResolution: "1080p" });
    expect(await codeFor({ routes: policy([normal, HQ_ROUTE]) }, facts)).toBe("PLANNED");
  });

  it("needs the model in the catalog, verified, under the route's provider and model id", async () => {
    expect(await codeFor({ models: catalog([model("beta")]) })).toBe("NO_ROUTE");
    const unverified = {
      key: "alpha",
      providerName: "test",
      displayName: "alpha",
      tier: "ECONOMY",
      recommended: false,
      availability: { kind: "UNVERIFIED", missing: ["capability"] },
    } as const;
    expect(await codeFor({ models: catalog([unverified]) })).toBe("NO_ROUTE");
    expect(await codeFor({ models: catalog([model("alpha", { providerName: "other" })]) })).toBe("NO_ROUTE");
    expect(await codeFor({ models: catalog([model("alpha", { providerModelId: "test/other" })]) })).toBe("NO_ROUTE");
  });

  it("needs the model to accept every scene's length", async () => {
    expect(await codeFor({}, job({ scenes: [scene(1, 5), scene(2, 16)] }))).toBe("NO_ROUTE");
    expect(await codeFor({}, job({ scenes: [scene(1, 4), scene(2, 5)] }))).toBe("NO_ROUTE");
    expect(await codeFor({}, job({ scenes: [scene(1, 15), scene(2, 5)] }))).toBe("PLANNED");
  });

  it("needs the catalog to deliver the resolution, from the route's own native tier", async () => {
    const no720 = model("alpha", {
      nativeGeneration: {
        byTarget: {
          "1080p": {
            nativeGenerationResolution: { providerValue: "1080p" },
            normalization: "NONE",
            nativeMeetsTarget: true,
          },
        },
      },
    });
    expect(await codeFor({ models: catalog([no720]) })).toBe("NO_ROUTE");
    expect(await codeFor({ routes: policy([route("alpha", { nativeGenerationResolution: "1080p" })]) })).toBe(
      "NO_ROUTE",
    );
  });

  it("skips a route the paid-submission gate would refuse", async () => {
    // Two routes for one model at different tiers. The catalog reaches 720p
    // from 1080p, so only the second fits it, and the gate, which matches the
    // model id first, authorizes only the first. Planning the second would
    // admit attempts the gate refuses later.
    const downscaled = model("alpha", {
      nativeGeneration: {
        byTarget: {
          "720p": {
            nativeGenerationResolution: { providerValue: "1080p" },
            normalization: "DOWNSCALE",
            nativeMeetsTarget: false,
          },
        },
      },
    });
    const routes = policy([route("alpha"), route("alpha", { nativeGenerationResolution: "1080p" })]);
    expect(await codeFor({ routes, models: catalog([downscaled]) })).toBe("NO_ROUTE");
  });

  it("lets the catalog's default decide between two, and plans nothing when it cannot", async () => {
    const routes = policy([route("alpha"), route("beta")]);
    const pricing = prices([contract("alpha"), contract("beta")]);
    const both = [model("alpha"), model("beta")];

    const toBeta = planned(await planner({ routes, pricing, models: catalog(both, "beta") }).plan(job()));
    expect(toBeta.route.requestModelKey).toBe("beta");
    const toAlpha = planned(await planner({ routes, pricing, models: catalog(both, "alpha") }).plan(job()));
    expect(toAlpha.route.requestModelKey).toBe("alpha");

    expect(await codeFor({ routes, pricing, models: catalog([...both, model("gamma")], "gamma") })).toBe(
      "AMBIGUOUS_ROUTE",
    );
  });

  it("takes the one qualifying route even when it is not the default", async () => {
    const routes = policy([route("alpha"), route("beta", { targetOutputResolutions: ["1080p"] })]);
    const plan = await planner({ routes, models: catalog([model("alpha"), model("beta")], "beta") }).plan(job());
    expect(planned(plan).route.requestModelKey).toBe("alpha");
  });
});

describe("the route must have one verified price in force now", () => {
  async function codeFor(contracts: readonly ProviderPricingContract[], facts: JobLaunchFacts = job()) {
    const fx = rates();
    const plan = await planner({ pricing: prices(contracts), fx }).plan(facts);
    return { code: plan.kind === "NO_PLAN" ? plan.code : "PLANNED", reads: fx.reads };
  }

  it("refuses a route with no contract, or only one for something else", async () => {
    expect(await codeFor([])).toEqual({ code: "NO_CURRENT_PRICING", reads: 0 });
    expect(await codeFor([contract("alpha", {}, "1080p")])).toEqual({ code: "NO_CURRENT_PRICING", reads: 0 });
    expect(await codeFor([contract("beta")])).toEqual({ code: "NO_CURRENT_PRICING", reads: 0 });
    const base = contract("alpha");
    for (const identity of [
      { ...base.identity, provider: "other" },
      { ...base.identity, generationMode: "text-to-video" },
      { ...base.identity, audioMode: "with-audio" },
    ]) {
      expect(await codeFor([{ ...base, identity }])).toEqual({ code: "NO_CURRENT_PRICING", reads: 0 });
    }
  });

  it("prices the route by its own generation and audio mode", async () => {
    const modes = { generationMode: "text-to-video", audioMode: "with-audio" };
    const routes = policy([route("alpha", modes)]);
    const base = contract("alpha");
    const own = { ...base, identity: { ...base.identity, ...modes } };
    for (const [contracts, code] of [
      [[own], "PLANNED"],
      [[base], "NO_CURRENT_PRICING"],
    ] as const) {
      const plan = await planner({ routes, pricing: prices(contracts) }).plan(job());
      expect(plan.kind === "NO_PLAN" ? plan.code : "PLANNED").toBe(code);
    }
  });

  it("counts one contract listed twice as one", async () => {
    expect(await codeFor([contract("alpha"), contract("alpha")])).toEqual({ code: "PLANNED", reads: 1 });
  });

  it("refuses a contract that has expired, has not begun or is unverified", async () => {
    const ended = contract("alpha", { effectiveUntil: NOW });
    const future = contract("alpha", { effectiveFrom: epochMillisFromDate(new Date("2026-10-29T00:00:00.000Z")) });
    const unverified = contract("alpha", { stable: { verification: "UNVERIFIED", rule: null } });
    for (const c of [ended, future, unverified]) {
      expect(await codeFor([c])).toEqual({ code: "NO_CURRENT_PRICING", reads: 0 });
    }
  });

  it("refuses two contracts in force for the same route", async () => {
    const second = contract("alpha");
    const other = { ...second, identity: { ...second.identity, pricingVersion: "launch-test.2" } };
    expect(await codeFor([contract("alpha"), other])).toEqual({ code: "AMBIGUOUS_CURRENT_PRICING", reads: 0 });
  });

  it("refuses when one scene's length cannot be billed", async () => {
    const shortOnly = contract("alpha", { billableDuration: { kind: "CONTINUOUS", minSeconds: 5, maxSeconds: 10 } });
    expect(await codeFor([shortOnly])).toEqual({ code: "NO_CURRENT_PRICING", reads: 1 });
  });
});

describe("the rate is read last, and a rate that cannot be read plans nothing", () => {
  const answers: readonly (readonly [string, () => Promise<FxSnapshot | null>])[] = [
    ["no rate", async () => null],
    ["a rate in another currency", async () => ({ ...RATE, quoteCurrency: "EUR" })],
    [
      "a source that fails",
      async (): Promise<FxSnapshot | null> => {
        throw new Error("upstream said: secret-token-123");
      },
    ],
  ];
  it.each(answers)("%s", async (_label, answer) => {
    const fx = rates(answer);
    const plan = await planner({ fx }).plan(job());
    expect(plan).toEqual({ kind: "NO_PLAN", code: "NO_FX_RATE" });
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(fx.reads).toBe(1);
  });

  it("is not read when no route qualifies", async () => {
    const fx = rates();
    await planner({ fx, models: catalog([model("beta")]) }).plan(job());
    expect(fx.reads).toBe(0);
  });
});
