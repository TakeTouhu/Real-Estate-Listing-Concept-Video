/**
 * Bounded automatic media-failure recovery — the policy, in one place.
 *
 * Phase 6A consumes a `VALID` media verdict and delivers a Scene. This module
 * owns the opposite operational path: a durable *terminal media failure* —
 * `INVALID_MEDIA` or `INTEGRITY_MISMATCH` — may cause the platform to admit one
 * bounded, automatic `SYSTEM_RECOVERY` provider attempt under the **same**
 * `SceneGenerationRequest`.
 *
 * ## Platform failure, not customer regeneration
 *
 * The customer asked once. The bytes the provider returned were not a usable
 * video, which is the platform's problem, so no new `SceneGenerationRequest` is
 * created, no `userRegenerationOrdinal` moves, and the customer's regeneration
 * entitlement is untouched. The business identity stays:
 *
 * ```text
 * one SceneGenerationRequest
 *   -> PRIMARY attempt
 *   -> at most one automatic media-failure SYSTEM_RECOVERY attempt
 * ```
 *
 * ## The cap is a circuit breaker, and it is specific
 *
 * Without a cap the shape is:
 *
 * ```text
 * output -> invalid -> recovery -> invalid -> recovery -> ...
 * ```
 *
 * Once paid provider execution is enabled that is an automatic spending loop
 * with no human in it. One automatic retry is authorized; if that recovery also
 * ends in a terminal media failure, no second automatic attempt is created.
 *
 * The cap is deliberately **not** a global limit on `SYSTEM_RECOVERY`. Explicit
 * recovery policies elsewhere may still admit later recovery attempts once an
 * earlier attempt has finished — that capability is unchanged and separately
 * tested. This constant governs exactly one actor: the automatic media-failure
 * runner.
 */

import { AppError } from "@app/shared";

/**
 * How many automatic media-failure recoveries one request may ever receive.
 *
 * One. Not a tunable: a deployment that wants more is asking to spend more of a
 * customer's money without anyone deciding to, and that is a product decision
 * with a review, not a configuration value.
 */
export const MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST = 1;

/**
 * Whether the automatic policy may admit another recovery for this request.
 *
 * Counts **every** existing `SYSTEM_RECOVERY` attempt under the request, not
 * only ones this actor created. The count is deliberately conservative: there
 * is no durable marker saying which actor admitted a given recovery, and
 * guessing wrong in the permissive direction is what produces a spending loop.
 * Being wrong in the refusing direction costs one refused automatic retry that
 * an operator can still handle deliberately.
 */
export function automaticMediaRecoveryAllowed(systemRecoveryAttemptCount: number): boolean {
  return systemRecoveryAttemptCount < MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST;
}

/** The two durable terminal media verdicts this phase acts on. */
export type MediaFailureKind = "INVALID_MEDIA" | "INTEGRITY_MISMATCH";

export const MEDIA_FAILURE_KINDS: readonly MediaFailureKind[] = [
  "INVALID_MEDIA",
  "INTEGRITY_MISMATCH",
];

export function isMediaFailureKind(value: string): value is MediaFailureKind {
  return (MEDIA_FAILURE_KINDS as readonly string[]).includes(value);
}

/** What one automatic recovery admission attempt concluded. Application-owned. */
export type AutomaticMediaRecoveryOutcome =
  | {
      readonly kind: "ADMITTED";
      readonly attemptId: string;
      readonly attemptOrdinal: number;
    }
  /**
   * A newer `SYSTEM_RECOVERY` attempt already exists for this request and this
   * source failure is therefore already answered. Idempotent: nothing is
   * written, no second pricing snapshot, no duplicate event.
   */
  | { readonly kind: "ALREADY_RECOVERED" }
  /**
   * The one automatic retry has been spent and the *current* failure is the
   * recovery's own. An operational outcome only — nothing is terminalized here.
   */
  | { readonly kind: "RECOVERY_LIMIT_REACHED" }
  /** The durable facts do not admit recovery. Ordinary, not an error. */
  | { readonly kind: "NOT_ELIGIBLE" }
  /** No such validation, attempt or request visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

/**
 * Internal consistency violations. Every one is a state the application
 * believes it cannot produce; none is customer input and none carries external
 * text.
 */
export type AutomaticMediaRecoveryDefectCode =
  /** The failure verdict is bound to different bytes than the source attempt's. */
  | "SOURCE_RECEIPT_BINDING_CONFLICT"
  /** The named validation does not belong to the named source attempt. */
  | "SOURCE_VALIDATION_MISBOUND"
  /** The supplied fresh pricing plan does not describe the source attempt's route. */
  | "RECOVERY_ROUTE_MISMATCH"
  /** The supplied FX snapshot does not match the pricing snapshot it was planned with. */
  | "RECOVERY_FX_BINDING_CONFLICT";

const DEFECT_MESSAGES: Record<AutomaticMediaRecoveryDefectCode, string> = {
  SOURCE_RECEIPT_BINDING_CONFLICT:
    "A media failure verdict is bound to different bytes than its attempt's verified receipt",
  SOURCE_VALIDATION_MISBOUND: "A media validation does not belong to the attempt it was read for",
  RECOVERY_ROUTE_MISMATCH: "A recovery pricing plan does not describe the source attempt's route",
  RECOVERY_FX_BINDING_CONFLICT:
    "A recovery pricing plan and its exchange rate disagree with each other",
};

export class AutomaticMediaRecoveryDefect extends Error {
  readonly code: AutomaticMediaRecoveryDefectCode;

  constructor(code: AutomaticMediaRecoveryDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "AutomaticMediaRecoveryDefect";
    this.code = code;
  }
}

/**
 * Why a candidate could not be planned. Closed, application-owned, no external
 * text.
 *
 * The runtime list lives beside the type because the runner *parses* a planner
 * result rather than trusting it: a structural type is a promise about a
 * compiled call site, not about what a value actually is at runtime.
 */
export type RecoveryPlanRefusalCode =
  /** The persisted pricing identity is not a complete, well-formed identity. */
  | "PERSISTED_PRICING_IDENTITY_MALFORMED"
  /** Today's model catalog no longer delivers this exact route. */
  | "NO_SAFE_CURRENT_ROUTE"
  /** No currently eligible contract, or no usable FX rate, for this route. */
  | "NO_SAFE_CURRENT_PRICING"
  /** More than one current contract matches this route; choosing one would be a guess. */
  | "AMBIGUOUS_CURRENT_PRICING";

export const RECOVERY_PLAN_REFUSAL_CODES: readonly RecoveryPlanRefusalCode[] = [
  "PERSISTED_PRICING_IDENTITY_MALFORMED",
  "NO_SAFE_CURRENT_ROUTE",
  "NO_SAFE_CURRENT_PRICING",
  "AMBIGUOUS_CURRENT_PRICING",
];

export function isRecoveryPlanRefusalCode(value: unknown): value is RecoveryPlanRefusalCode {
  return (
    typeof value === "string" &&
    (RECOVERY_PLAN_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/**
 * The one message a planning failure ever produces.
 *
 * Fixed text, no cause, no details. A planner reaches a pricing catalog, a
 * model catalog and an FX source — every one of which is a place a credential,
 * a vendor URL or a raw response body can appear in an exception. Attaching the
 * original as `cause` puts all of that one `JSON.stringify` away from a log.
 */
export const MEDIA_RECOVERY_PLANNING_FAILED_MESSAGE =
  "Automatic media recovery planning failed";

/** The largest recovery batch one pass may claim. Frozen, matching the other sweeps. */
export const MAX_MEDIA_RECOVERY_BATCH_SIZE = 100;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Not clamping: silently substituting 100 for 5000 lets a caller believe it
 * swept far more than it did.
 */
export function validateMediaRecoveryBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MEDIA_RECOVERY_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Media recovery batch limit must be an integer between 1 and ${MAX_MEDIA_RECOVERY_BATCH_SIZE}`,
    );
  }
  return value;
}

/**
 * The reason codes an admitted recovery records.
 *
 * Distinct per failure kind, because "the file was not a usable video" and "the
 * bytes at the key were not the bytes we verified" are different incidents that
 * an operator triages differently. Fixed application strings: no probe output,
 * no `invalidReason` object, no provider body, no prompt, no URL, no key.
 */
export const MEDIA_INVALID_SYSTEM_RECOVERY_REASON = "MEDIA_INVALID_SYSTEM_RECOVERY";
export const MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON =
  "MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY";

export function mediaRecoveryReasonCode(kind: MediaFailureKind): string {
  return kind === "INVALID_MEDIA"
    ? MEDIA_INVALID_SYSTEM_RECOVERY_REASON
    : MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON;
}

/** The event type an admitted automatic recovery appends. */
export const MEDIA_RECOVERY_ADMITTED_EVENT_TYPE = "attempt.media_recovery_admitted";
