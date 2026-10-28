import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { FxSnapshot } from "../pricing/provider-pricing-contract";
import type { PricingSnapshot } from "../pricing/pricing-snapshot";
import { epochMillis } from "../pricing/units";
import {
  JobLaunchDefect,
  MAX_JOB_LAUNCH_BATCH_SIZE,
  assertPlanForFacts,
  decideJobLaunch,
  validateJobLaunchBatchLimit,
  type JobLaunchLockedRows,
  type JobLaunchLockedScene,
} from "./launch";
import type { JobLaunchFacts, JobLaunchPlan } from "./ports";

/**
 * The launch commit's decision (ADR-0095): the locked rows launch only when
 * the job still waits, its Units are held, its Property stands, every scene is
 * as the start wrote it, and every fact the plan was made from still holds.
 */

type Planned = Extract<JobLaunchPlan, { kind: "PLANNED" }>;

function facts(): JobLaunchFacts {
  return {
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    aspectRatio: "16:9",
    scenes: [1, 2].map((n) => ({
      generationSceneId: `gscn_${n}`,
      initialRequestId: `greq_${n}`,
      durationSeconds: 5 * n,
      cameraMotion: n === 1 ? "SLOW_PAN" : null,
      compiledPrompt: `compiled ${n}`,
    })),
  };
}

function plan(from: JobLaunchFacts = facts()): Planned {
  return {
    kind: "PLANNED",
    route: {
      providerName: "fake",
      providerModelId: "fake/model",
      requestModelKey: "fake-model",
      requestNativeGenerationResolution: "720p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    },
    scenes: from.scenes.map((scene) => ({
      generationSceneId: scene.generationSceneId,
      generationSceneRequestId: scene.initialRequestId,
      compiledPrompt: scene.compiledPrompt ?? "",
      requestRenderedPrompt: `rendered ${scene.generationSceneId}`,
      pricingSnapshot: { fxSnapshotId: "fx_1" } as unknown as PricingSnapshot,
      fxSnapshot: { id: "fx_1" } as unknown as FxSnapshot,
    })),
    plannedAt: epochMillis(1_000),
  };
}

function lockedScene(n: number, overrides: Partial<JobLaunchLockedScene> = {}): JobLaunchLockedScene {
  return {
    generationSceneId: `gscn_${n}`,
    state: "PENDING",
    durationSeconds: 5 * n,
    cameraMotion: n === 1 ? "SLOW_PAN" : null,
    compiledPrompt: `compiled ${n}`,
    requests: request(`greq_${n}`),
    ...overrides,
  };
}

/** One request of a scene, pending and never attempted unless told otherwise. */
function request(id: string, overrides: Partial<JobLaunchLockedScene["requests"][number]> = {}) {
  return [{ id, kind: "INITIAL", state: "PENDING", attempts: 0, ...overrides }];
}

function locked(overrides: Partial<JobLaunchLockedRows> = {}): JobLaunchLockedRows {
  return {
    jobState: "RESERVED",
    reservationState: "RESERVED",
    propertyDeleted: false,
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    aspectRatio: "16:9",
    scenes: [lockedScene(1), lockedScene(2)],
    ...overrides,
  };
}

const decide = (rows: JobLaunchLockedRows, from: JobLaunchFacts = facts()) =>
  decideJobLaunch({ locked: rows, facts: from, plan: plan(from) });

describe("a waiting job exactly as the start wrote it", () => {
  it("launches", () => {
    expect(decide(locked())).toEqual({ kind: "LAUNCH" });
  });
});

describe("a job that is not waiting any more", () => {
  for (const jobState of ["CREATED", "RESERVING", "GENERATING", "FAILED_TERMINAL", "CANCELLED"]) {
    it(`is not launched from ${jobState}`, () => {
      expect(decide(locked({ jobState }))).toEqual({ kind: "REFUSE", reason: "NOT_WAITING" });
    });
  }

  it("is answered before its Property or its shape", () => {
    expect(decide(locked({ jobState: "GENERATING", propertyDeleted: true, reservationState: null }))).toEqual({
      kind: "REFUSE",
      reason: "NOT_WAITING",
    });
  });
});

describe("a deleted Property's job", () => {
  it("is not launched, whatever else holds", () => {
    expect(decide(locked({ propertyDeleted: true }))).toEqual({ kind: "REFUSE", reason: "PROPERTY_DELETED" });
    expect(decide(locked({ propertyDeleted: true, reservationState: "RELEASED" }))).toEqual({
      kind: "REFUSE",
      reason: "PROPERTY_DELETED",
    });
  });
});

describe("rows not of the start's shape", () => {
  const conflicts: [string, JobLaunchLockedRows][] = [
    ["no reservation", locked({ reservationState: null })],
    ["a released reservation", locked({ reservationState: "RELEASED" })],
    ["a reservation on hold", locked({ reservationState: "RECONCILIATION_HOLD" })],
    ["no scene", locked({ scenes: [] })],
    ["a scene already generating", locked({ scenes: [lockedScene(1), lockedScene(2, { state: "GENERATING" })] })],
    ["a scene with no request", locked({ scenes: [lockedScene(1), lockedScene(2, { requests: [] })] })],
    [
      "a scene with two requests",
      locked({
        scenes: [
          lockedScene(1),
          lockedScene(2, {
            requests: [
              { id: "greq_2", kind: "INITIAL", state: "PENDING", attempts: 0 },
              { id: "greq_2b", kind: "USER_REGENERATION", state: "PENDING", attempts: 0 },
            ],
          }),
        ],
      }),
    ],
    [
      "a first request that is a regeneration",
      locked({
        scenes: [lockedScene(1, { requests: request("greq_1", { kind: "USER_REGENERATION" }) })],
      }),
    ],
    [
      "a request already started",
      locked({
        scenes: [lockedScene(1, { requests: request("greq_1", { state: "GENERATING" }) })],
      }),
    ],
    [
      "a request with an attempt",
      locked({
        scenes: [lockedScene(1), lockedScene(2, { requests: request("greq_2", { attempts: 1 }) })],
      }),
    ],
  ];
  for (const [name, rows] of conflicts) {
    it(`refuses ${name}`, () => {
      expect(decide(rows)).toEqual({ kind: "REFUSE", reason: "SHAPE_CONFLICT" });
    });
  }
});

describe("facts other than the plan's", () => {
  const changed: [string, JobLaunchLockedRows][] = [
    ["the quality", locked({ qualityTier: "HIGH_QUALITY" })],
    ["the resolution", locked({ targetOutputResolution: "1080p" })],
    ["the aspect ratio", locked({ aspectRatio: "9:16" })],
    ["a scene fewer", locked({ scenes: [lockedScene(1)] })],
    ["a scene more", locked({ scenes: [lockedScene(1), lockedScene(2), lockedScene(3)] })],
    ["the scenes' order", locked({ scenes: [lockedScene(2), lockedScene(1)] })],
    ["a scene's id", locked({ scenes: [lockedScene(1), lockedScene(2, { generationSceneId: "gscn_x" })] })],
    [
      "a first request's id",
      locked({
        scenes: [lockedScene(1), lockedScene(2, { requests: request("greq_x") })],
      }),
    ],
    ["a scene's length", locked({ scenes: [lockedScene(1), lockedScene(2, { durationSeconds: 15 })] })],
    ["a scene's camera motion", locked({ scenes: [lockedScene(1, { cameraMotion: null }), lockedScene(2)] })],
    ["a scene's compiled prompt", locked({ scenes: [lockedScene(1), lockedScene(2, { compiledPrompt: "other" })] })],
    ["a compiled prompt gone", locked({ scenes: [lockedScene(1), lockedScene(2, { compiledPrompt: null })] })],
  ];
  for (const [name, rows] of changed) {
    it(`refuses a change of ${name}`, () => {
      expect(decide(rows)).toEqual({ kind: "REFUSE", reason: "FACTS_CHANGED" });
    });
  }
});

describe("a plan made from other facts", () => {
  function defectOf(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof JobLaunchDefect ? error.code : "other";
    }
  }

  it("is a defect, before any row is judged", () => {
    const other = facts();
    const mismatched: Planned[] = [
      { ...plan(other), scenes: plan(other).scenes.slice(1) },
      { ...plan(other), scenes: plan(other).scenes.slice(0, 1) },
      { ...plan(other), scenes: [...plan(other).scenes, ...plan(other).scenes.slice(0, 1)] },
      { ...plan(other), scenes: [...plan(other).scenes].reverse() },
      { ...plan(other), scenes: plan(other).scenes.map((s, i) => (i === 1 ? { ...s, generationSceneId: "x" } : s)) },
      {
        ...plan(other),
        scenes: plan(other).scenes.map((s, i) => (i === 1 ? { ...s, generationSceneRequestId: "x" } : s)),
      },
      { ...plan(other), scenes: plan(other).scenes.map((s, i) => (i === 1 ? { ...s, compiledPrompt: "x" } : s)) },
    ];
    for (const wrong of mismatched) {
      expect(defectOf(() => assertPlanForFacts(other, wrong))).toBe("PLAN_NOT_FOR_FACTS");
      expect(defectOf(() => decideJobLaunch({ locked: locked({ jobState: "GENERATING" }), facts: other, plan: wrong })))
        .toBe("PLAN_NOT_FOR_FACTS");
    }
    expect(defectOf(() => assertPlanForFacts(other, plan(other)))).toBeNull();
  });
});

describe("the batch bound", () => {
  it("accepts 1 to the maximum and refuses anything else, unclamped", () => {
    expect(validateJobLaunchBatchLimit(1)).toBe(1);
    expect(validateJobLaunchBatchLimit(MAX_JOB_LAUNCH_BATCH_SIZE)).toBe(MAX_JOB_LAUNCH_BATCH_SIZE);
    for (const bad of [0, -1, 1.5, MAX_JOB_LAUNCH_BATCH_SIZE + 1, Number.NaN]) {
      expect(() => validateJobLaunchBatchLimit(bad)).toThrow(AppError);
    }
  });
});

describe("defects", () => {
  it("carry a fixed message and nothing from the rows", () => {
    const codes = [
      "PLAN_NOT_FOR_FACTS",
      "ATTEMPT_IDS_NOT_FOR_PLAN",
      "ADMISSION_REFUSED",
      "PLAN_NOT_IN_CATALOG",
    ] as const;
    for (const code of codes) {
      const defect = new JobLaunchDefect(code);
      expect(defect.code).toBe(code);
      expect(defect.name).toBe("JobLaunchDefect");
      expect(defect.message).toMatch(/^A job launch/);
    }
  });
});
