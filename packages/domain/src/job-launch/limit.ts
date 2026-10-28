import { AppError, deepFreeze } from "@app/shared";
import type { GenerationJobState } from "../orchestration/types";

/**
 * The concurrent-job limit (GS-7a, ADR-0094): which jobs hold one of their
 * organization's places, and whether a waiting job may take one.
 *
 * ADR-0052 Decision 7 limits how many customer video Jobs an organization runs
 * at once, 1 / 3 / 5 by plan (`CustomerPlan.concurrentJobs`). It counts jobs,
 * not the provider requests inside them, and a job beyond the limit waits with
 * its Units reserved rather than being refused.
 *
 * ```text
 * waiting        RESERVED                       Units held, not launched yet
 * holds a place  GENERATING … DELIVERABLE_VALIDATING, REVISING
 * neither        CREATED, RESERVING             not started yet
 *                DELIVERABLE_READY, FAILED_TERMINAL, CANCELLED   ended
 * ```
 *
 * A job holds its place from launch until it ends, composition and the final
 * check included: until then the customer is still waiting for that video. A
 * job that fails frees its place at once, though attempts it closed may still
 * be finishing at the provider: the limit counts jobs, not provider requests.
 *
 * `REVISING` holds one too, and so does a revised job back in `GENERATING`,
 * whose state cannot be told from a first generation's. Whether a regeneration
 * counts at all is not decided (`docs/decisions/TODO.md`), so this is
 * provisional; nothing runs revision start today.
 */

/** A launched job that has not ended. Each holds one of its organization's places. */
export const JOB_STATES_HOLDING_A_PLACE: readonly GenerationJobState[] = deepFreeze([
  "GENERATING",
  "SCENES_READY",
  "COMPOSITION_PENDING",
  "COMPOSING",
  "DELIVERABLE_VALIDATING",
  "REVISING",
] as const);

/** The one state a job waits for a place in: started, its Units reserved. */
export const JOB_STATE_WAITING_FOR_A_PLACE: GenerationJobState = "RESERVED";

export function holdsAPlace(state: GenerationJobState): boolean {
  return JOB_STATES_HOLDING_A_PLACE.includes(state);
}

export type JobLaunchCapacity =
  | { readonly kind: "PLACE_FREE" }
  /** Every place is taken: the waiting job stays waiting, nothing is refused. */
  | { readonly kind: "AT_LIMIT" };

/**
 * Whether one more job may launch. Pure.
 *
 * Throws on a limit below one or a count that is not a whole number: either is
 * a defect in whoever read them, and launching on it could exceed the limit.
 */
export function decideJobLaunchCapacity(input: {
  readonly concurrentJobs: number;
  readonly jobsHoldingAPlace: number;
}): JobLaunchCapacity {
  if (!Number.isSafeInteger(input.concurrentJobs) || input.concurrentJobs < 1) {
    throw new AppError("INTERNAL_ERROR", "A concurrent-job limit must be a whole number from one");
  }
  if (!Number.isSafeInteger(input.jobsHoldingAPlace) || input.jobsHoldingAPlace < 0) {
    throw new AppError("INTERNAL_ERROR", "A count of running jobs must be a whole number from zero");
  }
  return input.jobsHoldingAPlace < input.concurrentJobs ? { kind: "PLACE_FREE" } : { kind: "AT_LIMIT" };
}
