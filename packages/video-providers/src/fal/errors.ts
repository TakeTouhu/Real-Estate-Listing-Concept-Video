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
