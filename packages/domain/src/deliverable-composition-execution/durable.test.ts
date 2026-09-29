/**
 * The durable vocabulary: statuses, the two disjoint code lists, the canonical
 * deliverable key, and the bounds that refuse rather than clamp.
 *
 * The disjointness assertions are the point of the file. `lastRetryCode` means
 * "why this work is currently deferred for automatic retry" and `blockCode`
 * means "why it will never be retried"; a value that could legally appear in
 * both columns would make those two sentences the same sentence, and the
 * infinite-retry loop this phase exists to prevent would be one assignment away.
 */

import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  COMPOSITION_BLOCK_CODES,
  COMPOSITION_RETRY_CODES,
  COMPOSITION_STATUSES,
  DEFAULT_COMPOSITION_LEASE_MS,
  DEFAULT_COMPOSITION_RETRY_DELAY_MS,
  DELIVERABLE_OUTPUT_CONTENT_TYPE,
  MAX_COMPOSITION_BATCH_SIZE,
  MAX_COMPOSITION_LEASE_MS,
  MAX_COMPOSITION_RETRY_DELAY_MS,
  MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES,
  MAX_DELIVERABLE_OUTPUT_BYTES,
  isCompositionBlockCode,
  isCompositionRetryCode,
  managedDeliverableOutputKey,
  validateCompositionBatchLimit,
  validateCompositionLeaseMs,
  validateCompositionRetryDelayMs,
} from "./durable";

// ---------------------------------------------------------------------------

describe("the status vocabulary is closed and ordered by lifecycle", () => {
  it("is exactly the four durable statuses", () => {
    expect([...COMPOSITION_STATUSES]).toEqual(["PENDING", "RUNNING", "BLOCKED", "OUTPUT_VERIFIED"]);
  });

  it("has no terminal customer-failure state", () => {
    // Blocking ends this phase's automatic work, not the customer's job: a
    // FAILED here would destroy a video an earlier cycle may already have
    // delivered, and would settle an entitlement over the platform's own limit.
    for (const banned of ["FAILED", "FAILED_TERMINAL", "DEAD_LETTER", "CANCELLED"]) {
      expect(`${banned}: ${(COMPOSITION_STATUSES as readonly string[]).includes(banned)}`).toBe(
        `${banned}: false`,
      );
    }
  });
});

describe("retry codes and block codes are disjoint vocabularies", () => {
  it("names exactly the three transient classes", () => {
    expect([...COMPOSITION_RETRY_CODES]).toEqual([
      "SOURCE_READ_RETRYABLE",
      "COMPOSER_RETRYABLE",
      "OUTPUT_PUBLISH_RETRYABLE",
    ]);
  });

  it("names exactly the four deterministic refusals", () => {
    expect([...COMPOSITION_BLOCK_CODES]).toEqual([
      "SOURCE_BYTES_LIMIT_EXCEEDED",
      "DURATION_INVARIANT_MISMATCH",
      "SOURCE_INTEGRITY_MISMATCH",
      "OUTPUT_SIZE_LIMIT_EXCEEDED",
    ]);
  });

  it("shares no member between the two lists", () => {
    const retries = new Set<string>(COMPOSITION_RETRY_CODES);
    for (const code of COMPOSITION_BLOCK_CODES) {
      expect(`${code} is a retry code: ${retries.has(code)}`).toBe(`${code} is a retry code: false`);
    }
  });

  it("guards each list against the other's members and against anything else", () => {
    for (const code of COMPOSITION_RETRY_CODES) {
      expect(isCompositionRetryCode(code)).toBe(true);
      expect(isCompositionBlockCode(code)).toBe(false);
    }
    for (const code of COMPOSITION_BLOCK_CODES) {
      expect(isCompositionBlockCode(code)).toBe(true);
      expect(isCompositionRetryCode(code)).toBe(false);
    }
    for (const value of [null, undefined, 1, {}, [], "", "RETRY", "BLOCKED"]) {
      expect(isCompositionRetryCode(value)).toBe(false);
      expect(isCompositionBlockCode(value)).toBe(false);
    }
  });

  it("carries no provider text, path, bucket or free-form field in either list", () => {
    for (const code of [...COMPOSITION_RETRY_CODES, ...COMPOSITION_BLOCK_CODES]) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });
});

describe("the canonical deliverable key is built from two application ids", () => {
  it("has exactly the documented shape", () => {
    expect(
      managedDeliverableOutputKey({ organizationId: "org_1", deliverableVersionId: "gdv_9" }),
    ).toBe("org/org_1/deliverables/gdv_9/output");
  });

  it("is stable for one deliverable, so an interrupted publish retries over itself", () => {
    const first = managedDeliverableOutputKey({
      organizationId: "org_1",
      deliverableVersionId: "gdv_9",
    });
    const second = managedDeliverableOutputKey({
      organizationId: "org_1",
      deliverableVersionId: "gdv_9",
    });
    expect(first).toBe(second);
  });

  it("separates organizations even for the same version id", () => {
    expect(
      managedDeliverableOutputKey({ organizationId: "org_1", deliverableVersionId: "gdv_9" }),
    ).not.toBe(
      managedDeliverableOutputKey({ organizationId: "org_2", deliverableVersionId: "gdv_9" }),
    );
  });

  it("carries no extension, so it asserts nothing a validation has not established", () => {
    const key = managedDeliverableOutputKey({
      organizationId: "org_1",
      deliverableVersionId: "gdv_9",
    });
    expect(key.endsWith(".mp4")).toBe(false);
    expect(DELIVERABLE_OUTPUT_CONTENT_TYPE).toBe("video/mp4");
  });

  it("refuses a blank identifier rather than building a traversable key", () => {
    for (const input of [
      { organizationId: "", deliverableVersionId: "gdv_9" },
      { organizationId: "   ", deliverableVersionId: "gdv_9" },
      { organizationId: "org_1", deliverableVersionId: "" },
      { organizationId: "org_1", deliverableVersionId: "\t\n" },
    ]) {
      expect(() => managedDeliverableOutputKey(input)).toThrow(AppError);
    }
  });
});

describe("resource bounds are stated, not guessed", () => {
  it("bounds one composition's sources at 2 GiB and its output at 512 MiB", () => {
    expect(MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES).toBe(2 * 1_073_741_824);
    expect(MAX_DELIVERABLE_OUTPUT_BYTES).toBe(536_870_912);
  });

  it("keeps the default lease far longer than the composer may run", () => {
    expect(DEFAULT_COMPOSITION_LEASE_MS).toBe(30 * 60_000);
    expect(MAX_COMPOSITION_LEASE_MS).toBe(2 * 60 * 60_000);
    // The lease must outlast the composer, or a healthy long encode has its
    // lease stolen and two workers compose the same deliverable for no reason.
    // The domain cannot see the composer's own ceiling from here -- it lives in
    // the storage adapter -- so the relationship between the two constants is
    // pinned in that package's composer suite, where both are reachable.
    expect(DEFAULT_COMPOSITION_LEASE_MS).toBeLessThanOrEqual(MAX_COMPOSITION_LEASE_MS);
  });
});

describe("every bound refuses rather than clamps", () => {
  const BAD = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    -1,
    0,
    Number.MAX_SAFE_INTEGER,
    "30000",
    null,
    undefined,
    {},
  ];

  it("refuses an out-of-range lease", () => {
    expect(validateCompositionLeaseMs(DEFAULT_COMPOSITION_LEASE_MS)).toBe(
      DEFAULT_COMPOSITION_LEASE_MS,
    );
    for (const value of [...BAD, 59_999, MAX_COMPOSITION_LEASE_MS + 1]) {
      expect(() => validateCompositionLeaseMs(value)).toThrow(AppError);
    }
  });

  it("refuses an out-of-range retry delay", () => {
    expect(validateCompositionRetryDelayMs(DEFAULT_COMPOSITION_RETRY_DELAY_MS)).toBe(
      DEFAULT_COMPOSITION_RETRY_DELAY_MS,
    );
    for (const value of [...BAD, 999, MAX_COMPOSITION_RETRY_DELAY_MS + 1]) {
      expect(() => validateCompositionRetryDelayMs(value)).toThrow(AppError);
    }
  });

  it("refuses a batch limit a SQL LIMIT must never see, and never substitutes one", () => {
    expect(validateCompositionBatchLimit(1)).toBe(1);
    expect(validateCompositionBatchLimit(MAX_COMPOSITION_BATCH_SIZE)).toBe(
      MAX_COMPOSITION_BATCH_SIZE,
    );
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5_000]) {
      // Silently substituting 25 for 5000 would let a caller believe it swept
      // far more than it did.
      expect(() => validateCompositionBatchLimit(value)).toThrow(AppError);
    }
  });
});
