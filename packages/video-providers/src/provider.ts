import type { Money } from "@app/shared";
import type {
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  ProviderName,
  ProviderError,
} from "./types";

/**
 * The single seam through which the platform talks to any video-generation
 * vendor. WaveSpeedAI is the initial implementation, but provider-specific
 * SDKs and payloads never cross this boundary (SystemArchitecture.md).
 */
export interface VideoGenerationProvider {
  readonly name: ProviderName;

  /** Submit an asynchronous prediction and return an internal reference. */
  createGeneration(input: ProviderGenerationInput): Promise<ProviderGenerationRef>;

  /** Query and normalize the current status of a submitted prediction. */
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;

  /** Cancel a prediction where the provider supports it. */
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;

  /** Estimate provider cost from configured model capabilities. */
  estimateCost(input: ProviderGenerationInput): Promise<Money>;

  /** Normalize an arbitrary thrown value into an internal ProviderError. */
  normalizeError(error: unknown): ProviderError;
}
