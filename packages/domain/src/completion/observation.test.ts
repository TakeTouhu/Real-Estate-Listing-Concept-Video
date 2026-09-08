import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBMISSION_DIAGNOSTIC_CODES } from "../submission/diagnostic-code";
import {
  isWellFormedCompletionObservation,
  type ProviderCompletionObservation,
} from "./observation";

/**
 * What a caller may tell this phase about a provider job it already accepted.
 *
 * Two arms, and the missing third is the design: there is no "still running"
 * arm, because the row already says `PROCESSING` and re-recording that would be
 * a write that changes nothing while claiming progress.
 */

describe("the shape of admissible completion evidence", () => {
  it("accepts a bare success", () => {
    expect(isWellFormedCompletionObservation({ kind: "SUCCEEDED" })).toBe(true);
  });

  it("accepts both failure shapes", () => {
    for (const retryable of [true, false]) {
      expect(
        isWellFormedCompletionObservation({ kind: "FAILED", retryable, diagnosticCode: null }),
      ).toBe(true);
    }
  });

  it.each(SUBMISSION_DIAGNOSTIC_CODES)("accepts the catalog member %s", (code) => {
    expect(
      isWellFormedCompletionObservation({
        kind: "FAILED",
        retryable: true,
        diagnosticCode: code,
      }),
    ).toBe(true);
  });

  it("reuses the Phase 2G-1 vocabulary without expanding it", () => {
    // Two catalogs for one concept would force an operator to know which phase
    // wrote each row.
    expect([...SUBMISSION_DIAGNOSTIC_CODES].sort()).toEqual([
      "CONNECTION_RESET",
      "LOCAL_CONFIGURATION",
      "TIMEOUT",
    ]);
  });
});

describe("the validator treats its input as unknown, because it is", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "SUCCEEDED"],
    ["a boolean", true],
    ["an array", []],
    ["an array carrying a valid arm's properties", Object.assign([], { kind: "SUCCEEDED" })],
    ["an empty object", {}],
    ["an object with no kind", { retryable: true }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedCompletionObservation(value)).toBe(false);
  });

  it.each([
    ["UNKNOWN", { kind: "UNKNOWN" }],
    ["a submission arm", { kind: "ACCEPTED", providerPredictionId: "p" }],
    ["another submission arm", { kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: null }],
    ["a lowercase success", { kind: "succeeded" }],
    ["a numeric kind", { kind: 1 }],
    ["a null kind", { kind: null }],
    // The dangerous shape: an unrecognised arm whose body would pass the
    // failure validation. Sweeping it into that branch would move a paid,
    // accepted attempt to a terminal state on a value nobody defined.
    ["a well-formed body under an unknown kind", { kind: "UNKNOWN", retryable: true, diagnosticCode: null }],
  ])("refuses the unrecognised discriminant %s rather than assuming failure", (_l, value) => {
    expect(isWellFormedCompletionObservation(value)).toBe(false);
  });

  it.each([
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array", []],
  ])("refuses a retryable flag that is %s", (_label, retryable) => {
    // `"false"` is truthy: believing it rather than proving it decides whether
    // the customer's request may be attempted again at all.
    expect(
      isWellFormedCompletionObservation({ kind: "FAILED", retryable, diagnosticCode: null }),
    ).toBe(false);
  });

  it("refuses a failure with no retryable flag at all", () => {
    expect(isWellFormedCompletionObservation({ kind: "FAILED", diagnosticCode: null })).toBe(
      false,
    );
  });

  it.each([
    ["a number", 429],
    ["undefined", undefined],
    ["missing", "__ABSENT__"],
    ["an object", { code: "TIMEOUT" }],
    ["lowercase", "timeout"],
    ["padded", "TIMEOUT "],
    ["a credential", "Bearer sk-live-abcdef"],
    ["a signed URL", "https://p.example/o.mp4?X-Amz-Signature=SECRET"],
    ["a prompt", "a sunlit living room, cinematic"],
    ["a retired code", "RATE_LIMITED"],
  ])("refuses a diagnostic that is %s", (_label, diagnosticCode) => {
    const observation: Record<string, unknown> =
      diagnosticCode === "__ABSENT__"
        ? { kind: "FAILED", retryable: true }
        : { kind: "FAILED", retryable: true, diagnosticCode };
    expect(isWellFormedCompletionObservation(observation)).toBe(false);
  });

  it("never throws on hostile input", () => {
    for (const hostile of [null, undefined, 1, "x", [], {}, { kind: "FAILED", retryable: {} }]) {
      expect(() => isWellFormedCompletionObservation(hostile)).not.toThrow();
    }
  });

  it("narrows the type for a caller that started from unknown", () => {
    const decoded: unknown = JSON.parse('{"kind":"SUCCEEDED"}');
    if (!isWellFormedCompletionObservation(decoded)) throw new Error("expected well-formed");
    const observation: ProviderCompletionObservation = decoded;
    expect(observation.kind).toBe("SUCCEEDED");
  });
});

describe("the contract carries no provider detail and no output location", () => {
  const TEXT = readFileSync(join(__dirname, "observation.ts"), "utf8");

  it("declares exactly the fields each arm is allowed", () => {
    const succeeded: ProviderCompletionObservation = { kind: "SUCCEEDED" };
    const failed: ProviderCompletionObservation = {
      kind: "FAILED",
      retryable: true,
      diagnosticCode: null,
    };
    expect(Object.keys(succeeded)).toEqual(["kind"]);
    expect(Object.keys(failed).sort()).toEqual(["diagnosticCode", "kind", "retryable"]);
  });

  it("names no field that could carry an output location or provider payload", () => {
    // The success arm is the dangerous one: a field for "where the result is"
    // is a provider URL that will eventually be persisted.
    for (const banned of [
      "outputUrl",
      "providerOutputUrl",
      "downloadUrl",
      "signedUrl",
      "storageKey",
      "httpStatus",
      "statusCode",
      "responseBody",
      "providerMessage",
      "rawResponse",
      "apiKey",
      "authorization",
      "prompt",
      "stack",
    ]) {
      expect(`${banned}: ${TEXT.includes(`${banned}:`)}`).toBe(`${banned}: false`);
    }
  });

  it("has no still-running arm", () => {
    for (const banned of ["IN_PROGRESS", "RUNNING", "PENDING", "STILL_PROCESSING"]) {
      expect(`${banned}: ${TEXT.includes(`"${banned}"`)}`).toBe(`${banned}: false`);
    }
  });
});
