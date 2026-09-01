import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import { deepFreeze } from "../deep-freeze";
import type { VideoModelCapability, VideoModelCapabilityProvider } from "@app/domain";

/**
 * What the configured WaveSpeedAI OpenVideo model can actually do.
 *
 * Every value here is transcribed from the official WaveSpeedAI documentation
 * for `wavespeed-ai/open-video/image-to-video`, verified during Phase 4B-2a
 * review (ADR-0019). Nothing is inferred from the adapter's existing shape, from
 * another model, or from the model's name — the earlier version of this
 * repository sent three fields this endpoint does not document, which is exactly
 * the failure this descriptor exists to prevent.
 *
 * It lives beside the adapter rather than in the domain because these are
 * provider facts. The domain owns the *shape* of a capability and the rule
 * applied to it; the adapter package owns the values.
 *
 * **Deeply** frozen, not shallowly. This object is shared by reference with the
 * model catalog so the two cannot drift, which also means one mutation through
 * either reference poisons both — and `Object.freeze` would still hand out a
 * live `resolutions` array (ADR-0033).
 */

/** Documented request parameters, for the adapter and its tests to agree on. */
export const OPEN_VIDEO_REQUEST_FIELDS = ["image", "prompt", "duration", "resolution"] as const;

/** Documented optional parameter, sent only when a caller supplies one. */
export const OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS = ["seed"] as const;

/**
 * The verified capability of the configured OpenVideo model.
 *
 * Three declarations deserve their reasoning stated at the point of definition,
 * because each one refuses an easier and wrong alternative:
 *
 * - **`aspectRatios: COMPOSITION_OWNED`** — the documented parameter table has
 *   no `aspect_ratio`. Claiming `PROVIDER_HONORED` would be a lie; declaring
 *   `UNSUPPORTED` would refuse *every* project, since a `VideoProject` always
 *   carries an aspect ratio. Neither is honest *and* workable, so the guarantee
 *   moves: the ratio stays a durable request fact and Phase 5 normalizes the
 *   delivered video to it.
 * - **`negativePrompt: UNSUPPORTED`** — no `negative_prompt` parameter exists.
 *   A project carrying user negative text is refused at admission. It is never
 *   folded into the positive prompt, which would invert its meaning.
 * - **`cameraMotion: PROMPT_RENDERED`** — also no dedicated parameter, but the
 *   documentation states the prompt controls motion, and `CompiledPrompt`
 *   already carries camera motion as a scene fact. Phase 4B-2b's renderer
 *   expresses it through the documented `prompt` input, so this is **no longer
 *   a promise**: `capability.test.ts` asserts this declaration equals
 *   `PROMPT_RENDERED` only if `renderPrompt` demonstrably carries the motion
 *   and omits it when there is none. If a change stops the renderer carrying
 *   it, that test demands this line become `UNSUPPORTED` rather than allowing
 *   itself to be relaxed (ADR-0020 §3).
 */
export const OPEN_VIDEO_CAPABILITY: VideoModelCapability = deepFreeze({
  providerName: "wavespeed",
  providerModelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  // Documented as integer seconds, 3 through 20 inclusive (default 5).
  durationSeconds: { kind: "RANGE", minSeconds: 3, maxSeconds: 20 },
  // Documented output resolutions (default 480p).
  resolutions: ["480p", "720p", "1080p"],
  aspectRatios: { kind: "COMPOSITION_OWNED" },
  negativePrompt: { kind: "UNSUPPORTED" },
  cameraMotion: { kind: "PROMPT_RENDERED" },
} as const);

/**
 * The production capability provider.
 *
 * Deliberately static and single-model: the roadmap asks for a configurable
 * model, not for routing between several, and a selection mechanism nobody has
 * specified would be speculative surface on the one path that spends money.
 */
export function createOpenVideoCapabilityProvider(): VideoModelCapabilityProvider {
  return { current: () => OPEN_VIDEO_CAPABILITY };
}
