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
  validateAttemptSubmissionCursor,
} from "./preparation-refusal";

describe("what a preparation refusal does to an orchestrated attempt", () => {
  it("leaves exactly the reasons that may pass, and ends every other", () => {
    // Written out, so a disposition changed in the canonical table is noticed
    // here too: it changes whether a customer's job fails.
    const staying = [
      "ASSET_NOT_READY",
      "ASSET_UPLOAD_FAILED",
      "MODEL_UNAVAILABLE",
      "SIGNED_SOURCE_URL_UNUSABLE",
      "STORAGE_UNAVAILABLE",
    ];
    const left = PREFLIGHT_REFUSAL_REASONS.filter((reason) => preparationRefusalEnding(reason) === null);
    expect([...left].sort()).toEqual(staying);
    for (const reason of PREFLIGHT_REFUSAL_REASONS.filter((r) => !staying.includes(r))) {
      expect([reason, preparationRefusalEnding(reason)]).toEqual([reason, "CANCELLED_PRE_SUBMISSION"]);
      expect(preflightDispositionFor(reason)).toBe("TERMINAL");
    }
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

describe("discovery's cursor", () => {
  it("passes the start and a usable cursor through", () => {
    const cursor = { createdAt: new Date("2026-11-10T01:00:00.000Z"), id: "sg1" };
    expect(validateAttemptSubmissionCursor(null)).toBeNull();
    expect(validateAttemptSubmissionCursor(cursor)).toBe(cursor);
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["a string", "sg1"],
    ["a date given as text", { createdAt: "2026-11-10T01:00:00.000Z", id: "sg1" }],
    ["an invalid date", { createdAt: new Date(Number.NaN), id: "sg1" }],
    ["a blank id", { createdAt: new Date("2026-11-10T01:00:00.000Z"), id: "" }],
  ])("refuses %s from a caller the types do not reach", (_, value) => {
    expect(() => validateAttemptSubmissionCursor(value as null)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
