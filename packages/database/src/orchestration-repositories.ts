import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AdmitGenerationAttemptInput,
  AdmitGenerationAttemptOutcome,
  AdmitUserRegenerationInput,
  AdmitUserRegenerationOutcome,
  ArmProviderBoundaryOutcome,
  CreateGenerationJobOutcome,
  GenerationAttempt,
  GenerationJob,
  GenerationJobRepository,
  GenerationPricingSnapshotRecord,
  GenerationPricingSnapshotRepository,
  GenerationReservation,
  GenerationReservationRepository,
  GenerationScene,
  GenerationSceneRepository,
  GenerationTransitionAggregateType,
  GenerationTransitionEventRecord,
  GenerationTransitionEventRepository,
  NewGenerationJob,
  NewGenerationScene,
  FxBindingFailure,
  FxSnapshot,
  GenerationRequestFacts,
  PricingBindingFailure,
  PricingSnapshot,
  ReservedTransitionOutcome,
  ReserveGenerationJobInput,
  ReserveGenerationJobOutcome,
  SceneGenerationAttemptRepository,
  SceneGenerationRequestRecord,
  SceneGenerationRequestRepository,
  TransitionContext,
  TransitionOutcome,
} from "@app/domain";
import {
  AUTHORIZED_AUDIO_MODE,
  AUTHORIZED_GENERATION_MODE,
  canTransitionAttempt,
  canTransitionJob,
  canTransitionReservation,
  canTransitionScene,
  canTransitionSceneRequest,
  computeGenerationRequestHash,
  isTargetOutputResolution,
  nextUserRegenerationOrdinal,
  requiredUnitsFor,
  riskProfileKeyForQualityTier,
  sanitizeTransitionMetadata,
  validateFxSnapshot,
} from "@app/domain";
import { AppError, randomId } from "@app/shared";

/**
 * Persistence for generation orchestration.
 *
 * Three rules shape every method here, and each exists because these rows
 * decide whether a paid provider call happens.
 *
 * **There is no open write.** No `update(id, fields)`, no `setState`. Every
 * mutation names the state and version it believes it is replacing, and the
 * database refuses if either has moved.
 *
 * **A state change and its transition event commit together, or neither does.**
 * A state with no event is history the system cannot explain; an event with no
 * state change is history that did not happen.
 *
 * **Every operation is tenant-scoped, in the same predicate as the CAS.** An id
 * is not an authorization. Ownership is resolved through the `VideoProject`
 * boundary the rest of the schema already uses, and a cross-tenant id behaves
 * exactly like a missing one — no read, no mutation, no event, and no
 * disclosure that the row exists.
 */

type Tx = Prisma.TransactionClient;

const EVENT_ID_PREFIX = "genevt";

/**
 * Edges the generic transition methods refuse, because an atomic primitive owns
 * them.
 *
 * Exposing an edge beside the transaction that owns it defeats the transaction:
 * a caller could still produce a `RESERVED` job with no reservation, or mark a
 * request delivered without the output verification that makes delivery mean
 * anything. Listed as data so the refusal is one lookup rather than three
 * conditionals that can drift apart.
 */
const JOB_RESERVED_EDGES: readonly `${string}->${string}`[] = [
  // Transaction B owns this.
  "RESERVING->RESERVED",
  // Transaction G owns this, and Transaction G is deferred.
  "DELIVERABLE_VALIDATING->DELIVERABLE_READY",
];

const REQUEST_RESERVED_EDGES: readonly `${string}->${string}`[] = [
  // Attempt admission owns this: the request generates *because* an attempt
  // exists, and the two must become true together.
  "PENDING->GENERATING",
  // Transaction F owns this, and Transaction F is deferred. Delivery consumes
  // a customer regeneration right; the half that makes it safe — output
  // verification — does not exist yet.
  "GENERATING->DELIVERED",
];

const RESERVATION_RESERVED_EDGES: readonly `${string}->${string}`[] = [
  // Transaction G owns this: consuming a unit and marking a deliverable ready
  // are one fact, and the quota ledger is deferred.
  "RESERVED->CONSUMED",
  "RECONCILIATION_HOLD->CONSUMED",
];

function isReservedEdge(
  reserved: readonly string[],
  from: string,
  to: string,
): boolean {
  return reserved.includes(`${from}->${to}`);
}

/**
 * Is this the active-regeneration index refusing a second in-flight request?
 *
 * Matched narrowly. Prisma reports every unique violation as `P2002`, and
 * translating them all would turn an unrelated collision — a duplicate id, a
 * future constraint — into a cheerful "someone else is already doing this",
 * which is the kind of mistranslation that hides a real defect for months.
 */
function isActiveRegenerationConflict(error: unknown): boolean {
  if ((error as { code?: unknown }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  // A partial index reports its own name rather than a field list.
  if (typeof target === "string") {
    return target === "scene_generation_requests_active_key";
  }
  if (Array.isArray(target)) {
    return target.map(String).includes("scene_generation_requests_active_key");
  }
  return false;
}

/** Attempt states in which the provider may hold and bill for this attempt. */
const ACTIVE_ORCHESTRATION_STATES = [
  "QUEUED",
  "SUBMITTING",
  "PROCESSING",
  "RECONCILIATION_PENDING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
] as const;

/**
 * Append one transition event, allocating its per-aggregate sequence.
 *
 * The sequence is `MAX + 1` read inside the caller's transaction. Two
 * concurrent writers can read the same maximum, and the unique index on
 * `(aggregateType, aggregateId, sequence)` then fails one of them — the correct
 * outcome, since those two writers were competing for the same CAS anyway.
 *
 * `organizationId` is a parameter, never read out of `safeMetadata`. Metadata
 * is caller-supplied decoration; tenancy is a fact the scoped operation already
 * established, and taking it from the decoration would let a caller relabel
 * whose history an event joins.
 */
async function appendEvent(
  tx: Tx,
  input: {
    readonly organizationId: string;
    readonly aggregateType: GenerationTransitionAggregateType;
    readonly aggregateId: string;
    readonly fromState: string | null;
    readonly toState: string;
    readonly context: TransitionContext;
  },
): Promise<void> {
  const highest = await tx.generationTransitionEvent.aggregate({
    where: { aggregateType: input.aggregateType, aggregateId: input.aggregateId },
    _max: { sequence: true },
  });
  // Sanitized again at the boundary even though the context type says it is
  // already safe. A structural type is a promise about shape, not about origin,
  // and this is the last place a prompt can be stopped.
  const safeMetadata = sanitizeTransitionMetadata(input.context.metadata);

  await tx.generationTransitionEvent.create({
    data: {
      id: randomId(EVENT_ID_PREFIX),
      organizationId: input.organizationId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      sequence: (highest._max.sequence ?? 0) + 1,
      fromState: input.fromState,
      toState: input.toState,
      eventType: input.context.eventType,
      actorType: input.context.actorType,
      actorUserId: input.context.actorUserId,
      reasonCode: input.context.reasonCode,
      correlationId: input.context.correlationId,
      causationId: input.context.causationId,
      safeMetadata: safeMetadata as Prisma.InputJsonValue,
    },
  });
}

function assertLegal(legal: boolean, from: string, to: string, aggregate: string): void {
  if (!legal) {
    throw new AppError("INTERNAL_ERROR", `Illegal ${aggregate} transition ${from} -> ${to}`, {
      details: { from, to, aggregate },
    });
  }
}

/**
 * The tenant predicate, written once.
 *
 * Every scoped query nests through to `videoProject.organizationId`. Expressed
 * as a filter rather than as a separate ownership lookup so it lands in the
 * same statement as the CAS: a check-then-act would be a window in which the
 * row could change hands between the two.
 */
const jobScope = (organizationId: string) => ({ videoProject: { organizationId } });
const sceneScope = (organizationId: string) => ({
  generationJob: { videoProject: { organizationId } },
});
const requestScope = (organizationId: string) => ({
  generationScene: { generationJob: { videoProject: { organizationId } } },
});
const attemptScope = (organizationId: string) => ({ videoProject: { organizationId } });

type JobRow = NonNullable<Awaited<ReturnType<PrismaClient["generationJob"]["findFirst"]>>>;
type ReservationRow = NonNullable<
  Awaited<ReturnType<PrismaClient["generationReservation"]["findFirst"]>>
>;
type SceneRow = NonNullable<Awaited<ReturnType<PrismaClient["generationScene"]["findFirst"]>>>;
type RequestRow = NonNullable<
  Awaited<ReturnType<PrismaClient["sceneGenerationRequest"]["findFirst"]>>
>;

function toJob(r: JobRow, organizationId: string): GenerationJob {
  return {
    id: r.id,
    videoProjectId: r.videoProjectId,
    organizationId,
    requestedByUserId: r.requestedByUserId,
    qualityTier: r.qualityTier,
    // Validated on the way in; a row that predates the constraint cannot exist
    // because the column arrived with it.
    targetOutputResolution: r.targetOutputResolution as GenerationJob["targetOutputResolution"],
    targetAspectRatio: r.targetAspectRatio,
    requestedDurationSeconds: r.requestedDurationSeconds,
    requiredVideoUnits: r.requiredVideoUnits,
    requiredHighQualityUnits: r.requiredHighQualityUnits,
    state: r.state,
    stateVersion: r.stateVersion,
    currentDeliverableVersionId: r.currentDeliverableVersionId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toReservation(r: ReservationRow): GenerationReservation {
  return {
    id: r.id,
    generationJobId: r.generationJobId,
    billingCycleKey: r.billingCycleKey,
    billingCycleStartedAt: r.billingCycleStartedAt,
    billingCycleEndsAt: r.billingCycleEndsAt,
    reservedTotalVideoUnits: r.reservedTotalVideoUnits,
    reservedHighQualityUnits: r.reservedHighQualityUnits,
    state: r.state,
    stateVersion: r.stateVersion,
    reservedAt: r.reservedAt,
    consumedAt: r.consumedAt,
    releasedAt: r.releasedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toScene(r: SceneRow): GenerationScene {
  return {
    id: r.id,
    generationJobId: r.generationJobId,
    position: r.position,
    sourceStoryboardSceneId: r.sourceStoryboardSceneId,
    sourceAssetId: r.sourceAssetId,
    sourceAnalysisRevision: r.sourceAnalysisRevision,
    snapshotDurationSeconds: r.snapshotDurationSeconds,
    snapshotCameraMotion: r.snapshotCameraMotion,
    snapshotCompiledPrompt: r.snapshotCompiledPrompt,
    state: r.state,
    stateVersion: r.stateVersion,
    currentDeliveredRequestId: r.currentDeliveredRequestId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toRequest(r: RequestRow): SceneGenerationRequestRecord {
  return {
    id: r.id,
    generationSceneId: r.generationSceneId,
    kind: r.kind,
    userRegenerationOrdinal: r.userRegenerationOrdinal,
    state: r.state,
    stateVersion: r.stateVersion,
    requestedByUserId: r.requestedByUserId,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
    failedAt: r.failedAt,
  };
}

const ATTEMPT_SELECT = {
  id: true,
  videoProjectId: true,
  generationSceneRequestId: true,
  attemptOrdinal: true,
  attemptKind: true,
  orchestrationState: true,
  submissionCertainty: true,
  pricingContractKey: true,
  stateVersion: true,
  providerName: true,
  providerModelId: true,
  requestHash: true,
  providerPredictionId: true,
  submissionBoundaryEnteredAt: true,
  providerAcceptedAt: true,
  reconciliationStartedAt: true,
  reconciliationDeadlineAt: true,
  reconciliationResolvedAt: true,
  normalizedErrorCode: true,
  outputStorageKey: true,
  createdAt: true,
} as const;

type AttemptRow = {
  id: string;
  videoProjectId: string;
  generationSceneRequestId: string | null;
  attemptOrdinal: number | null;
  attemptKind: GenerationAttempt["attemptKind"] | null;
  orchestrationState: GenerationAttempt["orchestrationState"] | null;
  submissionCertainty: GenerationAttempt["submissionCertainty"] | null;
  pricingContractKey: string | null;
  stateVersion: number;
  providerName: string;
  providerModelId: string;
  requestHash: string;
  providerPredictionId: string | null;
  submissionBoundaryEnteredAt: Date | null;
  providerAcceptedAt: Date | null;
  reconciliationStartedAt: Date | null;
  reconciliationDeadlineAt: Date | null;
  reconciliationResolvedAt: Date | null;
  normalizedErrorCode: string | null;
  outputStorageKey: string | null;
  createdAt: Date;
};

/**
 * An orchestration-admitted attempt.
 *
 * Throws on a legacy row rather than returning a half-populated value. Legacy
 * rows are readable through the existing `SceneGeneration` repository, which is
 * where they belong; forcing them through this shape would mean inventing an
 * attempt kind, a certainty and a pricing contract they never had.
 */
function toAttempt(r: AttemptRow): GenerationAttempt {
  if (
    r.generationSceneRequestId === null ||
    r.attemptOrdinal === null ||
    r.attemptKind === null ||
    r.orchestrationState === null ||
    r.submissionCertainty === null ||
    r.pricingContractKey === null
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Scene generation row predates orchestration and has no attempt projection",
      { details: { id: r.id } },
    );
  }
  return {
    id: r.id,
    videoProjectId: r.videoProjectId,
    generationSceneRequestId: r.generationSceneRequestId,
    attemptOrdinal: r.attemptOrdinal,
    attemptKind: r.attemptKind,
    orchestrationState: r.orchestrationState,
    submissionCertainty: r.submissionCertainty,
    pricingContractKey: r.pricingContractKey,
    stateVersion: r.stateVersion,
    providerName: r.providerName,
    providerModelId: r.providerModelId,
    requestHash: r.requestHash,
    providerPredictionId: r.providerPredictionId,
    submissionBoundaryEnteredAt: r.submissionBoundaryEnteredAt,
    providerAcceptedAt: r.providerAcceptedAt,
    reconciliationStartedAt: r.reconciliationStartedAt,
    reconciliationDeadlineAt: r.reconciliationDeadlineAt,
    reconciliationResolvedAt: r.reconciliationResolvedAt,
    normalizedErrorCode: r.normalizedErrorCode,
    outputStorageKey: r.outputStorageKey,
    createdAt: r.createdAt,
  };
}

/**
 * Does this cost decision belong to this attempt?
 *
 * Seven questions, not three. An earlier version asked only whether *a*
 * snapshot existed, which would have authorized a WaveSpeed attempt against a
 * fal cost decision. Matching provider and model key alone is still not enough:
 * a snapshot priced for five seconds attached to a fifteen-second scene
 * understates the cost by two thirds with every other field agreeing, and the
 * native tier is a pricing dimension of its own.
 *
 * Every comparison is opaque equality. Nothing parses `768P` or `1080p` — a
 * renamed tier must become a mismatch rather than a silently reinterpreted one.
 */
function checkPricingBinding(input: {
  readonly snapshot: {
    readonly provider: string;
    readonly contractKey: string;
    readonly requestedSeconds: number;
    readonly riskProfileKey: string;
    readonly identity: {
      readonly pricingModelKey: string;
      readonly nativeTier: string;
      readonly generationMode: string;
      readonly audioMode: string;
    };
  };
  readonly attemptProvider: string;
  readonly attemptModelKey: string | null;
  readonly attemptNativeTier: string;
  readonly sceneDurationSeconds: number;
  readonly jobQualityTier: "NORMAL" | "HIGH_QUALITY";
  /** Present only at the provider boundary, where the row already carries one. */
  readonly attemptContractKey?: string;
}): PricingBindingFailure | null {
  const { snapshot } = input;
  if (snapshot.provider !== input.attemptProvider) return "PROVIDER_MISMATCH";
  // A newly orchestrated attempt must carry the V2 model identity; a null here
  // is a V1/ambiguous attempt, which may not be newly admitted.
  if (input.attemptModelKey === null) return "MODEL_KEY_MISMATCH";
  if (snapshot.identity.pricingModelKey !== input.attemptModelKey) return "MODEL_KEY_MISMATCH";
  if (snapshot.requestedSeconds !== input.sceneDurationSeconds) return "DURATION_MISMATCH";
  if (snapshot.identity.nativeTier !== input.attemptNativeTier) return "NATIVE_TIER_MISMATCH";
  // The product has no audio-enabled generation contract, so an identity that
  // prices one describes work no attempt here can represent.
  if (snapshot.identity.generationMode !== AUTHORIZED_GENERATION_MODE) {
    return "GENERATION_MODE_UNSUPPORTED";
  }
  if (snapshot.identity.audioMode !== AUTHORIZED_AUDIO_MODE) return "AUDIO_MODE_UNSUPPORTED";
  // A HIGH_QUALITY job planned at the 30% normal buffer under-plans every
  // attempt by twenty points, and does it invisibly: both halves look
  // internally consistent.
  if (snapshot.riskProfileKey !== riskProfileKeyForQualityTier(input.jobQualityTier)) {
    return "RISK_PROFILE_MISMATCH";
  }
  if (
    input.attemptContractKey !== undefined &&
    snapshot.contractKey !== input.attemptContractKey
  ) {
    return "CONTRACT_KEY_MISMATCH";
  }
  return null;
}

/**
 * Persist the exact rate a pricing snapshot names, or explain why it cannot.
 *
 * A snapshot naming an FX id nobody can produce is an audit record that cannot
 * be re-derived — the same failure the contract fingerprint exists to prevent
 * one level up. So the rate itself is required whenever the snapshot names one,
 * validated through the pricing domain's own canonical check, and stored inside
 * this transaction.
 *
 * A row that already exists is compared field by field rather than reused. Two
 * different rates under one id is a conflict, not a cache hit, and silently
 * accepting the stored one would price an attempt against a rate its snapshot
 * never saw. Nothing here updates an existing row or fetches anything.
 */
async function bindFxSnapshot(
  tx: Tx,
  snapshot: PricingSnapshot,
  supplied: FxSnapshot | null,
): Promise<FxBindingFailure | null> {
  if (snapshot.fxSnapshotId === null) {
    return supplied === null ? null : "FX_SNAPSHOT_UNEXPECTED";
  }
  if (supplied === null) return "FX_SNAPSHOT_REQUIRED";
  if (supplied.id !== snapshot.fxSnapshotId) return "FX_SNAPSHOT_ID_MISMATCH";

  const validated = validateFxSnapshot(supplied);
  if (!validated.ok) return "FX_SNAPSHOT_INVALID";

  const existing = await tx.fxRateSnapshot.findUnique({ where: { id: supplied.id } });
  if (existing === null) {
    await tx.fxRateSnapshot.create({
      data: {
        id: supplied.id,
        baseCurrency: supplied.baseCurrency,
        quoteCurrency: supplied.quoteCurrency,
        rateNumerator: BigInt(supplied.rateNumerator),
        rateDenominator: BigInt(supplied.rateDenominator),
        effectiveAtEpochMs: BigInt(supplied.effectiveAt),
        sourceReference: supplied.sourceReference,
      },
    });
    return null;
  }

  const identical =
    existing.baseCurrency === supplied.baseCurrency &&
    existing.quoteCurrency === supplied.quoteCurrency &&
    existing.rateNumerator === BigInt(supplied.rateNumerator) &&
    existing.rateDenominator === BigInt(supplied.rateDenominator) &&
    existing.effectiveAtEpochMs === BigInt(supplied.effectiveAt) &&
    existing.sourceReference === supplied.sourceReference;
  return identical ? null : "FX_SNAPSHOT_CONFLICT";
}

export function createGenerationJobRepository(prisma: PrismaClient): GenerationJobRepository {
  return {
    /**
     * Admit a job, deriving its entitlement arithmetic.
     *
     * The unit counts are not accepted from the caller: they are a
     * deterministic function of duration and quality tier, and accepting them
     * made a 90-second job holding one unit constructible. A duration the
     * product does not sell is refused rather than converted into more units.
     */
    async create(
      organizationId: string,
      job: NewGenerationJob,
      context: TransitionContext,
    ): Promise<CreateGenerationJobOutcome> {
      const units = requiredUnitsFor(job.qualityTier, job.requestedDurationSeconds);
      if (!units.ok) return { kind: "DURATION_NOT_SUPPORTED" };

      // Ownership is proved before anything is written, and the write itself
      // carries the derived facts rather than the caller's.
      // The output configuration is snapshotted here and never read from the
      // project again. Project settings are mutable; an attempt admitted three
      // days later must be generated for what the customer started.
      const project = await prisma.videoProject.findFirst({
        where: { id: job.videoProjectId, organizationId },
        select: { id: true, targetOutputResolution: true, aspectRatio: true },
      });
      if (project === null) return { kind: "PROJECT_NOT_FOUND" };
      // The project's value was validated when it was written; this refuses
      // rather than widening the product vocabulary a second time.
      if (!isTargetOutputResolution(project.targetOutputResolution)) {
        return { kind: "PROJECT_NOT_FOUND" };
      }

      return prisma.$transaction(async (tx) => {
        const row = await tx.generationJob.create({
          data: {
            id: job.id,
            videoProjectId: job.videoProjectId,
            requestedByUserId: job.requestedByUserId,
            qualityTier: job.qualityTier,
            targetOutputResolution: project.targetOutputResolution,
            targetAspectRatio: project.aspectRatio,
            requestedDurationSeconds: job.requestedDurationSeconds,
            requiredVideoUnits: units.value.totalVideoUnits,
            requiredHighQualityUnits: units.value.highQualityUnits,
            state: "CREATED",
          },
        });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "JOB",
          aggregateId: row.id,
          fromState: null,
          toState: "CREATED",
          context,
        });
        return { kind: "CREATED" as const, job: toJob(row, organizationId) };
      });
    },

    async findById(organizationId, id) {
      const row = await prisma.generationJob.findFirst({
        where: { id, ...jobScope(organizationId) },
      });
      return row === null ? null : toJob(row, organizationId);
    },

    async transition(
      input,
    ): Promise<TransitionOutcome<GenerationJob> | ReservedTransitionOutcome> {
      if (isReservedEdge(JOB_RESERVED_EDGES, input.expectedState, input.nextState)) {
        return { kind: "TRANSITION_RESERVED" };
      }
      assertLegal(
        canTransitionJob(input.expectedState, input.nextState),
        input.expectedState,
        input.nextState,
        "generation job",
      );
      return prisma.$transaction(async (tx) => {
        // `updateMany` rather than `update`: `update` needs a unique selector
        // and cannot carry the state, version and tenant predicates that make
        // this a compare-and-set. Zero rows means someone else moved it — or it
        // was never this tenant's to move.
        const { count } = await tx.generationJob.updateMany({
          where: {
            id: input.id,
            state: input.expectedState,
            stateVersion: input.expectedVersion,
            ...jobScope(input.organizationId),
          },
          data: { state: input.nextState, stateVersion: { increment: 1 } },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "JOB",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationJob.findFirst({
          where: { id: input.id, ...jobScope(input.organizationId) },
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Generation job vanished inside its own transition");
        }
        return { kind: "APPLIED" as const, value: toJob(row, input.organizationId) };
      });
    },
  };
}

export function createGenerationReservationRepository(
  prisma: PrismaClient,
): GenerationReservationRepository {
  return {
    /**
     * Transaction B: create the hold and move the job, in one commit.
     *
     * Split into two commits — as an earlier version was — a crash between them
     * leaves a reservation whose job never moved, or a moved job with no hold
     * behind it, and neither row carries enough to tell which happened.
     *
     * The unit counts are **copied from the job**, never accepted. A
     * reservation covering fewer units than the job it belongs to is an
     * under-charge no reconciliation could detect, because both rows would look
     * internally consistent.
     */
    async reserve(
      organizationId: string,
      input: ReserveGenerationJobInput,
      context: TransitionContext,
    ): Promise<ReserveGenerationJobOutcome> {
      return prisma.$transaction(async (tx): Promise<ReserveGenerationJobOutcome> => {
        const job = await tx.generationJob.findFirst({
          where: { id: input.generationJobId, ...jobScope(organizationId) },
        });
        // A cross-tenant or missing job is LOST, not a distinguishable error:
        // telling a caller which of the two it was discloses existence.
        if (job === null) return { kind: "LOST" };

        const existing = await tx.generationReservation.findUnique({
          where: { generationJobId: input.generationJobId },
          select: { id: true },
        });
        if (existing !== null) return { kind: "ALREADY_RESERVED" };

        const moved = await tx.generationJob.updateMany({
          where: {
            id: input.generationJobId,
            state: "RESERVING",
            stateVersion: input.expectedJobVersion,
            ...jobScope(organizationId),
          },
          data: { state: "RESERVED", stateVersion: { increment: 1 } },
        });
        if (moved.count === 0) return { kind: "LOST" };

        // The reservation is created RESERVING and then actually moved to
        // RESERVED inside this same commit. An earlier version inserted it
        // directly as RESERVED while writing history claiming a
        // RESERVING -> RESERVED transition — the final row was right and the
        // event stream described a state change that never happened, which is
        // precisely the "event without an aggregate change" this phase forbids.
        // Nothing observes the intermediate state: the transaction is atomic.
        const created = await tx.generationReservation.create({
          data: {
            id: input.reservationId,
            generationJobId: input.generationJobId,
            billingCycleKey: input.billingCycleKey,
            billingCycleStartedAt: input.billingCycleStartedAt,
            billingCycleEndsAt: input.billingCycleEndsAt,
            // Copied from the job, which was itself derived at admission.
            reservedTotalVideoUnits: job.requiredVideoUnits,
            reservedHighQualityUnits: job.requiredHighQualityUnits,
            state: "RESERVING",
            stateVersion: 0,
          },
        });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "RESERVATION",
          aggregateId: created.id,
          fromState: null,
          toState: "RESERVING",
          context,
        });

        const held = await tx.generationReservation.updateMany({
          where: { id: created.id, state: "RESERVING", stateVersion: 0 },
          data: { state: "RESERVED", stateVersion: { increment: 1 } },
        });
        if (held.count === 0) {
          throw new AppError("INTERNAL_ERROR", "Reservation vanished inside its own creation");
        }
        await appendEvent(tx, {
          organizationId,
          aggregateType: "RESERVATION",
          aggregateId: created.id,
          fromState: "RESERVING",
          toState: "RESERVED",
          context,
        });
        const reservation = await tx.generationReservation.findUniqueOrThrow({
          where: { id: created.id },
        });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "JOB",
          aggregateId: input.generationJobId,
          fromState: "RESERVING",
          toState: "RESERVED",
          context,
        });

        const reloaded = await tx.generationJob.findFirst({
          where: { id: input.generationJobId, ...jobScope(organizationId) },
        });
        if (reloaded === null) {
          throw new AppError("INTERNAL_ERROR", "Job vanished inside its own reservation");
        }
        return {
          kind: "RESERVED",
          job: toJob(reloaded, organizationId),
          reservation: toReservation(reservation),
        };
      });
    },

    async findByJobId(organizationId, generationJobId) {
      const row = await prisma.generationReservation.findFirst({
        where: { generationJobId, generationJob: jobScope(organizationId) },
      });
      return row === null ? null : toReservation(row);
    },

    async transition(
      input,
    ): Promise<TransitionOutcome<GenerationReservation> | ReservedTransitionOutcome> {
      if (isReservedEdge(RESERVATION_RESERVED_EDGES, input.expectedState, input.nextState)) {
        return { kind: "TRANSITION_RESERVED" };
      }
      assertLegal(
        canTransitionReservation(input.expectedState, input.nextState),
        input.expectedState,
        input.nextState,
        "generation reservation",
      );
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.generationReservation.updateMany({
          where: {
            id: input.id,
            state: input.expectedState,
            stateVersion: input.expectedVersion,
            generationJob: jobScope(input.organizationId),
          },
          data: {
            state: input.nextState,
            stateVersion: { increment: 1 },
            // Set by the transition that reaches the state, so a released hold
            // carries when it happened without a second write that could be
            // forgotten.
            //
            // There is deliberately no `consumedAt` branch here. Both edges
            // into `CONSUMED` are reserved for Transaction G, so this method
            // can never reach that state — and a write that cannot execute is
            // not a rule, it is a claim the code makes about itself. Transaction
            // G will stamp `consumedAt` in the commit that actually spends the
            // unit. A mutation ledger found this by removing the branch and
            // watching nothing fail.
            ...(input.nextState === "RELEASED" ? { releasedAt: new Date() } : {}),
          },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "RESERVATION",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationReservation.findFirst({
          where: { id: input.id, generationJob: jobScope(input.organizationId) },
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Reservation vanished inside its own transition");
        }
        return { kind: "APPLIED" as const, value: toReservation(row) };
      });
    },
  };
}

export function createGenerationSceneRepository(prisma: PrismaClient): GenerationSceneRepository {
  return {
    async create(organizationId: string, scene: NewGenerationScene, context: TransitionContext) {
      const job = await prisma.generationJob.findFirst({
        where: { id: scene.generationJobId, ...jobScope(organizationId) },
        select: { id: true },
      });
      if (job === null) return null;

      return prisma.$transaction(async (tx) => {
        const row = await tx.generationScene.create({ data: { ...scene, state: "PENDING" } });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "SCENE",
          aggregateId: row.id,
          fromState: null,
          toState: "PENDING",
          context,
        });
        return toScene(row);
      });
    },

    async findById(organizationId, id) {
      const row = await prisma.generationScene.findFirst({
        where: { id, ...sceneScope(organizationId) },
      });
      return row === null ? null : toScene(row);
    },

    async listByJobId(organizationId, generationJobId) {
      const rows = await prisma.generationScene.findMany({
        where: { generationJobId, ...sceneScope(organizationId) },
        orderBy: { position: "asc" },
      });
      return rows.map(toScene);
    },

    async transition(input): Promise<TransitionOutcome<GenerationScene>> {
      assertLegal(
        canTransitionScene(input.expectedState, input.nextState),
        input.expectedState,
        input.nextState,
        "generation scene",
      );
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.generationScene.updateMany({
          where: {
            id: input.id,
            state: input.expectedState,
            stateVersion: input.expectedVersion,
            ...sceneScope(input.organizationId),
          },
          data: { state: input.nextState, stateVersion: { increment: 1 } },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "SCENE",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationScene.findFirst({
          where: { id: input.id, ...sceneScope(input.organizationId) },
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Generation scene vanished inside its transition");
        }
        return { kind: "APPLIED" as const, value: toScene(row) };
      });
    },
  };
}

export function createSceneGenerationRequestRepository(
  prisma: PrismaClient,
): SceneGenerationRequestRepository {
  return {
    async createInitial(organizationId, input, context) {
      const scene = await prisma.generationScene.findFirst({
        where: { id: input.generationSceneId, ...sceneScope(organizationId) },
        select: { id: true },
      });
      if (scene === null) return null;

      return prisma.$transaction(async (tx) => {
        const row = await tx.sceneGenerationRequest.create({
          data: {
            id: input.id,
            generationSceneId: input.generationSceneId,
            kind: "INITIAL",
            userRegenerationOrdinal: null,
            requestedByUserId: input.requestedByUserId,
            state: "PENDING",
          },
        });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "SCENE_REQUEST",
          aggregateId: row.id,
          fromState: null,
          toState: "PENDING",
          context,
        });
        return toRequest(row);
      });
    },

    /**
     * Admit a user regeneration, deriving its ordinal inside the transaction.
     *
     * The caller does not choose `1` or `2`. Nominating an ordinal is asserting
     * how much of the customer's entitlement is already spent, which is not a
     * fact any caller holds — it follows from delivered requests, and reading
     * them here makes the entitlement independent of how careful the call site
     * was.
     *
     * Two concurrent admissions both derive the same next ordinal. The partial
     * unique index on active regenerations is what stops both from committing:
     * the second violates it and its whole transaction rolls back.
     */
    async admitUserRegeneration(
      organizationId: string,
      input: AdmitUserRegenerationInput,
      context: TransitionContext,
    ): Promise<AdmitUserRegenerationOutcome> {
      return prisma.$transaction(async (tx): Promise<AdmitUserRegenerationOutcome> => {
        const scene = await tx.generationScene.findFirst({
          where: { id: input.generationSceneId, ...sceneScope(organizationId) },
          select: { id: true },
        });
        if (scene === null) return { kind: "SCENE_NOT_FOUND" };

        const siblings = await tx.sceneGenerationRequest.findMany({
          where: { generationSceneId: input.generationSceneId },
          select: { kind: true, state: true },
        });

        const active = siblings.some(
          (r) =>
            r.kind === "USER_REGENERATION" && (r.state === "PENDING" || r.state === "GENERATING"),
        );
        if (active) return { kind: "REGENERATION_ALREADY_ACTIVE" };

        const ordinal = nextUserRegenerationOrdinal(siblings);
        if (ordinal === null) return { kind: "ENTITLEMENT_EXHAUSTED" };

        // A genuine concurrent race gets past the check above: both
        // transactions read the same siblings before either commits. The
        // partial index settles it, and the loser's P2002 is an expected
        // business outcome — the caller asked for something another request is
        // already doing — not a database defect. Only that exact violation is
        // translated; anything else propagates unchanged.
        let row;
        try {
          row = await tx.sceneGenerationRequest.create({
            data: {
              id: input.id,
              generationSceneId: input.generationSceneId,
              kind: "USER_REGENERATION",
              userRegenerationOrdinal: ordinal,
              requestedByUserId: input.requestedByUserId,
              state: "PENDING",
            },
          });
        } catch (error) {
          if (isActiveRegenerationConflict(error)) {
            return { kind: "REGENERATION_ALREADY_ACTIVE" };
          }
          throw error;
        }
        await appendEvent(tx, {
          organizationId,
          aggregateType: "SCENE_REQUEST",
          aggregateId: row.id,
          fromState: null,
          toState: "PENDING",
          context,
        });
        return { kind: "ADMITTED", request: toRequest(row) };
      });
    },

    async findById(organizationId, id) {
      const row = await prisma.sceneGenerationRequest.findFirst({
        where: { id, ...requestScope(organizationId) },
      });
      return row === null ? null : toRequest(row);
    },

    async listBySceneId(organizationId, generationSceneId) {
      const rows = await prisma.sceneGenerationRequest.findMany({
        where: { generationSceneId, ...requestScope(organizationId) },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRequest);
    },

    async transition(
      input,
    ): Promise<TransitionOutcome<SceneGenerationRequestRecord> | ReservedTransitionOutcome> {
      if (isReservedEdge(REQUEST_RESERVED_EDGES, input.expectedState, input.nextState)) {
        return { kind: "TRANSITION_RESERVED" };
      }
      assertLegal(
        canTransitionSceneRequest(input.expectedState, input.nextState),
        input.expectedState,
        input.nextState,
        "scene generation request",
      );
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.sceneGenerationRequest.updateMany({
          where: {
            id: input.id,
            state: input.expectedState,
            stateVersion: input.expectedVersion,
            ...requestScope(input.organizationId),
          },
          data: {
            state: input.nextState,
            stateVersion: { increment: 1 },
            // Same reasoning as the reservation above: `GENERATING → DELIVERED`
            // is reserved for Transaction F, so this method cannot reach
            // `DELIVERED` and a `deliveredAt` branch here would be unreachable.
            // `deliveredAt` is the instant a customer's regeneration right was
            // spent; it belongs to the commit that spends it, alongside the
            // output verification that justifies delivery.
            ...(input.nextState === "FAILED_TERMINAL" ? { failedAt: new Date() } : {}),
          },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "SCENE_REQUEST",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.sceneGenerationRequest.findFirst({
          where: { id: input.id, ...requestScope(input.organizationId) },
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Scene request vanished inside its transition");
        }
        return { kind: "APPLIED" as const, value: toRequest(row) };
      });
    },
  };
}

/** The pricing snapshot columns, written once at admission and never again. */
function pricingSnapshotData(
  id: string,
  sceneGenerationId: string,
  s: PricingSnapshot,
): Prisma.GenerationPricingSnapshotUncheckedCreateInput {
  return {
    id,
    sceneGenerationId,
    pricingVersion: s.pricingVersion,
    provider: s.provider,
    contractKey: s.contractKey,
    contractFingerprint: s.contractFingerprint,
    identityJson: s.identity as unknown as Prisma.InputJsonValue,
    stablePriceReferenceJson:
      (s.stablePriceReference ?? null) as unknown as Prisma.InputJsonValue,
    riskProfileKey: s.riskProfileKey,
    riskBufferBps: s.riskBufferBps,
    requestedSeconds: s.requestedSeconds,
    billableSeconds: s.billableSeconds,
    estimatedStableCostMicroUsd: BigInt(s.estimatedStableCostMicroUsd),
    estimatedPlanningCostMicroUsd: BigInt(s.estimatedPlanningCostMicroUsd),
    pricingEffectiveAtEpochMs: BigInt(s.pricingEffectiveAt),
    fxSnapshotId: s.fxSnapshotId,
  };
}

export function createSceneGenerationAttemptRepository(
  prisma: PrismaClient,
): SceneGenerationAttemptRepository {
  return {
    /**
     * Transaction C: admit one provider attempt.
     *
     * The attempt row, its pricing snapshot and its first event commit
     * together. Apart, a crash between them leaves an admitted attempt with no
     * cost decision — which the provider boundary then refuses forever,
     * stranding work nobody can explain.
     *
     * `videoProjectId` is resolved from the parent request through scene → job
     * → project rather than accepted, because a caller-supplied project id is a
     * caller choosing which tenant's history this attempt joins.
     *
     * The pricing binding is checked before anything is written: the snapshot's
     * provider and model must be the ones this attempt will actually call.
     */
    async admit(
      organizationId: string,
      input: AdmitGenerationAttemptInput,
      context: TransitionContext,
    ): Promise<AdmitGenerationAttemptOutcome> {
      return prisma.$transaction(async (tx): Promise<AdmitGenerationAttemptOutcome> => {
        // The parent request, and through it every fact this attempt must not
        // be told. A caller-supplied copy of any of these could disagree with
        // the scene it claims to render.
        const request = await tx.sceneGenerationRequest.findFirst({
          where: { id: input.generationSceneRequestId, ...requestScope(organizationId) },
          select: {
            id: true,
            state: true,
            stateVersion: true,
            generationScene: {
              select: {
                sourceStoryboardSceneId: true,
                sourceAssetId: true,
                sourceAnalysisRevision: true,
                snapshotDurationSeconds: true,
                snapshotCameraMotion: true,
                snapshotCompiledPrompt: true,
                generationJob: {
                  select: {
                    videoProjectId: true,
                    qualityTier: true,
                    targetOutputResolution: true,
                    targetAspectRatio: true,
                  },
                },
              },
            },
          },
        });
        if (request === null) return { kind: "REQUEST_NOT_FOUND" };

        // A finished request admits nothing. Admitting an attempt onto a
        // DELIVERED request would spend money on work the customer already has.
        if (request.state !== "PENDING" && request.state !== "GENERATING") {
          return { kind: "REQUEST_NOT_ADMITTING" };
        }

        const scene = request.generationScene;
        const job = scene.generationJob;

        // A V2 executable request needs a compiled prompt. A scene without one
        // cannot produce a hash, so nothing is created rather than a row that
        // can never be executed or re-derived.
        if (scene.snapshotCompiledPrompt === null) {
          return { kind: "SCENE_FACTS_INCOMPLETE" };
        }
        if (!isTargetOutputResolution(job.targetOutputResolution)) {
          return { kind: "SCENE_FACTS_INCOMPLETE" };
        }

        const snapshot = input.pricingSnapshot;
        const mismatch = checkPricingBinding({
          snapshot,
          attemptProvider: input.providerName,
          attemptModelKey: input.requestModelKey,
          attemptNativeTier: input.requestNativeGenerationResolution,
          sceneDurationSeconds: scene.snapshotDurationSeconds,
          jobQualityTier: job.qualityTier,
        });
        if (mismatch !== null) {
          return { kind: "PRICING_BINDING_INVALID", reason: mismatch };
        }

        const fxFailure = await bindFxSnapshot(tx, snapshot, input.fxSnapshot);
        if (fxFailure !== null) return { kind: "FX_BINDING_INVALID", reason: fxFailure };

        // Attempt kind and ordinal are derived from what already exists. A
        // caller could otherwise make the first attempt a SYSTEM_RECOVERY, or
        // file a second PRIMARY — and after the fact the ordinal alone cannot
        // say which of two "first" attempts was really first.
        const siblings = await tx.sceneGeneration.findMany({
          where: { generationSceneRequestId: request.id },
          select: { attemptOrdinal: true, orchestrationState: true },
        });
        const active = siblings.some(
          (a) =>
            a.orchestrationState !== null &&
            (ACTIVE_ORCHESTRATION_STATES as readonly string[]).includes(a.orchestrationState),
        );
        // System recovery is sequential recovery from a *finished* attempt, not
        // permission to run two paid attempts at once.
        if (active) return { kind: "ATTEMPT_ALREADY_ACTIVE" };

        const attemptOrdinal = siblings.reduce(
          (highest, a) => Math.max(highest, a.attemptOrdinal ?? 0),
          0,
        ) + 1;
        const attemptKind = siblings.length === 0 ? "PRIMARY" : "SYSTEM_RECOVERY";

        // The request identity, derived from the exact facts about to be
        // persisted — never accepted from a caller. A caller offering its own
        // V2-prefixed digest for identical facts walks straight past the
        // active-request protection that stops the platform paying twice.
        const facts: GenerationRequestFacts = {
          assetId: scene.sourceAssetId,
          compiledPrompt: scene.snapshotCompiledPrompt,
          durationSeconds: scene.snapshotDurationSeconds,
          cameraMotion: scene.snapshotCameraMotion,
          aspectRatio: job.targetAspectRatio,
          targetOutputResolution: job.targetOutputResolution,
          nativeGenerationResolution: input.requestNativeGenerationResolution,
          resolutionNormalization: input.requestResolutionNormalization,
          nativeMeetsTarget: input.requestNativeMeetsTarget,
          modelKey: input.requestModelKey,
          providerName: input.providerName,
          providerModelId: input.providerModelId,
        };
        const requestHash = computeGenerationRequestHash(facts);

        const attempt = await tx.sceneGeneration.create({
          data: {
            id: input.id,
            videoProjectId: job.videoProjectId,
            // Every fact below comes from the scene or the job, never the caller.
            sourceStoryboardSceneId: scene.sourceStoryboardSceneId,
            assetId: scene.sourceAssetId,
            sourceAnalysisRevision: scene.sourceAnalysisRevision,
            requestHash,
            providerName: input.providerName,
            providerModelId: input.providerModelId,
            requestCompiledPrompt: scene.snapshotCompiledPrompt,
            requestRenderedPrompt: input.requestRenderedPrompt,
            requestDurationSeconds: scene.snapshotDurationSeconds,
            requestCameraMotion: scene.snapshotCameraMotion,
            requestAspectRatio: job.targetAspectRatio,
            requestModelKey: input.requestModelKey,
            requestTargetOutputResolution: job.targetOutputResolution,
            requestNativeGenerationResolution: input.requestNativeGenerationResolution,
            requestResolutionNormalization: input.requestResolutionNormalization,
            requestNativeMeetsTarget: input.requestNativeMeetsTarget,
            generationSceneRequestId: request.id,
            attemptOrdinal,
            attemptKind,
            submissionCertainty: "PRE_SUBMISSION",
            orchestrationState: "QUEUED",
            // Copied from the snapshot, never from the caller.
            pricingContractKey: snapshot.contractKey,
          },
          select: ATTEMPT_SELECT,
        });

        await tx.generationPricingSnapshot.create({
          data: pricingSnapshotData(input.pricingSnapshotId, attempt.id, snapshot),
        });

        await appendEvent(tx, {
          organizationId,
          aggregateType: "ATTEMPT",
          aggregateId: attempt.id,
          fromState: null,
          toState: "QUEUED",
          context,
        });

        // The first attempt starts the customer's request, in this same commit.
        // Split apart, the database would claim the request had not begun while
        // a provider attempt for it already existed.
        if (attemptKind === "PRIMARY") {
          const started = await tx.sceneGenerationRequest.updateMany({
            where: { id: request.id, state: "PENDING", stateVersion: request.stateVersion },
            data: { state: "GENERATING", stateVersion: { increment: 1 } },
          });
          if (started.count === 0) {
            throw new AppError(
              "INTERNAL_ERROR",
              "Scene request moved during its own first attempt admission",
            );
          }
          await appendEvent(tx, {
            organizationId,
            aggregateType: "SCENE_REQUEST",
            aggregateId: request.id,
            fromState: "PENDING",
            toState: "GENERATING",
            context,
          });
        }

        return { kind: "ADMITTED", attempt: toAttempt(attempt) };
      });
    },

    async findById(organizationId, id) {
      const row = await prisma.sceneGeneration.findFirst({
        where: { id, ...attemptScope(organizationId) },
        select: ATTEMPT_SELECT,
      });
      return row === null ? null : toAttempt(row);
    },

    async listByRequestId(organizationId, generationSceneRequestId) {
      const rows = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId, ...attemptScope(organizationId) },
        orderBy: { attemptOrdinal: "asc" },
        select: ATTEMPT_SELECT,
      });
      return rows.map(toAttempt);
    },

    /**
     * The provider-call authorization boundary.
     *
     * The commit of this transaction *is* the authorization, and only `ARMED`
     * permits an outbound call.
     *
     * The pricing snapshot is loaded **with** the attempt and inside the
     * transaction, and its provider, contract key and model must match. Merely
     * existing is not enough — that would authorize this attempt against
     * another provider's price.
     */
    async armProviderBoundary(input): Promise<ArmProviderBoundaryOutcome> {
      return prisma.$transaction(async (tx): Promise<ArmProviderBoundaryOutcome> => {
        const attempt = await tx.sceneGeneration.findFirst({
          where: { id: input.id, ...attemptScope(input.organizationId) },
          select: {
            ...ATTEMPT_SELECT,
            requestModelKey: true,
            requestDurationSeconds: true,
            requestNativeGenerationResolution: true,
            generationSceneRequest: {
              select: {
                generationScene: {
                  select: { generationJob: { select: { qualityTier: true } } },
                },
              },
            },
          },
        });
        if (attempt === null || attempt.generationSceneRequest === null) {
          return { kind: "LOST" };
        }

        const snapshot = await tx.generationPricingSnapshot.findUnique({
          where: { sceneGenerationId: input.id },
          select: {
            sceneGenerationId: true,
            provider: true,
            contractKey: true,
            requestedSeconds: true,
            riskProfileKey: true,
            identityJson: true,
          },
        });
        if (snapshot === null) return { kind: "MISSING_PRICING_SNAPSHOT" };
        if (snapshot.sceneGenerationId !== attempt.id) {
          return { kind: "PRICING_BINDING_INVALID", reason: "SNAPSHOT_NOT_FOR_ATTEMPT" };
        }

        // The identity is read back from the stored row rather than recomputed,
        // so a snapshot corrupted after admission is caught here rather than
        // trusted because admission once approved it.
        const identity = snapshot.identityJson as {
          pricingModelKey?: unknown;
          nativeTier?: unknown;
          generationMode?: unknown;
          audioMode?: unknown;
        } | null;
        if (
          typeof identity?.pricingModelKey !== "string" ||
          typeof identity.nativeTier !== "string" ||
          typeof identity.generationMode !== "string" ||
          typeof identity.audioMode !== "string" ||
          attempt.pricingContractKey === null ||
          attempt.requestDurationSeconds === null ||
          attempt.requestNativeGenerationResolution === null
        ) {
          return { kind: "PRICING_BINDING_INVALID", reason: "SNAPSHOT_MISSING" };
        }

        const mismatch = checkPricingBinding({
          snapshot: {
            provider: snapshot.provider,
            contractKey: snapshot.contractKey,
            requestedSeconds: snapshot.requestedSeconds,
            riskProfileKey: snapshot.riskProfileKey,
            identity: {
              pricingModelKey: identity.pricingModelKey,
              nativeTier: identity.nativeTier,
              generationMode: identity.generationMode,
              audioMode: identity.audioMode,
            },
          },
          attemptProvider: attempt.providerName,
          attemptModelKey: attempt.requestModelKey,
          attemptNativeTier: attempt.requestNativeGenerationResolution,
          sceneDurationSeconds: attempt.requestDurationSeconds,
          jobQualityTier: attempt.generationSceneRequest.generationScene.generationJob.qualityTier,
          attemptContractKey: attempt.pricingContractKey,
        });
        if (mismatch !== null) {
          return { kind: "PRICING_BINDING_INVALID", reason: mismatch };
        }

        const { count } = await tx.sceneGeneration.updateMany({
          where: {
            id: input.id,
            orchestrationState: "QUEUED",
            stateVersion: input.expectedVersion,
            ...attemptScope(input.organizationId),
          },
          data: {
            orchestrationState: "SUBMITTING",
            stateVersion: { increment: 1 },
            submissionBoundaryEnteredAt: new Date(),
          },
        });
        if (count === 0) return { kind: "LOST" };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "ATTEMPT",
          aggregateId: input.id,
          fromState: "QUEUED",
          toState: "SUBMITTING",
          context: input.context,
        });

        const row = await tx.sceneGeneration.findFirst({
          where: { id: input.id, ...attemptScope(input.organizationId) },
          select: ATTEMPT_SELECT,
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Attempt vanished inside its own arm transaction");
        }
        return { kind: "ARMED", attempt: toAttempt(row) };
      });
    },

    /**
     * Record what the provider said, atomically with the event that says so.
     *
     * The outcome union carries its own target state and certainty, so this
     * method never decides which pairing is correct — the domain type made that
     * impossible to get wrong. A provider reference is written only on the
     * `ACCEPTED` arm, which is the rule the database CHECK enforces from
     * underneath, in both directions.
     */
    async recordSubmissionOutcome(input): Promise<TransitionOutcome<GenerationAttempt>> {
      const outcome = input.outcome;
      assertLegal(
        canTransitionAttempt("SUBMITTING", outcome.state),
        "SUBMITTING",
        outcome.state,
        "generation attempt",
      );
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.sceneGeneration.updateMany({
          where: {
            id: input.id,
            orchestrationState: "SUBMITTING",
            stateVersion: input.expectedVersion,
            ...attemptScope(input.organizationId),
          },
          data: {
            orchestrationState: outcome.state,
            submissionCertainty: outcome.certainty,
            stateVersion: { increment: 1 },
            providerPredictionId: outcome.providerPredictionId,
            normalizedErrorCode: input.normalizedErrorCode,
            ...(outcome.certainty === "ACCEPTED"
              ? { providerAcceptedAt: outcome.providerAcceptedAt }
              : {}),
            ...(outcome.certainty === "SUBMISSION_UNKNOWN"
              ? {
                  reconciliationStartedAt: outcome.reconciliationStartedAt,
                  reconciliationDeadlineAt: outcome.reconciliationDeadlineAt,
                }
              : {}),
          },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          organizationId: input.organizationId,
          aggregateType: "ATTEMPT",
          aggregateId: input.id,
          fromState: "SUBMITTING",
          toState: outcome.state,
          context: input.context,
        });

        const row = await tx.sceneGeneration.findFirst({
          where: { id: input.id, ...attemptScope(input.organizationId) },
          select: ATTEMPT_SELECT,
        });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Attempt vanished inside its outcome transaction");
        }
        return { kind: "APPLIED" as const, value: toAttempt(row) };
      });
    },
  };
}

type PricingSnapshotRow = NonNullable<
  Awaited<ReturnType<PrismaClient["generationPricingSnapshot"]["findFirst"]>>
>;

function toPricingSnapshot(r: PricingSnapshotRow): GenerationPricingSnapshotRecord {
  return {
    id: r.id,
    sceneGenerationId: r.sceneGenerationId,
    pricingVersion: r.pricingVersion,
    provider: r.provider,
    contractKey: r.contractKey,
    contractFingerprint: r.contractFingerprint,
    riskProfileKey: r.riskProfileKey,
    riskBufferBps: r.riskBufferBps,
    requestedSeconds: r.requestedSeconds,
    billableSeconds: r.billableSeconds,
    estimatedStableCostMicroUsd: r.estimatedStableCostMicroUsd,
    estimatedPlanningCostMicroUsd: r.estimatedPlanningCostMicroUsd,
    pricingEffectiveAtEpochMs: r.pricingEffectiveAtEpochMs,
    fxSnapshotId: r.fxSnapshotId,
    createdAt: r.createdAt,
  };
}

/**
 * Read-only.
 *
 * There is no create method: a pricing snapshot is written by attempt
 * admission, inside the same transaction as the attempt it prices. Offering a
 * standalone create would reopen the crash window that admission closes.
 */
export function createGenerationPricingSnapshotRepository(
  prisma: PrismaClient,
): GenerationPricingSnapshotRepository {
  return {
    async findByAttemptId(organizationId, sceneGenerationId) {
      const row = await prisma.generationPricingSnapshot.findFirst({
        where: { sceneGenerationId, sceneGeneration: attemptScope(organizationId) },
      });
      return row === null ? null : toPricingSnapshot(row);
    },
  };
}

/**
 * Reads only.
 *
 * No update, no delete, and no "administrative correction" escape hatch. The
 * append-only guarantee is worth exactly as much as the narrowest method on
 * this interface, and a history that can be edited answers no question during
 * an incident.
 */
export function createGenerationTransitionEventRepository(
  prisma: PrismaClient,
): GenerationTransitionEventRepository {
  const toEvent = (r: {
    id: string;
    organizationId: string;
    aggregateType: GenerationTransitionAggregateType;
    aggregateId: string;
    sequence: number;
    fromState: string | null;
    toState: string;
    eventType: string;
    actorType: GenerationTransitionEventRecord["actorType"];
    actorUserId: string | null;
    reasonCode: string | null;
    correlationId: string;
    causationId: string | null;
    safeMetadata: Prisma.JsonValue;
    createdAt: Date;
  }): GenerationTransitionEventRecord => ({
    id: r.id,
    organizationId: r.organizationId,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    sequence: r.sequence,
    fromState: r.fromState,
    toState: r.toState,
    eventType: r.eventType,
    actorType: r.actorType,
    actorUserId: r.actorUserId,
    reasonCode: r.reasonCode,
    correlationId: r.correlationId,
    causationId: r.causationId,
    safeMetadata: (r.safeMetadata ?? {}) as GenerationTransitionEventRecord["safeMetadata"],
    createdAt: r.createdAt,
  });

  return {
    async listForAggregate(organizationId, aggregateType, aggregateId) {
      const rows = await prisma.generationTransitionEvent.findMany({
        where: { organizationId, aggregateType, aggregateId },
        orderBy: { sequence: "asc" },
      });
      return rows.map(toEvent);
    },
    async listForCorrelation(organizationId, correlationId) {
      const rows = await prisma.generationTransitionEvent.findMany({
        where: { organizationId, correlationId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toEvent);
    },
  };
}
