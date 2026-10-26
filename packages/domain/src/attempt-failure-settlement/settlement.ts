/**
 * Settling a scene whose provider attempt ended without output (ADR-0083).
 *
 * A scene request generates through attempts. An attempt can end without ever
 * producing a video: the provider refused it, the provider failed it, or nobody
 * could find out whether it reached the provider before the reconciliation
 * deadline. Once every attempt of the request has ended and the newest
 * produced nothing, no actor will create another one: the only automatic retry
 * today is the media recovery of ADR-0047, which answers a usable-looking video
 * that failed its media check, not an attempt with no video at all.
 *
 * Such a scene can never be delivered, so its job can never deliver a video.
 * ADR-0052 Decision 19 then requires the job to settle:
 *
 * - **Initial generation**: the request, the scene and the job fail, and the
 *   job's reserved Unit is **released**. The customer consumes nothing.
 * - **Scene regeneration** after delivery: the request fails, the scene returns
 *   to the rendition it already had and the job to the video the customer
 *   already holds. The job's Unit was consumed by that delivery and stays so.
 *
 * Which component gave up never enters the decision, so a provider refusal, a
 * provider failure and an unresolved submission cannot come to bill differently
 * from each other, or from a media failure (ADR-0048) or a failed deliverable
 * (ADR-0082).
 *
 * Pure: the persistence layer reads the locked rows into
 * {@link AttemptFailureFacts}, asks this module what they settle into, and
 * writes that.
 */

import { AppError } from "@app/shared";
import { isTerminalAttemptState } from "../orchestration/state-machines";
import type {
  GenerationAttemptState,
  GenerationJobState,
  GenerationReservationState,
  GenerationSceneState,
  SceneGenerationRequestKind,
  SceneGenerationRequestState,
} from "../orchestration/types";

/** The rows a settlement reads, under the locks the persistence layer took. */
export interface AttemptFailureFacts {
  readonly requestKind: SceneGenerationRequestKind;
  readonly requestState: SceneGenerationRequestState;
  readonly requestDelivered: boolean;
  /** Every attempt of the request, newest last. `null` is a row with no orchestration state. */
  readonly attemptStates: readonly (GenerationAttemptState | null)[];
  readonly sceneState: GenerationSceneState;
  /**
   * What the scene's delivered pointer names: nothing, an earlier delivered
   * request of the same scene, or anything else.
   */
  readonly sceneDelivered: "NONE" | "DELIVERED_PREDECESSOR" | "OTHER";
  readonly jobState: GenerationJobState;
  readonly jobHoldsDeliverable: boolean;
  /** `null` when the job has no reservation. */
  readonly reservationState: GenerationReservationState | null;
  /** The job's other scenes that are not `READY`. */
  readonly otherScenesNotReady: number;
  /** The job's other scene regenerations still `PENDING` or `GENERATING`. */
  readonly otherOpenRegenerations: number;
}

/** Why a request cannot be settled. Closed and application-owned. */
export type AttemptFailureRefusal =
  /** The request already ended, or never started. A settled one answers this. */
  | "REQUEST_NOT_GENERATING"
  /** An attempt is still in progress, or the newest one produced a video. */
  | "ATTEMPT_NOT_FAILED"
  /** The job is not generating scenes; a settled sibling scene answers this. */
  | "JOB_NOT_GENERATING"
  /** The scene, its pointer or the job's other scenes contradict the request's kind. */
  | "SHAPE_CONFLICT"
  /** The reservation contradicts the job: nothing it holds can be settled honestly. */
  | "RESERVATION_NOT_SETTLEABLE";

export type AttemptFailureSettlement =
  /**
   * Initial generation: fail request, scene and job. `releaseFrom` names the
   * state the Unit is released from, or `null` when reconciliation already
   * released it (ADR-0037 Decision 6) and only the job is left to settle.
   */
  | {
      readonly kind: "FAIL_INITIAL";
      readonly releaseFrom: "RESERVED" | "RECONCILIATION_HOLD" | null;
    }
  /** Scene regeneration: fail the request, give back the scene and the video. */
  | { readonly kind: "ROLL_BACK_REGENERATION" }
  | { readonly kind: "NOT_SETTLEABLE"; readonly reason: AttemptFailureRefusal };

/** Whether an attempt in this state has ended without producing a video. */
export function endedWithoutOutput(state: GenerationAttemptState): boolean {
  return isTerminalAttemptState(state) && state !== "OUTPUT_VERIFIED";
}

/**
 * Decide how a request whose attempts ended without output settles.
 *
 * The persistence layer's candidate query mirrors every condition here, so a
 * request this refuses is never offered to it again: a refusal is an answer,
 * not a retry.
 */
export function decideAttemptFailureSettlement(
  facts: AttemptFailureFacts,
): AttemptFailureSettlement {
  if (facts.requestState !== "GENERATING" || facts.requestDelivered) {
    return refuse("REQUEST_NOT_GENERATING");
  }
  const newest = facts.attemptStates.at(-1);
  if (
    newest === undefined ||
    newest === null ||
    !endedWithoutOutput(newest) ||
    facts.attemptStates.some((state) => state === null || !isTerminalAttemptState(state))
  ) {
    return refuse("ATTEMPT_NOT_FAILED");
  }
  if (facts.jobState !== "GENERATING") return refuse("JOB_NOT_GENERATING");

  if (facts.requestKind === "INITIAL") {
    if (
      facts.sceneState !== "GENERATING" ||
      facts.sceneDelivered !== "NONE" ||
      facts.jobHoldsDeliverable
    ) {
      return refuse("SHAPE_CONFLICT");
    }
    switch (facts.reservationState) {
      case "RESERVED":
      case "RECONCILIATION_HOLD":
        return { kind: "FAIL_INITIAL", releaseFrom: facts.reservationState };
      case "RELEASED":
        return { kind: "FAIL_INITIAL", releaseFrom: null };
      default:
        return refuse("RESERVATION_NOT_SETTLEABLE");
    }
  }

  // One revision at a time is the MVP constraint (ADR-0048 Decision 10), and it
  // is what makes returning to the previous video unambiguous: with another
  // scene revising, the earlier deliverable could discard its replacement.
  if (
    facts.sceneState !== "REVISING" ||
    facts.sceneDelivered !== "DELIVERED_PREDECESSOR" ||
    !facts.jobHoldsDeliverable ||
    facts.otherScenesNotReady > 0 ||
    facts.otherOpenRegenerations > 0
  ) {
    return refuse("SHAPE_CONFLICT");
  }
  if (facts.reservationState !== "CONSUMED") return refuse("RESERVATION_NOT_SETTLEABLE");
  return { kind: "ROLL_BACK_REGENERATION" };
}

function refuse(reason: AttemptFailureRefusal): AttemptFailureSettlement {
  return { kind: "NOT_SETTLEABLE", reason };
}

// ---------------------------------------------------------------------------
// Batch bound
// ---------------------------------------------------------------------------

/** The largest batch one pass may take, matching the other sweeps' bound. */
export const MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE = 100;

/** Prove a candidate-query limit is usable, or refuse. Never clamped. */
export function validateAttemptFailureSettlementBatchLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Attempt failure settlement batch limit must be an integer between 1 and ${MAX_ATTEMPT_FAILURE_SETTLEMENT_BATCH_SIZE}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export type AttemptFailureSettlementDefectCode =
  /** A settlement write matched no row while this transaction held its lock. */
  | "SETTLEMENT_LOST_UNDER_LOCK"
  /** A locked row held a state the domain does not name. */
  | "STATE_OUTSIDE_VOCABULARY";

const DEFECT_MESSAGES: Record<AttemptFailureSettlementDefectCode, string> = {
  SETTLEMENT_LOST_UNDER_LOCK:
    "A failed attempt's settlement write matched no row while holding that row's lock",
  STATE_OUTSIDE_VOCABULARY: "A failed attempt's settlement read a state outside the domain's",
};

export class AttemptFailureSettlementDefect extends Error {
  readonly code: AttemptFailureSettlementDefectCode;

  constructor(code: AttemptFailureSettlementDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "AttemptFailureSettlementDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const SCENE_REQUEST_FAILED_EVENT_TYPE = "scene_request.failed";
export const SCENE_FAILED_EVENT_TYPE = "scene.failed";
export const SCENE_REVISION_ROLLED_BACK_EVENT_TYPE = "scene.revision_rolled_back";
export const JOB_SCENE_FAILED_EVENT_TYPE = "job.scene_failed";
export const JOB_REVISION_ROLLED_BACK_EVENT_TYPE = "job.revision_rolled_back";

/** The reason code recorded on every settlement transition. */
export const ATTEMPT_FAILURE_SETTLEMENT_REASON_CODE = "ATTEMPT_FAILURE_SETTLEMENT";
