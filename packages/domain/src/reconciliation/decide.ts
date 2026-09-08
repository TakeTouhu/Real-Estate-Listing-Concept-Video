import type { EpochMillis } from "../pricing/units";
import type { GenerationAttemptState, SubmissionCertainty } from "../orchestration/types";
import { isStateCompatibleWithCertainty } from "../submission/outcome";
import {
  isWellFormedResolutionObservation,
  type ReconciliationResolutionObservation,
} from "./observation";
import { reservationActionFor, type ReservationAction } from "./entitlement";
import type { GenerationReservationState } from "../orchestration/types";

/**
 * What an uncertain attempt's record should say once its uncertainty ends.
 *
 * Pure. No database handle, no clock, no provider — the instant arrives as a
 * value, so every branch, including both sides of the deadline, is reachable
 * from a plain object.
 *
 * Three conclusions are possible and they are not symmetric. Two of them
 * *resolve* the question and stamp the moment they did so; the third admits the
 * question was never answered and deliberately stamps nothing.
 *
 * ```text
 * proven accepted   → PROCESSING + ACCEPTED,  resolvedAt = now
 * proven rejected   → FAILED_* + DEFINITIVELY_REJECTED, resolvedAt = now
 * deadline reached  → RECONCILIATION_EXHAUSTED + SUBMISSION_UNKNOWN, resolvedAt stays null
 * ```
 */

/** The attempt row, as much of it as either decision needs. */
export interface ReconcilingAttemptFacts {
  readonly attemptId: string;
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly stateVersion: number;
  readonly submissionBoundaryEnteredAt: EpochMillis | null;
  readonly providerPredictionId: string | null;
  readonly reconciliationStartedAt: EpochMillis | null;
  readonly reconciliationDeadlineAt: EpochMillis | null;
  readonly reconciliationResolvedAt: EpochMillis | null;
}

/** The durable shape one conclusion produces. */
export interface ReconciliationWrite {
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly providerPredictionId: string | null;
  readonly providerAcceptedAt: EpochMillis | null;
  /** `null` for exhaustion, and only for exhaustion. */
  readonly reconciliationResolvedAt: EpochMillis | null;
  readonly reservationAction: ReservationAction;
  /**
   * The one instant this decision was made — the single post-lock clock read.
   *
   * Every timestamp the decision produces comes from here, including the
   * reservation's `releasedAt`. Exhaustion carries it too, even though it
   * deliberately stamps no `reconciliationResolvedAt`: the release still needs a
   * time, and reaching for a second wall-clock read in the persistence layer to
   * get one would put a timestamp in the record that no lock was held for.
   */
  readonly decisionAt: EpochMillis;
}

export type ReconciliationConflictReason =
  /** A different provider reference is already recorded. */
  | "PROVIDER_REFERENCE_MISMATCH"
  /** The recorded certainty and the observed conclusion cannot both be true. */
  | "CERTAINTY_MISMATCH"
  /** Same rejection, different terminal state — retryable versus terminal. */
  | "TERMINAL_STATE_MISMATCH"
  /** The certainty on file matches but the state cannot account for it. */
  | "RECORDED_STATE_INCOHERENT";

export type NotReconcilingReason =
  | "ATTEMPT_NEVER_BECAME_UNCERTAIN"
  | "RECONCILIATION_METADATA_MISSING"
  | "PROVIDER_REFERENCE_ALREADY_PRESENT"
  /**
   * The attempt is resolved and its reconciliation history is partly written.
   *
   * Not a replay — no complete reconciliation is on file to replay. Not an
   * ordinary never-reconciled attempt either, because something *did* start one.
   * The record cannot be believed in either direction, so this fails closed
   * rather than silently repairing the missing timestamps.
   */
  | "RECONCILIATION_HISTORY_INCOHERENT";

export type ResolutionDecision =
  | { readonly kind: "APPLY"; readonly write: ReconciliationWrite }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICT"; readonly reason: ReconciliationConflictReason }
  | { readonly kind: "NOT_RECONCILING"; readonly reason: NotReconcilingReason }
  | { readonly kind: "DEADLINE_EXPIRED" }
  | { readonly kind: "RECONCILIATION_CLOSED" }
  | { readonly kind: "MALFORMED_OBSERVATION" };

export type ExhaustionDecision =
  | { readonly kind: "APPLY"; readonly write: ReconciliationWrite }
  | { readonly kind: "ALREADY_EXHAUSTED" }
  | { readonly kind: "NOT_RECONCILING"; readonly reason: NotReconcilingReason }
  | { readonly kind: "NOT_DUE"; readonly dueAt: EpochMillis };

/**
 * Is this attempt sitting in durable, unresolved uncertainty?
 *
 * Every field is required, and the combination is what Phase 2G-1 guarantees it
 * wrote. A row missing any of them is incoherent rather than merely incomplete,
 * and this phase fails closed on it rather than guessing a substitute — an
 * invented deadline would be a bound nobody agreed to.
 */
function uncertaintyPrecondition(
  facts: ReconcilingAttemptFacts,
): NotReconcilingReason | null {
  if (
    facts.orchestrationState !== "RECONCILIATION_PENDING" ||
    facts.submissionCertainty !== "SUBMISSION_UNKNOWN"
  ) {
    return "ATTEMPT_NEVER_BECAME_UNCERTAIN";
  }
  if (facts.providerPredictionId !== null) {
    // Uncertainty means nothing named the work. A reference already here is a
    // half-written record, not something to resolve on top of.
    return "PROVIDER_REFERENCE_ALREADY_PRESENT";
  }
  if (
    facts.submissionBoundaryEnteredAt === null ||
    facts.reconciliationStartedAt === null ||
    facts.reconciliationDeadlineAt === null
  ) {
    return "RECONCILIATION_METADATA_MISSING";
  }
  return null;
}

/**
 * The row a conclusive observation would produce.
 *
 * The reservation action is computed here, from the *actual* persisted
 * reservation state, so one function owns the whole answer. Deciding the intent
 * in one place and gating it on reality in another is how a `CONSUMED`
 * regeneration eventually gets restored by a caller that forgot the gate.
 */
function writeFor(
  observation: ReconciliationResolutionObservation,
  reservationState: GenerationReservationState | null,
  otherPendingUnknownAttemptsInJob: number,
  now: EpochMillis,
): ReconciliationWrite {
  switch (observation.kind) {
    case "ACCEPTED":
      return {
        orchestrationState: "PROCESSING",
        submissionCertainty: "ACCEPTED",
        providerPredictionId: observation.providerPredictionId,
        // Both from the single post-lock instant. There is no provider-supplied
        // timestamp anywhere in this phase, so "when the platform established
        // acceptance" is the only honest thing either field can mean.
        providerAcceptedAt: now,
        reconciliationResolvedAt: now,
        decisionAt: now,
        reservationAction: reservationActionFor({
          reservationState,
          conclusion: "ACCEPTED",
          otherPendingUnknownAttemptsInJob,
        }),
      };
    case "DEFINITIVELY_REJECTED":
      return {
        orchestrationState: observation.retryable ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
        submissionCertainty: "DEFINITIVELY_REJECTED",
        providerPredictionId: null,
        providerAcceptedAt: null,
        reconciliationResolvedAt: now,
        decisionAt: now,
        reservationAction: reservationActionFor({
          reservationState,
          // Retryable restores the unit so a future recovery attempt can stand
          // on it; terminal releases it because this path cannot continue.
          conclusion: observation.retryable ? "REJECTED_RETRYABLE" : "REJECTED_TERMINAL",
          otherPendingUnknownAttemptsInJob,
        }),
      };
  }
}

/**
 * Did this attempt actually go through reconciliation?
 *
 * Phase 2G-1 can land an attempt on `PROCESSING + ACCEPTED` directly, from a
 * provider response observed at the submission boundary, with all three
 * reconciliation timestamps null. Such an attempt has the same *certainty* and
 * the same *provider reference* a reconciled one would have — so provider-reality
 * comparison alone would call it a replay of a reconciliation that never
 * happened, and report success for an operation that was never performed.
 *
 * ```text
 * all three null      → never reconciled; this resolver has no business here
 * all three non-null  → a real reconciliation; replay rules may apply
 * anything between    → incoherent; fail closed, repair nothing
 * ```
 */
type ReconciliationHistory = "COMPLETE" | "ABSENT" | "PARTIAL";

function reconciliationHistoryOf(facts: ReconcilingAttemptFacts): ReconciliationHistory {
  const present = [
    facts.reconciliationStartedAt,
    facts.reconciliationDeadlineAt,
    facts.reconciliationResolvedAt,
  ].filter((value) => value !== null).length;
  if (present === 3) return "COMPLETE";
  if (present === 0) return "ABSENT";
  return "PARTIAL";
}

/**
 * Does the row already record this same conclusion?
 *
 * Compared on provider reality — the certainty, the provider reference, and for
 * a rejection the terminal state its `retryable` flag chose. Not on where the
 * attempt has since travelled: an accepted attempt that has reached
 * `OUTPUT_VERIFIED` has not contradicted its acceptance, and the compatibility
 * table is Phase 2G-1's, imported rather than copied.
 *
 * `reconciliationResolvedAt` is deliberately excluded: it records when *this
 * process* concluded, and requiring a replaying caller's fresh instant to equal
 * the stored one would make every replay after the first millisecond a conflict.
 */
function matchesResolution(
  facts: ReconcilingAttemptFacts,
  write: ReconciliationWrite,
): ResolutionDecision {
  if (facts.submissionCertainty !== write.submissionCertainty) {
    return { kind: "CONFLICT", reason: "CERTAINTY_MISMATCH" };
  }
  if (facts.providerPredictionId !== write.providerPredictionId) {
    return { kind: "CONFLICT", reason: "PROVIDER_REFERENCE_MISMATCH" };
  }
  if (!isStateCompatibleWithCertainty(facts.submissionCertainty, facts.orchestrationState)) {
    return { kind: "CONFLICT", reason: "RECORDED_STATE_INCOHERENT" };
  }
  if (
    write.submissionCertainty === "DEFINITIVELY_REJECTED" &&
    facts.orchestrationState !== write.orchestrationState
  ) {
    // Here the state *is* provider reality: it encodes whether another attempt
    // may be admitted, and with it whether the customer's unit was restored or
    // released. Two observers disagreeing have disagreed about entitlement.
    return { kind: "CONFLICT", reason: "TERMINAL_STATE_MISMATCH" };
  }
  return { kind: "REPLAY" };
}

/**
 * Decide what to do with conclusive evidence about one uncertain attempt.
 *
 * The order of the checks is itself a decision. Replay and closure are settled
 * *before* the deadline is consulted, because a replay of an already-recorded
 * resolution is a true answer about the past and stays true forever — refusing
 * it as `DEADLINE_EXPIRED` a day later would make a duplicate delivery look
 * like a failure and invite a caller to retry something already done.
 */
export function decideReconciliationResolution(input: {
  readonly facts: ReconcilingAttemptFacts;
  readonly observation: ReconciliationResolutionObservation;
  readonly reservationState: GenerationReservationState | null;
  /** Counted under the same lock. Never caller-supplied. */
  readonly otherPendingUnknownAttemptsInJob: number;
  readonly now: EpochMillis;
}): ResolutionDecision {
  const { facts, observation, reservationState, otherPendingUnknownAttemptsInJob, now } = input;

  if (!isWellFormedResolutionObservation(observation)) {
    return { kind: "MALFORMED_OBSERVATION" };
  }

  // Exhausted is terminal. Late evidence does not reopen customer entitlement;
  // what it establishes about internal provider cost belongs to accounting, not
  // to resurrecting an attempt whose window the platform already closed.
  if (facts.orchestrationState === "RECONCILIATION_EXHAUSTED") {
    return { kind: "RECONCILIATION_CLOSED" };
  }

  const write = writeFor(observation, reservationState, otherPendingUnknownAttemptsInJob, now);

  // Already resolved: replay or conflict, never a second application — and
  // regardless of the deadline, which bounds acting, not remembering.
  //
  // Only a certainty that *is* a resolution qualifies. `PRE_SUBMISSION` is the
  // absence of one, and answering a caller that named an attempt still at the
  // boundary with `CERTAINTY_MISMATCH` would send an operator hunting a second
  // observer who does not exist; the precondition below tells them the truth.
  if (
    facts.submissionCertainty === "ACCEPTED" ||
    facts.submissionCertainty === "DEFINITIVELY_REJECTED"
  ) {
    // Resolved — but resolved by *whom*? A Phase 2G-1 outcome observed directly
    // at the submission boundary lands on the same certainty with the same
    // provider reference and no reconciliation history at all. Calling that a
    // reconciliation replay would report success for an operation that never
    // ran, and would hide a caller routing attempts to the wrong service.
    switch (reconciliationHistoryOf(facts)) {
      case "COMPLETE":
        return matchesResolution(facts, write);
      case "ABSENT":
        return { kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" };
      case "PARTIAL":
        return { kind: "NOT_RECONCILING", reason: "RECONCILIATION_HISTORY_INCOHERENT" };
    }
  }

  const missing = uncertaintyPrecondition(facts);
  if (missing !== null) return { kind: "NOT_RECONCILING", reason: missing };

  // Non-null by the precondition above.
  const deadline = facts.reconciliationDeadlineAt as EpochMillis;
  // At-or-after, not strictly after. The deadline is the first instant at which
  // the window is over, so equality belongs to exhaustion. The opposite reading
  // would leave one instant in which both paths believed they owned the row.
  if (now >= deadline) return { kind: "DEADLINE_EXPIRED" };

  return { kind: "APPLY", write };
}

/**
 * Decide whether an uncertain attempt's window has closed.
 *
 * The deadline is read from the row, never recomputed. Phase 2G-1 froze it from
 * the submission boundary, and re-deriving it from current configuration would
 * let an operator lengthen or shorten a bound retroactively for attempts
 * already in flight.
 */
export function decideReconciliationExhaustion(input: {
  readonly facts: ReconcilingAttemptFacts;
  readonly reservationState: GenerationReservationState | null;
  /** Counted under the same lock. Never caller-supplied. */
  readonly otherPendingUnknownAttemptsInJob: number;
  readonly now: EpochMillis;
}): ExhaustionDecision {
  const { facts, reservationState, otherPendingUnknownAttemptsInJob, now } = input;

  if (
    facts.orchestrationState === "RECONCILIATION_EXHAUSTED" &&
    facts.submissionCertainty === "SUBMISSION_UNKNOWN"
  ) {
    return { kind: "ALREADY_EXHAUSTED" };
  }

  const missing = uncertaintyPrecondition(facts);
  if (missing !== null) return { kind: "NOT_RECONCILING", reason: missing };

  const deadline = facts.reconciliationDeadlineAt as EpochMillis;
  if (now < deadline) return { kind: "NOT_DUE", dueAt: deadline };

  return {
    kind: "APPLY",
    write: {
      orchestrationState: "RECONCILIATION_EXHAUSTED",
      // Unchanged, and that is the whole meaning of this transition: the window
      // closed without the question being answered.
      submissionCertainty: "SUBMISSION_UNKNOWN",
      providerPredictionId: null,
      providerAcceptedAt: null,
      // Deliberately null. Stamping a "resolved" instant on an outcome that
      // resolved nothing would put a fabricated success into the one field an
      // auditor would read to find out when certainty was regained. When the
      // platform gave up is recorded by the transition event's own timestamp.
      reconciliationResolvedAt: null,
      // Carried even though nothing was resolved: the release still needs a
      // time, and it must be *this* instant rather than a second wall-clock
      // read taken somewhere no lock is held.
      decisionAt: now,
      reservationAction: reservationActionFor({
        reservationState,
        conclusion: "EXHAUSTED",
        otherPendingUnknownAttemptsInJob,
      }),
    },
  };
}
