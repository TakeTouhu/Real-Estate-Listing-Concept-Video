import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  UploadPartCommand,
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
      const output = await client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ExpectedBucketOwner: input.expectedBucketOwner,
        }),
      );
      const rawBody = output.Body;
      const contentLength =
        typeof output.ContentLength === "number" ? output.ContentLength : null;
      if (rawBody === undefined) {
        return { contentLength, body: null };
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
