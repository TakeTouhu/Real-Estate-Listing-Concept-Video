import type { PricingSnapshot } from "../pricing/index";
import type { SafeTransitionMetadata } from "./transition-metadata";
import type {
  GenerationAttemptKind,
  GenerationAttemptState,
  GenerationJobState,
  GenerationQualityTier,
  GenerationReservationState,
  GenerationSceneState,
  GenerationTransitionActorType,
  GenerationTransitionAggregateType,
  SceneGenerationRequestKind,
  SceneGenerationRequestState,
  SubmissionCertainty,
} from "./types";

/**
 * The persistence contract for generation orchestration.
 *
 * Every mutation is a **transition**, never a write. There is deliberately no
 * `update(id, fields)` anywhere in this file: an open write is how a state
 * machine gets bypassed, and the states these rows carry decide whether a paid
 * provider call is authorized. A caller must name the state and version it
 * believes it is replacing, and the implementation must refuse if either has
 * moved.
 */

/** What every transition must supply so history is complete and traceable. */
export interface TransitionContext {
  readonly actorType: GenerationTransitionActorType;
  readonly actorUserId: string | null;
  /** Opaque. Groups every operation caused by one user request. */
  readonly correlationId: string;
  /** Opaque. The event that caused this one, when there is one. */
  readonly causationId: string | null;
  readonly reasonCode: string | null;
  readonly metadata: SafeTransitionMetadata;
  readonly eventType: string;
}

/**
 * The result of a compare-and-set transition.
 *
 * A discriminated union rather than a boolean or a throw. `LOST` is an ordinary,
 * expected outcome — another worker got there first — and the caller's correct
 * response is to reload and re-evaluate, never to retry the side effect. A
 * boolean invites `if (!ok) retry()`, which is the exact bug this phase exists
 * to make impossible.
 */
export type TransitionOutcome<T> =
  | { readonly kind: "APPLIED"; readonly value: T }
  | { readonly kind: "LOST" };

export interface GenerationJob {
  readonly id: string;
  readonly videoProjectId: string;
  readonly requestedByUserId: string;
  readonly qualityTier: GenerationQualityTier;
  readonly targetOutputResolution: string;
  readonly requestedDurationSeconds: number;
  readonly requiredVideoUnits: number;
  readonly requiredHighQualityUnits: number;
  readonly state: GenerationJobState;
  readonly stateVersion: number;
  readonly currentDeliverableVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewGenerationJob {
  readonly id: string;
  readonly videoProjectId: string;
  readonly requestedByUserId: string;
  readonly qualityTier: GenerationQualityTier;
  readonly targetOutputResolution: string;
  readonly requestedDurationSeconds: number;
  readonly requiredVideoUnits: number;
  readonly requiredHighQualityUnits: number;
}

export interface GenerationReservation {
  readonly id: string;
  readonly generationJobId: string;
  /**
   * The billing cycle this reservation belongs to, permanently.
   *
   * Frozen at reservation time and never recomputed. A job reserved on
   * 30 September and delivered on 1 October consumes September's entitlement:
   * the customer's allowance was committed when the platform began spending
   * money on their behalf, not when the work happened to finish.
   */
  readonly billingCycleKey: string;
  readonly billingCycleStartedAt: Date;
  readonly billingCycleEndsAt: Date;
  readonly reservedTotalVideoUnits: number;
  readonly reservedHighQualityUnits: number;
  readonly state: GenerationReservationState;
  readonly stateVersion: number;
  readonly reservedAt: Date;
  readonly consumedAt: Date | null;
  readonly releasedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewGenerationReservation {
  readonly id: string;
  readonly generationJobId: string;
  readonly billingCycleKey: string;
  readonly billingCycleStartedAt: Date;
  readonly billingCycleEndsAt: Date;
  readonly reservedTotalVideoUnits: number;
  readonly reservedHighQualityUnits: number;
}

export interface GenerationScene {
  readonly id: string;
  readonly generationJobId: string;
  readonly position: number;
  /** Provenance only. Recomposition deletes and recreates storyboard scenes. */
  readonly sourceStoryboardSceneId: string;
  /** Provenance only. Retention may remove the asset. */
  readonly sourceAssetId: string;
  readonly sourceAnalysisRevision: number;
  readonly snapshotDurationSeconds: number;
  readonly snapshotCameraMotion: string | null;
  /** Customer-authored. Never logged, audited or placed in transition metadata. */
  readonly snapshotCompiledPrompt: string | null;
  readonly state: GenerationSceneState;
  readonly stateVersion: number;
  readonly currentDeliveredRequestId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewGenerationScene {
  readonly id: string;
  readonly generationJobId: string;
  readonly position: number;
  readonly sourceStoryboardSceneId: string;
  readonly sourceAssetId: string;
  readonly sourceAnalysisRevision: number;
  readonly snapshotDurationSeconds: number;
  readonly snapshotCameraMotion: string | null;
  readonly snapshotCompiledPrompt: string | null;
}

export interface SceneGenerationRequestRecord {
  readonly id: string;
  readonly generationSceneId: string;
  readonly kind: SceneGenerationRequestKind;
  /** Null for `INITIAL`; 1 or 2 for `USER_REGENERATION`. */
  readonly userRegenerationOrdinal: number | null;
  readonly state: SceneGenerationRequestState;
  readonly stateVersion: number;
  readonly requestedByUserId: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly failedAt: Date | null;
}

export interface NewSceneGenerationRequest {
  readonly id: string;
  readonly generationSceneId: string;
  readonly kind: SceneGenerationRequestKind;
  readonly userRegenerationOrdinal: number | null;
  readonly requestedByUserId: string | null;
}

/**
 * One provider attempt, in the orchestration vocabulary.
 *
 * A projection of the existing `scene_generations` row, not a second table.
 * The row already carries the immutable request snapshot, the request hash and
 * the provider identity; this adds the orchestration linkage and the certainty
 * axis. Legacy rows have `generationSceneRequestId === null` and are readable
 * but never orchestrated.
 */
export interface GenerationAttempt {
  readonly id: string;
  readonly videoProjectId: string;
  readonly generationSceneRequestId: string;
  readonly attemptOrdinal: number;
  readonly attemptKind: GenerationAttemptKind;
  readonly orchestrationState: GenerationAttemptState;
  readonly submissionCertainty: SubmissionCertainty;
  readonly stateVersion: number;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestHash: string;
  readonly providerPredictionId: string | null;
  readonly submissionBoundaryEnteredAt: Date | null;
  readonly providerAcceptedAt: Date | null;
  readonly reconciliationStartedAt: Date | null;
  readonly reconciliationDeadlineAt: Date | null;
  readonly reconciliationResolvedAt: Date | null;
  readonly normalizedErrorCode: string | null;
  readonly outputStorageKey: string | null;
  readonly createdAt: Date;
}

export interface GenerationTransitionEventRecord {
  readonly id: string;
  readonly aggregateType: GenerationTransitionAggregateType;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly fromState: string | null;
  readonly toState: string;
  readonly eventType: string;
  readonly actorType: GenerationTransitionActorType;
  readonly actorUserId: string | null;
  readonly reasonCode: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly safeMetadata: SafeTransitionMetadata;
  readonly createdAt: Date;
}

export interface GenerationJobRepository {
  /** Creates the job and its first transition event in one transaction. */
  create(job: NewGenerationJob, context: TransitionContext): Promise<GenerationJob>;
  findById(id: string): Promise<GenerationJob | null>;
  transition(input: {
    readonly id: string;
    readonly expectedState: GenerationJobState;
    readonly expectedVersion: number;
    readonly nextState: GenerationJobState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationJob>>;
}

export interface GenerationReservationRepository {
  create(
    reservation: NewGenerationReservation,
    context: TransitionContext,
  ): Promise<GenerationReservation>;
  findByJobId(generationJobId: string): Promise<GenerationReservation | null>;
  transition(input: {
    readonly id: string;
    readonly expectedState: GenerationReservationState;
    readonly expectedVersion: number;
    readonly nextState: GenerationReservationState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationReservation>>;
}

export interface GenerationSceneRepository {
  create(scene: NewGenerationScene, context: TransitionContext): Promise<GenerationScene>;
  findById(id: string): Promise<GenerationScene | null>;
  listByJobId(generationJobId: string): Promise<readonly GenerationScene[]>;
  transition(input: {
    readonly id: string;
    readonly expectedState: GenerationSceneState;
    readonly expectedVersion: number;
    readonly nextState: GenerationSceneState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationScene>>;
}

export interface SceneGenerationRequestRepository {
  create(
    request: NewSceneGenerationRequest,
    context: TransitionContext,
  ): Promise<SceneGenerationRequestRecord>;
  findById(id: string): Promise<SceneGenerationRequestRecord | null>;
  listBySceneId(generationSceneId: string): Promise<readonly SceneGenerationRequestRecord[]>;
  transition(input: {
    readonly id: string;
    readonly expectedState: SceneGenerationRequestState;
    readonly expectedVersion: number;
    readonly nextState: SceneGenerationRequestState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<SceneGenerationRequestRecord>>;
}

/**
 * What a worker receives when it wins the right to call a provider.
 *
 * `ARMED` is the *only* value that authorizes an outbound call, and it is
 * returned only after the transaction that moved the attempt into `SUBMITTING`
 * has committed. Every other value means the call must not happen — including
 * `MISSING_PRICING_SNAPSHOT`, which is a refusal rather than a reason to go and
 * create one mid-flight.
 */
export type ArmProviderBoundaryOutcome =
  | { readonly kind: "ARMED"; readonly attempt: GenerationAttempt }
  | { readonly kind: "LOST" }
  | { readonly kind: "MISSING_PRICING_SNAPSHOT" };

export interface SceneGenerationAttemptRepository {
  findById(id: string): Promise<GenerationAttempt | null>;
  listByRequestId(generationSceneRequestId: string): Promise<readonly GenerationAttempt[]>;

  /**
   * Move `QUEUED -> SUBMITTING` under compare-and-set, having first proved a
   * pricing snapshot exists.
   *
   * The commit of this transaction *is* the authorization to call a provider.
   * Nothing else grants it, and a `LOST` result must never be retried into a
   * call: losing means another worker is already submitting this exact attempt.
   */
  armProviderBoundary(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly context: TransitionContext;
  }): Promise<ArmProviderBoundaryOutcome>;

  /** Persist a provider submission outcome atomically with its event. */
  recordSubmissionOutcome(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly outcome: import("./certainty").AttemptOutcomePersistence;
    readonly normalizedErrorCode: string | null;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationAttempt>>;
}

export interface GenerationPricingSnapshotRecord {
  readonly id: string;
  readonly sceneGenerationId: string;
  readonly pricingVersion: string;
  readonly provider: string;
  readonly contractKey: string;
  readonly contractFingerprint: string;
  readonly riskProfileKey: string;
  readonly riskBufferBps: number;
  readonly requestedSeconds: number;
  readonly billableSeconds: number;
  readonly estimatedStableCostMicroUsd: bigint;
  readonly estimatedPlanningCostMicroUsd: bigint;
  readonly pricingEffectiveAtEpochMs: bigint;
  readonly fxSnapshotId: string | null;
  readonly createdAt: Date;
}

export interface GenerationPricingSnapshotRepository {
  /**
   * Persist the domain's immutable pricing decision against one attempt.
   *
   * Takes the domain `PricingSnapshot` rather than loose fields, so no price is
   * ever recomputed on the way into the database. There is no update method and
   * no delete method: a pricing snapshot is the record of what the platform
   * believed a call would cost when it authorized the call.
   */
  create(input: {
    readonly id: string;
    readonly sceneGenerationId: string;
    readonly snapshot: PricingSnapshot;
  }): Promise<GenerationPricingSnapshotRecord>;
  findByAttemptId(sceneGenerationId: string): Promise<GenerationPricingSnapshotRecord | null>;
}

/**
 * Read-only by design.
 *
 * There is no `update` and no `delete`, and their absence is the append-only
 * guarantee. A history that can be edited is not a history, and offering the
 * methods "for admin use" would put the capability one call site away.
 */
export interface GenerationTransitionEventRepository {
  listForAggregate(
    aggregateType: GenerationTransitionAggregateType,
    aggregateId: string,
  ): Promise<readonly GenerationTransitionEventRecord[]>;
  listForCorrelation(correlationId: string): Promise<readonly GenerationTransitionEventRecord[]>;
}
