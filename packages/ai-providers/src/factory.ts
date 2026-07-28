import { AppError, type ServerEnv } from "@app/shared";
import type { ImageAnalysisProvider } from "@app/domain";
import { DeterministicImageAnalysisProvider } from "./deterministic-analysis-provider";

/**
 * Select the configured image-analysis provider.
 *
 * Phase 3 ships only the deterministic offline adapter (ADR-0009). No real
 * vision vendor is integrated, so any other selection fails fast rather than
 * silently degrading.
 */
export function createImageAnalysisProvider(env: ServerEnv): ImageAnalysisProvider {
  switch (env.ANALYSIS_PROVIDER) {
    case "deterministic":
      return new DeterministicImageAnalysisProvider();
    default:
      throw new AppError(
        "CONFIGURATION_ERROR",
        `Unsupported ANALYSIS_PROVIDER '${env.ANALYSIS_PROVIDER}'. Phase 3 supports 'deterministic' only.`,
      );
  }
}
