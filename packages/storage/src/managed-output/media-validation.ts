import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@app/shared";
import {
  parseVerificationReceipt,
  type ManagedGenerationOutputKey,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaInvalidReason,
  type ManagedOutputMediaValidationInput,
  type ManagedOutputMediaValidationOutcome,
  type ManagedOutputMediaValidationPort,
} from "@app/domain";
import type { S3GetObjectInput, S3GetObjectResult, S3ObjectBody } from "./s3-staging-sink";
import {
  MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
  validateManagedOutputByteLimit,
} from "./streaming-transfer";

/**
 * The dormant managed-output media validator: does the object already published
 * at a canonical key actually contain media, and is it still the bytes we
 * published?
 *
 * ## Two questions, deliberately in this order
 *
 * The canonical bytes are re-read and re-hashed **before** any media inspection
 * runs. Byte integrity is the cheaper, stricter question, and answering it first
 * means a corrupted, truncated or replaced object is reported as
 * `INTEGRITY_MISMATCH` rather than being handed to an inspector that might
 * cheerfully describe whatever it found. Mismatching bytes are never probed.
 *
 * ## Why the bytes are materialized to a file
 *
 * MP4-family containers are not reliably inspectable from a forward-only pipe:
 * the `moov` atom may sit at the end of the file, so an inspector needs to seek.
 * Rather than assume the object is faststart-optimized, the validator streams
 * the object to a temporary file and inspects that. Streaming is still
 * incremental — the object is never held in memory, never concatenated, never
 * turned into one array — and the hash and byte count are computed on the way
 * past, so materialization and verification are one pass.
 *
 * ## The materialization invariant
 *
 * The canonical object is not merely *hashed while being copied*. Every
 * canonical chunk must be **completely materialized locally**, and the local
 * file must **close successfully**, before the inspector may look at it:
 *
 * ```text
 * bytes admitted to the probe
 *   === bytes materialized to the temporary file
 *   === bytes hashed and counted from the canonical object
 * ```
 *
 * A write may be short — `write()` consuming part of a buffer is a request to
 * continue, not an error — so each chunk is written in a loop until every byte
 * of it has landed, and only then does it advance the authoritative hash and
 * byte count. A chunk that cannot be fully written, a writer that reports no
 * progress, and a close that fails all end the same way: `RETRYABLE_FAILURE`,
 * with the partial file discarded and the inspector never invoked. Without
 * that ordering the hash would describe bytes the inspector never saw, and a
 * truncated local copy could be reported as invalid media — a storage problem
 * dressed up as a verdict about the customer's video.
 *
 * ## What the inspector is told
 *
 * A path this process created, and nothing else. No bucket, no key, no provider
 * URL, no customer filename. The temporary directory name is random and
 * application-owned, and the file inside it is always called `input`, so the
 * command line carries no tenant-identifying data even in a process listing.
 *
 * ## Dormant
 *
 * Nothing in production constructs this validator, no production code performs a
 * media-validation read, and no runner calls it. It is tested against a fake
 * object reader and a fake process runner; CI needs no `ffprobe` binary.
 */

/**
 * The read-only slice of the S3 seam media validation needs.
 *
 * Narrower than the multipart client on purpose — the validator can read one
 * canonical object and do nothing else: it cannot create an upload, write a
 * part, complete, or abort. The existing `S3MultipartClient` satisfies this
 * structurally, so no second cloud abstraction is introduced.
 */
export interface S3ManagedObjectReader {
  getObject(input: S3GetObjectInput): Promise<S3GetObjectResult>;
}

/**
 * What inspecting a materialized local file concluded — application-owned and
 * closed. The inspector's own output never crosses this boundary.
 */
export type ManagedOutputMediaProbeOutcome =
  | { readonly kind: "FACTS"; readonly facts: ManagedOutputMediaFacts }
  | { readonly kind: "INVALID"; readonly reason: ManagedOutputMediaInvalidReason }
  | { readonly kind: "RETRYABLE" };

/**
 * The media inspector seam. It is handed a path this process created and
 * returns normalized facts or a closed refusal — never raw tool output.
 */
export interface ManagedOutputMediaProbe {
  probe(localPath: string): Promise<ManagedOutputMediaProbeOutcome>;
}

/** What one local write reported. Deliberately the only thing the seam returns. */
export interface ManagedOutputTempFileWriteResult {
  readonly bytesWritten: number;
}

/**
 * The open temporary file media validation materializes into.
 *
 * Narrow on purpose: this is **not** a filesystem abstraction and nothing else
 * in the repository may use it. It exposes exactly the two operations whose
 * failure modes change the validator's answer — a possibly-short `write` and a
 * `close` that can fail — so those paths can be exercised without a real
 * failing disk.
 */
export interface ManagedOutputTempFile {
  /**
   * Write `length` bytes of `data` starting at `data[offset]`, appending at the
   * current file position. May write fewer bytes than asked; the caller loops.
   */
  write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<ManagedOutputTempFileWriteResult>;
  close(): Promise<void>;
}

/** Opens the one temporary file media validation materializes into. */
export interface ManagedOutputTempFileFactory {
  /** Exclusive create (`wx`), owner-only mode. Rejects if the path exists. */
  openExclusive0600(path: string): Promise<ManagedOutputTempFile>;
}

/** The production temporary file: a plain `FileHandle`, nothing added. */
class NodeManagedOutputTempFile implements ManagedOutputTempFile {
  readonly #handle: FileHandle;

  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  async write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<ManagedOutputTempFileWriteResult> {
    // `position: null` appends at the handle's current offset.
    const { bytesWritten } = await this.#handle.write(data, offset, length, null);
    return { bytesWritten };
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** The production factory. Tests substitute a writer with controllable seams. */
export const nodeManagedOutputTempFileFactory: ManagedOutputTempFileFactory = {
  async openExclusive0600(path: string): Promise<ManagedOutputTempFile> {
    return new NodeManagedOutputTempFile(await open(path, "wx", 0o600));
  },
};

export type ManagedOutputMediaValidationDefectCode =
  | "EXPECTED_RECEIPT_MALFORMED"
  | "PROBE_PROGRAM_UNAVAILABLE"
  | "PROBE_OUTPUT_MALFORMED"
  | "PROBE_OUTPUT_TOO_LARGE";

const DEFECT_MESSAGES: Record<ManagedOutputMediaValidationDefectCode, string> = {
  EXPECTED_RECEIPT_MALFORMED:
    "The expected managed-output receipt is not a well-formed verification receipt",
  PROBE_PROGRAM_UNAVAILABLE: "The media inspector program could not be launched",
  PROBE_OUTPUT_MALFORMED: "The media inspector returned output outside its contract",
  PROBE_OUTPUT_TOO_LARGE: "The media inspector produced more output than the configured limit",
};

/**
 * The fixed, application-owned defect for media validation. Like every other
 * defect on this pipeline it carries no `cause` and no offending value: an
 * inspector's stderr, a malformed JSON body and an OS error are all external
 * data, and the default rendering of a thrown value is where such content
 * escapes without anyone choosing to log it.
 */
export class ManagedOutputMediaValidationDefect extends Error {
  readonly code: ManagedOutputMediaValidationDefectCode;

  constructor(code: ManagedOutputMediaValidationDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "ManagedOutputMediaValidationDefect";
    this.code = code;
  }
}

export interface S3ManagedOutputMediaValidatorConfig {
  readonly bucket: string;
  /**
   * The ceiling enforced while materializing the canonical object; default and
   * maximum {@link MAX_MANAGED_PROVIDER_OUTPUT_BYTES}. An over-limit object never
   * reaches the inspector.
   */
  readonly maxBytes?: number;
  readonly expectedBucketOwner?: string;
}

export interface S3ManagedOutputMediaValidatorDeps {
  readonly reader: S3ManagedObjectReader;
  readonly probe: ManagedOutputMediaProbe;
  /**
   * The local materialization seam; defaults to a real owner-only temporary
   * file. Substituted only so short writes, zero-progress writes and close
   * failures can be exercised deterministically.
   */
  readonly tempFiles?: ManagedOutputTempFileFactory;
}

/** The fixed local filename — never derived from a key, tenant or provider. */
export const MEDIA_VALIDATION_TEMP_FILENAME = "input";

/** The application-owned temporary directory prefix. Carries no tenant data. */
export const MEDIA_VALIDATION_TEMP_PREFIX = "managed-output-media-";

const RETRYABLE: ManagedOutputMediaValidationOutcome = { kind: "RETRYABLE_FAILURE" };
const INTEGRITY_MISMATCH: ManagedOutputMediaValidationOutcome = { kind: "INTEGRITY_MISMATCH" };

/** Best-effort release of a canonical-object body. */
async function cancelQuietly(body: S3ObjectBody): Promise<void> {
  try {
    await body.cancel();
  } catch {
    // Best effort; nothing in scope to leak.
  }
}

/** What materializing the canonical object concluded. Internal to this module. */
type Materialized =
  | { readonly kind: "OK"; readonly sha256: string; readonly sizeBytes: number }
  | { readonly kind: "RETRYABLE" };

/**
 * Write every byte of `chunk`, in order, honouring short writes.
 *
 * `true` means the exact bytes of this chunk are now in the file — no byte
 * skipped, none written twice — so the caller may finally count and hash them.
 * `false` means the local copy is incomplete or the writer reported progress
 * that cannot be true, and nothing derived from the file may be trusted.
 *
 * The progress guard is what keeps this loop bounded: a writer that reports
 * zero, negative, fractional or impossible progress ends the copy instead of
 * being asked again forever. Its report is read exactly once.
 */
async function writeAll(file: ManagedOutputTempFile, chunk: Uint8Array): Promise<boolean> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const remaining = chunk.byteLength - offset;
    const result = await file.write(chunk, offset, remaining);
    const written = result.bytesWritten;
    if (
      typeof written !== "number" ||
      !Number.isSafeInteger(written) ||
      written <= 0 ||
      written > remaining
    ) {
      return false;
    }
    offset += written;
  }
  return true;
}

export class S3ManagedOutputMediaValidator implements ManagedOutputMediaValidationPort {
  readonly #bucket: string;
  readonly #maxBytes: number;
  readonly #expectedBucketOwner: string | undefined;
  readonly #reader: S3ManagedObjectReader;
  readonly #probe: ManagedOutputMediaProbe;
  readonly #tempFiles: ManagedOutputTempFileFactory;

  constructor(
    config: S3ManagedOutputMediaValidatorConfig,
    deps: S3ManagedOutputMediaValidatorDeps,
  ) {
    if (typeof config.bucket !== "string" || config.bucket.trim().length === 0) {
      throw new AppError("CONFIGURATION_ERROR", "Media validation requires a non-blank bucket");
    }
    this.#bucket = config.bucket;
    this.#maxBytes = validateManagedOutputByteLimit(
      config.maxBytes ?? MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
    );
    this.#expectedBucketOwner = config.expectedBucketOwner;
    this.#reader = deps.reader;
    this.#probe = deps.probe;
    this.#tempFiles = deps.tempFiles ?? nodeManagedOutputTempFileFactory;
  }

  async validate(
    input: ManagedOutputMediaValidationInput,
  ): Promise<ManagedOutputMediaValidationOutcome> {
    // A malformed expected receipt is a caller/contract defect — not invalid
    // media, and not something to retry against an external service.
    const expected = parseVerificationReceipt(input.expectedReceipt);
    if (expected === null) {
      throw new ManagedOutputMediaValidationDefect("EXPECTED_RECEIPT_MALFORMED");
    }

    // One application-created temporary directory, random-named, holding one
    // fixed-named file. Cleanup is unconditional.
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), MEDIA_VALIDATION_TEMP_PREFIX));
    } catch {
      // Local temp creation failed: a materialization problem, not media.
      return RETRYABLE;
    }
    const localPath = join(directory, MEDIA_VALIDATION_TEMP_FILENAME);

    try {
      const materialized = await this.#materialize(input.destinationKey, localPath);
      if (materialized.kind === "RETRYABLE") return RETRYABLE;

      // Integrity first: mismatching bytes are never handed to the inspector.
      if (
        materialized.sha256 !== expected.sha256 ||
        materialized.sizeBytes !== expected.sizeBytes
      ) {
        return INTEGRITY_MISMATCH;
      }

      const probed = await this.#probe.probe(localPath);
      if (probed.kind === "FACTS") return { kind: "VALID", facts: probed.facts };
      if (probed.kind === "INVALID") return { kind: "INVALID_MEDIA", reason: probed.reason };
      return RETRYABLE;
    } finally {
      // Every exit path — valid, invalid, mismatch, retry, or an unexpected
      // defect thrown by the inspector — removes the file and its directory. A
      // cleanup failure is swallowed: it must never replace the primary result.
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }

  /**
   * Stream the canonical object to the local path, hashing and counting bytes
   * only once they are actually on disk. Never buffers the object: one chunk is
   * held at a time, written completely before the next is pulled.
   */
  async #materialize(
    destinationKey: ManagedGenerationOutputKey,
    localPath: string,
  ): Promise<Materialized> {
    let result: S3GetObjectResult;
    try {
      result = await this.#reader.getObject({
        bucket: this.#bucket,
        key: destinationKey,
        expectedBucketOwner: this.#expectedBucketOwner,
      });
    } catch {
      return { kind: "RETRYABLE" };
    }

    const body = result.body;
    if (body === null) return { kind: "RETRYABLE" };

    // `Content-Length` is a preflight ceiling only; the streamed count decides.
    if (result.contentLength !== null && result.contentLength > this.#maxBytes) {
      await cancelQuietly(body);
      return { kind: "RETRYABLE" };
    }

    // Exclusive create, owner-only mode: the file cannot pre-exist and is not
    // readable by other users on platforms that honour the mode.
    let file: ManagedOutputTempFile;
    try {
      file = await this.#tempFiles.openExclusive0600(localPath);
    } catch {
      // The body was already acquired, so it owns a connection nothing else
      // will close. Release it exactly once before giving up.
      await cancelQuietly(body);
      return { kind: "RETRYABLE" };
    }

    const hash = createHash("sha256");
    let total = 0;
    let streamed = false;
    try {
      for (;;) {
        const chunk = await body.read();
        if (chunk === null) break;
        if (!(chunk instanceof Uint8Array)) {
          await cancelQuietly(body);
          return { kind: "RETRYABLE" };
        }
        const next = total + chunk.byteLength;
        if (next > this.#maxBytes) {
          // An over-limit object never reaches the inspector.
          await cancelQuietly(body);
          return { kind: "RETRYABLE" };
        }
        // The chunk counts for nothing until all of it is on disk: a short or
        // stalled write leaves a truncated file, and a truncated file must
        // never be described by a hash of the bytes it does not contain.
        if (!(await writeAll(file, chunk))) {
          await cancelQuietly(body);
          return { kind: "RETRYABLE" };
        }
        hash.update(chunk);
        total = next;
      }
      streamed = true;
    } catch {
      // A mid-stream read rejection or a local write failure: both are transient
      // materialization problems, and neither is evidence about the media.
      await cancelQuietly(body);
      return { kind: "RETRYABLE" };
    } finally {
      // Only the abandoned paths close here, best effort — the success path
      // needs a close whose failure is *not* swallowed, and does it below.
      if (!streamed) {
        try {
          await file.close();
        } catch {
          // Best effort.
        }
      }
    }

    // Writing every byte is not the same as having every byte. Buffered data
    // still owed to the file is flushed by `close()`, so a close that fails
    // means the local copy may be short of what the hash already counted, and
    // the inspector must not see it.
    try {
      await file.close();
    } catch {
      await cancelQuietly(body);
      return { kind: "RETRYABLE" };
    }

    await cancelQuietly(body);

    // A clean end-of-stream at zero bytes is *not* a failure to determine the
    // bytes — it is a successful determination that the canonical object is
    // empty. A well-formed expected receipt always carries a positive size, so
    // that comparison is what rejects it, as INTEGRITY_MISMATCH: the object at
    // the canonical key is not what was published. Reporting it as retryable
    // would have a worker retry forever against a replacement that will never
    // match, and would confuse "could not read the bytes" with "read the bytes,
    // and they are wrong". No zero-byte receipt type is invented for this.
    return { kind: "OK", sha256: hash.digest("hex"), sizeBytes: total };
  }
}
