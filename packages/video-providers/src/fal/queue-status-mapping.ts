import type { SubmissionDiagnosticCode } from "@app/domain";
import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { deepFreeze } from "../deep-freeze";
import { FAL_QUEUE_BASE_URL } from "./h3-max-mapping";

/**
 * Everything the fal queue status adapter has to decide *before* it is allowed
 * to believe anything: which resource to address, and what a response means.
 *
 * Separated from the adapter because all of it is pure. The adapter owns one
 * status request, one conditional result request and the ordering between them;
 * this module owns the vocabulary, and a vocabulary that can be exercised
 * without a transport is a vocabulary a test can enumerate exhaustively.
 */

/** The one provider name this adapter answers for. */
export const FAL_PROVIDER_NAME = "fal";

/**
 * fal's queue lifecycle, exactly as fal publishes it.
 *
 * Three states, and only the third is terminal. `IN_QUEUE` and `IN_PROGRESS`
 * are different facts about fal's scheduler and the same fact about our
 * application: the render has not finished, and there is nothing to record.
 * Collapsing them here rather than in the adapter keeps the distinction from
 * reaching a caller that would then have to decide it does not matter.
 */
const FAL_STATUS_IN_QUEUE = "IN_QUEUE";
const FAL_STATUS_IN_PROGRESS = "IN_PROGRESS";
const FAL_STATUS_COMPLETED = "COMPLETED";

/**
 * The closed fal request-error vocabulary, taken from fal's current published
 * request-error contract.
 *
 * Closed is the whole point. An `error_type` this list does not contain is not
 * approximated, prefix-matched or bucketed by resemblance — `runner_something_new`
 * looks like the retryable family and might mean the opposite, and the cost of
 * guessing is either a paid render abandoned as terminal or a customer's unit
 * handed back for a failure that was really their prompt. Fail-closed is
 * cheaper than either, and the failure is loud enough to get the list updated.
 */
export const FAL_QUEUE_ERROR_TYPES = deepFreeze([
  "request_timeout",
  "startup_timeout",
  "runner_scheduling_failure",
  "runner_connection_timeout",
  "runner_disconnected",
  "runner_connection_refused",
  "runner_connection_error",
  "runner_incomplete_response",
  "runner_server_error",
  "client_disconnected",
  "client_cancelled",
  "bad_request",
  "internal_error",
] as const);

export type FalQueueErrorType = (typeof FAL_QUEUE_ERROR_TYPES)[number];

export function isFalQueueErrorType(value: unknown): value is FalQueueErrorType {
  return typeof value === "string" && (FAL_QUEUE_ERROR_TYPES as readonly string[]).includes(value);
}

/**
 * Whether a *new* attempt row may later be admitted for the same request.
 *
 * Not whether this adapter retries anything — it never does, and there is no
 * loop in the file that consults this table. The question is narrower and
 * money-relevant: fal already ran and billed for the failed execution, so
 * `true` authorizes spending again and `false` says a second identical spend
 * would fail the same way.
 *
 * The split follows who failed. Everything describing fal's own infrastructure
 * — schedulers, runners, timeouts, internal errors — is retryable, because the
 * request itself was never shown to be wrong. The three `false` entries are the
 * ones where repeating is either pointless or already the caller's decision:
 * `bad_request` is our own malformed request, and both `client_*` values mean
 * the request was withdrawn from our side rather than failed by fal.
 *
 * A `Record` keyed by the union rather than a lookup with a default: omitting a
 * member fails `tsc`, so extending {@link FAL_QUEUE_ERROR_TYPES} forces an
 * explicit decision here instead of silently inheriting one.
 */
export const FAL_ERROR_TYPE_RETRYABLE: Record<FalQueueErrorType, boolean> = {
  request_timeout: true,
  startup_timeout: true,
  runner_scheduling_failure: true,
  runner_connection_timeout: true,
  runner_disconnected: true,
  runner_connection_refused: true,
  runner_connection_error: true,
  runner_incomplete_response: true,
  runner_server_error: true,
  internal_error: true,
  client_disconnected: false,
  client_cancelled: false,
  bad_request: false,
};

/**
 * The application-owned diagnostic, or none.
 *
 * `SubmissionDiagnosticCode` is Phase 2G-1's closed catalog and this phase does
 * not extend it. That constraint is doing real work: fal's vocabulary is
 * thirteen values wide and ours is three, so most entries below are `null`, and
 * `null` is the honest answer rather than a gap. Inventing `RUNNER_FAILURE` to
 * make the mapping look complete would put a vendor's taxonomy into a field
 * ADR-0031 requires this application to own.
 *
 * Note what is never persisted: the `error_type` itself. It selects a code from
 * our catalog and then stops at this boundary.
 */
export const FAL_ERROR_TYPE_DIAGNOSTIC: Record<FalQueueErrorType, SubmissionDiagnosticCode | null> =
  {
    // Nobody answered in time — the canonical timeout shape.
    request_timeout: "TIMEOUT",
    startup_timeout: "TIMEOUT",
    // The transport failed mid-exchange rather than nobody answering. An
    // operator triaging a spike wants to know which, and neither says anything
    // more about what fal did.
    runner_connection_timeout: "CONNECTION_RESET",
    runner_disconnected: "CONNECTION_RESET",
    runner_connection_refused: "CONNECTION_RESET",
    runner_connection_error: "CONNECTION_RESET",
    runner_incomplete_response: "CONNECTION_RESET",
    // The only member that describes *this system*: we sent something fal
    // would not accept, and no amount of asking fal again changes that.
    bad_request: "LOCAL_CONFIGURATION",
    // Truthfully unclassifiable in a three-member catalog. fal's scheduler and
    // its internal errors are neither a timeout nor a reset nor our
    // configuration, and a client-side withdrawal is none of the three either.
    runner_scheduling_failure: null,
    runner_server_error: null,
    internal_error: null,
    client_disconnected: null,
    client_cancelled: null,
  };

/**
 * What one status response established, in this adapter's own words.
 *
 * Four outcomes rather than three, because "COMPLETED and it failed, but the
 * failure cannot be classified" is not the same as any of the others and must
 * not be quietly folded into one. It is the only arm that carries no decision:
 * it exists so the adapter can refuse.
 */
export type FalQueueStatusFact =
  | { readonly kind: "IN_PROGRESS" }
  | { readonly kind: "COMPLETED_SUCCESS" }
  | { readonly kind: "COMPLETED_FAILURE"; readonly errorType: FalQueueErrorType }
  | { readonly kind: "COMPLETED_FAILURE_UNCLASSIFIED" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a fal status body, or refuse it.
 *
 * **Total over arbitrary parsed JSON**, and `null` means "this adapter will not
 * act on this". `null`, an array, a string, a number, a missing `status`, a
 * non-string `status` and an unrecognized `status` all land there — an unknown
 * lifecycle value in particular, because fal adding a fourth state must not be
 * read as either "still working" or "finished".
 *
 * Only three fields are consulted: `status`, `error` and `error_type`. Not
 * `queue_position`, not `logs`, not `metrics`, not `response_url`, not
 * `status_url`, not `cancel_url`. A field this function does not read is a
 * field that cannot reach a decision, a log line or a column, which is a
 * stronger guarantee than reading it and choosing not to use it.
 *
 * Failure is recognized by *either* `error` or `error_type` being present,
 * deliberately: a body claiming a failure through only the human-readable half
 * still claims a failure, and treating it as success would record a paid render
 * as usable. But the human-readable half is only ever counted — never read,
 * never matched, never classified. Classification comes from `error_type`
 * alone, and a claim we cannot classify becomes
 * `COMPLETED_FAILURE_UNCLASSIFIED` rather than a guess in either direction.
 */
export function parseFalQueueStatus(payload: unknown): FalQueueStatusFact | null {
  if (!isPlainRecord(payload)) return null;

  const status = payload.status;
  if (typeof status !== "string") return null;

  if (status === FAL_STATUS_IN_QUEUE || status === FAL_STATUS_IN_PROGRESS) {
    return { kind: "IN_PROGRESS" };
  }
  if (status !== FAL_STATUS_COMPLETED) return null;

  // `undefined` and `null` both mean "fal did not report a failure". Anything
  // else in either field is a claim, however badly shaped.
  const claimsFailure =
    (payload.error !== undefined && payload.error !== null) ||
    (payload.error_type !== undefined && payload.error_type !== null);
  if (!claimsFailure) return { kind: "COMPLETED_SUCCESS" };

  const errorType = payload.error_type;
  if (!isFalQueueErrorType(errorType)) return { kind: "COMPLETED_FAILURE_UNCLASSIFIED" };
  return { kind: "COMPLETED_FAILURE", errorType };
}

/**
 * Recover H3 Max's documented output location, or `null`.
 *
 * `video.url` and nothing else. `content_type`, `file_name`, `file_size`,
 * `expanded_prompt`, `timings` and `logs` are all present in a real H3 Max
 * response and none of them informs a durable decision in this phase —
 * Phase 2H-1's managed-output verification is the authority for size and digest,
 * and it measures the bytes we actually stored rather than believing what the
 * vendor said about them.
 *
 * Total, and never throws: this runs after provider success is already known,
 * where a `TypeError` would turn a recorded success into a thrown status-source
 * failure.
 */
export function parseFalH3MaxOutputUrl(payload: unknown): string | null {
  if (!isPlainRecord(payload)) return null;
  const video = payload.video;
  if (!isPlainRecord(video)) return null;
  const url = video.url;
  if (typeof url !== "string" || url.trim().length === 0) return null;
  return url;
}

/**
 * A persisted fal request id, encoded as exactly one path component — or `null`
 * if it cannot be.
 *
 * The id is opaque external-ish data that has been sitting in a database column
 * since submission, and it is about to be spliced into a URL. `encodeURIComponent`
 * neutralizes the obvious weapons: `/` becomes `%2F`, `?` and `#` and `%`
 * likewise, and control characters that could split a request are escaped.
 *
 * It does **not** neutralize dots, which is the interesting case. `..` survives
 * encoding untouched, and `…/requests/../status` is a different resource from
 * the one this adapter meant to address. So a segment consisting only of dots
 * is refused outright rather than encoded — there is no legitimate fal request
 * id it could be, and refusing is the only answer that cannot be normalized
 * away by something downstream.
 *
 * Refusal never rewrites the database. The persisted id is historical identity
 * and stays exactly as fal issued it; this function only decides whether a URL
 * may be built from it.
 */
export function encodeFalQueueRequestId(requestId: string): string | null {
  if (requestId.trim().length === 0) return null;
  const encoded = encodeURIComponent(requestId);
  if (/^\.+$/.test(encoded)) return null;
  return encoded;
}

/**
 * The two queue resources, derived from a frozen host and a frozen model id.
 *
 * Both take the **already-encoded** id, and neither takes a model: the model
 * segment is {@link MINIMAX_H3_MAX_MODEL_ID}, the compiled-in constant, not the
 * `providerModelId` off the attempt row. The adapter compares the persisted
 * value against that constant and then interpolates the constant, which is a
 * deliberate belt-and-braces: even if the equality check were ever weakened or
 * removed, a persisted model id still could not become outbound network
 * authority, because it is not what these functions read.
 *
 * fal's own `status_url`, `response_url` and `cancel_url` are never used for the
 * same reason one step further out — a provider-supplied URL is a
 * provider-chosen host, and a poll that follows one is a request this
 * application never authorized, carrying an `Authorization` header whose
 * audience it did not choose.
 *
 * ## The result resource has no `/response` suffix
 *
 * The status resource ends in `/status`; the **result resource is the request
 * itself**:
 *
 * ```text
 * status  GET /{modelId}/requests/{requestId}/status
 * result  GET /{modelId}/requests/{requestId}
 * ```
 *
 * fal's current documentation is internally inconsistent about this, which is
 * worth recording because it is the kind of thing that gets "fixed" back the
 * wrong way. The submit and status payloads carry a `response_url` that ends in
 * `/response`, while the current REST *Get the Result* operation and the current
 * official `fal-ai/fal-js` client's `queue.result()` both address
 * `/requests/{requestId}` with no suffix. The SDK and the result operation are
 * treated as authoritative here.
 *
 * The resolution is deliberately **not** "follow `response_url`". Doing so would
 * read as pragmatic and would quietly hand a vendor's response body the power to
 * choose where this application sends its credential — trading a one-line URL
 * question for a routing-authority one. The suffix is derived correctly instead,
 * and the payload's URLs stay unread.
 *
 * A wrong suffix here is not a cosmetic defect. Every completed-success poll
 * would GET a resource that does not exist, take the non-2xx path, and answer
 * `SUCCEEDED` with a null locator — so provider success would be recorded
 * correctly and output ingestion could never start, on every attempt, silently.
 */
export function falQueueStatusUrl(encodedRequestId: string): string {
  return `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${encodedRequestId}/status`;
}

export function falQueueResultUrl(encodedRequestId: string): string {
  return `${FAL_QUEUE_BASE_URL}/${MINIMAX_H3_MAX_MODEL_ID}/requests/${encodedRequestId}`;
}
