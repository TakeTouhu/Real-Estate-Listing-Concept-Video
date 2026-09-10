import {
  TransientProviderOutputLocator,
  type ProviderCompletionStatusSource,
  type ProviderPollObservation,
  type ProviderStatusLookupRef,
} from "@app/domain";
import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { ProviderErrorException } from "../errors";
import type { HttpClient, HttpResponse } from "../http";
import type { ProviderError } from "../types";
import {
  falHttpError,
  falMissingCredentialError,
  falStatusFailureUnclassifiedError,
  falStatusNetworkError,
  falStatusRequestIdUnusableError,
  falStatusResponseUnreadableError,
  falStatusTimeout,
  falStatusUnsupportedProviderError,
  falUnsupportedModelError,
} from "./errors";
import {
  encodeFalQueueRequestId,
  falQueueResponseUrl,
  falQueueStatusUrl,
  FAL_ERROR_TYPE_DIAGNOSTIC,
  FAL_ERROR_TYPE_RETRYABLE,
  FAL_PROVIDER_NAME,
  parseFalH3MaxOutputUrl,
  parseFalQueueStatus,
} from "./queue-status-mapping";

/**
 * Shorter than the submission window, and for the opposite reason.
 *
 * A submission POST is given 60s because the ambiguous gap after a timeout is
 * the expensive one — fal may hold a request we cannot name. A status GET has
 * no such gap: it changes nothing, and a slow one costs only the poll. Waiting
 * a minute for it would hold a batch slot for a fact the next pass re-reads for
 * free.
 *
 * Module-local, like the submission constant, so a test cannot assert it
 * against itself. The contract is verified through the captured `HttpRequest`.
 */
const FAL_STATUS_TIMEOUT_MS = 15_000;

export interface FalQueueStatusSourceConfig {
  /**
   * The fal credential, supplied by whoever constructs this adapter.
   *
   * Constructor input, never an environment read — the same rule the submission
   * adapter follows and for the same reason. An adapter that reaches for
   * `process.env` can be armed by configuration alone; this one cannot exist
   * without a caller deciding to hand it a key, and no production path does.
   * Used only in the `Authorization` header: never logged, never returned,
   * never attached to a thrown value, never persisted.
   */
  readonly credential: string;
}

export interface FalQueueStatusSourceDeps {
  readonly http: HttpClient;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Classify a thrown transport value, trusting only this application's own.
 *
 * Nominal, exactly as the submission adapter's is. `instanceof` proves
 * provenance; matching on shape would let an arbitrary thrown object choose its
 * own `code`, `messageSanitized` and `retryable` (ADR-0031 §4). Everything else
 * lands on fixed text, and abort/network is the only distinction drawn — the
 * thrown value's message is never read, because a `fetch` failure's default
 * message carries the host, port and address it failed against.
 */
function normalizeStatusTransportError(error: unknown): ProviderError {
  if (error instanceof ProviderErrorException) return error.error;
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" ? falStatusTimeout() : falStatusNetworkError();
}

/**
 * MiniMax H3 Max completion status through fal's queue API — **dormant**.
 *
 * This is the first *concrete* implementation of Phase 2H-2's
 * `ProviderCompletionStatusSource`, and the claim about the repository has
 * changed accordingly: it now contains real fal request construction. What has
 * not changed is that nothing can reach it. `VIDEO_PROVIDER` accepts only
 * `fake` and `wavespeed`, there is no fal key in the environment schema,
 * `createVideoProvider` has no fal branch, the Phase 2H-2 runner has no
 * production caller, and this class cannot be constructed without a credential
 * nothing in production supplies. It is tested production code that no
 * configuration can reach — not code that is unable to make a request.
 *
 * ## Two calls, in one direction, at most once each
 *
 * fal's queue separates the lifecycle from the artifact: `/status` says whether
 * the render finished, `/response` returns what it produced. One `poll` makes
 * at most one of each, and the second only after the first proved success.
 * There is no loop, no backoff, no `sleep` and no call to fal's `subscribe`
 * helper — repetition is Phase 2H-2's batch cadence, which is bounded, audited
 * and interruptible, and an adapter that quietly polled until completion would
 * hold a batch slot open for a vendor's entire render time.
 *
 * ## The ordering that decides money
 *
 * Once `/status` returns `COMPLETED` with no failure, **fal has run and will
 * bill for the render**, and this adapter is committed to saying so. Every way
 * the subsequent `/response` call can go wrong — a throw, a timeout, a non-2xx,
 * unreadable JSON, a missing `video.url`, a blank one — returns
 * `SUCCEEDED` with a `null` locator, never `FAILED` and never a throw.
 *
 * That asymmetry is the point. Provider execution and output acquisition are
 * different facts with different owners, and letting the second suppress the
 * first would leave a paid attempt reading as in-flight forever while the
 * Safety Guard counted it against the tenant's exposure. Phase 2H-2 already has
 * the arm for this: `OUTPUT_LOCATOR_UNAVAILABLE`, recorded against a row that
 * is already `PROVIDER_SUCCEEDED`, re-pollable later purely to reacquire a
 * location.
 *
 * The mirror image is just as deliberate. A failure *before* completion is
 * known — the `/status` call itself throwing, timing out or returning something
 * unreadable — is never a provider failure. It throws, Phase 2H-2 maps it to
 * `STATUS_SOURCE_FAILED`, and the attempt is not touched.
 */
export class FalQueueCompletionStatusSource implements ProviderCompletionStatusSource {
  private readonly credential: string;
  private readonly http: HttpClient;

  constructor(config: FalQueueStatusSourceConfig, deps: FalQueueStatusSourceDeps) {
    this.credential = config.credential;
    this.http = deps.http;
  }

  /**
   * Exactly one GET, with the credential and nothing else.
   *
   * No body on either call — neither resource takes one, and a status poll that
   * could carry a body would be a status poll that could carry a prompt, a
   * source image or a price. No `?logs=1` either: provider log text is outside
   * this application's approved audit surface and may contain anything the
   * model was given.
   *
   * `redirect: "manual"` on a read is not the submission's argument about
   * re-POSTing a paid body; it is narrower. A followed 3xx would re-send the
   * `Authorization: Key …` header to whatever host the redirect named, which
   * makes the audience of our fal credential a decision fal's response gets to
   * make. A 3xx therefore arrives here as an ordinary non-2xx and is refused.
   */
  private async getOnce(url: string): Promise<HttpResponse> {
    return this.http.request({
      method: "GET",
      url,
      headers: { Authorization: `Key ${this.credential}` },
      timeoutMs: FAL_STATUS_TIMEOUT_MS,
      redirect: "manual",
    });
  }

  /**
   * Ask fal what became of one prediction.
   *
   * The local refusals come first and all of them precede any HTTP. That
   * ordering is the SSRF control: `providerModelId` is compared against the
   * compiled-in constant *before* a URL exists, so an attempt row carrying an
   * arbitrary model id can never become a host or a path this adapter dials.
   * The constant is then what gets interpolated — the persisted value is
   * validated, never used.
   */
  async poll(ref: ProviderStatusLookupRef): Promise<ProviderPollObservation> {
    // --- Local refusals: zero HTTP -------------------------------------------
    // Each of these throws, which Phase 2H-2 maps to STATUS_SOURCE_FAILED with
    // no mutation. Substituting a current provider or model instead would ask
    // today's default about yesterday's prediction — a lookup that fails, or
    // worse, one that succeeds against unrelated work.
    if (ref.providerName !== FAL_PROVIDER_NAME) {
      throw new ProviderErrorException(falStatusUnsupportedProviderError());
    }
    if (ref.providerModelId !== MINIMAX_H3_MAX_MODEL_ID) {
      throw new ProviderErrorException(falUnsupportedModelError());
    }
    if (this.credential.trim().length === 0) {
      throw new ProviderErrorException(falMissingCredentialError());
    }
    const encodedRequestId = encodeFalQueueRequestId(ref.providerPredictionId);
    if (encodedRequestId === null) {
      throw new ProviderErrorException(falStatusRequestIdUnusableError());
    }

    // --- One status request ---------------------------------------------------
    let statusResponse: HttpResponse;
    try {
      statusResponse = await this.getOnce(falQueueStatusUrl(encodedRequestId));
    } catch (error) {
      // Nothing was learned about fal. Not a provider failure, and the thrown
      // value is classified by type alone — never read, never logged.
      throw new ProviderErrorException(normalizeStatusTransportError(error));
    }

    if (!isSuccessStatus(statusResponse.status)) {
      // Only the status informs the diagnostic; the body is never read on this
      // path. An HTTP code is a fact about one exchange and is not evidence
      // about the render, so this cannot become a provider FAILED.
      throw new ProviderErrorException(falHttpError(statusResponse.status));
    }

    const fact = parseFalQueueStatus(safeJsonParse(statusResponse.body));
    if (fact === null) {
      throw new ProviderErrorException(falStatusResponseUnreadableError());
    }

    switch (fact.kind) {
      case "IN_PROGRESS":
        // IN_QUEUE and IN_PROGRESS both land here. No queue position, no ETA,
        // no logs: none is a fact this phase records, and a field that exists
        // is a field something eventually tries to store.
        return { kind: "IN_PROGRESS" };

      case "COMPLETED_FAILURE":
        return {
          kind: "FAILED",
          retryable: FAL_ERROR_TYPE_RETRYABLE[fact.errorType],
          diagnosticCode: FAL_ERROR_TYPE_DIAGNOSTIC[fact.errorType],
        };

      case "COMPLETED_FAILURE_UNCLASSIFIED":
        // Fail closed. Refusing leaves the attempt PROCESSING and recoverable
        // by extending the catalog; either guess about retryability is not.
        throw new ProviderErrorException(falStatusFailureUnclassifiedError());

      case "COMPLETED_SUCCESS":
        // From here on the render is a durable, billable fact. Nothing below
        // may throw, and nothing below may return anything but SUCCEEDED.
        return { kind: "SUCCEEDED", outputLocator: await this.acquireLocator(encodedRequestId) };
    }
  }

  /**
   * Fetch the finished artifact's location, or give up quietly.
   *
   * **Total by construction: this cannot throw and cannot return a failure.**
   * It is only ever called once provider success is established, and at that
   * point the only two truthful answers are "here is where the output is" and
   * "the output exists but I could not get a location for it right now".
   *
   * The `catch` binds nothing on purpose. There is no value in scope to
   * accidentally log, attach to an error or widen a diagnostic with, which is a
   * stronger guarantee than binding it and remembering not to touch it.
   *
   * The URL is handed straight to `TransientProviderOutputLocator`, which is
   * the only form in which it leaves this method. A signed fal media URL is
   * bearer authorization in URL form; returning it as a string would put a
   * credential into a value that is spreadable, loggable and serializable.
   */
  private async acquireLocator(
    encodedRequestId: string,
  ): Promise<TransientProviderOutputLocator | null> {
    let response: HttpResponse;
    try {
      response = await this.getOnce(falQueueResponseUrl(encodedRequestId));
    } catch {
      return null;
    }
    if (!isSuccessStatus(response.status)) return null;

    const url = parseFalH3MaxOutputUrl(safeJsonParse(response.body));
    if (url === null) return null;

    const built = TransientProviderOutputLocator.fromUnknown(url);
    return built.ok ? built.value : null;
  }
}
