import { describe, expect, it } from "vitest";
import { defineRoutePolicy, type AuthorizedRoute, type RoutePolicy } from "../authorization/routing";
import type { DurationPolicy } from "../generation/capability";
import type { VerifiedModelEntry, VideoModelCatalog, VideoModelEntry } from "../generation/model-catalog";
import { routeCheck } from "../orchestration/start-service";
import { judgeStartRoute, qualifyingRoutes, type RouteQualificationFacts } from "./route-qualification";

/**
 * The start's route question (GS-13c-1, ADR-0123): would the launch find
 * exactly one route for a storyboard, by the planner's own rule, and when the
 * one route at its quality refuses only lengths, which scenes and what lengths
 * it takes. The catalogs are narrow fakes, as in the planner's tests.
 */

const RANGE_5_15: DurationPolicy = { kind: "RANGE", minSeconds: 5, maxSeconds: 15 };

function model(key: string, capability: Record<string, unknown> = {}): VerifiedModelEntry {
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
      durationSeconds: RANGE_5_15,
      nativeGenerationResolutions: ["720p", "1080p"],
      aspectRatios: { kind: "COMPOSITION_OWNED" },
      negativePrompt: { kind: "UNSUPPORTED" },
      cameraMotion: { kind: "PROMPT_RENDERED" },
      ...capability,
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
  } as unknown as VerifiedModelEntry;
}

function catalog(entries: readonly VideoModelEntry[]): VideoModelCatalog {
  return {
    list: () => entries,
    default: () => entries[0] as never,
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

function policy(routes: readonly AuthorizedRoute[]): RoutePolicy {
  const tiers = [...new Set(routes.map((r) => r.qualityTier))];
  return defineRoutePolicy({ version: "start-route-test.1", qualityTiers: tiers, routes });
}

const ROUTES = policy([route("alpha")]);
const MODELS = catalog([model("alpha")]);

type StartFacts = RouteQualificationFacts & { readonly targetOutputResolution: string };

/** A Normal 720p storyboard of these scene lengths, each with a camera motion. */
function storyboard(seconds: readonly number[], overrides: Partial<StartFacts> = {}): StartFacts {
  return {
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    aspectRatio: "16:9",
    scenes: seconds.map((durationSeconds) => ({ durationSeconds, cameraMotion: "SLOW_DOLLY_FORWARD" })),
    ...overrides,
  };
}

describe("a storyboard the launch would route", () => {
  it("has one route when every scene is a length the route's model takes", () => {
    expect(judgeStartRoute(storyboard([5, 15]), ROUTES, MODELS)).toEqual({ kind: "ONE_ROUTE" });
    expect(judgeStartRoute(storyboard([7, 8, 9]), ROUTES, MODELS)).toEqual({ kind: "ONE_ROUTE" });
  });

  it("has one route when only one of two candidates takes every scene, as the planner would choose", () => {
    const routes = policy([route("alpha"), route("beta")]);
    const models = catalog([model("alpha"), model("beta", { durationSeconds: { kind: "ENUMERATED", seconds: [5] } })]);
    expect(judgeStartRoute(storyboard([6]), routes, models)).toEqual({ kind: "ONE_ROUTE" });
  });
});

describe("scenes the one route cannot make at their length", () => {
  it("names each such scene by its index in the storyboard, with the lengths the route takes", () => {
    expect(judgeStartRoute(storyboard([3, 6, 16, 5]), ROUTES, MODELS)).toEqual({
      kind: "SCENE_LENGTHS",
      durations: RANGE_5_15,
      scenes: [0, 2],
    });
  });

  it("refuses a length that is not a whole number of seconds above zero, as admission does", () => {
    expect(judgeStartRoute(storyboard([5, 7.5, 0]), ROUTES, MODELS)).toEqual({
      kind: "SCENE_LENGTHS",
      durations: RANGE_5_15,
      scenes: [1, 2],
    });
  });

  it("quotes a model that takes only listed lengths as it lists them", () => {
    const listed: DurationPolicy = { kind: "ENUMERATED", seconds: [5, 10] };
    const models = catalog([model("alpha", { durationSeconds: listed })]);
    expect(judgeStartRoute(storyboard([5, 7, 10]), ROUTES, models)).toEqual({
      kind: "SCENE_LENGTHS",
      durations: listed,
      scenes: [1],
    });
  });

  it("reads the lengths from the route at the storyboard's own quality", () => {
    const hq = route("beta", { qualityTier: "HIGH_QUALITY", nativeGenerationResolution: "1080p" });
    const routes = policy([route("alpha"), { ...hq, targetOutputResolutions: ["1080p"] }]);
    const hqLengths: DurationPolicy = { kind: "RANGE", minSeconds: 8, maxSeconds: 12 };
    const models = catalog([model("alpha"), model("beta", { durationSeconds: hqLengths })]);
    const facts = storyboard([6, 9], { qualityTier: "HIGH_QUALITY", targetOutputResolution: "1080p" });
    const verdict = judgeStartRoute(facts, routes, models);
    expect(verdict).toEqual({ kind: "SCENE_LENGTHS", durations: hqLengths, scenes: [0] });
  });
});

describe("a storyboard no one route can make, for a reason the member cannot fix from it", () => {
  it("has no route at a quality or resolution the policy does not sell", () => {
    const hq = storyboard([5], { qualityTier: "HIGH_QUALITY", targetOutputResolution: "1080p" });
    expect(judgeStartRoute(hq, ROUTES, MODELS)).toEqual({ kind: "NO_ROUTE" });
    expect(judgeStartRoute(storyboard([5], { targetOutputResolution: "1080p" }), ROUTES, MODELS)).toEqual({
      kind: "NO_ROUTE",
    });
  });

  it("has no route at a resolution outside the product's vocabulary", () => {
    expect(judgeStartRoute(storyboard([5], { targetOutputResolution: "4k" }), ROUTES, MODELS)).toEqual({
      kind: "NO_ROUTE",
    });
  });

  it("has no route when the route's model is missing from the catalog", () => {
    expect(judgeStartRoute(storyboard([3]), ROUTES, catalog([model("beta")]))).toEqual({ kind: "NO_ROUTE" });
  });

  it("names lengths only when they alone stand in the way: not when another setting refuses too", () => {
    const noMotion = catalog([model("alpha", { cameraMotion: { kind: "UNSUPPORTED" } })]);
    expect(judgeStartRoute(storyboard([3, 6]), ROUTES, noMotion)).toEqual({ kind: "NO_ROUTE" });
    const still = {
      ...storyboard([3, 6]),
      scenes: [3, 6].map((durationSeconds) => ({ durationSeconds, cameraMotion: null })),
    };
    expect(judgeStartRoute(still, ROUTES, noMotion)).toEqual({
      kind: "SCENE_LENGTHS",
      durations: RANGE_5_15,
      scenes: [0],
    });
  });

  it("names no lengths when the route's model takes none", () => {
    const none = catalog([model("alpha", { durationSeconds: { kind: "ENUMERATED", seconds: [] } })]);
    expect(judgeStartRoute(storyboard([5]), ROUTES, none)).toEqual({ kind: "NO_ROUTE" });
    const fromNothing = catalog([model("alpha", { durationSeconds: { kind: "RANGE", minSeconds: 0, maxSeconds: 0 } })]);
    expect(judgeStartRoute(storyboard([5]), ROUTES, fromNothing)).toEqual({ kind: "NO_ROUTE" });
    const fromZero = catalog([model("alpha", { durationSeconds: { kind: "RANGE", minSeconds: 0, maxSeconds: 4 } })]);
    expect(judgeStartRoute(storyboard([5]), ROUTES, fromZero)).toMatchObject({ kind: "SCENE_LENGTHS", scenes: [0] });
  });

  it("has no route when every length fits but another setting does not", () => {
    const noMotion = catalog([model("alpha", { cameraMotion: { kind: "UNSUPPORTED" } })]);
    expect(judgeStartRoute(storyboard([5, 6]), ROUTES, noMotion)).toEqual({ kind: "NO_ROUTE" });
    const still = {
      ...storyboard([5, 6]),
      scenes: [5, 6].map((durationSeconds) => ({ durationSeconds, cameraMotion: null })),
    };
    expect(judgeStartRoute(still, ROUTES, noMotion)).toEqual({ kind: "ONE_ROUTE" });
    const portraitOnly = catalog([model("alpha", { aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["9:16"] } })]);
    expect(judgeStartRoute(storyboard([5]), ROUTES, portraitOnly)).toEqual({ kind: "NO_ROUTE" });
  });

  it("has no route when two routes could make it, which the planner refuses as ambiguous", () => {
    const routes = policy([route("alpha"), route("beta")]);
    const models = catalog([model("alpha"), model("beta")]);
    expect(judgeStartRoute(storyboard([5]), routes, models)).toEqual({ kind: "NO_ROUTE" });
  });

  it("names no lengths when two candidate routes both refuse a scene, since neither is the route", () => {
    const routes = policy([route("alpha"), route("beta")]);
    const models = catalog([model("alpha"), model("beta")]);
    expect(judgeStartRoute(storyboard([3]), routes, models)).toEqual({ kind: "NO_ROUTE" });
  });
});

describe("one rule for the start and the launch", () => {
  it("answers one route exactly when the planner's qualification finds one", () => {
    const routes = policy([route("alpha"), route("beta", { targetOutputResolutions: ["720p", "1080p"] })]);
    const models = catalog([
      model("alpha"),
      model("beta", {
        durationSeconds: { kind: "ENUMERATED", seconds: [4, 10] },
        cameraMotion: { kind: "UNSUPPORTED" },
      }),
    ]);
    const lengths = [[3], [4], [5], [10], [16], [4, 10], [5, 15], [7.5]];
    for (const seconds of lengths) {
      for (const cameraMotion of ["SLOW_DOLLY_FORWARD", null]) {
        for (const targetOutputResolution of ["720p", "1080p"] as const) {
          const facts = {
            ...storyboard(seconds, { targetOutputResolution }),
            scenes: seconds.map((durationSeconds) => ({ durationSeconds, cameraMotion })),
          };
          const found = qualifyingRoutes(facts, targetOutputResolution, routes, models).length;
          const one = judgeStartRoute(facts, routes, models).kind === "ONE_ROUTE";
          expect([seconds, cameraMotion, targetOutputResolution, one]).toEqual([
            seconds,
            cameraMotion,
            targetOutputResolution,
            found === 1,
          ]);
        }
      }
    }
  });

  it("is the start's route check, over the policy and catalog it is built from", () => {
    const check = routeCheck(ROUTES, MODELS);
    for (const seconds of [[5, 15], [3, 16], [6]]) {
      const facts = storyboard(seconds);
      expect(check.judge(facts)).toEqual(judgeStartRoute(facts, ROUTES, MODELS));
    }
    expect(check.judge(storyboard([3]))).toMatchObject({ kind: "SCENE_LENGTHS", scenes: [0] });
  });
});
