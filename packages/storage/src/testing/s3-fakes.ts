import { createHash } from "node:crypto";
import type {
  S3AbortMultipartUploadInput,
  S3CompleteMultipartUploadInput,
  S3CreateMultipartUploadInput,
  S3CreateMultipartUploadResult,
  S3GetObjectInput,
  S3GetObjectResult,
  S3MultipartClient,
  S3ObjectBody,
  S3UploadPartInput,
  S3UploadPartResult,
} from "../managed-output/s3-staging-sink";

/**
 * A deterministic in-memory S3 multipart client for tests. No network, no AWS.
 *
 * It models the one property that makes the sink correct: conditional
 * completion. Sessions sharing a {@link FakeS3World} race for the same canonical
 * key, and only the first `CompleteMultipartUpload` with `If-None-Match: *`
 * publishes; a later one against an occupied key rejects with a `412`, exactly as
 * S3 would. The winner's assembled bytes are what a losing session's read-back
 * streams back.
 *
 * Everything else is scriptable so the failure classifications can be proved:
 * a create/upload/complete/get can be made to reject with a status-bearing value
 * the sink must read through guarded metadata and never serialize.
 */
export interface FakeS3World {
  /** Published canonical objects, by key. Shared across racing sessions. */
  readonly canonical: Map<string, Uint8Array>;
}

export function createFakeS3World(): FakeS3World {
  return { canonical: new Map<string, Uint8Array>() };
}

/** An error shaped like an AWS SDK service error, carrying an HTTP status. */
export function fakeS3Error(status: number, name: string, secret?: string): unknown {
  return {
    name,
    message: secret ?? name,
    $metadata: { httpStatusCode: status, requestId: secret ?? "req-secret" },
  };
}

export interface FakeS3ReadBackOptions {
  /** Chunk size for streaming the existing object back. Default 4 bytes. */
  readonly chunkSize?: number;
  /** Reject the read after this many chunks (models a mid-read failure). */
  readonly rejectReadAfter?: number;
  /** Reject the whole GetObject call. */
  readonly getRejects?: boolean;
  /** Return a result with a null body. */
  readonly noBody?: boolean;
  /** Override the reported Content-Length (a preflight bound only). */
  readonly contentLengthOverride?: number | null;
}

export interface FakeS3ClientOptions {
  readonly world?: FakeS3World;
  /** Reject CreateMultipartUpload with this value. */
  readonly failCreateWith?: unknown;
  /** 1-based UploadPart call index to reject (global across the client). */
  readonly failUploadPartOnCall?: number;
  /** The value UploadPart rejects with. Default a 500. */
  readonly failUploadPartWith?: unknown;
  /** Force completion to reject regardless of the world. */
  readonly completeOverride?: "412" | "409" | { readonly throw: unknown };
  /** Reject AbortMultipartUpload (must never change the primary outcome). */
  readonly abortRejects?: boolean;
  /** How an existing-winner GetObject behaves. */
  readonly readBack?: FakeS3ReadBackOptions;
}

export interface FakeUploadedPart {
  readonly uploadId: string;
  readonly key: string;
  readonly partNumber: number;
  readonly bytes: Uint8Array;
  readonly checksumSha256Base64: string;
}

export interface FakeCompleteCall {
  readonly uploadId: string;
  readonly key: string;
  readonly ifNoneMatch: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly checksumSha256Base64: string;
  }[];
}

export class FakeS3MultipartClient implements S3MultipartClient {
  readonly world: FakeS3World;
  readonly createCalls: { bucket: string; key: string }[] = [];
  readonly uploadedParts: FakeUploadedPart[] = [];
  readonly completeCalls: FakeCompleteCall[] = [];
  readonly abortCalls: { uploadId: string; key: string }[] = [];
  readonly getObjectCalls: { bucket: string; key: string }[] = [];
  /** Every field seen on any request, for secret-leak assertions. */
  readonly requestBuckets: string[] = [];
  readonly requestKeys: string[] = [];

  #uploadCounter = 0;
  #uploadPartCallCount = 0;
  readonly #options: FakeS3ClientOptions;

  constructor(options: FakeS3ClientOptions = {}) {
    this.#options = options;
    this.world = options.world ?? createFakeS3World();
  }

  async createMultipartUpload(
    input: S3CreateMultipartUploadInput,
  ): Promise<S3CreateMultipartUploadResult> {
    this.createCalls.push({ bucket: input.bucket, key: input.key });
    this.requestBuckets.push(input.bucket);
    this.requestKeys.push(input.key);
    if (this.#options.failCreateWith !== undefined) throw this.#options.failCreateWith;
    this.#uploadCounter += 1;
    return { uploadId: `upload-${this.#uploadCounter}` };
  }

  async uploadPart(input: S3UploadPartInput): Promise<S3UploadPartResult> {
    this.#uploadPartCallCount += 1;
    this.requestBuckets.push(input.bucket);
    this.requestKeys.push(input.key);
    if (this.#options.failUploadPartOnCall === this.#uploadPartCallCount) {
      throw this.#options.failUploadPartWith ?? fakeS3Error(500, "InternalError");
    }
    // Mimic S3 validating the part's SHA-256: a wrong or missing checksum is a
    // BadDigest, so the sink's per-part checksum really has to be correct.
    const expected = createHash("sha256").update(input.body).digest("base64");
    if (input.checksumSha256Base64 !== expected) {
      throw fakeS3Error(400, "BadDigest");
    }
    this.uploadedParts.push({
      uploadId: input.uploadId,
      key: input.key,
      partNumber: input.partNumber,
      bytes: Uint8Array.from(input.body),
      checksumSha256Base64: input.checksumSha256Base64,
    });
    return { etag: `etag-${input.uploadId}-${input.partNumber}` };
  }

  async completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void> {
    this.completeCalls.push({
      uploadId: input.uploadId,
      key: input.key,
      ifNoneMatch: input.ifNoneMatch,
      parts: input.parts.map((p) => ({ ...p })),
    });
    this.requestBuckets.push(input.bucket);
    this.requestKeys.push(input.key);

    const override = this.#options.completeOverride;
    if (override === "412") throw fakeS3Error(412, "PreconditionFailed");
    if (override === "409") throw fakeS3Error(409, "ConditionalRequestConflict");
    if (override !== undefined) throw override.throw;

    // The precondition is the first-publish-wins authority: only `If-None-Match:
    // "*"` makes completion conditional. Any other value is an unconditional
    // overwrite, exactly as S3 would treat a missing precondition.
    const conditional = input.ifNoneMatch === "*";
    if (conditional && this.world.canonical.has(input.key)) {
      throw fakeS3Error(412, "PreconditionFailed");
    }
    // Assemble the object from this upload's parts, in the completion order.
    const mine = this.uploadedParts.filter((p) => p.uploadId === input.uploadId);
    const byNumber = new Map(mine.map((p) => [p.partNumber, p.bytes]));
    const ordered: Uint8Array[] = [];
    for (const ref of input.parts) {
      const bytes = byNumber.get(ref.partNumber);
      if (bytes !== undefined) ordered.push(bytes);
    }
    let total = 0;
    for (const b of ordered) total += b.byteLength;
    const object = new Uint8Array(total);
    let offset = 0;
    for (const b of ordered) {
      object.set(b, offset);
      offset += b.byteLength;
    }
    this.world.canonical.set(input.key, object);
  }

  async abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void> {
    this.abortCalls.push({ uploadId: input.uploadId, key: input.key });
    if (this.#options.abortRejects === true) throw fakeS3Error(500, "AbortFailed");
  }

  async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
    this.getObjectCalls.push({ bucket: input.bucket, key: input.key });
    this.requestBuckets.push(input.bucket);
    this.requestKeys.push(input.key);
    const rb = this.#options.readBack ?? {};
    if (rb.getRejects === true) throw fakeS3Error(500, "GetFailed");
    if (rb.noBody === true) {
      return { contentLength: rb.contentLengthOverride ?? null, body: null };
    }
    const bytes = this.world.canonical.get(input.key);
    if (bytes === undefined) {
      // Nothing published — surface as no body, which the sink treats as retry.
      return { contentLength: rb.contentLengthOverride ?? null, body: null };
    }
    const chunkSize = rb.chunkSize ?? 4;
    const contentLength =
      rb.contentLengthOverride !== undefined ? rb.contentLengthOverride : bytes.byteLength;
    let position = 0;
    let reads = 0;
    const body: S3ObjectBody = {
      async read(): Promise<Uint8Array | null> {
        if (rb.rejectReadAfter !== undefined && reads >= rb.rejectReadAfter) {
          throw fakeS3Error(500, "BodyStreamReset");
        }
        reads += 1;
        if (position >= bytes.byteLength) return null;
        const end = Math.min(position + chunkSize, bytes.byteLength);
        const slice = bytes.subarray(position, end);
        position = end;
        return Uint8Array.from(slice);
      },
      async cancel(): Promise<void> {},
    };
    return { contentLength, body };
  }
}
