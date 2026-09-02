import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import type { ProviderGenerationInput } from "../types";

/**
 * fal's queue host, frozen.
 *
 * Not configurable, and the superseded `baseUrl` constructor override is not
 * restored. Tests inject an `HttpClient` and never need a host, so the only
 * thing an override could do is send the fal credential somewhere fal does not
 * operate. A constant cannot be misconfigured.
 */
export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

/**
 * V2 generation semantics, frozen as adapter constants rather than runtime
 * configuration: both change what the model produces, so changing either is a
 * request-identity question for CTO review, not a deployment setting.
 */
export const FAL_H3_MAX_PROMPT_EXPANSION_MODE = "balanced";
export const FAL_H3_MAX_ENABLE_SAFETY_CHECKER = true;

export interface FalQueueRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * Map an internal request onto H3 Max's documented image-to-video fields.
 *
 * The executable model id comes from the catalog — this module defines no
 * endpoint constant of its own, so there is exactly one place the wire value
 * can be wrong.
 *
 * `resolution` carries `input.nativeGenerationResolution` **verbatim**. For the
 * H3 Max 1080p delivery path that is `768P`, and sending `1080p` would ask a
 * model that cannot produce it to try — then bill for whatever came back.
 * Nothing here parses, converts or interprets the token: the product target,
 * the normalization plan and `nativeMeetsTarget` are product facts that a
 * provider request is not the place for (ADR-0034), and composition owns the
 * conversion to a customer deliverable.
 */
export function mapToFalH3MaxRequest(input: ProviderGenerationInput): FalQueueRequest {
  const body: Record<string, unknown> = {
    image_url: input.sourceImageUrl,
    prompt: input.prompt,
    duration: input.durationSeconds,
    resolution: input.nativeGenerationResolution,
    prompt_expansion_mode: FAL_H3_MAX_PROMPT_EXPANSION_MODE,
    enable_safety_checker: FAL_H3_MAX_ENABLE_SAFETY_CHECKER,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  return { url: `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}`, body };
}

/**
 * Recover fal's documented `request_id`, or `null`.
 *
 * **Total** over arbitrary parsed JSON. A type assertion is a compile-time
 * claim that validates nothing at runtime, so the guard is a real check: a body
 * of `null`, a number, a string or an array must not raise a `TypeError` from
 * inside a submission whose failures must all be classified outcomes.
 *
 * `request_id` is the *only* acceptance handle. `response_url`, `status_url`,
 * `cancel_url` and `gateway_request_id` are deliberately not consulted — a
 * derived or adjacent identifier would let a body that never named the work be
 * treated as trackable.
 */
export function parseFalQueueRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const id = (payload as { request_id?: unknown }).request_id;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length === 0 ? null : trimmed;
}
