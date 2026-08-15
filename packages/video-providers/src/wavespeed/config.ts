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
  /**
   * No `modelId` here, deliberately.
   *
   * An earlier version carried one, and nothing ever read it: the adapter builds
   * every submit URL from `input.modelId`. Keeping a second, unread model
   * identity invited the capability descriptor and the configured default to
   * drift apart unnoticed. The default for *new* admissions is
   * `WAVESPEED_OPEN_VIDEO_MODEL_ID` in `@app/shared`; the model an *existing*
   * generation executes against is the one frozen on its row (ADR-0019).
   */
  readonly webhookSecret?: string;
  readonly poll: WaveSpeedPollConfig;
  /**
   * Placeholder pricing. Actual WaveSpeedAI pricing, model capabilities, and
   * limits MUST be verified against official documentation before production
   * (WaveSpeedAIIntegration.md). Kept as configuration data, not constants.
   */
  readonly pricing: VideoModelPricing;
}
