import type {
  GenerationAttemptState,
  GenerationJobState,
  GenerationReservationState,
  GenerationSceneState,
  SceneGenerationRequestState,
} from "./types";

/**
 * Every orchestration transition the system permits, as five tables.
 *
 * Tables rather than conditionals scattered through services, for the reason
 * the existing attempt machine already gives: the legal moves *are* the
 * contract, and the dangerous properties — that `SUBMITTING` has no way back to
 * `QUEUED`, that `RECONCILIATION_PENDING` cannot re-arm a POST — are only
 * visible when the whole table is in one place.
 *
 * Legality is not automation. Several edges here have no actor in this phase at
 * all; they exist so that a later worker has somewhere legal to go, and every
 * one of them must still be performed as a compare-and-set.
 */

/**
 * The customer video lifecycle.
 *
 * `DELIVERABLE_READY -> REVISING` is the edge that makes post-delivery
 * regeneration possible, and it is why `DELIVERABLE_READY` is not terminal.
 * It is, however, terminal for *failure*: a delivered video does not become a
 * failed one because a later revision went wrong — the revision fails, and the
 * customer keeps what they already have.
 */
const JOB_TRANSITIONS: Readonly<Record<GenerationJobState, readonly GenerationJobState[]>> = {
  CREATED: ["RESERVING", "CANCELLED", "FAILED_TERMINAL"],
  RESERVING: ["RESERVED", "CANCELLED", "FAILED_TERMINAL"],
  RESERVED: ["GENERATING", "CANCELLED", "FAILED_TERMINAL"],
  GENERATING: ["SCENES_READY", "CANCELLED", "FAILED_TERMINAL"],
  SCENES_READY: ["COMPOSITION_PENDING", "CANCELLED", "FAILED_TERMINAL"],
  COMPOSITION_PENDING: ["COMPOSING", "CANCELLED", "FAILED_TERMINAL"],
  // Past this point the platform is spending its own compute on work the
  // customer has already paid for, and a cancellation would strand it. Failure
  // is still reachable; user cancellation is not.
  COMPOSING: ["DELIVERABLE_VALIDATING", "FAILED_TERMINAL"],
  DELIVERABLE_VALIDATING: ["DELIVERABLE_READY", "FAILED_TERMINAL"],
  // Not terminal, and not failable. A delivered video stays delivered.
  DELIVERABLE_READY: ["REVISING"],
  REVISING: ["GENERATING"],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

/**
 * The entitlement hold.
 *
 * `RESERVING -> RELEASED` covers a reservation that never completed. The two
 * edges into `RECONCILIATION_HOLD` and back exist because submission certainty
 * can be lost and later regained: while it is lost the platform must not decide
 * either way, and while it is held the customer's unit is neither spent nor
 * returned.
 */
const RESERVATION_TRANSITIONS: Readonly<
  Record<GenerationReservationState, readonly GenerationReservationState[]>
> = {
  RESERVING: ["RESERVED", "RELEASED"],
  RESERVED: ["RECONCILIATION_HOLD", "CONSUMED", "RELEASED"],
  RECONCILIATION_HOLD: ["RESERVED", "CONSUMED", "RELEASED"],
  CONSUMED: [],
  RELEASED: [],
};

/** One logical scene, as the customer sees it. */
const SCENE_TRANSITIONS: Readonly<
  Record<GenerationSceneState, readonly GenerationSceneState[]>
> = {
  PENDING: ["GENERATING", "CANCELLED", "FAILED_TERMINAL"],
  GENERATING: ["READY", "CANCELLED", "FAILED_TERMINAL"],
  // A ready scene can be regenerated, and a failed revision returns it to
  // READY: the customer keeps the rendition they already had.
  READY: ["REVISING"],
  REVISING: ["READY"],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

/**
 * One customer-visible rendition request.
 *
 * The absence of an edge is the important part: there is no path from
 * `GENERATING` back to `PENDING`, because a system recovery attempt does not
 * restart the customer's request — the request stays `GENERATING` while the
 * platform creates another attempt underneath it.
 */
const REQUEST_TRANSITIONS: Readonly<
  Record<SceneGenerationRequestState, readonly SceneGenerationRequestState[]>
> = {
  PENDING: ["GENERATING", "CANCELLED", "FAILED_TERMINAL"],
  GENERATING: ["DELIVERED", "CANCELLED", "FAILED_TERMINAL"],
  DELIVERED: [],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

/**
 * One provider attempt. The table that spends money.
 *
 * Three absences define it:
 *
 * - **`SUBMITTING` has no edge to `QUEUED`.** An attempt that entered the
 *   submission boundary may have reached the provider before the process died.
 *   Returning it to `QUEUED` would let a worker POST it a second time and pay
 *   twice for one request. A retry is a *new row*.
 * - **`RECONCILIATION_PENDING` has no edge to `QUEUED` either**, for the same
 *   reason and more sharply: unknown acceptance is precisely the case where a
 *   second POST is most likely to be a duplicate charge.
 * - **`FAILED_RETRYABLE` is terminal for this row.** It means the *parent
 *   request* may create another attempt, not that this attempt revives. The
 *   legacy machine allows `FAILED_RETRYABLE -> QUEUED`; this one deliberately
 *   does not, because reusing an attempt row is how one row crosses the
 *   provider boundary twice.
 */
const ATTEMPT_TRANSITIONS: Readonly<
  Record<GenerationAttemptState, readonly GenerationAttemptState[]>
> = {
  // Pre-provider failures are real: preflight can find the request
  // unreconstructable or storage unreachable before anything is sent.
  QUEUED: [
    "SUBMITTING",
    "CANCELLED_PRE_SUBMISSION",
    "FAILED_RETRYABLE",
    "FAILED_TERMINAL",
  ],
  // The four ways a submission can end, matching ProviderSubmissionOutcome plus
  // the accepted case. No cancellation: the provider may already be working.
  SUBMITTING: [
    "PROCESSING",
    "FAILED_RETRYABLE",
    "FAILED_TERMINAL",
    "RECONCILIATION_PENDING",
  ],
  PROCESSING: ["PROVIDER_SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  // What reconciliation can conclude. `PROCESSING` is the "it was accepted
  // after all" answer; `RECONCILIATION_EXHAUSTED` is "we will never know".
  RECONCILIATION_PENDING: [
    "PROCESSING",
    "FAILED_RETRYABLE",
    "FAILED_TERMINAL",
    "RECONCILIATION_EXHAUSTED",
  ],
  // The provider says it made something. Nobody has looked at it yet.
  PROVIDER_SUCCEEDED: ["OUTPUT_INGESTING"],
  OUTPUT_INGESTING: ["OUTPUT_VERIFIED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  OUTPUT_VERIFIED: [],
  FAILED_RETRYABLE: [],
  FAILED_TERMINAL: [],
  RECONCILIATION_EXHAUSTED: [],
  CANCELLED_PRE_SUBMISSION: [],
};

function makeChecker<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
): {
  can: (from: S, to: S) => boolean;
  allowedFrom: (from: S) => readonly S[];
} {
  return {
    can: (from, to) => table[from].includes(to),
    allowedFrom: (from) => table[from],
  };
}

const job = makeChecker(JOB_TRANSITIONS);
const reservation = makeChecker(RESERVATION_TRANSITIONS);
const scene = makeChecker(SCENE_TRANSITIONS);
const request = makeChecker(REQUEST_TRANSITIONS);
const attempt = makeChecker(ATTEMPT_TRANSITIONS);

export const canTransitionJob = job.can;
export const allowedJobTransitionsFrom = job.allowedFrom;

export const canTransitionReservation = reservation.can;
export const allowedReservationTransitionsFrom = reservation.allowedFrom;

export const canTransitionScene = scene.can;
export const allowedSceneTransitionsFrom = scene.allowedFrom;

export const canTransitionSceneRequest = request.can;
export const allowedSceneRequestTransitionsFrom = request.allowedFrom;

export const canTransitionAttempt = attempt.can;
export const allowedAttemptTransitionsFrom = attempt.allowedFrom;

/**
 * Attempt states that have finished for that exact row.
 *
 * `FAILED_RETRYABLE` is in this list, which reads oddly until you separate the
 * two lifecycles: the *attempt* is over, and the *request* may open another
 * one. Listing it explicitly rather than deriving "no outgoing edges" would be
 * equivalent today but would stop being equivalent the moment someone adds an
 * edge, so it is derived from the table and proved against it in tests.
 */
export const TERMINAL_ATTEMPT_STATES: readonly GenerationAttemptState[] = [
  "OUTPUT_VERIFIED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "RECONCILIATION_EXHAUSTED",
  "CANCELLED_PRE_SUBMISSION",
];

export function isTerminalAttemptState(state: GenerationAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(state);
}

/**
 * Attempt states in which the provider may already hold, and may already be
 * billing for, this request.
 *
 * The set that decides whether a second POST for the same logical work is safe.
 * `RECONCILIATION_PENDING` is a member precisely because the answer is unknown:
 * treating "we do not know" as "it did not happen" is how a system pays twice.
 */
export const PROVIDER_EXPOSED_ATTEMPT_STATES: readonly GenerationAttemptState[] = [
  "SUBMITTING",
  "PROCESSING",
  "RECONCILIATION_PENDING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
  "OUTPUT_VERIFIED",
  "RECONCILIATION_EXHAUSTED",
];

export function isProviderExposedAttemptState(state: GenerationAttemptState): boolean {
  return PROVIDER_EXPOSED_ATTEMPT_STATES.includes(state);
}

/**
 * The one state from which a provider call may be armed.
 *
 * A function rather than a constant so that call sites read as a question about
 * this attempt rather than as a comparison someone can invert by accident.
 */
export function mayArmProviderBoundary(state: GenerationAttemptState): boolean {
  return state === "QUEUED";
}
