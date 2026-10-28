import { describe, expect, it } from "vitest";
import {
  JobLaunchPlanner,
  PRESERVATION_RULES,
  PRODUCTION_ROUTE_POLICY,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  createProviderPricingCatalog,
  epochMillisFromDate,
  type CompiledPrompt,
  type FxSnapshot,
  type JobLaunchFacts,
  type JobLaunchPlannerDeps,
} from "@app/domain";
import { createVideoModelCatalog } from "./catalog";
import { FAKE_VIDEO_MODEL_ID, FAKE_VIDEO_MODEL_KEY, createFakeRouteKit } from "./fake/route-kit";

/**
 * The launch planner (ADR-0094) against the two compositions that will build
 * it: production's tables and the test route's kit. The planner's own suite
 * uses narrow fakes; this pins what it does with the real ones, for the two
 * pairings the start makes (720p is Normal, 1080p is HQ).
 */

const NOW = epochMillisFromDate(new Date("2026-10-28T03:00:00.000Z"));

const RATE: FxSnapshot = {
  id: "fx_launch_tables",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: NOW,
  sourceReference: null,
};

function compiledPrompt(durationSeconds: number): string {
  const prompt: CompiledPrompt = {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: { assetId: "ast_1", position: 1, roomType: "LIVING_ROOM", durationSeconds, cameraMotion: null },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  };
  return JSON.stringify(prompt);
}

function job(qualityTier: "NORMAL" | "HIGH_QUALITY"): JobLaunchFacts {
  return {
    qualityTier,
    targetOutputResolution: qualityTier === "NORMAL" ? "720p" : "1080p",
    aspectRatio: "16:9",
    scenes: [5, 15].map((seconds, i) => ({
      generationSceneId: `gscn_${i}`,
      initialRequestId: `greq_${i}`,
      durationSeconds: seconds,
      cameraMotion: null,
      compiledPrompt: compiledPrompt(seconds),
    })),
  };
}

function planner(deps: Omit<JobLaunchPlannerDeps, "clock">): JobLaunchPlanner {
  return new JobLaunchPlanner({ ...deps, clock: () => NOW });
}

describe("production's tables", () => {
  const production = planner({
    routes: PRODUCTION_ROUTE_POLICY,
    models: createVideoModelCatalog(),
    pricing: createProviderPricingCatalog(),
    fx: { current: async () => RATE },
  });

  it("plan a Normal job for the one route that sells 720p from its catalog tier", async () => {
    const plan = await production.plan(job("NORMAL"));
    expect(plan.kind === "PLANNED" ? plan.route : plan).toEqual({
      providerName: "fal",
      providerModelId: "minimax/h3-max/image-to-video",
      requestModelKey: "minimax-h3-max",
      requestNativeGenerationResolution: "768P",
      requestResolutionNormalization: "DOWNSCALE",
      requestNativeMeetsTarget: true,
    });
  });

  it("plan no HQ job, since no HQ route is authorized", async () => {
    expect(await production.plan(job("HIGH_QUALITY"))).toEqual({ kind: "NO_PLAN", code: "NO_ROUTE" });
  });
});

describe("the test route's kit", () => {
  const kit = createFakeRouteKit({ NODE_ENV: "test", VIDEO_PROVIDER: "fake" });
  const fake = planner({
    routes: kit.routePolicy,
    models: kit.models,
    pricing: kit.pricing,
    fx: { current: async () => kit.fx },
  });

  it.each([
    ["NORMAL", "720p"],
    ["HIGH_QUALITY", "1080p"],
  ] as const)("plans a %s job for its one route at %s, never two", async (qualityTier, native) => {
    const plan = await fake.plan(job(qualityTier));
    expect(plan.kind === "PLANNED" ? plan.route : plan).toEqual({
      providerName: "fake",
      providerModelId: FAKE_VIDEO_MODEL_ID,
      requestModelKey: FAKE_VIDEO_MODEL_KEY,
      requestNativeGenerationResolution: native,
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    });
  });
});
