import type { Money } from "@app/shared";

export type ProviderName = "fake" | "wavespeed";

/**
 * Normalized, provider-agnostic input for a single scene generation.
 * Domain services only ever construct and read these internal types; no
 * provider-specific payload shapes leak past the adapter boundary.
 */
export interface ProviderGenerationInput {
  readonly modelId: string;
  /**
   * Short-lived signed URL for the normalized source image. Internal only —
   * must not contain customer identifiers and must not be logged.
   */
  readonly sourceImageUrl: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly cameraMotion?: string;
  readonly seed?: number;
  /** Stable request hash used for idempotency and provider-charge dedup. */
  readonly requestHash: string;
}

/**
 * Internal reference to a submitted provider prediction. `predictionId` is
 * internal only and must never be exposed to customers (DataModel.md stores it
 * encrypted).
 */
export interface ProviderGenerationRef {
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly predictionId: string;
  readonly submittedAt: string; // ISO 8601
}

export type ProviderGenerationState =
  | "QUEUED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "CANCELLED"
  | "TIMED_OUT";

export const TERMINAL_STATES: readonly ProviderGenerationState[] = [
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "CANCELLED",
  "TIMED_OUT",
];

export function isTerminalState(state: ProviderGenerationState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface ProviderGenerationStatus {
  readonly ref: ProviderGenerationRef;
  readonly state: ProviderGenerationState;
  readonly progressPercent?: number;
  /**
   * Temporary provider output URL. INTERNAL ONLY — the worker downloads this,
   * validates it, and copies the result into managed object storage. It must
   * never be exposed to customers (WaveSpeedAIIntegration.md step 9).
   */
  readonly temporaryOutputUrl?: string;
  readonly temporaryOutputExpiresAt?: string;
  readonly error?: ProviderError;
}

export type ProviderErrorKind =
  | "NETWORK"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "AUTH"
  | "INVALID_INPUT"
  | "MODERATION"
  | "UNSUPPORTED"
  | "PROVIDER"
  | "UNKNOWN";

/**
 * Normalized provider error. `messageSanitized` is safe for support and logs;
 * it must not contain secrets, signed URLs, or raw provider payloads.
 */
export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly code: string;
  readonly messageSanitized: string;
  readonly cause?: unknown;
}

/** Model capability + pricing, treated as configuration data, not constants. */
export interface VideoModelPricing {
  readonly currency: string;
  readonly costPerSecondMinor: number;
}

export type { Money };
