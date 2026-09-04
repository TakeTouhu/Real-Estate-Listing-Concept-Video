import type { GenerationAttemptState, SubmissionCertainty } from "./types";

/**
 * What must be true of an attempt row once a provider outcome is known.
 *
 * The pairing of certainty with execution state is not free-form. Three
 * combinations are the whole contract, and the invariant that ties them
 * together is the one that keeps a fabricated provider reference out of the
 * database:
 *
 *     providerPredictionId != null  =>  certainty == ACCEPTED
 *
 * Stated in that direction on purpose. The converse is false: an accepted
 * submission whose response could not be parsed has no reference to record, and
 * inventing one so the column looks populated would put an unusable id into a
 * paid attempt's permanent record.
 */

/** The persistable shape of one provider submission outcome. */
export type AttemptOutcomePersistence =
  | {
      readonly certainty: "ACCEPTED";
      readonly state: "PROCESSING";
      readonly providerPredictionId: string;
      readonly providerAcceptedAt: Date;
    }
  | {
      readonly certainty: "DEFINITIVELY_REJECTED";
      readonly state: "FAILED_TERMINAL";
      readonly providerPredictionId: null;
    }
  | {
      readonly certainty: "SUBMISSION_UNKNOWN";
      readonly state: "RECONCILIATION_PENDING";
      readonly providerPredictionId: null;
      readonly reconciliationStartedAt: Date;
      readonly reconciliationDeadlineAt: Date;
    };

/**
 * How long the platform keeps trying to find out whether a submission landed.
 *
 * A default, not a rule scattered through the code. The window is **snapshotted
 * onto each attempt** when uncertainty begins, so changing this constant later
 * moves the deadline for new attempts and leaves every existing one exactly
 * where it was. An attempt whose deadline moves because a config value changed
 * is not an audit record.
 */
export const DEFAULT_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The deadline to freeze onto an attempt that has just become uncertain. */
export function reconciliationDeadlineFrom(
  startedAt: Date,
  windowMs: number = DEFAULT_RECONCILIATION_WINDOW_MS,
): Date {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("Reconciliation window must be a positive whole number of milliseconds");
  }
  return new Date(startedAt.getTime() + windowMs);
}

/**
 * Whether a certainty and an execution state may appear on the same row.
 *
 * Deliberately permissive about states that precede an outcome and strict about
 * the ones that follow it: before submission every attempt is `PRE_SUBMISSION`,
 * and afterwards the certainty constrains which states make sense. A
 * `DEFINITIVELY_REJECTED` attempt in `PROCESSING` would claim the provider both
 * refused the request and is working on it.
 */
export function isCoherentAttemptRecord(input: {
  readonly certainty: SubmissionCertainty;
  readonly state: GenerationAttemptState;
  readonly providerPredictionId: string | null;
}): boolean {
  if (input.providerPredictionId !== null && input.certainty !== "ACCEPTED") return false;

  switch (input.certainty) {
    case "PRE_SUBMISSION":
      // Nothing was sent. Only the states that precede or replace a submission.
      return (
        input.state === "QUEUED" ||
        input.state === "SUBMITTING" ||
        input.state === "CANCELLED_PRE_SUBMISSION" ||
        input.state === "FAILED_RETRYABLE" ||
        input.state === "FAILED_TERMINAL"
      );
    case "ACCEPTED":
      // The provider took it, so every downstream state is reachable — but not
      // the ones that mean it never got there.
      return (
        input.state !== "QUEUED" &&
        input.state !== "CANCELLED_PRE_SUBMISSION" &&
        input.state !== "SUBMITTING"
      );
    case "DEFINITIVELY_REJECTED":
      return input.state === "FAILED_TERMINAL";
    case "SUBMISSION_UNKNOWN":
      // Unknown acceptance can only be pending resolution, resolved into a
      // known execution path, or given up on.
      return (
        input.state === "RECONCILIATION_PENDING" ||
        input.state === "RECONCILIATION_EXHAUSTED" ||
        input.state === "FAILED_RETRYABLE" ||
        input.state === "FAILED_TERMINAL"
      );
  }
}

/**
 * Whether this attempt row may ever be POSTed to a provider again.
 *
 * Always `false` once the row has left `QUEUED`. There is no state in which
 * re-POSTing the same row is correct — recovery creates a new row — and this
 * function exists so a future worker asks the question rather than inferring it
 * from a state comparison that could be written the wrong way round.
 */
export function mayRePostAttempt(): false {
  return false;
}
