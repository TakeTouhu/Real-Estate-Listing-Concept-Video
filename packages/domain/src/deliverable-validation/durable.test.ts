import { describe, expect, it } from "vitest";
import {
  DELIVERABLE_PUBLICATION_REASON_CODE,
  DELIVERABLE_PUBLISHED_EVENT_TYPE,
  DELIVERABLE_PUBLISHED_STATE,
  DELIVERABLE_VALIDATED_EVENT_TYPE,
  DELIVERABLE_VALIDATED_STATE,
  DELIVERABLE_VALIDATION_REASON_CODE,
  DELIVERABLE_VALIDATION_STATUSES,
  DeliverableValidationDefect,
  JOB_DELIVERABLE_READY_EVENT_TYPE,
  MAX_DELIVERABLE_VALIDATION_BATCH_SIZE,
  MAX_DELIVERABLE_VALIDATION_LEASE_MS,
  MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS,
  RESERVATION_CONSUMED_EVENT_TYPE,
  TERMINAL_DELIVERABLE_VALIDATION_STATUSES,
  isDeliverableContainerFamily,
  isDeliverableInvalidReason,
  isDeliverableValidationStatus,
  isTerminalDeliverableValidationStatus,
  validateDeliverableValidationBatchLimit,
  validateDeliverableValidationLeaseMs,
  validateDeliverableValidationRetryDelayMs,
  type DeliverableValidationDefectCode,
} from "./durable";

/**
 * The durable vocabulary, pinned.
 *
 * Every constant here ends up in a database column, an event stream or an
 * operator's console, so the test is about *what may be persisted* rather than
 * about the functions that happen to check it.
 */

describe("the status vocabulary is closed", () => {
  it("is exactly five members, in lifecycle order", () => {
    expect([...DELIVERABLE_VALIDATION_STATUSES]).toEqual([
      "PENDING",
      "RUNNING",
      "VALID",
      "INVALID_MEDIA",
      "INTEGRITY_MISMATCH",
    ]);
  });

  it("has no RETRYABLE_FAILURE member, and that is the point", () => {
    // A transient storage or inspector failure is not a verdict about the video;
    // it is the absence of one. Persisting it would make a hiccup a permanent
    // record that a customer's deliverable is unusable.
    expect(
      (DELIVERABLE_VALIDATION_STATUSES as readonly string[]).includes("RETRYABLE_FAILURE"),
    ).toBe(false);
    expect(isDeliverableValidationStatus("RETRYABLE_FAILURE")).toBe(false);
  });

  it("treats the three verdicts as terminal and the two working states as not", () => {
    expect([...TERMINAL_DELIVERABLE_VALIDATION_STATUSES]).toEqual([
      "VALID",
      "INVALID_MEDIA",
      "INTEGRITY_MISMATCH",
    ]);
    for (const status of DELIVERABLE_VALIDATION_STATUSES) {
      expect(`${status}: ${isTerminalDeliverableValidationStatus(status)}`).toBe(
        `${status}: ${status !== "PENDING" && status !== "RUNNING"}`,
      );
    }
  });

  it("refuses everything that is not a member, including hostile shapes", () => {
    for (const value of [
      "",
      "valid",
      "PENDING ",
      "toString",
      "constructor",
      null,
      undefined,
      0,
      {},
      ["VALID"],
    ]) {
      expect(isDeliverableValidationStatus(value)).toBe(false);
      expect(isTerminalDeliverableValidationStatus(value)).toBe(false);
    }
  });
});

describe("the media vocabulary is the provider-attempt one, reused verbatim", () => {
  it("accepts exactly the five closed invalid reasons", () => {
    for (const reason of [
      "CONTAINER_UNSUPPORTED",
      "VIDEO_STREAM_MISSING",
      "VIDEO_DIMENSIONS_INVALID",
      "DURATION_INVALID",
      "PROBE_REJECTED",
    ]) {
      expect(`${reason}: ${isDeliverableInvalidReason(reason)}`).toBe(`${reason}: true`);
    }
    for (const value of ["INTEGRITY_MISMATCH", "probe_rejected", "", null, {}, "toString"]) {
      expect(isDeliverableInvalidReason(value)).toBe(false);
    }
  });

  it("accepts exactly one container family", () => {
    expect(isDeliverableContainerFamily("ISO_BMFF")).toBe(true);
    for (const value of ["MP4", "iso_bmff", "", null, undefined, {}]) {
      expect(isDeliverableContainerFamily(value)).toBe(false);
    }
  });
});

describe("the bounds refuse rather than clamp", () => {
  it("admits a usable lease and refuses anything outside the range", () => {
    expect(validateDeliverableValidationLeaseMs(60_000)).toBe(60_000);
    expect(validateDeliverableValidationLeaseMs(MAX_DELIVERABLE_VALIDATION_LEASE_MS)).toBe(
      MAX_DELIVERABLE_VALIDATION_LEASE_MS,
    );
    for (const value of [
      59_999,
      0,
      -1,
      MAX_DELIVERABLE_VALIDATION_LEASE_MS + 1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      "600000",
      null,
      undefined,
    ]) {
      expect(() => validateDeliverableValidationLeaseMs(value)).toThrow(
        /Deliverable validation lease/,
      );
    }
  });

  it("admits a usable retry delay and refuses anything outside the range", () => {
    expect(validateDeliverableValidationRetryDelayMs(1_000)).toBe(1_000);
    expect(
      validateDeliverableValidationRetryDelayMs(MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS),
    ).toBe(MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS);
    for (const value of [
      999,
      0,
      -1,
      MAX_DELIVERABLE_VALIDATION_RETRY_DELAY_MS + 1,
      2.5,
      Number.NaN,
      "1000",
      null,
    ]) {
      expect(() => validateDeliverableValidationRetryDelayMs(value)).toThrow(
        /Deliverable validation retry delay/,
      );
    }
  });

  it("refuses a batch limit rather than silently substituting the maximum", () => {
    // Clamping lets a caller believe it swept far more than it did.
    expect(validateDeliverableValidationBatchLimit(1)).toBe(1);
    expect(validateDeliverableValidationBatchLimit(MAX_DELIVERABLE_VALIDATION_BATCH_SIZE)).toBe(
      MAX_DELIVERABLE_VALIDATION_BATCH_SIZE,
    );
    for (const value of [
      0,
      -1,
      MAX_DELIVERABLE_VALIDATION_BATCH_SIZE + 1,
      5_000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() => validateDeliverableValidationBatchLimit(value)).toThrow(/between 1 and 25/);
    }
  });
});

describe("defects say what is wrong and disclose nothing", () => {
  const CODES: readonly DeliverableValidationDefectCode[] = [
    "COMPOSITION_NOT_VERIFIED",
    "COMPOSITION_RECEIPT_INCOMPLETE",
    "VALIDATION_RECEIPT_CONFLICT",
    "VALIDATION_VERDICT_CONFLICT",
    "PARTIAL_PUBLICATION_STATE",
    "FOREIGN_DELIVERABLE_VERSION",
    "RESERVATION_NOT_CONSUMABLE",
    "VALIDATOR_RESULT_MALFORMED",
    "VALIDATOR_FAILED",
    "PERSISTED_RECORD_MALFORMED",
  ];

  it("carries a fixed message, a code and no cause", () => {
    for (const code of CODES) {
      const defect = new DeliverableValidationDefect(code);
      expect(defect.code).toBe(code);
      expect(defect.name).toBe("DeliverableValidationDefect");
      expect(defect.message.length).toBeGreaterThan(0);
      // No `cause`: a storage error, an inspector's stderr and a Prisma
      // exception are all external data, and the default rendering of a thrown
      // value is where such content escapes without anyone choosing to log it.
      expect("cause" in defect && defect.cause !== undefined).toBe(false);
    }
  });

  it("names no identifier, key, bucket or path in any message", () => {
    for (const code of CODES) {
      const message = new DeliverableValidationDefect(code).message;
      for (const banned of ["org/", "s3://", "http", "/tmp", "gdv_", "genjob_", "sha256:"]) {
        expect(`${code}:${banned}: ${message.includes(banned)}`).toBe(`${code}:${banned}: false`);
      }
    }
  });
});

describe("the event vocabulary is application-owned and fixed", () => {
  it("names each transition exactly once", () => {
    expect(DELIVERABLE_VALIDATED_EVENT_TYPE).toBe("deliverable.validated");
    expect(DELIVERABLE_PUBLISHED_EVENT_TYPE).toBe("deliverable.published");
    expect(JOB_DELIVERABLE_READY_EVENT_TYPE).toBe("job.deliverable_ready");
    expect(RESERVATION_CONSUMED_EVENT_TYPE).toBe("reservation.consumed");
    expect(DELIVERABLE_VALIDATION_REASON_CODE).toBe("DELIVERABLE_VALIDATION");
    expect(DELIVERABLE_PUBLICATION_REASON_CODE).toBe("DELIVERABLE_PUBLICATION");
  });

  it("continues the deliverable aggregate's own past-participle vocabulary", () => {
    // PLANNED -> COMPOSING -> OUTPUT_VERIFIED -> VALIDATED -> PUBLISHED. One
    // reader, one vocabulary.
    expect(DELIVERABLE_VALIDATED_STATE).toBe("VALIDATED");
    expect(DELIVERABLE_PUBLISHED_STATE).toBe("PUBLISHED");
  });

  it("invents no state for a verdict that is not VALID", () => {
    // A terminal non-VALID verdict appends no event at all, so there is nothing
    // here to name it with. A `DELIVERABLE_INVALID` constant appearing in this
    // module would mean the event stream had grown a customer-visible failure
    // state that no reviewed state machine contains.
    const vocabulary = [DELIVERABLE_VALIDATED_STATE, DELIVERABLE_PUBLISHED_STATE];
    for (const banned of ["INVALID", "INVALID_MEDIA", "FAILED", "INTEGRITY_MISMATCH"]) {
      expect(`${banned}: ${vocabulary.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
