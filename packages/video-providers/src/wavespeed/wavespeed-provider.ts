import { money, type Money } from "@app/shared";
import type { VideoGenerationProvider } from "../provider";
import { ProviderErrorException, providerError } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  ProviderSubmissionOutcome,
} from "../types";
import type { WaveSpeedConfig } from "./config";
import type { HttpClient, HttpResponse } from "./http";
import {
  buildSubmitUrl,
  extractOutputUrl,
  findUsablePredictionId,
  isDefinitiveRejectionStatus,
  mapToWaveSpeedRequest,
  normalizeHttpStatusError,
  normalizeWaveSpeedError,
  normalizeWaveSpeedState,
} from "./mapping";

/**
 * The submission-only timeout, in milliseconds.
 *
 * Longer than the client's 30 s default, and deliberately so: aborting a paid
 * POST does not stop the provider, it only destroys our evidence, so a short
 * budget manufactures `SUBMISSION_UNKNOWN` rows a human must reconcile. 60 s
 * matches WaveSpeedAI's own documented submission examples. Status reads and
 * cancellation keep the ordinary default (ADR-0032).
 */
const SUBMIT_TIMEOUT_MS = 60_000;

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

  /**
   * The one paid call, and the only method that reports certainty rather than
   * throwing.
   *
   * The structure is the contract. Everything above the `http.request` line is
   * **pre-invocation**: no request exists yet, a failure there is provably not
   * a charge, and it may throw. Everything from that line onward is
   * post-invocation, where the honest default is "we do not know" — including
   * the `catch`, because an injected client can reject before a byte leaves the
   * process and the boundary cannot tell that apart from a reset mid-flight.
   * Guessing in that direction is what pays twice, so it fails closed.
   *
   * `submittedAt` is read **before** the call for the same reason: every value
   * needed to describe an acceptance is in hand before acceptance can happen,
   * so no avoidable local throw can occur while holding a prediction id we
   * would then lose. Exactly one `http.request` is issued, on every path
   * (ADR-0032).
   */
  async createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    // --- pre-invocation: may throw, cannot have spent money -----------------
    const req = mapToWaveSpeedRequest(input, this.config.baseUrl);
    const body = JSON.stringify(req.body);
    const headers = this.authHeaders();
    const submittedAt = this.now().toISOString();

    // --- invocation: from here, every exit is a ProviderSubmissionOutcome ---
    let res: HttpResponse;
    try {
      res = await this.http.request({
        method: "POST",
        url: req.url,
        headers,
        body,
        redirect: "manual",
        timeoutMs: SUBMIT_TIMEOUT_MS,
      });
    } catch (error) {
      return { kind: "SUBMISSION_UNKNOWN", error: this.normalizeError(error) };
    }

    if (res.status < 200 || res.status >= 300) {
      const error = normalizeHttpStatusError(res.status);
      return isDefinitiveRejectionStatus(res.status)
        ? { kind: "DEFINITIVELY_REJECTED", error }
        : { kind: "SUBMISSION_UNKNOWN", error };
    }

    // A 2xx is not proof of acceptance on its own — the prediction id is.
    const predictionId = findUsablePredictionId(safeJsonParse(res.body));
    if (predictionId === undefined) {
      return {
        kind: "SUBMISSION_UNKNOWN",
        error: providerError({
          kind: "PROVIDER",
          code: "WAVESPEED_MISSING_PREDICTION_ID",
          messageSanitized: "WaveSpeedAI accepted response carried no usable prediction id",
          retryable: false,
          providerStatus: res.status,
        }),
      };
    }

    return {
      kind: "ACCEPTED",
      ref: { provider: this.name, modelId: input.modelId, predictionId, submittedAt },
    };
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

  /**
   * The **only** place an already-normalized error is trusted, and the check is
   * nominal on purpose. `instanceof ProviderErrorException` is provenance: this
   * application built that object. Recognising one by shape instead would let
   * an arbitrary thrown value with the right field types choose `code` and
   * `messageSanitized` outright (ADR-0031 §4). Everything else falls through to
   * a fixed classification.
   */
  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderErrorException) return error.error;
    return normalizeWaveSpeedError(error);
  }
}
