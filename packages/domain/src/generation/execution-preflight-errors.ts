import { AppError } from "@app/shared";

/**
 * Why a queued generation could not be prepared for submission.
 *
 * A closed vocabulary, deliberately separate from the message text. Phase 4C-2B
 * maps these to durable states and Phase 4C-3 decides what a worker does next;
 * both need something stable to switch on, and matching on prose is how a
 * refusal quietly changes meaning under a reworded string.
 *
 * Nothing here describes a provider outcome. Preflight never contacts a
 * provider, so no reason in this list can mean "we may have been charged" —
 * that ambiguity belongs to `SUBMISSION_UNKNOWN` and to the milestone that
 * actually sends the request.
 */
export const PREFLIGHT_REFUSAL_REASONS = [
  /** Admitted before ADR-0018; the request facts cannot be reconstructed. */
  "LEGACY_SNAPSHOT_MISSING",
  /** Admitted before ADR-0023; there is no frozen prompt to submit. */
  "LEGACY_PROMPT_MISSING",
  /** The stored hash disagrees with the facts stored beside it. */
  "REQUEST_HASH_MISMATCH",
  /** The deployment now points at a different provider or model. */
  "PROVIDER_CONTRACT_CHANGED",
  /** No asset with that id inside the generation's own organization. */
  "ASSET_NOT_FOUND",
  /** The asset exists but is still being uploaded, scanned or processed. */
  "ASSET_NOT_READY",
  /** The upload failed. Recoverable, but only when the customer retries it. */
  "ASSET_UPLOAD_FAILED",
  /** The asset is deleted, quarantined or rejected — it is not coming back. */
  "ASSET_GONE",
  /** The asset row points at a storage key that holds no object. */
  "SOURCE_OBJECT_MISSING",
  /** Object storage could not answer. Says nothing about the asset itself. */
  "STORAGE_UNAVAILABLE",
] as const;

export type PreflightRefusalReason = (typeof PREFLIGHT_REFUSAL_REASONS)[number];

/**
 * Reasons whose durable disposition is `FAILED_RETRYABLE` rather than
 * `FAILED_TERMINAL`.
 *
 * **Retryable does not mean "leave it `QUEUED` and try again in a moment".**
 * Both dispositions park the work: `FAILED_RETRYABLE` records that a later,
 * explicit retry policy *could* legitimately move this row back to `QUEUED`,
 * where `FAILED_TERMINAL` records that nothing ever should. Until that policy
 * exists, the two differ only in what a human or a future milestone is allowed
 * to do with the row — an automatic loop that re-queued on this flag would be
 * inventing the policy rather than reading it.
 *
 * The split is by *whether the world could change*, not by how the failure
 * felt. A processing asset may become `READY`; a failed upload can be retried
 * onto the same asset id; storage may come back. A generation with no frozen
 * prompt never acquires one.
 *
 * Note that "the world could change" includes changes only a person can make.
 * `ASSET_UPLOAD_FAILED` is retryable because `AssetService.retryUpload` exists,
 * not because time alone would fix it — which is exactly why it is a separate
 * reason from `ASSET_NOT_READY` rather than folded into it.
 */
const RETRYABLE_REASONS: readonly PreflightRefusalReason[] = [
  "ASSET_NOT_READY",
  "ASSET_UPLOAD_FAILED",
  "STORAGE_UNAVAILABLE",
];

export function isRetryablePreflightRefusal(reason: PreflightRefusalReason): boolean {
  return RETRYABLE_REASONS.includes(reason);
}

/**
 * A refusal to prepare, carrying its machine-readable reason.
 *
 * `INTERNAL_ERROR` for every reason, and that is not laziness. Nothing a
 * customer submits reaches preflight — a worker is reading rows it has not been
 * asked about — so surfacing any of this as a 422 would be a lie about whose
 * mistake it was, the same argument `assertTransition` already makes. The
 * discrimination customers never see lives in {@link reason}.
 *
 * The message names no prompt, tenant, storage key, signed URL or asset
 * content. Several of those are customer-authored and one is a credential.
 */
export class PreflightRefusalError extends AppError {
  readonly reason: PreflightRefusalReason;
  /** Whether a later explicit retry policy could legitimately re-queue this. */
  readonly retryable: boolean;

  constructor(reason: PreflightRefusalReason, message: string, options: { cause?: unknown } = {}) {
    super("INTERNAL_ERROR", message, { details: { reason }, cause: options.cause });
    this.name = "PreflightRefusalError";
    this.reason = reason;
    this.retryable = isRetryablePreflightRefusal(reason);
  }
}
