import type { VideoModelPricing } from "../types";

export interface WaveSpeedPollConfig {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly timeoutMs: number;
}

export interface WaveSpeedConfig {
  /** Server-side only. Never bundled to the browser, never logged. */
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly webhookSecret?: string;
  readonly poll: WaveSpeedPollConfig;
  /**
   * Placeholder pricing. Actual WaveSpeedAI pricing, model capabilities, and
   * limits MUST be verified against official documentation before production
   * (WaveSpeedAIIntegration.md). Kept as configuration data, not constants.
   */
  readonly pricing: VideoModelPricing;
}
