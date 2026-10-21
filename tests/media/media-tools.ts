/**
 * Real FFmpeg for the media suites (ADR-0072).
 *
 * The suites under `tests/media/` run the actual `ffmpeg` and `ffprobe`
 * binaries. The dormant composer and inspector run through the no-shell
 * process runner they are written against (`runner`). The helpers below, which
 * make inputs, describe streams and decode frames, call `execFile` directly,
 * also without a shell, so that a failure in CI shows FFmpeg's own message,
 * which the runner discards. The suites make their own synthetic inputs, so no
 * customer photo, provider clip or network fetch is ever involved, and every
 * file lives in a temporary directory the suite removes.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDefaultProcessRunner } from "@app/storage";

export const runner = createDefaultProcessRunner();

const TOOL_TIMEOUT_MS = 120_000;
const run = promisify(execFile);

/** Runs a tool to a clean exit and returns its output; anything else fails the test, with the exit code and the tool's own error. */
async function tool(program: "ffmpeg" | "ffprobe", args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run(program, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 1_048_576, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const { code, signal, stderr } = error as { code?: unknown; signal?: unknown; stderr?: unknown };
    const message = typeof stderr === "string" ? stderr.trim().slice(-2_000) : "";
    throw new Error(`${program} failed (code ${String(code)}, signal ${String(signal)}): ${message}`);
  }
}

/** Runs `ffmpeg` with the arguments given, reporting errors only. */
export async function ffmpeg(args: readonly string[]): Promise<void> {
  await tool("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args]);
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
  const { streams } = JSON.parse(await tool("ffprobe", ["-v", "error", "-of", "json", "-show_streams", path])) as {
    streams: (ProbedVideoStream & { codec_type: string })[];
  };
  return {
    video: streams.filter((stream) => stream.codec_type === "video"),
    audioCount: streams.filter((stream) => stream.codec_type === "audio").length,
  };
}

/** Everything `ffprobe` reports of a file's container, streams and chapters, as its JSON. */
export async function probeEverything(path: string): Promise<{
  readonly text: string;
  readonly streamCount: number;
  readonly chapterCount: number;
}> {
  const text = await tool("ffprobe", ["-v", "error", "-of", "json", "-show_format", "-show_streams", "-show_chapters", path]);
  const { streams, chapters } = JSON.parse(text) as { streams: unknown[]; chapters: unknown[] };
  return { text, streamCount: streams.length, chapterCount: chapters.length };
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
