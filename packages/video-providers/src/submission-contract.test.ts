import { describe, expect, it } from "vitest";
import { FakeVideoProvider } from "./fake/fake-provider";
import { WaveSpeedVideoProvider } from "./wavespeed/wavespeed-provider";
import type { VideoGenerationProvider } from "./provider";
import type {
  ProviderGenerationRef,
  ProviderSubmissionOutcome,
} from "./types";

/**
 * The submission contract, pinned where it is actually enforceable.
 *
 * Runtime tests can only observe the outcomes a stub happens to produce. What
 * keeps a future edit from quietly returning a bare `ProviderGenerationRef`
 * again, or from bolting an `error` onto the accepted arm, is the compiler —
 * so these assertions are written to fail `tsc`, not `vitest`.
 */
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Accepted = Extract<ProviderSubmissionOutcome, { kind: "ACCEPTED" }>;
type Rejected = Extract<ProviderSubmissionOutcome, { kind: "DEFINITIVELY_REJECTED" }>;
type Unknown_ = Extract<ProviderSubmissionOutcome, { kind: "SUBMISSION_UNKNOWN" }>;

describe("the provider submission contract is pinned at compile time", () => {
  it("returns the outcome union, never a bare reference", () => {
    type Returned = Awaited<ReturnType<VideoGenerationProvider["createGeneration"]>>;
    const isOutcome: Assert<IsExactly<Returned, ProviderSubmissionOutcome>> = true;

    // The old contract must not be assignable to the new one. If someone
    // restores `Promise<ProviderGenerationRef>`, this stops resolving to
    // `false` and the annotation becomes unsatisfiable.
    const bareRefIsNotAnOutcome: Assert<
      IsExactly<[ProviderGenerationRef] extends [ProviderSubmissionOutcome] ? true : false, false>
    > = true;

    expect([isOutcome, bareRefIsNotAnOutcome]).toEqual([true, true]);
  });

  it("gives only the accepted arm a ref, and only the failure arms an error", () => {
    const acceptedHasRef: Assert<IsExactly<Accepted["ref"], ProviderGenerationRef>> = true;
    const acceptedHasNoError: Assert<IsNever<Extract<keyof Accepted, "error">>> = true;
    const rejectedHasNoRef: Assert<IsNever<Extract<keyof Rejected, "ref">>> = true;
    const unknownHasNoRef: Assert<IsNever<Extract<keyof Unknown_, "ref">>> = true;
    const rejectedHasError: Assert<IsExactly<Extract<keyof Rejected, "error">, "error">> = true;
    const unknownHasError: Assert<IsExactly<Extract<keyof Unknown_, "error">, "error">> = true;

    expect([
      acceptedHasRef,
      acceptedHasNoError,
      rejectedHasNoRef,
      unknownHasNoRef,
      rejectedHasError,
      unknownHasError,
    ]).toEqual([true, true, true, true, true, true]);
  });

  it("has exactly three discriminants, exhaustively handled", () => {
    const exactly: Assert<
      IsExactly<
        ProviderSubmissionOutcome["kind"],
        "ACCEPTED" | "DEFINITIVELY_REJECTED" | "SUBMISSION_UNKNOWN"
      >
    > = true;

    // A `never` default is reachable only while the union has no fourth arm.
    const describeOutcome = (outcome: ProviderSubmissionOutcome): string => {
      switch (outcome.kind) {
        case "ACCEPTED":
          return outcome.ref.predictionId;
        case "DEFINITIVELY_REJECTED":
          return outcome.error.code;
        case "SUBMISSION_UNKNOWN":
          return outcome.error.code;
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    };

    expect(exactly).toBe(true);
    expect(
      describeOutcome({
        kind: "ACCEPTED",
        ref: {
          provider: "fake",
          modelId: "m",
          predictionId: "pred_9",
          submittedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe("pred_9");
  });

  /**
   * Both shipped adapters are checked against the interface, so neither can
   * drift back to the old return type on its own.
   */
  it("is implemented by both providers", () => {
    const providers: VideoGenerationProvider[] = [
      new FakeVideoProvider(),
      new WaveSpeedVideoProvider(
        {
          apiKey: "k",
          baseUrl: "https://api.wavespeed.ai/api/v3",
          poll: { initialMs: 1, maxMs: 2, timeoutMs: 3 },
          pricing: { currency: "USD", costPerSecondMinor: 1 },
        },
        { http: { request: () => Promise.resolve({ status: 200, body: "{}" }) } },
      ),
    ];
    expect(providers.map((p) => p.name)).toEqual(["fake", "wavespeed"]);
  });
});
