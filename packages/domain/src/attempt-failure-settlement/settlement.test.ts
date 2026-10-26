import { describe, expect, it } from "vitest";
import {
  AttemptFailureSettlementDefect,
  decideAttemptFailureSettlement,
  endedWithoutOutput,
  MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE,
  validateAttemptFailureSettlementBatchLimit,
  type AttemptFailureFacts,
} from "./settlement";
import {
  GENERATION_ATTEMPT_STATES,
  GENERATION_JOB_STATES,
  GENERATION_RESERVATION_STATES,
  GENERATION_SCENE_STATES,
  SCENE_GENERATION_REQUEST_STATES,
} from "../orchestration/types";

/**
 * How a scene whose attempts ended without output settles (ADR-0083), asserted
 * as literals.
 */

const INITIAL: AttemptFailureFacts = {
  requestKind: "INITIAL",
  requestState: "GENERATING",
  requestDelivered: false,
  attemptStates: ["FAILED_TERMINAL"],
  sceneState: "GENERATING",
  sceneDelivered: "NONE",
  jobState: "GENERATING",
  jobHoldsDeliverable: false,
  reservationState: "RESERVED",
  otherScenesNotReady: 2,
  otherOpenRegenerations: 0,
};

const REGENERATION: AttemptFailureFacts = {
  requestKind: "USER_REGENERATION",
  requestState: "GENERATING",
  requestDelivered: false,
  attemptStates: ["FAILED_TERMINAL"],
  sceneState: "REVISING",
  sceneDelivered: "DELIVERED_PREDECESSOR",
  jobState: "GENERATING",
  jobHoldsDeliverable: true,
  reservationState: "CONSUMED",
  otherScenesNotReady: 0,
  otherOpenRegenerations: 0,
};

const decide = decideAttemptFailureSettlement;

describe("which attempts ended without a video", () => {
  it("names exactly the four outputless terminal states", () => {
    expect(GENERATION_ATTEMPT_STATES.filter(endedWithoutOutput)).toEqual([
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "RECONCILIATION_EXHAUSTED",
      "CANCELLED_PRE_SUBMISSION",
    ]);
  });
});

describe("an initial generation", () => {
  it.each([["RESERVED"], ["RECONCILIATION_HOLD"]] as const)(
    "fails and releases its Unit from %s",
    (reservationState) => {
      expect(decide({ ...INITIAL, reservationState })).toEqual({
        kind: "FAIL_INITIAL",
        releaseFrom: reservationState,
      });
    },
  );

  it("fails without a release when reconciliation already released its Unit", () => {
    expect(decide({ ...INITIAL, reservationState: "RELEASED" })).toEqual({
      kind: "FAIL_INITIAL",
      releaseFrom: null,
    });
  });

  it.each([
    ["FAILED_RETRYABLE"],
    ["FAILED_TERMINAL"],
    ["RECONCILIATION_EXHAUSTED"],
    ["CANCELLED_PRE_SUBMISSION"],
  ] as const)("settles the same way whichever way the attempt ended: %s", (state) => {
    expect(decide({ ...INITIAL, attemptStates: [state] })).toEqual({
      kind: "FAIL_INITIAL",
      releaseFrom: "RESERVED",
    });
  });

  it("settles on a failed recovery after an earlier attempt produced a video", () => {
    expect(
      decide({ ...INITIAL, attemptStates: ["OUTPUT_VERIFIED", "FAILED_TERMINAL"] }),
    ).toEqual({ kind: "FAIL_INITIAL", releaseFrom: "RESERVED" });
  });

  it.each([[null], ["RESERVING"], ["CONSUMED"]] as const)(
    "refuses a job whose Unit is %s",
    (reservationState) => {
      expect(decide({ ...INITIAL, reservationState })).toEqual({
        kind: "NOT_SETTLEABLE",
        reason: "RESERVATION_NOT_SETTLEABLE",
      });
    },
  );

  it.each([
    ["a scene that is not generating", { sceneState: "READY" }],
    ["a scene that already delivered", { sceneDelivered: "DELIVERED_PREDECESSOR" }],
    ["a scene pointing elsewhere", { sceneDelivered: "OTHER" }],
    ["a job that already holds a video", { jobHoldsDeliverable: true }],
  ] as const)("refuses %s as a shape conflict", (_label, change) => {
    expect(decide({ ...INITIAL, ...change })).toEqual({
      kind: "NOT_SETTLEABLE",
      reason: "SHAPE_CONFLICT",
    });
  });
});

describe("a scene regeneration", () => {
  it("rolls back to the video the customer holds, whichever way it ended", () => {
    for (const state of GENERATION_ATTEMPT_STATES.filter(endedWithoutOutput)) {
      expect(decide({ ...REGENERATION, attemptStates: [state] })).toEqual({
        kind: "ROLL_BACK_REGENERATION",
      });
    }
  });

  it.each([[null], ["RESERVING"], ["RESERVED"], ["RECONCILIATION_HOLD"], ["RELEASED"]] as const)(
    "refuses a job whose Unit is %s, not consumed",
    (reservationState) => {
      expect(decide({ ...REGENERATION, reservationState })).toEqual({
        kind: "NOT_SETTLEABLE",
        reason: "RESERVATION_NOT_SETTLEABLE",
      });
    },
  );

  it.each([
    ["a scene that is not revising", { sceneState: "GENERATING" }],
    ["a scene with nothing delivered", { sceneDelivered: "NONE" }],
    ["a scene pointing elsewhere", { sceneDelivered: "OTHER" }],
    ["a job that holds no video", { jobHoldsDeliverable: false }],
    ["another scene not ready", { otherScenesNotReady: 1 }],
    ["another regeneration open", { otherOpenRegenerations: 1 }],
  ] as const)("refuses %s as a shape conflict", (_label, change) => {
    expect(decide({ ...REGENERATION, ...change })).toEqual({
      kind: "NOT_SETTLEABLE",
      reason: "SHAPE_CONFLICT",
    });
  });
});

describe("what is never settled", () => {
  it.each(SCENE_GENERATION_REQUEST_STATES.filter((s) => s !== "GENERATING").map((s) => [s]))(
    "a request that is %s",
    (requestState) => {
      for (const facts of [INITIAL, REGENERATION]) {
        expect(decide({ ...facts, requestState })).toEqual({
          kind: "NOT_SETTLEABLE",
          reason: "REQUEST_NOT_GENERATING",
        });
      }
    },
  );

  it("a request that delivered", () => {
    expect(decide({ ...INITIAL, requestDelivered: true })).toEqual({
      kind: "NOT_SETTLEABLE",
      reason: "REQUEST_NOT_GENERATING",
    });
  });

  it.each([
    ["no attempt at all", []],
    ["an attempt with no orchestration state", [null]],
    ["a newest attempt that produced a video", ["FAILED_TERMINAL", "OUTPUT_VERIFIED"]],
    ["an older attempt still open", ["PROCESSING", "FAILED_TERMINAL"]],
    ["an older attempt with no orchestration state", [null, "FAILED_TERMINAL"]],
    ...GENERATION_ATTEMPT_STATES.filter((s) => s !== "OUTPUT_VERIFIED" && !endedWithoutOutput(s)).map(
      (s) => [`a newest attempt still ${s}`, [s]] as const,
    ),
  ] as const)("a request with %s", (_label, attemptStates) => {
    expect(decide({ ...INITIAL, attemptStates: [...attemptStates] })).toEqual({
      kind: "NOT_SETTLEABLE",
      reason: "ATTEMPT_NOT_FAILED",
    });
  });

  it.each(GENERATION_JOB_STATES.filter((s) => s !== "GENERATING").map((s) => [s]))(
    "a job that is %s",
    (jobState) => {
      for (const facts of [INITIAL, REGENERATION]) {
        expect(decide({ ...facts, jobState })).toEqual({
          kind: "NOT_SETTLEABLE",
          reason: "JOB_NOT_GENERATING",
        });
      }
    },
  );

  it("never consumes a Unit, and settles exactly the expected rows of the whole table", () => {
    const settled: string[] = [];
    for (const requestKind of ["INITIAL", "USER_REGENERATION"] as const) {
      const base = requestKind === "INITIAL" ? INITIAL : REGENERATION;
      for (const reservationState of [...GENERATION_RESERVATION_STATES, null]) {
        for (const sceneState of GENERATION_SCENE_STATES) {
          for (const jobHoldsDeliverable of [false, true]) {
            const answer = decide({ ...base, reservationState, sceneState, jobHoldsDeliverable });
            if (answer.kind !== "NOT_SETTLEABLE") {
              settled.push(
                `${requestKind} ${reservationState} ${sceneState} ${jobHoldsDeliverable} ${JSON.stringify(answer)}`,
              );
            }
          }
        }
      }
    }
    expect(settled).toEqual([
      'INITIAL RESERVED GENERATING false {"kind":"FAIL_INITIAL","releaseFrom":"RESERVED"}',
      'INITIAL RECONCILIATION_HOLD GENERATING false {"kind":"FAIL_INITIAL","releaseFrom":"RECONCILIATION_HOLD"}',
      'INITIAL RELEASED GENERATING false {"kind":"FAIL_INITIAL","releaseFrom":null}',
      'USER_REGENERATION CONSUMED REVISING true {"kind":"ROLL_BACK_REGENERATION"}',
    ]);
  });
});

describe("the batch bound", () => {
  it.each([[1], [MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE]])("accepts %s", (value) => {
    expect(validateAttemptFailureSettlementBatchLimit(value)).toBe(value);
  });

  it.each([[0], [MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE + 1], [1.5], [Number.NaN], [Infinity]])(
    "refuses %s rather than clamping it",
    (value) => {
      expect(() => validateAttemptFailureSettlementBatchLimit(value)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    },
  );
});

describe("the defect", () => {
  it.each([
    [
      "SETTLEMENT_LOST_UNDER_LOCK",
      "A failed attempt's settlement write matched no row while holding that row's lock",
    ],
    ["STATE_OUTSIDE_VOCABULARY", "A failed attempt's settlement read a state outside the domain's"],
  ] as const)("carries %s with its fixed message", (code, message) => {
    const defect = new AttemptFailureSettlementDefect(code);
    expect(defect.code).toBe(code);
    expect(defect.message).toBe(message);
    expect(defect.name).toBe("AttemptFailureSettlementDefect");
  });
});
