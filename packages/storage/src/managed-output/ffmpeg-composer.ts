/**
 * The dormant `ffmpeg`-backed deliverable composer.
 *
 * ## No shell, ever
 *
 * Invoked through the same injected `ProcessRunner` seam the media inspector
 * uses, which launches the program directly with no shell. There is no command *string*
 * anywhere in this module — nothing is interpolated, quoted or escaped, because
 * nothing is parsed by a shell. Every variable element is either a path this
 * process created inside its own temporary directory, or a number taken from the
 * frozen composition profile. No customer text, prompt, filename, bucket, key or
 * provider URL is ever an argument.
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
 */

import { AppError } from "@app/shared";
import {
  COMPOSITION_AUDIO_MODE,
  COMPOSITION_FIT_MODE,
  COMPOSITION_TRANSITION_MODE,
  type ComposeDeliverableInput,
  type ComposeDeliverableOutcome,
  type CompositionProfile,
  type DeliverableMediaComposer,
} from "@app/domain";
import type { ProcessRunner } from "./process-runner";

/** 20 minutes by default: long enough for a 60s 1080p encode with headroom. */
export const DEFAULT_COMPOSE_TIMEOUT_MS = 20 * 60_000;
/** One hour, absolute. Always shorter than the composition lease. */
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
    // No audio, from any input, ever.
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
    // The container is stated rather than inferred from the output path's
    // extension: the path is application-owned and deliberately plain, and a
    // format guessed from a suffix is a format nobody chose.
    "-f",
    "mp4",
    input.outputPath,
  );
  return args;
}

export function createFfmpegDeliverableComposer(
  deps: FfmpegComposerDeps,
  config: FfmpegComposerConfig = {},
): DeliverableMediaComposer {
  const program = config.programPath ?? DEFAULT_COMPOSE_PROGRAM;
  const timeoutMs = validateComposeTimeoutMs(config.timeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS);

  return {
    async compose(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome> {
      // The profile is the platform's, so a mismatch is an internal defect
      // rather than anything about the media.
      if (
        input.profile.fitMode !== COMPOSITION_FIT_MODE ||
        input.profile.transitionMode !== COMPOSITION_TRANSITION_MODE ||
        input.profile.audioMode !== COMPOSITION_AUDIO_MODE
      ) {
        throw new AppError(
          "INTERNAL_ERROR",
          "The composer was handed a profile it does not implement",
        );
      }

      const outcome = await deps.runner.run({
        program,
        args: ffmpegComposeArgsFor(input),
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
    },
  };
}
