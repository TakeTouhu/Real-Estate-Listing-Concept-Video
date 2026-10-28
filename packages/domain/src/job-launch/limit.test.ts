import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { GENERATION_JOB_STATES, type GenerationJobState } from "../orchestration/types";
import {
  JOB_STATES_HOLDING_A_PLACE,
  JOB_STATE_WAITING_FOR_A_PLACE,
  decideJobLaunchCapacity,
  holdsAPlace,
} from "./limit";

/**
 * The concurrent-job limit (ADR-0094): which jobs hold a place, and whether a
 * waiting job may take one. Every job state is classified on purpose: a state
 * added later must be placed here before it can be counted wrongly.
 */

const HOLDING: readonly GenerationJobState[] = [
  "GENERATING",
  "SCENES_READY",
  "COMPOSITION_PENDING",
  "COMPOSING",
  "DELIVERABLE_VALIDATING",
  "REVISING",
];
const NOT_STARTED: readonly GenerationJobState[] = ["CREATED", "RESERVING"];
const ENDED: readonly GenerationJobState[] = ["DELIVERABLE_READY", "FAILED_TERMINAL", "CANCELLED"];

describe("which jobs hold one of their organization's places", () => {
  it("classifies every job state exactly once", () => {
    const classified = [...HOLDING, JOB_STATE_WAITING_FOR_A_PLACE, ...NOT_STARTED, ...ENDED];
    expect([...classified].sort()).toEqual([...GENERATION_JOB_STATES].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("counts a launched job until it ends, composition and the final check included", () => {
    expect([...JOB_STATES_HOLDING_A_PLACE].sort()).toEqual([...HOLDING].sort());
    for (const state of HOLDING) expect([state, holdsAPlace(state)]).toEqual([state, true]);
  });

  it("does not count a waiting job, one not yet started, or one that ended", () => {
    expect(JOB_STATE_WAITING_FOR_A_PLACE).toBe("RESERVED");
    for (const state of [JOB_STATE_WAITING_FOR_A_PLACE, ...NOT_STARTED, ...ENDED]) {
      expect([state, holdsAPlace(state)]).toEqual([state, false]);
    }
  });

  it("cannot be changed by a caller", () => {
    expect(Object.isFrozen(JOB_STATES_HOLDING_A_PLACE)).toBe(true);
  });
});

describe("whether one more job may launch", () => {
  it.each([
    [1, 0, "PLACE_FREE"],
    [1, 1, "AT_LIMIT"],
    [3, 2, "PLACE_FREE"],
    [3, 3, "AT_LIMIT"],
    [5, 4, "PLACE_FREE"],
    [5, 5, "AT_LIMIT"],
    // More running than the limit allows, after a downgrade, still launches nothing.
    [1, 3, "AT_LIMIT"],
  ] as const)("a limit of %i with %i running: %s", (concurrentJobs, jobsHoldingAPlace, kind) => {
    expect(decideJobLaunchCapacity({ concurrentJobs, jobsHoldingAPlace })).toEqual({ kind });
  });

  it.each([
    [0, 0],
    [-1, 0],
    [1.5, 0],
    [Number.NaN, 0],
    [1, -1],
    [1, 0.5],
    [1, Number.POSITIVE_INFINITY],
  ])("refuses a limit of %s or a count of %s as a defect", (concurrentJobs, jobsHoldingAPlace) => {
    expect(() => decideJobLaunchCapacity({ concurrentJobs, jobsHoldingAPlace })).toThrow(AppError);
  });
});
