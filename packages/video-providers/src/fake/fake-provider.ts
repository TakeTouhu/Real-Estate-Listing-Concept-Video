import { money, type Money } from "@app/shared";
import type { VideoGenerationProvider } from "../provider";
import { providerError } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  ProviderSubmissionOutcome,
  VideoModelPricing,
} from "../types";

/**
 * Which submission outcome the fake produces, chosen up front.
 *
 * A closed vocabulary rather than a callback, and it carries no message: a
 * caller-supplied string would end up in `ProviderError.messageSanitized`,
 * which ADR-0031 requires to be application-owned. The fake is the provider
 * every test and local run wires, so it is exactly where that habit would form.
 */
export type FakeSubmissionOutcomeKind =
  | "ACCEPTED"
  | "DEFINITIVELY_REJECTED"
  | "SUBMISSION_UNKNOWN";

export interface FakeVideoProviderOptions {
  readonly pricing?: VideoModelPricing;
  readonly now?: () => Date;
  /** Base for the synthetic temporary output URL (never a real endpoint). */
  readonly outputUrlBase?: string;
  /**
   * The submission outcome to return. Defaults to `ACCEPTED`.
   *
   * This is the offline seam for exercising the ambiguous path: a worker's
   * handling of `SUBMISSION_UNKNOWN` is the most expensive thing to get wrong
   * and the hardest to reach with a real provider, so it has to be reachable
   * deterministically and without a network.
   */
  readonly submissionOutcome?: FakeSubmissionOutcomeKind;
}

const DEFAULT_PRICING: VideoModelPricing = { currency: "USD", costPerSecondMinor: 5 };

/**
 * Deterministic, offline provider used for Phase 0, local development, and
 * tests. It never performs network I/O, so it satisfies the roadmap rule
 * "Do not call the real WaveSpeedAI API in Phase 0" while proving the adapter
 * boundary compiles and is wired end-to-end.
 */
export class FakeVideoProvider implements VideoGenerationProvider {
  readonly name = "fake" as const;
  private readonly pricing: VideoModelPricing;
  private readonly now: () => Date;
  private readonly outputUrlBase: string;
  private readonly submissionOutcome: FakeSubmissionOutcomeKind;

  constructor(options: FakeVideoProviderOptions = {}) {
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    this.now = options.now ?? (() => new Date());
    this.outputUrlBase = options.outputUrlBase ?? "https://fake-provider.internal/outputs";
    this.submissionOutcome = options.submissionOutcome ?? "ACCEPTED";
  }

  /**
   * Return the configured outcome, deterministically and offline.
   *
   * The two failure arms use fixed application-owned errors, and their
   * `retryable` values are chosen to make the orthogonality visible: the
   * ambiguous one is `retryable: true`, which is exactly the combination a
   * caller must **not** read as permission to submit again.
   */
  createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    if (this.submissionOutcome === "DEFINITIVELY_REJECTED") {
      return Promise.resolve({
        kind: "DEFINITIVELY_REJECTED",
        error: providerError({
          kind: "INVALID_INPUT",
          code: "FAKE_SUBMISSION_REJECTED",
          messageSanitized: "Fake provider rejected the submission",
          retryable: false,
        }),
      });
    }
    if (this.submissionOutcome === "SUBMISSION_UNKNOWN") {
      return Promise.resolve({
        kind: "SUBMISSION_UNKNOWN",
        error: providerError({
          kind: "TIMEOUT",
          code: "FAKE_SUBMISSION_UNKNOWN",
          messageSanitized: "Fake provider submission outcome is unknown",
          // Deliberately true: a retryable transport error still leaves the
          // submission ambiguous, and nothing may treat this as a licence to
          // re-POST (ADR-0035).
          retryable: true,
        }),
      });
    }
    return Promise.resolve({
      kind: "ACCEPTED",
      ref: {
        provider: this.name,
        modelId: input.modelId,
        predictionId: `fake_${input.requestHash}`,
        submittedAt: this.now().toISOString(),
      },
    });
  }

  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus> {
    const expires = new Date(this.now().getTime() + 60 * 60 * 1000);
    return Promise.resolve({
      ref,
      state: "SUCCEEDED",
      progressPercent: 100,
      temporaryOutputUrl: `${this.outputUrlBase}/${ref.predictionId}.mp4?token=fake`,
      temporaryOutputExpiresAt: expires.toISOString(),
    });
  }

  cancelGeneration(_ref: ProviderGenerationRef): Promise<void> {
    return Promise.resolve();
  }

  estimateCost(input: ProviderGenerationInput): Promise<Money> {
    return Promise.resolve(
      money(input.durationSeconds * this.pricing.costPerSecondMinor, this.pricing.currency),
    );
  }

  /**
   * The fake obeys the **same** secrecy contract as the real adapter.
   *
   * It used to copy `error.message` into `messageSanitized` and retain the
   * thrown value as `cause`. Being offline does not make that safe: this is the
   * provider every test and every local run wires, so it is where a habit of
   * "the message is probably fine" would form, and the `ProviderError` it
   * returns is the same type the domain persists. The parameter is accepted and
   * deliberately unused (ADR-0031).
   */
  normalizeError(_error: unknown): ProviderError {
    return providerError({
      kind: "UNKNOWN",
      code: "FAKE_PROVIDER_ERROR",
      messageSanitized: "Fake provider error",
    });
  }
}
