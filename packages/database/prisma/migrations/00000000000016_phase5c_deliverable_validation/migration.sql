-- Phase 5C — durable deliverable validation.
--
-- One table, one enum, and the shape constraints that keep an impossible row
-- impossible in the database rather than only in TypeScript.
--
-- Two existing enums are **reused, not copied**: `ManagedOutputMediaInvalidReason`
-- and `ManagedOutputContainerFamily`. "Is this file playable video" is the same
-- question for a provider attempt's output and for a composed deliverable, and a
-- second five-member copy of those types would drift from the first the moment
-- either is extended.
--
-- No publication column. A deliverable is published when the job says
-- DELIVERABLE_READY, the job's pointer names this version, and the hold is
-- CONSUMED; Transaction G writes those three in one commit. Recording it a
-- fourth time here would create a fourth thing to disagree.
--
-- No backfill. Nothing here reads, updates or rewrites an existing orchestration
-- row: deliverable versions composed by Phase 5B carry no validation row until a
-- worker claims one, and an absent row is an eligible state rather than a gap.
--
-- Migrations 0 through 15 are not touched.

-- CreateEnum
-- `RETRYABLE_FAILURE` is deliberately not a member. It is not a verdict about
-- the video; it is the absence of one, and it returns the row to PENDING with a
-- future instant. A storage hiccup must never become a permanent record that a
-- customer's deliverable is unusable.
CREATE TYPE "DeliverableValidationStatus" AS ENUM ('PENDING', 'RUNNING', 'VALID', 'INVALID_MEDIA', 'INTEGRITY_MISMATCH');

-- CreateTable
CREATE TABLE "generation_deliverable_validations" (
    "id" TEXT NOT NULL,
    "deliverableVersionId" TEXT NOT NULL,
    "status" "DeliverableValidationStatus" NOT NULL DEFAULT 'PENDING',
    "receiptSha256" TEXT NOT NULL,
    "receiptSizeBytes" BIGINT NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "invalidReason" "ManagedOutputMediaInvalidReason",
    "container" "ManagedOutputContainerFamily",
    "durationMs" BIGINT,
    "videoWidth" BIGINT,
    "videoHeight" BIGINT,
    "videoStreamCount" BIGINT,
    "audioStreamCount" BIGINT,
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_deliverable_validations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliverable_validations_deliverableVersionId_key" ON "generation_deliverable_validations"("deliverableVersionId");

-- CreateIndex
CREATE INDEX "generation_deliverable_validations_status_nextAttemptAt_idx" ON "generation_deliverable_validations"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "generation_deliverable_validations_status_leaseExpiresAt_idx" ON "generation_deliverable_validations"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "generation_deliverable_validations" ADD CONSTRAINT "generation_deliverable_validations_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shape: counters are never negative.
ALTER TABLE "generation_deliverable_validations"
  ADD CONSTRAINT "deliverable_validation_counters_check"
  CHECK ("attemptCount" >= 0 AND "version" >= 0);

-- Shape: the frozen byte binding is a receipt the domain can represent.
--
-- Matching `deliverable_composition_receipt_check`, and NOT NULL here rather
-- than nullable there: a validation row is only ever created against a
-- composition that already carries a complete receipt, so a row that could not
-- name the bytes it is judging must not exist at all. Zero bytes never became a
-- canonical object; the upper bound keeps the column's range and the domain's
-- range the same range.
ALTER TABLE "generation_deliverable_validations"
  ADD CONSTRAINT "deliverable_validation_receipt_check"
  CHECK (
    "receiptSha256" ~ '^[0-9a-f]{64}$'
    AND "receiptSizeBytes" > 0
    AND "receiptSizeBytes" <= 9007199254740991
  );

-- Shape: the recorded media facts are inside the domain's own range.
--
-- Matching `managed_output_media_validation_facts_check`. Duration and the two
-- dimensions are strictly positive -- a zero-length or zero-pixel "valid" video
-- is not one -- and the video stream count is positive because a VALID verdict
-- claims there is a stream to play. The audio count is merely non-negative:
-- zero is legal, and requiring audio would encode a product rule nobody made.
ALTER TABLE "generation_deliverable_validations"
  ADD CONSTRAINT "deliverable_validation_facts_check"
  CHECK (
    ("durationMs" IS NULL OR ("durationMs" > 0 AND "durationMs" <= 9007199254740991))
    AND ("videoWidth" IS NULL OR ("videoWidth" > 0 AND "videoWidth" <= 9007199254740991))
    AND ("videoHeight" IS NULL OR ("videoHeight" > 0 AND "videoHeight" <= 9007199254740991))
    AND ("videoStreamCount" IS NULL OR ("videoStreamCount" > 0 AND "videoStreamCount" <= 9007199254740991))
    AND ("audioStreamCount" IS NULL OR ("audioStreamCount" >= 0 AND "audioStreamCount" <= 9007199254740991))
  );

-- Shape: each status admits exactly one arrangement of the lease, retry and
-- verdict columns.
--
-- Without this a row can claim to be VALID while still holding a lease, or
-- PENDING with no instant at which it becomes due, or INVALID_MEDIA with media
-- facts describing a video it just called unusable, or VALID with four of the
-- five facts -- states TypeScript can refuse and a direct UPDATE cannot.
--
-- The five facts are all-or-none in the VALID arm, because a container with no
-- duration is not a description of anything, and a partially written fact set is
-- exactly what a later reader would average over.
--
-- `invalidReason` exists in the INVALID_MEDIA arm and nowhere else. An
-- INTEGRITY_MISMATCH is not a statement about media at all -- the object is not
-- the bytes that were published -- so carrying a media reason there would assert
-- something nobody measured.
ALTER TABLE "generation_deliverable_validations"
  ADD CONSTRAINT "deliverable_validation_status_shape_check"
  CHECK (
    (
      "status" = 'PENDING'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NOT NULL
      AND "invalidReason" IS NULL
      AND "container" IS NULL
      AND "durationMs" IS NULL
      AND "videoWidth" IS NULL
      AND "videoHeight" IS NULL
      AND "videoStreamCount" IS NULL
      AND "audioStreamCount" IS NULL
      AND "validatedAt" IS NULL
    )
    OR (
      "status" = 'RUNNING'
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "nextAttemptAt" IS NULL
      AND "invalidReason" IS NULL
      AND "container" IS NULL
      AND "durationMs" IS NULL
      AND "videoWidth" IS NULL
      AND "videoHeight" IS NULL
      AND "videoStreamCount" IS NULL
      AND "audioStreamCount" IS NULL
      AND "validatedAt" IS NULL
    )
    OR (
      "status" = 'VALID'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND "invalidReason" IS NULL
      AND "container" IS NOT NULL
      AND "durationMs" IS NOT NULL
      AND "videoWidth" IS NOT NULL
      AND "videoHeight" IS NOT NULL
      AND "videoStreamCount" IS NOT NULL
      AND "audioStreamCount" IS NOT NULL
      AND "validatedAt" IS NOT NULL
    )
    OR (
      "status" = 'INVALID_MEDIA'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND "invalidReason" IS NOT NULL
      AND "container" IS NULL
      AND "durationMs" IS NULL
      AND "videoWidth" IS NULL
      AND "videoHeight" IS NULL
      AND "videoStreamCount" IS NULL
      AND "audioStreamCount" IS NULL
      AND "validatedAt" IS NOT NULL
    )
    OR (
      "status" = 'INTEGRITY_MISMATCH'
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND "invalidReason" IS NULL
      AND "container" IS NULL
      AND "durationMs" IS NULL
      AND "videoWidth" IS NULL
      AND "videoHeight" IS NULL
      AND "videoStreamCount" IS NULL
      AND "audioStreamCount" IS NULL
      AND "validatedAt" IS NOT NULL
    )
  );
