/**
 * Durable media-failure resolution — the policy, in one place.
 *
 * Phase 6B gave a terminal media failure one bounded consequence: a single
 * automatic `SYSTEM_RECOVERY` attempt. It deliberately stopped there, which left
 * two holes this module closes.
 *
 * ## Hole 1 — a planning refusal was an answer
 *
 * Phase 6B's runner reported `NO_PLAN` and moved on. Nothing durable recorded
 * that the candidate had been looked at, so the next bounded oldest-first sweep
 * offered the same rows again, and a prefix of unplannable candidates could
 * occupy every pass forever while newer, actionable failures sat behind them.
 *
 * `NO_PLAN` is also almost never a verdict about the customer. An FX source can
 * be unreachable, a rate card can be mid-replacement, a model can be withdrawn
 * for an afternoon. Terminalizing a customer's job because the platform's own
 * configuration was briefly inconsistent would be the platform charging its
 * outage to the customer. So a refusal **defers**: the work row goes back to
 * `PENDING` with a future `nextAttemptAt`, disappears from discovery until then,
 * and the sweep moves on to work it can actually do.
 *
 * That durable deferral is the whole fairness mechanism. It is not a scan
 * heuristic and not an unbounded query — the candidate simply stops being a
 * candidate for a while.
 *
 * ## Hole 2 — an exhausted recovery settled nothing
 *
 * When the one automatic recovery *also* came back as unusable media, Phase 6B
 * returned `RECOVERY_LIMIT_REACHED` and left the customer's request `GENERATING`
 * forever, with a reservation still held. This module's settlement kinds are the
 * terminal answers, and which one applies is decided by the request kind:
 *
 * ```text
 * INITIAL            -> the customer got nothing  -> fail everything, RELEASE the hold
 * USER_REGENERATION  -> the customer still has the previous video
 *                                                 -> fail only the new request, roll back
 * ```
 *
 * The commercial rule underneath both is one sentence: **a provider or system
 * failure never consumes the customer's Unit.**
 */

import { AppError } from "@app/shared";

/** The durable work states. Closed, and enforced by a database CHECK as well. */
export type MediaFailureResolutionStatus = "PENDING" | "RUNNING" | "RESOLVED";

export const MEDIA_FAILURE_RESOLUTION_STATUSES: readonly MediaFailureResolutionStatus[] = [
  "PENDING",
  "RUNNING",
  "RESOLVED",
];

/**
 * How a piece of resolution work ended. Recorded once, on the terminal row.
 *
 * `OBSOLETE` is narrow on purpose. It means "a locked authority read proved no
 * customer mutation is required here", such as work for a validation whose
 * request has already been delivered by Transaction F. It is never a catch-all
 * for a shape nobody understood: an unexplained state is a defect, and defects
 * fail closed rather than resolving themselves quietly.
 */
export type MediaFailureResolutionKind =
  | "RECOVERY_ADMITTED"
  | "INITIAL_FAILURE_SETTLED"
  | "USER_REGENERATION_ROLLED_BACK"
  | "OBSOLETE";

export const MEDIA_FAILURE_RESOLUTION_KINDS: readonly MediaFailureResolutionKind[] = [
  "RECOVERY_ADMITTED",
  "INITIAL_FAILURE_SETTLED",
  "USER_REGENERATION_ROLLED_BACK",
  "OBSOLETE",
];

/**
 * How long a claim owns its work before another worker may take it.
 *
 * Crash recovery, not a deadline. It says how long the system waits before
 * assuming the owner died — the same meaning the media-validation lease carries,
 * and deliberately the same default, because two lease vocabularies that differ
 * by a minute are two things to remember instead of one.
 */
export const DEFAULT_MEDIA_FAILURE_RESOLUTION_LEASE_MS = 5 * 60 * 1000;

/** The longest lease a caller may ask for. An hour of assumed-dead is already generous. */
export const MAX_MEDIA_FAILURE_RESOLUTION_LEASE_MS = 60 * 60 * 1000;

export function validateMediaFailureResolutionLeaseMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEDIA_FAILURE_RESOLUTION_LEASE_MS
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A media-failure resolution lease must be an integer between 1 and ${MAX_MEDIA_FAILURE_RESOLUTION_LEASE_MS} milliseconds`,
    );
  }
  return value;
}

/**
 * How long a deferred candidate stays invisible.
 *
 * A *work* retry delay, not a provider retry delay: nothing is called while the
 * row waits. It is what turns "this candidate cannot be planned right now" into
 * "this candidate is not a candidate right now", which is what stops a prefix of
 * unplannable rows from owning every bounded sweep.
 */
export const MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS = 5 * 60 * 1000;

export const MAX_MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS = 60 * 60 * 1000;

export function validateMediaFailureResolutionRetryDelayMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A media-failure resolution retry delay must be an integer between 1 and ${MAX_MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS} milliseconds`,
    );
  }
  return value;
}

/** The largest resolution batch one pass may claim. Frozen, matching the other sweeps. */
export const MAX_MEDIA_FAILURE_RESOLUTION_BATCH_SIZE = 100;

export function validateMediaFailureResolutionBatchLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEDIA_FAILURE_RESOLUTION_BATCH_SIZE
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Media failure resolution batch limit must be an integer between 1 and ${MAX_MEDIA_FAILURE_RESOLUTION_BATCH_SIZE}`,
    );
  }
  return value;
}

/**
 * What one settlement transaction concluded.
 *
 * `ALREADY_SETTLED` requires the **exact** already-settled shape, every row of
 * it. A partial match is `SETTLEMENT_STATE_DEFECT`, never a repair: a half
 * applied settlement means an invariant this application believes it cannot
 * violate was violated, and quietly finishing the job would destroy the evidence
 * of how.
 */
export type SettleExhaustedMediaFailureOutcome =
  | {
      readonly kind: "SETTLED";
      readonly resolutionKind: Extract<
        MediaFailureResolutionKind,
        "INITIAL_FAILURE_SETTLED" | "USER_REGENERATION_ROLLED_BACK"
      >;
      /** The one instant every row in the settlement recorded. */
      readonly settledAt: number;
    }
  | { readonly kind: "ALREADY_SETTLED"; readonly resolutionKind: MediaFailureResolutionKind }
  /** The durable facts do not authorize settlement. Ordinary, not an error. */
  | { readonly kind: "NOT_EXHAUSTED" }
  /** Nothing visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

/**
 * Internal consistency violations reachable from settlement.
 *
 * Every one is a state the application believes it cannot produce. None is
 * customer input, none carries external text, and none is repaired in place.
 */
export type MediaFailureSettlementDefectCode =
  /** Some of the settlement landed and some did not. Never repaired silently. */
  | "PARTIAL_SETTLEMENT"
  /** The failure verdict is bound to different bytes than the source attempt's. */
  | "SOURCE_RECEIPT_BINDING_CONFLICT"
  /** The named validation does not belong to the named source attempt. */
  | "SOURCE_VALIDATION_MISBOUND"
  /** The Scene's delivered pointer does not name a delivered request of that Scene. */
  | "DELIVERED_PREDECESSOR_MISBOUND"
  /** Another Scene of this Job is mid-revision, so a rollback target is ambiguous. */
  | "CONCURRENT_REVISION_AMBIGUOUS"
  /** A row moved under its own lock, which cannot happen. */
  | "SETTLEMENT_LOST_UNDER_LOCK";

const SETTLEMENT_DEFECT_MESSAGES: Record<MediaFailureSettlementDefectCode, string> = {
  PARTIAL_SETTLEMENT:
    "A media failure settlement is partially applied and will not be repaired automatically",
  SOURCE_RECEIPT_BINDING_CONFLICT:
    "A media failure verdict is bound to different bytes than its attempt's verified receipt",
  SOURCE_VALIDATION_MISBOUND: "A media validation does not belong to the attempt it was read for",
  DELIVERED_PREDECESSOR_MISBOUND:
    "A scene's delivered pointer does not name a delivered request of that scene",
  CONCURRENT_REVISION_AMBIGUOUS:
    "A job holds more than one revision in flight, so a rollback target cannot be determined",
  SETTLEMENT_LOST_UNDER_LOCK: "A settlement write matched no row while holding that row's lock",
};

export class MediaFailureSettlementDefect extends Error {
  readonly code: MediaFailureSettlementDefectCode;

  constructor(code: MediaFailureSettlementDefectCode) {
    super(SETTLEMENT_DEFECT_MESSAGES[code]);
    this.name = "MediaFailureSettlementDefect";
    this.code = code;
  }
}

/**
 * The reason codes a settlement records on its transition events.
 *
 * Fixed application strings. No probe output, no provider body, no prompt, no
 * storage key, no URL.
 */
export const INITIAL_MEDIA_FAILURE_SETTLED_REASON = "MEDIA_FAILURE_INITIAL_SETTLED";
export const USER_REGENERATION_ROLLED_BACK_REASON = "MEDIA_FAILURE_REGENERATION_ROLLED_BACK";

/** The event types the two settlements and the revision start append. */
export const MEDIA_FAILURE_SETTLED_EVENT_TYPE = "request.media_failure_settled";
export const USER_REGENERATION_STARTED_EVENT_TYPE = "request.user_regeneration_started";
