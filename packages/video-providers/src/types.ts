import type { Money } from "@app/shared";

export type ProviderName = "fake" | "wavespeed";

/**
 * Normalized, provider-agnostic input for a single scene generation.
 * Domain services only ever construct and read these internal types; no
 * provider-specific payload shapes leak past the adapter boundary.
 *
 * `negativePrompt` and `cameraMotion` were removed in Phase 4B-2b. Neither was
 * ever read: Phase 4B-2a stopped sending `negative_prompt` and `camera_motion`
 * because the selected model documents neither, and motion now reaches the
 * model inside `prompt`. Keeping unread optional fields on the type that
 * describes a paid request is how the earlier undocumented-field defect stayed
 * invisible — a field here reads as a capability the system has.
 */
export interface ProviderGenerationInput {
  readonly modelId: string;
  /**
   * Short-lived signed URL for the normalized source image. Internal only —
   * must not contain customer identifiers and must not be logged.
   */
  readonly sourceImageUrl: string;
  /**
   * The rendered provider prompt — `renderPrompt` in `@app/domain` is the only
   * thing that produces it. Camera motion is *inside* this string, which is
   * what makes a `cameraMotion: PROMPT_RENDERED` capability true (ADR-0020).
   */
  readonly prompt: string;
  readonly durationSeconds: number;
  /**
   * Requested by the project and part of the request identity, but not
   * necessarily sent to the provider: `AspectRatioSupport` decides who
   * guarantees it, and under `COMPOSITION_OWNED` composition does (ADR-0019).
   */
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly seed?: number;
  /**
   * Stable **internal** request identity.
   *
   * It is this application's own coordination key — admission, reuse and
   * accounting all key off it. It is **not** a provider idempotency token: the
   * current official WaveSpeedAI documentation establishes no idempotency-key
   * support for the create endpoint, and nothing sends this value as an
   * `Idempotency-Key` header or in the request body. An earlier comment here
   * claimed "idempotency and provider-charge dedup", which overstated the
   * provider contract — no provider-side deduplication exists to rely on, so
   * duplicate-charge safety comes from not re-POSTing, never from this hash
   * (ADR-0031).
   */
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

/**
 * What a submission attempt is known to have done to the **provider's** state,
 * as distinct from whether the client's request went well.
 *
 * The initial generation POST is the one call that spends money, and there are
 * three materially different things that can be true afterwards. Two of them
 * look identical from the outside — a 429 and a connection reset both "failed"
 * — but one may already have created a billed prediction. Collapsing them is
 * how a system pays twice.
 *
 * Certainty is deliberately **not** derivable from anything else the boundary
 * returns. Not from `ProviderError.kind`, not from `retryable`, not from the
 * HTTP status, and not from whether something was thrown. `retryable` answers
 * "would this request plausibly succeed if repeated"; this union answers "is it
 * safe to repeat it at all", and for a paid POST those are different questions
 * with different answers. A 429 is `retryable: true` and
 * `SUBMISSION_UNKNOWN` at the same time (ADR-0032).
 *
 * The arms are structurally disjoint on purpose: only `ACCEPTED` carries a
 * `ref`, so a caller cannot reach a prediction id without having discriminated
 * first, and the compiler enforces that rather than a convention.
 */
export type ProviderSubmissionOutcome =
  | {
      readonly kind: "ACCEPTED";
      /** Proof of acceptance: a usable prediction id the provider returned. */
      readonly ref: ProviderGenerationRef;
    }
  | {
      /**
       * Positive evidence the provider did **not** accept the request, so no
       * charge can exist and nothing needs reconciling.
       */
      readonly kind: "DEFINITIVELY_REJECTED";
      readonly error: ProviderError;
    }
  | {
      /**
       * Acceptance is unproven **in either direction**. A prediction may exist
       * and may be billed. Never re-submit on this outcome.
       */
      readonly kind: "SUBMISSION_UNKNOWN";
      readonly error: ProviderError;
    };

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
 * Normalized provider error — **safe structured data**, in the strong sense:
 * every field is application-owned, so the whole object may be stringified,
 * logged, and persisted without further filtering (ADR-0031).
 *
 * That guarantee is structural, not a convention. There is deliberately no
 * `cause`, no `rawBody`, no `response`, no `headers`, and no free-form details
 * bag: a field able to hold an arbitrary external value is a field that will
 * eventually hold a signed source URL, a bearer token, or a customer prompt,
 * and `normalizedErrorMessage` is a persisted column. `messageSanitized` is
 * chosen from fixed application text — it is never built from provider bytes.
 *
 * The only value ever interpolated into a message is `providerStatus`, and only
 * after it is proven to be an integer HTTP status.
 */
export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly code: string;
  readonly messageSanitized: string;
  /**
   * The HTTP status actually received from the provider, when one was.
   *
   * Present only for errors derived from a provider **response**; absent for
   * network, abort, and locally-raised errors, where no status exists and
   * inventing one would assert contact that never happened. Constrained to an
   * integer in 100–599, which is what makes it safe to interpolate.
   */
  readonly providerStatus?: number;
}

/** Model capability + pricing, treated as configuration data, not constants. */
export interface VideoModelPricing {
  readonly currency: string;
  readonly costPerSecondMinor: number;
}

export type { Money };
