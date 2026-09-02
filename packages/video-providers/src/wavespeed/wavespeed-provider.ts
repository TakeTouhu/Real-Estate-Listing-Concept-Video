import { money, type Money } from "@app/shared";
import type { VideoGenerationProvider } from "../provider";
import { ProviderErrorException } from "../errors";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderGenerationRef,
  ProviderGenerationStatus,
  ProviderSubmissionOutcome,
} from "../types";
import type { WaveSpeedConfig } from "./config";
import type { HttpClient } from "./http";
import {
  accepted,
  classifyWaveSpeedSubmissionStatus,
  definitivelyRejected,
  submissionResponseUnreadable,
  submissionUnknown,
  WAVESPEED_SUBMISSION_TIMEOUT_MS,
} from "./submission";
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

  /**
   * Submit one paid generation, exactly once, and report what is known.
   *
   * The method is structured around a single line — the `this.http.request`
   * call — because that line is the invocation boundary. Before it, a failure
   * proves nothing reached WaveSpeed and is a definitive rejection. From the
   * moment it is entered, WaveSpeed may hold the request and may bill for it,
   * so every unhappy path after that point is `SUBMISSION_UNKNOWN` unless the
   * status itself proves otherwise (ADR-0035).
   *
   * There is deliberately no loop, no retry and no second request anywhere in
   * this method. `requestHash` is never transmitted: it is this application's
   * own coordination key, and WaveSpeed documents no idempotency contract that
   * would make re-sending safe.
   */
  async createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    // --- Before invocation ---------------------------------------------------
    // Mapping is local and total, but it is still on this side of the boundary:
    // if it ever refuses, nothing has been sent and the rejection is definitive.
    let req: ReturnType<typeof mapToWaveSpeedRequest>;
    try {
      req = mapToWaveSpeedRequest(input, this.config.baseUrl);
    } catch (error) {
      return definitivelyRejected(this.normalizeError(error));
    }

    // --- Invocation ----------------------------------------------------------
    // One request. Everything below is classification of what came back, never
    // another attempt.
    let res;
    try {
      res = await this.http.request({
        method: "POST",
        url: req.url,
        headers: this.authHeaders(),
        body: JSON.stringify(req.body),
        timeoutMs: WAVESPEED_SUBMISSION_TIMEOUT_MS,
        // A followed redirect would re-send this body to another URL: a second
        // POST nobody authorized, for an operation that may bill on arrival.
        redirect: "manual",
      });
    } catch (error) {
      // Timeout, abort, connection reset, DNS failure — all after the request
      // was handed to the transport. None of them says whether WaveSpeed
      // received it.
      return submissionUnknown(this.normalizeError(error));
    }

    // --- After invocation ----------------------------------------------------
    // A 3xx lands here rather than being followed, and falls through to
    // UNKNOWN: the request left this process and its fate is not established.
    if (res.status < 200 || res.status >= 300) {
      return classifyWaveSpeedSubmissionStatus(res.status);
    }

    // A 2xx this process cannot read is still a 2xx. The provider may hold the
    // request; the failure is on this side.
    let predictionId: string;
    try {
      predictionId = parsePredictionId(safeJsonParse(res.body));
    } catch {
      return submissionResponseUnreadable();
    }

    return accepted({
      provider: this.name,
      modelId: input.modelId,
      predictionId,
      submittedAt: this.now().toISOString(),
    });
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
