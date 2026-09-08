import { deepFreeze } from "@app/shared";
import type { EpochMillis } from "../pricing/units";
import type { GenerationAttemptState, SubmissionCertainty } from "../orchestration/types";
import { isWellFormedObservation, type ProviderSubmissionObservation } from "./observation";
import type { SubmissionDiagnosticCode } from "./diagnostic-code";
import {
  isStaleSubmitting,
  reconciliationDeadlineFor,
  staleSubmittingBoundary,
  type ReconciliationPolicy,
} from "./reconciliation-window";

/**
 * What the durable record should say, given one observation and one row.
 *
 * Pure. No database handle, no clock, no provider — the instant arrives as a
 * value and every branch is reachable from a plain object, which is what makes
 * the rules that decide whether a paid submission is remembered testable
 * without submitting anything.
 *
 * The hard part of this phase is not writing the row. It is deciding, on the
 * second and third and fourth arrival of the same news, whether to write it
 * again. A worker that retries after a network blip, a queue that delivers
 * twice, a stale-sweeper racing the worker that was never actually stuck:
 * every one of them presents an observation about an attempt that already has
 * an outcome. Three answers are possible, and conflating any two of them loses
 * money or invents history:
 *
 * ```text
 * the record already says exactly this   → REPLAY, write nothing
 * the record says something else         → CONFLICT, write nothing, refuse
 * the record has no outcome yet          → APPLY
 * ```
 */

/** The attempt row, as much of it as the decision needs. */
export interface AttemptSubmissionFacts {
  readonly attemptId: string;
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly stateVersion: number;
  /**
   * When this attempt committed to crossing the provider boundary.
   *
   * `null` only for a row that never crossed. The reconciliation *deadline* is
   * derived from it, so an orchestrated `SUBMITTING` row without one is
   * incoherent rather than merely incomplete.
   */
  readonly submissionBoundaryEnteredAt: EpochMillis | null;
  readonly providerPredictionId: string | null;
  readonly reconciliationStartedAt: EpochMillis | null;
  readonly reconciliationDeadlineAt: EpochMillis | null;
}

/** The durable shape one observation would produce. */
export interface SubmissionOutcomeWrite {
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly providerPredictionId: string | null;
  readonly providerAcceptedAt: EpochMillis | null;
  readonly reconciliationStartedAt: EpochMillis | null;
  readonly reconciliationDeadlineAt: EpochMillis | null;
  readonly normalizedErrorCode: SubmissionDiagnosticCode | null;
  /**
   * Whether a `RESERVED` hold should move to `RECONCILIATION_HOLD` in the same
   * transaction. True only for uncertainty: an accepted or rejected submission
   * resolves the entitlement question rather than suspending it.
   */
  readonly holdReservation: boolean;
}

export type SubmissionOutcomeDecision =
  | { readonly kind: "APPLY"; readonly write: SubmissionOutcomeWrite }
  | { readonly kind: "REPLAY" }
  | {
      readonly kind: "CONFLICT";
      readonly reason: SubmissionConflictReason;
    }
  | {
      readonly kind: "NOT_AT_BOUNDARY";
      readonly reason: NotAtBoundaryReason;
    }
  | { readonly kind: "MALFORMED_OBSERVATION" };

export type SubmissionConflictReason =
  /** A different provider reference is already recorded for this attempt. */
  | "PROVIDER_REFERENCE_MISMATCH"
  /** The recorded certainty and the observed one cannot both be true. */
  | "CERTAINTY_MISMATCH"
  /** Same certainty, incompatible terminal state — retryable versus terminal. */
  | "TERMINAL_STATE_MISMATCH"
  /**
   * The certainty on file matches, but the attempt is in a state that certainty
   * cannot explain — a half-written row rather than two disagreeing observers.
   */
  | "RECORDED_STATE_INCOHERENT";

export type NotAtBoundaryReason =
  | "ATTEMPT_NEVER_ENTERED_BOUNDARY"
  | "ATTEMPT_STILL_QUEUED"
  | "ATTEMPT_ALREADY_BEYOND_SUBMISSION"
  | "ATTEMPT_BOUNDARY_TIMESTAMP_MISSING";

/**
 * States in which an outcome has already been recorded, so a new observation is
 * either a replay or a conflict — never an application.
 *
 * Written as an exhaustive map rather than a negated list so a state added to
 * the vocabulary fails to compile here instead of silently falling through into
 * "not yet submitted".
 */
const POST_SUBMISSION_STATES: Record<GenerationAttemptState, boolean> = deepFreeze({
  QUEUED: false,
  SUBMITTING: false,
  PROCESSING: true,
  PROVIDER_SUCCEEDED: true,
  OUTPUT_INGESTING: true,
  OUTPUT_VERIFIED: true,
  RECONCILIATION_PENDING: true,
  RECONCILIATION_EXHAUSTED: true,
  FAILED_RETRYABLE: true,
  FAILED_TERMINAL: true,
  CANCELLED_PRE_SUBMISSION: false,
} as const);

/**
 * The states an attempt may legitimately occupy for a given recorded certainty.
 *
 * This is the correction that matters most in this phase. Replay identity is
 * **provider reality** — what the provider did — not the landing state the first
 * application happened to write. Those are different facts, and conflating them
 * produced a false conflict on an entirely ordinary sequence:
 *
 * ```text
 * ACCEPTED lands            → PROCESSING
 * execution proceeds        → PROVIDER_SUCCEEDED → OUTPUT_INGESTING → OUTPUT_VERIFIED
 * the same ACCEPTED arrives → "state mismatch", refused
 * ```
 *
 * Nothing about that second observation disagrees with the record. The provider
 * accepted the work, named it, and still has; the execution lifecycle simply
 * moved on afterwards, which is what it is supposed to do. Refusing there would
 * demand a human adjudicate a duplicate delivery of unchanged news.
 *
 * So a replay checks that the recorded certainty matches, that the provider
 * reference matches, and that the attempt is somewhere that certainty can
 * explain — never that it is still where it first landed.
 *
 * The map is exhaustive over both axes for the same reason as
 * `POST_SUBMISSION_STATES`: a new state or certainty must be placed
 * deliberately rather than inheriting a default.
 */
const STATES_COMPATIBLE_WITH_CERTAINTY: Record<
  SubmissionCertainty,
  Record<GenerationAttemptState, boolean>
> = deepFreeze({
  PRE_SUBMISSION: {
    QUEUED: true,
    SUBMITTING: true,
    CANCELLED_PRE_SUBMISSION: true,
    PROCESSING: false,
    PROVIDER_SUCCEEDED: false,
    OUTPUT_INGESTING: false,
    OUTPUT_VERIFIED: false,
    RECONCILIATION_PENDING: false,
    RECONCILIATION_EXHAUSTED: false,
    FAILED_RETRYABLE: false,
    FAILED_TERMINAL: false,
  },
  /**
   * Acceptance is durable, and everything downstream of it is a *later* fact
   * about execution rather than a revision of the acceptance. A failure state is
   * reachable too: an accepted generation can still fail while running, and that
   * does not un-accept it.
   */
  ACCEPTED: {
    PROCESSING: true,
    PROVIDER_SUCCEEDED: true,
    OUTPUT_INGESTING: true,
    OUTPUT_VERIFIED: true,
    FAILED_RETRYABLE: true,
    FAILED_TERMINAL: true,
    QUEUED: false,
    SUBMITTING: false,
    CANCELLED_PRE_SUBMISSION: false,
    RECONCILIATION_PENDING: false,
    RECONCILIATION_EXHAUSTED: false,
  },
  DEFINITIVELY_REJECTED: {
    FAILED_RETRYABLE: true,
    FAILED_TERMINAL: true,
    QUEUED: false,
    SUBMITTING: false,
    CANCELLED_PRE_SUBMISSION: false,
    PROCESSING: false,
    PROVIDER_SUCCEEDED: false,
    OUTPUT_INGESTING: false,
    OUTPUT_VERIFIED: false,
    RECONCILIATION_PENDING: false,
    RECONCILIATION_EXHAUSTED: false,
  },
  /**
   * `RECONCILIATION_EXHAUSTED` means the window closed while provider reality
   * was still unknown. It is a later fact about how long nobody found out — it
   * does not turn the original observation into conflicting history, and a
   * replay must never drag the row back to `RECONCILIATION_PENDING`.
   */
  SUBMISSION_UNKNOWN: {
    RECONCILIATION_PENDING: true,
    RECONCILIATION_EXHAUSTED: true,
    QUEUED: false,
    SUBMITTING: false,
    CANCELLED_PRE_SUBMISSION: false,
    PROCESSING: false,
    PROVIDER_SUCCEEDED: false,
    OUTPUT_INGESTING: false,
    OUTPUT_VERIFIED: false,
    FAILED_RETRYABLE: false,
    FAILED_TERMINAL: false,
  },
} as const);

/**
 * Is this attempt in a state the recorded certainty can account for?
 *
 * Exported so Phase 4C-3B-2G-2's reconciliation replay asks the same question
 * rather than copying the map. Two copies of a compatibility table drift the
 * first time a state is added, and the drift shows up as a false conflict on a
 * duplicate delivery — the exact defect this table was introduced to fix.
 */
export function isStateCompatibleWithCertainty(
  certainty: SubmissionCertainty,
  state: GenerationAttemptState,
): boolean {
  return STATES_COMPATIBLE_WITH_CERTAINTY[certainty][state];
}

/**
 * Everything the decision needs that is not on the attempt row.
 *
 * `now` is the single instant read from the injected clock after the lock was
 * taken. Two fields are stamped from it — the acceptance instant and the moment
 * uncertainty first became durable — and they must be the *same* instant, so it
 * arrives once rather than being read per field.
 */
export interface SubmissionDecisionContext {
  readonly policy: ReconciliationPolicy;
  readonly now: EpochMillis;
}

/** The row an observation would produce, before any comparison. */
function writeFor(
  observation: ProviderSubmissionObservation,
  boundaryEnteredAt: EpochMillis,
  context: SubmissionDecisionContext,
): SubmissionOutcomeWrite {
  const { policy, now } = context;
  switch (observation.kind) {
    case "ACCEPTED":
      return {
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: observation.providerPredictionId,
        // The moment acceptance became durable here, from the service's own
        // post-lock clock. No frozen provider contract establishes an
        // authoritative provider-side acceptance instant, and a caller-supplied
        // one would be an unverified claim about when money started being spent.
        providerAcceptedAt: now,
        reconciliationStartedAt: null,
        reconciliationDeadlineAt: null,
        normalizedErrorCode: null,
        holdReservation: false,
      };
    case "DEFINITIVELY_REJECTED":
      return {
        // Both are definitive rejections. The flag decides only whether a new
        // attempt row may be admitted for the same request.
        orchestrationState: observation.retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
        submissionCertainty: "DEFINITIVELY_REJECTED",
        providerPredictionId: null,
        providerAcceptedAt: null,
        reconciliationStartedAt: null,
        reconciliationDeadlineAt: null,
        normalizedErrorCode: observation.normalizedErrorCode,
        holdReservation: false,
      };
    case "SUBMISSION_UNKNOWN":
      return {
        orchestrationState: "RECONCILIATION_PENDING",
        submissionCertainty: "SUBMISSION_UNKNOWN",
        providerPredictionId: null,
        providerAcceptedAt: null,
        // When the system first durably concluded it did not know. For a stale
        // attempt this is hours after the boundary, and saying otherwise would
        // backdate operational history.
        reconciliationStartedAt: now,
        // The deadline is a different fact and stays boundary-derived, so no
        // route can grant itself a longer window by looking later. A delayed
        // sweeper simply inherits less remaining time.
        reconciliationDeadlineAt: reconciliationDeadlineFor(boundaryEnteredAt, policy),
        normalizedErrorCode: observation.normalizedErrorCode,
        // The customer's hold is suspended while nobody knows whether the
        // provider took the work.
        holdReservation: true,
      };
  }
}

/**
 * Does the row already record this same provider reality?
 *
 * Compared on the facts that describe what the provider did — certainty and the
 * provider's own reference — plus a check that the attempt is somewhere that
 * certainty can explain.
 *
 * Three things are deliberately **not** compared:
 *
 * - **the landing state.** See `STATES_COMPATIBLE_WITH_CERTAINTY`: an accepted
 *   attempt that has since reached `OUTPUT_VERIFIED` has not contradicted its
 *   acceptance.
 * - **`normalizedErrorCode`.** It is the platform's own classification of a
 *   failure, and two workers describing one rejection slightly differently have
 *   not disagreed about what the provider did.
 * - **the reconciliation timestamps.** They are bookkeeping about when *this
 *   process* learned something, not provider reality. Requiring a replaying
 *   worker's freshly computed `reconciliationStartedAt` to equal the stored one
 *   would make every replay after the first millisecond a conflict.
 */
function matchesRecord(
  facts: AttemptSubmissionFacts,
  write: SubmissionOutcomeWrite,
): SubmissionOutcomeDecision {
  if (facts.submissionCertainty !== write.submissionCertainty) {
    return { kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" };
  }
  if (facts.providerPredictionId !== write.providerPredictionId) {
    // Two different references for one submission means one of them names work
    // nobody ordered — and overwriting either would lose the ability to ask the
    // provider about the other.
    return { kind: "CONFLICT", reason: "PROVIDER_REFERENCE_MISMATCH" };
  }
  if (!STATES_COMPATIBLE_WITH_CERTAINTY[facts.submissionCertainty][facts.orchestrationState]) {
    // The certainty on file matches, but the row is somewhere that certainty
    // cannot account for. That is a corrupt record rather than a disagreement
    // between observers, and it is not this phase's job to repair it.
    return { kind: "CONFLICT", reason: "RECORDED_STATE_INCOHERENT" };
  }
  if (
    write.submissionCertainty === "DEFINITIVELY_REJECTED" &&
    facts.orchestrationState !== write.orchestrationState
  ) {
    // The one case where the state *is* provider reality. Both failure states
    // are compatible with a rejection in general, so the compatibility map
    // cannot separate them — but the observation's own `retryable` flag decides
    // which is correct, and two observers disagreeing about whether the same
    // request may be re-admitted have genuinely disagreed.
    return { kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" };
  }
  return { kind: "REPLAY" };
}

/**
 * Decide what to do with one observation about one attempt.
 *
 * The caller passes `now` from an injected clock read after the lock, so both
 * the staleness judgement and every instant this write stamps come from one
 * value rather than from wall time read somewhere in the middle of a
 * transaction.
 */
export function decideSubmissionOutcome(input: {
  readonly facts: AttemptSubmissionFacts;
  readonly observation: ProviderSubmissionObservation;
  readonly policy: ReconciliationPolicy;
  readonly now: EpochMillis;
}): SubmissionOutcomeDecision {
  const { facts, observation, policy, now } = input;
  const context: SubmissionDecisionContext = { policy, now };

  if (!isWellFormedObservation(observation)) {
    return { kind: "MALFORMED_OBSERVATION" };
  }

  // An attempt that never crossed has no outcome to record. Recording one would
  // manufacture a provider interaction that did not happen.
  if (facts.orchestrationState === "QUEUED") {
    return { kind: "NOT_AT_BOUNDARY", reason: "ATTEMPT_STILL_QUEUED" };
  }
  if (facts.orchestrationState === "CANCELLED_PRE_SUBMISSION") {
    return { kind: "NOT_AT_BOUNDARY", reason: "ATTEMPT_NEVER_ENTERED_BOUNDARY" };
  }
  if (facts.submissionBoundaryEnteredAt === null) {
    // The reconciliation deadline is derived from it. A `SUBMITTING` row without
    // one is incoherent, and guessing a substitute would put an invented instant
    // into the field that bounds how long a charge stays unresolved.
    return { kind: "NOT_AT_BOUNDARY", reason: "ATTEMPT_BOUNDARY_TIMESTAMP_MISSING" };
  }

  const write = writeFor(observation, facts.submissionBoundaryEnteredAt, context);

  // Already has an outcome: replay or conflict, never a second application.
  if (POST_SUBMISSION_STATES[facts.orchestrationState]) {
    return matchesRecord(facts, write);
  }

  // Still `SUBMITTING`. Certainty must still be pre-submission; anything else on
  // a SUBMITTING row is a half-written outcome rather than a fresh boundary.
  if (facts.submissionCertainty !== "PRE_SUBMISSION") {
    return { kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" };
  }
  return { kind: "APPLY", write };
}

/** The stale-recovery guard, kept separate so its threshold is testable alone. */
export function isRecoverableStaleSubmitting(input: {
  readonly facts: AttemptSubmissionFacts;
  readonly policy: ReconciliationPolicy;
  readonly now: EpochMillis;
}): { readonly stale: true } | { readonly stale: false; readonly staleAt: EpochMillis | null } {
  const { facts, policy, now } = input;
  if (facts.submissionBoundaryEnteredAt === null) return { stale: false, staleAt: null };
  const staleAt = staleSubmittingBoundary(facts.submissionBoundaryEnteredAt, policy);
  return isStaleSubmitting({
    submissionBoundaryEnteredAt: facts.submissionBoundaryEnteredAt,
    now,
    policy,
  })
    ? { stale: true }
    : { stale: false, staleAt };
}
