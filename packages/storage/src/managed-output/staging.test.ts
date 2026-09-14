import { describe, expect, it } from "vitest";
import { safePositiveByteCount, sha256Digest } from "@app/domain";
import {
  EXISTING_COMMIT_KEYS,
  isWellFormedStagingCommitOutcome,
  PUBLISHED_COMMIT_KEYS,
  RETRYABLE_FAILURE_COMMIT_KEYS,
} from "./staging";

const RECEIPT = { sha256: sha256Digest("a".repeat(64)), sizeBytes: safePositiveByteCount(1) };

describe("isWellFormedStagingCommitOutcome", () => {
  it("accepts PUBLISHED with exactly its discriminant", () => {
    expect(isWellFormedStagingCommitOutcome({ kind: "PUBLISHED" })).toBe(true);
    expect(PUBLISHED_COMMIT_KEYS).toEqual(["kind"]);
  });

  it("accepts EXISTING with exactly a discriminant and a receipt", () => {
    expect(isWellFormedStagingCommitOutcome({ kind: "EXISTING", receipt: RECEIPT })).toBe(true);
    expect(EXISTING_COMMIT_KEYS).toEqual(["kind", "receipt"]);
  });

  it("does not inspect the EXISTING receipt's contents", () => {
    // Presence is this boundary's rule; validity is Phase 2H-1's. A receipt
    // that is plainly wrong still travels, and finalization refuses it there.
    expect(isWellFormedStagingCommitOutcome({ kind: "EXISTING", receipt: "nonsense" })).toBe(true);
    expect(isWellFormedStagingCommitOutcome({ kind: "EXISTING", receipt: null })).toBe(true);
  });

  it("accepts RETRYABLE_FAILURE with exactly its discriminant", () => {
    expect(isWellFormedStagingCommitOutcome({ kind: "RETRYABLE_FAILURE" })).toBe(true);
    expect(RETRYABLE_FAILURE_COMMIT_KEYS).toEqual(["kind"]);
  });

  it.each([
    ["PUBLISHED with a receipt", { kind: "PUBLISHED", receipt: RECEIPT }],
    ["PUBLISHED with a URL", { kind: "PUBLISHED", url: "s3://bucket/key" }],
    ["PUBLISHED with an etag", { kind: "PUBLISHED", etag: "abc" }],
    ["EXISTING without a receipt", { kind: "EXISTING" }],
    ["EXISTING with a URL alongside", { kind: "EXISTING", receipt: RECEIPT, url: "s3://x" }],
    ["EXISTING with a storage key alongside", { kind: "EXISTING", receipt: RECEIPT, key: "k" }],
    ["RETRYABLE_FAILURE with a message", { kind: "RETRYABLE_FAILURE", message: "slow down" }],
    ["RETRYABLE_FAILURE with a diagnostic", { kind: "RETRYABLE_FAILURE", code: "THROTTLED" }],
    ["RETRYABLE_FAILURE with a retry-after", { kind: "RETRYABLE_FAILURE", retryAfterMs: 500 }],
    ["an unknown kind", { kind: "TERMINAL_FAILURE" }],
    ["an unknown kind that looks harmless", { kind: "OK" }],
    ["a missing kind", { receipt: RECEIPT }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedStagingCommitOutcome(value)).toBe(false);
  });

  it.each([null, undefined, "PUBLISHED", 200, true, [], [{ kind: "PUBLISHED" }]])(
    "refuses the non-record %o",
    (value) => {
      expect(isWellFormedStagingCommitOutcome(value)).toBe(false);
    },
  );

  it("counts non-enumerable smuggled fields as extra keys", () => {
    const value = { kind: "PUBLISHED" };
    Object.defineProperty(value, "url", { value: "s3://x", enumerable: false });
    expect(isWellFormedStagingCommitOutcome(value)).toBe(false);
  });
});
