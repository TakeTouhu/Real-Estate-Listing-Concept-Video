-- GS-4b — a start key on the job (ADR-0087).
--
-- docs/API.md requires an Idempotency-Key for generation commands, and the
-- approved plan says pressing start twice starts one job. One nullable column
-- and its unique index:
--
--   generation_jobs.idempotencyKey  the key the customer's start carried; a
--                                   second start with the same key on the same
--                                   project answers with this job
--
-- Unique per project, not per organization as docs/DataModel.md sketches: the
-- job has no organization column, and a project belongs to one organization,
-- so a replay always names the same project. NULL for every existing job and
-- for every job the single-scene path makes, and PostgreSQL's unique index
-- admits any number of NULLs. No existing row is touched.
--
-- The CHECK bounds a key to 1-200 characters, the bound unit_purchases uses
-- (migration 27). Prisma cannot express it, so the schema drift check does not
-- see it.

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_videoProjectId_idempotencyKey_key" ON "generation_jobs"("videoProjectId", "idempotencyKey");

-- A usable key, or none.
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_idempotency_key_check"
  CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") BETWEEN 1 AND 200);
