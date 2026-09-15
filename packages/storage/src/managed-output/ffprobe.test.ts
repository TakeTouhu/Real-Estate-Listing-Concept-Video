import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { ISO_BMFF_CONTAINER } from "@app/domain";
import {
  attachedPictureStream,
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
  classifyProcessError,
  ffprobeArgsFor,
  interpretFfprobeDocument,
  isIsoBmffFormatName,
  isUsableVideoStream,
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

describe("embedded artwork is not the customer's video", () => {
  it("recognizes a usable video stream and rejects attached artwork", () => {
    expect(isUsableVideoStream(videoStream(1920, 1080))).toBe(true);
    expect(isUsableVideoStream(attachedPictureStream())).toBe(false);
    // The numeric-string form external JSON may carry is excluded too.
    expect(
      isUsableVideoStream({ codec_type: "video", width: 8, height: 8, disposition: { attached_pic: "1" } }),
    ).toBe(false);
    // A disposition that merely exists, or says 0, does not exclude anything.
    expect(
      isUsableVideoStream({ codec_type: "video", width: 8, height: 8, disposition: { attached_pic: 0 } }),
    ).toBe(true);
    expect(isUsableVideoStream(audioStream())).toBe(false);
    expect(isUsableVideoStream(null)).toBe(false);
  });

  it("refuses an audio-only file whose only 'video' stream is cover art", () => {
    // An M4A podcast with album art: positive artwork dimensions and a positive
    // container duration must not add up to a valid video.
    const result = interpretFfprobeDocument(
      ffprobeDocument({ streams: [audioStream(), attachedPictureStream(1400, 1400)] }),
    );
    expect(result).toEqual({ kind: "INVALID", reason: "VIDEO_STREAM_MISSING" });
  });

  it("refuses a file carrying several attached pictures and no real video", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        streams: [
          attachedPictureStream(1400, 1400),
          audioStream(),
          attachedPictureStream(600, 600),
          attachedPictureStream(3000, 3000),
        ],
      }),
    );
    expect(result).toEqual({ kind: "INVALID", reason: "VIDEO_STREAM_MISSING" });
  });

  it("selects the real video stream even when artwork is listed first", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        streams: [audioStream(), attachedPictureStream(1400, 1400), videoStream(1920, 1080)],
      }),
    );
    expect(result).toEqual({
      kind: "FACTS",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 8500,
        // The real video's dimensions, not the artwork's.
        videoWidth: 1920,
        videoHeight: 1080,
        videoStreamCount: 1,
        audioStreamCount: 1,
      },
    });
  });

  it("counts only usable video streams, never artwork", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        streams: [
          videoStream(1920, 1080),
          attachedPictureStream(),
          videoStream(640, 360),
          attachedPictureStream(),
          audioStream(),
        ],
      }),
    );
    expect(result).toMatchObject({
      kind: "FACTS",
      facts: { videoStreamCount: 2, audioStreamCount: 1, videoWidth: 1920, videoHeight: 1080 },
    });
  });

  it("never takes the duration fallback from an attached picture", () => {
    // No container duration at all. The artwork carries a plausible one; the
    // real video does not. Falling back to the artwork would invent a duration.
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        formatDuration: null,
        streams: [
          attachedPictureStream(1400, 1400, { duration: "12.000000" }),
          videoStream(1920, 1080),
        ],
      }),
    );
    expect(result).toEqual({ kind: "INVALID", reason: "DURATION_INVALID" });
  });

  it("still takes the documented fallback from the real video stream", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        formatDuration: null,
        streams: [
          attachedPictureStream(1400, 1400, { duration: "99.000000" }),
          videoStream(1920, 1080, { duration: "4.250000" }),
        ],
      }),
    );
    expect(result).toMatchObject({ kind: "FACTS", facts: { durationMs: 4250 } });
  });

  it("judges dimensions on the real video, not on artwork that happens to be valid", () => {
    const result = interpretFfprobeDocument(
      ffprobeDocument({
        streams: [attachedPictureStream(1400, 1400), videoStream(0, undefined)],
      }),
    );
    expect(result).toEqual({ kind: "INVALID", reason: "VIDEO_DIMENSIONS_INVALID" });
  });
});

// ---------------------------------------------------------------------------

/**
 * The narrowest deterministic seam for the runner's judgement: the pure
 * classification of one `execFile` callback error. No subprocess, no binary, no
 * host condition to reproduce.
 */
describe("host and process failures are never fabricated into an exit status", () => {
  function err(props: Record<string, unknown>): unknown {
    return Object.assign(new Error("boom SECRET-DETAIL /tmp/SECRET/input"), props);
  }

  it("keeps a real numeric exit status as EXITED", () => {
    expect(classifyProcessError(err({ code: 1 }), "partial")).toEqual({
      kind: "EXITED",
      exitCode: 1,
      stdout: "partial",
    });
    expect(classifyProcessError(err({ code: 69 }), "")).toMatchObject({
      kind: "EXITED",
      exitCode: 69,
    });
  });

  it.each([
    ["ENOENT", "LAUNCH_FAILED"],
    ["EACCES", "LAUNCH_FAILED"],
    ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "OUTPUT_TOO_LARGE"],
    ["EMFILE", "TRANSIENT_FAILURE"],
    ["ENOMEM", "TRANSIENT_FAILURE"],
    ["EAGAIN", "TRANSIENT_FAILURE"],
    ["ESOMETHINGUNKNOWN", "TRANSIENT_FAILURE"],
  ])("classifies system code %s as %s", (code, expected) => {
    expect(classifyProcessError(err({ code }), "")).toMatchObject({ kind: expected });
  });

  it("keeps our own configured timeout as TIMED_OUT", () => {
    // Node marks a timeout kill with killed: true and a signal.
    expect(classifyProcessError(err({ killed: true, signal: "SIGTERM" }), "")).toEqual({
      kind: "TIMED_OUT",
    });
  });

  it("classifies a signal we did not send as a transient host failure", () => {
    // The OOM killer, an operator, or a crash — not a verdict about the video.
    expect(classifyProcessError(err({ killed: false, signal: "SIGKILL" }), "")).toEqual({
      kind: "TRANSIENT_FAILURE",
    });
    expect(classifyProcessError(err({ signal: "SIGSEGV" }), "")).toEqual({
      kind: "TRANSIENT_FAILURE",
    });
  });

  it("does not invent exit 1 for an unrecognizable failure", () => {
    for (const shape of [{}, { code: undefined }, { code: null }, { code: 1.5 }, { code: "1" }]) {
      expect(classifyProcessError(err(shape), "")).toEqual({ kind: "TRANSIENT_FAILURE" });
    }
  });

  it("survives hostile error properties without leaking them", () => {
    const hostile = new Error("outer SECRET-DETAIL");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("getter SECRET-DETAIL s3://bucket/key");
      },
    });
    const outcome = classifyProcessError(hostile, "");
    expect(outcome).toEqual({ kind: "TRANSIENT_FAILURE" });
    expect(JSON.stringify(outcome)).not.toContain("SECRET-DETAIL");
    expect(JSON.stringify(outcome)).not.toContain("s3://");
  });

  it("carries none of the error's own text into any outcome", () => {
    for (const shape of [{ code: 1 }, { code: "ENOENT" }, { code: "EMFILE" }, { signal: "SIGKILL" }]) {
      const text = JSON.stringify(classifyProcessError(err(shape), ""));
      expect(text).not.toContain("SECRET-DETAIL");
      expect(text).not.toContain("/tmp/SECRET");
      expect(text).not.toContain("boom");
    }
  });
});

// ---------------------------------------------------------------------------

describe("the probe maps every process outcome to the closed model", () => {
  it.each([
    ["a numeric non-zero exit", { code: 1 }, { kind: "INVALID", reason: "PROBE_REJECTED" }],
    ["EMFILE", { code: "EMFILE" }, { kind: "RETRYABLE" }],
    ["ENOMEM", { code: "ENOMEM" }, { kind: "RETRYABLE" }],
    ["an unexpected signal", { killed: false, signal: "SIGKILL" }, { kind: "RETRYABLE" }],
    ["an unknown non-numeric code", { code: "EWHATEVER" }, { kind: "RETRYABLE" }],
    ["our configured timeout", { killed: true, signal: "SIGTERM" }, { kind: "RETRYABLE" }],
  ])("maps %s through classification to the right verdict", async (_label, shape, expected) => {
    const outcome = classifyProcessError(
      Object.assign(new Error("boom SECRET-DETAIL"), shape),
      "",
    );
    const runner = new FakeProcessRunner({ outcome });
    const result = await probe(runner).probe(PATH);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("SECRET-DETAIL");
  });

  it.each([
    ["ENOENT", { code: "ENOENT" }],
    ["EACCES", { code: "EACCES" }],
  ])("keeps %s a fixed configuration defect, never invalid media", async (_label, shape) => {
    const outcome = classifyProcessError(Object.assign(new Error("boom"), shape), "");
    expect(outcome).toEqual({ kind: "LAUNCH_FAILED" });
    const error = await rejection(probe(new FakeProcessRunner({ outcome })).probe(PATH));
    expect((error as ManagedOutputMediaValidationDefect).code).toBe("PROBE_PROGRAM_UNAVAILABLE");
  });

  it("keeps the max-buffer error its own fixed defect", async () => {
    const outcome = classifyProcessError(
      Object.assign(new Error("boom"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      "",
    );
    expect(outcome).toEqual({ kind: "OUTPUT_TOO_LARGE" });
    const error = await rejection(probe(new FakeProcessRunner({ outcome })).probe(PATH));
    expect((error as ManagedOutputMediaValidationDefect).code).toBe("PROBE_OUTPUT_TOO_LARGE");
  });

  it("maps a transient host failure to RETRYABLE, never to a defect or a verdict", async () => {
    const runner = new FakeProcessRunner({ outcome: { kind: "TRANSIENT_FAILURE" } });
    expect(await probe(runner).probe(PATH)).toEqual({ kind: "RETRYABLE" });
  });
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
