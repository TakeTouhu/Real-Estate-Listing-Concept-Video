import { describe, expect, it } from "vitest";
import {
  ATTEMPT_CANCELLED_PRE_SUBMISSION_EVENT_TYPE,
  FAILED_JOB_SCENE_CLOSURE_REASON_CODE,
  FailedJobSceneClosureDefect,
  MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE,
  SCENE_CANCELLED_EVENT_TYPE,
  SCENE_REQUEST_CANCELLED_EVENT_TYPE,
  decideFailedJobSceneClosure,
  validateFailedJobSceneClosureBatchLimit,
  type FailedJobSceneFacts,
  type FailedJobSceneRequestFacts,
} from "./closure";
import {
  canTransitionAttempt,
  canTransitionScene,
  canTransitionSceneRequest,
} from "../orchestration/state-machines";
import {
  GENERATION_ATTEMPT_STATES,
  GENERATION_JOB_STATES,
  GENERATION_SCENE_STATES,
  SCENE_GENERATION_REQUEST_STATES,
} from "../orchestration/types";

/**
 * How an open scene of a failed job closes (ADR-0084), asserted as literals.
 */

const NEVER_STARTED: FailedJobSceneFacts = {
  jobState: "FAILED_TERMINAL",
  sceneState: "PENDING",
  sceneNamesRendition: false,
  requests: [{ kind: "INITIAL", state: "PENDING", delivered: false, attemptStates: [] }],
};

const STARTED: FailedJobSceneFacts = {
  jobState: "FAILED_TERMINAL",
  sceneState: "GENERATING",
  sceneNamesRendition: false,
  requests: [{ kind: "INITIAL", state: "GENERATING", delivered: false, attemptStates: ["QUEUED"] }],
};

const decide = decideFailedJobSceneClosure;

function withRequest(
  facts: FailedJobSceneFacts,
  change: Partial<FailedJobSceneRequestFacts>,
): FailedJobSceneFacts {
  const [request] = facts.requests;
  if (request === undefined) throw new Error("no request to change");
  return { ...facts, requests: [{ ...request, ...change }] };
}

describe("a scene that never started", () => {
  it("is cancelled with its pending request", () => {
    expect(decide(NEVER_STARTED)).toEqual({
      kind: "CLOSE",
      sceneTo: "CANCELLED",
      request: "CANCEL",
      attemptsToCancel: 0,
    });
  });

  it("is cancelled alone when it has no request", () => {
    expect(decide({ ...NEVER_STARTED, requests: [] })).toEqual({
      kind: "CLOSE",
      sceneTo: "CANCELLED",
      request: "NONE",
      attemptsToCancel: 0,
    });
  });
});

describe("a scene that started", () => {
  it("fails, cancelling the attempt still waiting to be sent", () => {
    expect(decide(STARTED)).toEqual({
      kind: "CLOSE",
      sceneTo: "FAILED_TERMINAL",
      request: "FAIL",
      attemptsToCancel: 1,
    });
  });

  it("counts only the waiting attempt among ended ones", () => {
    expect(
      decide(withRequest(STARTED, { attemptStates: ["FAILED_RETRYABLE", "QUEUED"] })),
    ).toEqual({ kind: "CLOSE", sceneTo: "FAILED_TERMINAL", request: "FAIL", attemptsToCancel: 1 });
  });

  it.each([
    ["OUTPUT_VERIFIED"],
    ["FAILED_RETRYABLE"],
    ["FAILED_TERMINAL"],
    ["RECONCILIATION_EXHAUSTED"],
    ["CANCELLED_PRE_SUBMISSION"],
  ] as const)("fails with nothing to cancel once its attempt ended %s", (state) => {
    expect(decide(withRequest(STARTED, { attemptStates: [state] }))).toEqual({
      kind: "CLOSE",
      sceneTo: "FAILED_TERMINAL",
      request: "FAIL",
      attemptsToCancel: 0,
    });
  });

  it("fails when its request was admitted, though the scene was never recorded as started", () => {
    // Admission does not move the scene.
    expect(decide({ ...STARTED, sceneState: "PENDING" })).toEqual({
      kind: "CLOSE",
      sceneTo: "FAILED_TERMINAL",
      request: "FAIL",
      attemptsToCancel: 1,
    });
  });

  it("fails with its request cancelled when the request was never admitted", () => {
    expect(decide({ ...NEVER_STARTED, sceneState: "GENERATING" })).toEqual({
      kind: "CLOSE",
      sceneTo: "FAILED_TERMINAL",
      request: "CANCEL",
      attemptsToCancel: 0,
    });
  });

  it("fails alone when it has no request", () => {
    expect(decide({ ...STARTED, requests: [] })).toEqual({
      kind: "CLOSE",
      sceneTo: "FAILED_TERMINAL",
      request: "NONE",
      attemptsToCancel: 0,
    });
  });

  it.each([
    ["SUBMITTING"],
    ["PROCESSING"],
    ["RECONCILIATION_PENDING"],
    ["PROVIDER_SUCCEEDED"],
    ["OUTPUT_INGESTING"],
  ] as const)("waits while an attempt is %s", (state) => {
    expect(decide(withRequest(STARTED, { attemptStates: ["FAILED_RETRYABLE", state] }))).toEqual({
      kind: "NOT_CLOSABLE",
      reason: "ATTEMPT_IN_FLIGHT",
    });
  });
});

describe("what is never closed", () => {
  it.each(GENERATION_JOB_STATES.filter((s) => s !== "FAILED_TERMINAL").map((s) => [s]))(
    "a scene of a job that is %s",
    (jobState) => {
      // Refused first, whatever else the scene holds.
      expect(decide({ ...STARTED, jobState, sceneState: "READY", sceneNamesRendition: true })).toEqual({
        kind: "NOT_CLOSABLE",
        reason: "JOB_NOT_FAILED",
      });
    },
  );

  it.each([["READY"], ["REVISING"], ["FAILED_TERMINAL"], ["CANCELLED"]] as const)(
    "a scene that is %s",
    (sceneState) => {
      expect(decide({ ...STARTED, sceneState, sceneNamesRendition: true })).toEqual({
        kind: "NOT_CLOSABLE",
        reason: "SCENE_NOT_OPEN",
      });
    },
  );

  it("a scene whose pointer names a rendition", () => {
    expect(decide({ ...NEVER_STARTED, sceneNamesRendition: true })).toEqual({
      kind: "NOT_CLOSABLE",
      reason: "SHAPE_CONFLICT",
    });
  });

  it("a scene with more than one request", () => {
    const request: FailedJobSceneRequestFacts = {
      kind: "INITIAL",
      state: "PENDING",
      delivered: false,
      attemptStates: [],
    };
    expect(decide({ ...NEVER_STARTED, requests: [request, request] })).toEqual({
      kind: "NOT_CLOSABLE",
      reason: "SHAPE_CONFLICT",
    });
  });

  it.each([
    ["a regeneration request", { kind: "USER_REGENERATION" }],
    ["a delivered request", { delivered: true }],
    ["a pending request with an attempt", { attemptStates: ["FAILED_TERMINAL"] }],
  ] as const)("%s", (_label, change) => {
    expect(decide(withRequest(NEVER_STARTED, change))).toEqual({
      kind: "NOT_CLOSABLE",
      reason: "SHAPE_CONFLICT",
    });
  });

  it.each([["DELIVERED"], ["FAILED_TERMINAL"], ["CANCELLED"]] as const)(
    "a request that is already %s",
    (state) => {
      expect(decide(withRequest(STARTED, { state }))).toEqual({
        kind: "NOT_CLOSABLE",
        reason: "SHAPE_CONFLICT",
      });
    },
  );

  // The database's all-or-none check forbids such a row under a request; read
  // anyway, it is refused, and ahead of an attempt in flight.
  it("an attempt with no orchestration state, before an attempt in flight", () => {
    expect(decide(withRequest(STARTED, { attemptStates: [null, "PROCESSING"] }))).toEqual({
      kind: "NOT_CLOSABLE",
      reason: "SHAPE_CONFLICT",
    });
  });
});

describe("the whole table", () => {
  it("closes exactly these shapes, each along a legal edge", () => {
    const closed: string[] = [];
    const requestShapes: (FailedJobSceneRequestFacts | null)[] = [null];
    for (const state of SCENE_GENERATION_REQUEST_STATES) {
      requestShapes.push({ kind: "INITIAL", state, delivered: false, attemptStates: [] });
      for (const attempt of GENERATION_ATTEMPT_STATES) {
        requestShapes.push({ kind: "INITIAL", state, delivered: false, attemptStates: [attempt] });
      }
    }
    for (const sceneState of GENERATION_SCENE_STATES) {
      for (const shape of requestShapes) {
        const facts: FailedJobSceneFacts = {
          jobState: "FAILED_TERMINAL",
          sceneState,
          sceneNamesRendition: false,
          requests: shape === null ? [] : [shape],
        };
        const answer = decide(facts);
        if (answer.kind !== "CLOSE") continue;

        expect(canTransitionScene(sceneState, answer.sceneTo)).toBe(true);
        if (shape !== null && answer.request === "CANCEL") {
          expect(canTransitionSceneRequest(shape.state, "CANCELLED")).toBe(true);
        }
        if (shape !== null && answer.request === "FAIL") {
          expect(canTransitionSceneRequest(shape.state, "FAILED_TERMINAL")).toBe(true);
        }
        expect(canTransitionAttempt("QUEUED", "CANCELLED_PRE_SUBMISSION")).toBe(true);

        const attempts = shape === null ? "-" : shape.attemptStates.join(",") || "none";
        closed.push(
          `${sceneState} ${shape?.state ?? "-"} ${attempts} ${answer.sceneTo} ${answer.request} ${answer.attemptsToCancel}`,
        );
      }
    }
    expect(closed).toEqual([
      "PENDING - - CANCELLED NONE 0",
      "PENDING PENDING none CANCELLED CANCEL 0",
      "PENDING GENERATING none FAILED_TERMINAL FAIL 0",
      "PENDING GENERATING QUEUED FAILED_TERMINAL FAIL 1",
      "PENDING GENERATING OUTPUT_VERIFIED FAILED_TERMINAL FAIL 0",
      "PENDING GENERATING FAILED_RETRYABLE FAILED_TERMINAL FAIL 0",
      "PENDING GENERATING FAILED_TERMINAL FAILED_TERMINAL FAIL 0",
      "PENDING GENERATING RECONCILIATION_EXHAUSTED FAILED_TERMINAL FAIL 0",
      "PENDING GENERATING CANCELLED_PRE_SUBMISSION FAILED_TERMINAL FAIL 0",
      "GENERATING - - FAILED_TERMINAL NONE 0",
      "GENERATING PENDING none FAILED_TERMINAL CANCEL 0",
      "GENERATING GENERATING none FAILED_TERMINAL FAIL 0",
      "GENERATING GENERATING QUEUED FAILED_TERMINAL FAIL 1",
      "GENERATING GENERATING OUTPUT_VERIFIED FAILED_TERMINAL FAIL 0",
      "GENERATING GENERATING FAILED_RETRYABLE FAILED_TERMINAL FAIL 0",
      "GENERATING GENERATING FAILED_TERMINAL FAILED_TERMINAL FAIL 0",
      "GENERATING GENERATING RECONCILIATION_EXHAUSTED FAILED_TERMINAL FAIL 0",
      "GENERATING GENERATING CANCELLED_PRE_SUBMISSION FAILED_TERMINAL FAIL 0",
    ]);
  });
});

describe("the batch bound", () => {
  it.each([[1], [MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE]])("accepts %s", (value) => {
    expect(validateFailedJobSceneClosureBatchLimit(value)).toBe(value);
  });

  it.each([[0], [MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE + 1], [1.5], [Number.NaN], [Infinity]])(
    "refuses %s",
    (value) => {
      expect(() => validateFailedJobSceneClosureBatchLimit(value)).toThrow(
        "Failed job scene closure batch limit must be an integer between 1 and 100",
      );
    },
  );
});

describe("the vocabulary", () => {
  it("names its events and reason code", () => {
    expect([
      SCENE_CANCELLED_EVENT_TYPE,
      SCENE_REQUEST_CANCELLED_EVENT_TYPE,
      ATTEMPT_CANCELLED_PRE_SUBMISSION_EVENT_TYPE,
      FAILED_JOB_SCENE_CLOSURE_REASON_CODE,
    ]).toEqual([
      "scene.cancelled",
      "scene_request.cancelled",
      "attempt.cancelled_pre_submission",
      "FAILED_JOB_SCENE_CLOSURE",
    ]);
  });

  it.each([
    [
      "CLOSURE_LOST_UNDER_LOCK",
      "A failed job's scene closure write matched other rows than it holds locked",
    ],
    ["STATE_OUTSIDE_VOCABULARY", "A failed job's scene closure read a state outside the domain's"],
  ] as const)("carries %s with its fixed message", (code, message) => {
    const defect = new FailedJobSceneClosureDefect(code);
    expect(defect.code).toBe(code);
    expect(defect.message).toBe(message);
    expect(defect.name).toBe("FailedJobSceneClosureDefect");
  });
});
