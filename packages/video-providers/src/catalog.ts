import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import type { VideoModelCatalog, VideoModelEntry } from "@app/domain";
import { OPEN_VIDEO_CAPABILITY } from "./wavespeed/capability";

/**
 * The model catalog's **values**.
 *
 * The domain owns the shape of a model entry and the rules applied to it; this
 * package owns what is actually true about each vendor, exactly as ADR-0019
 * split capability shape from capability values. Putting the entries here is
 * what keeps `packages/domain` free of fal, WaveSpeed, MiniMax and Google
 * specifics (ADR-0033).
 *
 * Two of the four entries are deliberately **not selectable**. They exist so
 * the selection seam, the catalog port and a future UI can be built and tested
 * against a genuinely multi-model catalog, while `planGenerationResolution`
 * refuses them until someone verifies the missing contracts. A model in this
 * file is not a claim that the product can run it.
 */

/**
 * MiniMax H3 Max, through fal — the current default.
 *
 * Native generation is `768P` and only `768P` in this configuration. The
 * product still offers 720p and 1080p deliverables, and the difference is the
 * whole reason the two-resolution split exists: 720p is a downscale from 768
 * lines and carries native detail; **1080p is an upscale from 768 lines and
 * does not**. `planGenerationResolution` reports that as
 * `nativeMeetsTarget: false`, and nothing in the product may describe it as
 * native 1080p.
 *
 * Aspect ratio is `COMPOSITION_OWNED`: fal documents image-to-video output as
 * following the source image, so the model honours no ratio parameter of ours
 * and composition normalizes to the project's ratio — the same ownership
 * OpenVideo already has, reached for a different reason.
 *
 * Duration is 5–15 seconds. Pricing is `null`: no authoritative fal pricing
 * contract has been transcribed, and a placeholder would reserve the wrong
 * number of credits while looking exactly like a real one.
 */
export const MINIMAX_H3_MAX_MODEL_ID = "minimax/h3-max/image-to-video";

const MINIMAX_H3_MAX: VideoModelEntry = Object.freeze({
  key: "minimax-h3-max",
  providerName: "fal",
  providerModelId: MINIMAX_H3_MAX_MODEL_ID,
  displayName: "MiniMax H3 Max",
  tier: "RECOMMENDED",
  recommended: true,
  capability: Object.freeze({
    providerName: "fal",
    providerModelId: MINIMAX_H3_MAX_MODEL_ID,
    durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
    // Native generation tokens, not product outputs. `480P` is documented and
    // available; `768P` is the default and what this product asks for.
    resolutions: ["480P", "768P"],
    aspectRatios: { kind: "COMPOSITION_OWNED" },
    negativePrompt: { kind: "UNSUPPORTED" },
    cameraMotion: { kind: "PROMPT_RENDERED" },
  } as const),
  nativeGeneration: { kind: "FIXED", native: { providerValue: "768P", heightPx: 768 } },
  targetOutputResolutions: ["720p", "1080p"],
  pricing: null,
  availability: { kind: "SELECTABLE" },
} as const);

/**
 * MiniMax H3 — the high-resolution alternative, **not yet selectable**.
 *
 * Its role is the case where 1080p detail must be genuinely native rather than
 * upscaled. That is exactly why it cannot be guessed at: its documented native
 * output is described as "2K", which has no single correct reading in lines,
 * and `NativeGenerationResolution` requires a number. Nothing here invents one.
 */
const MINIMAX_H3: VideoModelEntry = Object.freeze({
  key: "minimax-h3",
  providerName: "fal",
  providerModelId: "minimax/h3/image-to-video",
  displayName: "MiniMax H3",
  tier: "HIGH_RESOLUTION",
  recommended: false,
  capability: Object.freeze({
    providerName: "fal",
    providerModelId: "minimax/h3/image-to-video",
    durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
    resolutions: [],
    aspectRatios: { kind: "COMPOSITION_OWNED" },
    negativePrompt: { kind: "UNSUPPORTED" },
    cameraMotion: { kind: "UNSUPPORTED" },
  } as const),
  nativeGeneration: { kind: "FIXED", native: { providerValue: "2K", heightPx: 0 } },
  targetOutputResolutions: [],
  pricing: null,
  availability: {
    kind: "UNVERIFIED",
    missing: [
      "exact production endpoint",
      'native output resolution in lines (documented only as "2K")',
      "duration and aspect-ratio contract",
      "pricing contract",
    ],
  },
} as const);

/**
 * Veo 3.1 — the premium alternative, **not yet selectable**.
 *
 * Native 720p and 1080p would make it the model that needs no upscale for a
 * 1080p deliverable. Everything about it that this product would depend on —
 * endpoint, pricing, duration, audio behaviour, aspect-ratio behaviour and the
 * exact resolution variants — is unfrozen, and each is a way to spend money
 * incorrectly.
 */
const VEO_31: VideoModelEntry = Object.freeze({
  key: "veo-3-1",
  providerName: "fal",
  providerModelId: "google/veo-3.1/image-to-video",
  displayName: "Veo 3.1",
  tier: "PREMIUM",
  recommended: false,
  capability: Object.freeze({
    providerName: "fal",
    providerModelId: "google/veo-3.1/image-to-video",
    durationSeconds: { kind: "RANGE", minSeconds: 1, maxSeconds: 1 },
    resolutions: [],
    aspectRatios: { kind: "COMPOSITION_OWNED" },
    negativePrompt: { kind: "UNSUPPORTED" },
    cameraMotion: { kind: "UNSUPPORTED" },
  } as const),
  nativeGeneration: { kind: "FIXED", native: { providerValue: "unverified", heightPx: 0 } },
  targetOutputResolutions: [],
  pricing: null,
  availability: {
    kind: "UNVERIFIED",
    missing: [
      "exact endpoint and variant",
      "resolution variants this product would use",
      "duration contract",
      "audio behaviour",
      "aspect-ratio behaviour",
      "pricing contract",
    ],
  },
} as const);

/**
 * WaveSpeed/OpenVideo — the economy path, and the one already verified.
 *
 * Its capability descriptor is reused **by reference** from
 * `OPEN_VIDEO_CAPABILITY` rather than restated, so this catalog cannot drift
 * from the descriptor ADR-0019 froze. It is the only entry whose native policy
 * is `PER_TARGET`: it generates natively at both product outputs, so neither
 * needs normalization — which is precisely why the single `resolution` field
 * looked correct for as long as this was the only model.
 */
const WAVESPEED_OPEN_VIDEO: VideoModelEntry = Object.freeze({
  key: "wavespeed-open-video",
  providerName: "wavespeed",
  providerModelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  displayName: "WaveSpeed OpenVideo",
  tier: "ECONOMY",
  recommended: false,
  capability: OPEN_VIDEO_CAPABILITY,
  nativeGeneration: {
    kind: "PER_TARGET",
    byTarget: {
      "720p": { providerValue: "720p", heightPx: 720 },
      "1080p": { providerValue: "1080p", heightPx: 1080 },
    },
  },
  targetOutputResolutions: ["720p", "1080p"],
  pricing: null,
  availability: { kind: "SELECTABLE" },
} as const);

/** Stable order: recommended first, then by tier. */
const ENTRIES: readonly VideoModelEntry[] = Object.freeze([
  MINIMAX_H3_MAX,
  MINIMAX_H3,
  VEO_31,
  WAVESPEED_OPEN_VIDEO,
]);

/**
 * The production catalog.
 *
 * Constructing it performs no I/O and contacts no provider — it is a frozen
 * table. Nothing here selects a provider adapter or enables paid execution;
 * being the default *model* and being an executable *request* are different
 * things, and only the second costs money (ADR-0033).
 */
export function createVideoModelCatalog(): VideoModelCatalog {
  return {
    list: () => ENTRIES,
    default: () => MINIMAX_H3_MAX,
    find: (key: string) => ENTRIES.find((entry) => entry.key === key),
  };
}
