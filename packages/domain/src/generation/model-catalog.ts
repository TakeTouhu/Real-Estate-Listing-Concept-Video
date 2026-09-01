import { AppError } from "@app/shared";
import type { VideoModelCapability } from "./capability";

/**
 * The two-resolution vocabulary, and the reason it exists.
 *
 * Until now the system had one field called `resolution`, and it meant two
 * different things at once because for the only wired model they happened to
 * coincide: WaveSpeed/OpenVideo generates natively at `720p` and `1080p`, so
 * "what the customer asked for" and "what we send the model" were the same
 * string. That coincidence is not a design, and it breaks the moment a second
 * model exists. MiniMax H3 Max generates natively at `480P` or `768P` and at
 * nothing else — a request for a 1080p deliverable is still a 768P generation
 * followed by normalization, and a field that cannot say so will end up
 * claiming native 1080p detail that was never produced (ADR-0033).
 *
 * So the two concepts are named apart, permanently:
 *
 * - **{@link TargetOutputResolution}** — the product-level deliverable the
 *   customer asked for. A closed set, because it is a promise the product
 *   makes.
 * - **native generation resolution** — what the selected provider/model is
 *   actually asked to generate. Provider-specific, open, and never a product
 *   promise.
 *
 * Nothing here performs normalization. Composition owns that (Phase 5); this
 * module only records what would be required, so the fact is available before
 * anyone spends money on the assumption that it is free.
 */
export type TargetOutputResolution = "720p" | "1080p";

/**
 * Every supported product output, as a runtime authority.
 *
 * Ordered smallest-first so a caller iterating it gets a stable, meaningful
 * order rather than declaration order.
 */
export const TARGET_OUTPUT_RESOLUTIONS: readonly TargetOutputResolution[] = ["720p", "1080p"];

/** Height in lines for each product target, used to compare against native output. */
const TARGET_HEIGHT_PX: Record<TargetOutputResolution, number> = {
  "720p": 720,
  "1080p": 1080,
};

export function isTargetOutputResolution(value: unknown): value is TargetOutputResolution {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(TARGET_HEIGHT_PX, value)
  );
}

/**
 * One native generation resolution, as the provider names it **and** as a
 * number we can reason about.
 *
 * Both halves are transcribed from the provider's own contract. The label is
 * what goes on the wire (`"768P"`, not `"768p"`, if that is what the vendor
 * documents); `heightPx` is what makes "is this at least the target" answerable
 * without parsing vendor strings, which is guesswork dressed as arithmetic —
 * `"2K"` has no single correct reading, and a model whose native output cannot
 * be stated as a number simply does not get a policy until someone verifies it.
 */
export interface NativeGenerationResolution {
  /** Exactly the token the provider documents. Adapters send this verbatim. */
  readonly providerValue: string;
  /** Vertical lines the provider documents for that token. */
  readonly heightPx: number;
}

/**
 * How a model's native generation resolution is chosen for a requested target.
 *
 * `FIXED` is the H3 Max shape: one native resolution regardless of what the
 * customer asked for. `PER_TARGET` is the WaveSpeed shape: the model can
 * generate natively at each supported target, so no normalization is needed.
 */
export type NativeGenerationPolicy =
  | { readonly kind: "FIXED"; readonly native: NativeGenerationResolution }
  | {
      readonly kind: "PER_TARGET";
      readonly byTarget: Readonly<Record<TargetOutputResolution, NativeGenerationResolution>>;
    };

/**
 * Model pricing, present **only** when an authoritative provider contract has
 * been verified and transcribed.
 *
 * `null` is the honest state for a model whose pricing nobody has confirmed,
 * and it is deliberately not a placeholder number: a placeholder reserves the
 * wrong number of credits and looks exactly like a real one. The paid gate is
 * separately blocked until pricing is resolution-aware and verified for every
 * selectable model (ADR-0032, ADR-0033).
 */
export interface VerifiedModelPricing {
  readonly currency: string;
  /** Cost per second at each native generation resolution, in minor units. */
  readonly costPerSecondMinorByNative: Readonly<Record<string, number>>;
  /** Maximum billed duration the provider documents, in seconds. */
  readonly maxBilledSeconds: number;
  /** Where the numbers came from, so a reviewer can re-check them. */
  readonly verifiedFrom: string;
  readonly verifiedOn: string;
}

/**
 * Whether a model may be chosen for real work.
 *
 * `UNVERIFIED` carries what is missing rather than a bare flag, because the
 * list is the work item. A model can be present in the catalog — so the
 * selection seam and the UI can be built against it — while being impossible
 * to select, which is the state MiniMax H3 and Veo are in today.
 */
export type ModelAvailability =
  | { readonly kind: "SELECTABLE" }
  | { readonly kind: "UNVERIFIED"; readonly missing: readonly string[] };

/** Coarse product grouping, for a future selection UI. Not a routing rule. */
export type ModelTier = "RECOMMENDED" | "HIGH_RESOLUTION" | "PREMIUM" | "ECONOMY";

/**
 * One selectable (or not yet selectable) video model.
 *
 * Provider-neutral by construction: there is no fal field, no WaveSpeed field,
 * no MiniMax field and no Google field anywhere in this type. Adapters own the
 * translation from these facts to their own request payloads, which is what
 * keeps orchestration unchanged when a provider is added (ADR-0019, ADR-0033).
 */
export interface VideoModelEntry {
  /** Stable internal key. Never a provider id, so a vendor rename cannot move it. */
  readonly key: string;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly tier: ModelTier;
  /** Exactly one entry in a catalog is the default. */
  readonly recommended: boolean;
  readonly capability: VideoModelCapability;
  readonly nativeGeneration: NativeGenerationPolicy;
  readonly targetOutputResolutions: readonly TargetOutputResolution[];
  /** `null` until an authoritative pricing contract is verified. */
  readonly pricing: VerifiedModelPricing | null;
  readonly availability: ModelAvailability;
}

/** The port through which orchestration discovers and selects models. */
export interface VideoModelCatalog {
  /** Every entry, selectable or not, in a stable order. */
  list(): readonly VideoModelEntry[];
  /** The default/recommended model. */
  default(): VideoModelEntry;
  /** One entry by internal key, or `undefined`. */
  find(key: string): VideoModelEntry | undefined;
}

/**
 * What producing a given product output on a given model actually involves.
 *
 * The field that matters is {@link GenerationResolutionPlan.nativeMeetsTarget}.
 * When it is `false`, the delivered file can carry the requested pixel
 * dimensions but not the detail — H3 Max at a 1080p target is a 768-line
 * generation enlarged — and no part of the product may describe that as native
 * 1080p.
 */
export interface GenerationResolutionPlan {
  readonly targetOutputResolution: TargetOutputResolution;
  readonly nativeGenerationResolution: NativeGenerationResolution;
  /** What composition would have to do to reach the target. */
  readonly normalization: "NONE" | "DOWNSCALE" | "UPSCALE";
  /** Whether the native generation carries at least the target's detail. */
  readonly nativeMeetsTarget: boolean;
}

/**
 * Resolve the native generation resolution for a target, and say what reaching
 * that target would cost in normalization.
 *
 * **Refuses rather than guesses.** A model that is not `SELECTABLE`, or that
 * does not list the requested target, gets no plan — inventing one is how a
 * model with unverified capabilities ends up carrying a paid request. The
 * message names the model key and nothing else.
 */
export function planGenerationResolution(
  entry: VideoModelEntry,
  target: TargetOutputResolution,
): GenerationResolutionPlan {
  if (entry.availability.kind !== "SELECTABLE") {
    throw new AppError(
      "VALIDATION_FAILED",
      `The model ${entry.key} is not verified for selection`,
    );
  }
  if (!entry.targetOutputResolutions.includes(target)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The model ${entry.key} does not support the ${target} output`,
    );
  }

  const native =
    entry.nativeGeneration.kind === "FIXED"
      ? entry.nativeGeneration.native
      : entry.nativeGeneration.byTarget[target];

  const targetHeight = TARGET_HEIGHT_PX[target];
  const normalization =
    native.heightPx === targetHeight
      ? "NONE"
      : native.heightPx > targetHeight
        ? "DOWNSCALE"
        : "UPSCALE";

  return {
    targetOutputResolution: target,
    nativeGenerationResolution: native,
    normalization,
    // Equal counts as met; only a shortfall does not.
    nativeMeetsTarget: native.heightPx >= targetHeight,
  };
}
