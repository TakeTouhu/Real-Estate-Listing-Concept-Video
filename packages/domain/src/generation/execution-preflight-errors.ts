import { AppError } from "@app/shared";

/**
 * Why a queued generation could not be prepared for submission.
 *
 * A closed vocabulary of thirteen, deliberately separate from the message text.
 * Phase 4C-2B maps these to durable states and Phase 4C-3 decides what a worker
 * does next; both need something stable to switch on, and matching on prose is
 * how a refusal quietly changes meaning under a reworded string.
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
  /** The deployment now serves a different provider or model than was admitted. */
  "PROVIDER_IDENTITY_MISMATCH",
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
  /** Ready, but not a normalized JPEG source, or its storage key is blank. */
  "ASSET_FORMAT_UNSUPPORTED",
  /** The asset changed underneath preparation, after the URL was signed. */
  "ASSET_SOURCE_CHANGED",
  /** The asset row points at a storage key that holds no object. */
  "ASSET_OBJECT_MISSING",
  /** Object storage could not answer. Says nothing about the asset itself. */
  "STORAGE_UNAVAILABLE",
  /** Storage returned a URL or expiry a provider could not use. */
  "SIGNED_SOURCE_URL_UNUSABLE",
] as const;

export type PreflightRefusalReason = (typeof PREFLIGHT_REFUSAL_REASONS)[number];

/**
 * What a later milestone may do with a refused generation.
 *
 * Two values, and neither is "try again now". Phase 4C-2B parks a `RETRYABLE`
 * refusal in `FAILED_RETRYABLE` and a `TERMINAL` one in `FAILED_TERMINAL`;
 * **both are parked**. The difference is only whether a later *explicit* policy
 * could legitimately return the row to `QUEUED` once the world has changed.
 * There is no automatic loop, no timer, and no leaving the row `QUEUED`.
 */
export type PreflightDisposition = "TERMINAL" | "RETRYABLE";

/**
 * The one canonical answer for every reason.
 *
 * A `Record` keyed by the reason union, so a new reason fails to compile until
 * its disposition is decided. There is deliberately no second list of retryable
 * reasons and no second list of terminal ones — two sources would disagree
 * eventually, and the one that decides whether customer work is permanently
 * failed is the wrong place to find that out.
 *
 * `RETRYABLE` follows the same-identity criterion: the source may still become
 * usable under the admitted `assetId`, or the infrastructure that refused may
 * simply answer next time.
 */
const REASON_DISPOSITION: Record<PreflightRefusalReason, PreflightDisposition> = {
  LEGACY_SNAPSHOT_MISSING: "TERMINAL",
  LEGACY_PROMPT_MISSING: "TERMINAL",
  REQUEST_HASH_MISMATCH: "TERMINAL",
  PROVIDER_IDENTITY_MISMATCH: "TERMINAL",
  ASSET_NOT_FOUND: "TERMINAL",
  ASSET_NOT_READY: "RETRYABLE",
  ASSET_UPLOAD_FAILED: "RETRYABLE",
  ASSET_UNRECOVERABLE: "TERMINAL",
  ASSET_FORMAT_UNSUPPORTED: "TERMINAL",
  ASSET_SOURCE_CHANGED: "TERMINAL",
  ASSET_OBJECT_MISSING: "TERMINAL",
  STORAGE_UNAVAILABLE: "RETRYABLE",
  SIGNED_SOURCE_URL_UNUSABLE: "RETRYABLE",
};

/** The disposition of a refusal reason. Pure, and the only source of the answer. */
export function preflightDispositionFor(reason: PreflightRefusalReason): PreflightDisposition {
  return REASON_DISPOSITION[reason];
}

/**
 * The durable state a refused generation is parked in.
 *
 * The union is two states wide on purpose. Widening it to
 * `SceneGenerationState` would let a future edit return `SUBMITTING` — a
 * licence to spend money — from a helper whose entire job is to describe work
 * that will **not** be submitted. Here that is a compile error.
 */
export type PreflightFailureState = "FAILED_RETRYABLE" | "FAILED_TERMINAL";

/**
 * Disposition to durable state. Two entries, because there are two dispositions.
 *
 * Deliberately **not** a second thirteen-reason table. {@link REASON_DISPOSITION}
 * already answers "what may be done about this reason", and re-deciding that per
 * reason here would create two places where a reason's fate is written down —
 * the classic way a `TERMINAL` reason acquires a `FAILED_RETRYABLE` parking spot
 * in one file and not the other. Reasons reach a state only *through* their
 * disposition.
 */
const DISPOSITION_FAILURE_STATE: Record<PreflightDisposition, PreflightFailureState> = {
  RETRYABLE: "FAILED_RETRYABLE",
  TERMINAL: "FAILED_TERMINAL",
};

/**
 * Where a refusal parks. Pure, total over the reason vocabulary, and derived.
 *
 * **Both outcomes are parked.** `FAILED_RETRYABLE` does not mean anything will
 * try again — it means a later *explicit* policy could legitimately return the
 * row to `QUEUED` once the world has changed. Nothing performs that move today
 * (see `state-machine.ts`), and this helper introduces no actor.
 */
export function preflightFailureStateFor(reason: PreflightRefusalReason): PreflightFailureState {
  return DISPOSITION_FAILURE_STATE[preflightDispositionFor(reason)];
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
 * **This object is safe to log whole.** It accepts no cause, so a raw
 * infrastructure error can never ride along inside it, and every message is
 * fixed text chosen at the throw site. It carries no signed URL, storage key,
 * credential, prompt, compiled prompt, request hash, organization id, asset id
 * or provider payload — several of those are customer-authored and one is a
 * credential. The only detail is the reason, which is already public
 * vocabulary.
 */
export class PreflightRefusalError extends AppError {
  readonly reason: PreflightRefusalReason;
  /** Always derived from {@link preflightDispositionFor}; never passed in. */
  readonly disposition: PreflightDisposition;

  constructor(reason: PreflightRefusalReason, message: string) {
    super("INTERNAL_ERROR", message, { details: { reason } });
    this.name = "PreflightRefusalError";
    this.reason = reason;
    this.disposition = preflightDispositionFor(reason);
  }
}
