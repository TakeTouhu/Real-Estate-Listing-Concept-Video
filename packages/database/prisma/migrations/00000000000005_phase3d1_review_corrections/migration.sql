-- Phase 3D-1: human review corrections on an analysis.
--
-- Purely additive. Four nullable columns, no backfill, no index, no constraint,
-- and no change to any existing column. NULL everywhere means "no human
-- correction", which is exactly the behaviour before this migration, so
-- existing rows need no attention and old application code ignoring these
-- columns keeps working.
--
-- The analyzer's own output (`roomType`, `suggestedOrder`) is deliberately left
-- untouched: a correction is stored beside the AI value, never over it, so the
-- model's answer stays recoverable and `confidence` keeps describing the value
-- it was produced for. See docs/decisions/0015-review-corrections.md.
--
-- No index: corrections are read as part of the analysis row that is already
-- being loaded by primary key or by the unique `assetId`, never searched by.
ALTER TABLE "asset_analyses" ADD COLUMN     "roomTypeOverride" "RoomType",
ADD COLUMN     "orderOverride" INTEGER,
ADD COLUMN     "correctedBy" TEXT,
ADD COLUMN     "correctedAt" TIMESTAMP(3);
