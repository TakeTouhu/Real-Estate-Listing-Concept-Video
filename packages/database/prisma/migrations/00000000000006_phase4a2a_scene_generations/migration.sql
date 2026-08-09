-- CreateEnum
CREATE TYPE "SceneGenerationState" AS ENUM ('QUEUED', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'SUBMISSION_UNKNOWN', 'CANCELLED');

-- CreateTable
CREATE TABLE "scene_generations" (
    "id" TEXT NOT NULL,
    "videoProjectId" TEXT NOT NULL,
    "sourceStoryboardSceneId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sourceAnalysisRevision" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "state" "SceneGenerationState" NOT NULL DEFAULT 'QUEUED',
    "providerPredictionId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "normalizedErrorCode" TEXT,
    "normalizedErrorMessage" TEXT,
    "outputStorageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scene_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scene_generations_videoProjectId_idx" ON "scene_generations"("videoProjectId");

-- CreateIndex
CREATE INDEX "scene_generations_state_idx" ON "scene_generations"("state");

-- AddForeignKey
-- RESTRICT, not CASCADE. A generation row may record a paid provider attempt,
-- so a future physical project deletion has to resolve retention policy
-- deliberately instead of silently erasing that history. No physical deletion
-- path exists today (property removal is a soft delete), so this is fail-closed
-- rather than behaviour-changing. See docs/decisions/TODO.md.
ALTER TABLE "scene_generations" ADD CONSTRAINT "scene_generations_videoProjectId_fkey" FOREIGN KEY ("videoProjectId") REFERENCES "video_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberately NO foreign key on "sourceStoryboardSceneId" or "assetId".
-- StoryboardService.compose replaces a project's scenes wholesale, deleting
-- every row and re-inserting with fresh ids, and media assets are removed by
-- the retention pipeline. A cascade from either would destroy the record of a
-- paid external call; a restrict would block ordinary recomposition. Both
-- columns are provenance (ADR-0016).


-- Hand-written: Prisma cannot express a partial index in schema.prisma, so this
-- constraint is added directly. It makes the database authoritative for
-- "at most one ACTIVE generation attempt per (videoProjectId, requestHash)",
-- which is what makes concurrent submissions safe: the loser gets a unique
-- violation rather than a second, separately billed provider POST.
--
-- The predicate lists exactly ACTIVE_SCENE_GENERATION_STATES from
-- packages/domain/src/generation/state-machine.ts. FAILED_RETRYABLE is included
-- because it can return to QUEUED, and SUBMISSION_UNKNOWN because the provider
-- may already hold a billed prediction for that request. Terminal states —
-- SUCCEEDED, FAILED_TERMINAL, CANCELLED — release the identity so a deliberate
-- regeneration can create a new attempt.
--
-- tests/schema/active-generation-states.test.ts parses this predicate and fails
-- if it stops matching the domain's exported set.
CREATE UNIQUE INDEX "scene_generations_active_request_key"
  ON "scene_generations" ("videoProjectId", "requestHash")
  WHERE "state" IN ('QUEUED', 'SUBMITTING', 'PROCESSING', 'FAILED_RETRYABLE', 'SUBMISSION_UNKNOWN');
