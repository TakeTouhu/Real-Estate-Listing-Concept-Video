import { execFile } from "node:child_process";
import { AppError } from "@app/shared";
import {
  ISO_BMFF_CONTAINER,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaInvalidReason,
} from "@app/domain";
import {
  ManagedOutputMediaValidationDefect,
  type ManagedOutputMediaProbe,
  type ManagedOutputMediaProbeOutcome,
} from "./media-validation";

/**
 * The dormant `ffprobe`-backed media inspector.
 *
 * ## What this proves, and what it does not
 *
 * Container inspection is **not** a full-frame decode verification. `ffprobe`
 * reads container metadata and stream headers; it does not decode every frame,
 * and a file it describes happily can still contain corrupt pictures. Nothing
 * here may be described as proving the output is "fully playable". A later,
 * reviewed phase may add a bounded or complete decode pass if the product needs
 * that guarantee; this phase deliberately stops at container and stream facts.
 *
 * ## No shell, ever
 *
 * The inspector is invoked through `execFile` with `shell: false`. There is no
 * command string anywhere in this module — nothing is interpolated, quoted or
 * escaped, because nothing is parsed by a shell. The only variable argument is a
 * path this process created in its own temporary directory; a bucket, key,
 * provider URL, signed location or customer filename is never passed.
 *
 * ## Bounded
 *
 * The subprocess runs under a validated timeout and a validated stdout ceiling.
 * Output beyond the ceiling terminates the process rather than accumulating, a
 * timeout kills it, and stderr is discarded rather than captured into anything
 * that could be surfaced.
 *
 * ## Availability is not invalidity
 *
 * A program that runs and exits non-zero is evidence about the *file*:
 * `PROBE_REJECTED`. A program that cannot be launched at all is evidence about
 * the *deployment*, and is a fixed configuration defect — never a claim that the
 * customer's video is broken. A timeout is neither, and is retryable.
 */

/** A bounded subprocess invocation. No shell, fixed args, capped output. */
export interface ProcessRunInput {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

/**
 * What running the inspector concluded, before any interpretation.
 *
 * `LAUNCH_FAILED` is deliberately distinct from a non-zero exit: one means the
 * binary is missing or unusable, the other means it ran and refused the file.
 */
export type ProcessRunOutcome =
  | { readonly kind: "EXITED"; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: "TIMED_OUT" }
  | { readonly kind: "OUTPUT_TOO_LARGE" }
  | { readonly kind: "LAUNCH_FAILED" };

export interface ProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunOutcome>;
}

/** 15 seconds: generous for metadata inspection, far below any request budget. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** 1 MiB of JSON is already far more than a stream listing needs. */
export const DEFAULT_PROBE_MAX_STDOUT_BYTES = 1_048_576;
/** Hard bounds, so a configuration cannot remove the bound entirely. */
export const MAX_PROBE_TIMEOUT_MS = 120_000;
export const MAX_PROBE_STDOUT_BYTES = 8 * 1_048_576;
/** The default program name. No environment variable is introduced this phase. */
export const DEFAULT_PROBE_PROGRAM = "ffprobe";

export interface FfprobeMediaProbeConfig {
  /** Injected for a future composition; defaults to the bare program name. */
  readonly programPath?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
}

export interface FfprobeMediaProbeDeps {
  readonly runner: ProcessRunner;
}

export function validateProbeTimeoutMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_PROBE_TIMEOUT_MS
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Media inspector timeout must be a positive safe integer no greater than 120s",
    );
  }
  return value;
}

export function validateProbeMaxStdoutBytes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_PROBE_STDOUT_BYTES
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Media inspector stdout limit must be a positive safe integer no greater than 8 MiB",
    );
  }
  return value;
}

/**
 * The fixed argument vector. The only variable element is the
 * application-created local path, appended last.
 */
export function ffprobeArgsFor(localPath: string): readonly string[] {
  return ["-v", "error", "-of", "json", "-show_format", "-show_streams", localPath];
}

// ---------------------------------------------------------------------------
// JSON → normalized facts. Infrastructure-local; raw JSON never leaves here.
// ---------------------------------------------------------------------------

/** MP4-family (ISO Base Media File Format) `format_name` tokens ffprobe emits. */
const ISO_BMFF_FORMAT_TOKENS: ReadonlySet<string> = new Set([
  "mp4",
  "m4a",
  "m4v",
  "mov",
  "3gp",
  "3g2",
  "mj2",
  "isom",
  "f4v",
  "qt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite, positive number — from JSON, so it may be a numeric string. */
function finitePositiveNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** A positive safe-integer dimension — from JSON, so possibly a numeric string. */
function positiveSafeInteger(value: unknown): number | null {
  const asNumber = finitePositiveNumber(value);
  if (asNumber === null) return null;
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/**
 * Whether the reported `format_name` names an MP4-family container.
 *
 * ffprobe reports a comma-separated candidate list; any ISO-BMFF member is
 * enough. The *filename* is never consulted — the managed key is extensionless
 * by design, and an extension would prove nothing anyway.
 */
export function isIsoBmffFormatName(formatName: unknown): boolean {
  if (typeof formatName !== "string") return false;
  return formatName
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .some((token) => ISO_BMFF_FORMAT_TOKENS.has(token));
}

/**
 * Interpret one parsed ffprobe document under the closed media policy.
 *
 * Returns normalized facts or a fixed refusal reason. Nothing from the document
 * escapes: no `format_name`, no codec names, no filename, no tags.
 */
export function interpretFfprobeDocument(
  document: unknown,
): { readonly kind: "FACTS"; readonly facts: ManagedOutputMediaFacts } | {
  readonly kind: "INVALID";
  readonly reason: ManagedOutputMediaInvalidReason;
} {
  if (!isRecord(document)) return { kind: "INVALID", reason: "CONTAINER_UNSUPPORTED" };

  const format = isRecord(document.format) ? document.format : null;
  if (format === null || !isIsoBmffFormatName(format.format_name)) {
    return { kind: "INVALID", reason: "CONTAINER_UNSUPPORTED" };
  }

  const rawStreams = document.streams;
  const streams: Record<string, unknown>[] = Array.isArray(rawStreams)
    ? rawStreams.filter(isRecord)
    : [];

  // Primary video stream determinism: the first stream ffprobe lists whose
  // codec_type is "video", regardless of how many other streams are present.
  const videoStreams = streams.filter((s) => s.codec_type === "video");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const primaryVideo = videoStreams[0];
  if (primaryVideo === undefined) {
    return { kind: "INVALID", reason: "VIDEO_STREAM_MISSING" };
  }

  const width = positiveSafeInteger(primaryVideo.width);
  const height = positiveSafeInteger(primaryVideo.height);
  if (width === null || height === null) {
    return { kind: "INVALID", reason: "VIDEO_DIMENSIONS_INVALID" };
  }

  // Duration: the container's own duration is preferred. A primary-video-stream
  // duration is accepted as a documented fallback, because a valid MP4 can carry
  // the duration on the track when the format entry is absent.
  const durationSeconds =
    finitePositiveNumber(format.duration) ?? finitePositiveNumber(primaryVideo.duration);
  if (durationSeconds === null) {
    return { kind: "INVALID", reason: "DURATION_INVALID" };
  }
  const durationMs = Math.round(durationSeconds * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return { kind: "INVALID", reason: "DURATION_INVALID" };
  }

  return {
    kind: "FACTS",
    facts: {
      container: ISO_BMFF_CONTAINER,
      durationMs,
      videoWidth: width,
      videoHeight: height,
      videoStreamCount: videoStreams.length,
      audioStreamCount: audioStreams.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export class FfprobeMediaProbe implements ManagedOutputMediaProbe {
  readonly #program: string;
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #runner: ProcessRunner;

  constructor(config: FfprobeMediaProbeConfig, deps: FfprobeMediaProbeDeps) {
    this.#program = config.programPath ?? DEFAULT_PROBE_PROGRAM;
    if (typeof this.#program !== "string" || this.#program.trim().length === 0) {
      throw new AppError("CONFIGURATION_ERROR", "Media inspector program must be non-blank");
    }
    this.#timeoutMs = validateProbeTimeoutMs(config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    this.#maxStdoutBytes = validateProbeMaxStdoutBytes(
      config.maxStdoutBytes ?? DEFAULT_PROBE_MAX_STDOUT_BYTES,
    );
    this.#runner = deps.runner;
  }

  async probe(localPath: string): Promise<ManagedOutputMediaProbeOutcome> {
    const outcome = await this.#runner.run({
      program: this.#program,
      args: ffprobeArgsFor(localPath),
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: this.#maxStdoutBytes,
    });

    switch (outcome.kind) {
      case "TIMED_OUT":
        // Neither a statement about the file nor about the deployment.
        return { kind: "RETRYABLE" };
      case "LAUNCH_FAILED":
        // The binary is missing or unusable: a deployment defect, never a claim
        // that the customer's video is invalid.
        throw new ManagedOutputMediaValidationDefect("PROBE_PROGRAM_UNAVAILABLE");
      case "OUTPUT_TOO_LARGE":
        throw new ManagedOutputMediaValidationDefect("PROBE_OUTPUT_TOO_LARGE");
      case "EXITED":
        break;
    }

    if (outcome.exitCode !== 0) {
      // It ran and refused the file: structurally unreadable media. The
      // inspector's own diagnostics are not carried.
      return { kind: "INVALID", reason: "PROBE_REJECTED" };
    }

    let document: unknown;
    try {
      document = JSON.parse(outcome.stdout);
    } catch {
      // Malformed output from a tool that exited zero is a contract violation,
      // not media evidence. The raw text never enters the defect.
      throw new ManagedOutputMediaValidationDefect("PROBE_OUTPUT_MALFORMED");
    }

    const interpreted = interpretFfprobeDocument(document);
    return interpreted.kind === "FACTS"
      ? { kind: "FACTS", facts: interpreted.facts }
      : { kind: "INVALID", reason: interpreted.reason };
  }
}

/**
 * The default process runner, backed by `execFile` with `shell: false`.
 *
 * Provided so a future wiring has a real implementation to inject; constructed
 * nowhere in production this phase, and every test drives a fake runner instead
 * so CI never needs an `ffprobe` binary. `maxBuffer` is what terminates a
 * process whose output exceeds the ceiling, and stderr is discarded rather than
 * captured.
 */
export function createDefaultProcessRunner(): ProcessRunner {
  return {
    async run(input: ProcessRunInput): Promise<ProcessRunOutcome> {
      return await new Promise<ProcessRunOutcome>((resolve) => {
        execFile(
          input.program,
          [...input.args],
          {
            shell: false,
            timeout: input.timeoutMs,
            maxBuffer: input.maxStdoutBytes,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error === null) {
              resolve({ kind: "EXITED", exitCode: 0, stdout: String(stdout) });
              return;
            }
            // Every property read below is guarded: a hostile or unusual error
            // object must not escape, and none of its text is ever surfaced.
            let code: unknown;
            let killed: unknown;
            let exitCode: unknown;
            try {
              code = (error as { code?: unknown }).code;
              killed = (error as { killed?: unknown }).killed;
              exitCode = (error as { code?: unknown }).code;
            } catch {
              resolve({ kind: "LAUNCH_FAILED" });
              return;
            }
            if (code === "ENOENT" || code === "EACCES") {
              resolve({ kind: "LAUNCH_FAILED" });
              return;
            }
            if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ kind: "OUTPUT_TOO_LARGE" });
              return;
            }
            if (killed === true) {
              resolve({ kind: "TIMED_OUT" });
              return;
            }
            resolve({
              kind: "EXITED",
              exitCode: typeof exitCode === "number" ? exitCode : 1,
              stdout: String(stdout),
            });
          },
        );
      });
    },
  };
}
