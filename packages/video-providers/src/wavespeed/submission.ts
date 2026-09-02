import { providerError } from "../errors";
import type { ProviderError, ProviderGenerationRef, ProviderSubmissionOutcome } from "../types";
import { normalizeHttpStatusError } from "./mapping";

/**
 * How long a paid WaveSpeed create POST may take before it is abandoned.
 *
 * Deliberately its own constant, longer than the client-wide default: the
 * question is not "how long are we willing to wait" but "how long before
 * giving up produces a worse outcome than waiting". Abandoning a submission
 * does not cancel it — it converts a knowable answer into
 * `SUBMISSION_UNKNOWN`, which is the most expensive state this system has.
 */
export const WAVESPEED_SUBMISSION_TIMEOUT_MS = 60_000;

/**
 * The statuses that prove WaveSpeed did **not** accept the request.
 *
 * An allowlist, not a blocklist, and the asymmetry is the whole design. Getting
 * this set wrong in one direction parks a request a human can re-submit; wrong
 * in the other direction re-POSTs work the provider may already be billing for.
 * So a status earns a place here only when it establishes non-acceptance:
 *
 * - **400** — the request was malformed; there is nothing to execute.
 * - **401** / **403** — the credential was refused, so the request never
 *   reached anything that could begin work.
 *
 * **422 is deliberately absent**, and its previous definitive treatment is not
 * carried forward. "Unprocessable entity" describes a request the server
 * understood and declined to process *as given* — which on a generation API can
 * mean a moderation or model-level refusal reached after the request was
 * accepted, and possibly after work was begun. Semantic rejection is not proof
 * that nothing happened.
 *
 * 429 and every 5xx are absent for the same reason in a different direction:
 * they describe the transport's willingness to answer, not the provider's
 * decision about the request (ADR-0035).
 */
const DEFINITIVE_REJECTION_STATUSES: readonly number[] = [400, 401, 403];

export function isDefinitiveRejectionStatus(status: number): boolean {
  return DEFINITIVE_REJECTION_STATUSES.includes(status);
}

/** Every status in the allowlist, for tests that enumerate the contract. */
export const WAVESPEED_DEFINITIVE_REJECTION_STATUSES = DEFINITIVE_REJECTION_STATUSES;

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
 * `SUBMISSION_UNKNOWN`, never rejection. The provider answered with success —
 * it may well hold the request and be billing for it — and the failure is on
 * this side, in parsing. Calling that a rejection would invite a re-submission
 * of work already accepted, which is precisely the charge this contract exists
 * to prevent.
 */
export function submissionResponseUnreadable(): ProviderSubmissionOutcome {
  return submissionUnknown(
    providerError({
      kind: "PROVIDER",
      code: "WAVESPEED_SUBMISSION_RESPONSE_INVALID",
      messageSanitized:
        "WaveSpeedAI accepted the submission but no usable prediction id could be read",
      retryable: false,
    }),
  );
}
