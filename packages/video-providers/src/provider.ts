import type { Money } from "@app/shared";
import type {
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  ProviderName,
  ProviderError,
  ProviderSubmissionOutcome,
} from "./types";

/**
 * The one operation that can cost money, isolated as its own port.
 *
 * Submission is separated from the rest of the provider seam because it is the
 * only call whose *failure mode* is financial rather than functional. A status
 * poll that fails can be repeated; a create POST that fails may already have
 * been billed, and repeating it may bill again. That asymmetry deserves a
 * boundary rather than a comment.
 *
 * Splitting it also lets an adapter exist for submission alone. The fal / H3 Max
 * adapter implements exactly this and nothing else: it has no verified pricing
 * contract, no polling contract, and no cancellation contract, so it declares
 * none. Forcing it through the full {@link VideoGenerationProvider} would have
 * meant inventing three fake answers to satisfy a type — which is the same
 * fabrication ADR-0033 refused for unverified catalog entries.
 *
 * **`createGeneration` does not throw for expected submission failures.** A
 * rejected, timed-out or ambiguous submission is a *result*, returned as a
 * {@link ProviderSubmissionOutcome}, because `catch { retry() }` is the natural
 * wrong handler for an exception and the natural wrong handler here spends the
 * customer's money twice. Programmer defects still throw; they are not provider
 * certainty and must not be dressed up as it (ADR-0035).
 */
export interface VideoGenerationSubmissionProvider {
  readonly name: ProviderName;

  /**
   * Submit one paid generation request, **at most once**.
   *
   * Every implementation must invoke its outbound submission transport no more
   * than a single time per call: no loop, no retry, no retry-on-timeout, no
   * retry-on-429, no retry after a redirect or a malformed success. The
   * application holds no provider idempotency contract, so a second POST is a
   * second potential charge.
   */
  createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome>;

  /** Normalize an arbitrary thrown value into an internal ProviderError. */
  normalizeError(error: unknown): ProviderError;
}

/**
 * The full seam through which the platform talks to any video-generation
 * vendor. WaveSpeedAI is the initial implementation, but provider-specific
 * SDKs and payloads never cross this boundary (SystemArchitecture.md).
 *
 * It extends the submission port rather than redeclaring `createGeneration`, so
 * there is exactly one definition of what submitting costs and returns. Status
 * and cancellation keep their existing exception behaviour: neither can incur a
 * charge, so neither needs the certainty vocabulary.
 */
export interface VideoGenerationProvider extends VideoGenerationSubmissionProvider {
  /** Query and normalize the current status of a submitted prediction. */
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;

  /** Cancel a prediction where the provider supports it. */
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;

  /** Estimate provider cost from configured model capabilities. */
  estimateCost(input: ProviderGenerationInput): Promise<Money>;
}
