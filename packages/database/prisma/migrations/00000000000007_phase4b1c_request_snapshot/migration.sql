-- Phase 4B-1c: immutable generation request snapshot (ADR-0018)
--
-- An admitted generation must be able to rebuild the exact provider request it
-- was admitted for. It previously could not: `requestHash` is a one-way digest,
-- `sourceStoryboardSceneId` has no foreign key and is deleted by recomposition,
-- and the project's `aspectRatio`/`resolution` are mutable after admission.
-- These five columns close that gap and, together with `assetId`,
-- `providerName` and `providerModelId`, complete every fact the request hash
-- covers.
--
-- Deliberately NULLABLE, and deliberately NOT backfilled. A row admitted before
-- this migration has no recoverable snapshot: its storyboard scene may be gone,
-- and copying today's scene or project values would fabricate a request that was
-- never admitted — one whose facts would not even reproduce the stored hash.
-- NULL therefore means "predates the contract, cannot be reconstructed", and
-- consumers fail closed. No existing `requestHash` is rewritten and no
-- historical row is deleted.
--
-- No index is added: these columns are reconstruction payload, never a lookup
-- key. Identity lookups continue to use the existing
-- (videoProjectId, requestHash) partial unique index and the (state) index.

ALTER TABLE "scene_generations"
  ADD COLUMN "requestCompiledPrompt"  TEXT,
  ADD COLUMN "requestDurationSeconds" INTEGER,
  ADD COLUMN "requestCameraMotion"    TEXT,
  ADD COLUMN "requestAspectRatio"     TEXT,
  ADD COLUMN "requestResolution"      TEXT;
