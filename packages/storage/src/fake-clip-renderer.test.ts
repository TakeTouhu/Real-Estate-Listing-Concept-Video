import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import {
  createFfmpegFakeClipRenderer,
  ffmpegFakeClipArgsFor,
  type FakeClipFfmpegInput,
  type FakeClipRenderInput,
} from "./fake-clip-renderer";
import type { ProcessRunOutcome } from "./managed-output/process-runner";
import { NonProductionAdapterError } from "./production-guard";
import { FakeProcessRunner } from "./testing/media-fakes";

const INPUT: FakeClipFfmpegInput = {
  picturePath: "/work/picture.png",
  outputPath: "/work/clip.mp4",
  widthPx: 1280,
  heightPx: 720,
  durationSeconds: 5,
};

let work: string;
/** A real photo in a folder of the test's own, as the studio hands one over. */
let photo: FakeClipRenderInput;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "fake-clip-renderer-"));
  const photoPath = join(work, "photo.jpg");
  await sharp({ create: { width: 8, height: 6, channels: 3, background: "#c87832" } })
    .jpeg({ mozjpeg: true })
    .toFile(photoPath);
  photo = { photoPath, outputPath: join(work, "clip.mp4"), widthPx: 1280, heightPx: 720, durationSeconds: 5 };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

describe("the test clip's argument vector", () => {
  it("fits the whole photo, zooms 8 % and pans across, for exactly duration × 30 frames", () => {
    expect(ffmpegFakeClipArgsFor(INPUT)).toEqual([
      "-nostdin", "-y", "-v", "error",
      "-f", "png_pipe", "-i", "/work/picture.png",
      "-filter_complex",
      "[0:v]scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:(ow-iw)/2:(oh-ih)/2:black,setsar=1," +
        "zoompan=z='1+0.08*on/149':x='(iw-iw/zoom)*on/149':y='(ih-ih/zoom)/2':d=150:s=1280x720:fps=30," +
        "setsar=1,format=yuv420p[out]",
      "-map", "[out]", "-frames:v", "150",
      "-map_metadata", "-1", "-map_chapters", "-1", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-f", "mp4", "/work/clip.mp4",
    ]);
  });

  it("takes the frame and length it is given", () => {
    const args = ffmpegFakeClipArgsFor({ ...INPUT, widthPx: 1080, heightPx: 1920, durationSeconds: 15 });
    expect(args).toContain("450");
    expect(args.join(" ")).toContain(":d=450:s=1080x1920:fps=30");
    expect(args.join(" ")).toContain("scale=2160:3840:");
  });

  it.each([
    ["an odd side", { widthPx: 1279 }],
    ["a side past 1080p", { heightPx: 1922 }],
    ["no width", { widthPx: 0 }],
    ["a fractional side", { heightPx: 720.5 }],
    ["no length", { durationSeconds: 0 }],
    ["more than a minute", { durationSeconds: 61 }],
    ["a fractional length", { durationSeconds: 5.5 }],
  ])("refuses %s", (_, change) => {
    expect(() => ffmpegFakeClipArgsFor({ ...INPUT, ...change })).toThrow(AppError);
  });

  it("makes clips at both ends of what it allows", () => {
    expect(ffmpegFakeClipArgsFor({ ...INPUT, widthPx: 1920, heightPx: 2, durationSeconds: 60 })).toContain("1800");
    expect(ffmpegFakeClipArgsFor({ ...INPUT, durationSeconds: 1 }).join(" ")).toContain("on/29");
  });
});

describe("rendering", () => {
  it("decodes the photo to a PNG beside the clip, runs ffmpeg on it once, bounded; a clean exit is made", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    const renderer = createFfmpegFakeClipRenderer({ runner }, { nodeEnv: "test" });
    expect(await renderer.render(photo)).toEqual({ kind: "RENDERED" });
    expect(runner.runs).toHaveLength(1);
    const picturePath = join(work, "picture.png");
    expect(runner.lastRun).toMatchObject({
      program: "ffmpeg",
      args: ffmpegFakeClipArgsFor({ ...INPUT, picturePath, outputPath: photo.outputPath }),
      timeoutMs: 300_000,
      maxStdoutBytes: 65_536,
    });
    expect(await sharp(await readFile(picturePath)).metadata()).toMatchObject({ format: "png", width: 8, height: 6 });
  });

  it("reports a photo it cannot decode as the clip not made, without running ffmpeg", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    const renderer = createFfmpegFakeClipRenderer({ runner });
    expect(await renderer.render({ ...photo, photoPath: join(work, "missing.jpg") })).toEqual({ kind: "FAILED" });
    expect(runner.runs).toHaveLength(0);
  });

  it("refuses a frame it does not make before decoding anything", async () => {
    const runner = new FakeProcessRunner();
    const renderer = createFfmpegFakeClipRenderer({ runner });
    await expect(renderer.render({ ...photo, widthPx: 1279 })).rejects.toThrow(AppError);
    await expect(readFile(join(work, "picture.png"))).rejects.toThrow();
  });

  it("takes another program and a shorter timeout", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    await createFfmpegFakeClipRenderer({ runner }, { programPath: "/opt/ffmpeg", timeoutMs: 1_000 }).render(photo);
    expect(runner.lastRun).toMatchObject({ program: "/opt/ffmpeg", timeoutMs: 1_000 });
  });

  it.each<[string, ProcessRunOutcome]>([
    ["a failed exit", { kind: "EXITED", exitCode: 1, stdout: "" }],
    ["a timeout", { kind: "TIMED_OUT" }],
    ["too much output", { kind: "OUTPUT_TOO_LARGE" }],
    ["a host failure", { kind: "TRANSIENT_FAILURE" }],
    ["a missing program", { kind: "LAUNCH_FAILED" }],
  ])("reports %s as the clip not made", async (_, outcome) => {
    const renderer = createFfmpegFakeClipRenderer({ runner: new FakeProcessRunner({ outcome }) });
    expect(await renderer.render(photo)).toEqual({ kind: "FAILED" });
  });

  it.each([999, 300_001, 1.5, 1_000.5])("refuses a timeout of %s", (timeoutMs) => {
    expect(() => createFfmpegFakeClipRenderer({ runner: new FakeProcessRunner() }, { timeoutMs })).toThrow(AppError);
  });
});

describe("production", () => {
  it("refuses the renderer when told it is production", () => {
    expect(() => createFfmpegFakeClipRenderer({ runner: new FakeProcessRunner() }, { nodeEnv: "production" })).toThrow(
      NonProductionAdapterError,
    );
  });

  it("refuses the renderer when the process runs in production, whatever it is told", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createFfmpegFakeClipRenderer({ runner: new FakeProcessRunner() }, { nodeEnv: "test" })).toThrow(
      NonProductionAdapterError,
    );
  });
});
