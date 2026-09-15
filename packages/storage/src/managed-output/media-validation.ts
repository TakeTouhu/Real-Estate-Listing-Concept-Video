import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
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

export class S3ManagedOutputMediaValidator implements ManagedOutputMediaValidationPort {
  readonly #bucket: string;
  readonly #maxBytes: number;
  readonly #expectedBucketOwner: string | undefined;
  readonly #reader: S3ManagedObjectReader;
  readonly #probe: ManagedOutputMediaProbe;

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
   * Stream the canonical object to the local path, hashing and counting on the
   * way past. Never buffers the object: one chunk is held at a time, written
   * before the next is pulled.
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
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(localPath, "wx", 0o600);
    } catch {
      return { kind: "RETRYABLE" };
    }

    const hash = createHash("sha256");
    let total = 0;
    try {
      for (;;) {
        const chunk = await body.read();
        if (chunk === null) break;
        if (!(chunk instanceof Uint8Array)) {
          await cancelQuietly(body);
          return { kind: "RETRYABLE" };
        }
        total += chunk.byteLength;
        if (total > this.#maxBytes) {
          // An over-limit object never reaches the inspector.
          await cancelQuietly(body);
          return { kind: "RETRYABLE" };
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } catch {
      // A mid-stream read rejection or a local write failure: both are transient
      // materialization problems, and neither is evidence about the media.
      await cancelQuietly(body);
      return { kind: "RETRYABLE" };
    } finally {
      try {
        await handle.close();
      } catch {
        // Best effort.
      }
    }

    await cancelQuietly(body);
    // A zero-byte canonical object cannot match any positive receipt and is
    // certainly not media.
    if (total === 0) return { kind: "RETRYABLE" };

    return { kind: "OK", sha256: hash.digest("hex"), sizeBytes: total };
  }
}
