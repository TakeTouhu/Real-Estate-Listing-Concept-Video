import { providerError } from "../errors";
import type { ProviderError, ProviderGenerationRef, ProviderSubmissionOutcome } from "../types";
import { normalizeHttpStatusError } from "./mapping";

/**
 * How long a paid WaveSpeed create POST may take before it is abandoned.
 *
 * Deliberately its own constant, longer than the client-wide default: the
 * question is not "how long are we willing to wait" but "how long before giving
 * up produces a worse outcome than waiting". Abandoning a submission does not
 * cancel it — it converts a knowable answer into `SUBMISSION_UNKNOWN`, which is
 * the most expensive state this system has.
 */
export const WAVESPEED_SUBMISSION_TIMEOUT_MS = 60_000;

/**
 * Does this status establish that WaveSpeed did **not** accept the request?
 *
 * An allowlist, and the asymmetry is the whole design. Wrong in one direction
 * parks a request a human can re-submit; wrong in the other re-POSTs work the
 * provider may already be billing for. A status earns a place here only when it
 * establishes non-acceptance:
 *
 * - **400** — the request was malformed; there is nothing to execute.
 * - **401** / **403** — the credential was refused, so the request never
 *   reached anything that could begin work.
 *
 * **422 is deliberately absent**, and its previous definitive treatment is not
 * carried forward. The currently verified WaveSpeed contract does not establish
 * 422 as proof of non-acceptance, and absence of that proof is the only ground
 * this function needs. 429 and every 5xx are absent for the same reason in a
 * different direction: they describe the transport's willingness to answer, not
 * the provider's decision about the request (ADR-0035).
 *
 * Written as a `switch` over literals with **no backing collection**. An
 * exported array would be a mutable object controlling a financial
 * classification: any module holding the reference could `push(429)` and widen
 * what this system treats as proof that nothing was charged. Tests pin the
 * allowlist by asserting behaviour per status, never by importing it.
 */
export function isDefinitiveRejectionStatus(status: number): boolean {
  switch (status) {
    case 400:
    case 401:
    case 403:
      return true;
    default:
      return false;
  }
}

/**
 * A submission whose outcome this process could not determine.
 *
 * Named rather than inlined so every ambiguous path in the adapter produces the
 * same shape, and so a reader can find every one of them by finding this.
 */
export function submissionUnknown(error: ProviderError): ProviderSubmissionOutcome {
  return { kind: "SUBMISSION_UNKNOWN", error };
}

export function definitivelyRejected(error: ProviderError): ProviderSubmissionOutcome {
  return { kind: "DEFINITIVELY_REJECTED", error };
}

export function accepted(ref: ProviderGenerationRef): ProviderSubmissionOutcome {
  return { kind: "ACCEPTED", ref };
}

/**
 * Classify a WaveSpeed response that arrived **after** the POST was invoked.
 *
 * Only the status is consulted. The body is never read for classification: it
 * is untrusted external input with no schema, and ADR-0031 keeps raw provider
 * bytes out of every diagnostic this can produce.
 */
export function classifyWaveSpeedSubmissionStatus(status: number): ProviderSubmissionOutcome {
  const error = normalizeHttpStatusError(status);
  return isDefinitiveRejectionStatus(status)
    ? definitivelyRejected(error)
    : submissionUnknown(error);
}

/**
 * A 2xx whose prediction id could not be recovered.
 *
 * `SUBMISSION_UNKNOWN`, never rejection. The provider answered with success and
 * **may** hold the request and be billing for it; what failed is this side's
 * ability to name it. Calling that a rejection would invite re-submitting work
 * that may already have been accepted.
 *
 * The message says only what is known — that no usable prediction id was
 * present. It must not say the submission was accepted: acceptance is precisely
 * the fact this outcome exists because nobody can establish it.
 */
export function submissionResponseUnreadable(): ProviderSubmissionOutcome {
  return submissionUnknown(
    providerError({
      kind: "PROVIDER",
      code: "WAVESPEED_SUBMISSION_RESPONSE_INVALID",
      messageSanitized: "WaveSpeedAI submission response did not contain a usable prediction id",
      retryable: false,
    }),
  );
}
