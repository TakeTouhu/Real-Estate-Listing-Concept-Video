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
  WAVESPEED_DEFINITIVE_REJECTION_STATUSES,
  WAVESPEED_SUBMISSION_TIMEOUT_MS,
} from "./wavespeed/submission";

/**
 * The dormant fal / H3 Max submission adapter.
 *
 * Exported so it can be tested and reviewed, **not** so it can be wired:
 * `VIDEO_PROVIDER` still accepts only `fake` and `wavespeed`, the factory has
 * no fal branch, and the adapter cannot be constructed without a credential
 * nothing in production supplies (ADR-0035).
 */
export { FalH3MaxSubmissionProvider, FAL_SUBMISSION_TIMEOUT_MS } from "./fal/h3-max-provider";
export type {
  FalH3MaxSubmissionConfig,
  FalH3MaxSubmissionDeps,
} from "./fal/h3-max-provider";
export {
  buildFalQueueSubmitUrl,
  FAL_H3_MAX_ENABLE_SAFETY_CHECKER,
  FAL_H3_MAX_ENDPOINT_ID,
  FAL_H3_MAX_PROMPT_EXPANSION_MODE,
  FAL_QUEUE_BASE_URL,
  mapToFalH3MaxRequest,
  parseFalQueueRequestId,
} from "./fal/h3-max-mapping";
export type { FalQueueRequest } from "./fal/h3-max-mapping";

export {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./wavespeed/capability";
