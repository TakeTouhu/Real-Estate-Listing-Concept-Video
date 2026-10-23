/**
 * Composition profile v2 — the frozen answer to "how are these clips encoded?"
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
 * ## What v2 adds to v1, and what neither does
 *
 * v1 composed the customer's video straight from the scenes. v2 makes the
 * overlay-free Clean Master from them first, at {@link CLEAN_MASTER_CRF}, and
 * the customer's video from the stored master, with disclosure layer v1 laid
 * over it as the version's mode requires (ADR-0075, ADR-0078). The raster, the
 * frame rate and the customer's video's encoder settings are v1's.
 *
 * Neither does a crop, a speed change, a transition beyond a hard cut, audio,
 * a logo or a watermark. Each of those is a product decision with its own
 * review, and several are legally meaningful.
 */

import { AppError } from "@app/shared";
import { isDisclosureMode } from "../disclosure/mode";
import type { TargetOutputResolution } from "../generation/model-catalog";
import type { CleanMasterRaster } from "./ports";

/** The versioned profile identity, persisted verbatim on every work row. */
export const COMPOSITION_PROFILE_KEY = "vtavision-compose:v2";

/**
 * The aspect ratios the profile can compose, v1's and v2's alike.
 *
 * A closed list, matching the product's supported delivery shapes. The column
 * it is compared against is free-form text on `GenerationJob`, snapshotted when
 * the job began, so a historical job may legitimately carry something outside
 * this list — and that job is simply not composable under this profile.
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

/**
 * Constant Rate Factor of the customer's video. One value in v1 and v2, and the
 * CHECK constraint pins it.
 */
export const COMPOSITION_CRF = 18;

/**
 * The Clean Master's Constant Rate Factor (ADR-0075 Decision 1).
 *
 * The master is encoded from the scenes with every other setting above, at a
 * higher quality than the customer's video, which is then encoded from it at
 * {@link COMPOSITION_CRF} with the disclosure laid over it. Measured on FFmpeg
 * 6.1.1 over three inputs, the two encodes together lost at most 0.25 dB of
 * PSNR against one encode at 18, and the master was 1.1 to 1.5 times the
 * customer's video: the approved plan's estimate that the master roughly
 * doubles what is kept per video.
 *
 * Not a column: the composer reads it for the master. Profile v2 binds it, so
 * changing it must be a new composition profile, never an edit in place.
 */
export const CLEAN_MASTER_CRF = 16;

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
 * Every `(aspect ratio, resolution)` pair the profile can compose, derived from
 * the same table {@link resolveCompositionProfile} reads.
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
   * The job's frozen aspect ratio or resolution is outside what the profile
   * composes. An ordinary outcome, not an error: the job was admitted legitimately under
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
 * Resolve the frozen job target into this build's profile, or refuse.
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
  const byResolution: object = RASTERS[target.targetAspectRatio];
  // `Object.hasOwn` before indexing, because the resolution is free-form text
  // snapshotted onto the job. A plain property read answers `"toString"`,
  // `"constructor"` and `"valueOf"` with something from `Object.prototype`
  // instead of `undefined`, and the table would appear to hold a raster for a
  // target nobody ever added to it.
  if (!Object.hasOwn(byResolution, target.targetOutputResolution)) {
    return { kind: "UNSUPPORTED_TARGET" };
  }
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
 * `true` when a Clean Master is the profile's frame size and frame rate, so the
 * disclosure image for that size, laid at the origin, covers it exactly
 * (ADR-0076 Decision 3).
 *
 * Exact: no rounding and no tolerance. A master of another size would come out
 * with the image cut off or misplaced, or, smaller than the image's ink, with no
 * disclosure at all. The frame rates are compared as fractions, so 60/2 is 30/1;
 * a fraction over zero is no rate at all, and 0/0, ffprobe's "unknown", would
 * otherwise equal every fraction.
 */
export function cleanMasterMatchesProfile(
  raster: CleanMasterRaster,
  profile: CompositionProfile,
): boolean {
  return (
    raster.frameRateDenominator > 0 &&
    raster.widthPx === profile.targetWidthPx &&
    raster.heightPx === profile.targetHeightPx &&
    raster.frameRateNumerator * profile.frameRateDenominator ===
      raster.frameRateDenominator * profile.frameRateNumerator
  );
}

/**
 * Whether a composition frozen under `profileKey` drew the disclosure of `mode`
 * over the customer's video (ADR-0080).
 *
 * Only v2 draws one: it lays the version's mode over every video it makes
 * (ADR-0078), and v1 drew none. A mode this build does not know was drawn by
 * nobody. Publication asks this of the composition's frozen key, never of
 * today's, so a v1 video verified before v2 is not published as if it carried
 * the disclosure.
 */
export function profileDrewDisclosure(profileKey: string, mode: unknown): boolean {
  return profileKey === COMPOSITION_PROFILE_KEY && isDisclosureMode(mode);
}

/**
 * Prove a profile read back from the database is still one this build can run.
 *
 * The profile is frozen per deliverable version and **retries must reuse the
 * persisted one**, so a v2 build reading a v1 row must not quietly re-derive v2
 * settings and encode a different video into the same deliverable. It refuses
 * instead, which turns a silent product change into an operational decision.
 *
 * @throws AppError CONFIGURATION_ERROR when the persisted profile is not this
 * build's (v2).
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
