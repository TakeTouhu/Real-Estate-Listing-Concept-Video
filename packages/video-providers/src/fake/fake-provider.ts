import { money, type Money } from "@app/shared";
import type { VideoGenerationProvider } from "../provider";
import { providerError } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  VideoModelPricing,
} from "../types";

export interface FakeVideoProviderOptions {
  readonly pricing?: VideoModelPricing;
  readonly now?: () => Date;
  /** Base for the synthetic temporary output URL (never a real endpoint). */
  readonly outputUrlBase?: string;
}

const DEFAULT_PRICING: VideoModelPricing = { currency: "USD", costPerSecondMinor: 5 };

/**
 * Deterministic, offline provider used for Phase 0, local development, and
 * tests. It never performs network I/O, so it satisfies the roadmap rule
 * "Do not call the real WaveSpeedAI API in Phase 0" while proving the adapter
 * boundary compiles and is wired end-to-end.
 */
export class FakeVideoProvider implements VideoGenerationProvider {
  readonly name = "fake" as const;
  private readonly pricing: VideoModelPricing;
  private readonly now: () => Date;
  private readonly outputUrlBase: string;

  constructor(options: FakeVideoProviderOptions = {}) {
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    this.now = options.now ?? (() => new Date());
    this.outputUrlBase = options.outputUrlBase ?? "https://fake-provider.internal/outputs";
  }

  createGeneration(input: ProviderGenerationInput): Promise<ProviderGenerationRef> {
    return Promise.resolve({
      provider: this.name,
      modelId: input.modelId,
      predictionId: `fake_${input.requestHash}`,
      submittedAt: this.now().toISOString(),
    });
  }

  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus> {
    const expires = new Date(this.now().getTime() + 60 * 60 * 1000);
    return Promise.resolve({
      ref,
      state: "SUCCEEDED",
      progressPercent: 100,
      temporaryOutputUrl: `${this.outputUrlBase}/${ref.predictionId}.mp4?token=fake`,
      temporaryOutputExpiresAt: expires.toISOString(),
    });
  }

  cancelGeneration(_ref: ProviderGenerationRef): Promise<void> {
    return Promise.resolve();
  }

  estimateCost(input: ProviderGenerationInput): Promise<Money> {
    return Promise.resolve(
      money(input.durationSeconds * this.pricing.costPerSecondMinor, this.pricing.currency),
    );
  }

  normalizeError(error: unknown): ProviderError {
    return providerError({
      kind: "UNKNOWN",
      code: "FAKE_PROVIDER_ERROR",
      messageSanitized: error instanceof Error ? error.message : "Unknown fake provider error",
      cause: error,
    });
  }
}
