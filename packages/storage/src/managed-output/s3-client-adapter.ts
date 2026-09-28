import { AppError } from "@app/shared";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  UploadPartCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
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
} from "./s3-staging-sink";

/**
 * Map a real AWS `S3Client` onto the narrow {@link S3MultipartClient} seam the
 * durable sink consumes — the one place `@aws-sdk/client-s3` is used.
 *
 * **Constructed nowhere in production this phase.** It exists so a future wiring
 * has a real implementation to inject and so the SDK contract is exercised by
 * type-checking and review, not so the sink can be activated: there is no
 * production `new S3Client`, no bucket credential, and no caller. Every test
 * drives the fake client instead.
 *
 * The mapping is deliberately thin. It attaches the SHA-256 checksum the sink
 * computed to each part, requests SHA-256 checksums on the multipart upload, and
 * carries `If-None-Match: *` onto completion unchanged. It never reads a body
 * into memory: `getObject` exposes the response as a pull-based stream via the
 * SDK's `transformToWebStream`, never `transformToByteArray`/`String`/
 * `arrayBuffer`.
 */
/**
 * AWS's error name for "no object exists at this key", for `GetObject`.
 *
 * Matched by name and by nothing else. A status code will not do: `NoSuchKey`
 * and `NoSuchBucket` are both 404, and reading "404" as "the key is empty" would
 * let a misconfigured or deleted bucket look like a deliverable nobody has
 * composed yet — which would send a worker to compose into a bucket that is not
 * there. `NotFound`, which `HeadObject` raises for the same condition, is
 * deliberately absent: this adapter only ever issues `GetObject`, and accepting a
 * name it cannot produce would be a guess dressed as a contract.
 */
const S3_MISSING_KEY_ERROR_NAME = "NoSuchKey";

/**
 * Does this rejection prove the key is empty?
 *
 * Reads exactly one property, inside a guard, and compares it to one string. A
 * hostile or unusual error object — a throwing getter, a frozen proxy, a thrown
 * string — answers "no", which is the safe direction: the caller then treats the
 * read as a failure rather than as proof of absence.
 */
function isMissingKeyError(error: unknown): boolean {
  let name: unknown;
  try {
    name = (error as { name?: unknown }).name;
  } catch {
    return false;
  }
  return name === S3_MISSING_KEY_ERROR_NAME;
}

export function createS3MultipartClient(client: S3Client): S3MultipartClient {
  return {
    async createMultipartUpload(
      input: S3CreateMultipartUploadInput,
    ): Promise<S3CreateMultipartUploadResult> {
      const output = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          ChecksumAlgorithm: "SHA256",
          ExpectedBucketOwner: input.expectedBucketOwner,
        }),
      );
      if (output.UploadId === undefined) {
        throw new Error("S3 CreateMultipartUpload returned no UploadId");
      }
      return { uploadId: output.UploadId };
    },

    async uploadPart(input: S3UploadPartInput): Promise<S3UploadPartResult> {
      const output = await client.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          Body: input.body,
          ChecksumSHA256: input.checksumSha256Base64,
          ExpectedBucketOwner: input.expectedBucketOwner,
        }),
      );
      if (output.ETag === undefined) {
        throw new Error("S3 UploadPart returned no ETag");
      }
      return { etag: output.ETag };
    },

    async completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void> {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          IfNoneMatch: input.ifNoneMatch,
          ExpectedBucketOwner: input.expectedBucketOwner,
          MultipartUpload: {
            Parts: input.parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
              ChecksumSHA256: part.checksumSha256Base64,
            })),
          },
        }),
      );
    },

    async abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void> {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          ExpectedBucketOwner: input.expectedBucketOwner,
        }),
      );
    },

    async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
      let output: GetObjectCommandOutput;
      try {
        output = await client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            ExpectedBucketOwner: input.expectedBucketOwner,
          }),
        );
      } catch (error) {
        // The one error AWS raises that *proves* the key holds nothing. It is
        // normalized into the seam's absence shape here, at the only place that
        // can tell the difference, so no caller has to inspect an SDK error.
        if (isMissingKeyError(error)) return { contentLength: null, body: null };
        // Everything else is rethrown unread: AccessDenied (which AWS also
        // returns for a missing key when the principal lacks `s3:ListBucket`,
        // and which therefore proves nothing), NoSuchBucket, throttling,
        // timeouts, 5xx, and anything unrecognized.
        throw error;
      }

      const rawBody = output.Body;
      const contentLength =
        typeof output.ContentLength === "number" ? output.ContentLength : null;
      if (rawBody === undefined) {
        // A *successful* response with no body. Deliberately not absence: the
        // request did not fail, so nothing here establishes that the key is
        // empty, and returning `null` would assert exactly that. An
        // application-owned error with no SDK text, bucket or key in it.
        throw new AppError(
          "INTERNAL_ERROR",
          "The object store returned a successful read with no body",
        );
      }
      // Stream the object incrementally — never buffer the whole thing.
      const webStream = (
        rawBody as { transformToWebStream: () => ReadableStream<Uint8Array> }
      ).transformToWebStream();
      const reader = webStream.getReader();
      const body: S3ObjectBody = {
        async read(): Promise<Uint8Array | null> {
          const { value, done } = await reader.read();
          if (done || value === undefined) return null;
          return value instanceof Uint8Array ? value : new Uint8Array(value);
        },
        async cancel(): Promise<void> {
          try {
            await reader.cancel();
          } catch {
            // Best-effort release.
          }
        },
      };
      return { contentLength, body };
    },
  };
}
