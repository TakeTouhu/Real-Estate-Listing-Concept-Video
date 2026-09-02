import { ProviderErrorException } from "../errors";
import type { HttpClient } from "../http";
import type {
  ProviderError,
  ProviderGenerationInput,
  ProviderSubmissionOutcome,
} from "../types";
import type { VideoGenerationSubmissionProvider } from "../provider";
import {
  falHttpError,
  falLocalConfigurationError,
  falSubmissionNetworkError,
  falSubmissionResponseInvalid,
  falSubmissionTimeout,
} from "./errors";
import {
  FAL_H3_MAX_ENDPOINT_ID,
  FAL_QUEUE_BASE_URL,
  mapToFalH3MaxRequest,
  parseFalQueueRequestId,
} from "./h3-max-mapping";

/** Matches the WaveSpeed submission window; the ambiguous gap is what costs. */
export const FAL_SUBMISSION_TIMEOUT_MS = 60_000;

export interface FalH3MaxSubmissionConfig {
  /**
   * The fal credential, supplied by whoever constructs this adapter.
   *
   * Deliberately constructor input rather than an environment read. An adapter
   * that reaches for `process.env` itself can be armed by configuration alone;
   * this one cannot exist without a caller deciding to hand it a key, and no
   * production path does. It is used only in the `Authorization` header — never
   * logged, never returned in an error, never attached to a thrown value.
   */
  readonly credential: string;
  /** Injectable so tests resolve nothing. Defaults to the official queue host. */
  readonly baseUrl?: string;
}

export interface FalH3MaxSubmissionDeps {
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
 * MiniMax H3 Max submission through fal's queue API — **dormant**.
 *
 * Dormant is a precise claim, not a caveat. `VIDEO_PROVIDER` still accepts only
 * `fake` and `wavespeed`, there is no `FAL_API_KEY` in the environment schema,
 * `createVideoProvider` has no fal branch, and this class requires a credential
 * that nothing in production supplies. It is tested production code that no
 * configuration can reach (ADR-0035).
 *
 * ## Why raw HTTP rather than `@fal-ai/client`
 *
 * The application's central financial guarantee is *at most one outbound paid
 * POST per call*. The SDK's retry behaviour is not part of its public contract
 * and could change in a patch release; adopting it would move the guarantee
 * into a dependency where it cannot be audited from this repository. fal
 * documents direct queue submission over plain HTTP, so the seam stays here
 * where a test can count invocations. The SDK may be reconsidered later for
 * non-submission operations, and only after its retry behaviour is separately
 * proven safe.
 *
 * ## Why almost everything is UNKNOWN
 *
 * This adapter implements only {@link VideoGenerationSubmissionProvider}: it has
 * no verified pricing, polling or cancellation contract, so it declares none
 * rather than fabricating three answers to satisfy a wider interface.
 *
 * And unlike WaveSpeed, it treats **no** remote status as a definitive
 * rejection. That is not caution for its own sake: fal's queue documents client
 * and model errors — 422 among them — that can be raised *after* a request has
 * been accepted and GPU work begun. A status that means "your input was wrong"
 * is not evidence that nothing was charged. Copying WaveSpeed's 400/401/403
 * allowlist here would be inventing a certainty contract fal has not published.
 */
export class FalH3MaxSubmissionProvider implements VideoGenerationSubmissionProvider {
  readonly name = "fal" as const;
  private readonly credential: string;
  private readonly baseUrl: string;
  private readonly http: HttpClient;
  private readonly now: () => Date;

  constructor(config: FalH3MaxSubmissionConfig, deps: FalH3MaxSubmissionDeps) {
    this.credential = config.credential;
    this.baseUrl = config.baseUrl ?? FAL_QUEUE_BASE_URL;
    this.http = deps.http;
    this.now = deps.now ?? (() => new Date());
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Key ${this.credential}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Submit one H3 Max generation, at most once.
   *
   * The structure mirrors the WaveSpeed adapter deliberately: everything before
   * `this.http.request` can be a definitive rejection, and everything from that
   * call onward cannot. The boundary is a single line so it stays visible.
   */
  async createGeneration(input: ProviderGenerationInput): Promise<ProviderSubmissionOutcome> {
    // --- Before invocation ---------------------------------------------------
    // Local refusals only. Each proves nothing was sent, which is the sole
    // basis on which this adapter will say DEFINITIVELY_REJECTED.
    if (input.modelId !== FAL_H3_MAX_ENDPOINT_ID) {
      return {
        kind: "DEFINITIVELY_REJECTED",
        error: falLocalConfigurationError(
          "This adapter serves only the configured MiniMax H3 Max endpoint",
        ),
      };
    }
    if (this.credential.trim().length === 0) {
      return {
        kind: "DEFINITIVELY_REJECTED",
        error: falLocalConfigurationError("No fal credential is configured for this adapter"),
      };
    }

    const req = mapToFalH3MaxRequest(input, this.baseUrl);

    // --- Invocation ----------------------------------------------------------
    // One request, and no `catch` above it that could lead back here.
    let res;
    try {
      res = await this.http.request({
        method: "POST",
        url: req.url,
        headers: this.authHeaders(),
        body: JSON.stringify(req.body),
        timeoutMs: FAL_SUBMISSION_TIMEOUT_MS,
        // Never follow: a 3xx would re-send this body to a host fal's queue
        // contract does not name, as a second POST.
        redirect: "manual",
      });
    } catch (error) {
      // Timeout and transport failure are indistinguishable from "fal has it"
      // from here. Neither is retried, and neither is definitive.
      return { kind: "SUBMISSION_UNKNOWN", error: this.normalizeError(error) };
    }

    // --- After invocation ----------------------------------------------------
    // Every non-2xx, 3xx included, is UNKNOWN. The response body is never read
    // on this path: it is untrusted, and only the status may inform an error.
    if (res.status < 200 || res.status >= 300) {
      return { kind: "SUBMISSION_UNKNOWN", error: falHttpError(res.status) };
    }

    // A 2xx is parsed only far enough to recover the documented identifier.
    const requestId = parseFalQueueRequestId(safeJsonParse(res.body));
    if (requestId === null) {
      return { kind: "SUBMISSION_UNKNOWN", error: falSubmissionResponseInvalid() };
    }

    return {
      kind: "ACCEPTED",
      ref: {
        provider: this.name,
        modelId: input.modelId,
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
   * `code` and `messageSanitized` (ADR-0031 §4). Everything else lands on fixed
   * text, and the abort/network split is the only distinction drawn.
   */
  normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderErrorException) return error.error;
    const name = error instanceof Error ? error.name : "";
    return name === "AbortError" ? falSubmissionTimeout() : falSubmissionNetworkError();
  }
}
