/**
 * The dormant deliverable composer: its exact argument vector, and the
 * outcomes it maps a run to.
 *
 * No subprocess is launched anywhere in this file. The argument vector is
 * pinned element by element because it is the whole security surface of this
 * adapter — there is no command *string* to review, only a list, and a list is
 * only safe if nothing customer-derived is ever in it.
 */

import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  DEFAULT_COMPOSITION_LEASE_MS,
  resolveCompositionProfile,
  type ComposeDeliverableInput,
  type ComposeDeliverableOutcome,
  type CompositionProfile,
} from "@app/domain";
import { FakeProcessRunner } from "../testing/media-fakes";
import type { ProcessRunOutcome } from "./process-runner";
import {
  COMPOSE_MAX_STDOUT_BYTES,
  DEFAULT_COMPOSE_PROGRAM,
  DEFAULT_COMPOSE_TIMEOUT_MS,
  MAX_COMPOSE_TIMEOUT_MS,
  createFfmpegDeliverableComposer,
  ffmpegComposeArgsFor,
  validateComposeTimeoutMs,
} from "./ffmpeg-composer";

function profileOf(aspect = "16:9", resolution = "1080p"): CompositionProfile {
  const outcome = resolveCompositionProfile({
    targetAspectRatio: aspect,
    targetOutputResolution: resolution,
  });
  if (outcome.kind !== "RESOLVED") throw new Error("fixture profile must resolve");
  return outcome.profile;
}

function inputOf(overrides: Partial<ComposeDeliverableInput> = {}): ComposeDeliverableInput {
  return {
    clips: [
      { localPath: "/tmp/vta-compose-x/input-0000", durationSeconds: 5 },
      { localPath: "/tmp/vta-compose-x/input-0001", durationSeconds: 7 },
    ],
    profile: profileOf(),
    outputPath: "/tmp/vta-compose-x/output.mp4",
    ...overrides,
  };
}

function filterComplexOf(args: readonly string[]): string {
  const index = args.indexOf("-filter_complex");
  expect(index).toBeGreaterThan(-1);
  return args[index + 1]!;
}

// ---------------------------------------------------------------------------

describe("the argument vector is exact", () => {
  it("is pinned element by element for the documented two-clip case", () => {
    expect(ffmpegComposeArgsFor(inputOf())).toEqual([
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      "/tmp/vta-compose-x/input-0000",
      "-i",
      "/tmp/vta-compose-x/input-0001",
      "-filter_complex",
      [
        "[0:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease," +
          "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1," +
          "tpad=stop_mode=clone:stop_duration=5,trim=duration=5,setpts=PTS-STARTPTS[v0]",
        "[1:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease," +
          "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1," +
          "tpad=stop_mode=clone:stop_duration=7,trim=duration=7,setpts=PTS-STARTPTS[v1]",
        "[v0][v1]concat=n=2:v=1:a=0[out]",
      ].join(";"),
      "-map",
      "[out]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "/tmp/vta-compose-x/output.mp4",
    ]);
  });

  it("states the container rather than inferring it from the output path", () => {
    const args = ffmpegComposeArgsFor(inputOf({ outputPath: "/tmp/x/output" }));
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
    expect(args.at(-1)).toBe("/tmp/x/output");
  });

  it("carries the raster of whichever profile it is handed", () => {
    for (const [aspect, resolution, w, h] of [
      ["9:16", "720p", 720, 1280],
      ["1:1", "1080p", 1080, 1080],
    ] as const) {
      const filters = filterComplexOf(
        ffmpegComposeArgsFor(inputOf({ profile: profileOf(aspect, resolution) })),
      );
      expect(filters).toContain(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
      expect(filters).toContain(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`);
    }
  });

  it("contains and pads, and never crops or changes playback speed", () => {
    const filters = filterComplexOf(ffmpegComposeArgsFor(inputOf()));
    expect(filters).toContain("force_original_aspect_ratio=decrease");
    expect(filters).toContain("pad=");
    for (const banned of ["crop", "setpts=0.", "atempo", "scale2ref", "increase"]) {
      expect(`${banned}: ${filters.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("holds a short clip and trims a long one to exactly its scene length", () => {
    const filters = filterComplexOf(
      ffmpegComposeArgsFor(inputOf({ clips: [{ localPath: "/tmp/x/input-0000", durationSeconds: 3 }] })),
    );
    // Both, in this order: tpad never shortens, and trim is what makes the
    // result exact in the other direction.
    expect(filters.indexOf("tpad=stop_mode=clone:stop_duration=3")).toBeLessThan(
      filters.indexOf("trim=duration=3"),
    );
  });

  it("resets each segment's timeline before concatenating", () => {
    const filters = filterComplexOf(ffmpegComposeArgsFor(inputOf()));
    expect(filters.match(/setpts=PTS-STARTPTS/g)).toHaveLength(2);
    expect(filters.indexOf("setpts=PTS-STARTPTS")).toBeLessThan(filters.indexOf("concat="));
  });

  it("drops audio in both places it could survive", () => {
    const args = ffmpegComposeArgsFor(inputOf());
    expect(args).toContain("-an");
    expect(filterComplexOf(args)).toContain("a=0");
    expect(args.some((arg) => arg.startsWith("-c:a"))).toBe(false);
  });

  it("scales the graph to the clip count", () => {
    for (const count of [1, 3, 8]) {
      const clips = Array.from({ length: count }, (_, index) => ({
        localPath: `/tmp/x/input-${String(index).padStart(4, "0")}`,
        durationSeconds: 2,
      }));
      const args = ffmpegComposeArgsFor(inputOf({ clips }));
      expect(args.filter((arg) => arg === "-i")).toHaveLength(count);
      expect(filterComplexOf(args)).toContain(`concat=n=${count}:v=1:a=0[out]`);
    }
  });

  it("refuses to build a vector for no clips at all", () => {
    expect(() => ffmpegComposeArgsFor(inputOf({ clips: [] }))).toThrow(AppError);
  });
});

describe("nothing customer-derived reaches an argument", () => {
  it("varies only by application-created path and frozen profile numbers", () => {
    const args = ffmpegComposeArgsFor(inputOf());
    const paths = new Set(["/tmp/vta-compose-x/input-0000", "/tmp/vta-compose-x/input-0001", "/tmp/vta-compose-x/output.mp4"]);
    for (const arg of args) {
      if (paths.has(arg)) continue;
      // Everything else is a fixed flag, a fixed vocabulary word, or a number
      // and punctuation from the profile.
      expect(arg).toMatch(/^[-A-Za-z0-9_:=,;[\]().+/*]+$/);
    }
  });

  it("builds no command string and can reach no shell", () => {
    const args = ffmpegComposeArgsFor(inputOf());
    const joined = args.join(" ");
    for (const banned of ["&&", "||", ";", "|", "`", "$(", ">", "<"]) {
      // `;` separates filter-graph elements inside one argument, but must never
      // appear where the vector is treated as a command line.
      if (banned === ";") continue;
      expect(`${banned}: ${joined.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("timeouts are bounded, and always shorter than the lease", () => {
  it("names the defaults and ceilings", () => {
    expect(DEFAULT_COMPOSE_PROGRAM).toBe("ffmpeg");
    expect(DEFAULT_COMPOSE_TIMEOUT_MS).toBe(20 * 60_000);
    expect(MAX_COMPOSE_TIMEOUT_MS).toBe(60 * 60_000);
    expect(COMPOSE_MAX_STDOUT_BYTES).toBe(65_536);
  });

  it("keeps the default encode well inside the default lease", () => {
    // The cross-package invariant: a composer allowed to outrun its own lease
    // would have the work reclaimed underneath it and encoded twice.
    expect(DEFAULT_COMPOSE_TIMEOUT_MS).toBeLessThan(DEFAULT_COMPOSITION_LEASE_MS);
  });

  it("refuses an unusable timeout rather than clamping it", () => {
    expect(validateComposeTimeoutMs(60_000)).toBe(60_000);
    for (const value of [
      0,
      -1,
      999,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_COMPOSE_TIMEOUT_MS + 1,
      "60000",
      null,
      undefined,
    ]) {
      expect(() => validateComposeTimeoutMs(value)).toThrow(AppError);
    }
  });

  it("passes the configured program and bounds to the runner", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    await createFfmpegDeliverableComposer(
      { runner },
      { programPath: "/opt/bin/ffmpeg", timeoutMs: 120_000 },
    ).compose(inputOf());
    expect(runner.lastRun.program).toBe("/opt/bin/ffmpeg");
    expect(runner.lastRun.timeoutMs).toBe(120_000);
    expect(runner.lastRun.maxStdoutBytes).toBe(COMPOSE_MAX_STDOUT_BYTES);
    expect(runner.lastRun.args).toEqual(ffmpegComposeArgsFor(inputOf()));
  });
});

describe("process outcomes are mapped to the closed composer vocabulary", () => {
  const compose = async (outcome: ProcessRunOutcome): Promise<ComposeDeliverableOutcome> => {
    const runner = new FakeProcessRunner({ outcome });
    return createFfmpegDeliverableComposer({ runner }).compose(inputOf());
  };

  it("maps a clean exit to SUCCESS", async () => {
    await expect(compose({ kind: "EXITED", exitCode: 0, stdout: "" })).resolves.toEqual({
      kind: "SUCCESS",
    });
  });

  it("maps a non-zero exit to a retryable failure, never to a terminal verdict", async () => {
    // This phase has no authority to declare a customer's deliverable
    // permanently unencodable from an exit status alone.
    for (const exitCode of [1, 69, 255]) {
      await expect(compose({ kind: "EXITED", exitCode, stdout: "" })).resolves.toEqual({
        kind: "RETRYABLE_FAILURE",
      });
    }
  });

  it("maps a timeout, an overrun and a host failure to the same retryable answer", async () => {
    const kinds = ["TIMED_OUT", "OUTPUT_TOO_LARGE", "TRANSIENT_FAILURE"] as const;
    for (const kind of kinds) {
      await expect(compose({ kind })).resolves.toEqual({ kind: "RETRYABLE_FAILURE" });
    }
  });

  it("turns an unavailable binary into a configuration defect, not a retry", async () => {
    // Retrying a missing binary forever would hide a broken rollout behind a
    // queue that never drains.
    await expect(compose({ kind: "LAUNCH_FAILED" })).rejects.toThrow(AppError);
  });

  it("never carries stderr, an exit object or any diagnostic across the port", async () => {
    const runner = new FakeProcessRunner({
      outcome: { kind: "EXITED", exitCode: 3, stdout: "secret diagnostic text" },
    });
    const outcome = await createFfmpegDeliverableComposer({ runner }).compose(inputOf());
    expect(JSON.stringify(outcome)).toBe(JSON.stringify({ kind: "RETRYABLE_FAILURE" }));
  });

  it("refuses a profile it does not implement rather than encoding something else", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } });
    const composer = createFfmpegDeliverableComposer({ runner });
    for (const broken of [
      { ...profileOf(), fitMode: "COVER_CROP" },
      { ...profileOf(), transitionMode: "CROSSFADE" },
      { ...profileOf(), audioMode: "KEEP_ALL" },
    ]) {
      await expect(composer.compose(inputOf({ profile: broken }))).rejects.toThrow(AppError);
    }
    expect(runner.runs).toHaveLength(0);
  });
});
