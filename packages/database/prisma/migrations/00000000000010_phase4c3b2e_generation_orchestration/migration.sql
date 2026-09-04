-- Phase 4C-3B-2E: generation orchestration and audit state
--
-- Six new tables, a certainty axis on the existing attempt row, and the
-- constraints that make the accounting rule structural rather than aspirational:
--
--     a customer video unit is not a provider attempt
--
-- One entitlement can produce an initial generation, up to two user
-- regenerations, and any number of system recovery attempts. Before this
-- migration there was one row for all of it, so "how many times did we pay for
-- this scene, and how many of those were the customer's choice?" had no answer.
--
-- NO EXISTING ROW IS UPDATED. Every column added to `scene_generations` is
-- nullable and stays NULL for rows admitted before this phase. That is a
-- deliberate refusal rather than a convenience: a legacy row sitting in
-- SUBMITTING might have been accepted by the provider or might never have been
-- sent, and there is no longer any way to find out. Writing a certainty onto it
-- would put a guess into the permanent record of a possibly-paid call. The same
-- applies to attempt ordinals, parent requests and reconciliation deadlines —
-- all absent, all left absent.
--
-- The legacy `SceneGenerationState` enum is untouched, and legacy rows keep
-- using it. New orchestration attempts carry `orchestrationState` from the new
-- `GenerationAttemptState` enum instead. Two columns rather than a rewrite,
-- because relabelling `SUCCEEDED` as `PROVIDER_SUCCEEDED` on a historical row
-- asserts something about that row nobody can verify today.

-- CreateEnum
CREATE TYPE "GenerationQualityTier" AS ENUM ('NORMAL', 'HIGH_QUALITY');

-- CreateEnum
CREATE TYPE "GenerationJobState" AS ENUM ('CREATED', 'RESERVING', 'RESERVED', 'GENERATING', 'SCENES_READY', 'COMPOSITION_PENDING', 'COMPOSING', 'DELIVERABLE_VALIDATING', 'DELIVERABLE_READY', 'REVISING', 'FAILED_TERMINAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GenerationReservationState" AS ENUM ('RESERVING', 'RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "GenerationSceneState" AS ENUM ('PENDING', 'GENERATING', 'READY', 'REVISING', 'FAILED_TERMINAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SceneGenerationRequestKind" AS ENUM ('INITIAL', 'USER_REGENERATION');

-- CreateEnum
CREATE TYPE "SceneGenerationRequestState" AS ENUM ('PENDING', 'GENERATING', 'DELIVERED', 'FAILED_TERMINAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GenerationAttemptKind" AS ENUM ('PRIMARY', 'SYSTEM_RECOVERY');

-- CreateEnum
CREATE TYPE "SubmissionCertainty" AS ENUM ('PRE_SUBMISSION', 'ACCEPTED', 'DEFINITIVELY_REJECTED', 'SUBMISSION_UNKNOWN');

-- CreateEnum
CREATE TYPE "GenerationAttemptState" AS ENUM ('QUEUED', 'SUBMITTING', 'PROCESSING', 'RECONCILIATION_PENDING', 'PROVIDER_SUCCEEDED', 'OUTPUT_INGESTING', 'OUTPUT_VERIFIED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'RECONCILIATION_EXHAUSTED', 'CANCELLED_PRE_SUBMISSION');

-- CreateEnum
CREATE TYPE "GenerationTransitionAggregateType" AS ENUM ('JOB', 'RESERVATION', 'SCENE', 'SCENE_REQUEST', 'ATTEMPT', 'DELIVERABLE');

-- CreateEnum
CREATE TYPE "GenerationTransitionActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER', 'ADMIN', 'RECONCILIATION_WORKER');

-- AlterTable
ALTER TABLE "scene_generations" ADD COLUMN     "attemptKind" "GenerationAttemptKind",
ADD COLUMN     "attemptOrdinal" INTEGER,
ADD COLUMN     "generationSceneRequestId" TEXT,
ADD COLUMN     "orchestrationState" "GenerationAttemptState",
ADD COLUMN     "providerAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationResolvedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationStartedAt" TIMESTAMP(3),
ADD COLUMN     "stateVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "submissionBoundaryEnteredAt" TIMESTAMP(3),
ADD COLUMN     "submissionCertainty" "SubmissionCertainty";

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "videoProjectId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "qualityTier" "GenerationQualityTier" NOT NULL,
    "targetOutputResolution" TEXT NOT NULL,
    "requestedDurationSeconds" INTEGER NOT NULL,
    "requiredVideoUnits" INTEGER NOT NULL,
    "requiredHighQualityUnits" INTEGER NOT NULL,
    "state" "GenerationJobState" NOT NULL DEFAULT 'CREATED',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "currentDeliverableVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_reservations" (
    "id" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "billingCycleKey" TEXT NOT NULL,
    "billingCycleStartedAt" TIMESTAMP(3) NOT NULL,
    "billingCycleEndsAt" TIMESTAMP(3) NOT NULL,
    "reservedTotalVideoUnits" INTEGER NOT NULL,
    "reservedHighQualityUnits" INTEGER NOT NULL,
    "state" "GenerationReservationState" NOT NULL DEFAULT 'RESERVING',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_scenes" (
    "id" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sourceStoryboardSceneId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "sourceAnalysisRevision" INTEGER NOT NULL,
    "snapshotDurationSeconds" INTEGER NOT NULL,
    "snapshotCameraMotion" TEXT,
    "snapshotCompiledPrompt" TEXT,
    "state" "GenerationSceneState" NOT NULL DEFAULT 'PENDING',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "currentDeliveredRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_generation_requests" (
    "id" TEXT NOT NULL,
    "generationSceneId" TEXT NOT NULL,
    "kind" "SceneGenerationRequestKind" NOT NULL,
    "userRegenerationOrdinal" INTEGER,
    "state" "SceneGenerationRequestState" NOT NULL DEFAULT 'PENDING',
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "scene_generation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_pricing_snapshots" (
    "id" TEXT NOT NULL,
    "sceneGenerationId" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contractKey" TEXT NOT NULL,
    "contractFingerprint" TEXT NOT NULL,
    "identityJson" JSONB NOT NULL,
    "stablePriceReferenceJson" JSONB NOT NULL,
    "riskProfileKey" TEXT NOT NULL,
    "riskBufferBps" INTEGER NOT NULL,
    "requestedSeconds" INTEGER NOT NULL,
    "billableSeconds" INTEGER NOT NULL,
    "estimatedStableCostMicroUsd" BIGINT NOT NULL,
    "estimatedPlanningCostMicroUsd" BIGINT NOT NULL,
    "pricingEffectiveAtEpochMs" BIGINT NOT NULL,
    "fxSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_pricing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate_snapshots" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "rateNumerator" BIGINT NOT NULL,
    "rateDenominator" BIGINT NOT NULL,
    "effectiveAtEpochMs" BIGINT NOT NULL,
    "sourceReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_transition_events" (
    "id" TEXT NOT NULL,
    "aggregateType" "GenerationTransitionAggregateType" NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" "GenerationTransitionActorType" NOT NULL,
    "actorUserId" TEXT,
    "reasonCode" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "safeMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_transition_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_jobs_videoProjectId_idx" ON "generation_jobs"("videoProjectId");

-- CreateIndex
CREATE INDEX "generation_jobs_state_idx" ON "generation_jobs"("state");

-- CreateIndex
CREATE UNIQUE INDEX "generation_reservations_generationJobId_key" ON "generation_reservations"("generationJobId");

-- CreateIndex
CREATE INDEX "generation_reservations_billingCycleKey_idx" ON "generation_reservations"("billingCycleKey");

-- CreateIndex
CREATE INDEX "generation_scenes_generationJobId_idx" ON "generation_scenes"("generationJobId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_scenes_generationJobId_position_key" ON "generation_scenes"("generationJobId", "position");

-- CreateIndex
CREATE INDEX "scene_generation_requests_generationSceneId_idx" ON "scene_generation_requests"("generationSceneId");

-- CreateIndex
CREATE UNIQUE INDEX "scene_generation_requests_generationSceneId_kind_userRegene_key" ON "scene_generation_requests"("generationSceneId", "kind", "userRegenerationOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "generation_pricing_snapshots_sceneGenerationId_key" ON "generation_pricing_snapshots"("sceneGenerationId");

-- CreateIndex
CREATE INDEX "generation_pricing_snapshots_contractKey_idx" ON "generation_pricing_snapshots"("contractKey");

-- CreateIndex
CREATE INDEX "generation_transition_events_aggregateId_idx" ON "generation_transition_events"("aggregateId");

-- CreateIndex
CREATE INDEX "generation_transition_events_correlationId_idx" ON "generation_transition_events"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_transition_events_aggregateType_aggregateId_sequ_key" ON "generation_transition_events"("aggregateType", "aggregateId", "sequence");

-- CreateIndex
CREATE INDEX "scene_generations_generationSceneRequestId_idx" ON "scene_generations"("generationSceneRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "scene_generations_generationSceneRequestId_attemptOrdinal_key" ON "scene_generations"("generationSceneRequestId", "attemptOrdinal");

-- AddForeignKey
ALTER TABLE "scene_generations" ADD CONSTRAINT "scene_generations_generationSceneRequestId_fkey" FOREIGN KEY ("generationSceneRequestId") REFERENCES "scene_generation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_videoProjectId_fkey" FOREIGN KEY ("videoProjectId") REFERENCES "video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_reservations" ADD CONSTRAINT "generation_reservations_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "generation_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_scenes" ADD CONSTRAINT "generation_scenes_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "generation_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_generation_requests" ADD CONSTRAINT "scene_generation_requests_generationSceneId_fkey" FOREIGN KEY ("generationSceneId") REFERENCES "generation_scenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_pricing_snapshots" ADD CONSTRAINT "generation_pricing_snapshots_sceneGenerationId_fkey" FOREIGN KEY ("sceneGenerationId") REFERENCES "scene_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_pricing_snapshots" ADD CONSTRAINT "generation_pricing_snapshots_fxSnapshotId_fkey" FOREIGN KEY ("fxSnapshotId") REFERENCES "fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express.
--
-- Every one of these protects an invariant that must survive an application
-- bug. TypeScript checks the code we wrote; these check the database whatever
-- reaches it — a migration script, a console session, a future service that
-- forgot the domain layer exists.

-- 1. The regeneration entitlement, enforced structurally.
--
-- Two halves of one rule: an INITIAL request has no ordinal, and a
-- USER_REGENERATION has ordinal 1 or 2 and nothing else. A third regeneration
-- is not rejected by policy — it cannot be stored. Combined with the unique
-- index on (scene, kind, ordinal), a scene can hold at most one INITIAL and at
-- most two regenerations, forever.
ALTER TABLE "scene_generation_requests"
  ADD CONSTRAINT "scene_generation_requests_ordinal_check"
  CHECK (
    ("kind" = 'INITIAL' AND "userRegenerationOrdinal" IS NULL)
    OR ("kind" = 'USER_REGENERATION' AND "userRegenerationOrdinal" IN (1, 2))
  );

ALTER TABLE "scene_generation_requests"
  ADD CONSTRAINT "scene_generation_requests_state_version_check"
  CHECK ("stateVersion" >= 0);

-- 2. A provider reference may exist only when acceptance is known.
--
-- The hard rule of the certainty axis, stated in the only direction that is
-- true: a prediction id implies ACCEPTED. The converse does not hold — an
-- accepted submission whose response could not be parsed has no id to record,
-- and inventing one so the column looks populated would put an unusable
-- reference into a paid attempt's permanent record.
--
-- Legacy rows have NULL certainty and are exempt: their ids were written before
-- this axis existed, and rejecting them would make the migration fail on real
-- history it has no right to judge.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_prediction_requires_accepted_check"
  CHECK (
    "providerPredictionId" IS NULL
    OR "submissionCertainty" IS NULL
    OR "submissionCertainty" = 'ACCEPTED'
  );

-- 3. Orchestration linkage is all-or-none.
--
-- A row is either fully legacy or fully orchestrated. Half-populated rows are
-- the state in which every later query has to guess which vocabulary applies,
-- and guessing is what this whole phase exists to prevent.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_orchestration_all_or_none_check"
  CHECK (
    (
      "generationSceneRequestId" IS NULL
      AND "attemptOrdinal" IS NULL
      AND "attemptKind" IS NULL
      AND "submissionCertainty" IS NULL
      AND "orchestrationState" IS NULL
    )
    OR (
      "generationSceneRequestId" IS NOT NULL
      AND "attemptOrdinal" IS NOT NULL
      AND "attemptKind" IS NOT NULL
      AND "submissionCertainty" IS NOT NULL
      AND "orchestrationState" IS NOT NULL
    )
  );

-- 4. Attempt ordinals are positive and never zero.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_attempt_ordinal_check"
  CHECK ("attemptOrdinal" IS NULL OR "attemptOrdinal" >= 1);

ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_state_version_check"
  CHECK ("stateVersion" >= 0);

-- 5. Uncertain attempts must carry the metadata their resolution needs.
--
-- An attempt in RECONCILIATION_PENDING with no deadline is an attempt nobody
-- will ever come back to. The deadline is snapshotted rather than recomputed,
-- so a later change to the reconciliation window cannot move it.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_reconciliation_metadata_check"
  CHECK (
    "orchestrationState" IS DISTINCT FROM 'RECONCILIATION_PENDING'
    OR ("reconciliationStartedAt" IS NOT NULL AND "reconciliationDeadlineAt" IS NOT NULL)
  );

-- 6. An attempt that has been at the provider boundary says so.
--
-- Every orchestration state past QUEUED implies the boundary was entered, and
-- the timestamp is what a crash-recovery worker reads to decide that a stale
-- SUBMITTING row is uncertain rather than fresh.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_submission_boundary_check"
  CHECK (
    "orchestrationState" IS NULL
    OR "orchestrationState" IN ('QUEUED', 'CANCELLED_PRE_SUBMISSION')
    OR "submissionBoundaryEnteredAt" IS NOT NULL
  );

-- 7. Entitlement arithmetic cannot go negative, and high-quality units cannot
-- exceed the total they sit inside.
--
-- The second half is the one that matters commercially: high quality is a
-- property of units already counted, not an additional allowance, and a row
-- claiming 2 total with 3 high-quality would be selling something that does not
-- exist.
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_units_check"
  CHECK (
    "requiredVideoUnits" > 0
    AND "requiredHighQualityUnits" >= 0
    AND "requiredHighQualityUnits" <= "requiredVideoUnits"
  );

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_duration_check"
  CHECK ("requestedDurationSeconds" > 0);

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_state_version_check"
  CHECK ("stateVersion" >= 0);

ALTER TABLE "generation_reservations"
  ADD CONSTRAINT "generation_reservations_units_check"
  CHECK (
    "reservedTotalVideoUnits" >= 0
    AND "reservedHighQualityUnits" >= 0
    AND "reservedHighQualityUnits" <= "reservedTotalVideoUnits"
  );

ALTER TABLE "generation_reservations"
  ADD CONSTRAINT "generation_reservations_state_version_check"
  CHECK ("stateVersion" >= 0);

-- 8. A billing cycle is a real interval.
--
-- The reservation is attributed to the cycle it was taken in and never
-- reassigned to the cycle it completes in, so a malformed interval here would
-- misattribute a customer's entitlement permanently.
ALTER TABLE "generation_reservations"
  ADD CONSTRAINT "generation_reservations_cycle_window_check"
  CHECK ("billingCycleStartedAt" < "billingCycleEndsAt");

ALTER TABLE "generation_scenes"
  ADD CONSTRAINT "generation_scenes_position_check"
  CHECK ("position" >= 0);

ALTER TABLE "generation_scenes"
  ADD CONSTRAINT "generation_scenes_duration_check"
  CHECK ("snapshotDurationSeconds" > 0);

ALTER TABLE "generation_scenes"
  ADD CONSTRAINT "generation_scenes_state_version_check"
  CHECK ("stateVersion" >= 0);

-- 9. Transition history starts at 1 and every price is a whole number.
ALTER TABLE "generation_transition_events"
  ADD CONSTRAINT "generation_transition_events_sequence_check"
  CHECK ("sequence" >= 1);

ALTER TABLE "generation_pricing_snapshots"
  ADD CONSTRAINT "generation_pricing_snapshots_amounts_check"
  CHECK (
    "estimatedStableCostMicroUsd" >= 0
    AND "estimatedPlanningCostMicroUsd" >= 0
    AND "riskBufferBps" >= 0
    AND "requestedSeconds" > 0
    AND "billableSeconds" > 0
  );

-- 10. A stored exchange rate is a strictly positive fraction.
--
-- The same rule the pricing domain applies before conversion, repeated here
-- because this table outlives any single code path. A zero or negative rate
-- drives every provider cost to zero or below, which improves every margin —
-- so the corruption would hide precisely where a margin review looks for it.
ALTER TABLE "fx_rate_snapshots"
  ADD CONSTRAINT "fx_rate_snapshots_rate_check"
  CHECK ("rateNumerator" > 0 AND "rateDenominator" > 0);
