-- Phase 4C-3B-2B: resolution persistence and versioned request identity (ADR-0034)
--
-- One `resolution` string used to mean two different things at once — the
-- product deliverable the customer asked for, and the token the provider is
-- told to generate at. That only held together because the single wired model
-- generated natively at exactly the two strings the product sold. A second
-- model breaks it: MiniMax H3 Max generates at 480P or 768P and nothing else,
-- so a 1080p deliverable is a 768P generation plus an upscale, and one column
-- cannot say so.
--
-- This migration does three things and no more:
--   1. constrains the project's product target to the closed product vocabulary
--      WITHOUT rewriting a single value;
--   2. adds the V2 delivery snapshot to scene_generations;
--   3. makes the two request-identity vocabularies mutually exclusive per row,
--      keyed to the version already recorded in the hash itself.
--
-- No row is updated. No hash is recomputed. No legacy snapshot is backfilled.

-- ---------------------------------------------------------------------------
-- 1. video_projects.resolution — renamed in the Prisma model only.
--
-- The physical column keeps its name; `VideoProject.targetOutputResolution` is
-- mapped onto it. A physical rename would be a larger, riskier migration that
-- buys nothing: the meaning is fixed by the constraint below, not by the name.
--
-- FAIL CLOSED, deliberately. If any existing project holds a value outside the
-- product vocabulary, this migration ABORTS and the deployment stops. It must
-- not "clean up" such a row: a project row is a customer's stated request, and
-- silently rewriting `4k` or `1080` to `1080p` would change what somebody asked
-- for, in a table that already has generations hashed against it. The explicit
-- check below runs first so the failure names the problem and the exact query
-- an operator needs, instead of Postgres's generic constraint-violation text.
DO $$
DECLARE
  offending_count BIGINT;
BEGIN
  SELECT count(*) INTO offending_count
  FROM "video_projects"
  WHERE "resolution" NOT IN ('720p', '1080p');

  IF offending_count > 0 THEN
    RAISE EXCEPTION
      'Cannot apply the output-resolution constraint: % video_projects row(s) hold a value outside (720p, 1080p). These are customer-stated requests and this migration will not rewrite them. Review them first: SELECT id, resolution FROM video_projects WHERE resolution NOT IN (''720p'', ''1080p'');',
      offending_count;
  END IF;
END
$$;

ALTER TABLE "video_projects"
  ADD CONSTRAINT "video_projects_resolution_target_check"
  CHECK ("resolution" IN ('720p', '1080p'));

-- ---------------------------------------------------------------------------
-- 2. The V2 delivery snapshot.
--
-- Nullable and NOT backfilled, for the same reason the Phase 4B-1c snapshot was
-- not: a row admitted under V1 carries one ambiguous string, and deciding which
-- of its two meanings it had would be a guess written into a paid attempt's
-- immutable record. NULL means "predates V2", and consumers fail closed.
--
-- `requestResolution` is kept rather than dropped. V1 rows were hashed over it,
-- so it is the only surviving evidence of what those attempts were admitted for.
ALTER TABLE "scene_generations"
  ADD COLUMN "requestModelKey"                   TEXT,
  ADD COLUMN "requestTargetOutputResolution"     TEXT,
  ADD COLUMN "requestNativeGenerationResolution" TEXT,
  ADD COLUMN "requestResolutionNormalization"    TEXT,
  ADD COLUMN "requestNativeMeetsTarget"          BOOLEAN;

-- Closed vocabularies, checked only when a value is present so legacy rows are
-- unaffected. These are product and delivery semantics, not free text.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_target_output_resolution_check"
  CHECK (
    "requestTargetOutputResolution" IS NULL
    OR "requestTargetOutputResolution" IN ('720p', '1080p')
  );

ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_resolution_normalization_check"
  CHECK (
    "requestResolutionNormalization" IS NULL
    OR "requestResolutionNormalization" IN ('NONE', 'DOWNSCALE', 'UPSCALE')
  );

-- ---------------------------------------------------------------------------
-- 3. One vocabulary per row, decided by the version in the hash.
--
-- `requestHash` already carries its identity version as a prefix — V1 rows are
-- `sha256:<hex>`, V2 rows are `sha256:v2:<hex>`. That makes the version a fact
-- of the row rather than something a reader has to infer from which columns
-- happen to be populated, so the constraint keys off it:
--
--   * a V2 row has all five delivery columns AND no `requestResolution`;
--   * any other row has none of the five.
--
-- This forbids the two states that would be genuinely dangerous: a partially
-- populated V2 snapshot (which would look reconstructable and hash to something
-- else), and a row carrying both vocabularies at once (where nothing says which
-- one the request was actually admitted under). The domain refuses both as well;
-- the constraint is what makes that true of rows the domain did not write.
ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_request_identity_version_check"
  CHECK (
    CASE
      WHEN "requestHash" LIKE 'sha256:v2:%' THEN
        "requestModelKey" IS NOT NULL
        AND "requestTargetOutputResolution" IS NOT NULL
        AND "requestNativeGenerationResolution" IS NOT NULL
        AND "requestResolutionNormalization" IS NOT NULL
        AND "requestNativeMeetsTarget" IS NOT NULL
        AND "requestResolution" IS NULL
      ELSE
        "requestModelKey" IS NULL
        AND "requestTargetOutputResolution" IS NULL
        AND "requestNativeGenerationResolution" IS NULL
        AND "requestResolutionNormalization" IS NULL
        AND "requestNativeMeetsTarget" IS NULL
    END
  );

-- No index is added. Like the Phase 4B-1c snapshot, these columns are
-- reconstruction payload rather than a lookup key: identity lookups still use
-- the (videoProjectId, requestHash) partial unique index and the (state) index.
