-- Near-duplicate rule removal (ADR-0063, implementing ADR-0052 Decision 14).
--
-- Drops the hand-written partial unique index from migration 3 that allowed at
-- most one APPROVED analysis per (organizationId, duplicateGroup). Look-alike
-- photos are the customer's responsibility: each photo is approved on its own,
-- and two approved look-alikes may both be used.
--
-- The perceptual hash, the computed "duplicateGroup" and its non-unique index
-- "asset_analyses_organizationId_duplicateGroup_idx" stay, for internal use.
-- No row is updated or deleted, and migrations 0 through 23 are not touched.
--
-- Forward-only: once two look-alikes are both approved, recreating this index
-- would fail.

-- DropIndex
DROP INDEX "asset_analyses_org_dupgroup_approved_key";
