export { ManagedOutputTransferDefect } from "./defect";
export type { ManagedOutputTransferDefectCode } from "./defect";
export {
  EXISTING_COMMIT_KEYS,
  ManagedOutputStagingRetryableFailure,
  PUBLISHED_COMMIT_KEYS,
  RETRYABLE_FAILURE_COMMIT_KEYS,
  isWellFormedStagingCommitOutcome,
  parseStagingCommitOutcome,
} from "./staging";
export type {
  ManagedOutputStagingCommitOutcome,
  ManagedOutputStagingSession,
  ManagedOutputStagingSink,
} from "./staging";
export {
  MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
  StreamingManagedOutputTransfer,
  validateManagedOutputByteLimit,
} from "./streaming-transfer";
export type {
  StreamingManagedOutputTransferConfig,
  StreamingManagedOutputTransferDeps,
} from "./streaming-transfer";

/**
 * The dormant durable S3 managed-output staging sink (Phase 2H-3B-3).
 *
 * The first concrete `ManagedOutputStagingSink`: an S3 multipart upload against
 * the canonical key, published only through a conditional
 * `CompleteMultipartUpload`. Exported for tests and review, **not** wired:
 * nothing in production constructs it or an `S3Client`, no bucket credential
 * exists, and the only client it ever sees in tests is a deterministic fake.
 */
export {
  DEFAULT_S3_PART_SIZE_BYTES,
  S3_MIN_PART_SIZE_BYTES,
  S3ManagedOutputStagingDefect,
  S3ManagedOutputStagingSession,
  S3ManagedOutputStagingSink,
  validateS3PartSize,
} from "./s3-staging-sink";
export type {
  S3AbortMultipartUploadInput,
  S3CompletedPartRef,
  S3CompleteMultipartUploadInput,
  S3CreateMultipartUploadInput,
  S3CreateMultipartUploadResult,
  S3GetObjectInput,
  S3GetObjectResult,
  S3ManagedOutputStagingDefectCode,
  S3ManagedOutputStagingSinkConfig,
  S3ManagedOutputStagingSinkDeps,
  S3MultipartClient,
  S3ObjectBody,
  S3UploadPartInput,
  S3UploadPartResult,
} from "./s3-staging-sink";
export { createS3MultipartClient } from "./s3-client-adapter";
