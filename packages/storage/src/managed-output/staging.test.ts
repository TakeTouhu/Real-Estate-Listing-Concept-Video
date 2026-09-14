import { describe, expect, it } from "vitest";
import { safePositiveByteCount, sha256Digest } from "@app/domain";
import {
  EXISTING_COMMIT_KEYS,
  isWellFormedStagingCommitOutcome,
  parseStagingCommitOutcome,
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

  it.each([
    ["a throwing kind getter", { get kind(): never { throw new Error("GETTER-SECRET"); } }],
    [
      "a throwing receipt getter on EXISTING",
      { kind: "EXISTING", get receipt(): never { throw new Error("GETTER-SECRET"); } },
    ],
  ])("answers false, rather than throwing, for %s", (_label, hostile) => {
    // A predicate is total. A getter that throws is a value outside the
    // contract, and the caller's fixed defect must be what escapes — never the
    // getter's own error.
    expect(() => isWellFormedStagingCommitOutcome(hostile)).not.toThrow();
    expect(isWellFormedStagingCommitOutcome(hostile)).toBe(false);
  });

  it("answers false, rather than throwing, for a revoked Proxy", () => {
    // Hostile before `kind` is ever read: the shared record check's
    // `Array.isArray` is the first thing that can throw, and it sits ahead of
    // this parser's guard. Totality has to start there.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => isWellFormedStagingCommitOutcome(proxy)).not.toThrow();
    expect(isWellFormedStagingCommitOutcome(proxy)).toBe(false);
  });
});

describe("parseStagingCommitOutcome", () => {
  it("returns null, rather than throwing, for a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => parseStagingCommitOutcome(proxy)).not.toThrow();
    expect(parseStagingCommitOutcome(proxy)).toBeNull();
  });

  it("materializes each arm as a fresh plain object with exactly its own keys", () => {
    const published = parseStagingCommitOutcome({ kind: "PUBLISHED" });
    const existing = parseStagingCommitOutcome({ kind: "EXISTING", receipt: RECEIPT });
    const retry = parseStagingCommitOutcome({ kind: "RETRYABLE_FAILURE" });
    expect(published).toEqual({ kind: "PUBLISHED" });
    expect(existing).toEqual({ kind: "EXISTING", receipt: RECEIPT });
    expect(retry).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(Object.getOwnPropertyNames(published)).toEqual(["kind"]);
    expect(Object.getOwnPropertyNames(existing)).toEqual(["kind", "receipt"]);
  });

  it("carries the EXISTING receipt reference through untouched", () => {
    const receipt = { anything: "at all" };
    const parsed = parseStagingCommitOutcome({ kind: "EXISTING", receipt });
    expect(parsed?.kind).toBe("EXISTING");
    expect((parsed as { receipt: unknown }).receipt).toBe(receipt);
  });

  it("returns a value that does not alias the input", () => {
    const input = { kind: "PUBLISHED" };
    expect(parseStagingCommitOutcome(input)).not.toBe(input);
  });

  it("reads kind exactly once, so a getter that answers once and then throws cannot pass and later explode", () => {
    let reads = 0;
    const stateful = {
      get kind(): string {
        reads += 1;
        if (reads > 1) throw new Error("GETTER-SECRET-ON-SECOND-READ");
        return "PUBLISHED";
      },
    };
    const parsed = parseStagingCommitOutcome(stateful);
    expect(parsed).toEqual({ kind: "PUBLISHED" });
    expect(reads).toBe(1);
    // The materialized object's own `kind` is a plain data property; reading
    // it again touches the hostile getter zero more times.
    expect(parsed?.kind).toBe("PUBLISHED");
    expect(reads).toBe(1);
  });

  it.each([
    ["a throwing kind getter", { get kind(): never { throw new Error("x"); } }],
    ["a throwing receipt getter", { kind: "EXISTING", get receipt(): never { throw new Error("x"); } }],
    ["null", null],
    ["an unknown kind", { kind: "OK" }],
    ["PUBLISHED with an extra key", { kind: "PUBLISHED", url: "s3://x" }],
  ])("returns null for %s", (_label, value) => {
    expect(() => parseStagingCommitOutcome(value)).not.toThrow();
    expect(parseStagingCommitOutcome(value)).toBeNull();
  });
});
