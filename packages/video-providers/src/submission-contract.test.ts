import { describe, expect, it } from "vitest";
import type {
  ProviderError,
  ProviderGenerationRef,
  ProviderSubmissionOutcome,
} from "./types";
import type { VideoGenerationProvider, VideoGenerationSubmissionProvider } from "./provider";

/**
 * The provider-neutral submission contract, pinned at compile time.
 *
 * These assertions guard the shape of the one answer that decides whether a
 * customer can be charged twice. Each is a type-level equation that fails to
 * compile if the union widens, narrows, or acquires a field it must not have.
 *
 * The negative assertions matter most. A `retryable` flag on the union, or an
 * HTTP status on it, would let a caller read certainty off the wrong thing —
 * and the wrong reading here is "safe to POST again".
 *
 * No `any`, no `@ts-ignore`, no cast used to satisfy anything.
 */

type Assert<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type IsNever<T> = [T] extends [never] ? true : false;

/** Every arm's discriminant, as the union actually declares them. */
type OutcomeKind = ProviderSubmissionOutcome["kind"];
type AcceptedArm = Extract<ProviderSubmissionOutcome, { kind: "ACCEPTED" }>;
type RejectedArm = Extract<ProviderSubmissionOutcome, { kind: "DEFINITIVELY_REJECTED" }>;
type UnknownArm = Extract<ProviderSubmissionOutcome, { kind: "SUBMISSION_UNKNOWN" }>;

describe("ProviderSubmissionOutcome is a closed, provider-neutral union", () => {
  it("has exactly three arms and no others", () => {
    const exhaustive: Assert<
      IsExactly<OutcomeKind, "ACCEPTED" | "DEFINITIVELY_REJECTED" | "SUBMISSION_UNKNOWN">
    > = true;
    expect(exhaustive).toBe(true);

    // Every arm is reachable: a mistyped discriminant would make one `never`.
    const acceptedExists: Assert<IsNever<AcceptedArm> extends true ? false : true> = true;
    const rejectedExists: Assert<IsNever<RejectedArm> extends true ? false : true> = true;
    const unknownExists: Assert<IsNever<UnknownArm> extends true ? false : true> = true;
    expect([acceptedExists, rejectedExists, unknownExists]).toEqual([true, true, true]);
  });

  it("gives ACCEPTED a ref and no error", () => {
    const hasRef: Assert<IsExactly<AcceptedArm["ref"], ProviderGenerationRef>> = true;
    expect(hasRef).toBe(true);

    // An `error` on the success arm would invite reading a failure off a
    // successful submission.
    const noError: Assert<IsNever<Extract<keyof AcceptedArm, "error">>> = true;
    expect(noError).toBe(true);
  });

  it("gives both failure arms an error and no ref", () => {
    const rejectedError: Assert<IsExactly<RejectedArm["error"], ProviderError>> = true;
    const unknownError: Assert<IsExactly<UnknownArm["error"], ProviderError>> = true;
    expect([rejectedError, unknownError]).toEqual([true, true]);

    // A `ref` on a failure arm would let a caller treat an ambiguous or refused
    // submission as trackable work.
    const rejectedNoRef: Assert<IsNever<Extract<keyof RejectedArm, "ref">>> = true;
    const unknownNoRef: Assert<IsNever<Extract<keyof UnknownArm, "ref">>> = true;
    expect([rejectedNoRef, unknownNoRef]).toEqual([true, true]);
  });

  it("carries no retryability of its own", () => {
    // Certainty and retryability are orthogonal. If the union grew a
    // `retryable`, the two would be read as one — and `retryable: true` would
    // start to look like permission to re-POST (ADR-0035).
    type AnyArmKeys = keyof AcceptedArm | keyof RejectedArm | keyof UnknownArm;
    const noRetryable: Assert<IsNever<Extract<AnyArmKeys, "retryable">>> = true;
    expect(noRetryable).toBe(true);
  });

  it("carries no provider-specific transport detail", () => {
    // A status belongs on ProviderError.providerStatus, where it is a sanitized
    // diagnostic. On the union it would become an input to certainty decisions,
    // which is what keeps each adapter owning its own evidence.
    type AnyArmKeys = keyof AcceptedArm | keyof RejectedArm | keyof UnknownArm;
    type Forbidden =
      | "status"
      | "providerStatus"
      | "httpStatus"
      | "response"
      | "body"
      | "headers"
      | "cause";
    const none: Assert<IsNever<Extract<AnyArmKeys, Forbidden>>> = true;
    expect(none).toBe(true);
  });

  it("is exhaustively switchable, with no default arm needed", () => {
    // A runtime companion to the compile-time exhaustiveness: `assertNever`
    // fails to compile if an arm is added without being handled here.
    const describeOutcome = (outcome: ProviderSubmissionOutcome): string => {
      switch (outcome.kind) {
        case "ACCEPTED":
          return outcome.ref.predictionId;
        case "DEFINITIVELY_REJECTED":
          return `rejected:${outcome.error.code}`;
        case "SUBMISSION_UNKNOWN":
          return `unknown:${outcome.error.code}`;
      }
    };

    const ref: ProviderGenerationRef = {
      provider: "fake",
      modelId: "m",
      predictionId: "p1",
      submittedAt: "2026-09-02T00:00:00.000Z",
    };
    const error: ProviderError = {
      kind: "PROVIDER",
      retryable: true,
      code: "C",
      messageSanitized: "m",
    };

    expect(describeOutcome({ kind: "ACCEPTED", ref })).toBe("p1");
    expect(describeOutcome({ kind: "DEFINITIVELY_REJECTED", error })).toBe("rejected:C");
    expect(describeOutcome({ kind: "SUBMISSION_UNKNOWN", error })).toBe("unknown:C");
  });
});

describe("the submission port is a narrow sub-port of the provider seam", () => {
  it("declares createGeneration as returning the outcome union", () => {
    const returnsOutcome: Assert<
      IsExactly<
        Awaited<ReturnType<VideoGenerationSubmissionProvider["createGeneration"]>>,
        ProviderSubmissionOutcome
      >
    > = true;
    expect(returnsOutcome).toBe(true);
  });

  it("is inherited by the full provider rather than redeclared", () => {
    // One definition of what submitting costs and returns. A second, competing
    // abstraction is exactly what the milestone forbids.
    const inherited: Assert<
      IsExactly<
        Awaited<ReturnType<VideoGenerationProvider["createGeneration"]>>,
        Awaited<ReturnType<VideoGenerationSubmissionProvider["createGeneration"]>>
      >
    > = true;
    expect(inherited).toBe(true);

    const isSubPort: Assert<VideoGenerationProvider extends VideoGenerationSubmissionProvider
      ? true
      : false> = true;
    expect(isSubPort).toBe(true);
  });

  it("requires only submission and error normalization of a submission-only adapter", () => {
    // The fal adapter implements this and nothing else. If the sub-port grew
    // polling or pricing, that adapter would have to fabricate answers it does
    // not have — the fabrication ADR-0033 refused for unverified entries.
    const keys: Assert<
      IsExactly<keyof VideoGenerationSubmissionProvider, "name" | "createGeneration" | "normalizeError">
    > = true;
    expect(keys).toBe(true);
  });
});
