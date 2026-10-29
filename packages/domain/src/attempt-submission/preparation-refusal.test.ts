import { describe, expect, it } from "vitest";
import { endedWithoutOutput } from "../attempt-failure-settlement/settlement";
import {
  PREFLIGHT_REFUSAL_REASONS,
  preflightDispositionFor,
} from "../generation/execution-preflight-errors";
import { canTransitionAttempt } from "../orchestration/state-machines";
import {
  MAX_ATTEMPT_SUBMISSION_BATCH_SIZE,
  preparationRefusalEnding,
  validateAttemptSubmissionBatchLimit,
} from "./preparation-refusal";

describe("what a preparation refusal does to an orchestrated attempt", () => {
  it.each(PREFLIGHT_REFUSAL_REASONS)("follows the canonical disposition of %s", (reason) => {
    expect(preparationRefusalEnding(reason)).toBe(
      preflightDispositionFor(reason) === "TERMINAL" ? "CANCELLED_PRE_SUBMISSION" : null,
    );
  });

  it("ends an attempt whose photo is gone, and leaves one whose storage did not answer", () => {
    expect(preparationRefusalEnding("ASSET_NOT_FOUND")).toBe("CANCELLED_PRE_SUBMISSION");
    expect(preparationRefusalEnding("ASSET_UNRECOVERABLE")).toBe("CANCELLED_PRE_SUBMISSION");
    expect(preparationRefusalEnding("STORAGE_UNAVAILABLE")).toBeNull();
    expect(preparationRefusalEnding("ASSET_NOT_READY")).toBeNull();
  });

  it("ends it by a legal move into a state the attempt failure settlement settles", () => {
    // Transaction K fails the request, and releases the Unit, only once the
    // newest attempt has ended without a video (ADR-0083 Decision 2).
    expect(canTransitionAttempt("QUEUED", "CANCELLED_PRE_SUBMISSION")).toBe(true);
    expect(endedWithoutOutput("CANCELLED_PRE_SUBMISSION")).toBe(true);
  });
});

describe("the discovery's batch limit", () => {
  it.each([1, 7, MAX_ATTEMPT_SUBMISSION_BATCH_SIZE])("accepts %s", (limit) => {
    expect(validateAttemptSubmissionBatchLimit(limit)).toBe(limit);
  });

  it.each([0, -1, MAX_ATTEMPT_SUBMISSION_BATCH_SIZE + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s rather than clamping it",
    (limit) => {
      expect(() => validateAttemptSubmissionBatchLimit(limit)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    },
  );

  it("is one hundred, as the other sweeps' bound", () => {
    expect(MAX_ATTEMPT_SUBMISSION_BATCH_SIZE).toBe(100);
  });
});
