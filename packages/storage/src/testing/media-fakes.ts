import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import type {
  ProcessRunInput,
  ProcessRunOutcome,
  ProcessRunner,
} from "../managed-output/ffprobe";
import type {
  ManagedOutputTempFile,
  ManagedOutputTempFileFactory,
  ManagedOutputTempFileWriteResult,
} from "../managed-output/media-validation";

/**
 * Deterministic stand-ins for the media-validation boundary: a subprocess runner
 * that never launches a process, and helpers for building the inspector
 * documents the policy is tested against.
 *
 * **Test support only.** CI needs no `ffprobe` binary, and no test runs one.
 * The runner is deliberately able to *read the file it was handed*, so an
 * integration-style test can prove the inspector would receive the exact
 * canonical bytes rather than merely a path-shaped argument.
 */

/** What one fake run observed, for assertions. */
export interface FakeProcessRun {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  /** SHA-256 of the file at the invoked path, if it existed when run. */
  readonly seenFileSha256: string | null;
  /** Byte length of that file, if it existed. */
  readonly seenFileBytes: number | null;
  /** Octal permission bits of that file, if the platform reported them. */
  readonly seenFileMode: number | null;
  /** Whether the file existed at invocation time. */
  readonly fileExisted: boolean;
}

export interface FakeProcessRunnerOptions {
  /**
   * The outcome to return. A function receives the run record so a test can
   * derive the document from the bytes the inspector actually saw.
   */
  readonly outcome?: ProcessRunOutcome | ((run: FakeProcessRun) => ProcessRunOutcome);
  /** Throw this from `run` (an unexpected adapter failure). */
  readonly throws?: unknown;
}

/**
 * A process runner that reads the file it was pointed at instead of executing
 * anything. Records every invocation.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly runs: FakeProcessRun[] = [];
  readonly #options: FakeProcessRunnerOptions;

  constructor(options: FakeProcessRunnerOptions = {}) {
    this.#options = options;
  }

  get lastRun(): FakeProcessRun {
    const last = this.runs.at(-1);
    if (last === undefined) throw new Error("fake runner: nothing was run");
    return last;
  }

  async run(input: ProcessRunInput): Promise<ProcessRunOutcome> {
    // The invoked path is the last argument by the adapter's fixed arg vector.
    const path = input.args.at(-1) ?? "";
    let seenFileSha256: string | null = null;
    let seenFileBytes: number | null = null;
    let seenFileMode: number | null = null;
    let fileExisted = false;
    try {
      const bytes = await readFile(path);
      fileExisted = true;
      seenFileSha256 = createHash("sha256").update(bytes).digest("hex");
      seenFileBytes = bytes.byteLength;
      try {
        const stats = await stat(path);
        seenFileMode = stats.mode & 0o777;
      } catch {
        seenFileMode = null;
      }
    } catch {
      fileExisted = false;
    }

    const record: FakeProcessRun = {
      program: input.program,
      args: [...input.args],
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      seenFileSha256,
      seenFileBytes,
      seenFileMode,
      fileExisted,
    };
    this.runs.push(record);

    if (this.#options.throws !== undefined) throw this.#options.throws;
    const outcome = this.#options.outcome ?? {
      kind: "EXITED" as const,
      exitCode: 0,
      stdout: JSON.stringify(ffprobeDocument()),
    };
    return typeof outcome === "function" ? outcome(record) : outcome;
  }
}

export interface FfprobeDocumentOptions {
  readonly formatName?: string | null;
  readonly formatDuration?: unknown;
  readonly streams?: readonly Record<string, unknown>[];
  /** Omit the `format` object entirely. */
  readonly omitFormat?: boolean;
}

/**
 * One video stream with the given dimensions. Passing `undefined` for a
 * dimension omits the key entirely, which is how a real "missing width" document
 * looks — a default parameter would silently substitute a valid value instead.
 */
export function videoStream(
  width: unknown,
  height: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const stream: Record<string, unknown> = { codec_type: "video", ...extra };
  if (width !== undefined) stream.width = width;
  if (height !== undefined) stream.height = height;
  return stream;
}

/** One audio stream. */
export function audioStream(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { codec_type: "audio", ...extra };
}

/**
 * Embedded cover art as ffprobe reports it: `codec_type: "video"` with
 * `disposition.attached_pic`, and perfectly plausible dimensions. This is what
 * an audio-only M4A or podcast with album art looks like, and it must never be
 * mistaken for the customer's video.
 */
export function attachedPictureStream(
  width: unknown = 1400,
  height: unknown = 1400,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...videoStream(width, height, extra),
    disposition: { attached_pic: 1, ...(isRecord(extra.disposition) ? extra.disposition : {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build an ffprobe-shaped document. Defaults describe a valid MP4-family file
 * with a single 1920×1080 video stream and no audio.
 */
export function ffprobeDocument(options: FfprobeDocumentOptions = {}): Record<string, unknown> {
  const streams = options.streams ?? [videoStream(1920, 1080)];
  const document: Record<string, unknown> = { streams: [...streams] };
  if (options.omitFormat !== true) {
    const format: Record<string, unknown> = {};
    const formatName = options.formatName === undefined ? "mov,mp4,m4a,3gp,3g2,mj2" : options.formatName;
    if (formatName !== null) format.format_name = formatName;
    const duration = options.formatDuration === undefined ? "8.500000" : options.formatDuration;
    if (duration !== null) format.duration = duration;
    document.format = format;
  }
  return document;
}

/** A successful run returning the given document as stdout JSON. */
export function exitedWith(document: unknown): ProcessRunOutcome {
  return { kind: "EXITED", exitCode: 0, stdout: JSON.stringify(document) };
}

// ---------------------------------------------------------------------------

/**
 * A temporary-file writer that wraps a **real** owner-only file while making
 * the failure modes of local materialization reachable: short writes, a writer
 * that reports impossible progress, an open that fails, and a close that fails.
 *
 * Wrapping a real file is the point. The fake process runner reads whatever is
 * actually on disk, so a test can prove what the inspector would have seen
 * rather than what the validator believed it wrote.
 */
export interface FakeTempFileOptions {
  /** Reject `openExclusive0600` (models a local open failure after the GET). */
  readonly openFails?: boolean;
  /**
   * Cap successive delegated writes at these lengths, in order; once exhausted,
   * each remaining write takes everything it is offered. `[2, 3]` writes the
   * first two bytes, then three, then the rest — a real short-write sequence.
   */
  readonly writeCaps?: readonly number[];
  /**
   * Make the Nth (1-based) write report `bytesWritten` while delegating
   * nothing, so the file falls behind what the report claims.
   */
  readonly reportWithoutWriting?: { readonly call: number; readonly bytesWritten: number };
  /** Fail `close()` — after the real descriptor has been released. */
  readonly closeFails?: boolean;
}

/** What one delegated write did, for assertions. */
export interface FakeTempFileWrite {
  readonly offset: number;
  readonly length: number;
  /** What the seam reported to the validator. */
  readonly bytesWritten: number;
  /** What actually reached the file. */
  readonly delegated: number;
}

class FakeTempFile implements ManagedOutputTempFile {
  readonly #handle: Awaited<ReturnType<typeof open>>;
  readonly #options: FakeTempFileOptions;
  readonly #owner: FakeManagedOutputTempFiles;
  #writeCount = 0;

  constructor(
    handle: Awaited<ReturnType<typeof open>>,
    options: FakeTempFileOptions,
    owner: FakeManagedOutputTempFiles,
  ) {
    this.#handle = handle;
    this.#options = options;
    this.#owner = owner;
  }

  async write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<ManagedOutputTempFileWriteResult> {
    this.#writeCount += 1;

    const forced = this.#options.reportWithoutWriting;
    if (forced !== undefined && forced.call === this.#writeCount) {
      this.#owner.writes.push({ offset, length, bytesWritten: forced.bytesWritten, delegated: 0 });
      return { bytesWritten: forced.bytesWritten };
    }

    const cap = this.#options.writeCaps?.[this.#writeCount - 1];
    const take = cap === undefined ? length : Math.min(cap, length);
    const { bytesWritten } = await this.#handle.write(data, offset, take, null);
    this.#owner.writes.push({ offset, length, bytesWritten, delegated: take });
    return { bytesWritten };
  }

  async close(): Promise<void> {
    this.#owner.closeCalls += 1;
    // Release the real descriptor either way: a simulated failure must not leak
    // an OS handle into the rest of the suite.
    await this.#handle.close();
    if (this.#options.closeFails === true) {
      throw new Error("fake temp file: close refused (simulated flush failure)");
    }
  }
}

/** Opens {@link FakeTempFile} instances and records everything they were asked. */
export class FakeManagedOutputTempFiles implements ManagedOutputTempFileFactory {
  readonly openedPaths: string[] = [];
  readonly writes: FakeTempFileWrite[] = [];
  closeCalls = 0;
  readonly #options: FakeTempFileOptions;

  constructor(options: FakeTempFileOptions = {}) {
    this.#options = options;
  }

  async openExclusive0600(path: string): Promise<ManagedOutputTempFile> {
    this.openedPaths.push(path);
    if (this.#options.openFails === true) {
      throw new Error("fake temp file: EACCES opening /nonexistent-secret-path/input");
    }
    return new FakeTempFile(await open(path, "wx", 0o600), this.#options, this);
  }
}
