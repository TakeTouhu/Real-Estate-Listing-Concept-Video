import { AppError } from "@app/shared";

/**
 * The one bound on how much a maintenance pass may look at.
 *
 * A candidate query ends in a SQL `LIMIT`. An unvalidated number reaching it is
 * not a style problem: `Infinity` or `Number.MAX_SAFE_INTEGER` turns a bounded
 * sweep into a full scan of every uncertain attempt in the installation, and a
 * fractional or `NaN` value produces a statement the driver will either reject
 * at runtime or coerce in a way nobody chose.
 *
 * One implementation, used by both the batch runner and the repository. Two
 * subtly different bound rules is how a limit that the runner rejects reaches
 * the database through a direct call.
 */

/**
 * The operational maximum, per category, per `runOnce`.
 *
 * A frozen number rather than configuration. It is a statement about how much
 * work one pass may claim before yielding, and a deployment that needs more
 * throughput should run more passes — raising this instead lengthens the time a
 * single pass holds its locks and delays every other worker behind it.
 */
export const MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE = 100;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Deliberately **not** clamping. Silently substituting 100 for 5000 would let a
 * caller believe it swept far more than it did, and silently substituting 1 for
 * 0 would turn "do nothing" into "do something". A caller that computed a
 * nonsense bound has a defect, and the useful thing to do with a defect is
 * surface it before it reaches the database.
 */
export function validateReconciliationMaintenanceLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE
  ) {
    // `Number.isSafeInteger` rejects NaN, Infinity, fractions and integers past
    // 2^53-1 in one predicate — all of which are values a SQL LIMIT must never
    // receive.
    throw new AppError(
      "VALIDATION_FAILED",
      `Reconciliation maintenance limit must be an integer between 1 and ${MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE}`,
    );
  }
  return value;
}
