import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { ISO_BMFF_CONTAINER } from "@app/domain";
import {
  audioStream,
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
  FfprobeMediaProbe,
  MAX_PROBE_STDOUT_BYTES,
  MAX_PROBE_TIMEOUT_MS,
  ffprobeArgsFor,
  interpretFfprobeDocument,
  isIsoBmffFormatName,
  validateProbeMaxStdoutBytes,
  validateProbeTimeoutMs,
} from "./ffprobe";

/**
 * The dormant ffprobe inspector, driven entirely by a fake process runner — no
 * binary, no subprocess, no CI dependency on ffmpeg being installed.
 */

const PATH = "/tmp/managed-output-media-abc123/input";

function probe(runner: FakeProcessRunner, config = {}): FfprobeMediaProbe {
  return new FfprobeMediaProbe(config, { runner });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the probe to reject");
}

// ---------------------------------------------------------------------------

describe("configuration bounds", () => {
  it("names the defaults", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_PROBE_MAX_STDOUT_BYTES).toBe(1_048_576);
    expect(DEFAULT_PROBE_PROGRAM).toBe("ffprobe");
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["over the hard ceiling", MAX_PROBE_TIMEOUT_MS + 1],
    ["a string", "15000"],
  ])("refuses a timeout that is %s", (_l, value) => {
    expect(() => validateProbeTimeoutMs(value)).toThrow(AppError);
    expect(() => probe(new FakeProcessRunner(), { timeoutMs: value })).toThrow(AppError);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["over the hard ceiling", MAX_PROBE_STDOUT_BYTES + 1],
    ["a string", "1048576"],
  ])("refuses a stdout cap that is %s", (_l, value) => {
    expect(() => validateProbeMaxStdoutBytes(value)).toThrow(AppError);
    expect(() => probe(new FakeProcessRunner(), { maxStdoutBytes: value })).toThrow(AppError);
  });

  it("refuses a blank program path", () => {
    expect(() => probe(new FakeProcessRunner(), { programPath: "  " })).toThrow(AppError);
  });

  it("passes the configured bounds and program to every run", async () => {
    const runner = new FakeProcessRunner();
    await probe(runner, { programPath: "/opt/bin/ffprobe", timeoutMs: 1234, maxStdoutBytes: 4096 }).probe(PATH);
    expect(runner.lastRun.program).toBe("/opt/bin/ffprobe");
    expect(runner.lastRun.timeoutMs).toBe(1234);
    expect(runner.lastRun.maxStdoutBytes).toBe(4096);
  });
});

// ---------------------------------------------------------------------------

describe("the invocation is fixed, argument-vector only, and carries no tenant data", () => {
  it("builds exactly the documented argument vector with the path last", () => {
    expect(ffprobeArgsFor(PATH)).toEqual([
      "-v",
      "error",
      "-of",
      "json",
      "-show_format",
      "-show_streams",
      PATH,
    ]);
  });

  it("passes only the local path as a variable argument", async () => {
    const runner = new FakeProcessRunner();
    await probe(runner).probe(PATH);
    const args = runner.lastRun.args;
    // Every argument except the last is a fixed flag.
    expect(args.slice(0, -1)).toEqual(["-v", "error", "-of", "json", "-show_format", "-show_streams"]);
    expect(args.at(-1)).toBe(PATH);
    // Nothing tenant-, storage- or provider-shaped reaches the command line.
    const joined = args.join(" ");
    for (const banned of ["s3://", "bucket", "org/", "generations/", "fal.media", "http", "X-Fal-Signature", ".mp4"]) {
      expect(joined).not.toContain(banned);
    }
  });

  it("never builds a shell command string", () => {
    const src = readFileSync(join(__dirname, "ffprobe.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    for (const banned of ["shell: true", "exec(", "execSync", "spawnSync", "/bin/sh", "-c\"", "`${"]) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The one invocation is execFile with shell disabled.
    expect(src.includes("execFile(")).toBe(true);
    expect(src.includes("shell: false")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("container policy — the bytes decide, never a name or an extension", () => {
  it.each([
    ["mov,mp4,m4a,3gp,3g2,mj2", true],
    ["mp4", true],
    ["MOV,MP4", true],
    ["  mp4  ", true],
    ["isom", true],
    ["matroska,webm", false],
    ["avi", false],
    ["mpegts", false],
    ["", false],
    ["mp4x", false],
  ])("reads format_name %s as ISO-BMFF: %s", (name, expected) => {
    expect(isIsoBmffFormatName(name)).toBe(expected);
  });

  it.each([[null], [undefined], [42], [{}], [["mp4"]]])(
    "refuses a non-string format_name (%s)",
    (value) => {
      expect(isIsoBmffFormatName(value)).toBe(false);
    },
  );

  it("rejects an unsupported container", () => {
    expect(interpretFfprobeDocument(ffprobeDocument({ formatName: "matroska,webm" }))).toEqual({
      kind: "INVALID",
      reason: "CONTAINER_UNSUPPORTED",
    });
  });

  it("rejects a document with no format object at all", () => {
    expect(interpretFfprobeDocument(ffprobeDocument({ omitFormat: true }))).toEqual({
      kind: "INVALID",
      reason: "CONTAINER_UNSUPPORTED",
    });
  });
});

// ---------------------------------------------------------------------------

describe("stream and duration policy", () => {
  it("accepts one video stream and no audio — audio is optional", () => {
    expect(interpretFfprobeDocument(ffprobeDocument({ streams: [videoStream(1920, 1080)] }))).toEqual({
      kind: "FACTS",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 8500,
        videoWidth: 1920,
        videoHeight: 1080,
        videoStreamCount: 1,
        audioStreamCount: 0,
      },
    });
  });

  it("accepts optional audio and reports its normalized count", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({ streams: [videoStream(1280, 720), audioStream()] }),
    );
    expect(result).toEqual({
      kind: "FACTS",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 8500,
        videoWidth: 1280,
        videoHeight: 720,
        videoStreamCount: 1,
        audioStreamCount: 1,
      },
    });
  });

  it("keeps primary-video determinism with several streams of each kind", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        streams: [
          audioStream(),
          videoStream(1920, 1080),
          videoStream(320, 240),
          audioStream(),
          { codec_type: "subtitle" },
        ],
      }),
    );
    // The first video stream is primary, regardless of ordering or extras.
    expect(result).toEqual({
      kind: "FACTS",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 8500,
        videoWidth: 1920,
        videoHeight: 1080,
        videoStreamCount: 2,
        audioStreamCount: 2,
      },
    });
  });

  it("rejects a document with no video stream", () => {
    expect(interpretFfprobeDocument(ffprobeDocument({ streams: [audioStream()] }))).toEqual({
      kind: "INVALID",
      reason: "VIDEO_STREAM_MISSING",
    });
  });

  it("rejects a document with no streams array", () => {
    expect(interpretFfprobeDocument({ format: { format_name: "mp4", duration: "5" } })).toEqual({
      kind: "INVALID",
      reason: "VIDEO_STREAM_MISSING",
    });
  });

  it.each([
    ["zero width", 0, 1080],
    ["negative width", -1920, 1080],
    ["fractional width", 1920.5, 1080],
    ["missing width", undefined, 1080],
    ["non-numeric width", "wide", 1080],
    ["zero height", 1920, 0],
    ["negative height", 1920, -1080],
    ["fractional height", 1920, 1080.25],
    ["missing height", 1920, undefined],
    ["non-numeric height", 1920, "tall"],
  ])("rejects %s", (_l, width, height) => {
    expect(
      interpretFfprobeDocument(ffprobeDocument({ streams: [videoStream(width, height)] })),
    ).toEqual({ kind: "INVALID", reason: "VIDEO_DIMENSIONS_INVALID" });
  });

  it("accepts numeric-string dimensions, as ffprobe sometimes emits", () => {
    const result = interpretFfprobeDocument(ffprobeDocument({ streams: [videoStream("1920", "1080")] }));
    expect(result).toEqual({
      kind: "FACTS",
      facts: expect.objectContaining({ videoWidth: 1920, videoHeight: 1080 }),
    });
  });

  it.each([
    ["missing", null],
    ["zero", "0"],
    ["negative", "-3.5"],
    ["malformed", "N/A"],
    ["empty", "   "],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", {}],
  ])("rejects a %s duration", (_l, duration) => {
    expect(
      interpretFfprobeDocument(ffprobeDocument({ formatDuration: duration })),
    ).toEqual({ kind: "INVALID", reason: "DURATION_INVALID" });
  });

  it("converts a fractional-second duration to positive safe-integer milliseconds", () => {
    const result = interpretFfprobeDocument(ffprobeDocument({ formatDuration: "8.5006" }));
    expect(result).toEqual({ kind: "FACTS", facts: expect.objectContaining({ durationMs: 8501 }) });
  });

  it("falls back to the primary video stream duration when the format omits one", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        formatDuration: null,
        streams: [videoStream(1920, 1080, { duration: "4.25" })],
      }),
    );
    expect(result).toEqual({ kind: "FACTS", facts: expect.objectContaining({ durationMs: 4250 }) });
  });

  it("rejects a duration so small it rounds to zero milliseconds", () => {
    expect(interpretFfprobeDocument(ffprobeDocument({ formatDuration: "0.0001" }))).toEqual({
      kind: "INVALID",
      reason: "DURATION_INVALID",
    });
  });

  it.each([["null", null], ["a string", "probe"], ["an array", []]])(
    "rejects a document that is %s",
    (_l, document) => {
      expect(interpretFfprobeDocument(document)).toEqual({
        kind: "INVALID",
        reason: "CONTAINER_UNSUPPORTED",
      });
    },
  );
});

// ---------------------------------------------------------------------------

describe("process outcomes are classified, never surfaced", () => {
  it("returns normalized facts for a clean run", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedWith(ffprobeDocument()) });
    expect(await probe(runner).probe(PATH)).toEqual({
      kind: "FACTS",
      facts: expect.objectContaining({ container: ISO_BMFF_CONTAINER, durationMs: 8500 }),
    });
  });

  it("maps a non-zero exit to PROBE_REJECTED without carrying diagnostics", async () => {
    const runner = new FakeProcessRunner({
      outcome: { kind: "EXITED", exitCode: 1, stdout: "moov atom not found /tmp/SECRET/input" },
    });
    const outcome = await probe(runner).probe(PATH);
    expect(outcome).toEqual({ kind: "INVALID", reason: "PROBE_REJECTED" });
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
    expect(JSON.stringify(outcome)).not.toContain("moov");
  });

  it("maps a timeout to RETRYABLE, not to invalid media", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "TIMED_OUT" } });
    expect(await probe(runner).probe(PATH)).toEqual({ kind: "RETRYABLE" });
  });

  it("maps an unavailable binary to a configuration defect, never to invalid media", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "LAUNCH_FAILED" } });
    const error = await rejection(probe(runner).probe(PATH));
    expect(error).toBeInstanceOf(ManagedOutputMediaValidationDefect);
    expect((error as ManagedOutputMediaValidationDefect).code).toBe("PROBE_PROGRAM_UNAVAILABLE");
  });

  it("maps oversized output to a bounded defect", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "OUTPUT_TOO_LARGE" } });
    const error = await rejection(probe(runner).probe(PATH));
    expect((error as ManagedOutputMediaValidationDefect).code).toBe("PROBE_OUTPUT_TOO_LARGE");
  });

  it("maps malformed JSON to a fixed defect that carries none of the text", async () => {
    const runner = new FakeProcessRunner({
      outcome: { kind: "EXITED", exitCode: 0, stdout: "{not json SECRET-PAYLOAD s3://bucket/key" },
    });
    const error = await rejection(probe(runner).probe(PATH));
    expect(error).toBeInstanceOf(ManagedOutputMediaValidationDefect);
    expect((error as ManagedOutputMediaValidationDefect).code).toBe("PROBE_OUTPUT_MALFORMED");
    const text = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
    for (const fragment of ["SECRET-PAYLOAD", "s3://", "bucket", "not json"]) {
      expect(text).not.toContain(fragment);
    }
    expect((error as Error).cause).toBeUndefined();
  });

  it("never lets inspector stderr or raw error text reach an outcome", async () => {
    // Whatever the process wrote, only the closed verdict escapes.
    const runner = new FakeProcessRunner({
      outcome: { kind: "EXITED", exitCode: 69, stdout: "STDERR-SECRET /tmp/priv/input" },
    });
    const outcome = await probe(runner).probe(PATH);
    expect(Object.getOwnPropertyNames(outcome)).toEqual(["kind", "reason"]);
    expect(JSON.stringify(outcome)).not.toContain("STDERR-SECRET");
    expect(JSON.stringify(outcome)).not.toContain("/tmp/priv");
  });
});
