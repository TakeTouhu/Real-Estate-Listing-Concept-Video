-- Phase 5B — durable deliverable composition execution.
--
-- One table, two enums, and the shape constraints that keep an impossible row
-- impossible in the database rather than only in TypeScript.
--
-- No backfill. Nothing here reads, updates or rewrites an existing orchestration
-- row: deliverable versions planned by Phase 5A carry no composition row until a
-- worker claims one, and an absent row is an eligible state rather than a gap.
--
-- Migration 14 is not touched. The deliverable plan's shape is settled.

-- CreateEnum
CREATE TYPE "DeliverableCompositionStatus" AS ENUM ('PENDING', 'RUNNING', 'OUTPUT_VERIFIED');

-- CreateEnum
CREATE TYPE "DeliverableCompositionRetryCode" AS ENUM ('SOURCE_READ_RETRYABLE', 'SOURCE_INTEGRITY_MISMATCH', 'COMPOSER_RETRYABLE', 'OUTPUT_PUBLISH_RETRYABLE');

-- CreateTable
CREATE TABLE "generation_deliverable_compositions" (
    "id" TEXT NOT NULL,
    "deliverableVersionId" TEXT NOT NULL,
    "status" "DeliverableCompositionStatus" NOT NULL DEFAULT 'PENDING',
    "profileKey" TEXT NOT NULL,
    "targetWidthPx" INTEGER NOT NULL,
    "targetHeightPx" INTEGER NOT NULL,
    "frameRateNumerator" INTEGER NOT NULL,
    "frameRateDenominator" INTEGER NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "pixelFormat" TEXT NOT NULL,
    "fitMode" TEXT NOT NULL,
    "transitionMode" TEXT NOT NULL,
    "audioMode" TEXT NOT NULL,
    "encoderPreset" TEXT NOT NULL,
    "crf" INTEGER NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastRetryCode" "DeliverableCompositionRetryCode",
    "outputStorageKey" TEXT,
    "outputSha256" TEXT,
    "outputSizeBytes" BIGINT,
    "outputVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_deliverable_compositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliverable_compositions_deliverableVersionId_key" ON "generation_deliverable_compositions"("deliverableVersionId");

-- CreateIndex
CREATE INDEX "generation_deliverable_compositions_status_nextAttemptAt_idx" ON "generation_deliverable_compositions"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "generation_deliverable_compositions_status_leaseExpiresAt_idx" ON "generation_deliverable_compositions"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "generation_deliverable_compositions" ADD CONSTRAINT "generation_deliverable_compositions_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shape: counters are never negative.
ALTER TABLE "generation_deliverable_compositions"
  ADD CONSTRAINT "deliverable_composition_counters_check"
  CHECK ("attemptCount" >= 0 AND "version" >= 0);

-- Shape: the frozen raster is encodable.
--
-- Positive and EVEN on both axes. `yuv420p` subsamples chroma by two in each
-- direction, so an odd dimension is not merely unusual — it cannot be encoded
-- in the pixel format this profile fixes. The frame rate is a rational, so both
-- halves must be positive or it is not a rate at all.
ALTER TABLE "generation_deliverable_compositions"
  ADD CONSTRAINT "deliverable_composition_raster_check"
  CHECK (
    "targetWidthPx" > 0
    AND "targetHeightPx" > 0
    AND "targetWidthPx" % 2 = 0
    AND "targetHeightPx" % 2 = 0
    AND "frameRateNumerator" > 0
    AND "frameRateDenominator" > 0
  );

-- Shape: profile v1 admits exactly one CRF.
--
-- Deliberately an equality rather than a range. v1 has one quality setting; a
-- range would invite a per-row value nobody reviewed, and a future v2 will carry
-- its own profile key and its own constraint.
ALTER TABLE "generation_deliverable_compositions"
  ADD CONSTRAINT "deliverable_composition_crf_check"
  CHECK ("crf" = 18);

-- Shape: canonical lowercase hex, and a byte count the domain can represent.
--
-- Matching `scene_generations_output_sha256_check`. Zero bytes never became a
-- canonical object, so zero here would be a receipt for something that was never
-- published; the upper bound keeps the column's range and the domain's range the
-- same range.
ALTER TABLE "generation_deliverable_compositions"
  ADD CONSTRAINT "deliverable_composition_receipt_check"
  CHECK (
    ("outputSha256" IS NULL OR "outputSha256" ~ '^[0-9a-f]{64}$')
    AND ("outputSizeBytes" IS NULL OR ("outputSizeBytes" > 0 AND "outputSizeBytes" <= 9007199254740991))
  );

-- Shape: each status admits exactly one arrangement of the lease, retry and
-- receipt columns.
--
-- Without this a row can claim to be OUTPUT_VERIFIED while still holding a
-- lease, or PENDING with no instant at which it becomes due, or RUNNING with a
-- half-written receipt — states TypeScript can refuse and a direct UPDATE
-- cannot. The receipt columns are all-or-none in the verified arm, because a
-- digest without a byte count is not a receipt.
ALTER TABLE "generation_deliverable_compositions"
  ADD CONSTRAINT "deliverable_composition_status_shape_check"
  CHECK (
    (
      "status" = 'PENDING'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NOT NULL
      AND "outputStorageKey" IS NULL
      AND "outputSha256" IS NULL
      AND "outputSizeBytes" IS NULL
      AND "outputVerifiedAt" IS NULL
    )
    OR (
      "status" = 'RUNNING'
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "nextAttemptAt" IS NULL
      AND "outputStorageKey" IS NULL
      AND "outputSha256" IS NULL
      AND "outputSizeBytes" IS NULL
      AND "outputVerifiedAt" IS NULL
    )
    OR (
      "status" = 'OUTPUT_VERIFIED'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND "outputStorageKey" IS NOT NULL
      AND "outputSha256" IS NOT NULL
      AND "outputSizeBytes" IS NOT NULL
      AND "outputVerifiedAt" IS NOT NULL
    )
  );
