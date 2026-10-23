/**
 * The dormant deliverable composer's Clean Master encode, the one encode of the
 * scenes (ADR-0079): its exact argument vector, and the outcomes it maps a run
 * to. `ffmpeg-composer-disclosure.test.ts` covers the disclosure's encode.
 *
 * No subprocess is launched anywhere in this file. The argument vector is
 * pinned element by element because it is the whole security surface of this
 * adapter — there is no command *string* to review, only a list, and a list is
 * only safe if nothing customer-derived is ever in it.
 */

import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  CLEAN_MASTER_CRF,
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
  ffmpegCleanMasterArgsFor,
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
    outputPath: "/tmp/vta-compose-x/clean-master.mp4",
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
    expect(ffmpegCleanMasterArgsFor(inputOf())).toEqual([
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
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "/tmp/vta-compose-x/clean-master.mp4",
    ]);
  });

  it("states the container rather than inferring it from the output path", () => {
    const args = ffmpegCleanMasterArgsFor(inputOf({ outputPath: "/tmp/x/output" }));
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
    expect(args.at(-1)).toBe("/tmp/x/output");
  });

  it("carries the raster of whichever profile it is handed", () => {
    for (const [aspect, resolution, w, h] of [
      ["9:16", "720p", 720, 1280],
      ["1:1", "1080p", 1080, 1080],
    ] as const) {
      const filters = filterComplexOf(
        ffmpegCleanMasterArgsFor(inputOf({ profile: profileOf(aspect, resolution) })),
      );
      expect(filters).toContain(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
      expect(filters).toContain(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`);
    }
  });

  it("contains and pads, and never crops or changes playback speed", () => {
    const filters = filterComplexOf(ffmpegCleanMasterArgsFor(inputOf()));
    expect(filters).toContain("force_original_aspect_ratio=decrease");
    expect(filters).toContain("pad=");
    for (const banned of ["crop", "setpts=0.", "atempo", "scale2ref", "increase"]) {
      expect(`${banned}: ${filters.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("holds a short clip and trims a long one to exactly its scene length", () => {
    const filters = filterComplexOf(
      ffmpegCleanMasterArgsFor(inputOf({ clips: [{ localPath: "/tmp/x/input-0000", durationSeconds: 3 }] })),
    );
    // Both, in this order: tpad never shortens, and trim is what makes the
    // result exact in the other direction.
    expect(filters.indexOf("tpad=stop_mode=clone:stop_duration=3")).toBeLessThan(
      filters.indexOf("trim=duration=3"),
    );
  });

  it("resets each segment's timeline before concatenating", () => {
    const filters = filterComplexOf(ffmpegCleanMasterArgsFor(inputOf()));
    expect(filters.match(/setpts=PTS-STARTPTS/g)).toHaveLength(2);
    expect(filters.indexOf("setpts=PTS-STARTPTS")).toBeLessThan(filters.indexOf("concat="));
  });

  it("drops audio in both places it could survive", () => {
    const args = ffmpegCleanMasterArgsFor(inputOf());
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
      const args = ffmpegCleanMasterArgsFor(inputOf({ clips }));
      expect(args.filter((arg) => arg === "-i")).toHaveLength(count);
      expect(filterComplexOf(args)).toContain(`concat=n=${count}:v=1:a=0[out]`);
    }
  });

  it("refuses to build a vector for no clips at all", () => {
    expect(() => ffmpegCleanMasterArgsFor(inputOf({ clips: [] }))).toThrow(AppError);
  });
});

describe("every video is made from a master", () => {
  it("offers the master's encode and the disclosure's, and no encode of the scenes into a video", () => {
    const composer = createFfmpegDeliverableComposer({ runner: new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 0, stdout: "" } }) });
    expect(Object.keys(composer).sort()).toEqual(["applyDisclosure", "composeCleanMaster"]);
  });

  it("encodes the master at its own quality, whatever the profile's", () => {
    // The profile's CRF is the customer's video's (ADR-0078 Decision 1).
    const args = ffmpegCleanMasterArgsFor(inputOf({ profile: { ...profileOf(), crf: 23 } }));
    expect(args[args.indexOf("-crf") + 1]).toBe(String(CLEAN_MASTER_CRF));
  });
});

describe("nothing customer-derived reaches an argument", () => {
  it("varies only by application-created path and frozen profile numbers", () => {
    const args = ffmpegCleanMasterArgsFor(inputOf());
    const paths = new Set(["/tmp/vta-compose-x/input-0000", "/tmp/vta-compose-x/input-0001", "/tmp/vta-compose-x/clean-master.mp4"]);
    for (const arg of args) {
      if (paths.has(arg)) continue;
      // Everything else is a fixed flag, a fixed vocabulary word, or a number
      // and punctuation from the profile.
      expect(arg).toMatch(/^[-A-Za-z0-9_:=,;[\]().+/*]+$/);
    }
  });

  it("builds no command string and can reach no shell", () => {
    const args = ffmpegCleanMasterArgsFor(inputOf());
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

  it("keeps the two defaults in a sane relationship, and claims nothing more", () => {
    // The *defaults* line up, and that is worth pinning so nobody raises this
    // one past the lease by accident.
    expect(DEFAULT_COMPOSE_TIMEOUT_MS).toBeLessThan(DEFAULT_COMPOSITION_LEASE_MS);
    // But it is not an invariant, and this suite does not pretend otherwise: the
    // ceiling here exceeds the default lease outright, the two values are
    // configured independently in different packages, materialization and
    // publication add further unbounded time, and an attempt that makes the
    // Clean Master runs two encodes. Correctness rests on the runner probing
    // the canonical key before it encodes, and reusing a stored master instead
    // of encoding it again (ADR-0078), not on this inequality.
    expect(MAX_COMPOSE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_COMPOSITION_LEASE_MS);
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
    ).composeCleanMaster(inputOf());
    expect(runner.lastRun.program).toBe("/opt/bin/ffmpeg");
    expect(runner.lastRun.timeoutMs).toBe(120_000);
    expect(runner.lastRun.maxStdoutBytes).toBe(COMPOSE_MAX_STDOUT_BYTES);
    expect(runner.lastRun.args).toEqual(ffmpegCleanMasterArgsFor(inputOf()));
  });
});

describe("process outcomes are mapped to the closed composer vocabulary", () => {
  const encode = async (outcome: ProcessRunOutcome): Promise<ComposeDeliverableOutcome> => {
    const runner = new FakeProcessRunner({ outcome });
    return createFfmpegDeliverableComposer({ runner }).composeCleanMaster(inputOf());
  };

  it("maps a clean exit to SUCCESS", async () => {
    await expect(encode({ kind: "EXITED", exitCode: 0, stdout: "" })).resolves.toEqual({
      kind: "SUCCESS",
    });
  });

  it("maps a non-zero exit to a retryable failure, never to a terminal verdict", async () => {
    // This phase has no authority to declare a customer's deliverable
    // permanently unencodable from an exit status alone.
    for (const exitCode of [1, 69, 255]) {
      await expect(encode({ kind: "EXITED", exitCode, stdout: "" })).resolves.toEqual({
        kind: "RETRYABLE_FAILURE",
      });
    }
  });

  it("maps a timeout, an overrun and a host failure to the same retryable answer", async () => {
    const kinds = ["TIMED_OUT", "OUTPUT_TOO_LARGE", "TRANSIENT_FAILURE"] as const;
    for (const kind of kinds) {
      await expect(encode({ kind })).resolves.toEqual({ kind: "RETRYABLE_FAILURE" });
    }
  });

  it("turns an unavailable binary into a configuration defect, not a retry", async () => {
    // Retrying a missing binary forever would hide a broken rollout behind a
    // queue that never drains.
    await expect(encode({ kind: "LAUNCH_FAILED" })).rejects.toThrow(AppError);
  });

  it("never carries stderr, an exit object or any diagnostic across the port", async () => {
    const runner = new FakeProcessRunner({
      outcome: { kind: "EXITED", exitCode: 3, stdout: "secret diagnostic text" },
    });
    const outcome = await createFfmpegDeliverableComposer({ runner }).composeCleanMaster(inputOf());
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
      await expect(composer.composeCleanMaster(inputOf({ profile: broken }))).rejects.toThrow(AppError);
    }
    expect(runner.runs).toHaveLength(0);
  });
});
