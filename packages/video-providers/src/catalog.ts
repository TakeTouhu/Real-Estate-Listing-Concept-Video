import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import type {
  UnverifiedModelEntry,
  VerifiedModelEntry,
  VideoModelCatalog,
  VideoModelEntry,
} from "@app/domain";
import { deepFreeze } from "./deep-freeze";
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
 * Two of the four entries are `UNVERIFIED`. They are typed as
 * {@link UnverifiedModelEntry}, which **cannot hold** a `providerModelId`, a
 * capability, a native generation policy or pricing — so they carry identity
 * and a list of what is missing, and nothing that could be mistaken for a
 * transcribed fact. A provider model id is an executable address, and an
 * unverified entry has no business asserting one.
 *
 * Every value below is deeply frozen. `Object.freeze` alone would still hand a
 * consumer a live `nativeGenerationResolutions` array, and the OpenVideo
 * descriptor is shared
 * by reference with the capability provider.
 */

/**
 * MiniMax H3 Max, through fal — the current default.
 *
 * Verified facts only: the model generates natively at `480P` or `768P`,
 * `768P` is the default and what this product asks for, duration is 5–15
 * seconds, and image-to-video output follows the supplied image's aspect ratio
 * — which is why aspect ratio is `COMPOSITION_OWNED`: the model honours no
 * ratio parameter of ours, so composition normalizes to the project's.
 *
 * The delivery policy below is **stated, not calculated**. `768P` is not "768
 * pixels tall" independently of aspect ratio (at 16:9 fal documents it as
 * 1344×768), and `1080p` is a product quality class rather than a promise of
 * 1920×1080. So each target says explicitly what it gets: 720p is served from
 * a 768P generation and carries native detail; **1080p is served from the same
 * 768P generation and does not**. Nothing in the product may describe the
 * second as native 1080p.
 *
 * Pricing is `null`. No authoritative fal pricing contract has been
 * transcribed, and the current public price includes a time-limited launch
 * discount that must never become a durable production assumption.
 */
export const MINIMAX_H3_MAX_MODEL_ID = "minimax/h3-max/image-to-video";

/** The native token this product asks H3 Max for. `480P` is available and unused. */
const H3_MAX_NATIVE = { providerValue: "768P" } as const;

const MINIMAX_H3_MAX: VerifiedModelEntry = deepFreeze({
  key: "minimax-h3-max",
  providerName: "fal",
  providerModelId: MINIMAX_H3_MAX_MODEL_ID,
  displayName: "MiniMax H3 Max",
  tier: "RECOMMENDED",
  recommended: true,
  availability: { kind: "SELECTABLE" },
  capability: {
    providerName: "fal",
    providerModelId: MINIMAX_H3_MAX_MODEL_ID,
    durationSeconds: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
    // Native generation tokens, not product outputs.
    nativeGenerationResolutions: ["480P", "768P"],
    aspectRatios: { kind: "COMPOSITION_OWNED" },
    negativePrompt: { kind: "UNSUPPORTED" },
    // A claim about the renderer, pinned by a test — see ADR-0020.
    cameraMotion: { kind: "PROMPT_RENDERED" },
  },
  nativeGeneration: {
    byTarget: {
      "720p": {
        nativeGenerationResolution: H3_MAX_NATIVE,
        normalization: "DOWNSCALE",
        nativeMeetsTarget: true,
      },
      "1080p": {
        nativeGenerationResolution: H3_MAX_NATIVE,
        normalization: "UPSCALE",
        // The fact this whole separation exists to carry.
        nativeMeetsTarget: false,
      },
    },
  },
  pricing: null,
} as const);

/**
 * MiniMax H3 — the high-resolution alternative, **not yet verified**.
 *
 * Its role is the case where 1080p detail must be genuinely native rather than
 * upscaled, which is exactly why none of it may be guessed at. It carries no
 * `providerModelId`, no capability, no native policy and no pricing, because
 * the type forbids all four.
 *
 * That a route exists, and that fal currently describes 2K output for it, is
 * **research evidence** — enough to know the model is worth verifying, not
 * enough to be a product contract. The missing list names what is actually
 * unresolved; "the endpoint exists" is not among them.
 */
const MINIMAX_H3: UnverifiedModelEntry = deepFreeze({
  key: "minimax-h3",
  providerName: "fal",
  displayName: "MiniMax H3",
  tier: "HIGH_RESOLUTION",
  recommended: false,
  availability: {
    kind: "UNVERIFIED",
    missing: [
      "the exact capability contract this product would use",
      "native generation resolution policy for the product catalog",
      "duration, aspect-ratio and feature-delivery contract",
      "target-output delivery plan for 720p and 1080p",
      "verified pricing contract",
    ],
  },
} as const);

/**
 * Veo 3.1 — the premium alternative, **not yet verified**.
 *
 * Native 720p and 1080p would make it the model that needs no upscale for a
 * 1080p deliverable. The unresolved question is not whether an image-to-video
 * route exists — one does — but **which variant this product is verifying**:
 * fal publishes standard, Fast and other Veo 3.1 routes, and they differ in
 * exactly the ways that decide a paid request. Freezing one id here would
 * present a choice nobody has made as though it had been.
 */
const VEO_31: UnverifiedModelEntry = deepFreeze({
  key: "veo-3-1",
  providerName: "fal",
  displayName: "Veo 3.1",
  tier: "PREMIUM",
  recommended: false,
  availability: {
    kind: "UNVERIFIED",
    missing: [
      "production variant selection and frozen endpoint contract",
      "resolution variants this product would use",
      "duration contract",
      "audio behaviour",
      "aspect-ratio behaviour",
      "verified pricing contract",
    ],
  },
} as const);

/**
 * WaveSpeed/OpenVideo — the economy path, and the one already verified.
 *
 * Its capability descriptor is reused **by reference** from
 * `OPEN_VIDEO_CAPABILITY` rather than restated, so this catalog cannot drift
 * from the descriptor ADR-0019 froze. That sharing is why the descriptor itself
 * is deeply frozen at its source.
 *
 * It is the only entry needing no normalization at either target: it generates
 * natively at both, which is precisely why one `resolution` field looked
 * correct for as long as this was the only model.
 */
const WAVESPEED_OPEN_VIDEO: VerifiedModelEntry = deepFreeze({
  key: "wavespeed-open-video",
  providerName: "wavespeed",
  providerModelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  displayName: "WaveSpeed OpenVideo",
  tier: "ECONOMY",
  recommended: false,
  availability: { kind: "SELECTABLE" },
  capability: OPEN_VIDEO_CAPABILITY,
  nativeGeneration: {
    byTarget: {
      "720p": {
        nativeGenerationResolution: { providerValue: "720p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
      "1080p": {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
    },
  },
  pricing: null,
} as const);

/** Stable order: recommended first, then by tier. */
const ENTRIES: readonly VideoModelEntry[] = deepFreeze([
  MINIMAX_H3_MAX,
  MINIMAX_H3,
  VEO_31,
  WAVESPEED_OPEN_VIDEO,
]);

/**
 * The production catalog.
 *
 * Constructing it performs no I/O and contacts no provider — it is a frozen
 * table. Nothing here selects a provider adapter or enables paid execution:
 * `SELECTABLE` means eligible for product-level model selection against a
 * verified capability contract, and H3 Max is `SELECTABLE` while having no fal
 * adapter at all (ADR-0033).
 */
export function createVideoModelCatalog(): VideoModelCatalog {
  return {
    list: () => ENTRIES,
    default: () => MINIMAX_H3_MAX,
    find: (key: string) => ENTRIES.find((entry) => entry.key === key),
  };
}
