-- Phase 4C-3B-2H-3B-6C — durable media-failure resolution work.
--
-- One new table, three new enums, and the shape constraints that keep an
-- impossible row impossible in the database rather than only in TypeScript.
--
-- No backfill. Nothing here reads, updates or rewrites an existing orchestration
-- row: historical terminal media failures are discovered lazily by the sweep,
-- exactly as the validation records themselves are.

-- CreateEnum
CREATE TYPE "MediaFailureResolutionStatus" AS ENUM ('PENDING', 'RUNNING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MediaFailureResolutionKind" AS ENUM (
  'RECOVERY_ADMITTED',
  'INITIAL_FAILURE_SETTLED',
  'USER_REGENERATION_ROLLED_BACK',
  'OBSOLETE'
);

-- CreateEnum
CREATE TYPE "MediaRecoveryPlanRefusalCode" AS ENUM (
  'PERSISTED_PRICING_IDENTITY_MALFORMED',
  'NO_SAFE_CURRENT_ROUTE',
  'NO_SAFE_CURRENT_PRICING',
  'AMBIGUOUS_CURRENT_PRICING'
);

-- CreateTable
CREATE TABLE "managed_output_media_failure_resolutions" (
    "id" TEXT NOT NULL,
    "managedOutputMediaValidationId" TEXT NOT NULL,
    "status" "MediaFailureResolutionStatus" NOT NULL DEFAULT 'PENDING',
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastPlanRefusalCode" "MediaRecoveryPlanRefusalCode",
    "resolutionKind" "MediaFailureResolutionKind",
    "recoveryAttemptId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_output_media_failure_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "managed_output_media_failure_resolutions_managedOutputMedia_key"
  ON "managed_output_media_failure_resolutions" ("managedOutputMediaValidationId");

-- CreateIndex
CREATE INDEX "managed_output_media_failure_resolutions_status_nextAttempt_idx"
  ON "managed_output_media_failure_resolutions" ("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "managed_output_media_failure_resolutions_status_leaseExpire_idx"
  ON "managed_output_media_failure_resolutions" ("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "managed_output_media_failure_resolutions_recoveryAttemptId_idx"
  ON "managed_output_media_failure_resolutions" ("recoveryAttemptId");

-- AddForeignKey
-- RESTRICT, never CASCADE: this row is durable evidence about a possibly-paid
-- attempt's failure, so a physical deletion must resolve retention deliberately.
ALTER TABLE "managed_output_media_failure_resolutions"
  ADD CONSTRAINT "managed_output_media_failure_resolutions_managedOutputMedi_fkey"
  FOREIGN KEY ("managedOutputMediaValidationId")
  REFERENCES "managed_output_media_validations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_output_media_failure_resolutions"
  ADD CONSTRAINT "managed_output_media_failure_resolutions_recoveryAttemptId_fkey"
  FOREIGN KEY ("recoveryAttemptId")
  REFERENCES "scene_generations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: counters are never negative.
ALTER TABLE "managed_output_media_failure_resolutions"
  ADD CONSTRAINT "media_failure_resolution_counters_check"
  CHECK ("attemptCount" >= 0 AND "version" >= 0);

-- Shape: each status admits exactly one arrangement of the lease, retry and
-- terminal columns. Without this, a row can claim to be RESOLVED while still
-- holding a lease, or PENDING with no instant at which it becomes due — states
-- TypeScript can refuse and a direct UPDATE cannot.
ALTER TABLE "managed_output_media_failure_resolutions"
  ADD CONSTRAINT "media_failure_resolution_status_shape_check"
  CHECK (
    (
      "status" = 'PENDING'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NOT NULL
      AND "resolutionKind" IS NULL
      AND "recoveryAttemptId" IS NULL
      AND "resolvedAt" IS NULL
    )
    OR (
      "status" = 'RUNNING'
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "nextAttemptAt" IS NULL
      AND "resolutionKind" IS NULL
      AND "recoveryAttemptId" IS NULL
      AND "resolvedAt" IS NULL
    )
    OR (
      "status" = 'RESOLVED'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND "resolutionKind" IS NOT NULL
      AND "resolvedAt" IS NOT NULL
    )
  );

-- Shape: only a recovery names an attempt, and it must name one.
--
-- Separate from the status check so a violation says which rule was broken: the
-- lifecycle arrangement, or the binding between a resolution kind and the
-- attempt it claims to have produced.
ALTER TABLE "managed_output_media_failure_resolutions"
  ADD CONSTRAINT "media_failure_resolution_recovery_binding_check"
  CHECK (
    ("resolutionKind" = 'RECOVERY_ADMITTED' AND "recoveryAttemptId" IS NOT NULL)
    OR ("resolutionKind" IS DISTINCT FROM 'RECOVERY_ADMITTED' AND "recoveryAttemptId" IS NULL)
  );
