import { createHash } from "node:crypto";
import { AppError } from "@app/shared";
import {
  parseVerificationReceipt,
  safePositiveByteCount,
  sha256Digest,
  type ManagedGenerationOutputKey,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";
import {
  ManagedOutputStagingRetryableFailure,
  type ManagedOutputStagingCommitOutcome,
  type ManagedOutputStagingSession,
  type ManagedOutputStagingSink,
} from "./staging";
import {
  MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
  validateManagedOutputByteLimit,
} from "./streaming-transfer";

/**
 * The first concrete durable {@link ManagedOutputStagingSink}, backed by an S3
 * multipart upload — and, like everything else on this data plane, **dormant**.
 *
 * ## Why S3 multipart *is* the staging mechanism
 *
 * The contract says staging must be invisible until commit, and that the first
 * writer to publish a canonical key wins and is never overwritten. S3 multipart
 * upload gives both properties for free, without inventing a second temporary key
 * and copying:
 *
 * - `CreateMultipartUpload` / `UploadPart` never expose a completed object at the
 *   destination key. The in-flight upload *is* the invisible staging area.
 * - Only `CompleteMultipartUpload` publishes the canonical object, and it accepts
 *   an `If-None-Match: *` precondition, so a completion against a key that already
 *   holds an object fails with `412` instead of overwriting. That is atomic
 *   first-publish-wins at the destination key itself — no read-then-write race, no
 *   temporary-object copy, no overwrite.
 *
 * So the multipart upload targets the **canonical key directly**. There is no
 * canonical-adjacent staging object. Publication happens *only* through the
 * conditional completion; a completion without the precondition would be an
 * ordinary overwrite and is never issued.
 *
 * ## What the integrity proof is, and is not
 *
 * The application receipt — the SHA-256 and byte count over the exact ordered
 * source bytes — is computed by the streaming transfer core, not here. This sink
 * does not recompute or replace it. What the sink adds is that the *same ordered
 * bytes* were partitioned without modification and every part upload carried that
 * part's SHA-256, which S3 verifies. The multipart ETag is **not** an application
 * hash and is never treated as one; it identifies a part for completion and
 * nothing more. When this session loses the completion race, the winner's receipt
 * is produced by streaming the actual canonical bytes back and hashing them — not
 * by trusting an ETag, a `Content-Length`, or object metadata.
 *
 * ## Dormant
 *
 * Nothing in production constructs this sink or an `S3Client`; no bucket
 * credential is wired; the client and bucket arrive only through constructor
 * injection, and every test drives a deterministic fake client with no network.
 * The static suite asserts it.
 */

/** S3's hard floor for every multipart part except the last: 5 MiB. */
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** A safe default part size, comfortably above the 5 MiB floor: 8 MiB. */
export const DEFAULT_S3_PART_SIZE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The narrow S3 seam
// ---------------------------------------------------------------------------

/**
 * The multipart operations this sink needs, and nothing else.
 *
 * A narrow seam, not a cloud abstraction framework: exactly the five calls the
 * sink makes, each with a small typed shape. It is injected so tests drive the
 * whole multipart lifecycle deterministically without an AWS request, and so the
 * sink file itself carries no `@aws-sdk/client-s3` import. The production mapping
 * from a real `S3Client` to this seam lives in `s3-client-adapter.ts` and is
 * constructed nowhere in production this phase.
 *
 * Every call **rejects** on failure with the SDK's own error value; the sink
 * catches those rejections at its boundary, discards them unread, and classifies
 * the outcome — a completion `412`/`409` is read from guarded HTTP status
 * metadata, everything else is a transient storage failure.
 */
export interface S3MultipartClient {
  createMultipartUpload(input: S3CreateMultipartUploadInput): Promise<S3CreateMultipartUploadResult>;
  uploadPart(input: S3UploadPartInput): Promise<S3UploadPartResult>;
  completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void>;
  abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void>;
  getObject(input: S3GetObjectInput): Promise<S3GetObjectResult>;
}

export interface S3CreateMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly expectedBucketOwner: string | undefined;
}
export interface S3CreateMultipartUploadResult {
  readonly uploadId: string;
}
export interface S3UploadPartInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly partNumber: number;
  readonly body: Uint8Array;
  /** The application-computed SHA-256 of this exact part, Base64-encoded. */
  readonly checksumSha256Base64: string;
  readonly expectedBucketOwner: string | undefined;
}
export interface S3UploadPartResult {
  /** The part's ETag, used only to identify the part on completion. */
  readonly etag: string;
}
export interface S3CompletedPartRef {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksumSha256Base64: string;
}
export interface S3CompleteMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly parts: readonly S3CompletedPartRef[];
  /**
   * The `If-None-Match` precondition. The sink always sends `"*"` — publish only
   * if no canonical object exists at the key — which is the first-publish-wins
   * authority. A value other than `"*"` degrades completion to an unconditional
   * overwrite and must never be sent.
   */
  readonly ifNoneMatch: string;
  readonly expectedBucketOwner: string | undefined;
}
export interface S3AbortMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly expectedBucketOwner: string | undefined;
}
export interface S3GetObjectInput {
  readonly bucket: string;
  readonly key: string;
  readonly expectedBucketOwner: string | undefined;
}
export interface S3GetObjectResult {
  /** The `Content-Length`, a preflight bound only; the streamed count decides. */
  readonly contentLength: number | null;
  readonly body: S3ObjectBody | null;
}
/** A pull-based canonical-object body: one chunk per `read`, `null` at EOF. */
export interface S3ObjectBody {
  read(): Promise<Uint8Array | null>;
  cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface S3ManagedOutputStagingSinkConfig {
  /** The managed-output bucket. Non-blank; the sink never derives it elsewhere. */
  readonly bucket: string;
  /** Multipart part size; default {@link DEFAULT_S3_PART_SIZE_BYTES}. */
  readonly partSizeBytes?: number;
  /**
   * The ceiling enforced while streaming an existing winner back for
   * verification; default and maximum {@link MAX_MANAGED_PROVIDER_OUTPUT_BYTES}.
   */
  readonly verificationMaxBytes?: number;
  /** Optional `x-amz-expected-bucket-owner` guard, passed through unchanged. */
  readonly expectedBucketOwner?: string;
}

export interface S3ManagedOutputStagingSinkDeps {
  readonly client: S3MultipartClient;
}

/** Validate a configured part size, or refuse it. Never clamps. */
export function validateS3PartSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < S3_MIN_PART_SIZE_BYTES ||
    value > MAX_MANAGED_PROVIDER_OUTPUT_BYTES
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "S3 multipart part size must be a safe integer between 5 MiB and the managed-output ceiling",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixed adapter-contract defect (carries no receipt content)
// ---------------------------------------------------------------------------

export type S3ManagedOutputStagingDefectCode = "STAGED_BYTES_RECEIPT_MISMATCH";

const STAGING_DEFECT_MESSAGES: Record<S3ManagedOutputStagingDefectCode, string> = {
  STAGED_BYTES_RECEIPT_MISMATCH:
    "The staged byte count does not match the supplied managed-output receipt",
};

/**
 * The fixed, application-owned defect the sink raises when the bytes it staged
 * do not match the receipt the core computed over the same bytes. Like the
 * transfer core's defect it carries no `cause` and no offending value — a
 * mismatching receipt is a contract bug, not a place to serialize a receipt or a
 * storage response.
 */
export class S3ManagedOutputStagingDefect extends Error {
  readonly code: S3ManagedOutputStagingDefectCode;

  constructor(code: S3ManagedOutputStagingDefectCode) {
    super(STAGING_DEFECT_MESSAGES[code]);
    this.name = "S3ManagedOutputStagingDefect";
    this.code = code;
  }
}

/**
 * The one internal marker that says "a client seam call was interrupted". It
 * never leaves this module: `write` turns it into the public
 * {@link ManagedOutputStagingRetryableFailure} signal, and `commit` turns it into
 * a `RETRYABLE_FAILURE` outcome. It carries nothing — the caught SDK rejection is
 * discarded unread at the seam boundary that throws this.
 */
class S3StorageInterruption {
  readonly #brand: true;
  constructor() {
    this.#brand = true;
  }
  static is(value: unknown): value is S3StorageInterruption {
    return typeof value === "object" && value !== null && #brand in value;
  }
}

/** Read an HTTP status from a caught SDK error, fully guarded. */
function httpStatusOf(error: unknown): number | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const metadata: unknown = (error as { $metadata?: unknown }).$metadata;
    if (typeof metadata !== "object" || metadata === null) return null;
    const status: unknown = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
    return typeof status === "number" ? status : null;
  } catch {
    return null;
  }
}

/** Base64 SHA-256 of one part's bytes — the checksum S3 validates. */
function partChecksumBase64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

/** Best-effort release of a read-back body. */
async function cancelQuietly(body: S3ObjectBody): Promise<void> {
  try {
    await body.cancel();
  } catch {
    // Best effort. Nothing in scope to leak.
  }
}

const RETRYABLE: ManagedOutputStagingCommitOutcome = { kind: "RETRYABLE_FAILURE" };

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export class S3ManagedOutputStagingSink implements ManagedOutputStagingSink {
  readonly #bucket: string;
  readonly #partSizeBytes: number;
  readonly #verificationMaxBytes: number;
  readonly #expectedBucketOwner: string | undefined;
  readonly #client: S3MultipartClient;

  constructor(config: S3ManagedOutputStagingSinkConfig, deps: S3ManagedOutputStagingSinkDeps) {
    if (typeof config.bucket !== "string" || config.bucket.trim().length === 0) {
      throw new AppError("CONFIGURATION_ERROR", "S3 managed-output sink requires a non-blank bucket");
    }
    this.#bucket = config.bucket;
    this.#partSizeBytes = validateS3PartSize(config.partSizeBytes ?? DEFAULT_S3_PART_SIZE_BYTES);
    // Same ceiling authority as the transfer core; may be lower, never higher.
    this.#verificationMaxBytes = validateManagedOutputByteLimit(
      config.verificationMaxBytes ?? MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
    );
    this.#expectedBucketOwner = config.expectedBucketOwner;
    this.#client = deps.client;
  }

  async begin(input: {
    readonly destinationKey: ManagedGenerationOutputKey;
  }): Promise<ManagedOutputStagingSession> {
    // The multipart upload is created lazily, on the first part actually
    // uploaded — so a transient `CreateMultipartUpload` failure surfaces on the
    // write/commit path where it is classified as retryable, never as a `begin`
    // throw the core would record as a source failure.
    return new S3ManagedOutputStagingSession(
      {
        bucket: this.#bucket,
        key: input.destinationKey,
        partSizeBytes: this.#partSizeBytes,
        verificationMaxBytes: this.#verificationMaxBytes,
        expectedBucketOwner: this.#expectedBucketOwner,
      },
      this.#client,
    );
  }
}

interface S3StagingSessionConfig {
  readonly bucket: string;
  readonly key: string;
  readonly partSizeBytes: number;
  readonly verificationMaxBytes: number;
  readonly expectedBucketOwner: string | undefined;
}

export class S3ManagedOutputStagingSession implements ManagedOutputStagingSession {
  readonly #config: S3StagingSessionConfig;
  readonly #client: S3MultipartClient;

  #uploadId: string | null = null;
  /**
   * The one sink-owned assembly buffer, allocated lazily to exactly
   * `partSizeBytes`. It holds only a *partial* part being assembled across chunk
   * boundaries; full aligned regions of an incoming chunk are uploaded directly
   * from bounded `subarray` views without ever entering it. So the sink's pending
   * assembly state is bounded by `partSizeBytes`, independent of how large a
   * single incoming chunk is.
   */
  #partBuffer: Uint8Array | null = null;
  /** Bytes currently assembled in `#partBuffer` — always `< partSizeBytes`. */
  #partFill = 0;
  #stagedBytes = 0;
  #nextPartNumber = 1;
  readonly #parts: S3CompletedPartRef[] = [];
  #published = false;
  #aborted = false;

  constructor(config: S3StagingSessionConfig, client: S3MultipartClient) {
    this.#config = config;
    this.#client = client;
  }

  /**
   * Partition an arbitrary incoming chunk into `partSizeBytes` parts, uploading
   * each full part sequentially and retaining only a sub-part remainder.
   *
   * S3 part boundaries are the sink's, not the source's: a single incoming chunk
   * may be smaller than a part, span several parts, or straddle a boundary, and
   * none of that changes the parts produced. The whole chunk is counted, then
   * consumed from an offset — first topping up any partial part in the bounded
   * buffer, then uploading each full `partSizeBytes` region directly as a view
   * (no copy), then copying only the final sub-part remainder into the buffer.
   * Every full-part upload is awaited before `write` proceeds, so backpressure
   * holds and no unbounded concurrent uploads exist. The caller-owned chunk is
   * not retained after `write` returns — only the bounded remainder is copied.
   */
  async write(chunk: Uint8Array): Promise<void> {
    this.#stagedBytes += chunk.byteLength;
    const partSize = this.#config.partSizeBytes;
    let offset = 0;

    try {
      // 1. Top up a partial pending part from the front of this chunk.
      if (this.#partFill > 0) {
        const buffer = this.#ensurePartBuffer();
        const take = Math.min(partSize - this.#partFill, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + take), this.#partFill);
        this.#partFill += take;
        offset += take;
        if (this.#partFill === partSize) {
          await this.#uploadPart(buffer.subarray(0, partSize));
          this.#partFill = 0;
        }
      }

      // 2. Upload each full aligned part straight from the chunk as a bounded
      //    view — no copy, no sink allocation for the source's bytes.
      while (this.#partFill === 0 && chunk.byteLength - offset >= partSize) {
        await this.#uploadPart(chunk.subarray(offset, offset + partSize));
        offset += partSize;
      }

      // 3. Retain only the sub-part remainder in the bounded buffer.
      if (offset < chunk.byteLength) {
        const buffer = this.#ensurePartBuffer();
        buffer.set(chunk.subarray(offset, chunk.byteLength), this.#partFill);
        this.#partFill += chunk.byteLength - offset;
      }
      return;
    } catch (error) {
      if (S3StorageInterruption.is(error)) {
        // Discard the caught SDK value entirely; it never reaches the signal.
        throw new ManagedOutputStagingRetryableFailure();
      }
      throw error;
    }
  }

  async commit(input: {
    readonly receipt: ManagedOutputVerificationReceipt;
  }): Promise<ManagedOutputStagingCommitOutcome> {
    // The receipt is validated through the domain's single authority, and its
    // byte count must match what we actually staged. A mismatch is a contract
    // defect, not a retry: publish nothing, abort, raise the fixed defect. No
    // receipt content enters the error.
    const receipt = parseVerificationReceipt(input.receipt);
    if (receipt === null || receipt.sizeBytes !== this.#stagedBytes) {
      await this.#abortQuietly();
      throw new S3ManagedOutputStagingDefect("STAGED_BYTES_RECEIPT_MISMATCH");
    }

    // Flush the final, possibly short, part — but never an empty one. The
    // remainder lives in the bounded buffer; a sub-part view of it is the last
    // part.
    if (this.#partFill > 0) {
      const finalPart = this.#ensurePartBuffer().subarray(0, this.#partFill);
      try {
        await this.#uploadPart(finalPart);
      } catch (error) {
        if (S3StorageInterruption.is(error)) {
          await this.#abortQuietly();
          return RETRYABLE;
        }
        throw error;
      }
      this.#partFill = 0;
    }

    // Publish only through the conditional completion. `If-None-Match: *` is the
    // first-publish-wins authority: it succeeds only when no canonical object
    // exists at the key, so it is never an overwrite.
    try {
      await this.#client.completeMultipartUpload({
        bucket: this.#config.bucket,
        key: this.#config.key,
        uploadId: this.#requireUploadId(),
        parts: this.#parts,
        ifNoneMatch: "*",
        expectedBucketOwner: this.#config.expectedBucketOwner,
      });
    } catch (error) {
      const status = httpStatusOf(error);
      // A losing completion never overwrites and never retries the completion
      // without the precondition. Abort this upload, then decide from the status.
      await this.#abortQuietly();
      if (status === 412) {
        // Another writer already owns the key: read and verify the winner.
        return await this.#readExistingWinner();
      }
      // 409 ConditionalRequestConflict and every other operational failure: a
      // later run reacquires the output and starts a fresh multipart upload.
      return RETRYABLE;
    }

    this.#published = true;
    return { kind: "PUBLISHED" };
  }

  async abort(): Promise<void> {
    // Idempotent, and a no-op after a successful publish. At most one
    // `AbortMultipartUpload`, and only if a multipart upload was ever created.
    if (this.#aborted || this.#published) return;
    this.#aborted = true;
    const uploadId = this.#uploadId;
    if (uploadId === null) return;
    try {
      await this.#client.abortMultipartUpload({
        bucket: this.#config.bucket,
        key: this.#config.key,
        uploadId,
        expectedBucketOwner: this.#config.expectedBucketOwner,
      });
    } catch {
      // Swallow: an abort failure must not replace the primary outcome, and an
      // incomplete-multipart lifecycle rule on the bucket is the defense-in-depth
      // backstop (documented in the ADR; no infrastructure is added here).
    }
  }

  /** Create the multipart upload if it does not exist yet, then upload one part. */
  async #uploadPart(part: Uint8Array): Promise<void> {
    const checksum = partChecksumBase64(part);
    const partNumber = this.#nextPartNumber;
    let result: S3UploadPartResult;
    try {
      const uploadId = await this.#ensureUploadId();
      result = await this.#client.uploadPart({
        bucket: this.#config.bucket,
        key: this.#config.key,
        uploadId,
        partNumber,
        body: part,
        checksumSha256Base64: checksum,
        expectedBucketOwner: this.#config.expectedBucketOwner,
      });
    } catch (error) {
      // Any rejection from the create or the part upload is a transient storage
      // interruption. Discard the SDK value unread and raise the internal marker;
      // the caller decides between the write signal and the commit outcome.
      void error;
      throw new S3StorageInterruption();
    }
    this.#parts.push({
      partNumber,
      etag: result.etag,
      checksumSha256Base64: checksum,
    });
    this.#nextPartNumber += 1;
  }

  /** Allocate the bounded assembly buffer on first need, at exactly the part size. */
  #ensurePartBuffer(): Uint8Array {
    if (this.#partBuffer === null) {
      this.#partBuffer = new Uint8Array(this.#config.partSizeBytes);
    }
    return this.#partBuffer;
  }

  async #ensureUploadId(): Promise<string> {
    if (this.#uploadId !== null) return this.#uploadId;
    const created = await this.#client.createMultipartUpload({
      bucket: this.#config.bucket,
      key: this.#config.key,
      expectedBucketOwner: this.#config.expectedBucketOwner,
    });
    this.#uploadId = created.uploadId;
    return created.uploadId;
  }

  #requireUploadId(): string {
    if (this.#uploadId === null) {
      // Unreachable: commit is only called with staged bytes, which means at
      // least one part was flushed and the upload was created.
      throw new S3ManagedOutputStagingDefect("STAGED_BYTES_RECEIPT_MISMATCH");
    }
    return this.#uploadId;
  }

  /**
   * Stream the existing canonical winner back and produce its receipt, or a
   * retry. This streamed read-back — not an ETag, a `Content-Length`, or object
   * metadata — is the managed-storage verification authority for an existing
   * winner.
   */
  async #readExistingWinner(): Promise<ManagedOutputStagingCommitOutcome> {
    let result: S3GetObjectResult;
    try {
      result = await this.#client.getObject({
        bucket: this.#config.bucket,
        key: this.#config.key,
        expectedBucketOwner: this.#config.expectedBucketOwner,
      });
    } catch {
      return RETRYABLE;
    }

    const body = result.body;
    if (body === null) return RETRYABLE;

    // `Content-Length` is only a preflight bound; the streamed count is the
    // authority. A declared size over the ceiling refuses before reading.
    if (result.contentLength !== null && result.contentLength > this.#config.verificationMaxBytes) {
      await cancelQuietly(body);
      return RETRYABLE;
    }

    const hash = createHash("sha256");
    let total = 0;
    try {
      for (;;) {
        const chunk = await body.read();
        if (chunk === null) break;
        if (!(chunk instanceof Uint8Array)) {
          await cancelQuietly(body);
          return RETRYABLE;
        }
        total += chunk.byteLength;
        if (total > this.#config.verificationMaxBytes) {
          await cancelQuietly(body);
          return RETRYABLE;
        }
        hash.update(chunk);
      }
    } catch {
      // The body stream rejected mid-read: the winner cannot be verified now.
      await cancelQuietly(body);
      return RETRYABLE;
    }

    await cancelQuietly(body);
    if (total === 0) return RETRYABLE;

    return {
      kind: "EXISTING",
      receipt: {
        sha256: sha256Digest(hash.digest("hex")),
        sizeBytes: safePositiveByteCount(total),
      },
    };
  }

  async #abortQuietly(): Promise<void> {
    await this.abort();
  }
}
