import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBMISSION_DIAGNOSTIC_CODES,
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";
import {
  isWellFormedResolutionObservation,
  type ReconciliationResolutionObservation,
} from "./observation";

/**
 * The evidence contract — what a caller is allowed to tell this phase.
 *
 * Two arms, and the missing third is the design. "Still unknown" is already
 * what the row says; re-recording it would be a write that changes nothing
 * while claiming progress.
 *
 * Everything else here is about what cannot get in. Provider bodies, HTTP
 * statuses, signed URLs, credentials and prompts have no field to travel in,
 * and the one string-shaped field is checked against a closed catalog rather
 * than a pattern — a value spelled like a code is not one.
 */

function code(raw: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(raw);
  if (!parsed.ok || parsed.code === null) throw new Error(`fixture: ${raw}`);
  return parsed.code;
}

describe("the shape of admissible evidence", () => {
  it("accepts an acceptance carrying a provider reference", () => {
    expect(
      isWellFormedResolutionObservation({
        kind: "ACCEPTED",
        providerPredictionId: "pred_found",
      }),
    ).toBe(true);
  });

  it.each(["", " ", "\t", "\n", "   \t  "])(
    "refuses a blank provider reference %p",
    (blank) => {
      // A reference that names nothing is uncertainty, and uncertainty is
      // already what the row says.
      expect(
        isWellFormedResolutionObservation({ kind: "ACCEPTED", providerPredictionId: blank }),
      ).toBe(false);
    },
  );

  it("accepts a rejection with no diagnostic at all", () => {
    // Nobody is required to have a classification. Absence is honest; an
    // invented code is not.
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: true,
        diagnosticCode: null,
      }),
    ).toBe(true);
  });

  it.each(SUBMISSION_DIAGNOSTIC_CODES)("accepts the catalog member %s", (member) => {
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: false,
        diagnosticCode: code(member),
      }),
    ).toBe(true);
  });

  it.each([
    "https://provider.example/out.mp4?X-Amz-Signature=SECRET",
    "Bearer sk-live-abcdef",
    "Provider returned 429: too many requests",
    "a sunlit living room, cinematic, wide angle",
    "TIMEOUT ",
    "timeout",
    "TIMEOUT; DROP TABLE",
    "RATE_LIMITED",
  ])("refuses %p at the boundary even though it is typed as a code", (hostile) => {
    // A cast is what a caller in a hurry writes, so membership is re-checked
    // here rather than trusted from the type.
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: false,
        diagnosticCode: hostile as SubmissionDiagnosticCode,
      }),
    ).toBe(false);
  });
});

describe("the contract carries no provider detail", () => {
  const TEXT = readFileSync(join(__dirname, "observation.ts"), "utf8");

  it("declares exactly the fields each arm is allowed", () => {
    // Enumerated from a real value rather than read off the type, so a field
    // added to the union without a test is a field this notices.
    const accepted: ReconciliationResolutionObservation = {
      kind: "ACCEPTED",
      providerPredictionId: "pred_found",
    };
    const rejected: ReconciliationResolutionObservation = {
      kind: "DEFINITIVELY_REJECTED",
      retryable: true,
      diagnosticCode: null,
    };
    expect(Object.keys(accepted).sort()).toEqual(["kind", "providerPredictionId"]);
    expect(Object.keys(rejected).sort()).toEqual(["diagnosticCode", "kind", "retryable"]);
  });

  it("names no field that could carry a raw provider payload", () => {
    for (const banned of [
      "httpStatus",
      "statusCode",
      "responseBody",
      "providerMessage",
      "errorBody",
      "rawResponse",
      "providerUrl",
      "outputUrl",
      "signedUrl",
      "apiKey",
      "authorization",
      "headers",
      "prompt",
      "stack",
    ]) {
      expect(`${banned}: ${TEXT.includes(`${banned}:`)}`).toBe(`${banned}: false`);
    }
  });

  it("has no STILL_UNKNOWN arm", () => {
    // Phase 2G-1 needed one, because "nobody can say" is worth writing down the
    // first time. Here the attempt is already recorded as unknown with a
    // deadline, and a lookup that still cannot decide simply does not call.
    expect(TEXT.includes("STILL_UNKNOWN")).toBe(false);
    const arms = new Set<string>();
    for (const observation of [
      { kind: "ACCEPTED", providerPredictionId: "p" },
      { kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode: null },
    ] as const) {
      arms.add(observation.kind);
    }
    expect([...arms].sort()).toEqual(["ACCEPTED", "DEFINITIVELY_REJECTED"]);
  });

  it("reuses the Phase 2G-1 vocabulary without expanding it", () => {
    // Two catalogs for one concept would force an operator to know which phase
    // wrote each row, and expanding one without a concrete requirement is how a
    // closed vocabulary becomes free text a byte at a time.
    expect([...SUBMISSION_DIAGNOSTIC_CODES].sort()).toEqual([
      "CONNECTION_RESET",
      "LOCAL_CONFIGURATION",
      "TIMEOUT",
    ]);
  });
});


describe("the validator treats its input as unknown, because it is", () => {
  /**
   * The union is a compile-time promise about a value this layer did not
   * construct. Everything below type-checks its way in through a cast, decoded
   * JSON, or a queue payload — which is exactly how it will arrive in
   * production, since the producers do not exist yet and will not be written by
   * the person who wrote this contract.
   */

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "ACCEPTED"],
    ["an array", []],
    ["an array shaped like a tuple", ["ACCEPTED", "pred_x"]],
    // An array is an object and indexes cleanly, so without an explicit
    // array check it reaches the discriminant switch as a value with
    // properties. A JS producer building its result on an array would get
    // here; JSON would not.
    ["an array carrying a valid arm's properties", Object.assign([], {
      kind: "ACCEPTED",
      providerPredictionId: "pred_x",
    })],
    ["an empty object", {}],
    ["an object with no kind", { providerPredictionId: "pred_x" }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedResolutionObservation(value)).toBe(false);
  });

  it.each([
    ["UNKNOWN", { kind: "UNKNOWN" }],
    ["SUBMISSION_UNKNOWN", { kind: "SUBMISSION_UNKNOWN", diagnosticCode: null }],
    ["a lowercase accepted", { kind: "accepted", providerPredictionId: "pred_x" }],
    // The one that matters: an unrecognised arm carrying a body that would
    // pass the rejection validation. A future provider adapter emitting a new
    // kind must not have it silently recorded as a definitive rejection —
    // resolving a paid attempt and moving a customer's unit on a name nobody
    // wrote a meaning for.
    ["a well-formed body under an unknown kind", {
      kind: "UNKNOWN",
      retryable: true,
      diagnosticCode: null,
    }],
    ["a well-formed body under a 2G-1 arm", {
      kind: "SUBMISSION_UNKNOWN",
      retryable: false,
      diagnosticCode: "TIMEOUT",
    }],
    ["a numeric kind", { kind: 1 }],
    ["a null kind", { kind: null }],
  ])("refuses the unrecognised discriminant %s rather than assuming rejection", (_l, value) => {
    // The dangerous default. Sweeping an unrecognised kind into the rejection
    // branch would resolve an uncertain attempt, move a customer's entitlement
    // and close a paid submission on the strength of a value nobody wrote a
    // meaning for. `SUBMISSION_UNKNOWN` is listed here on purpose: it is a
    // valid Phase 2G-1 arm and deliberately *not* one of this phase's two.
    expect(isWellFormedResolutionObservation(value)).toBe(false);
  });

  it.each([
    ["a number", { kind: "ACCEPTED", providerPredictionId: 123 }],
    ["null", { kind: "ACCEPTED", providerPredictionId: null }],
    ["undefined", { kind: "ACCEPTED", providerPredictionId: undefined }],
    ["missing", { kind: "ACCEPTED" }],
    ["an object", { kind: "ACCEPTED", providerPredictionId: { id: "pred_x" } }],
    ["an array", { kind: "ACCEPTED", providerPredictionId: ["pred_x"] }],
    ["blank", { kind: "ACCEPTED", providerPredictionId: "   " }],
  ])("refuses a provider reference that is %s, without throwing", (_label, value) => {
    // The earlier version called `.trim()` on whatever it was given, so a
    // non-string reference threw out of a validator instead of answering.
    expect(() => isWellFormedResolutionObservation(value)).not.toThrow();
    expect(isWellFormedResolutionObservation(value)).toBe(false);
  });

  it.each([
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ])("refuses a retryable flag that is %s", (_label, retryable) => {
    // The specific hole this closes: `retryable: "false"` is truthy, so it
    // recorded FAILED_RETRYABLE and handed the customer's reserved unit back
    // for a retry — on the strength of a string that says the opposite.
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable,
        diagnosticCode: null,
      }),
    ).toBe(false);
  });

  it("refuses a rejection with no retryable flag at all", () => {
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        diagnosticCode: null,
      }),
    ).toBe(false);
  });

  it.each([
    ["a number", 429],
    ["undefined", undefined],
    ["missing", "__ABSENT__"],
    ["an object", { code: "TIMEOUT" }],
    ["an array", ["TIMEOUT"]],
    ["lowercase", "timeout"],
    ["padded", "TIMEOUT "],
    ["a credential", "Bearer sk-live-abcdef"],
    ["a signed URL", "https://p.example/o.mp4?X-Amz-Signature=SECRET"],
    ["a retired code", "RATE_LIMITED"],
  ])("refuses a diagnostic that is %s", (_label, diagnosticCode) => {
    const observation: Record<string, unknown> =
      diagnosticCode === "__ABSENT__"
        ? { kind: "DEFINITIVELY_REJECTED", retryable: true }
        : { kind: "DEFINITIVELY_REJECTED", retryable: true, diagnosticCode };
    expect(isWellFormedResolutionObservation(observation)).toBe(false);
  });

  it("accepts the two well-formed shapes", () => {
    // The guard must still let real evidence through, or the phase is a
    // very safe way of doing nothing.
    expect(
      isWellFormedResolutionObservation({
        kind: "ACCEPTED",
        providerPredictionId: "pred_found",
      }),
    ).toBe(true);
    expect(
      isWellFormedResolutionObservation({
        kind: "DEFINITIVELY_REJECTED",
        retryable: false,
        diagnosticCode: "TIMEOUT",
      }),
    ).toBe(true);
  });

  it("narrows the type for a caller that started from unknown", () => {
    // The signature is a type guard, so a producer decoding JSON gets a checked
    // value rather than having to assert one.
    const decoded: unknown = JSON.parse('{"kind":"ACCEPTED","providerPredictionId":"pred_j"}');
    if (!isWellFormedResolutionObservation(decoded)) throw new Error("expected well-formed");
    const observation: ReconciliationResolutionObservation = decoded;
    expect(observation.kind).toBe("ACCEPTED");
  });
});
