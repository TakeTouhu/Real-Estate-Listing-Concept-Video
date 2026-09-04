import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  ArmProviderBoundaryOutcome,
  AttemptOutcomePersistence,
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
  NewGenerationReservation,
  NewGenerationScene,
  NewSceneGenerationRequest,
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
  sanitizeTransitionMetadata,
} from "@app/domain";
import { AppError, randomId } from "@app/shared";

/**
 * Persistence for generation orchestration.
 *
 * Two rules shape every method here, and both exist because these rows decide
 * whether a paid provider call happens.
 *
 * **There is no open write.** No `update(id, fields)`, no `setState`. Every
 * mutation names the state and version it believes it is replacing, and the
 * database refuses if either has moved. An open write is how a state machine
 * gets bypassed by a caller in a hurry.
 *
 * **A state change and its transition event commit together, or neither does.**
 * A state with no event is history the system cannot explain; an event with no
 * state change is history that did not happen. Both are worse than a failure.
 *
 * The domain decides which transitions are *legal*; this layer decides whether
 * one *won*. Both checks are required — legality without CAS loses races, CAS
 * without legality writes nonsense atomically.
 */

type Tx = Prisma.TransactionClient;

/** The transition-event id prefix, matching the repository's id conventions. */
const EVENT_ID_PREFIX = "genevt";

/**
 * Append one transition event, allocating its per-aggregate sequence.
 *
 * The sequence is `MAX + 1` read inside the caller's transaction. Two concurrent
 * writers can read the same maximum, and the unique index on
 * `(aggregateType, aggregateId, sequence)` then fails one of them — which is the
 * correct outcome, not a flaw: those two writers were also competing for the
 * same CAS, so at most one of them was going to commit anyway. The loser's whole
 * transaction rolls back, taking its state change with it.
 */
async function appendEvent(
  tx: Tx,
  input: {
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

/**
 * Refuse an illegal transition before any row is touched.
 *
 * `INTERNAL_ERROR`: no customer input reaches these state machines, so an
 * illegal move is always a defect in a caller. Losing a race is a different
 * thing entirely and is reported as `LOST`, never thrown.
 */
function assertLegal(legal: boolean, from: string, to: string, aggregate: string): void {
  if (!legal) {
    throw new AppError("INTERNAL_ERROR", `Illegal ${aggregate} transition ${from} -> ${to}`, {
      details: { from, to, aggregate },
    });
  }
}

type JobRow = Awaited<ReturnType<PrismaClient["generationJob"]["findUnique"]>>;
type ReservationRow = Awaited<ReturnType<PrismaClient["generationReservation"]["findUnique"]>>;
type SceneRow = Awaited<ReturnType<PrismaClient["generationScene"]["findUnique"]>>;
type RequestRow = Awaited<ReturnType<PrismaClient["sceneGenerationRequest"]["findUnique"]>>;

function toJob(r: NonNullable<JobRow>): GenerationJob {
  return {
    id: r.id,
    videoProjectId: r.videoProjectId,
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

function toReservation(r: NonNullable<ReservationRow>): GenerationReservation {
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

function toScene(r: NonNullable<SceneRow>): GenerationScene {
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

function toRequest(r: NonNullable<RequestRow>): SceneGenerationRequestRecord {
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

/**
 * An orchestration-admitted attempt.
 *
 * Throws on a legacy row rather than returning a half-populated value. Legacy
 * rows are readable through the existing `SceneGeneration` repository, which is
 * where they belong; forcing them through this shape would mean inventing an
 * attempt kind and a certainty they never had.
 */
function toAttempt(r: {
  id: string;
  videoProjectId: string;
  generationSceneRequestId: string | null;
  attemptOrdinal: number | null;
  attemptKind: GenerationAttempt["attemptKind"] | null;
  orchestrationState: GenerationAttempt["orchestrationState"] | null;
  submissionCertainty: GenerationAttempt["submissionCertainty"] | null;
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
}): GenerationAttempt {
  if (
    r.generationSceneRequestId === null ||
    r.attemptOrdinal === null ||
    r.attemptKind === null ||
    r.orchestrationState === null ||
    r.submissionCertainty === null
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

export function createGenerationJobRepository(prisma: PrismaClient): GenerationJobRepository {
  return {
    async create(job: NewGenerationJob, context: TransitionContext): Promise<GenerationJob> {
      return prisma.$transaction(async (tx) => {
        const row = await tx.generationJob.create({ data: { ...job, state: "CREATED" } });
        await appendEvent(tx, {
          aggregateType: "JOB",
          aggregateId: row.id,
          fromState: null,
          toState: "CREATED",
          context,
        });
        return toJob(row);
      });
    },

    async findById(id) {
      const row = await prisma.generationJob.findUnique({ where: { id } });
      return row === null ? null : toJob(row);
    },

    async transition(input): Promise<TransitionOutcome<GenerationJob>> {
      assertLegal(
        canTransitionJob(input.expectedState, input.nextState),
        input.expectedState,
        input.nextState,
        "generation job",
      );
      return prisma.$transaction(async (tx) => {
        // `updateMany` rather than `update`: `update` needs a unique selector and
        // cannot carry the state and version predicates that make this a
        // compare-and-set. Zero rows updated means someone else moved it.
        const { count } = await tx.generationJob.updateMany({
          where: {
            id: input.id,
            state: input.expectedState,
            stateVersion: input.expectedVersion,
          },
          data: { state: input.nextState, stateVersion: { increment: 1 } },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          aggregateType: "JOB",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationJob.findUnique({ where: { id: input.id } });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Generation job vanished inside its own transition");
        }
        return { kind: "APPLIED" as const, value: toJob(row) };
      });
    },
  };
}

export function createGenerationReservationRepository(
  prisma: PrismaClient,
): GenerationReservationRepository {
  return {
    async create(reservation: NewGenerationReservation, context: TransitionContext) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.generationReservation.create({
          data: { ...reservation, state: "RESERVING" },
        });
        await appendEvent(tx, {
          aggregateType: "RESERVATION",
          aggregateId: row.id,
          fromState: null,
          toState: "RESERVING",
          context,
        });
        return toReservation(row);
      });
    },

    async findByJobId(generationJobId) {
      const row = await prisma.generationReservation.findUnique({ where: { generationJobId } });
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
          aggregateType: "RESERVATION",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationReservation.findUnique({ where: { id: input.id } });
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
    async create(scene: NewGenerationScene, context: TransitionContext) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.generationScene.create({ data: { ...scene, state: "PENDING" } });
        await appendEvent(tx, {
          aggregateType: "SCENE",
          aggregateId: row.id,
          fromState: null,
          toState: "PENDING",
          context,
        });
        return toScene(row);
      });
    },

    async findById(id) {
      const row = await prisma.generationScene.findUnique({ where: { id } });
      return row === null ? null : toScene(row);
    },

    async listByJobId(generationJobId) {
      const rows = await prisma.generationScene.findMany({
        where: { generationJobId },
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
          },
          data: { state: input.nextState, stateVersion: { increment: 1 } },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          aggregateType: "SCENE",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.generationScene.findUnique({ where: { id: input.id } });
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
    async create(request: NewSceneGenerationRequest, context: TransitionContext) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.sceneGenerationRequest.create({
          data: { ...request, state: "PENDING" },
        });
        await appendEvent(tx, {
          aggregateType: "SCENE_REQUEST",
          aggregateId: row.id,
          fromState: null,
          toState: "PENDING",
          context,
        });
        return toRequest(row);
      });
    },

    async findById(id) {
      const row = await prisma.sceneGenerationRequest.findUnique({ where: { id } });
      return row === null ? null : toRequest(row);
    },

    async listBySceneId(generationSceneId) {
      const rows = await prisma.sceneGenerationRequest.findMany({
        where: { generationSceneId },
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
          },
          data: {
            state: input.nextState,
            stateVersion: { increment: 1 },
            // `deliveredAt` is what the regeneration entitlement is counted
            // from, so it is written by the transition that earns it rather
            // than by a caller that might forget.
            ...(input.nextState === "DELIVERED" ? { deliveredAt: new Date() } : {}),
            ...(input.nextState === "FAILED_TERMINAL" ? { failedAt: new Date() } : {}),
          },
        });
        if (count === 0) return { kind: "LOST" as const };

        await appendEvent(tx, {
          aggregateType: "SCENE_REQUEST",
          aggregateId: input.id,
          fromState: input.expectedState,
          toState: input.nextState,
          context: input.context,
        });
        const row = await tx.sceneGenerationRequest.findUnique({ where: { id: input.id } });
        if (row === null) {
          throw new AppError("INTERNAL_ERROR", "Scene request vanished inside its transition");
        }
        return { kind: "APPLIED" as const, value: toRequest(row) };
      });
    },
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

export function createSceneGenerationAttemptRepository(
  prisma: PrismaClient,
): SceneGenerationAttemptRepository {
  return {
    async findById(id) {
      const row = await prisma.sceneGeneration.findUnique({
        where: { id },
        select: ATTEMPT_SELECT,
      });
      return row === null ? null : toAttempt(row);
    },

    async listByRequestId(generationSceneRequestId) {
      const rows = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId },
        orderBy: { attemptOrdinal: "asc" },
        select: ATTEMPT_SELECT,
      });
      return rows.map(toAttempt);
    },

    /**
     * The provider-call authorization boundary.
     *
     * The commit of this transaction *is* the authorization. Everything the
     * caller needs to know is in the returned discriminant, and only `ARMED`
     * permits an outbound call.
     *
     * The pricing snapshot is checked **inside** the transaction, not before
     * it. Checking outside would be a time-of-check-to-time-of-use window: the
     * snapshot could be verified, the CAS could win, and the two facts would
     * never have been true simultaneously. Here they are established under the
     * same commit.
     *
     * `QUEUED` is named as the expected state rather than passed in, because
     * there is exactly one state a provider call may be armed from and letting
     * a caller nominate a different one is the bug this method prevents.
     */
    async armProviderBoundary(input): Promise<ArmProviderBoundaryOutcome> {
      return prisma.$transaction(async (tx): Promise<ArmProviderBoundaryOutcome> => {
        const snapshot = await tx.generationPricingSnapshot.findUnique({
          where: { sceneGenerationId: input.id },
          select: { id: true },
        });
        if (snapshot === null) return { kind: "MISSING_PRICING_SNAPSHOT" };

        const { count } = await tx.sceneGeneration.updateMany({
          where: {
            id: input.id,
            orchestrationState: "QUEUED",
            stateVersion: input.expectedVersion,
          },
          data: {
            orchestrationState: "SUBMITTING",
            stateVersion: { increment: 1 },
            submissionBoundaryEnteredAt: new Date(),
          },
        });
        if (count === 0) return { kind: "LOST" };

        await appendEvent(tx, {
          aggregateType: "ATTEMPT",
          aggregateId: input.id,
          fromState: "QUEUED",
          toState: "SUBMITTING",
          context: input.context,
        });

        const row = await tx.sceneGeneration.findUnique({
          where: { id: input.id },
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
     * The outcome union carries its own target state and its own certainty, so
     * this method never has to decide which pairing is correct — the domain
     * type already made that impossible to get wrong. A provider reference is
     * written only on the `ACCEPTED` arm, which is the same rule the database
     * CHECK enforces from underneath.
     */
    async recordSubmissionOutcome(input): Promise<TransitionOutcome<GenerationAttempt>> {
      const outcome: AttemptOutcomePersistence = input.outcome;
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
          aggregateType: "ATTEMPT",
          aggregateId: input.id,
          fromState: "SUBMITTING",
          toState: outcome.state,
          context: input.context,
        });

        const row = await tx.sceneGeneration.findUnique({
          where: { id: input.id },
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

export function createGenerationPricingSnapshotRepository(
  prisma: PrismaClient,
): GenerationPricingSnapshotRepository {
  return {
    /**
     * Persist the domain's pricing decision verbatim.
     *
     * Every value is copied from the supplied `PricingSnapshot`; nothing is
     * recomputed, and no pricing arithmetic appears in this file at all. A
     * repository that recalculated a price would be a second pricing
     * implementation, and the second one is always the one that drifts.
     *
     * Monetary values become `BigInt` on the way in. They arrive as branded
     * safe integers from the pricing domain, so the conversion is exact.
     */
    async create(input): Promise<GenerationPricingSnapshotRecord> {
      const s = input.snapshot;
      const row = await prisma.generationPricingSnapshot.create({
        data: {
          id: input.id,
          sceneGenerationId: input.sceneGenerationId,
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
        },
      });
      return toPricingSnapshot(row);
    },

    async findByAttemptId(sceneGenerationId) {
      const row = await prisma.generationPricingSnapshot.findUnique({
        where: { sceneGenerationId },
      });
      return row === null ? null : toPricingSnapshot(row);
    },
  };
}

type PricingSnapshotRow = Awaited<
  ReturnType<PrismaClient["generationPricingSnapshot"]["findUnique"]>
>;

function toPricingSnapshot(
  r: NonNullable<PricingSnapshotRow>,
): GenerationPricingSnapshotRecord {
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
    async listForAggregate(aggregateType, aggregateId) {
      const rows = await prisma.generationTransitionEvent.findMany({
        where: { aggregateType, aggregateId },
        orderBy: { sequence: "asc" },
      });
      return rows.map(toEvent);
    },
    async listForCorrelation(correlationId) {
      const rows = await prisma.generationTransitionEvent.findMany({
        where: { correlationId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toEvent);
    },
  };
}
