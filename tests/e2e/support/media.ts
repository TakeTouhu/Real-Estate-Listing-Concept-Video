import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * What a saved video is, read by FFmpeg (GS-13c-2): Playwright's Chromium
 * cannot decode H.264 (ADR-0117 Decision 4), so the browser test proves the
 * downloaded file plays by FFmpeg's decoder instead, as was decided for GS-13.
 */

const run = promisify(execFile);

export interface VideoFacts {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
}

/** The first video stream's codec and size, and the file's length. */
export async function probeVideo(path: string): Promise<VideoFacts> {
  const { stdout } = await run("ffprobe", [
    ...["-v", "error", "-select_streams", "v:0"],
    ...["-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", path],
  ]);
  const read = JSON.parse(stdout) as {
    readonly streams?: readonly { codec_name?: string; width?: number; height?: number }[];
    readonly format?: { duration?: string };
  };
  const stream = read.streams?.[0];
  return {
    codec: stream?.codec_name ?? "",
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    durationSeconds: Number(read.format?.duration ?? Number.NaN),
  };
}

/** Rejects unless FFmpeg decodes every frame of the file without an error. */
export async function decodeVideo(path: string): Promise<void> {
  const { stderr } = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-f", "null", "-"]);
  if (stderr.trim() !== "") throw new Error(`FFmpeg reported errors decoding the saved video:\n${stderr}`);
}
