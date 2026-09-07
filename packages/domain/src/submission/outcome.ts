import { deepFreeze } from "@app/shared";
import type { EpochMillis } from "../pricing/units";
import type { GenerationAttemptState, SubmissionCertainty } from "../orchestration/types";
import { isWellFormedObservation, type ProviderSubmissionObservation } from "./observation";
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
   * `null` only for a row that never crossed. Every deadline in this phase is
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
  readonly normalizedErrorCode: string | null;
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
  /** Same certainty, different terminal state — retryable versus terminal. */
  | "TERMINAL_STATE_MISMATCH";

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

/** The row an observation would produce, before any comparison. */
function writeFor(
  observation: ProviderSubmissionObservation,
  boundaryEnteredAt: EpochMillis,
  policy: ReconciliationPolicy,
): SubmissionOutcomeWrite {
  switch (observation.kind) {
    case "ACCEPTED":
      return {
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: observation.providerPredictionId,
        providerAcceptedAt: observation.providerAcceptedAt,
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
        // Both anchored to the boundary, not to now. See the window module: it
        // is what makes two entry paths agree and replay exact.
        reconciliationStartedAt: boundaryEnteredAt,
        reconciliationDeadlineAt: reconciliationDeadlineFor(boundaryEnteredAt, policy),
        normalizedErrorCode: observation.normalizedErrorCode,
        // The customer's hold is suspended while nobody knows whether the
        // provider took the work.
        holdReservation: true,
      };
  }
}

/**
 * Does the row already say exactly what this observation says?
 *
 * Compared on the facts that describe *provider reality* — certainty, the
 * execution state it implies, and the provider's own reference. The normalized
 * error code is deliberately excluded: it is diagnostic text about how the
 * platform classified a failure, and two workers describing the same rejection
 * slightly differently have not disagreed about what the provider did.
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
  if (facts.orchestrationState !== write.orchestrationState) {
    // Same certainty, different state. For a rejection this is
    // retryable-versus-terminal; for an acceptance it means the attempt has
    // moved on past PROCESSING, which a replay must not drag it back from.
    return { kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" };
  }
  return { kind: "REPLAY" };
}

/**
 * Decide what to do with one observation about one attempt.
 *
 * `stale` selects the entry route. A direct observation may only be applied to
 * an attempt still at the boundary. A stale-recovery may only be applied to one
 * that has additionally sat there past its threshold — and the caller passes
 * `now` so that judgement comes from an injected clock rather than wall time
 * read somewhere in the middle of a transaction.
 */
export function decideSubmissionOutcome(input: {
  readonly facts: AttemptSubmissionFacts;
  readonly observation: ProviderSubmissionObservation;
  readonly policy: ReconciliationPolicy;
  readonly now: EpochMillis;
}): SubmissionOutcomeDecision {
  const { facts, observation, policy } = input;

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
    // Every deadline here is derived from it. A `SUBMITTING` row without one is
    // incoherent, and guessing a substitute would put an invented instant into
    // the field that bounds how long a charge stays unresolved.
    return { kind: "NOT_AT_BOUNDARY", reason: "ATTEMPT_BOUNDARY_TIMESTAMP_MISSING" };
  }

  const write = writeFor(observation, facts.submissionBoundaryEnteredAt, policy);

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
