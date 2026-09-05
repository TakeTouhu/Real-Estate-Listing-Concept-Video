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
  PricingBindingFailure,
  PricingSnapshot,
  ReserveGenerationJobInput,
  ReserveGenerationJobOutcome,
  SceneGenerationAttemptRepository,
  SceneGenerationRequestRecord,
  SceneGenerationRequestRepository,
  TransitionContext,
  TransitionOutcome,
} from "@app/domain";
import {
  canTransitionAttempt,
  canTransitionJob,
  canTransitionReservation,
  canTransitionScene,
  canTransitionSceneRequest,
  nextUserRegenerationOrdinal,
  requiredUnitsFor,
  sanitizeTransitionMetadata,
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

/** The versioned request-identity prefix an orchestrated attempt must carry. */
const V2_REQUEST_HASH_PREFIX = "sha256:v2:";

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
    targetOutputResolution: r.targetOutputResolution,
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
 * Three questions, not one. An earlier version asked only whether *a* snapshot
 * existed, which would have authorized a WaveSpeed attempt against a fal cost
 * decision: an audit record that cannot be re-derived, and a future cost gate
 * reading a price for work nobody was doing.
 */
function checkPricingBinding(input: {
  readonly snapshotProvider: string;
  readonly snapshotContractKey: string;
  readonly snapshotModelKey: string;
  readonly attemptProvider: string;
  readonly attemptContractKey: string;
  readonly attemptModelKey: string | null;
}): PricingBindingFailure | null {
  if (input.snapshotProvider !== input.attemptProvider) return "PROVIDER_MISMATCH";
  if (input.snapshotContractKey !== input.attemptContractKey) return "CONTRACT_KEY_MISMATCH";
  // A newly orchestrated attempt must carry the V2 model identity. A null here
  // is a V1/ambiguous attempt, which may not be newly admitted.
  if (input.attemptModelKey === null) return "MODEL_KEY_MISMATCH";
  if (input.snapshotModelKey !== input.attemptModelKey) return "MODEL_KEY_MISMATCH";
  return null;
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
      const project = await prisma.videoProject.findFirst({
        where: { id: job.videoProjectId, organizationId },
        select: { id: true },
      });
      if (project === null) return { kind: "PROJECT_NOT_FOUND" };

      return prisma.$transaction(async (tx) => {
        const row = await tx.generationJob.create({
          data: {
            id: job.id,
            videoProjectId: job.videoProjectId,
            requestedByUserId: job.requestedByUserId,
            qualityTier: job.qualityTier,
            targetOutputResolution: job.targetOutputResolution,
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

    async transition(input): Promise<TransitionOutcome<GenerationJob>> {
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

        const reservation = await tx.generationReservation.create({
          data: {
            id: input.reservationId,
            generationJobId: input.generationJobId,
            billingCycleKey: input.billingCycleKey,
            billingCycleStartedAt: input.billingCycleStartedAt,
            billingCycleEndsAt: input.billingCycleEndsAt,
            // Copied from the job, which was itself derived at admission.
            reservedTotalVideoUnits: job.requiredVideoUnits,
            reservedHighQualityUnits: job.requiredHighQualityUnits,
            state: "RESERVED",
            // The hold is created already RESERVED, so no intermediate state is
            // observable: this transaction either produces a complete hold or
            // none at all.
            stateVersion: 1,
          },
        });

        await appendEvent(tx, {
          organizationId,
          aggregateType: "RESERVATION",
          aggregateId: reservation.id,
          fromState: null,
          toState: "RESERVING",
          context,
        });
        await appendEvent(tx, {
          organizationId,
          aggregateType: "RESERVATION",
          aggregateId: reservation.id,
          fromState: "RESERVING",
          toState: "RESERVED",
          context,
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

    async transition(input): Promise<TransitionOutcome<GenerationReservation>> {
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
            // Terminal timestamps are set by the transition that reaches them,
            // so a released or consumed hold carries when it happened without a
            // second write that could be forgotten.
            ...(input.nextState === "CONSUMED" ? { consumedAt: new Date() } : {}),
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

        const row = await tx.sceneGenerationRequest.create({
          data: {
            id: input.id,
            generationSceneId: input.generationSceneId,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: ordinal,
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

    async transition(input): Promise<TransitionOutcome<SceneGenerationRequestRecord>> {
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
            // `deliveredAt` is the instant a customer's right was spent, so it
            // is written by the transition that earns it rather than by a
            // caller that might forget.
            ...(input.nextState === "DELIVERED" ? { deliveredAt: new Date() } : {}),
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
        const request = await tx.sceneGenerationRequest.findFirst({
          where: { id: input.generationSceneRequestId, ...requestScope(organizationId) },
          select: {
            id: true,
            generationScene: {
              select: { generationJob: { select: { videoProjectId: true } } },
            },
          },
        });
        if (request === null) return { kind: "REQUEST_NOT_FOUND" };

        // A newly orchestrated attempt must carry the V2 request identity. The
        // Phase 4C-3B-2B CHECK keys the V2 snapshot off this prefix, so an
        // attempt admitted with a V1 hash would be storing a V2 payload the
        // database refuses — and a V1 identity cannot express which model was
        // selected, which is what the pricing binding is checked against.
        if (!input.requestHash.startsWith(V2_REQUEST_HASH_PREFIX)) {
          return { kind: "PRICING_BINDING_INVALID", reason: "MODEL_KEY_MISMATCH" };
        }

        const snapshot = input.pricingSnapshot;
        const mismatch = checkPricingBinding({
          snapshotProvider: snapshot.provider,
          snapshotContractKey: snapshot.contractKey,
          snapshotModelKey: snapshot.identity.pricingModelKey,
          attemptProvider: input.providerName,
          attemptContractKey: snapshot.contractKey,
          attemptModelKey: input.requestModelKey,
        });
        if (mismatch !== null) {
          return { kind: "PRICING_BINDING_INVALID", reason: mismatch };
        }

        // Ordinals are scoped to the request and never reused. Read inside the
        // transaction; the unique index on (request, ordinal) settles a race.
        const highest = await tx.sceneGeneration.aggregate({
          where: { generationSceneRequestId: input.generationSceneRequestId },
          _max: { attemptOrdinal: true },
        });

        const attempt = await tx.sceneGeneration.create({
          data: {
            id: input.id,
            videoProjectId: request.generationScene.generationJob.videoProjectId,
            sourceStoryboardSceneId: input.sourceStoryboardSceneId,
            assetId: input.sourceAssetId,
            sourceAnalysisRevision: input.sourceAnalysisRevision,
            requestHash: input.requestHash,
            providerName: input.providerName,
            providerModelId: input.providerModelId,
            requestCompiledPrompt: input.requestCompiledPrompt,
            requestRenderedPrompt: input.requestRenderedPrompt,
            requestDurationSeconds: input.requestDurationSeconds,
            requestCameraMotion: input.requestCameraMotion,
            requestAspectRatio: input.requestAspectRatio,
            requestModelKey: input.requestModelKey,
            requestTargetOutputResolution: input.requestTargetOutputResolution,
            requestNativeGenerationResolution: input.requestNativeGenerationResolution,
            requestResolutionNormalization: input.requestResolutionNormalization,
            requestNativeMeetsTarget: input.requestNativeMeetsTarget,
            generationSceneRequestId: input.generationSceneRequestId,
            attemptOrdinal: (highest._max.attemptOrdinal ?? 0) + 1,
            attemptKind: input.attemptKind,
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
          select: { ...ATTEMPT_SELECT, requestModelKey: true },
        });
        if (attempt === null) return { kind: "LOST" };

        const snapshot = await tx.generationPricingSnapshot.findUnique({
          where: { sceneGenerationId: input.id },
          select: { sceneGenerationId: true, provider: true, contractKey: true, identityJson: true },
        });
        if (snapshot === null) return { kind: "MISSING_PRICING_SNAPSHOT" };
        if (snapshot.sceneGenerationId !== attempt.id) {
          return { kind: "PRICING_BINDING_INVALID", reason: "SNAPSHOT_NOT_FOR_ATTEMPT" };
        }

        const identity = snapshot.identityJson as { pricingModelKey?: unknown } | null;
        const snapshotModelKey =
          typeof identity?.pricingModelKey === "string" ? identity.pricingModelKey : null;
        if (snapshotModelKey === null || attempt.pricingContractKey === null) {
          return { kind: "PRICING_BINDING_INVALID", reason: "SNAPSHOT_MISSING" };
        }

        const mismatch = checkPricingBinding({
          snapshotProvider: snapshot.provider,
          snapshotContractKey: snapshot.contractKey,
          snapshotModelKey,
          attemptProvider: attempt.providerName,
          attemptContractKey: attempt.pricingContractKey,
          attemptModelKey: attempt.requestModelKey,
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
