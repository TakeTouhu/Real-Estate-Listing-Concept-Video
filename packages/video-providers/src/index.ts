export * from "./types";
export * from "./errors";
export * from "./provider";
export * from "./factory";
export * from "./catalog";

export { FakeVideoProvider } from "./fake/fake-provider";
export type { FakeVideoProviderOptions } from "./fake/fake-provider";

export { WaveSpeedVideoProvider } from "./wavespeed/wavespeed-provider";
export type { WaveSpeedProviderDeps } from "./wavespeed/wavespeed-provider";
export type { WaveSpeedConfig, WaveSpeedPollConfig } from "./wavespeed/config";
export { FetchHttpClient } from "./wavespeed/http";
export type { HttpClient, HttpRequest, HttpResponse } from "./wavespeed/http";
export * from "./wavespeed/mapping";
export {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./wavespeed/capability";
