import { loadServerEnv, type ServerEnv } from "@app/shared";
import { createLogger, type Logger, type LogLevel } from "@app/observability";
import {
  createVideoProvider,
  type ProviderGenerationInput,
  type VideoGenerationProvider,
} from "@app/video-providers";

export interface WorkerBootstrapResult {
  readonly ready: boolean;
  readonly provider: string;
}

export interface WorkerBootstrapDeps {
  readonly env?: ServerEnv;
  readonly logger?: Logger;
  readonly provider?: VideoGenerationProvider;
}

function toLogLevel(level: ServerEnv["LOG_LEVEL"]): LogLevel {
  switch (level) {
    case "debug":
    case "trace":
      return "debug";
    case "warn":
      return "warn";
    case "error":
    case "fatal":
    case "silent":
      return "error";
    default:
      return "info";
  }
}

/**
 * Phase 0 worker bootstrap: validate configuration, construct the configured
 * video provider through the adapter boundary, and run an offline self-check
 * (cost estimate — no network). Later phases attach the queue consumer here.
 */
export async function bootstrapWorker(
  deps: WorkerBootstrapDeps = {},
): Promise<WorkerBootstrapResult> {
  const env = deps.env ?? loadServerEnv();
  const logger = deps.logger ?? createLogger({ level: toLogLevel(env.LOG_LEVEL) });
  const provider = deps.provider ?? createVideoProvider(env);

  const selfCheckInput: ProviderGenerationInput = {
    modelId: env.WAVESPEED_VIDEO_MODEL_ID,
    sourceImageUrl: "https://internal.placeholder/self-check",
    prompt: "bootstrap self-check",
    // Inside the configured model's documented 3–20s range. A self-check that
    // describes a request the model would reject is not a check of the wiring.
    durationSeconds: 5,
    aspectRatio: "16:9",
    resolution: "720p",
    requestHash: "bootstrap-self-check",
  };
  await provider.estimateCost(selfCheckInput);

  logger.info("worker bootstrap complete", { provider: provider.name });
  return { ready: true, provider: provider.name };
}
