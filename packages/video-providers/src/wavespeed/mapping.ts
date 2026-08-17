import { ProviderErrorException, providerError } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationState,
} from "../types";

/**
 * NOTE: The exact WaveSpeedAI request/response shapes, model capabilities, and
 * status vocabulary are treated as CANDIDATES and must be verified against the
 * official WaveSpeedAI documentation before production (WaveSpeedAIIntegration.md,
 * ADR-0003). These pure functions isolate that mapping so it can be corrected
 * in one place and covered by fixtures.
 */

export interface WaveSpeedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

export function buildSubmitUrl(baseUrl: string, modelId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${modelId}`;
}

/**
 * Build the OpenVideo submission request.
 *
 * The body contains **only** parameters the selected model documents:
 * `image`, `prompt`, `duration`, `resolution`, and `seed` when a caller supplies
 * one. Nothing else is sent, and the omissions are the point of this function
 * rather than an oversight:
 *
 * - **`aspect_ratio`** — not a documented parameter. The requested ratio is
 *   still a durable request fact and part of the request identity; it is
 *   `COMPOSITION_OWNED`, so Phase 5 normalizes the delivered video to it
 *   (ADR-0019). Sending an undocumented field would be guessing at the vendor's
 *   API on the one path that spends money.
 * - **`negative_prompt`** — not documented. A project carrying user negative
 *   text is refused at admission instead, and the text is never folded into
 *   `prompt`, which would invert its meaning.
 * - **`camera_motion`** — not documented. Motion intent is `PROMPT_RENDERED`:
 *   Phase 4B-2b expresses it through the documented `prompt` input.
 * - **`preset`** — appears in a Quick Start example but not in the parameter
 *   table, so its contract is unresolved. An example is not a specification.
 *
 * The submit URL is built from **`input.modelId`**, never from configuration.
 * That is what lets an already-admitted generation execute against the model it
 * was admitted under, even if the configured default changes afterwards.
 */
export function mapToWaveSpeedRequest(
  input: ProviderGenerationInput,
  baseUrl: string,
): WaveSpeedRequest {
  const body: Record<string, unknown> = {
    image: input.sourceImageUrl,
    prompt: input.prompt,
    duration: input.durationSeconds,
    resolution: input.resolution,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  return { url: buildSubmitUrl(baseUrl, input.modelId), body };
}

interface WaveSpeedEnvelope {
  readonly data?: {
    readonly id?: string;
    readonly status?: string;
    readonly outputs?: unknown;
    readonly urls?: { readonly get?: string };
  };
  readonly id?: string;
  readonly status?: string;
}

export function parsePredictionId(payload: unknown): string {
  const env = payload as WaveSpeedEnvelope;
  const id = env.data?.id ?? env.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ProviderErrorException(
      providerError({
        kind: "PROVIDER",
        code: "WAVESPEED_MISSING_PREDICTION_ID",
        messageSanitized: "WaveSpeedAI response did not contain a prediction id",
        retryable: false,
      }),
    );
  }
  return id;
}

/**
 * Map provider status strings into the normalized state machine. Unknown
 * states are treated as non-terminal (PROCESSING) so a bounded poller keeps
 * waiting, then times out into manual investigation.
 */
export function normalizeWaveSpeedState(raw: string | undefined): ProviderGenerationState {
  switch ((raw ?? "").toLowerCase()) {
    case "created":
    case "queued":
    case "pending":
    case "starting":
      return "QUEUED";
    case "processing":
    case "running":
    case "in_progress":
      return "PROCESSING";
    case "completed":
    case "succeeded":
    case "success":
      return "SUCCEEDED";
    case "failed":
    case "error":
      return "FAILED_TERMINAL";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    case "timeout":
    case "timed_out":
      return "TIMED_OUT";
    default:
      return "PROCESSING";
  }
}

export function extractOutputUrl(payload: unknown): string | undefined {
  const env = payload as WaveSpeedEnvelope;
  const outputs = env.data?.outputs;
  if (Array.isArray(outputs) && typeof outputs[0] === "string") return outputs[0];
  if (typeof outputs === "string") return outputs;
  return undefined;
}

/** Map an HTTP status code from the provider into a normalized error. */
export function normalizeHttpStatusError(status: number, bodySummary: string): ProviderError {
  if (status === 401 || status === 403) {
    return providerError({
      kind: "AUTH",
      code: "WAVESPEED_AUTH_FAILED",
      messageSanitized: "WaveSpeedAI authentication failed",
    });
  }
  if (status === 400 || status === 422) {
    return providerError({
      kind: "INVALID_INPUT",
      code: "WAVESPEED_INVALID_INPUT",
      messageSanitized: "WaveSpeedAI rejected the request as invalid",
    });
  }
  if (status === 429) {
    return providerError({
      kind: "RATE_LIMITED",
      code: "WAVESPEED_RATE_LIMITED",
      messageSanitized: "WaveSpeedAI rate limit exceeded",
    });
  }
  if (status >= 500) {
    return providerError({
      kind: "PROVIDER",
      code: "WAVESPEED_SERVER_ERROR",
      messageSanitized: "WaveSpeedAI returned a server error",
      retryable: true,
    });
  }
  return providerError({
    kind: "PROVIDER",
    code: "WAVESPEED_UNEXPECTED_STATUS",
    messageSanitized: `WaveSpeedAI returned unexpected status ${status}: ${bodySummary}`,
    retryable: false,
  });
}

/** Normalize an arbitrary thrown value (e.g. fetch/network failure). */
export function normalizeWaveSpeedError(error: unknown): ProviderError {
  if (error && typeof error === "object" && "kind" in error && "retryable" in error) {
    return error as ProviderError;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") {
    return providerError({
      kind: "TIMEOUT",
      code: "WAVESPEED_TIMEOUT",
      messageSanitized: "WaveSpeedAI request timed out",
    });
  }
  return providerError({
    kind: "NETWORK",
    code: "WAVESPEED_NETWORK_ERROR",
    messageSanitized: "Network error contacting WaveSpeedAI",
    cause: error,
  });
}
