import { AppError, type ServerEnv } from "@app/shared";
import type { VideoGenerationProvider } from "./provider";
import type { VideoModelPricing } from "./types";
import { FakeVideoProvider } from "./fake/fake-provider";
import { WaveSpeedVideoProvider } from "./wavespeed/wavespeed-provider";
import { FetchHttpClient, type HttpClient } from "./wavespeed/http";

/**
 * Placeholder pricing until verified WaveSpeedAI model pricing is wired in
 * (see ADR-0003 / ADR-0005 and WaveSpeedAIIntegration.md). Kept as
 * configuration data, not a constant baked into call sites.
 */
export const DEFAULT_WAVESPEED_PRICING: VideoModelPricing = {
  currency: "USD",
  costPerSecondMinor: 10,
};

export interface CreateVideoProviderDeps {
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

/**
 * Select and construct the configured video provider. Defaults to the offline
 * fake adapter; the real WaveSpeedVideoProvider is constructed (and its fetch
 * client only created) when configured with VIDEO_PROVIDER=wavespeed and a key.
 * Network calls always go through the injected HttpClient, so unit tests stay
 * offline.
 */
export function createVideoProvider(
  env: ServerEnv,
  deps: CreateVideoProviderDeps = {},
): VideoGenerationProvider {
  if (env.VIDEO_PROVIDER === "wavespeed") {
    if (!env.WAVESPEED_API_KEY) {
      throw new AppError(
        "CONFIGURATION_ERROR",
        "WAVESPEED_API_KEY is required when VIDEO_PROVIDER=wavespeed",
      );
    }
    return new WaveSpeedVideoProvider(
      {
        apiKey: env.WAVESPEED_API_KEY,
        baseUrl: env.WAVESPEED_API_BASE_URL,
        webhookSecret: env.WAVESPEED_WEBHOOK_SECRET,
        poll: {
          initialMs: env.WAVESPEED_POLL_INITIAL_MS,
          maxMs: env.WAVESPEED_POLL_MAX_MS,
          timeoutMs: env.WAVESPEED_POLL_TIMEOUT_MS,
        },
        pricing: DEFAULT_WAVESPEED_PRICING,
      },
      { http: deps.http ?? new FetchHttpClient(), now: deps.now },
    );
  }
  return new FakeVideoProvider({ now: deps.now });
}
