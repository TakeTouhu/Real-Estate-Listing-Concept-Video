import { describe, expect, it } from "vitest";
import { SUBMISSION_DIAGNOSTIC_CODES } from "./diagnostic-code";
import {
  isWellFormedObservation,
  type ProviderSubmissionObservation,
} from "./observation";

/**
 * Phase 2G-1's evidence contract, re-examined as a trust boundary.
 *
 * The union is a compile-time promise about a value this layer did not build.
 * What will actually arrive is decoded JSON from a provider adapter, a queue
 * payload, or a value someone cast on the way in — and `tsc` checked none of
 * it. The validator therefore takes `unknown` and proves the shape.
 *
 * Two holes are closed here, both of which cost money rather than merely
 * crashing:
 *
 * - a non-string `providerPredictionId` threw inside `trim()`, so a validator
 *   answered with an exception;
 * - every discriminant other than `ACCEPTED` fell into the rejection branch
 *   with `retryable` never examined, so `retryable: "false"` was truthy,
 *   recorded `FAILED_RETRYABLE`, and restored a customer's reserved unit.
 */

describe("well-formed observations are still accepted", () => {
  it("accepts an acceptance naming what was taken", () => {
    expect(
      isWellFormedObservation({ kind: "ACCEPTED", providerPredictionId: "pred_live" }),
    ).toBe(true);
  });

  it("accepts both rejection shapes", () => {
    for (const retryable of [true, false]) {
      expect(
        isWellFormedObservation({
          kind: "DEFINITIVELY_REJECTED",
          retryable,
          normalizedErrorCode: null,
        }),
      ).toBe(true);
    }
  });

  it("accepts an uncertain submission", () => {
    expect(
      isWellFormedObservation({ kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: null }),
    ).toBe(true);
  });

  it.each(SUBMISSION_DIAGNOSTIC_CODES)("accepts the catalog member %s on both arms", (code) => {
    expect(
      isWellFormedObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: true,
        normalizedErrorCode: code,
      }),
    ).toBe(true);
    expect(
      isWellFormedObservation({ kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: code }),
    ).toBe(true);
  });
});

describe("the validator proves the shape rather than assuming it", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "ACCEPTED"],
    ["a boolean", true],
    ["an array", []],
    ["an array of arms", [{ kind: "ACCEPTED", providerPredictionId: "p" }]],
    ["an array carrying a valid arm's properties", Object.assign([], {
      kind: "ACCEPTED",
      providerPredictionId: "pred_live",
    })],
    ["an empty object", {}],
    ["an object with no kind", { providerPredictionId: "pred_live" }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedObservation(value)).toBe(false);
  });

  it.each([
    ["UNKNOWN", { kind: "UNKNOWN" }],
    ["PRE_SUBMISSION", { kind: "PRE_SUBMISSION" }],
    ["a lowercase arm", { kind: "accepted", providerPredictionId: "pred_live" }],
    // The dangerous shape: an unrecognised arm whose body would satisfy the
    // rejection validation. The old code reached the rejection branch for
    // *every* non-ACCEPTED kind, so a new provider arm would have been
    // recorded as a definitive rejection of a paid submission.
    ["a well-formed body under an unknown kind", {
      kind: "UNKNOWN",
      retryable: true,
      normalizedErrorCode: null,
    }],
    ["a numeric kind", { kind: 3 }],
    ["a null kind", { kind: null }],
    ["an object kind", { kind: { name: "ACCEPTED" } }],
  ])("refuses the unrecognised discriminant %s instead of calling it a rejection", (_l, value) => {
    // This is the defect, not a hypothetical. The old branch was "if not
    // ACCEPTED then it must be one of the other two", so an unrecognised kind
    // was validated as a rejection and could then be *recorded* as one —
    // failing a paid submission on the strength of a value nobody defined.
    expect(isWellFormedObservation(value)).toBe(false);
  });

  it.each([
    ["a number", 123],
    ["null", null],
    ["undefined", undefined],
    ["an object", { id: "pred_live" }],
    ["an array", ["pred_live"]],
    ["blank", "   "],
    ["empty", ""],
  ])("refuses an acceptance whose reference is %s, without throwing", (_label, id) => {
    const value = { kind: "ACCEPTED", providerPredictionId: id };
    // The old validator called `.trim()` on whatever it was handed, so a
    // non-string reference threw out of the validator rather than being refused.
    expect(() => isWellFormedObservation(value)).not.toThrow();
    expect(isWellFormedObservation(value)).toBe(false);
  });

  it("refuses an acceptance with no reference field at all", () => {
    expect(isWellFormedObservation({ kind: "ACCEPTED" })).toBe(false);
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
  ])("refuses a rejection whose retryable flag is %s", (_label, retryable) => {
    // The expensive one. `"false"` is truthy, so it recorded FAILED_RETRYABLE
    // and restored the customer's reserved unit — the exact opposite of what
    // the value said, and a unit given away on a type confusion.
    expect(
      isWellFormedObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable,
        normalizedErrorCode: null,
      }),
    ).toBe(false);
  });

  it("refuses a rejection with no retryable flag at all", () => {
    expect(
      isWellFormedObservation({ kind: "DEFINITIVELY_REJECTED", normalizedErrorCode: null }),
    ).toBe(false);
  });

  it.each([
    ["a number", 429],
    ["undefined", undefined],
    ["an object", { code: "TIMEOUT" }],
    ["an array", ["TIMEOUT"]],
    ["lowercase", "timeout"],
    ["padded", "TIMEOUT "],
    ["a credential", "Bearer sk-live-abcdef"],
    ["a signed URL", "https://p.example/o.mp4?X-Amz-Signature=SECRET"],
    ["a prompt", "a sunlit living room, cinematic"],
    ["a retired code", "RATE_LIMITED"],
  ])("refuses a diagnostic that is %s, on both arms that carry one", (_label, normalizedErrorCode) => {
    expect(
      isWellFormedObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: true,
        normalizedErrorCode,
      }),
    ).toBe(false);
    expect(isWellFormedObservation({ kind: "SUBMISSION_UNKNOWN", normalizedErrorCode })).toBe(
      false,
    );
  });

  it("refuses an arm whose diagnostic field is simply missing", () => {
    // `undefined` is not `null`. A sender that omitted the field has not stated
    // that there was no diagnostic; it has said nothing, and the record would
    // read as a positive claim of absence.
    expect(isWellFormedObservation({ kind: "SUBMISSION_UNKNOWN" })).toBe(false);
    expect(
      isWellFormedObservation({ kind: "DEFINITIVELY_REJECTED", retryable: false }),
    ).toBe(false);
  });

  it("narrows the type for a caller that started from unknown", () => {
    const decoded: unknown = JSON.parse(
      '{"kind":"SUBMISSION_UNKNOWN","normalizedErrorCode":"TIMEOUT"}',
    );
    if (!isWellFormedObservation(decoded)) throw new Error("expected well-formed");
    const observation: ProviderSubmissionObservation = decoded;
    expect(observation.kind).toBe("SUBMISSION_UNKNOWN");
  });
});
