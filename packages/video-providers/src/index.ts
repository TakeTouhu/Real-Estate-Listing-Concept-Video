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

export {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./wavespeed/capability";
