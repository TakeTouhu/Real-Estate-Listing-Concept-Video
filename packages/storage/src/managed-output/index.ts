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

/**
 * The dormant managed-output media validator and its `ffprobe` inspector
 * (Phase 2H-3B-4). Exported for tests and review only: nothing in production
 * constructs either, no production media-validation read happens, and CI needs
 * no `ffprobe` binary (ADR-0044).
 */
export {
  MEDIA_VALIDATION_TEMP_FILENAME,
  MEDIA_VALIDATION_TEMP_PREFIX,
  ManagedOutputMediaValidationDefect,
  S3ManagedOutputMediaValidator,
} from "./media-validation";
export type {
  ManagedOutputMediaProbe,
  ManagedOutputMediaProbeOutcome,
  ManagedOutputMediaValidationDefectCode,
  S3ManagedObjectReader,
  S3ManagedOutputMediaValidatorConfig,
  S3ManagedOutputMediaValidatorDeps,
} from "./media-validation";
export {
  DEFAULT_PROBE_MAX_STDOUT_BYTES,
  DEFAULT_PROBE_PROGRAM,
  DEFAULT_PROBE_TIMEOUT_MS,
  FfprobeMediaProbe,
  MAX_PROBE_STDOUT_BYTES,
  MAX_PROBE_TIMEOUT_MS,
  createDefaultProcessRunner,
  ffprobeArgsFor,
  interpretFfprobeDocument,
  isIsoBmffFormatName,
  validateProbeMaxStdoutBytes,
  validateProbeTimeoutMs,
} from "./ffprobe";
export type {
  FfprobeMediaProbeConfig,
  FfprobeMediaProbeDeps,
  ProcessRunInput,
  ProcessRunOutcome,
  ProcessRunner,
} from "./ffprobe";

export {
  COMPOSE_MAX_STDOUT_BYTES,
  DEFAULT_COMPOSE_PROGRAM,
  DEFAULT_COMPOSE_TIMEOUT_MS,
  MAX_COMPOSE_TIMEOUT_MS,
  createFfmpegDeliverableComposer,
  ffmpegComposeArgsFor,
  validateComposeTimeoutMs,
} from "./ffmpeg-composer";
export type { FfmpegComposerConfig, FfmpegComposerDeps } from "./ffmpeg-composer";
export {
  COMPOSED_FILE_NAME,
  composedOutputPathFor,
  createDeliverableCompositionSourceMaterializer,
  createDeliverableOutputPublisher,
  sourceFileName,
} from "./deliverable-composition-io";
export type {
  DeliverableCompositionIoConfig,
  DeliverableCompositionIoDeps,
  DeliverableObjectClient,
} from "./deliverable-composition-io";
