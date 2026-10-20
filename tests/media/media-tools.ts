/**
 * Real FFmpeg for the media suites (ADR-0072).
 *
 * The suites under `tests/media/` run the actual `ffmpeg` and `ffprobe`
 * binaries, through the same no-shell process runner the dormant composer and
 * inspector are written against. They make their own synthetic inputs, so no
 * customer photo, provider clip or network fetch is ever involved, and every
 * file lives in a temporary directory the suite removes.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultProcessRunner } from "@app/storage";

export const runner = createDefaultProcessRunner();

const TOOL_TIMEOUT_MS = 120_000;

/** Runs `ffmpeg` with the arguments given; any outcome but a clean exit fails the test. */
export async function ffmpeg(args: readonly string[]): Promise<void> {
  const outcome = await runner.run({
    program: "ffmpeg",
    args: ["-nostdin", "-y", "-v", "error", ...args],
    timeoutMs: TOOL_TIMEOUT_MS,
    maxStdoutBytes: 65_536,
  });
  if (outcome.kind !== "EXITED" || outcome.exitCode !== 0) {
    throw new Error(`ffmpeg did not exit cleanly: ${outcome.kind}`);
  }
}

/** A video stream as `ffprobe` describes it, for the facts the inspector does not report. */
export interface ProbedVideoStream {
  readonly codec_name: string;
  readonly pix_fmt: string;
  readonly avg_frame_rate: string;
  readonly sample_aspect_ratio?: string;
  readonly nb_frames: string;
}

export async function probeStreams(path: string): Promise<{
  readonly video: readonly ProbedVideoStream[];
  readonly audioCount: number;
}> {
  const outcome = await runner.run({
    program: "ffprobe",
    args: ["-v", "error", "-of", "json", "-show_streams", path],
    timeoutMs: TOOL_TIMEOUT_MS,
    maxStdoutBytes: 1_048_576,
  });
  if (outcome.kind !== "EXITED" || outcome.exitCode !== 0) {
    throw new Error(`ffprobe did not exit cleanly: ${outcome.kind}`);
  }
  const { streams } = JSON.parse(outcome.stdout) as {
    streams: (ProbedVideoStream & { codec_type: string })[];
  };
  return {
    video: streams.filter((stream) => stream.codec_type === "video"),
    audioCount: streams.filter((stream) => stream.codec_type === "audio").length,
  };
}

let decoded = 0;

/** One decoded frame, as packed 8-bit RGB. */
export async function decodeFrame(dir: string, path: string, frameIndex: number): Promise<Buffer> {
  decoded += 1;
  const out = join(dir, `decoded-${decoded}.rgb`);
  await ffmpeg(["-i", path, "-vf", `select=eq(n\\,${frameIndex})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  return await readFile(out);
}

/** A PNG decoded by FFmpeg itself, as packed 8-bit RGBA with straight alpha. */
export async function decodeRgba(dir: string, path: string): Promise<Buffer> {
  decoded += 1;
  const out = join(dir, `decoded-${decoded}.rgba`);
  await ffmpeg(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", out]);
  return await readFile(out);
}
