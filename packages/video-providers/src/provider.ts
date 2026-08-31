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
 * The single seam through which the platform talks to any video-generation
 * vendor. WaveSpeedAI is the initial implementation, but provider-specific
 * SDKs and payloads never cross this boundary (SystemArchitecture.md).
 */
export interface VideoGenerationProvider {
  readonly name: ProviderName;

  /**
   * Submit an asynchronous prediction and report **what is known** about the
   * provider's state afterwards.
   *
   * It returns rather than throws for anything that happens once the paid
   * invocation has begun, because a thrown value cannot carry the distinction
   * that matters: `catch` treats "the provider rejected this" and "a prediction
   * may already be running and billed" identically, and the natural handler for
   * the first is a retry.
   *
   * It may throw a sanitized `ProviderErrorException` **only** for a failure
   * proven to occur strictly before invocation — request construction and
   * serialization. From the moment the HTTP call is entered, every outcome is a
   * `ProviderSubmissionOutcome` (ADR-0032).
   */
  createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome>;

  /** Query and normalize the current status of a submitted prediction. */
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;

  /** Cancel a prediction where the provider supports it. */
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;

  /** Estimate provider cost from configured model capabilities. */
  estimateCost(input: ProviderGenerationInput): Promise<Money>;

  /** Normalize an arbitrary thrown value into an internal ProviderError. */
  normalizeError(error: unknown): ProviderError;
}
