import type { ResolutionNormalization, TargetOutputResolution } from "../generation/model-catalog";
import type { FxSnapshot, PricingSnapshot } from "../pricing/index";
import type { AttemptOutcomePersistence } from "./certainty";
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
 * Two rules shape every method here.
 *
 * **Every mutation is a transition, never a write.** There is deliberately no
 * `update(id, fields)`: an open write is how a state machine gets bypassed, and
 * the states these rows carry decide whether a paid provider call is
 * authorized. A caller must name the state and version it believes it is
 * replacing, and the implementation must refuse if either has moved.
 *
 * **Every method is organization-scoped.** An id is not an authorization. Bare
 * ids let any caller that obtains one reach another tenant's generation
 * history, so `organizationId` is a required parameter throughout and is
 * resolved through the `VideoProject` ownership boundary the rest of the
 * schema already uses. A cross-tenant id behaves exactly like a missing one:
 * no read, no mutation, no event, no disclosure that the row exists.
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
 * expected outcome — another worker got there first, or the row belongs to
 * another tenant — and the caller's correct response is to reload and
 * re-evaluate, never to retry the side effect. A boolean invites
 * `if (!ok) retry()`, which is the exact bug this phase exists to make
 * impossible.
 */
export type TransitionOutcome<T> =
  | { readonly kind: "APPLIED"; readonly value: T }
  | { readonly kind: "LOST" };

export interface GenerationJob {
  readonly id: string;
  readonly videoProjectId: string;
  readonly organizationId: string;
  readonly requestedByUserId: string;
  readonly qualityTier: GenerationQualityTier;
  /**
   * The output configuration as it stood when this lifecycle began.
   *
   * Snapshotted from the `VideoProject` inside the creation transaction and
   * never read again: project settings are mutable, and an attempt admitted
   * three days later must be generated for what the customer started, not for
   * whatever the project says today.
   */
  readonly targetOutputResolution: TargetOutputResolution;
  readonly targetAspectRatio: string;
  readonly requestedDurationSeconds: number;
  readonly requiredVideoUnits: number;
  readonly requiredHighQualityUnits: number;
  readonly state: GenerationJobState;
  readonly stateVersion: number;
  readonly currentDeliverableVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A new job, with the entitlement arithmetic **absent**.
 *
 * `requiredVideoUnits` and `requiredHighQualityUnits` are not accepted from a
 * caller. They are a deterministic function of duration and quality tier, and
 * accepting them independently made three impossible things constructible: a
 * 90-second job holding one unit, a `NORMAL` job with high-quality units, and a
 * `HIGH_QUALITY` job with none. They are derived at the admission boundary from
 * the customer pricing contract, and a duration the product does not sell is
 * refused rather than converted into more units.
 */
export interface NewGenerationJob {
  readonly id: string;
  readonly videoProjectId: string;
  readonly requestedByUserId: string;
  readonly qualityTier: GenerationQualityTier;
  readonly requestedDurationSeconds: number;
}

/** Why a job could not be admitted. Closed, and never provider-derived. */
export type CreateGenerationJobOutcome =
  | { readonly kind: "CREATED"; readonly job: GenerationJob }
  | { readonly kind: "PROJECT_NOT_FOUND" }
  | { readonly kind: "DURATION_NOT_SUPPORTED" };

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

/**
 * Transaction B's input.
 *
 * The unit counts are absent here too, and for a stronger reason than at job
 * creation: the reservation must hold exactly what the job was admitted for.
 * Accepting them independently would let a reservation cover fewer units than
 * the job it belongs to — an under-charge no later reconciliation could
 * detect, because both rows would look internally consistent.
 */
export interface ReserveGenerationJobInput {
  readonly reservationId: string;
  readonly generationJobId: string;
  readonly expectedJobVersion: number;
  readonly billingCycleKey: string;
  readonly billingCycleStartedAt: Date;
  readonly billingCycleEndsAt: Date;
}

export type ReserveGenerationJobOutcome =
  | {
      readonly kind: "RESERVED";
      readonly job: GenerationJob;
      readonly reservation: GenerationReservation;
    }
  | { readonly kind: "LOST" }
  | { readonly kind: "ALREADY_RESERVED" };

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

/**
 * Admitting a user regeneration.
 *
 * **The ordinal is absent, deliberately.** A caller nominating `1` or `2` is a
 * caller asserting how much of the customer's entitlement is already spent,
 * which is not a fact any caller holds — it is derived from delivered requests
 * inside the transaction that creates the row. Accepting it would make the
 * entitlement as trustworthy as the least careful call site.
 */
export interface AdmitUserRegenerationInput {
  readonly id: string;
  readonly generationSceneId: string;
  readonly requestedByUserId: string;
}

export type AdmitUserRegenerationOutcome =
  | { readonly kind: "ADMITTED"; readonly request: SceneGenerationRequestRecord }
  | { readonly kind: "SCENE_NOT_FOUND" }
  | { readonly kind: "ENTITLEMENT_EXHAUSTED" }
  | { readonly kind: "REGENERATION_ALREADY_ACTIVE" };

/**
 * One provider attempt, in the orchestration vocabulary.
 *
 * A projection of the existing `scene_generations` row, not a second table.
 * Legacy rows have `generationSceneRequestId === null` and are readable but
 * never orchestrated.
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
  /**
   * The pricing contract this attempt was admitted against.
   *
   * Copied from the snapshot at admission and never supplied by a caller. It is
   * what lets the provider boundary check that the cost decision belongs to
   * *this* attempt rather than merely existing.
   */
  readonly pricingContractKey: string;
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

/**
 * Transaction C's input: admitting one provider attempt.
 *
 * Everything absent from this shape is absent because something else already
 * owns it, and two caller-controlled copies of one fact will eventually
 * disagree.
 *
 * - **`requestHash`** is derived, never supplied. A caller offering its own
 *   V2-prefixed digest for identical request facts walks straight past the
 *   active-request identity protection, which is the whole defence against
 *   paying twice for one request.
 * - **`videoProjectId`** is resolved through request → scene → job → project:
 *   a caller-supplied project id chooses which tenant's history this joins.
 * - **`attemptKind` and `attemptOrdinal`** are derived from the attempts that
 *   already exist. A caller could otherwise make the first attempt a
 *   `SYSTEM_RECOVERY`, or file a second `PRIMARY`.
 * - **The scene's facts** — asset, prompt, duration, camera motion,
 *   provenance — come from the parent `GenerationScene`.
 * - **The job's facts** — target resolution and aspect ratio — come from the
 *   parent `GenerationJob`'s frozen snapshot.
 *
 * What remains is the delivery plan: which provider and model this request is
 * routed to, and how the native output reconciles with the target. This phase
 * does not own the model-routing catalog, so those stay explicit — but every
 * one of them participates in the derived hash.
 */
export interface AdmitGenerationAttemptInput {
  readonly id: string;
  readonly generationSceneRequestId: string;
  readonly providerName: string;
  readonly providerModelId: string;
  /** The V2 model identity. Required: a new attempt may not be admitted V1. */
  readonly requestModelKey: string;
  readonly requestRenderedPrompt: string;
  readonly requestNativeGenerationResolution: string;
  readonly requestResolutionNormalization: ResolutionNormalization;
  readonly requestNativeMeetsTarget: boolean;
  /** The pricing decision. Bound to this attempt on every dimension that moves cost. */
  readonly pricingSnapshotId: string;
  readonly pricingSnapshot: PricingSnapshot;
  /**
   * The exact immutable rate the snapshot names, when it names one.
   *
   * Required when `pricingSnapshot.fxSnapshotId` is non-null and forbidden
   * otherwise: a snapshot naming a rate nobody can produce is an audit record
   * that cannot be re-derived.
   */
  readonly fxSnapshot: FxSnapshot | null;
}

export type AdmitGenerationAttemptOutcome =
  | { readonly kind: "ADMITTED"; readonly attempt: GenerationAttempt }
  | { readonly kind: "REQUEST_NOT_FOUND" }
  /** The parent request is DELIVERED, FAILED_TERMINAL or CANCELLED. */
  | { readonly kind: "REQUEST_NOT_ADMITTING" }
  /**
   * Another attempt under the same logical request is still live.
   *
   * System recovery is sequential recovery from a finished attempt, not
   * permission to run two paid attempts at once.
   */
  | { readonly kind: "ATTEMPT_ALREADY_ACTIVE" }
  /** The scene lacks a fact a V2 executable request requires. */
  | { readonly kind: "SCENE_FACTS_INCOMPLETE" }
  | { readonly kind: "PRICING_BINDING_INVALID"; readonly reason: PricingBindingFailure }
  | { readonly kind: "FX_BINDING_INVALID"; readonly reason: FxBindingFailure };

/**
 * Why a pricing decision does not belong to the attempt it was offered for.
 *
 * Provider and model key are not enough. A snapshot priced for five seconds
 * attached to a fifteen-second scene understates the cost by two thirds with
 * every other field agreeing, and a native tier is a pricing dimension in its
 * own right.
 */
export type PricingBindingFailure =
  | "PROVIDER_MISMATCH"
  | "MODEL_KEY_MISMATCH"
  | "CONTRACT_KEY_MISMATCH"
  | "DURATION_MISMATCH"
  | "NATIVE_TIER_MISMATCH"
  | "GENERATION_MODE_UNSUPPORTED"
  | "AUDIO_MODE_UNSUPPORTED"
  | "RISK_PROFILE_MISMATCH"
  | "SNAPSHOT_MISSING"
  | "SNAPSHOT_NOT_FOR_ATTEMPT";

/** Why the supplied exchange rate does not match the snapshot that names it. */
export type FxBindingFailure =
  | "FX_SNAPSHOT_REQUIRED"
  | "FX_SNAPSHOT_UNEXPECTED"
  | "FX_SNAPSHOT_ID_MISMATCH"
  | "FX_SNAPSHOT_INVALID"
  | "FX_SNAPSHOT_CONFLICT";

export interface GenerationTransitionEventRecord {
  readonly id: string;
  readonly organizationId: string;
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

/**
 * Edges the generic transition APIs deliberately refuse.
 *
 * Adding an atomic primitive achieves nothing if the same edge stays reachable
 * through a generic method beside it: a caller would still be able to produce a
 * `RESERVED` job with no reservation, which is exactly the state Transaction B
 * exists to prevent.
 *
 * Three groups, for three reasons:
 *
 * - **`RESERVING -> RESERVED` on a job** belongs to `reserve()`.
 * - **`PENDING -> GENERATING` on a request** belongs to attempt admission: the
 *   request starts generating *because* an attempt exists.
 * - **`GENERATING -> DELIVERED` on a request**, and the pair
 *   `DELIVERABLE_VALIDATING -> DELIVERABLE_READY` with `-> CONSUMED`, belong to
 *   Transactions F and G, which are deferred. Delivery consumes a customer's
 *   regeneration right and `CONSUMED` spends their unit; exposing either alone
 *   would make an incomplete workflow executable, and the missing halves —
 *   output verification and the quota ledger — are what make it safe.
 *
 * The pure state machines still describe these edges: they are legal moves with
 * no persistence route yet, which is the honest description of deferred work.
 * Tests needing such rows seed them through raw Prisma.
 */
export type ReservedTransitionOutcome = { readonly kind: "TRANSITION_RESERVED" };

export interface GenerationJobRepository {
  /**
   * Create a job and its first transition event in one transaction.
   *
   * Derives the entitlement arithmetic rather than accepting it, and refuses a
   * duration the product does not sell.
   */
  create(
    organizationId: string,
    job: NewGenerationJob,
    context: TransitionContext,
  ): Promise<CreateGenerationJobOutcome>;
  findById(organizationId: string, id: string): Promise<GenerationJob | null>;
  /**
   * Refuses `RESERVING -> RESERVED` (Transaction B) and
   * `DELIVERABLE_VALIDATING -> DELIVERABLE_READY` (Transaction G, deferred).
   */
  transition(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedState: GenerationJobState;
    readonly expectedVersion: number;
    readonly nextState: GenerationJobState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationJob> | ReservedTransitionOutcome>;
}

export interface GenerationReservationRepository {
  /**
   * Transaction B, as one commit.
   *
   * Creates the reservation, moves the job `RESERVING -> RESERVED`, and writes
   * both transition events together. Split across two commits — as an earlier
   * version was — a crash between them leaves a reservation whose job never
   * moved, or a moved job with no hold behind it, and neither row can tell.
   */
  reserve(
    organizationId: string,
    input: ReserveGenerationJobInput,
    context: TransitionContext,
  ): Promise<ReserveGenerationJobOutcome>;
  findByJobId(
    organizationId: string,
    generationJobId: string,
  ): Promise<GenerationReservation | null>;
  /** Refuses `-> CONSUMED` (Transaction G, deferred). */
  transition(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedState: GenerationReservationState;
    readonly expectedVersion: number;
    readonly nextState: GenerationReservationState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationReservation> | ReservedTransitionOutcome>;
}

export interface GenerationSceneRepository {
  create(
    organizationId: string,
    scene: NewGenerationScene,
    context: TransitionContext,
  ): Promise<GenerationScene | null>;
  findById(organizationId: string, id: string): Promise<GenerationScene | null>;
  listByJobId(
    organizationId: string,
    generationJobId: string,
  ): Promise<readonly GenerationScene[]>;
  transition(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedState: GenerationSceneState;
    readonly expectedVersion: number;
    readonly nextState: GenerationSceneState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<GenerationScene>>;
}

export interface SceneGenerationRequestRepository {
  /** The one initial request for a scene. A second is refused by the database. */
  createInitial(
    organizationId: string,
    input: {
      readonly id: string;
      readonly generationSceneId: string;
      readonly requestedByUserId: string | null;
    },
    context: TransitionContext,
  ): Promise<SceneGenerationRequestRecord | null>;

  /**
   * Admit a user regeneration, deriving its ordinal inside the transaction.
   *
   * Refuses when the entitlement is spent or another regeneration is already in
   * flight for the scene — the second is what stops two concurrent admissions
   * from both claiming the same ordinal.
   */
  admitUserRegeneration(
    organizationId: string,
    input: AdmitUserRegenerationInput,
    context: TransitionContext,
  ): Promise<AdmitUserRegenerationOutcome>;

  findById(organizationId: string, id: string): Promise<SceneGenerationRequestRecord | null>;
  listBySceneId(
    organizationId: string,
    generationSceneId: string,
  ): Promise<readonly SceneGenerationRequestRecord[]>;
  /**
   * Refuses `PENDING -> GENERATING` (attempt admission owns it) and
   * `GENERATING -> DELIVERED` (Transaction F, deferred).
   */
  transition(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedState: SceneGenerationRequestState;
    readonly expectedVersion: number;
    readonly nextState: SceneGenerationRequestState;
    readonly context: TransitionContext;
  }): Promise<TransitionOutcome<SceneGenerationRequestRecord> | ReservedTransitionOutcome>;
}

/**
 * What a worker receives when it asks for the right to call a provider.
 *
 * `ARMED` is the *only* value that authorizes an outbound call, and it is
 * returned only after the transaction that moved the attempt into `SUBMITTING`
 * has committed. `PRICING_BINDING_INVALID` is a refusal rather than a throw:
 * an attempt whose cost decision does not belong to it is unarmable, which is
 * an outcome a worker must handle, not a crash.
 */
export type ArmProviderBoundaryOutcome =
  | { readonly kind: "ARMED"; readonly attempt: GenerationAttempt }
  | { readonly kind: "LOST" }
  | { readonly kind: "MISSING_PRICING_SNAPSHOT" }
  | { readonly kind: "PRICING_BINDING_INVALID"; readonly reason: PricingBindingFailure };

export interface SceneGenerationAttemptRepository {
  /**
   * Transaction C, as one commit.
   *
   * Creates the attempt row, its pricing snapshot and its first event
   * together. Split apart, a crash between them leaves an admitted attempt
   * with no cost decision — which the provider boundary would then refuse
   * forever, stranding work nobody can explain.
   */
  admit(
    organizationId: string,
    input: AdmitGenerationAttemptInput,
    context: TransitionContext,
  ): Promise<AdmitGenerationAttemptOutcome>;

  findById(organizationId: string, id: string): Promise<GenerationAttempt | null>;
  listByRequestId(
    organizationId: string,
    generationSceneRequestId: string,
  ): Promise<readonly GenerationAttempt[]>;

  /**
   * Move `QUEUED -> SUBMITTING` under compare-and-set, having first proved the
   * pricing decision belongs to *this* attempt.
   *
   * Existence is not enough. An earlier version checked only that some snapshot
   * was present, which would have authorized a WaveSpeed attempt using a fal
   * cost decision — an audit record that cannot be re-derived and a future cost
   * gate reading the wrong price.
   */
  armProviderBoundary(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedVersion: number;
    readonly context: TransitionContext;
  }): Promise<ArmProviderBoundaryOutcome>;

  /** Persist a provider submission outcome atomically with its event. */
  recordSubmissionOutcome(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly expectedVersion: number;
    readonly outcome: AttemptOutcomePersistence;
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

/**
 * Read-only.
 *
 * A pricing snapshot is written by attempt admission and never afterwards.
 * There is no create method here, and no update or delete anywhere: the row is
 * the record of what the platform believed a call would cost when it
 * authorized the call.
 */
export interface GenerationPricingSnapshotRepository {
  findByAttemptId(
    organizationId: string,
    sceneGenerationId: string,
  ): Promise<GenerationPricingSnapshotRecord | null>;
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
    organizationId: string,
    aggregateType: GenerationTransitionAggregateType,
    aggregateId: string,
  ): Promise<readonly GenerationTransitionEventRecord[]>;
  listForCorrelation(
    organizationId: string,
    correlationId: string,
  ): Promise<readonly GenerationTransitionEventRecord[]>;
}
