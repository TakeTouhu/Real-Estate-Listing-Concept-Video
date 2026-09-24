-- Phase 5A — durable deliverable composition plan.
--
-- Two new tables, the shape constraints that keep an impossible row impossible
-- in the database rather than only in TypeScript, and the foreign key that
-- finally binds `generation_jobs.currentDeliverableVersionId` to something real.
--
-- No backfill. Nothing here reads, inserts, updates or deletes an existing
-- orchestration row. Jobs that already delivered under earlier phases carry no
-- deliverable version, and fabricating one would be inventing a plan that never
-- existed.
--
-- The current-pointer foreign key is safe to add without any data step: the
-- column has been nullable with no default since migration 10, no migration has
-- ever written a value into it, and the repository has no write path that sets
-- it. Every non-null value in existence is created by an integration fixture
-- after schema setup, in a disposable database.

-- CreateTable
CREATE TABLE "generation_deliverable_versions" (
    "id" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_deliverable_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_deliverable_inputs" (
    "id" TEXT NOT NULL,
    "deliverableVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "generationSceneId" TEXT NOT NULL,
    "sceneGenerationRequestId" TEXT NOT NULL,
    "sceneGenerationAttemptId" TEXT NOT NULL,
    "mediaValidationId" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceSizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_deliverable_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_deliverable_versions_generationJobId_idx" ON "generation_deliverable_versions"("generationJobId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliverable_versions_generationJobId_ordinal_key" ON "generation_deliverable_versions"("generationJobId", "ordinal");

-- CreateIndex
-- The composite key `generation_jobs.currentDeliverableVersionId` points
-- through. Redundant as a uniqueness claim — `id` is already the primary key —
-- and required by PostgreSQL, because a foreign key must reference a uniquely
-- constrained column list.
CREATE UNIQUE INDEX "generation_deliverable_versions_id_generationJobId_key" ON "generation_deliverable_versions"("id", "generationJobId");

-- CreateIndex
CREATE INDEX "generation_deliverable_inputs_generationSceneId_idx" ON "generation_deliverable_inputs"("generationSceneId");

-- CreateIndex
CREATE INDEX "generation_deliverable_inputs_sceneGenerationAttemptId_idx" ON "generation_deliverable_inputs"("sceneGenerationAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliverable_inputs_deliverableVersionId_position_key" ON "generation_deliverable_inputs"("deliverableVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliverable_inputs_deliverableVersionId_generati_key" ON "generation_deliverable_inputs"("deliverableVersionId", "generationSceneId");

-- AddForeignKey
-- The ownership guarantee, in the database rather than in a comment: a non-null
-- `currentDeliverableVersionId` can only ever name a version whose own
-- `generationJobId` is this job. A nonexistent id and another job's version are
-- both rejected. Exactly the pattern
-- `generation_scenes.currentDeliveredRequestId` already uses.
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_currentDeliverableVersionId_id_fkey" FOREIGN KEY ("currentDeliverableVersionId", "id") REFERENCES "generation_deliverable_versions"("id", "generationJobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT throughout this migration, never CASCADE: every row referenced here
-- is paid generated history, so a physical deletion must resolve retention
-- policy deliberately rather than erasing it through a cascade that happened to
-- be in the schema.
ALTER TABLE "generation_deliverable_versions" ADD CONSTRAINT "generation_deliverable_versions_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "generation_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_deliverable_inputs" ADD CONSTRAINT "generation_deliverable_inputs_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_deliverable_inputs" ADD CONSTRAINT "generation_deliverable_inputs_generationSceneId_fkey" FOREIGN KEY ("generationSceneId") REFERENCES "generation_scenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_deliverable_inputs" ADD CONSTRAINT "generation_deliverable_inputs_sceneGenerationRequestId_fkey" FOREIGN KEY ("sceneGenerationRequestId") REFERENCES "scene_generation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_deliverable_inputs" ADD CONSTRAINT "generation_deliverable_inputs_sceneGenerationAttemptId_fkey" FOREIGN KEY ("sceneGenerationAttemptId") REFERENCES "scene_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_deliverable_inputs" ADD CONSTRAINT "generation_deliverable_inputs_mediaValidationId_fkey" FOREIGN KEY ("mediaValidationId") REFERENCES "managed_output_media_validations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: a deliverable version is ordinal 1 or later.
--
-- Zero is not a smaller first version, it is a different vocabulary, and a
-- negative ordinal would sort ahead of every real one in the "highest ordinal is
-- the planned version" query the rest of the system relies on.
ALTER TABLE "generation_deliverable_versions"
  ADD CONSTRAINT "generation_deliverable_version_ordinal_check"
  CHECK ("ordinal" >= 1);

-- Shape: an input's position matches the scene position vocabulary.
--
-- The same lower bound `generation_scenes_position_check` already sets, because
-- this column is that column frozen — planning never renumbers scenes.
ALTER TABLE "generation_deliverable_inputs"
  ADD CONSTRAINT "generation_deliverable_input_position_check"
  CHECK ("position" >= 0);

-- Shape: the frozen receipt is a real receipt.
--
-- Canonical lowercase hex and a positive byte count, matching
-- `scene_generations_output_sha256_check`. Zero bytes never became a canonical
-- object, so zero here would be a receipt for something that was never
-- verified; the upper bound keeps the column's range and the domain's range the
-- same range, so a value that round-trips through the database cannot stop being
-- a safe JavaScript integer.
ALTER TABLE "generation_deliverable_inputs"
  ADD CONSTRAINT "generation_deliverable_input_receipt_check"
  CHECK (
    "sourceSha256" ~ '^[0-9a-f]{64}$'
    AND "sourceSizeBytes" > 0
    AND "sourceSizeBytes" <= 9007199254740991
  );
