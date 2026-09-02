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
import type { HttpClient, HttpRequest } from "./http";
import {
  accepted,
  classifyWaveSpeedSubmissionStatus,
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
   * The invocation boundary is the `submitRequest` call. From that point
   * WaveSpeed may hold the request and may bill for it, so every unhappy path
   * after it is `SUBMISSION_UNKNOWN` unless the status proves otherwise. Before
   * it, being on this side is *necessary* for a definitive rejection but not
   * sufficient: only an explicitly modelled local refusal may claim one, and an
   * unexpected exception propagates as the defect it is (ADR-0035).
   *
   * No loop, no retry, no second request. `requestHash` is never transmitted:
   * it is this application's own coordination key, and WaveSpeed documents no
   * idempotency contract that would make re-sending safe.
   */
  async createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    // --- Before invocation ---------------------------------------------------
    // Deliberately unguarded, and drawn as widely as JavaScript allows: mapping,
    // headers, body serialization and *resolving the transport method* all
    // complete before the certainty `try` opens. Each runs before the call, so a
    // failure is a defect — not evidence about a provider — and catching one
    // would turn an unknown bug into a claim about billing (ADR-0035).
    const req = mapToWaveSpeedRequest(input, this.config.baseUrl);
    const httpRequest: HttpRequest = {
      method: "POST",
      url: req.url,
      headers: this.authHeaders(),
      body: JSON.stringify(req.body),
      timeoutMs: WAVESPEED_SUBMISSION_TIMEOUT_MS,
      // A followed redirect would re-send this body to another URL: a second
      // POST nobody authorized, for an operation that may bill on arrival.
      redirect: "manual",
    };
    // Resolved, not called: a throwing `request` getter is a transport defect,
    // and reading it inside the `try` would disguise it as an unknown fate.
    const submitRequest = this.http.request.bind(this.http);

    // --- Invocation ----------------------------------------------------------
    // The `try` opens on the call and nothing else. One request; everything
    // below classifies what came back, never another attempt.
    let res;
    try {
      res = await submitRequest(httpRequest);
    } catch (error) {
      // Timeout, abort, connection reset, DNS failure — all raised from inside
      // the transport, after it held the request. None says whether it arrived.
      return submissionUnknown(this.normalizeError(error));
    }

    // --- After invocation ----------------------------------------------------
    // A 3xx lands here rather than being followed, and falls through to
    // UNKNOWN: the request left this process and its fate is not established.
    if (res.status < 200 || res.status >= 300) {
      return classifyWaveSpeedSubmissionStatus(res.status);
    }

    // A 2xx this process cannot read is still a 2xx. The provider may hold the
    // request; the failure is on this side. `parsePredictionId` is total over
    // arbitrary parsed JSON — a literal `null` body included — so this is a
    // branch on a value, not a `catch` standing in for validation.
    const predictionId = parsePredictionId(safeJsonParse(res.body));
    if (predictionId === null) {
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
