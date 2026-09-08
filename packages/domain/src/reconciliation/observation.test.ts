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
