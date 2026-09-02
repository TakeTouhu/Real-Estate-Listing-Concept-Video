import { isHttpStatus, providerError } from "../errors";
import type { ProviderError } from "../types";

/**
 * fal's normalized errors.
 *
 * Every one is fixed application text chosen here, never built from provider
 * bytes. The only value ever interpolated is a proven integer HTTP status.
 * There is no raw body, no thrown message, no URL, no prompt, no source image
 * URL and no credential anywhere in this file — ADR-0031 binds fal exactly as
 * it binds WaveSpeed.
 *
 * **`code` never carries certainty.** A reader must not be able to infer "safe
 * to resubmit" from an error code; that answer lives only in
 * `ProviderSubmissionOutcome.kind`. The codes below describe *what went wrong*,
 * and `retryable` describes whether the transport might work later — neither is
 * permission to POST again (ADR-0035).
 */

export function falSubmissionTimeout(): ProviderError {
  return providerError({
    kind: "TIMEOUT",
    code: "FAL_SUBMISSION_TIMEOUT",
    messageSanitized: "The fal submission request timed out",
    // True: the transport may well succeed later. That is not a statement
    // about whether fal already holds this request.
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
 * A 2xx whose documented `request_id` could not be read.
 *
 * `retryable: false` on purpose: repeating the call would not help, because the
 * problem is that a submission fal may already hold cannot be named.
 */
export function falSubmissionResponseInvalid(): ProviderError {
  return providerError({
    kind: "PROVIDER",
    code: "FAL_SUBMISSION_RESPONSE_INVALID",
    messageSanitized: "fal accepted the submission but no usable request id could be read",
    retryable: false,
  });
}

/**
 * Any non-2xx from fal, carrying only the status.
 *
 * One function for every status rather than a per-status table, because fal's
 * queue contract establishes no status that proves non-acceptance — so there is
 * nothing for a table to discriminate. The status is preserved for operators
 * via `providerStatus`; it decides nothing.
 */
export function falHttpError(status: number): ProviderError {
  const providerStatus = isHttpStatus(status) ? status : undefined;
  return providerError({
    kind: status === 429 ? "RATE_LIMITED" : status >= 500 ? "PROVIDER" : "PROVIDER",
    code: "FAL_HTTP_ERROR",
    messageSanitized:
      providerStatus === undefined
        ? "fal returned an unsuccessful HTTP status"
        : `fal returned HTTP status ${providerStatus}`,
    retryable: status === 429 || status >= 500,
    providerStatus,
  });
}

/**
 * A refusal raised **before** the HTTP method was invoked.
 *
 * The only class of fal failure this milestone will call definitive, because it
 * is the only one where nothing left this process.
 */
export function falLocalConfigurationError(messageSanitized: string): ProviderError {
  return providerError({
    kind: "UNSUPPORTED",
    code: "FAL_LOCAL_CONFIGURATION_ERROR",
    messageSanitized,
    retryable: false,
  });
}
