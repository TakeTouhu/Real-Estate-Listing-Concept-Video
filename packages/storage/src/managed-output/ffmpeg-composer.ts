/**
 * The dormant `ffmpeg`-backed deliverable composer.
 *
 * ## No shell, ever
 *
 * Invoked through the same injected `ProcessRunner` seam the media inspector
 * uses, which launches the program directly with no shell. There is no command *string*
 * anywhere in this module — nothing is interpolated, quoted or escaped, because
 * nothing is parsed by a shell. Every variable element is either a path this
 * process created inside its own temporary directory, or a value taken from the
 * frozen composition profile, which the composer checks against the settings it
 * implements before building anything. No customer text, prompt, filename,
 * bucket, key or provider URL is ever an argument.
 *
 * ## The filter graph, and why each part is there
 *
 * Per input, in order:
 *
 * ```text
 * fps=30                          constant rate; concat needs one timebase
 * scale=W:H:force_original_aspect_ratio=decrease   contain, never crop
 * pad=W:H:(ow-iw)/2:(oh-ih)/2:black                letterbox to the exact raster
 * setsar=1                        square pixels, so players do not re-stretch
 * tpad=stop_mode=clone:stop_duration=D             hold the last frame if short
 * trim=duration=D + setpts=PTS-STARTPTS            exact length, timeline reset
 * ```
 *
 * then one `concat` with `a=0`.
 *
 * `force_original_aspect_ratio=decrease` with a pad is the whole no-crop policy:
 * a 9:16 source delivered into a 16:9 raster is shown whole with black at the
 * sides, never centre-cropped. Cropping decides for the customer which part of
 * their property photo is worth keeping, and this phase has no authority to make
 * that decision.
 *
 * `tpad` then `trim` is deliberately both: a source shorter than its scene holds
 * its final frame rather than cutting early, and a longer one is trimmed. The
 * result is exactly `snapshotDurationSeconds` either way, so the concatenated
 * length is the duration the customer was admitted for. Playback speed is never
 * changed — a time-stretched walkthrough is a different video, not a fitted one.
 *
 * `setpts=PTS-STARTPTS` before `concat` because concat demands each segment's
 * timeline start at zero; without it the second clip's timestamps continue the
 * first's and players see a stream that jumps.
 *
 * ## Audio is dropped, not mixed
 *
 * `-an`, and `a=0` in the concat. Provider clips may carry incidental audio
 * nobody reviewed; a deliverable that plays unexpected sound in an estate
 * agent's office is a product decision, not a default.
 *
 * ## Nothing from an input's container
 *
 * `-map_metadata -1` and `-map_chapters -1`. FFmpeg otherwise copies the first
 * input's title, comment and chapters into the output, and an mp4 holds a
 * chapter as a track of its own: a provider clip's tags would reach the Clean
 * Master and then the customer's video. Both options, because the first alone
 * still copies the chapter, only without its title.
 *
 * ## The Clean Master, then the disclosure (ADR-0075)
 *
 * `composeCleanMaster` runs the same graph as `compose` at the master's higher
 * quality, `CLEAN_MASTER_CRF`, and lays nothing over it. `applyDisclosure` then
 * encodes the customer's video from a Clean Master with the profile's own
 * settings, laying the committed disclosure image for the frame size over it at
 * the origin:
 *
 * ```text
 * [0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p
 * ```
 *
 * the image looped as the second input, the method ADR-0072 measured. Before
 * every run the image is read from the deployment's copy of `assets/disclosure/`
 * and its SHA-256 compared with the one `DISCLOSURE_LAYER_ASSETS` pins; FFmpeg
 * then reads a private copy of those bytes, never the deployment's file, so the
 * image laid over a video is the image that was reviewed, whatever the worker
 * image carries or does while the encode runs. There is no fallback: a missing
 * or different image, or a frame size the table does not cover, refuses the run
 * rather than scaling another size's image or shipping a video without its
 * disclosure.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AppError } from "@app/shared";
import {
  CLEAN_MASTER_CRF,
  COMPOSITION_AUDIO_MODE,
  COMPOSITION_ENCODER_PRESET,
  COMPOSITION_FIT_MODE,
  COMPOSITION_PIXEL_FORMAT,
  COMPOSITION_TRANSITION_MODE,
  COMPOSITION_VIDEO_CODEC,
  disclosureLayerFor,
  type ApplyDisclosureInput,
  type DisclosureLayerAsset,
  type ComposeDeliverableInput,
  type ComposeDeliverableOutcome,
  type CompositionProfile,
  type DeliverableMediaComposer,
} from "@app/domain";
import type { ProcessRunner } from "./process-runner";

/** 20 minutes by default: long enough for a 60s 1080p encode with headroom. */
export const DEFAULT_COMPOSE_TIMEOUT_MS = 20 * 60_000;
/**
 * One hour, absolute.
 *
 * This is **not** guaranteed to be shorter than the composition lease, and an
 * earlier version of this comment claimed it was. The two are configured
 * independently — the lease belongs to the domain runner, this timeout to a
 * storage adapter — and source materialization and publication add further
 * unbounded time on top of the encode, so a deployment can legitimately hold a
 * configuration where a run outlives its own lease.
 *
 * Correctness does not depend on the inequality. An encode that outlives its
 * lease loses `finalizeComposition` and its work is wasted, but publication is
 * first-wins and the next claim probes the canonical key before materializing
 * anything: once the object exists, the reclaiming worker finalizes against its
 * receipt instead of encoding again. That is what makes the lease a
 * crash-recovery bound rather than a deadline.
 */
export const MAX_COMPOSE_TIMEOUT_MS = 60 * 60_000;
/** ffmpeg writes progress to stderr; stdout stays tiny. */
export const COMPOSE_MAX_STDOUT_BYTES = 65_536;
/** The default program name. No environment variable is introduced this phase. */
export const DEFAULT_COMPOSE_PROGRAM = "ffmpeg";

export function validateComposeTimeoutMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1_000 ||
    value > MAX_COMPOSE_TIMEOUT_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Composer timeout must be a positive safe integer no greater than one hour",
    );
  }
  return value;
}

export interface FfmpegComposerConfig {
  readonly programPath?: string;
  readonly timeoutMs?: number;
  /**
   * The deployment's copy of `assets/disclosure/`, where the committed
   * disclosure images are, as an absolute path. Only `applyDisclosure` reads
   * it, and without it refuses to run.
   */
  readonly disclosureLayerDirectory?: string;
}

export interface FfmpegComposerDeps {
  readonly runner: ProcessRunner;
}

/**
 * The per-input filter chain, as one string.
 *
 * A filter *expression*, not a command: it is passed as a single `-filter_complex`
 * argument element and never sees a shell. Durations are rendered from validated
 * numbers.
 */
function clipFilter(
  index: number,
  profile: CompositionProfile,
  durationSeconds: number,
): string {
  const { targetWidthPx: w, targetHeightPx: h } = profile;
  const fps = profile.frameRateNumerator / profile.frameRateDenominator;
  const chain = [
    `fps=${fps}`,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    `setsar=1`,
    // Hold the final decoded frame when the source is shorter than its scene.
    // `stop_duration` is the scene length: tpad never shortens, and the trim
    // below is what makes the result exact in both directions.
    `tpad=stop_mode=clone:stop_duration=${durationSeconds}`,
    `trim=duration=${durationSeconds}`,
    `setpts=PTS-STARTPTS`,
  ].join(",");
  // Pad labels bind directly to the chain, with no separator: `[0:v]fps=…[v0]`.
  return `[${index}:v]${chain}[v${index}]`;
}

/**
 * The exact semantic argument vector.
 *
 * Exported so the unit suite can pin it without running a subprocess. The only
 * variable elements are application-created local paths and numbers from the
 * frozen profile.
 */
export function ffmpegComposeArgsFor(input: ComposeDeliverableInput): readonly string[] {
  return composeArgsAt(input, input.profile.crf);
}

/**
 * The Clean Master's argument vector: the composition graph, encoded at
 * {@link CLEAN_MASTER_CRF} instead of the profile's own quality.
 */
export function ffmpegCleanMasterArgsFor(input: ComposeDeliverableInput): readonly string[] {
  return composeArgsAt(input, CLEAN_MASTER_CRF);
}

function composeArgsAt(input: ComposeDeliverableInput, crf: number): readonly string[] {
  if (input.clips.length === 0) {
    throw new AppError("INTERNAL_ERROR", "A composition requires at least one clip");
  }
  const { profile } = input;
  const filters = input.clips.map((clip, index) =>
    clipFilter(index, profile, clip.durationSeconds),
  );
  const concatInputs = input.clips.map((_, index) => `[v${index}]`).join("");
  const filterComplex = [
    ...filters,
    `${concatInputs}concat=n=${input.clips.length}:v=1:a=0[out]`,
  ].join(";");

  const args: string[] = ["-nostdin", "-y", "-v", "error"];
  for (const clip of input.clips) {
    args.push("-i", clip.localPath);
  }
  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    // No tags or chapters from any input (see the module header).
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    // No audio, from any input, ever.
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    profile.encoderPreset,
    "-crf",
    String(crf),
    "-pix_fmt",
    profile.pixelFormat,
    "-movflags",
    "+faststart",
    // The container is stated rather than inferred from the output path's
    // extension: the path is application-owned and deliberately plain, and a
    // format guessed from a suffix is a format nobody chose.
    "-f",
    "mp4",
    input.outputPath,
  );
  return args;
}

/** The overlay for a disclosure mode, or a refusal for one not implemented. */
function disclosureOverlayFor(mode: ApplyDisclosureInput["disclosureMode"]): string {
  switch (mode) {
    case "THROUGHOUT":
      // Mode A: the whole video. Mode B will limit it with `enable`.
      return "overlay=0:0:format=auto:shortest=1";
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      throw new AppError("INTERNAL_ERROR", "The composer was handed a disclosure mode it does not implement");
    }
  }
}

/**
 * The argument vector that lays the disclosure image at `layerPath` over the
 * Clean Master and encodes the customer's video with the profile's settings.
 *
 * Not exported from the package: `layerPath` must be the private copy
 * `applyDisclosure` writes after checking the image, and only it calls this.
 *
 * The image is the frame's size, so it goes at the origin with no coordinates
 * and no scaling. Its reader is stated, `png_pipe`, rather than guessed from the
 * path: for a path holding a `%` pattern FFmpeg would pick its image-sequence
 * reader, which expands the pattern and opens the file again for every frame.
 * Looped, it is a frame for every frame of the master, and `shortest=1` ends the
 * video with the master. `format=auto` blends in the master's own format, and
 * the closing `format` hands the encoder the profile's.
 */
export function ffmpegDisclosureArgsFor(
  input: ApplyDisclosureInput,
  layerPath: string,
): readonly string[] {
  const { profile } = input;
  const overlay = disclosureOverlayFor(input.disclosureMode);
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    input.cleanMasterPath,
    "-f",
    "png_pipe",
    "-loop",
    "1",
    "-i",
    layerPath,
    "-filter_complex",
    `[0:v][1:v]${overlay},format=${profile.pixelFormat}[out]`,
    "-map",
    "[out]",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    profile.encoderPreset,
    "-crf",
    String(profile.crf),
    "-pix_fmt",
    profile.pixelFormat,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outputPath,
  ];
}

/** The private copy's fixed name, which carries no identity. */
const PRIVATE_LAYER_FILE_NAME = "layer.png";

/**
 * Read errors that say the deployment's image is missing or unreadable: a
 * deployment fault. Anything else (too many open files, an I/O error) is about
 * this moment, and the run is retried.
 */
const DEPLOYMENT_READ_FAULTS: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENAMETOOLONG",
]);

export function isDeploymentReadFault(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DEPLOYMENT_READ_FAULTS.has(code);
}

/**
 * The deployment's disclosure image, proved to be the reviewed image, or
 * `null` when it could not be read for a reason the deployment did not cause.
 *
 * Read and hashed before every run rather than once at start-up, so a file
 * replaced while the worker runs is caught at its next use.
 */
async function reviewedDisclosureLayer(
  directory: string | undefined,
  asset: DisclosureLayerAsset,
): Promise<Buffer | null> {
  if (directory === undefined) {
    throw new AppError("CONFIGURATION_ERROR", "This deployment has no disclosure images");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, asset.fileName));
  } catch (error) {
    if (!isDeploymentReadFault(error)) return null;
    throw new AppError("CONFIGURATION_ERROR", "A disclosure image is missing from this deployment");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new AppError("CONFIGURATION_ERROR", "A disclosure image in this deployment is not the reviewed image");
  }
  return bytes;
}

export function createFfmpegDeliverableComposer(
  deps: FfmpegComposerDeps,
  config: FfmpegComposerConfig = {},
): DeliverableMediaComposer {
  const program = config.programPath ?? DEFAULT_COMPOSE_PROGRAM;
  const timeoutMs = validateComposeTimeoutMs(config.timeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS);
  const layerDirectory = config.disclosureLayerDirectory;
  if (layerDirectory !== undefined && !isAbsolute(layerDirectory)) {
    throw new AppError("CONFIGURATION_ERROR", "The disclosure image directory must be an absolute path");
  }

  async function run(args: readonly string[]): Promise<ComposeDeliverableOutcome> {
    const outcome = await deps.runner.run({
      program,
      args,
      timeoutMs,
      maxStdoutBytes: COMPOSE_MAX_STDOUT_BYTES,
    });

    switch (outcome.kind) {
      case "EXITED":
        // A real exit status is evidence about this run. Non-zero is
        // retryable: the encoder may have hit a transient resource problem,
        // and this phase has no authority to declare a customer's deliverable
        // permanently unencodable. stderr is never read.
        return outcome.exitCode === 0
          ? { kind: "SUCCESS" }
          : { kind: "RETRYABLE_FAILURE" };
      case "TIMED_OUT":
      case "OUTPUT_TOO_LARGE":
      case "TRANSIENT_FAILURE":
        return { kind: "RETRYABLE_FAILURE" };
      case "LAUNCH_FAILED":
        // The binary is missing or unusable: a *deployment* fault, not a fact
        // about the video. Retrying it forever would hide a broken rollout
        // behind a queue that never drains.
        throw new AppError(
          "CONFIGURATION_ERROR",
          "The deliverable composer executable is unavailable in this deployment",
        );
      default: {
        const exhaustive: never = outcome;
        void exhaustive;
        throw new AppError("INTERNAL_ERROR", "The composer returned an unknown outcome");
      }
    }
  }

  return {
    async compose(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome> {
      assertImplementedProfile(input.profile);
      return run(ffmpegComposeArgsFor(input));
    },

    async composeCleanMaster(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome> {
      assertImplementedProfile(input.profile);
      return run(ffmpegCleanMasterArgsFor(input));
    },

    async applyDisclosure(input: ApplyDisclosureInput): Promise<ComposeDeliverableOutcome> {
      // What needs nothing from the deployment is checked first, so a defect
      // reads as a defect whatever the deployment holds.
      assertImplementedProfile(input.profile);
      disclosureOverlayFor(input.disclosureMode);
      const asset = disclosureLayerFor(input.profile.targetWidthPx, input.profile.targetHeightPx);
      // Every raster a profile resolves to has an image (ADR-0071 Decision 1), so
      // this is a defect in the profile, never a fact about the deployment.
      if (asset === null) {
        throw new AppError("INTERNAL_ERROR", "No disclosure image exists for this frame size");
      }
      if (resolve(input.cleanMasterPath) === resolve(input.outputPath)) {
        throw new AppError("INTERNAL_ERROR", "The customer's video cannot be written over the Clean Master it is made from");
      }

      const bytes = await reviewedDisclosureLayer(layerDirectory, asset);
      if (bytes === null) return { kind: "RETRYABLE_FAILURE" };

      // FFmpeg reads a private copy of the bytes just compared, never the
      // deployment's file, so nothing done to that file during the encode can
      // change what is laid over the video. A new directory (created 0700),
      // the file created exclusively, 0600, and removed after the run.
      let privateDirectory: string;
      try {
        privateDirectory = await mkdtemp(join(tmpdir(), "vta-disclosure-"));
      } catch {
        return { kind: "RETRYABLE_FAILURE" };
      }
      try {
        const layerPath = join(privateDirectory, PRIVATE_LAYER_FILE_NAME);
        try {
          await writeFile(layerPath, bytes, { flag: "wx", mode: 0o600 });
        } catch {
          return { kind: "RETRYABLE_FAILURE" };
        }
        return await run(ffmpegDisclosureArgsFor(input, layerPath));
      } finally {
        await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * The profile is the platform's, so a mismatch is an internal defect rather
 * than anything about the media. Its strings reach the argument vector and the
 * filter graph, so each must be the one this composer implements.
 */
function assertImplementedProfile(profile: CompositionProfile): void {
  if (
    profile.videoCodec !== COMPOSITION_VIDEO_CODEC ||
    profile.pixelFormat !== COMPOSITION_PIXEL_FORMAT ||
    profile.encoderPreset !== COMPOSITION_ENCODER_PRESET ||
    profile.fitMode !== COMPOSITION_FIT_MODE ||
    profile.transitionMode !== COMPOSITION_TRANSITION_MODE ||
    profile.audioMode !== COMPOSITION_AUDIO_MODE
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "The composer was handed a profile it does not implement",
    );
  }
}
