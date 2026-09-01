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
 *   makes. It names a **quality class**, not a raster size: this service
 *   supports multiple aspect ratios, including future vertical and square
 *   media, so `1080p` must not be read as "1920×1080".
 * - **native generation resolution** — the provider's own token for what the
 *   model is asked to generate. Deliberately **opaque** (see
 *   {@link NativeGenerationResolution}).
 *
 * Nothing here performs normalization. Composition owns that (Phase 5); this
 * module only records what would be required, so the fact is available before
 * anyone spends money on the assumption that it is free.
 */
export type TargetOutputResolution = "720p" | "1080p";

/** Every supported product output, as a runtime authority. Smallest first. */
export const TARGET_OUTPUT_RESOLUTIONS: readonly TargetOutputResolution[] = ["720p", "1080p"];

const TARGET_MEMBERSHIP: Record<TargetOutputResolution, true> = {
  "720p": true,
  "1080p": true,
};

export function isTargetOutputResolution(value: unknown): value is TargetOutputResolution {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(TARGET_MEMBERSHIP, value)
  );
}

/**
 * A provider's own name for a generation resolution — and **nothing else**.
 *
 * It is opaque on purpose. An earlier revision of this milestone paired the
 * token with a `heightPx` and compared it arithmetically against an assumed
 * target height, which is wrong twice over. `768P` is not "video height 768"
 * independently of aspect ratio: fal documents 768P at 16:9 as 1344×768, and
 * image-to-video output follows the supplied image's ratio, so the raster size
 * varies with the source. And a product label like `1080p` is a quality class,
 * not a promise of 1920×1080. Deriving a relationship by parsing vendor strings
 * or assuming a height is inference dressed as arithmetic.
 *
 * The relationship between a model and a product target is therefore **stated**
 * per model, per target — see {@link NativeGenerationPolicy}.
 */
export interface NativeGenerationResolution {
  /** Exactly the token the provider documents. Adapters send it verbatim. */
  readonly providerValue: string;
}

/**
 * What producing one product target on one model actually involves.
 *
 * `nativeMeetsTarget` is the load-bearing field. When it is `false` the
 * delivered file can carry the requested dimensions but not the detail — H3 Max
 * at a 1080p target is a 768P generation enlarged — and no part of the product
 * may describe that as native 1080p.
 */
export interface TargetResolutionDelivery {
  readonly nativeGenerationResolution: NativeGenerationResolution;
  /** What composition would have to do. Recorded here, performed in Phase 5. */
  readonly normalization: "NONE" | "DOWNSCALE" | "UPSCALE";
  readonly nativeMeetsTarget: boolean;
}

/**
 * Which product targets a model serves, and how it serves each one.
 *
 * A partial map on purpose: a model that serves only some targets says so by
 * omission, and the present keys **are** the list of supported outputs — one
 * declaration rather than a separate array that can disagree with it.
 */
export interface NativeGenerationPolicy {
  readonly byTarget: Readonly<Partial<Record<TargetOutputResolution, TargetResolutionDelivery>>>;
}

/**
 * Model pricing, present **only** when an authoritative provider contract has
 * been verified and transcribed.
 *
 * `null` is the honest state for a model whose pricing nobody has confirmed,
 * and it is deliberately not a placeholder number: a placeholder reserves the
 * wrong number of credits and looks exactly like a real one. A time-limited
 * launch discount must never become a durable production assumption.
 */
export interface VerifiedModelPricing {
  readonly currency: string;
  /** Cost per second keyed by the provider's own native token. */
  readonly costPerSecondMinorByNative: Readonly<Record<string, number>>;
  readonly maxBilledSeconds: number;
  /** Where the numbers came from, so a reviewer can re-check them. */
  readonly verifiedFrom: string;
  readonly verifiedOn: string;
}

/** Coarse product grouping, for a future selection UI. Not a routing rule. */
export type ModelTier = "RECOMMENDED" | "HIGH_RESOLUTION" | "PREMIUM" | "ECONOMY";

/**
 * What every catalog entry carries, verified or not: who it is, never what it
 * can do.
 */
export interface ModelEntryIdentity {
  /** Stable internal key. Never a provider id, so a vendor rename cannot move it. */
  readonly key: string;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly tier: ModelTier;
  /** Exactly one entry in a catalog is the default. */
  readonly recommended: boolean;
}

/**
 * A model whose operational contract has been read from the provider's
 * documentation and transcribed.
 *
 * `SELECTABLE` means **eligible for product-level model selection against a
 * verified capability contract**. It does *not* mean paid execution is
 * reachable: that is separately gated by adapter availability, provider
 * configuration, verified pricing, the future paid gate, and orchestration
 * readiness — none of which exist yet. H3 Max is `SELECTABLE` and has no fal
 * adapter at all.
 */
export interface VerifiedModelEntry extends ModelEntryIdentity {
  readonly availability: { readonly kind: "SELECTABLE" };
  readonly capability: VideoModelCapability;
  readonly nativeGeneration: NativeGenerationPolicy;
  /** `null` until an authoritative pricing contract is verified. */
  readonly pricing: VerifiedModelPricing | null;
}

/**
 * A model that is known about but whose contract has not been verified.
 *
 * It carries identity and the list of what is missing — the list is the work
 * item — and **structurally cannot carry operational facts**. The optional
 * `never` members are the mechanism: omitting them is fine, supplying any value
 * is a type error. An earlier revision filled these with placeholders
 * (`heightPx: 0`, a 1-to-1-second duration range, a literal `"unverified"`
 * token) purely to satisfy a single wide interface, and argued they were safe
 * because `planGenerationResolution` refused the entry. Unreachable fabricated
 * data is still fabricated data: it reads as fact to the next person, and the
 * type system should make it impossible rather than a convention.
 */
export interface UnverifiedModelEntry extends ModelEntryIdentity {
  readonly availability: { readonly kind: "UNVERIFIED"; readonly missing: readonly string[] };
  readonly capability?: never;
  readonly nativeGeneration?: never;
  readonly pricing?: never;
}

export type VideoModelEntry = VerifiedModelEntry | UnverifiedModelEntry;

/**
 * Narrow to a verified entry.
 *
 * A function rather than an inline check because the discriminant lives one
 * level down, on `availability.kind`, and TypeScript does not narrow a union
 * through a nested property access.
 */
export function isSelectableModel(entry: VideoModelEntry): entry is VerifiedModelEntry {
  return entry.availability.kind === "SELECTABLE";
}

/** The product outputs a model serves — the keys of its stated policy. */
export function supportedTargetOutputResolutions(
  entry: VideoModelEntry,
): readonly TargetOutputResolution[] {
  if (!isSelectableModel(entry)) return [];
  return TARGET_OUTPUT_RESOLUTIONS.filter(
    (target) => entry.nativeGeneration.byTarget[target] !== undefined,
  );
}

/** The port through which orchestration discovers and selects models. */
export interface VideoModelCatalog {
  /** Every entry, verified or not, in a stable order. */
  list(): readonly VideoModelEntry[];
  /** The default/recommended model. */
  default(): VerifiedModelEntry;
  /** One entry by internal key, or `undefined`. */
  find(key: string): VideoModelEntry | undefined;
}

/**
 * Look up how this model delivers this product target.
 *
 * A lookup, not a calculation. Nothing is inferred from the provider's token,
 * and nothing assumes a raster height — the answer was stated by whoever
 * transcribed the model's contract.
 *
 * **Refuses rather than guessing.** An unverified model has no operational
 * facts to consult (it cannot even hold them), and a target the policy does not
 * mention is unsupported. The message names the model key and nothing else.
 */
export function planGenerationResolution(
  entry: VideoModelEntry,
  target: TargetOutputResolution,
): TargetResolutionDelivery {
  if (!isSelectableModel(entry)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The model ${entry.key} is not verified for selection`,
    );
  }

  const delivery = entry.nativeGeneration.byTarget[target];
  if (delivery === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The model ${entry.key} does not support the ${target} output`,
    );
  }
  return delivery;
}
