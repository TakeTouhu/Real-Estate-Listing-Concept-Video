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
  /**
   * Deleted, quarantined, rejected, or pending deletion. This asset id can
   * never carry an executable source again — "gone" would be inaccurate for
   * quarantined or rejected content, which still exists but is unusable.
   */
  "ASSET_UNRECOVERABLE",
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
 * **Retryable means exactly one thing:** a later *explicit* retry policy could
 * legitimately try this generation again once the asset has changed. It does
 * not mean an automatic loop, it does not mean leaving the row `QUEUED`, and it
 * does not mean retrying after a timer. Both dispositions park the work — Phase
 * 4C-2B will put a retryable refusal in `FAILED_RETRYABLE`, where it waits.
 *
 * The split follows the asset criterion: can this same identity become an
 * executable `READY` source again, without changing the admitted `assetId`?
 * Nothing here claims that happens on its own. `PENDING_UPLOAD` may be waiting
 * on a customer's client; `ASSET_UPLOAD_FAILED` needs someone to call
 * `AssetService.retryUpload`. Both are recoverable and neither is automatic,
 * which is why they are separate reasons rather than one.
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
