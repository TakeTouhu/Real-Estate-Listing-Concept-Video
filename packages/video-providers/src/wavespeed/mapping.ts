import { ProviderErrorException, isHttpStatus, providerError } from "../errors";
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
    // The provider's own wire field, fed from the domain's explicitly-named
    // native token. The rename stops here: `resolution` is what OpenVideo
    // documents, and an adapter's job is to speak the vendor's vocabulary
    // rather than to export it inwards (ADR-0034).
    resolution: input.nativeGenerationResolution,
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

/**
 * Map an HTTP status code from the provider into a normalized error.
 *
 * **The response body is not an input.** It used to be: the unexpected-status
 * branch interpolated the first 120 raw bytes of the provider's response into
 * `messageSanitized`, which the type documents as carrying no raw provider
 * payload and which is bound for the persisted `normalizedErrorMessage` column.
 * A provider that echoes the parameter it rejected would have written the
 * signed source image URL into the database. Every message here is now fixed
 * application text, and the only interpolated value is the status itself —
 * admitted solely because `isHttpStatus` proves it is an integer in 100–599
 * before it reaches a template (ADR-0031).
 *
 * The status→kind and retryable mappings below are **unchanged** by this
 * milestone. Whether a given status means the provider definitively did not
 * accept the submission is Phase 4C-3B-2's subject, not sanitization's.
 */
export function normalizeHttpStatusError(status: number): ProviderError {
  const providerStatus = isHttpStatus(status) ? status : undefined;
  if (status === 401 || status === 403) {
    return providerError({
      kind: "AUTH",
      code: "WAVESPEED_AUTH_FAILED",
      messageSanitized: "WaveSpeedAI authentication failed",
      providerStatus,
    });
  }
  if (status === 400 || status === 422) {
    return providerError({
      kind: "INVALID_INPUT",
      code: "WAVESPEED_INVALID_INPUT",
      messageSanitized: "WaveSpeedAI rejected the request as invalid",
      providerStatus,
    });
  }
  if (status === 429) {
    return providerError({
      kind: "RATE_LIMITED",
      code: "WAVESPEED_RATE_LIMITED",
      messageSanitized: "WaveSpeedAI rate limit exceeded",
      providerStatus,
    });
  }
  if (status >= 500) {
    return providerError({
      kind: "PROVIDER",
      code: "WAVESPEED_SERVER_ERROR",
      messageSanitized: "WaveSpeedAI returned a server error",
      retryable: true,
      providerStatus,
    });
  }
  return providerError({
    kind: "PROVIDER",
    code: "WAVESPEED_UNEXPECTED_STATUS",
    messageSanitized:
      providerStatus === undefined
        ? "WaveSpeedAI returned an unexpected HTTP status"
        : `WaveSpeedAI returned an unexpected HTTP status ${providerStatus}`,
    retryable: false,
    providerStatus,
  });
}

/**
 * Normalize an arbitrary thrown value (e.g. fetch/network failure).
 *
 * Two things it deliberately does **not** do.
 *
 * It does not retain the thrown value. `cause: error` used to travel out of
 * here on every network failure, and Node's `fetch` rejection chain routinely
 * carries the host, address and port it failed to reach. The provider boundary
 * drops arbitrary external diagnostic content outright rather than trying to
 * filter it; richer telemetry would need its own closed schema first.
 *
 * It has **no pass-through for a plain object that looks normalized**, and that
 * absence is the correction that closed the last hole. Recognising an
 * already-normalized error by its shape — even validating every field's type
 * and rebuilding a clean object — proves only that a value has the right form.
 * It cannot prove the value came from this application, so a hostile object
 * with a valid `kind`, a boolean `retryable`, and a signed URL sitting in
 * `messageSanitized` passed straight through and chose both public diagnostic
 * strings. Arbitrary input may influence only the **classification** this
 * module picks, never the text.
 *
 * The one legitimate pass-through is nominal and lives one level up:
 * `WaveSpeedVideoProvider.normalizeError` returns `error.error` for an
 * `instanceof ProviderErrorException`, which this application constructed
 * (ADR-0031 §4).
 */
export function normalizeWaveSpeedError(error: unknown): ProviderError {
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
  });
}
