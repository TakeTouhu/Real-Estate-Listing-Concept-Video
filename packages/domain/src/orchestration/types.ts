/**
 * The orchestration vocabulary: what a customer asked for, what it entitles
 * them to, and how many times a provider was actually invoked to satisfy it.
 *
 * Every union here is closed. A generic string state would let a typo become a
 * lifecycle, and these lifecycles decide whether money is spent.
 *
 * The separations below are the reason this module exists at all, and none of
 * them is a naming preference:
 *
 * - **A customer video unit is not a provider attempt.** One entitlement can
 *   produce an initial generation, two user regenerations and any number of
 *   system recovery attempts. Modelling them as one thing makes every provider
 *   failure look like a customer charge.
 * - **A user regeneration is not a system recovery.** The first is a right the
 *   customer spends; the second is the platform absorbing its own failure.
 * - **Submission certainty is not execution state.** Whether the provider
 *   accepted a request and what it is doing with it are different questions,
 *   and the dangerous case — accepted-but-unknown — has no answer to the second.
 */

/** The product quality class a customer bought. Never a provider or model name. */
export type GenerationQualityTier = "NORMAL" | "HIGH_QUALITY";

export const GENERATION_QUALITY_TIERS: readonly GenerationQualityTier[] = [
  "NORMAL",
  "HIGH_QUALITY",
];

/**
 * The customer-visible lifecycle of one video.
 *
 * `REVISING` sits after `DELIVERABLE_READY` rather than before it: a customer
 * may regenerate a scene of a video they already have, and the deliverable they
 * hold stays valid until a replacement is ready.
 */
export type GenerationJobState =
  | "CREATED"
  | "RESERVING"
  | "RESERVED"
  | "GENERATING"
  | "SCENES_READY"
  | "COMPOSITION_PENDING"
  | "COMPOSING"
  | "DELIVERABLE_VALIDATING"
  | "DELIVERABLE_READY"
  | "REVISING"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export const GENERATION_JOB_STATES: readonly GenerationJobState[] = [
  "CREATED",
  "RESERVING",
  "RESERVED",
  "GENERATING",
  "SCENES_READY",
  "COMPOSITION_PENDING",
  "COMPOSING",
  "DELIVERABLE_VALIDATING",
  "DELIVERABLE_READY",
  "REVISING",
  "FAILED_TERMINAL",
  "CANCELLED",
];

/**
 * The lifecycle of one customer entitlement hold.
 *
 * `RECONCILIATION_HOLD` exists because submission certainty can be lost. While
 * the platform does not know whether a provider accepted a request, it can
 * neither consume the customer's unit nor give it back, and a state that says
 * so is better than a boolean that does not.
 */
export type GenerationReservationState =
  | "RESERVING"
  | "RESERVED"
  | "RECONCILIATION_HOLD"
  | "CONSUMED"
  | "RELEASED";

export const GENERATION_RESERVATION_STATES: readonly GenerationReservationState[] = [
  "RESERVING",
  "RESERVED",
  "RECONCILIATION_HOLD",
  "CONSUMED",
  "RELEASED",
];

/** The customer-facing state of one logical scene. Not a provider attempt state. */
export type GenerationSceneState =
  | "PENDING"
  | "GENERATING"
  | "READY"
  | "REVISING"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export const GENERATION_SCENE_STATES: readonly GenerationSceneState[] = [
  "PENDING",
  "GENERATING",
  "READY",
  "REVISING",
  "FAILED_TERMINAL",
  "CANCELLED",
];

/**
 * Why a new rendition of a scene was requested.
 *
 * There is deliberately no `SYSTEM_RECOVERY` member. Recovery from a provider
 * failure is not a new customer request — it is another attempt at the same
 * one — so it belongs to the attempt, not here. Putting it in this union would
 * make every provider outage look like the customer spending a regeneration.
 */
export type SceneGenerationRequestKind = "INITIAL" | "USER_REGENERATION";

export const SCENE_GENERATION_REQUEST_KINDS: readonly SceneGenerationRequestKind[] = [
  "INITIAL",
  "USER_REGENERATION",
];

/**
 * The lifecycle of one customer-visible rendition request.
 *
 * There is no `FAILED_RETRYABLE` here, and its absence is load-bearing.
 * Retryability is a property of one provider invocation, not of the customer's
 * request: a request whose attempt failed retryably is still `GENERATING`,
 * because the platform is going to try again without telling the customer their
 * request failed.
 */
export type SceneGenerationRequestState =
  | "PENDING"
  | "GENERATING"
  | "DELIVERED"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export const SCENE_GENERATION_REQUEST_STATES: readonly SceneGenerationRequestState[] = [
  "PENDING",
  "GENERATING",
  "DELIVERED",
  "FAILED_TERMINAL",
  "CANCELLED",
];

/**
 * The most user regenerations one scene may consume.
 *
 * A count, not a policy engine: the entitlement is two, and the ordinal column
 * is constrained to `1` or `2` in the database so an application bug cannot
 * grant a third.
 */
export const MAX_USER_REGENERATIONS_PER_SCENE = 2;

/**
 * What one provider attempt is *for*.
 *
 * `PRIMARY` is the first invocation for a request; `SYSTEM_RECOVERY` is the
 * platform trying again after its own or the provider's failure. A user
 * regeneration is never an attempt kind — it creates a whole new
 * `SceneGenerationRequest`, with its own `PRIMARY` attempt.
 */
export type GenerationAttemptKind = "PRIMARY" | "SYSTEM_RECOVERY";

export const GENERATION_ATTEMPT_KINDS: readonly GenerationAttemptKind[] = [
  "PRIMARY",
  "SYSTEM_RECOVERY",
];

/**
 * Whether the provider accepted this attempt — an axis of its own.
 *
 * This mirrors `ProviderSubmissionOutcome` in `@app/video-providers` exactly,
 * plus the `PRE_SUBMISSION` value that port has no reason to name: before the
 * boundary is crossed there is no outcome yet, and calling that "rejected"
 * would be a lie about a request nobody sent.
 *
 * Certainty is never derivable from execution state. `SUBMISSION_UNKNOWN` is
 * the case that proves it: the attempt may be running and billable, or may
 * never have reached the provider, and one execution state has to cover both.
 */
export type SubmissionCertainty =
  | "PRE_SUBMISSION"
  | "ACCEPTED"
  | "DEFINITIVELY_REJECTED"
  | "SUBMISSION_UNKNOWN";

export const SUBMISSION_CERTAINTIES: readonly SubmissionCertainty[] = [
  "PRE_SUBMISSION",
  "ACCEPTED",
  "DEFINITIVELY_REJECTED",
  "SUBMISSION_UNKNOWN",
];

/**
 * The execution lifecycle of one provider attempt.
 *
 * Distinct from the legacy `SceneGenerationState` vocabulary, which stays
 * exactly as it is for rows admitted before this phase. Three differences carry
 * meaning rather than tidiness:
 *
 * - `PROVIDER_SUCCEEDED` replaces the legacy `SUCCEEDED`, because a provider
 *   reporting success is not the customer being delivered anything. Ingestion
 *   and verification still stand between them.
 * - `RECONCILIATION_PENDING` replaces the legacy `SUBMISSION_UNKNOWN` *state*.
 *   Unknown acceptance is now recorded on the certainty axis, and this state
 *   says what the platform is doing about it.
 * - `CANCELLED_PRE_SUBMISSION` replaces the legacy `CANCELLED`, naming the only
 *   cancellation that is safe: one where no provider was contacted.
 */
export type GenerationAttemptState =
  | "QUEUED"
  | "SUBMITTING"
  | "PROCESSING"
  | "RECONCILIATION_PENDING"
  | "PROVIDER_SUCCEEDED"
  | "OUTPUT_INGESTING"
  | "OUTPUT_VERIFIED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "RECONCILIATION_EXHAUSTED"
  | "CANCELLED_PRE_SUBMISSION";

export const GENERATION_ATTEMPT_STATES: readonly GenerationAttemptState[] = [
  "QUEUED",
  "SUBMITTING",
  "PROCESSING",
  "RECONCILIATION_PENDING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
  "OUTPUT_VERIFIED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "RECONCILIATION_EXHAUSTED",
  "CANCELLED_PRE_SUBMISSION",
];

/** Which aggregate a transition event describes. */
export type GenerationTransitionAggregateType =
  | "JOB"
  | "RESERVATION"
  | "SCENE"
  | "SCENE_REQUEST"
  | "ATTEMPT"
  | "DELIVERABLE";

export const GENERATION_TRANSITION_AGGREGATE_TYPES: readonly GenerationTransitionAggregateType[] =
  ["JOB", "RESERVATION", "SCENE", "SCENE_REQUEST", "ATTEMPT", "DELIVERABLE"];

/** Who caused a transition. `WORKER` and `RECONCILIATION_WORKER` are separate
 * because "the system retried" and "the system resolved an unknown submission"
 * answer different questions during an incident. */
export type GenerationTransitionActorType =
  | "USER"
  | "SYSTEM"
  | "WORKER"
  | "ADMIN"
  | "RECONCILIATION_WORKER";

export const GENERATION_TRANSITION_ACTOR_TYPES: readonly GenerationTransitionActorType[] = [
  "USER",
  "SYSTEM",
  "WORKER",
  "ADMIN",
  "RECONCILIATION_WORKER",
];

/**
 * Where a failure came from, as a closed vocabulary.
 *
 * A raw provider string is not a business fact. Routing, alerting and cost
 * attribution all key off *which layer* failed, and a free-text field cannot be
 * switched on without eventually being parsed.
 */
export type GenerationFailureSource =
  | "LOCAL_VALIDATION"
  | "PROVIDER"
  | "NETWORK"
  | "STORAGE"
  | "COMPOSITION"
  | "SAFETY"
  | "RECONCILIATION"
  | "SYSTEM"
  | "COST_SAFETY_GUARD";

export const GENERATION_FAILURE_SOURCES: readonly GenerationFailureSource[] = [
  "LOCAL_VALIDATION",
  "PROVIDER",
  "NETWORK",
  "STORAGE",
  "COMPOSITION",
  "SAFETY",
  "RECONCILIATION",
  "SYSTEM",
  "COST_SAFETY_GUARD",
];

/**
 * A normalized failure, safe to persist and to show an operator.
 *
 * `safeMessage` is optional and sanitized by construction — it never carries a
 * provider body, a prompt or a URL. The reason a raw provider error must not be
 * persisted is not tidiness: provider error text has been observed to echo
 * request content back, which would put customer prompts into an audit table
 * that is read far more widely than the generation row itself.
 */
export interface GenerationFailureReason {
  readonly reasonCode: string;
  readonly reasonSource: GenerationFailureSource;
  readonly safeMessage: string | null;
}
