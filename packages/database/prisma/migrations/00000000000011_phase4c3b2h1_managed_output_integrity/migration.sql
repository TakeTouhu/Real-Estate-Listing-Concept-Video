-- Phase 4C-3B-2H-1: managed output integrity facts.
--
-- WHY THIS MIGRATION IS REQUIRED
--
-- `outputStorageKey` already existed, but a key alone cannot prove anything. It
-- says where the platform believes a copy lives; it does not say that the copy
-- is complete, that it is the object the provider produced, or when anyone
-- checked. An attempt could reach OUTPUT_VERIFIED with a key pointing at a
-- half-written object and nothing in the row would contradict it.
--
-- Three additive nullable columns make OUTPUT_VERIFIED auditable: what the bytes
-- hash to, how many there are, and when the platform established both. With the
-- key that is a complete, self-contained integrity record — enough to re-verify
-- the object later without trusting any other system.
--
-- LEGACY EXCEPTION, STATED EXACTLY
--
-- Every constraint below keys on `orchestrationState`, which is NULL on every
-- row admitted before Phase 4C-3B-2E. `IS DISTINCT FROM` is null-safe, so those
-- rows satisfy the verified-metadata constraint unconditionally and no exception
-- logic is needed for them.
--
-- Legacy rows using the older `state` enum — including `state = 'SUCCEEDED'` —
-- are deliberately untouched and are NOT reinterpreted as orchestrated
-- `PROVIDER_SUCCEEDED` rows. A legacy success is a historical fact recorded
-- under a different vocabulary; nothing here backfills a digest, a size, a
-- verification timestamp or an orchestration state for it, because every one of
-- those values would be invented.

ALTER TABLE "scene_generations"
  ADD COLUMN "outputSha256"    TEXT,
  ADD COLUMN "outputSizeBytes" BIGINT,
  ADD COLUMN "outputVerifiedAt" TIMESTAMP(3);

-- 1. A verified managed output carries all four integrity facts.
--
-- The one invariant that makes OUTPUT_VERIFIED mean something. Without it the
-- state is a label an application bug could apply to a row describing nothing.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_verified_output_metadata_check"
  CHECK (
    "orchestrationState" IS DISTINCT FROM 'OUTPUT_VERIFIED'
    OR (
      "outputStorageKey"  IS NOT NULL
      AND "outputSha256"    IS NOT NULL
      AND "outputSizeBytes" IS NOT NULL
      AND "outputVerifiedAt" IS NOT NULL
    )
  );

-- 2. A digest is canonical or it is absent.
--
-- Lowercase hex, exactly 64 characters, matching the execution-source digest
-- convention. Two spellings of one digest is how an equality check starts
-- reporting identical bytes as a corrupted output.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_output_sha256_format_check"
  CHECK ("outputSha256" IS NULL OR "outputSha256" ~ '^[0-9a-f]{64}$');

-- 3. A size is positive or it is absent.
--
-- Zero is refused explicitly: a zero-byte object is not a small video, it is a
-- failed copy that happened to create the destination.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_output_size_positive_check"
  CHECK ("outputSizeBytes" IS NULL OR "outputSizeBytes" > 0);
