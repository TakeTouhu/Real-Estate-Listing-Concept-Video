import type { ProviderGenerationInput } from "../types";

/**
 * The only fal endpoint this adapter serves.
 *
 * Named as a constant and checked at submission time, so the adapter refuses a
 * request addressed anywhere else rather than confidently POSTing to a URL
 * assembled from an unverified id. `ADR-0033` froze this endpoint; nothing here
 * may widen it.
 */
export const FAL_H3_MAX_ENDPOINT_ID = "minimax/h3-max/image-to-video";

/** The official fal queue host. Injectable so tests never resolve it. */
export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

/**
 * Prompt expansion, frozen on.
 *
 * `balanced` is a **request-identity-relevant** setting: it changes what the
 * model is effectively asked for, so two requests that differ only in this
 * value are not the same paid request. It is deliberately not configurable in
 * this milestone — a knob here would let generated work change without the
 * frozen twelve-fact identity noticing, and deciding whether that needs a new
 * identity version or an additional frozen fact is the CTO's call, not a
 * default someone flips (ADR-0035).
 */
export const FAL_H3_MAX_PROMPT_EXPANSION_MODE = "balanced";

/** Safety checking, frozen on, for the same reason and with the same rule. */
export const FAL_H3_MAX_ENABLE_SAFETY_CHECKER = true;

export interface FalQueueRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

export function buildFalQueueSubmitUrl(baseUrl: string, endpointId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpointId}`;
}

/**
 * Build the H3 Max queue submission body.
 *
 * The body contains **only** parameters fal documents for this endpoint, and
 * the omissions are as deliberate as the inclusions:
 *
 * - **`resolution` carries the frozen native token verbatim.** For a 1080p
 *   product target on H3 Max that token is `768P`, because H3 Max generates at
 *   768P and the deliverable is an upscale. There is no translation step here
 *   and there must never be one: converting `768P` into `1080p` on the wire
 *   would ask for something the model does not offer and would quietly turn a
 *   recorded upscale into a claimed native render (ADR-0034).
 * - **No `aspect_ratio`.** H3 Max image-to-video follows the supplied image's
 *   ratio; the requested ratio is `COMPOSITION_OWNED` and Phase 5 delivers it.
 *   Inventing a field fal does not document would be guessing at a vendor API
 *   on the one path that spends money.
 * - **No `requestHash`, no `Idempotency-Key`.** The hash is this application's
 *   internal coordination key. fal documents no idempotency contract for queue
 *   submission, so sending it would imply a guarantee that does not exist —
 *   and duplicate-charge safety here comes from not re-POSTing, never from a
 *   token.
 * - **No `targetOutputResolution`, `resolutionNormalization` or
 *   `nativeMeetsTarget`.** Those are product facts about what was promised.
 *   A provider has no use for them and no business seeing them.
 * - **No webhook, no `end_image_url`, no sync mode.** None is in scope, and
 *   each would change what the queue does with the request.
 */
export function mapToFalH3MaxRequest(
  input: ProviderGenerationInput,
  baseUrl: string,
): FalQueueRequest {
  const body: Record<string, unknown> = {
    image_url: input.sourceImageUrl,
    prompt: input.prompt,
    duration: input.durationSeconds,
    // Verbatim. The frozen native token, not the product target.
    resolution: input.nativeGenerationResolution,
    prompt_expansion_mode: FAL_H3_MAX_PROMPT_EXPANSION_MODE,
    enable_safety_checker: FAL_H3_MAX_ENABLE_SAFETY_CHECKER,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  return { url: buildFalQueueSubmitUrl(baseUrl, input.modelId), body };
}

interface FalQueueSubmitEnvelope {
  readonly request_id?: unknown;
}

/**
 * The documented queue identifier, or `null`.
 *
 * Returns `null` rather than throwing because at this point the caller has
 * already received a 2xx and the answer feeds a certainty decision, not an
 * error path: a body this process cannot read is `SUBMISSION_UNKNOWN`, and
 * expressing that as an exception would invite a `catch` that treats it as a
 * failure to retry.
 *
 * **Only `request_id` is accepted.** Not the response URL, not `status_url`,
 * not the `x-fal-request-id` header, not `gateway_request_id`, and never the
 * internal `requestHash`. `request_id` is the identifier fal documents for
 * later status and result retrieval; substituting anything else would store a
 * handle that cannot find the work again.
 */
export function parseFalQueueRequestId(payload: unknown): string | null {
  const envelope = payload as FalQueueSubmitEnvelope;
  const id = envelope.request_id;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length === 0 ? null : id;
}
