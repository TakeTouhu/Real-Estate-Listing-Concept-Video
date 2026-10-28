/**
 * The test provider's clip maker (GS-6, ADR-0092): one photo in, one short
 * clip out that slowly zooms into the photo and pans across it.
 *
 * For development and CI only. It stands in for a provider's renderer, so a
 * video made on the test provider shows the customer's own photos; it is not
 * part of the delivery pipeline, and nothing it makes is shown to anyone without
 * going through the same copy, checks and composition as a real provider's clip.
 * Construction refuses production, given or ambient, with no override.
 *
 * It runs FFmpeg through the injected `ProcessRunner`, the seam the composer
 * uses, so no shell parses anything: every argument is a path this process made
 * or a number checked here.
 *
 * ## The picture
 *
 * ```text
 * scale=2W:2H:force_original_aspect_ratio=decrease   the whole photo, never cropped
 * pad=2W:2H:(ow-iw)/2:(oh-ih)/2:black                 to the frame's shape
 * zoompan=…:d=N:s=WxH:fps=30                          N frames from the one photo
 * ```
 *
 * The photo is fitted whole into the frame at twice its size, so the first frame
 * shows all of it, as the composer never crops a customer's photo either. Over
 * the clip the view zooms in steadily by {@link FAKE_CLIP_ZOOM_IN} and drifts
 * from the left edge to the right; working at twice the size keeps the motion
 * smooth, because the zoom moves in whole input pixels. One photo is one input
 * frame, so the clip has exactly `N = duration × 30` frames.
 *
 * No audio, and nothing from the photo's own metadata.
 */

import { AppError } from "@app/shared";
import type { ProcessRunner } from "./managed-output/process-runner";
import { assertNotProduction } from "./production-guard";

/** The clip's frame rate, the composition profile's own. */
export const FAKE_CLIP_FRAME_RATE = 30;
/** How much the view has zoomed in by the last frame: 8 %. */
export const FAKE_CLIP_ZOOM_IN = 0.08;
/** The longest clip it makes. The test route's scenes are 5 to 15 seconds. */
export const FAKE_CLIP_MAX_DURATION_SECONDS = 60;
/** The largest side it makes, a 1080p frame's. */
const MAX_SIDE_PX = 1920;
/** Five minutes: a 15-second 1080p clip takes a few seconds. */
export const DEFAULT_FAKE_CLIP_TIMEOUT_MS = 5 * 60_000;
const MAX_STDOUT_BYTES = 65_536;

export interface FakeClipRenderInput {
  /** A JPEG this process wrote. */
  readonly photoPath: string;
  readonly outputPath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationSeconds: number;
}

/** Whether the clip is at `outputPath`. Nothing more: no tool output travels. */
export type FakeClipRenderOutcome = { readonly kind: "RENDERED" } | { readonly kind: "FAILED" };

export interface FakeClipRendererConfig {
  readonly programPath?: string;
  readonly timeoutMs?: number;
  /** Refused as production too, besides the ambient NODE_ENV; for tests. */
  readonly nodeEnv?: string;
}

function isEvenSide(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 2 && value <= MAX_SIDE_PX && value % 2 === 0;
}

/**
 * The exact argument vector, exported so the unit suite can pin it without
 * running anything. The input's reader is stated rather than guessed from the
 * path, and so is the container written.
 */
export function ffmpegFakeClipArgsFor(input: FakeClipRenderInput): readonly string[] {
  const { widthPx: w, heightPx: h, durationSeconds } = input;
  if (!isEvenSide(w) || !isEvenSide(h)) {
    throw new AppError("INTERNAL_ERROR", "A test clip's frame must have even sides no larger than 1920");
  }
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > FAKE_CLIP_MAX_DURATION_SECONDS
  ) {
    throw new AppError("INTERNAL_ERROR", "A test clip lasts a whole number of seconds, from 1 to 60");
  }
  const frames = durationSeconds * FAKE_CLIP_FRAME_RATE;
  // `on` counts output frames from 0, so the last frame is `frames - 1`.
  const progress = `on/${frames - 1}`;
  const picture = [
    `scale=${2 * w}:${2 * h}:force_original_aspect_ratio=decrease`,
    `pad=${2 * w}:${2 * h}:(ow-iw)/2:(oh-ih)/2:black`,
    "setsar=1",
    `zoompan=z='1+${FAKE_CLIP_ZOOM_IN}*${progress}'` +
      `:x='(iw-iw/zoom)*${progress}':y='(ih-ih/zoom)/2'` +
      `:d=${frames}:s=${w}x${h}:fps=${FAKE_CLIP_FRAME_RATE}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-f",
    "jpeg_pipe",
    "-i",
    input.photoPath,
    "-filter_complex",
    `[0:v]${picture}[out]`,
    "-map",
    "[out]",
    "-frames:v",
    String(frames),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outputPath,
  ];
}

export function createFfmpegFakeClipRenderer(
  deps: { readonly runner: ProcessRunner },
  config: FakeClipRendererConfig = {},
): { render(input: FakeClipRenderInput): Promise<FakeClipRenderOutcome> } {
  // The given value cannot vouch for the ambient one: either says production.
  for (const nodeEnv of [config.nodeEnv, process.env.NODE_ENV]) {
    assertNotProduction(
      "FfmpegFakeClipRenderer",
      "it makes the test provider's clips",
      "use a verified provider route",
      { nodeEnv },
    );
  }
  const program = config.programPath ?? "ffmpeg";
  const timeoutMs = config.timeoutMs ?? DEFAULT_FAKE_CLIP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DEFAULT_FAKE_CLIP_TIMEOUT_MS) {
    throw new AppError("CONFIGURATION_ERROR", "The test clip timeout must be from one second to five minutes");
  }
  return {
    async render(input: FakeClipRenderInput): Promise<FakeClipRenderOutcome> {
      const args = ffmpegFakeClipArgsFor(input);
      // Only a clean exit made the clip. Every other outcome, a missing binary
      // included, is a clip not made: the test provider then refuses the
      // request, which is true, since it holds nothing (ADR-0092).
      const outcome = await deps.runner.run({ program, args, timeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES });
      return outcome.kind === "EXITED" && outcome.exitCode === 0 ? { kind: "RENDERED" } : { kind: "FAILED" };
    },
  };
}
