import { describe, expect, it } from "vitest";
import {
  attachedPictureStream,
  exitedWith,
  FakeProcessRunner,
  ffprobeDocument,
  videoStream,
} from "../testing/media-fakes";
import { ManagedOutputMediaValidationDefect } from "./media-validation";
import {
  DEFAULT_PROBE_MAX_STDOUT_BYTES,
  DEFAULT_PROBE_PROGRAM,
  DEFAULT_PROBE_TIMEOUT_MS,
  FfprobeCleanMasterInspector,
  exactFrameRate,
  ffprobeArgsFor,
  interpretCleanMasterRaster,
} from "./ffprobe";

/**
 * The Clean Master inspector (ADR-0076 Decision 3), driven by a fake process
 * runner. The real `ffprobe` reads real masters in `tests/media/`.
 */

const PATH = "/tmp/vta-master-abc123/clean-master.mp4";

/** One video stream at a constant rate, as ffprobe reports a composed master. */
function masterStream(
  width: unknown,
  height: unknown,
  rates: { readonly base?: unknown; readonly average?: unknown } = {},
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (rates.base !== null) extra["r_frame_rate"] = rates.base ?? "30/1";
  if (rates.average !== null) extra["avg_frame_rate"] = rates.average ?? "30/1";
  return videoStream(width, height, extra);
}

const RASTER_1080 = {
  widthPx: 1920,
  heightPx: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
};

function inspector(runner: FakeProcessRunner, config = {}): FfprobeCleanMasterInspector {
  return new FfprobeCleanMasterInspector(config, { runner });
}

describe("a frame rate is read exactly, or not at all", () => {
  it("reads two positive integers as a reduced fraction", () => {
    expect(exactFrameRate("30/1")).toEqual({ numerator: 30, denominator: 1 });
    expect(exactFrameRate("60/2")).toEqual({ numerator: 30, denominator: 1 });
    expect(exactFrameRate("30000/1001")).toEqual({ numerator: 30000, denominator: 1001 });
    expect(exactFrameRate("25/1")).toEqual({ numerator: 25, denominator: 1 });
  });

  it.each([
    ["0/0", "ffprobe's unknown"],
    ["30/0", "a zero denominator"],
    ["0/1", "a zero rate"],
    ["030/1", "a leading zero"],
    ["30", "no denominator"],
    ["30.0/1", "a decimal"],
    ["-30/1", "a sign"],
    [" 30/1", "a leading space"],
    ["30/1 ", "a trailing space"],
    ["30/1/1", "two slashes"],
    ["9007199254740993/1", "an unsafe integer"],
    ["", "nothing"],
  ])("refuses %j (%s)", (value) => {
    expect(exactFrameRate(value)).toBeNull();
  });

  it.each([[30], [null], [undefined], [{ numerator: 30, denominator: 1 }]])("refuses a non-string %j", (value) => {
    expect(exactFrameRate(value)).toBeNull();
  });
});

describe("a master's raster is its primary video stream's size and one constant rate", () => {
  it("reads the frame size and the rate from a composed master", () => {
    expect(interpretCleanMasterRaster(ffprobeDocument({ streams: [masterStream(1920, 1080)] }))).toEqual(
      RASTER_1080,
    );
  });

  it("reports the rate reduced, so the profile's comparison never sees 60/2", () => {
    const document = ffprobeDocument({
      streams: [masterStream(720, 1280, { base: "60/2", average: "30/1" })],
    });
    expect(interpretCleanMasterRaster(document)).toEqual({
      widthPx: 720,
      heightPx: 1280,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
    });
  });

  it("reports a wrong size or rate as read, for the profile to refuse", () => {
    expect(
      interpretCleanMasterRaster(ffprobeDocument({ streams: [masterStream(1280, 720, { base: "25/1", average: "25/1" })] })),
    ).toEqual({ widthPx: 1280, heightPx: 720, frameRateNumerator: 25, frameRateDenominator: 1 });
  });

  it.each([
    ["the average differs from the base rate", { base: "30/1", average: "29/1" }],
    ["the average has the base rate's numerator over another denominator", { base: "30/1", average: "30/7" }],
    ["the base rate is unknown", { base: "0/0" }],
    ["the average is unknown", { average: "0/0" }],
    ["there is no base rate", { base: null }],
    ["there is no average", { average: null }],
  ])("is unusable when %s", (_label, rates) => {
    expect(interpretCleanMasterRaster(ffprobeDocument({ streams: [masterStream(1920, 1080, rates)] }))).toBeNull();
  });

  it("is unusable when the media policy refuses the file", () => {
    for (const document of [
      ffprobeDocument({ formatName: "matroska,webm", streams: [masterStream(1920, 1080)] }),
      ffprobeDocument({ streams: [] }),
      ffprobeDocument({ streams: [masterStream(undefined, 1080)] }),
      ffprobeDocument({ formatDuration: null, streams: [masterStream(1920, 1080)] }),
      ffprobeDocument({ streams: [attachedPictureStream(1920, 1080, { r_frame_rate: "30/1", avg_frame_rate: "30/1" })] }),
      null,
      "not a document",
    ]) {
      expect(interpretCleanMasterRaster(document)).toBeNull();
    }
  });

  it.each([
    ["a display matrix", { side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: "…", rotation: 90 }] }],
    ["a display matrix with no turn", { side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }] }],
    ["a display matrix that names no rotation", { side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: "…" }] }],
    ["a rotation in other side data", { side_data_list: [{ side_data_type: "Other", rotation: -90 }] }],
    ["a rotate tag", { tags: { rotate: "90" } }],
  ])("is unusable when the stream carries %s, which FFmpeg would apply before the disclosure", (_label, extra) => {
    const stream = { ...masterStream(1920, 1080), ...extra };
    expect(interpretCleanMasterRaster(ffprobeDocument({ streams: [stream] }))).toBeNull();
  });

  it("is not refused for side data that turns nothing", () => {
    const stream = { ...masterStream(1920, 1080), side_data_list: [{ side_data_type: "CPB properties" }], tags: { language: "und" } };
    expect(interpretCleanMasterRaster(ffprobeDocument({ streams: [stream] }))).toEqual(RASTER_1080);
  });

  it("takes the rate from the real video stream, never from artwork listed before it", () => {
    const document = ffprobeDocument({
      streams: [
        attachedPictureStream(1920, 1080, { r_frame_rate: "90000/1", avg_frame_rate: "0/0" }),
        masterStream(1920, 1080),
      ],
    });
    expect(interpretCleanMasterRaster(document)).toEqual(RASTER_1080);
  });

  it("takes the rate from the first real video stream when there are two", () => {
    const document = ffprobeDocument({
      streams: [masterStream(1920, 1080, { base: "25/1", average: "25/1" }), masterStream(1920, 1080)],
    });
    expect(interpretCleanMasterRaster(document)).toMatchObject({ frameRateNumerator: 25 });
  });
});

describe("the inspector runs ffprobe as the media validator does", () => {
  it("runs the fixed argument vector on the local path, with the validator's defaults", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedWith(ffprobeDocument({ streams: [masterStream(1920, 1080)] })) });
    expect(await inspector(runner).inspect({ localPath: PATH })).toEqual({ kind: "RASTER", raster: RASTER_1080 });
    expect(runner.runs).toHaveLength(1);
    expect(runner.lastRun).toMatchObject({
      program: DEFAULT_PROBE_PROGRAM,
      args: ffprobeArgsFor(PATH),
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: DEFAULT_PROBE_MAX_STDOUT_BYTES,
    });
  });

  it("passes the configured program and bounds", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedWith(ffprobeDocument({ streams: [masterStream(1920, 1080)] })) });
    await inspector(runner, { programPath: "/usr/bin/ffprobe", timeoutMs: 5_000, maxStdoutBytes: 4_096 }).inspect({
      localPath: PATH,
    });
    expect(runner.lastRun).toMatchObject({ program: "/usr/bin/ffprobe", timeoutMs: 5_000, maxStdoutBytes: 4_096 });
  });

  it("refuses a configuration the validator would refuse", () => {
    const runner = new FakeProcessRunner();
    for (const config of [{ programPath: " " }, { timeoutMs: 0 }, { timeoutMs: 120_001 }, { maxStdoutBytes: 0 }]) {
      expect(() => inspector(runner, config)).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    }
  });

  it("is unusable when ffprobe refuses the file or the raster cannot be read", async () => {
    for (const outcome of [
      { kind: "EXITED" as const, exitCode: 1, stdout: "" },
      exitedWith(ffprobeDocument({ streams: [masterStream(1920, 1080, { average: "0/0" })] })),
      exitedWith(ffprobeDocument({ formatName: "png_pipe", streams: [masterStream(1920, 1080)] })),
    ]) {
      expect(await inspector(new FakeProcessRunner({ outcome })).inspect({ localPath: PATH })).toEqual({
        kind: "UNUSABLE",
      });
    }
  });

  it("is retryable when ffprobe could not run this time", async () => {
    for (const kind of ["TIMED_OUT", "TRANSIENT_FAILURE"] as const) {
      expect(await inspector(new FakeProcessRunner({ outcome: { kind } })).inspect({ localPath: PATH })).toEqual({
        kind: "RETRYABLE_FAILURE",
      });
    }
  });

  it("throws the validator's fixed defects for a missing binary, oversized output and malformed output", async () => {
    for (const [outcome, code] of [
      [{ kind: "LAUNCH_FAILED" }, "PROBE_PROGRAM_UNAVAILABLE"],
      [{ kind: "OUTPUT_TOO_LARGE" }, "PROBE_OUTPUT_TOO_LARGE"],
      [{ kind: "EXITED", exitCode: 0, stdout: "{not json at /secret/path" }, "PROBE_OUTPUT_MALFORMED"],
    ] as const) {
      const error = await inspector(new FakeProcessRunner({ outcome })).inspect({ localPath: PATH }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ManagedOutputMediaValidationDefect);
      expect(error).toMatchObject({ code });
      expect(String((error as Error).message)).not.toContain("/secret/path");
    }
  });
});
