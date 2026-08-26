import { AppError } from "@app/shared";
import type { SceneGenerationState } from "./types";

/**
 * The complete transition contract for a scene-generation attempt.
 *
 * One table, not scattered conditionals: the legal moves are the contract, and
 * reading them in one place is the only way to see that
 * `SUBMISSION_UNKNOWN` has no way out.
 *
 * Nothing here knows about HTTP, providers, backoff, or timeouts. Deciding
 * *which* transition a given failure warrants is the worker's job (Phase 4C);
 * this module only says which are legal at all.
 *
 * The vocabulary is compatible with the already-shipped `ProviderGenerationState`
 * in `@app/video-providers`: every verdict that port can normalize about a known
 * prediction — succeeded, retryably failed, terminally failed — has somewhere to
 * go from `PROCESSING`.
 */
const TRANSITIONS: Readonly<Record<SceneGenerationState, readonly SceneGenerationState[]>> = {
  // Nothing has been sent yet, so cancelling costs nothing and risks nothing —
  // and for the same reason, the two failure edges here are safe in a way the
  // ones out of `SUBMITTING` are not. A generation can fail **before** any
  // provider is contacted: preflight can find the request unreconstructable, the
  // source asset unusable, or storage unreachable (ADR-0026). Parking those in
  // `FAILED_RETRYABLE` / `FAILED_TERMINAL` cannot describe a paid attempt,
  // because no attempt was made. Which of the two a given refusal warrants is
  // `preflightFailureStateFor`'s answer, not this table's (ADR-0027).
  QUEUED: ["SUBMITTING", "CANCELLED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],

  // The four ways a submission POST can end. The split between the last three
  // is the whole point of this design: a failure is only `FAILED_RETRYABLE`
  // when there is positive evidence the provider did **not** accept the
  // request. Anything that leaves acceptance in doubt is `SUBMISSION_UNKNOWN`.
  SUBMITTING: ["PROCESSING", "FAILED_RETRYABLE", "FAILED_TERMINAL", "SUBMISSION_UNKNOWN"],

  // A prediction id is known, so the provider's own verdict on it is what moves
  // this job. Two different things can go wrong while polling, and they are
  // deliberately not the same edge:
  //
  // - **The status GET itself fails** (timeout, reset, transient network). That
  //   means "we do not know the latest provider state", not that anything
  //   failed. GET is idempotent, so the worker retries it with bounded backoff
  //   and the job **stays `PROCESSING`**. There is no edge for this, by design.
  //
  // - **The status GET succeeds and reports a failure.** Now we have learned
  //   something: the known prediction failed. The provider port already
  //   normalizes that verdict into `FAILED_RETRYABLE` or `FAILED_TERMINAL`
  //   (`ProviderGenerationState`), so both are reachable from here. The only
  //   route back to a submission is `FAILED_RETRYABLE -> QUEUED -> SUBMITTING`,
  //   which is why `PROCESSING -> QUEUED` is absent. Reaching
  //   `FAILED_RETRYABLE` does **not** start that route: nothing follows the edge
  //   on its own (see below).
  PROCESSING: ["SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],

  // The one edge back to the start of the submission path.
  //
  // **Legal is not automatic, and this entry is the clearest place that
  // distinction bites.** No actor in the system performs this move today: there
  // is no scheduler, no timer, no retry loop, and no worker. The edge exists so
  // that a future *explicit* retry policy has somewhere legal to go — a decision
  // someone makes, not one the machine takes because a row is sitting here.
  //
  // Whatever implements it later must express the move as an expected-state
  // compare-and-swap naming `FAILED_RETRYABLE` as the state it replaces, and
  // treat zero rows updated as "someone else moved it" rather than as success.
  // A row here can be competed for — a future cancellation above all — and an
  // unconditional write would silently overwrite whichever writer lost
  // (docs/decisions/TODO.md).
  FAILED_RETRYABLE: ["QUEUED"],

  // Deliberately empty. The provider may already have accepted and billed this
  // request, so no automatic transition exists — not back to `QUEUED`, not back
  // to `SUBMITTING`, and not forward to `PROCESSING` either, because inventing
  // a prediction id we never received would be worse than stopping. Resolving
  // one needs a human (docs/decisions/TODO.md); Phase 4A-1 does not model that.
  SUBMISSION_UNKNOWN: [],

  // Terminal. A deliberate regeneration is a **new** generation job, never a
  // revival of this one, so its history and its provider attempt stay intact.
  SUCCEEDED: [],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

/**
 * States that still hold the local generation identity.
 *
 * Phase 4A-2's partial unique index uses exactly this set, so a second job for
 * the same request cannot be created while one of these is outstanding.
 *
 * Two memberships are load-bearing and easy to get wrong:
 *
 * - **`FAILED_RETRYABLE` is active.** It can return to `QUEUED`, so releasing
 *   the identity here would let a second job be created alongside a job that is
 *   still going to submit — the exact duplicate-submission path this design
 *   exists to prevent.
 * - **`SUBMISSION_UNKNOWN` is active.** The provider may already hold a billed
 *   prediction for this request. Holding the identity is what stops the system
 *   paying twice for it.
 *
 * Active is not the same as *automatically retryable*: `SUBMISSION_UNKNOWN` is
 * active and has no outgoing transition at all.
 */
export const ACTIVE_SCENE_GENERATION_STATES: readonly SceneGenerationState[] = [
  "QUEUED",
  "SUBMITTING",
  "PROCESSING",
  "FAILED_RETRYABLE",
  "SUBMISSION_UNKNOWN",
];

/**
 * States that have finished and release the local generation identity, so a
 * deliberate later regeneration can create a new job.
 *
 * Listed explicitly rather than derived as "not active", so the two sets can be
 * proved to partition the vocabulary instead of one silently defining the
 * other.
 */
export const TERMINAL_SCENE_GENERATION_STATES: readonly SceneGenerationState[] = [
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "CANCELLED",
];

/**
 * Whether `to` is a legal move from `from`.
 *
 * Legality only says the move is *allowed*. It is not evidence that anything
 * performs it — `FAILED_RETRYABLE -> QUEUED` is legal and has no actor at all.
 */
export function canTransition(from: SceneGenerationState, to: SceneGenerationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The legal moves out of `from`. Empty for terminal states — and for `SUBMISSION_UNKNOWN`. */
export function allowedTransitionsFrom(
  from: SceneGenerationState,
): readonly SceneGenerationState[] {
  return TRANSITIONS[from];
}

/**
 * Whether this state still reserves the local generation identity.
 *
 * @see ACTIVE_SCENE_GENERATION_STATES for why `FAILED_RETRYABLE` and
 * `SUBMISSION_UNKNOWN` count.
 */
export function isActiveGenerationState(state: SceneGenerationState): boolean {
  return ACTIVE_SCENE_GENERATION_STATES.includes(state);
}

/** Whether this state has finished and released the local generation identity. */
export function isTerminalGenerationState(state: SceneGenerationState): boolean {
  return TERMINAL_SCENE_GENERATION_STATES.includes(state);
}

/**
 * Refuse an illegal transition.
 *
 * `INTERNAL_ERROR`, not `VALIDATION_FAILED`: nothing a customer submits reaches
 * this. An illegal move means a worker bug or a lost race with another writer,
 * and surfacing either to a customer as a 422 refusal would be a lie about
 * whose mistake it was. The message names both states because it is only ever
 * read in a log or a test.
 */
export function assertTransition(from: SceneGenerationState, to: SceneGenerationState): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Illegal scene-generation transition ${from} -> ${to}`,
      { details: { from, to } },
    );
  }
}
