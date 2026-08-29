import { money, type Money } from "@app/shared";
import type { VideoGenerationProvider } from "../provider";
import { ProviderErrorException } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
} from "../types";
import type { WaveSpeedConfig } from "./config";
import type { HttpClient } from "./http";
import {
  buildSubmitUrl,
  extractOutputUrl,
  mapToWaveSpeedRequest,
  normalizeHttpStatusError,
  normalizeWaveSpeedError,
  normalizeWaveSpeedState,
  parsePredictionId,
} from "./mapping";

export interface WaveSpeedProviderDeps {
  readonly http: HttpClient;
  readonly now?: () => Date;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * WaveSpeedAI implementation of {@link VideoGenerationProvider}. All network
 * access goes through the injected {@link HttpClient}; the API key is used only
 * in the Authorization header and is never logged. The factory only constructs
 * this with a real fetch client when VIDEO_PROVIDER=wavespeed, so Phase 0's
 * default (fake) configuration performs no real API calls.
 *
 * A **non-2xx response body is read and discarded**, on every operation. Only
 * the status reaches error normalization. The body is untrusted external input
 * with no schema, and the previous code passed a 120-byte slice of it into a
 * field documented as carrying no raw provider payload (ADR-0031).
 */
export class WaveSpeedVideoProvider implements VideoGenerationProvider {
  readonly name = "wavespeed" as const;
  private readonly config: WaveSpeedConfig;
  private readonly http: HttpClient;
  private readonly now: () => Date;

  constructor(config: WaveSpeedConfig, deps: WaveSpeedProviderDeps) {
    this.config = config;
    this.http = deps.http;
    this.now = deps.now ?? (() => new Date());
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async createGeneration(input: ProviderGenerationInput): Promise<ProviderGenerationRef> {
    try {
      const req = mapToWaveSpeedRequest(input, this.config.baseUrl);
      const res = await this.http.request({
        method: "POST",
        url: req.url,
        headers: this.authHeaders(),
        body: JSON.stringify(req.body),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderErrorException(normalizeHttpStatusError(res.status));
      }
      const predictionId = parsePredictionId(safeJsonParse(res.body));
      return {
        provider: this.name,
        modelId: input.modelId,
        predictionId,
        submittedAt: this.now().toISOString(),
      };
    } catch (error) {
      throw new ProviderErrorException(this.normalizeError(error));
    }
  }

  async getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus> {
    try {
      const url = `${buildSubmitUrl(this.config.baseUrl, "predictions")}/${ref.predictionId}/result`;
      const res = await this.http.request({
        method: "GET",
        url,
        headers: this.authHeaders(),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderErrorException(normalizeHttpStatusError(res.status));
      }
      const payload = safeJsonParse(res.body) as { data?: { status?: string } };
      const state = normalizeWaveSpeedState(payload.data?.status);
      const outputUrl = extractOutputUrl(payload);
      return {
        ref,
        state,
        ...(outputUrl === undefined ? {} : { temporaryOutputUrl: outputUrl }),
      };
    } catch (error) {
      throw new ProviderErrorException(this.normalizeError(error));
    }
  }

  async cancelGeneration(ref: ProviderGenerationRef): Promise<void> {
    try {
      const url = `${buildSubmitUrl(this.config.baseUrl, "predictions")}/${ref.predictionId}/cancel`;
      const res = await this.http.request({ method: "POST", url, headers: this.authHeaders() });
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderErrorException(normalizeHttpStatusError(res.status));
      }
    } catch (error) {
      throw new ProviderErrorException(this.normalizeError(error));
    }
  }

  estimateCost(input: ProviderGenerationInput): Promise<Money> {
    return Promise.resolve(
      money(
        input.durationSeconds * this.config.pricing.costPerSecondMinor,
        this.config.pricing.currency,
      ),
    );
  }

  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderErrorException) return error.error;
    return normalizeWaveSpeedError(error);
  }
}
