import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import { createFfmpegFakeClipRenderer, ffmpegFakeClipArgsFor, type FakeClipRenderInput } from "./fake-clip-renderer";
import type { ProcessRunOutcome } from "./managed-output/process-runner";
import { NonProductionAdapterError } from "./production-guard";
import { FakeProcessRunner } from "./testing/media-fakes";

const INPUT: FakeClipRenderInput = {
  photoPath: "/work/photo.jpg",
  outputPath: "/work/clip.mp4",
  widthPx: 1280,
  heightPx: 720,
  durationSeconds: 5,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the test clip's argument vector", () => {
  it("fits the whole photo, zooms 8 % and pans across, for exactly duration × 30 frames", () => {
    expect(ffmpegFakeClipArgsFor(INPUT)).toEqual([
      "-nostdin", "-y", "-v", "error",
      "-f", "jpeg_pipe", "-i", "/work/photo.jpg",
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
  it("runs ffmpeg once, bounded, and reports a clean exit as the clip made", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    const renderer = createFfmpegFakeClipRenderer({ runner }, { nodeEnv: "test" });
    expect(await renderer.render(INPUT)).toEqual({ kind: "RENDERED" });
    expect(runner.runs).toHaveLength(1);
    expect(runner.lastRun).toMatchObject({
      program: "ffmpeg",
      args: ffmpegFakeClipArgsFor(INPUT),
      timeoutMs: 300_000,
      maxStdoutBytes: 65_536,
    });
  });

  it("takes another program and a shorter timeout", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    await createFfmpegFakeClipRenderer({ runner }, { programPath: "/opt/ffmpeg", timeoutMs: 1_000 }).render(INPUT);
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
    expect(await renderer.render(INPUT)).toEqual({ kind: "FAILED" });
  });

  it.each([999, 300_001, 1.5])("refuses a timeout of %s", (timeoutMs) => {
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
