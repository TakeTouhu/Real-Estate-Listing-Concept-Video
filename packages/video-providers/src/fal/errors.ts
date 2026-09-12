import { isHttpStatus, providerError } from "../errors";
import type { ProviderError } from "../types";

/**
 * fal's normalized errors — every message is fixed text chosen here.
 *
 * There is deliberately **no** helper taking a caller-supplied string. The
 * superseded design had one, and a `messageSanitized` parameter is an open
 * channel into a field ADR-0031 requires to be application-owned: any future
 * caller could pass a credential, a prompt or a provider body through it. The
 * only value ever interpolated below is a validated integer HTTP status.
 *
 * `code` and `retryable` never carry certainty. Whether a submission may be
 * sent again lives only in `ProviderSubmissionOutcome.kind` (ADR-0035).
 */

export function falSubmissionTimeout(): ProviderError {
  return providerError({
    kind: "TIMEOUT",
    code: "FAL_SUBMISSION_TIMEOUT",
    messageSanitized: "The fal submission request timed out",
    // The transport may work later. That is not a statement about whether fal
    // already holds this request.
    retryable: true,
  });
}

export function falSubmissionNetworkError(): ProviderError {
  return providerError({
    kind: "NETWORK",
    code: "FAL_SUBMISSION_NETWORK_ERROR",
    messageSanitized: "Network error contacting fal",
    retryable: true,
  });
}

/**
 * A response from which no usable queue request id could be read.
 *
 * `retryable: false`: repeating would not help, because the problem is that a
 * submission fal may already hold cannot be named. The wording must not say fal
 * accepted anything — that is precisely what is unestablished.
 */
export function falSubmissionResponseInvalid(): ProviderError {
  return providerError({
    kind: "PROVIDER",
    code: "FAL_SUBMISSION_RESPONSE_INVALID",
    messageSanitized: "fal submission response did not contain a usable request id",
    retryable: false,
  });
}

/**
 * Any non-2xx from fal, carrying only the status.
 *
 * One function rather than a per-status table, because fal's queue contract
 * establishes no status that proves non-acceptance — there is nothing for a
 * table to discriminate. `retryable` is an operator scheduling hint and decides
 * no outcome. The response body is never read on this path.
 */
export function falHttpError(status: number): ProviderError {
  const providerStatus = isHttpStatus(status) ? status : undefined;
  return providerError({
    kind: status === 429 ? "RATE_LIMITED" : "PROVIDER",
    code: "FAL_HTTP_ERROR",
    messageSanitized:
      providerStatus === undefined
        ? "fal returned an unsuccessful HTTP status"
        : `fal returned HTTP status ${providerStatus}`,
    retryable: status === 429 || status >= 500,
    providerStatus,
  });
}

/** Local refusals — the only fal failures that may be definitive. */

export function falUnsupportedModelError(): ProviderError {
  return providerError({
    kind: "UNSUPPORTED",
    code: "FAL_UNSUPPORTED_MODEL",
    messageSanitized: "This adapter serves only the configured MiniMax H3 Max model",
    retryable: false,
  });
}

export function falMissingCredentialError(): ProviderError {
  return providerError({
    kind: "AUTH",
    code: "FAL_MISSING_CREDENTIAL",
    messageSanitized: "No fal credential is configured for this adapter",
    retryable: false,
  });
}

/**
 * Status-poll failures.
 *
 * Every one of these is thrown, and every throw the Phase 2H-2 runner catches
 * becomes `STATUS_SOURCE_FAILED` with **no** lifecycle mutation. That is the
 * property the whole group exists to preserve: a poll that could not establish
 * what fal did must leave the attempt exactly where it was, because "I could
 * not find out" is not evidence about a paid render.
 *
 * The messages remain fixed text for the reason at the top of this file. In
 * particular none of them may carry an unrecognized `error_type`, a response
 * body, a URL or a request id — a diagnostic is read by more people than the
 * row it describes.
 */

export function falStatusUnsupportedProviderError(): ProviderError {
  return providerError({
    kind: "UNSUPPORTED",
    code: "FAL_STATUS_UNSUPPORTED_PROVIDER",
    messageSanitized: "This status adapter answers only for fal-issued predictions",
    retryable: false,
  });
}

/**
 * A persisted request id no URL may be built from.
 *
 * Blank, or a path-traversal segment. Not retryable, and deliberately not
 * described further: the id is the untrustworthy part, so naming it in the
 * message would put it exactly where it must not go.
 */
export function falStatusRequestIdUnusableError(): ProviderError {
  return providerError({
    kind: "INVALID_INPUT",
    code: "FAL_STATUS_REQUEST_ID_UNUSABLE",
    messageSanitized: "The persisted fal request id cannot address a queue resource",
    retryable: false,
  });
}

export function falStatusTimeout(): ProviderError {
  return providerError({
    kind: "TIMEOUT",
    code: "FAL_STATUS_TIMEOUT",
    messageSanitized: "The fal status request timed out",
    retryable: true,
  });
}

export function falStatusNetworkError(): ProviderError {
  return providerError({
    kind: "NETWORK",
    code: "FAL_STATUS_NETWORK_ERROR",
    messageSanitized: "Network error contacting fal for status",
    retryable: true,
  });
}

/**
 * A 2xx status body this adapter will not act on.
 *
 * Malformed, or reporting a lifecycle state fal has not published. `retryable`
 * is `true` because the *next* poll may well be readable — the attempt is
 * untouched either way, so this only informs scheduling.
 */
export function falStatusResponseUnreadableError(): ProviderError {
  return providerError({
    kind: "PROVIDER",
    code: "FAL_STATUS_RESPONSE_UNREADABLE",
    messageSanitized: "The fal status response did not describe a known queue state",
    retryable: true,
  });
}

/**
 * fal reported a failure this application cannot classify.
 *
 * Missing, blank, wrongly typed or simply not in the closed catalog. The one
 * thing this must never do is pick a retryability: the two wrong answers are
 * abandoning a render that would have succeeded on a second attempt, and
 * spending a customer's unit again on a request that will fail identically.
 * Refusing leaves the attempt `PROCESSING`, which is recoverable by updating
 * the catalog; the guesses are not recoverable at all.
 */
export function falStatusFailureUnclassifiedError(): ProviderError {
  return providerError({
    kind: "PROVIDER",
    code: "FAL_STATUS_FAILURE_UNCLASSIFIED",
    messageSanitized: "fal reported a failure this application does not classify",
    retryable: false,
  });
}
