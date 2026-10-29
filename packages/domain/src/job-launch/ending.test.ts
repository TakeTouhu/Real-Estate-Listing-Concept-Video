import { describe, expect, it } from "vitest";
import { PRESERVATION_RULES, SYSTEM_NEGATIVE_CONSTRAINTS, type CompiledPrompt } from "../storyboard/index";
import { decideUnlaunchableJobEnding } from "./ending";
import type { JobLaunchLockedRows, JobLaunchLockedScene } from "./launch";
import { checkFrozenFacts, isFrozenFactsCode } from "./planner";
import type { JobLaunchNoPlanCode } from "./ports";

/**
 * The ending's decision (GS-7d-1, ADR-0099): a waiting job ends, its Units
 * released, only for what its own locked rows say, and never while its hold
 * is anything but `RESERVED` or one of its requests has an attempt.
 */

function compiled(n: number): string {
  const prompt: CompiledPrompt = {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: { assetId: `ast_${n}`, position: n, roomType: "LIVING_ROOM", durationSeconds: 5, cameraMotion: null },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  };
  return JSON.stringify(prompt);
}

type LockedRequest = JobLaunchLockedScene["requests"][number];

function scene(n: number, overrides: Partial<JobLaunchLockedScene> = {}): JobLaunchLockedScene {
  return {
    generationSceneId: `gscn_${n}`,
    state: "PENDING",
    durationSeconds: 5,
    cameraMotion: null,
    compiledPrompt: compiled(n),
    requests: [{ id: `greq_${n}`, kind: "INITIAL", state: "PENDING", attempts: 0 }],
    ...overrides,
  };
}

function request(overrides: Partial<LockedRequest>): LockedRequest[] {
  return [{ id: "greq_x", kind: "INITIAL", state: "PENDING", attempts: 0, ...overrides }];
}

function locked(overrides: Partial<JobLaunchLockedRows> = {}): JobLaunchLockedRows {
  return {
    jobState: "RESERVED",
    reservationState: "RESERVED",
    propertyDeleted: false,
    qualityTier: "NORMAL",
    targetOutputResolution: "720p",
    aspectRatio: "16:9",
    scenes: [scene(1), scene(2)],
    ...overrides,
  };
}

const ends = (cause: string) => ({ kind: "END", cause });
const keeps = (reason: string) => ({ kind: "KEEP", reason });

describe("a waiting job exactly as the start wrote it", () => {
  it("is kept: nothing in its rows stops it launching", () => {
    expect(decideUnlaunchableJobEnding(locked())).toEqual(keeps("LAUNCHABLE"));
  });
});

describe("a job that can never launch", () => {
  it("ends when its Property is deleted", () => {
    expect(decideUnlaunchableJobEnding(locked({ propertyDeleted: true }))).toEqual(ends("PROPERTY_DELETED"));
  });

  it("ends for a frozen fact, by the planner's own check", () => {
    expect(decideUnlaunchableJobEnding(locked({ targetOutputResolution: "4k" }))).toEqual(
      ends("TARGET_RESOLUTION_UNKNOWN"),
    );
    expect(decideUnlaunchableJobEnding(locked({ scenes: [] }))).toEqual(ends("NO_SCENES"));
    expect(decideUnlaunchableJobEnding(locked({ scenes: [scene(1), scene(2, { compiledPrompt: null })] }))).toEqual(
      ends("SCENE_PROMPT_MISSING"),
    );
    expect(
      decideUnlaunchableJobEnding(locked({ scenes: [scene(1, { compiledPrompt: "{not a prompt" }), scene(2)] })),
    ).toEqual(ends("SCENE_PROMPT_UNRENDERABLE"));
  });

  it.each([
    ["a scene already started", scene(2, { state: "GENERATING" })],
    ["a scene with no request", scene(2, { requests: [] })],
    ["a scene with a second request", scene(2, { requests: [...request({ id: "a" }), ...request({ id: "b" })] })],
    ["a request that is not the first", scene(2, { requests: request({ kind: "USER_REGENERATION" }) })],
    ["a request no longer pending", scene(2, { requests: request({ state: "CANCELLED" }) })],
  ])("ends as SHAPE_CONFLICT for %s", (_, odd) => {
    expect(decideUnlaunchableJobEnding(locked({ scenes: [scene(1), odd] }))).toEqual(ends("SHAPE_CONFLICT"));
  });

  it("names the deleted Property first, then a frozen fact, then the shape", () => {
    const broken = [scene(1, { compiledPrompt: null, state: "GENERATING" })];
    expect(decideUnlaunchableJobEnding(locked({ propertyDeleted: true, scenes: broken }))).toEqual(
      ends("PROPERTY_DELETED"),
    );
    expect(decideUnlaunchableJobEnding(locked({ scenes: broken }))).toEqual(ends("SCENE_PROMPT_MISSING"));
  });
});

describe("a job that is not ended", () => {
  it.each(["CREATED", "RESERVING", "GENERATING", "FAILED_TERMINAL", "CANCELLED"])(
    "is not waiting from %s, whatever else is true of it",
    (jobState) => {
      expect(decideUnlaunchableJobEnding(locked({ jobState, propertyDeleted: true }))).toEqual(keeps("NOT_WAITING"));
    },
  );

  it.each([null, "RESERVING", "RECONCILIATION_HOLD", "CONSUMED", "RELEASED"])(
    "has no hold to release when its reservation is %s",
    (reservationState) => {
      expect(decideUnlaunchableJobEnding(locked({ reservationState, propertyDeleted: true }))).toEqual(
        keeps("RESERVATION_NOT_HELD"),
      );
    },
  );

  it("has had an attempt admitted under any of its requests, deleted Property or not", () => {
    const attempted = scene(2, { state: "GENERATING", requests: request({ state: "GENERATING", attempts: 1 }) });
    for (const propertyDeleted of [false, true]) {
      expect(decideUnlaunchableJobEnding(locked({ propertyDeleted, scenes: [scene(1), attempted] }))).toEqual(
        keeps("ATTEMPT_ADMITTED"),
      );
    }
    // Even a request that is not the scene's only one.
    const second = scene(1, { requests: [...request({ id: "a" }), ...request({ id: "b", attempts: 2 })] });
    expect(decideUnlaunchableJobEnding(locked({ scenes: [second] }))).toEqual(keeps("ATTEMPT_ADMITTED"));
  });

  it("answers the job's state before its reservation, and the reservation before any attempt", () => {
    const attempted = scene(1, { requests: request({ attempts: 1 }) });
    expect(decideUnlaunchableJobEnding(locked({ jobState: "GENERATING", reservationState: null }))).toEqual(
      keeps("NOT_WAITING"),
    );
    expect(decideUnlaunchableJobEnding(locked({ reservationState: "RELEASED", scenes: [attempted] }))).toEqual(
      keeps("RESERVATION_NOT_HELD"),
    );
  });
});

describe("the frozen facts", () => {
  it("are the codes the planner refuses before any catalog, and no other", () => {
    const all: JobLaunchNoPlanCode[] = [
      "TARGET_RESOLUTION_UNKNOWN",
      "NO_SCENES",
      "SCENE_PROMPT_MISSING",
      "SCENE_PROMPT_UNRENDERABLE",
      "NO_ROUTE",
      "AMBIGUOUS_ROUTE",
      "NO_CURRENT_PRICING",
      "AMBIGUOUS_CURRENT_PRICING",
      "NO_FX_RATE",
    ];
    expect(all.filter(isFrozenFactsCode)).toEqual([
      "TARGET_RESOLUTION_UNKNOWN",
      "NO_SCENES",
      "SCENE_PROMPT_MISSING",
      "SCENE_PROMPT_UNRENDERABLE",
    ]);
  });

  it("render each scene's prompt once, in order, when they pass", () => {
    const check = checkFrozenFacts({ targetOutputResolution: "1080p", scenes: [scene(1), scene(2)] });
    expect(check.ok && check.target).toBe("1080p");
    expect(check.ok && check.prompts.map((prompt) => prompt.compiled)).toEqual([compiled(1), compiled(2)]);
  });
});
