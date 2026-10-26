/**
 * Closing the open scenes of a failed job (ADR-0084).
 *
 * A job fails with the first scene that settles (Transaction H for a media
 * failure, Transaction K for an attempt that ended without a video), and that
 * commit releases the job's Unit. The job's other scenes are left where they
 * were: some never started, some have an attempt waiting to be sent, some have
 * one at the provider. None of them can be delivered any more, because delivery
 * requires the job `GENERATING`, and none can be sent, because the
 * paid-submission gate refuses a released Unit.
 *
 * This closes each such scene once nothing of it is at the provider:
 *
 * - a scene that never started is **cancelled**, with its pending request;
 * - a scene that started **fails**: an attempt still waiting to be sent is
 *   cancelled before submission, and its request fails.
 *
 * A scene with an attempt the provider may hold is not closed yet. A request
 * does not report itself finished while a provider may be working on it (the
 * request state machine has no such edge for the same reason); it closes once
 * that attempt ends, by whichever writer ends it.
 *
 * Nothing here moves money. The job's Unit was released by the settlement that
 * failed the job, and a closed scene changes nothing the customer pays.
 *
 * Pure: the persistence layer reads the locked rows into
 * {@link FailedJobSceneFacts}, asks this module what they close into, and
 * writes that.
 */

import { AppError } from "@app/shared";
import { isTerminalAttemptState } from "../orchestration/state-machines";
import type {
  GenerationAttemptState,
  GenerationJobState,
  GenerationSceneState,
  SceneGenerationRequestKind,
  SceneGenerationRequestState,
} from "../orchestration/types";

/** One request of the scene and its attempts, under the locks taken. */
export interface FailedJobSceneRequestFacts {
  readonly kind: SceneGenerationRequestKind;
  readonly state: SceneGenerationRequestState;
  readonly delivered: boolean;
  /** Every attempt of the request. `null` is a row with no orchestration state. */
  readonly attemptStates: readonly (GenerationAttemptState | null)[];
}

/** The rows a closure reads, under the locks the persistence layer took. */
export interface FailedJobSceneFacts {
  readonly jobState: GenerationJobState;
  readonly sceneState: GenerationSceneState;
  /** Whether the scene's delivered pointer names a request. */
  readonly sceneNamesRendition: boolean;
  /** Every request of the scene. A failed job never delivered, so at most its initial one. */
  readonly requests: readonly FailedJobSceneRequestFacts[];
}

/** Why a scene cannot be closed. Closed and application-owned. */
export type FailedJobSceneRefusal =
  /** The job has not failed. A scene of a live job is its workflow's. */
  | "JOB_NOT_FAILED"
  /** The scene is ready or already closed. A closed one answers this. */
  | "SCENE_NOT_OPEN"
  /** An attempt the provider may hold has not ended; the scene closes after it. */
  | "ATTEMPT_IN_FLIGHT"
  /** The scene, its requests or their attempts contradict a job that never delivered. */
  | "SHAPE_CONFLICT";

export type FailedJobSceneClosure =
  | {
      readonly kind: "CLOSE";
      /** A scene that never started is cancelled; one that started fails. */
      readonly sceneTo: "CANCELLED" | "FAILED_TERMINAL";
      /** What its request becomes: a pending one is cancelled, a generating one fails. */
      readonly request: "NONE" | "CANCEL" | "FAIL";
      /** Attempts still waiting to be sent, cancelled before submission. */
      readonly attemptsToCancel: number;
    }
  | { readonly kind: "NOT_CLOSABLE"; readonly reason: FailedJobSceneRefusal };

/**
 * Decide how an open scene of a failed job closes.
 *
 * The persistence layer's candidate query mirrors every condition here, so a
 * scene this refuses is not offered again until the fact it refused on changes.
 */
export function decideFailedJobSceneClosure(facts: FailedJobSceneFacts): FailedJobSceneClosure {
  if (facts.jobState !== "FAILED_TERMINAL") return refuse("JOB_NOT_FAILED");
  if (facts.sceneState !== "PENDING" && facts.sceneState !== "GENERATING") {
    return refuse("SCENE_NOT_OPEN");
  }
  const sceneTo = facts.sceneState === "PENDING" ? "CANCELLED" : "FAILED_TERMINAL";

  const [request, ...others] = facts.requests;
  if (facts.sceneNamesRendition || others.length > 0) return refuse("SHAPE_CONFLICT");
  if (request === undefined) return { kind: "CLOSE", sceneTo, request: "NONE", attemptsToCancel: 0 };
  if (request.kind !== "INITIAL" || request.delivered) return refuse("SHAPE_CONFLICT");

  if (request.state === "PENDING") {
    // Admission takes a request to GENERATING with its first attempt.
    if (request.attemptStates.length > 0) return refuse("SHAPE_CONFLICT");
    return { kind: "CLOSE", sceneTo, request: "CANCEL", attemptsToCancel: 0 };
  }
  if (request.state !== "GENERATING" || facts.sceneState !== "GENERATING") {
    return refuse("SHAPE_CONFLICT");
  }

  let attemptsToCancel = 0;
  for (const state of request.attemptStates) {
    if (state === null) return refuse("SHAPE_CONFLICT");
    if (state === "QUEUED") attemptsToCancel += 1;
    else if (!isTerminalAttemptState(state)) return refuse("ATTEMPT_IN_FLIGHT");
  }
  return { kind: "CLOSE", sceneTo, request: "FAIL", attemptsToCancel };
}

function refuse(reason: FailedJobSceneRefusal): FailedJobSceneClosure {
  return { kind: "NOT_CLOSABLE", reason };
}

// ---------------------------------------------------------------------------
// Batch bound
// ---------------------------------------------------------------------------

/** The largest batch one pass may take, matching the other sweeps' bound. */
export const MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE = 100;

/** Prove a candidate-query limit is usable, or refuse. Never clamped. */
export function validateFailedJobSceneClosureBatchLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Failed job scene closure batch limit must be an integer between 1 and ${MAX_FAILED_JOB_SCENE_CLOSURE_BATCH_SIZE}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export type FailedJobSceneClosureDefectCode =
  /** A closure write matched other than the rows this transaction holds locked. */
  | "CLOSURE_LOST_UNDER_LOCK"
  /** A locked row held a state the domain does not name. */
  | "STATE_OUTSIDE_VOCABULARY";

const DEFECT_MESSAGES: Record<FailedJobSceneClosureDefectCode, string> = {
  CLOSURE_LOST_UNDER_LOCK:
    "A failed job's scene closure write matched other rows than it holds locked",
  STATE_OUTSIDE_VOCABULARY: "A failed job's scene closure read a state outside the domain's",
};

export class FailedJobSceneClosureDefect extends Error {
  readonly code: FailedJobSceneClosureDefectCode;

  constructor(code: FailedJobSceneClosureDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "FailedJobSceneClosureDefect";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

/** Fixed application-owned event types. Nothing external reaches these. */
export const SCENE_CANCELLED_EVENT_TYPE = "scene.cancelled";
export const SCENE_REQUEST_CANCELLED_EVENT_TYPE = "scene_request.cancelled";
export const ATTEMPT_CANCELLED_PRE_SUBMISSION_EVENT_TYPE = "attempt.cancelled_pre_submission";

/** The reason code recorded on every closure transition. */
export const FAILED_JOB_SCENE_CLOSURE_REASON_CODE = "FAILED_JOB_SCENE_CLOSURE";
