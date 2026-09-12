export * from "./types";
export * from "./errors";
export * from "./provider";
export * from "./factory";
export * from "./catalog";
export { deepFreeze } from "./deep-freeze";

export { FakeVideoProvider } from "./fake/fake-provider";
export type {
  FakeSubmissionOutcomeKind,
  FakeVideoProviderOptions,
} from "./fake/fake-provider";

export { WaveSpeedVideoProvider } from "./wavespeed/wavespeed-provider";
export type { WaveSpeedProviderDeps } from "./wavespeed/wavespeed-provider";
export type { WaveSpeedConfig, WaveSpeedPollConfig } from "./wavespeed/config";
export { FetchHttpClient } from "./http";
export type { HttpClient, HttpRedirectMode, HttpRequest, HttpResponse } from "./http";
export * from "./wavespeed/mapping";
export {
  accepted,
  classifyWaveSpeedSubmissionStatus,
  definitivelyRejected,
  isDefinitiveRejectionStatus,
  submissionResponseUnreadable,
  submissionUnknown,
  WAVESPEED_SUBMISSION_TIMEOUT_MS,
} from "./wavespeed/submission";

/**
 * The dormant fal / H3 Max submission adapter.
 *
 * Exported so it can be tested and reviewed, **not** so it can be wired:
 * `VIDEO_PROVIDER` accepts only `fake` and `wavespeed`, the factory has no fal
 * branch, and the adapter cannot be constructed without a credential nothing in
 * production supplies (ADR-0035).
 */
export { FalH3MaxSubmissionProvider } from "./fal/h3-max-provider";
export type {
  FalH3MaxSubmissionConfig,
  FalH3MaxSubmissionDeps,
} from "./fal/h3-max-provider";

/**
 * The dormant fal / H3 Max **completion status** adapter.
 *
 * Unlike everything above it, this one really does construct fal queue
 * requests — so the accurate claim about the repository is not "there is no
 * concrete polling implementation" but "the concrete polling implementation has
 * no production composition, caller or credential". Exported for tests and
 * review; the Phase 2H-2 runner it satisfies has no production caller either
 * (ADR-0040).
 */
export { FalQueueCompletionStatusSource } from "./fal/queue-status-source";
export type {
  FalQueueStatusSourceConfig,
  FalQueueStatusSourceDeps,
} from "./fal/queue-status-source";
export {
  encodeFalQueueRequestId,
  falQueueResultUrl,
  falQueueStatusUrl,
  parseFalH3MaxOutputUrl,
  parseFalQueueStatus,
  isFalQueueErrorType,
  FAL_ERROR_TYPE_DIAGNOSTIC,
  FAL_ERROR_TYPE_RETRYABLE,
  FAL_PROVIDER_NAME,
  FAL_QUEUE_ERROR_TYPES,
} from "./fal/queue-status-mapping";
export type { FalQueueErrorType, FalQueueStatusFact } from "./fal/queue-status-mapping";

export {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./wavespeed/capability";
