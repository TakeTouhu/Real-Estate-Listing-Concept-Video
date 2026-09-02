import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { ProviderErrorException } from "../errors";
import type { HttpClient, HttpRequest } from "../http";
import type { VideoGenerationSubmissionProvider } from "../provider";
import type { ProviderError, ProviderGenerationInput, ProviderSubmissionOutcome } from "../types";
import {
  falHttpError,
  falMissingCredentialError,
  falSubmissionNetworkError,
  falSubmissionResponseInvalid,
  falSubmissionTimeout,
  falUnsupportedModelError,
} from "./errors";
import { mapToFalH3MaxRequest, parseFalQueueRequestId } from "./h3-max-mapping";

/** Matches WaveSpeed's submission window; the ambiguous gap is what costs. */
export const FAL_SUBMISSION_TIMEOUT_MS = 60_000;

export interface FalH3MaxSubmissionConfig {
  /**
   * The fal credential, supplied by whoever constructs this adapter.
   *
   * Constructor input, never an environment read. An adapter that reaches for
   * `process.env` itself can be armed by configuration alone; this one cannot
   * exist without a caller deciding to hand it a key, and no production path
   * does. Used only in the `Authorization` header — never logged, never
   * returned in an error, never attached to a thrown value.
   */
  readonly credential: string;
}

export interface FalH3MaxSubmissionDeps {
  readonly http: HttpClient;
  readonly now?: () => Date;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * MiniMax H3 Max submission through fal's queue API — **dormant**.
 *
 * Dormant is a precise claim: `VIDEO_PROVIDER` accepts only `fake` and
 * `wavespeed`, there is no fal key in the environment schema,
 * `createVideoProvider` has no fal branch, and this class requires a credential
 * nothing in production supplies. It is tested production code that no
 * configuration can reach.
 *
 * ## Why raw HTTP rather than `@fal-ai/client`
 *
 * The application's guarantee is *at most one outbound paid POST per call*.
 * The SDK's retry behaviour is not part of its published contract and could
 * change in a patch release, moving that guarantee into a dependency where it
 * cannot be audited from this repository. fal documents direct queue submission
 * over plain HTTP, so the seam stays here where a test can count invocations.
 *
 * That guarantee is about *this application*. fal's own durable-queue retries
 * are provider-internal processing of a request it has already accepted, and
 * are not an application re-POST — which is why `X-Fal-No-Retry` is **not**
 * sent. Suppressing fal's internal recovery to satisfy an application-side rule
 * would trade reliability for a property the application already holds.
 *
 * ## Why almost everything is UNKNOWN
 *
 * Unlike WaveSpeed, no *remote* status is a definitive rejection. fal's queue
 * publishes nothing establishing that a given status proves non-acceptance, and
 * a 422 in particular may follow work that has already been admitted and
 * billed. Copying WaveSpeed's 400/401/403 allowlist would be inventing a
 * certainty contract fal has not offered (ADR-0035).
 */
export class FalH3MaxSubmissionProvider implements VideoGenerationSubmissionProvider {
  readonly name = "fal" as const;
  private readonly credential: string;
  private readonly http: HttpClient;
  private readonly now: () => Date;

  constructor(config: FalH3MaxSubmissionConfig, deps: FalH3MaxSubmissionDeps) {
    this.credential = config.credential;
    this.http = deps.http;
    this.now = deps.now ?? (() => new Date());
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Key ${this.credential}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Submit one H3 Max generation, at most once.
   *
   * Two explicitly modelled local refusals may be definitive, because each
   * proves nothing was sent. Everything else before the invocation — mapping,
   * headers, serialization, request construction and resolving the transport
   * method — is unguarded: a failure there is a defect, not evidence about fal,
   * and it propagates. The certainty `try` opens only on the call itself.
   */
  async createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    // --- Explicitly modelled local refusals ----------------------------------
    if (input.modelId !== MINIMAX_H3_MAX_MODEL_ID) {
      return { kind: "DEFINITIVELY_REJECTED", error: falUnsupportedModelError() };
    }
    if (this.credential.trim().length === 0) {
      return { kind: "DEFINITIVELY_REJECTED", error: falMissingCredentialError() };
    }

    // --- Before invocation ---------------------------------------------------
    const mapped = mapToFalH3MaxRequest(input);
    const httpRequest: HttpRequest = {
      method: "POST",
      url: mapped.url,
      headers: this.buildHeaders(),
      body: JSON.stringify(mapped.body),
      timeoutMs: FAL_SUBMISSION_TIMEOUT_MS,
      // Never follow: a 3xx would re-send this body to a host fal's queue
      // contract does not name, as a second POST.
      redirect: "manual",
    };
    const submitRequest = this.http.request.bind(this.http);

    // --- Invocation ----------------------------------------------------------
    let response;
    try {
      response = await submitRequest(httpRequest);
    } catch (error) {
      return { kind: "SUBMISSION_UNKNOWN", error: this.normalizeError(error) };
    }

    // --- After invocation ----------------------------------------------------
    // Every non-2xx, 3xx included, is UNKNOWN. The body is never read here: it
    // is untrusted, and only the status may inform a diagnostic.
    if (response.status < 200 || response.status >= 300) {
      return { kind: "SUBMISSION_UNKNOWN", error: falHttpError(response.status) };
    }

    const requestId = parseFalQueueRequestId(safeJsonParse(response.body));
    if (requestId === null) {
      return { kind: "SUBMISSION_UNKNOWN", error: falSubmissionResponseInvalid() };
    }

    return {
      kind: "ACCEPTED",
      ref: {
        provider: this.name,
        modelId: MINIMAX_H3_MAX_MODEL_ID,
        predictionId: requestId,
        submittedAt: this.now().toISOString(),
      },
    };
  }

  /**
   * Classify a thrown value, trusting only this application's own.
   *
   * Nominal, exactly as WaveSpeed's is: `instanceof` proves provenance, where
   * matching on shape would let an arbitrary thrown object choose its own
   * `code`, `messageSanitized`, `retryable` and `providerStatus` (ADR-0031 §4).
   * Everything else lands on fixed text, and abort/network is the only
   * distinction drawn.
   */
  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderErrorException) return error.error;
    const name = error instanceof Error ? error.name : "";
    return name === "AbortError" ? falSubmissionTimeout() : falSubmissionNetworkError();
  }
}
