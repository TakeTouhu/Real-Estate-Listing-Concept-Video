-- Phase 4C-3B-2H-3B-5: durable managed-output media-validation lifecycle.
--
-- WHY THIS IS A SEPARATE TABLE AND NOT ANOTHER ATTEMPT STATE
--
-- `OUTPUT_VERIFIED` is terminal for the provider-attempt byte-integrity
-- lifecycle and means exactly one thing: canonical managed bytes were copied
-- and byte-level integrity was verified. Appending a media state after it would
-- retroactively redefine what every already-`OUTPUT_VERIFIED` row claimed, and
-- would bind a question about container structure to a state machine about
-- provider execution. Media validity is orthogonal, so it gets its own
-- one-to-one record with its own closed vocabulary.
--
-- NO BACKFILL, ON PURPOSE
--
-- Nothing here creates a validation row for an existing `OUTPUT_VERIFIED`
-- attempt, and the completion transaction is deliberately not modified to start
-- creating them. A backfilled row would have to claim a status nobody
-- established. Instead the *absence* of a row is itself an eligible state: the
-- lifecycle runner discovers historical attempts lazily and validates them for
-- the first time. That keeps completion untouched and needs no data migration.

-- ---------------------------------------------------------------------------
-- 1. Closed vocabularies.
--
-- Enums rather than text columns. A raw ffprobe format name, codec, stderr
-- line, JSON blob, command string, signal name, AWS error or temporary path
-- must never become persisted state; making the column an enum means it cannot,
-- even through a direct SQL write that bypasses the application.
-- ---------------------------------------------------------------------------
CREATE TYPE "ManagedOutputMediaValidationStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'VALID',
  'INVALID_MEDIA',
  'INTEGRITY_MISMATCH'
);

CREATE TYPE "ManagedOutputMediaInvalidReason" AS ENUM (
  'CONTAINER_UNSUPPORTED',
  'VIDEO_STREAM_MISSING',
  'VIDEO_DIMENSIONS_INVALID',
  'DURATION_INVALID',
  'PROBE_REJECTED'
);

CREATE TYPE "ManagedOutputContainerFamily" AS ENUM ('ISO_BMFF');

-- ---------------------------------------------------------------------------
-- 2. The durable record.
--
-- BIGINT for every numeric media fact and for the receipt size, matching
-- `scene_generations.outputSizeBytes`: the domain admits any positive safe
-- integer, and int4 would silently overflow on a value the validator accepted.
-- ---------------------------------------------------------------------------
CREATE TABLE "managed_output_media_validations" (
  "id"                TEXT NOT NULL,
  "sceneGenerationId" TEXT NOT NULL,
  "status"            "ManagedOutputMediaValidationStatus" NOT NULL DEFAULT 'PENDING',
  "receiptSha256"     TEXT NOT NULL,
  "receiptSizeBytes"  BIGINT NOT NULL,
  "leaseToken"        TEXT,
  "leaseExpiresAt"    TIMESTAMP(3),
  "nextAttemptAt"     TIMESTAMP(3),
  "attemptCount"      INTEGER NOT NULL DEFAULT 0,
  "version"           INTEGER NOT NULL DEFAULT 0,
  "invalidReason"     "ManagedOutputMediaInvalidReason",
  "container"         "ManagedOutputContainerFamily",
  "durationMs"        BIGINT,
  "videoWidth"        BIGINT,
  "videoHeight"       BIGINT,
  "videoStreamCount"  BIGINT,
  "audioStreamCount"  BIGINT,
  "validatedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_output_media_validations_pkey" PRIMARY KEY ("id")
);

-- One validation per attempt. This uniqueness is what makes two workers racing
-- to create the first record resolvable: exactly one insert wins, and the loser
-- re-reads rather than retrying blindly.
CREATE UNIQUE INDEX "managed_output_media_validations_sceneGenerationId_key"
  ON "managed_output_media_validations"("sceneGenerationId");

-- RESTRICT, never CASCADE. A validation record describes the output of a
-- possibly-paid attempt; a future physical deletion must resolve retention
-- policy deliberately rather than erasing durable validation history through a
-- cascade that happened to be in the schema.
ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "managed_output_media_validations_sceneGenerationId_fkey"
  FOREIGN KEY ("sceneGenerationId") REFERENCES "scene_generations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Worker indexes.
--
-- Exactly the two the lifecycle runner needs, and no speculative others: due
-- PENDING rows, and expired RUNNING leases.
-- ---------------------------------------------------------------------------
CREATE INDEX "managed_output_media_validations_status_nextAttemptAt_idx"
  ON "managed_output_media_validations"("status", "nextAttemptAt");

CREATE INDEX "managed_output_media_validations_status_leaseExpiresAt_idx"
  ON "managed_output_media_validations"("status", "leaseExpiresAt");

-- The candidate sweep scans OUTPUT_VERIFIED attempts ordered by
-- `outputVerifiedAt`. `scene_generations` had indexes on `videoProjectId`,
-- `state` and `generationSceneRequestId` only — none of which helps — so this
-- is the smallest supporting index the sweep needs, and the only change this
-- migration makes to an existing table.
CREATE INDEX "scene_generations_orchestrationState_outputVerifiedAt_idx"
  ON "scene_generations"("orchestrationState", "outputVerifiedAt");

-- ---------------------------------------------------------------------------
-- 4. Byte-binding shape.
--
-- The receipt is frozen at creation and names the exact bytes this verdict is
-- about. Without it, a record created against one object could later be read as
-- a verdict about a different object at the same key — precisely the situation
-- INTEGRITY_MISMATCH exists to detect.
-- ---------------------------------------------------------------------------
ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "momv_receipt_sha256_format_check"
  CHECK ("receiptSha256" ~ '^[0-9a-f]{64}$');

-- Upper bound is Number.MAX_SAFE_INTEGER so the column's range and the
-- application's range are the *same* range. Above 2^53-1, reading the column
-- into a JavaScript number is silently lossy, so a value that was never written
-- would compare cleanly against a receipt.
ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "momv_receipt_size_range_check"
  CHECK ("receiptSizeBytes" > 0 AND "receiptSizeBytes" <= 9007199254740991);

ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "momv_counters_non_negative_check"
  CHECK ("attemptCount" >= 0 AND "version" >= 0);

-- ---------------------------------------------------------------------------
-- 5. Media-fact ranges.
--
-- Five positive facts and one that may be zero. `audioStreamCount = 0` is legal
-- and meaningful: a generated walkthrough with no audio track is valid media,
-- and requiring audio here would encode a product rule this phase has no
-- authority to make.
-- ---------------------------------------------------------------------------
ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "momv_media_fact_ranges_check"
  CHECK (
    ("durationMs"       IS NULL OR ("durationMs"       > 0 AND "durationMs"       <= 9007199254740991))
    AND ("videoWidth"       IS NULL OR ("videoWidth"       > 0 AND "videoWidth"       <= 9007199254740991))
    AND ("videoHeight"      IS NULL OR ("videoHeight"      > 0 AND "videoHeight"      <= 9007199254740991))
    AND ("videoStreamCount" IS NULL OR ("videoStreamCount" > 0 AND "videoStreamCount" <= 9007199254740991))
    AND ("audioStreamCount" IS NULL OR ("audioStreamCount" >= 0 AND "audioStreamCount" <= 9007199254740991))
  );

-- ---------------------------------------------------------------------------
-- 6. Per-status row shape.
--
-- TypeScript cannot keep a row honest: a direct SQL write, a future repository
-- bug, or a partially-applied update can all produce a row whose status and
-- columns disagree — a VALID row with no facts, a terminal row still holding a
-- lease, a PENDING row carrying a verdict. Each of those would be read later as
-- a durable claim about a customer's video, so the shape is enforced where the
-- data actually lives.
-- ---------------------------------------------------------------------------
ALTER TABLE "managed_output_media_validations"
  ADD CONSTRAINT "momv_status_shape_check"
  CHECK (
    CASE "status"
      -- Eligible, owned by nobody, carrying no verdict.
      WHEN 'PENDING' THEN
        "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
        AND "invalidReason" IS NULL
        AND "container" IS NULL
        AND "durationMs" IS NULL
        AND "videoWidth" IS NULL
        AND "videoHeight" IS NULL
        AND "videoStreamCount" IS NULL
        AND "audioStreamCount" IS NULL
        AND "validatedAt" IS NULL

      -- Owned. A lease with no token, or a token with no expiry, is an owner
      -- nobody can identify or dispossess.
      WHEN 'RUNNING' THEN
        "leaseToken" IS NOT NULL
        AND length("leaseToken") > 0
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

      -- A verdict of VALID is worthless without the facts it is asserting, so
      -- all six are required together.
      WHEN 'VALID' THEN
        "leaseToken" IS NULL
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

      -- Exactly one closed reason, and no facts: the inspector rejected the
      -- file, so there is nothing true to record about its streams.
      WHEN 'INVALID_MEDIA' THEN
        "leaseToken" IS NULL
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

      -- The bytes are not ours. No media reason and no facts, because nothing
      -- was inspected.
      WHEN 'INTEGRITY_MISMATCH' THEN
        "leaseToken" IS NULL
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

      ELSE FALSE
    END
  );
