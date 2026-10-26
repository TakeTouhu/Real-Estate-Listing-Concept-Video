/**
 * Settling a deliverable cycle that ended without a usable video (ADR-0082).
 *
 * A composition recorded `BLOCKED`, or a final verdict recorded `INVALID_MEDIA`
 * or `INTEGRITY_MISMATCH`, means no technically valid video will come out of
 * that cycle. ADR-0052 Decision 19 then requires the job to settle at once:
 *
 * - **Initial generation** (the job has never delivered anything): the job
 *   fails, and the Unit its reservation holds is **released**. The customer
 *   consumes nothing.
 * - **Replacement** (the job already delivered a video, and this cycle was
 *   making its successor): the job returns to `DELIVERABLE_READY` and the
 *   customer keeps the video they had. Its reservation was consumed by that
 *   earlier delivery and stays consumed: this model holds no separate Unit for a
 *   replacement cycle, so there is nothing more to release.
 *
 * The failure class never enters the decision. A block and both verdicts settle
 * through this one function, so they cannot come to bill differently
 * (Decision 19, "failure class must not change the bill").
 *
 * Pure: the persistence layer reads the locked rows, asks this module what they
 * settle into, and writes that.
 */

import type { GenerationJobState, GenerationReservationState } from "../orchestration/types";

/** The job states a failed deliverable cycle can be found in, one per failure point. */
export type FailedDeliverableCycleState = "COMPOSING" | "DELIVERABLE_VALIDATING";

/** What a failed deliverable cycle settles into. */
export type DeliverableFailureSettlement =
  /** Initial generation: fail the job, release the Unit from the state it is in. */
  | {
      readonly kind: "RELEASE";
      readonly jobState: "FAILED_TERMINAL";
      readonly releaseFrom: "RESERVED" | "RECONCILIATION_HOLD";
    }
  /** Replacement: give the customer back the video they already hold. */
  | { readonly kind: "ROLL_BACK"; readonly jobState: "DELIVERABLE_READY" };

export interface DeliverableFailureSettlementInput {
  /** The job's deliverable pointer, read under the job lock. */
  readonly currentDeliverableVersionId: string | null;
  /** The job's reservation, read under its lock. `null` when the job has none. */
  readonly reservationState: GenerationReservationState | null;
}

/**
 * Decide how a failed deliverable cycle settles.
 *
 * @throws DeliverableSettlementDefect `RESERVATION_NOT_SETTLEABLE` when the
 *   reservation contradicts the job: an initial generation whose Unit is not
 *   held (absent, already consumed or already released), or a replacement whose
 *   earlier delivery was never paid for. Neither can be settled honestly, so
 *   nothing is written.
 */
export function settleFailedDeliverable(
  input: DeliverableFailureSettlementInput,
): DeliverableFailureSettlement {
  if (input.currentDeliverableVersionId === null) {
    if (
      input.reservationState === "RESERVED" ||
      input.reservationState === "RECONCILIATION_HOLD"
    ) {
      return { kind: "RELEASE", jobState: "FAILED_TERMINAL", releaseFrom: input.reservationState };
    }
    throw new DeliverableSettlementDefect("RESERVATION_NOT_SETTLEABLE");
  }
  if (input.reservationState === "CONSUMED") {
    return { kind: "ROLL_BACK", jobState: "DELIVERABLE_READY" };
  }
  throw new DeliverableSettlementDefect("RESERVATION_NOT_SETTLEABLE");
}

export interface DeliverableFailureSettledInput {
  /** The state the job was in when this cycle failed. */
  readonly failedIn: FailedDeliverableCycleState;
  readonly jobState: GenerationJobState;
  readonly currentDeliverableVersionId: string | null;
  readonly reservationState: GenerationReservationState | null;
  /** Whether the failed version is still the job's newest one. */
  readonly failedVersionIsNewest: boolean;
}

/**
 * Whether a failed cycle's settlement is durable, for a replay of its terminal
 * row.
 *
 * A replay that finds the terminal row without its settlement has found a row
 * written before ADR-0082, or one altered by hand. It is refused rather than
 * settled late: the commit that wrote the row is the only one that may settle
 * it, so a settlement can never be applied twice.
 *
 * - An initial generation is settled once its job is `FAILED_TERMINAL` and its
 *   Unit `RELEASED`. Neither has any way back.
 * - A replacement is settled once the job no longer sits in this cycle's state
 *   with this version as its newest, and its Unit is still `CONSUMED`: the
 *   rollback never touches it. The job may have gone on to a later revision
 *   since, which is why its present state is not asked to be
 *   `DELIVERABLE_READY`.
 */
export function isDeliverableFailureSettled(input: DeliverableFailureSettledInput): boolean {
  if (input.currentDeliverableVersionId === null) {
    return input.jobState === "FAILED_TERMINAL" && input.reservationState === "RELEASED";
  }
  return (
    input.reservationState === "CONSUMED" &&
    !(input.failedVersionIsNewest && input.jobState === input.failedIn)
  );
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export type DeliverableSettlementDefectCode =
  /** The reservation contradicts the job; see {@link settleFailedDeliverable}. */
  | "RESERVATION_NOT_SETTLEABLE"
  /** A replay found the terminal row without the settlement its commit makes. */
  | "SETTLEMENT_INCOMPLETE"
  /** A settlement write matched no row while this transaction held its lock. */
  | "SETTLEMENT_LOST_UNDER_LOCK";

const DEFECT_MESSAGES: Record<DeliverableSettlementDefectCode, string> = {
  RESERVATION_NOT_SETTLEABLE:
    "A failed deliverable's reservation is not in a state its job can settle",
  SETTLEMENT_INCOMPLETE: "A failed deliverable's terminal record exists without its settlement",
  SETTLEMENT_LOST_UNDER_LOCK:
    "A failed deliverable's settlement write matched no row while holding that row's lock",
};

export class DeliverableSettlementDefect extends Error {
  readonly code: DeliverableSettlementDefectCode;

  constructor(code: DeliverableSettlementDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "DeliverableSettlementDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const JOB_DELIVERABLE_FAILED_EVENT_TYPE = "job.deliverable_failed";
export const JOB_DELIVERABLE_ROLLED_BACK_EVENT_TYPE = "job.deliverable_rolled_back";
export const RESERVATION_RELEASED_EVENT_TYPE = "reservation.released";

/** The reason code recorded on every settlement transition. */
export const DELIVERABLE_SETTLEMENT_REASON_CODE = "DELIVERABLE_FAILURE_SETTLEMENT";
