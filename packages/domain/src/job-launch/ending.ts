/**
 * Ending a waiting job that can never launch (GS-7d-1, ADR-0099).
 *
 * A started job waits `RESERVED`, its Units held, until its organization has a
 * place (ADR-0095). One whose own data makes it impossible would wait forever:
 * its Property was deleted, a frozen fact the planner refuses before any
 * catalog (ADR-0094), or rows not as the start wrote them. Its Units would stay
 * held, against ADR-0052 Decision 19, and since the launch is oldest first it
 * would also hold back its organization's later jobs.
 *
 * Such a job fails and its Units are released, in one commit. A job refused
 * for VTaVision's own configuration or for timing (no route, no price, no
 * rate) is not ended here: it can launch once that is fixed.
 *
 * The cause is decided from the rows the ending locked, never taken from the
 * caller, so a job is ended only for what its rows say at the commit.
 *
 * Pure: the persistence layer reads, this decides, the persistence layer
 * writes what it answers.
 */

import { scenesOfStartShape, type JobLaunchLockedRows } from "./launch";
import { checkFrozenFacts, type FrozenFactsCode } from "./planner";

/** Why a waiting job can never launch. Closed and application-owned. */
export type UnlaunchableJobCause =
  /**
   * Its Property was deleted. Its photos await deletion and nothing is sent
   * from them (ADR-0088), and the product owner decided on 2026-10-29 that
   * such a job ends at once and its Units come back.
   */
  | "PROPERTY_DELETED"
  /** A frozen fact the planner refuses before any catalog. */
  | FrozenFactsCode
  /** Its scenes or their requests are not as the start wrote them. */
  | "SHAPE_CONFLICT";

/** Why a job is not ended. Nothing was written. */
export type UnlaunchableJobEndingRefusal =
  /** The job is not waiting: launched, ended, of another organization, or none. */
  | "NOT_WAITING"
  /** Its reservation is not `RESERVED`: there is no hold this commit may release. */
  | "RESERVATION_NOT_HELD"
  /**
   * A request of the job has an attempt. An attempt may be at the provider,
   * and a hold is released only for a job nothing of which was ever admitted.
   */
  | "ATTEMPT_ADMITTED"
  /** Nothing in the job's own rows stops it launching. */
  | "LAUNCHABLE";

export type UnlaunchableJobEnding =
  | { readonly kind: "END"; readonly cause: UnlaunchableJobCause }
  | { readonly kind: "KEEP"; readonly reason: UnlaunchableJobEndingRefusal };

const keep = (reason: UnlaunchableJobEndingRefusal): UnlaunchableJobEnding => ({ kind: "KEEP", reason });

/**
 * Decide whether a waiting job ends, from the rows the ending locked.
 *
 * The reservation and the attempts are checked before any cause, so a hold
 * that is not `RESERVED`, or a job that may have reached the provider, is
 * never released whatever else is true of it.
 */
export function decideUnlaunchableJobEnding(locked: JobLaunchLockedRows): UnlaunchableJobEnding {
  if (locked.jobState !== "RESERVED") return keep("NOT_WAITING");
  if (locked.reservationState !== "RESERVED") return keep("RESERVATION_NOT_HELD");
  if (locked.scenes.some((scene) => scene.requests.some((request) => request.attempts !== 0))) {
    return keep("ATTEMPT_ADMITTED");
  }

  if (locked.propertyDeleted) return { kind: "END", cause: "PROPERTY_DELETED" };
  const frozen = checkFrozenFacts({ targetOutputResolution: locked.targetOutputResolution, scenes: locked.scenes });
  if (!frozen.ok) return { kind: "END", cause: frozen.code };
  if (!scenesOfStartShape(locked.scenes)) return { kind: "END", cause: "SHAPE_CONFLICT" };
  return keep("LAUNCHABLE");
}

/** Fixed application-owned event type: the job's `RESERVED → FAILED_TERMINAL`. */
export const JOB_ENDED_UNLAUNCHABLE_EVENT_TYPE = "job.ended_unlaunchable";
