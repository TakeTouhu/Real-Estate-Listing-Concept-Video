/**
 * Composition profile v1 — the frozen answer to "how are these clips encoded?"
 *
 * Phase 5A froze *which* scene renditions belong to a deliverable. This freezes
 * *how* they become one file, and it is deliberately a small closed table rather
 * than a computation.
 *
 * ## Application-owned, never inferred
 *
 * Nothing here is derived from a provider, a model id, a capability descriptor
 * or the source media's own properties. A profile inferred from the provider
 * would change under the customer's feet the day a model's native output
 * changed, and two deliverables of the same job would encode differently for a
 * reason nobody chose. The profile is the platform's product decision, it is
 * versioned, and it is frozen onto the composition work row the first time that
 * row is created (see `durable.ts`).
 *
 * ## The raster table is exhaustive, not a formula
 *
 * Six combinations, written out. A formula over a free-form aspect string is
 * how `21:9` silently becomes 16:9 — a letterboxed delivery the customer never
 * agreed to, produced by rounding. An unsupported combination refuses instead,
 * and refusing is the whole point: Phase 5B has no authority to reinterpret what
 * a job was admitted under.
 *
 * ## What v1 deliberately does not do
 *
 * No crop, no speed change, no transitions beyond a hard cut, no audio, no
 * overlay, no watermark, no disclosure burn-in. Each of those is a product
 * decision with its own review, and several are legally meaningful. v1 composes
 * exactly what was planned and nothing else.
 */

import { AppError } from "@app/shared";
import type { TargetOutputResolution } from "../generation/model-catalog";

/** The versioned profile identity, persisted verbatim on every work row. */
export const COMPOSITION_PROFILE_KEY = "vtavision-compose:v1";

/**
 * The aspect ratios v1 can compose.
 *
 * A closed list, matching the product's supported delivery shapes. The column
 * it is compared against is free-form text on `GenerationJob`, snapshotted when
 * the job began, so a historical job may legitimately carry something outside
 * this list — and that job is simply not composable under v1.
 */
export const COMPOSABLE_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type ComposableAspectRatio = (typeof COMPOSABLE_ASPECT_RATIOS)[number];

/** Closed encoder vocabularies. Persisted as text, constrained by CHECK. */
export const COMPOSITION_VIDEO_CODEC = "h264";
export const COMPOSITION_PIXEL_FORMAT = "yuv420p";
export const COMPOSITION_FIT_MODE = "CONTAIN_PAD";
export const COMPOSITION_TRANSITION_MODE = "HARD_CUT";
export const COMPOSITION_AUDIO_MODE = "DROP_ALL";
export const COMPOSITION_ENCODER_PRESET = "medium";

/** Constant frame rate, as an exact rational so nothing rounds it later. */
export const COMPOSITION_FRAME_RATE_NUMERATOR = 30;
export const COMPOSITION_FRAME_RATE_DENOMINATOR = 1;

/** Constant Rate Factor. One value in v1, and the CHECK constraint pins it. */
export const COMPOSITION_CRF = 18;

/**
 * The exhaustive raster table.
 *
 * Every dimension is even, which `yuv420p` requires: chroma is subsampled by
 * two on both axes, so an odd dimension is not encodable at all. That is a
 * property of the format rather than a preference, and the migration asserts it
 * on the persisted columns too.
 */
const RASTERS: Readonly<
  Record<ComposableAspectRatio, Readonly<Record<TargetOutputResolution, readonly [number, number]>>>
> = {
  "16:9": { "720p": [1280, 720], "1080p": [1920, 1080] },
  "9:16": { "720p": [720, 1280], "1080p": [1080, 1920] },
  "1:1": { "720p": [720, 720], "1080p": [1080, 1080] },
};

/**
 * Every `(aspect ratio, resolution)` pair v1 can compose, derived from the same
 * table {@link resolveCompositionProfile} reads.
 *
 * Exported so candidate discovery can exclude a job whose frozen target this
 * profile version cannot deliver, without a second hand-written copy of the
 * list living in SQL. A copy would drift the first time the raster table gained
 * an entry, and the symptom would be a queue that keeps offering work every
 * claim refuses — the starvation the bounded batch exists to prevent.
 */
export const COMPOSABLE_TARGETS: readonly {
  readonly targetAspectRatio: string;
  readonly targetOutputResolution: string;
}[] = Object.entries(RASTERS).flatMap(([targetAspectRatio, byResolution]) =>
  Object.keys(byResolution).map((targetOutputResolution) => ({
    targetAspectRatio,
    targetOutputResolution,
  })),
);

/** The frozen encoder settings for one deliverable version. */
export interface CompositionProfile {
  readonly profileKey: string;
  readonly targetWidthPx: number;
  readonly targetHeightPx: number;
  readonly frameRateNumerator: number;
  readonly frameRateDenominator: number;
  readonly videoCodec: string;
  readonly pixelFormat: string;
  readonly fitMode: string;
  readonly transitionMode: string;
  readonly audioMode: string;
  readonly encoderPreset: string;
  readonly crf: number;
}

/** What resolving a job's frozen delivery target concluded. Closed. */
export type CompositionProfileOutcome =
  | { readonly kind: "RESOLVED"; readonly profile: CompositionProfile }
  /**
   * The job's frozen aspect ratio or resolution is outside what v1 composes.
   * An ordinary outcome, not an error: the job was admitted legitimately under
   * a target this profile version cannot deliver, and saying so is more honest
   * than approximating it.
   */
  | { readonly kind: "UNSUPPORTED_TARGET" };

export function isComposableAspectRatio(value: unknown): value is ComposableAspectRatio {
  return (
    typeof value === "string" &&
    (COMPOSABLE_ASPECT_RATIOS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the frozen job target into the v1 profile, or refuse.
 *
 * Refuses rather than normalizes. A blank string, `21:9`, `16 : 9`, `HD` and an
 * unknown resolution all take the same path: `UNSUPPORTED_TARGET`. There is no
 * trimming, no case folding and no nearest-match, because each of those is a
 * decision about what the customer receives that this function is not entitled
 * to make.
 */
export function resolveCompositionProfile(target: {
  readonly targetAspectRatio: string;
  readonly targetOutputResolution: string;
}): CompositionProfileOutcome {
  if (!isComposableAspectRatio(target.targetAspectRatio)) {
    return { kind: "UNSUPPORTED_TARGET" };
  }
  const byResolution = RASTERS[target.targetAspectRatio];
  const raster = (byResolution as Record<string, readonly [number, number] | undefined>)[
    target.targetOutputResolution
  ];
  if (raster === undefined) return { kind: "UNSUPPORTED_TARGET" };

  const [targetWidthPx, targetHeightPx] = raster;
  return {
    kind: "RESOLVED",
    profile: {
      profileKey: COMPOSITION_PROFILE_KEY,
      targetWidthPx,
      targetHeightPx,
      frameRateNumerator: COMPOSITION_FRAME_RATE_NUMERATOR,
      frameRateDenominator: COMPOSITION_FRAME_RATE_DENOMINATOR,
      videoCodec: COMPOSITION_VIDEO_CODEC,
      pixelFormat: COMPOSITION_PIXEL_FORMAT,
      fitMode: COMPOSITION_FIT_MODE,
      transitionMode: COMPOSITION_TRANSITION_MODE,
      audioMode: COMPOSITION_AUDIO_MODE,
      encoderPreset: COMPOSITION_ENCODER_PRESET,
      crf: COMPOSITION_CRF,
    },
  };
}

/**
 * Prove a profile read back from the database is still one this build can run.
 *
 * The profile is frozen per deliverable version and **retries must reuse the
 * persisted one**, so a v2 build reading a v1 row must not quietly re-derive v2
 * settings and encode a different video into the same deliverable. It refuses
 * instead, which turns a silent product change into an operational decision.
 *
 * @throws AppError CONFIGURATION_ERROR when the persisted profile is not v1.
 */
export function assertRunnableProfile(profile: CompositionProfile): CompositionProfile {
  if (profile.profileKey !== COMPOSITION_PROFILE_KEY) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "This build cannot execute the composition profile frozen on that deliverable version",
    );
  }
  return profile;
}
