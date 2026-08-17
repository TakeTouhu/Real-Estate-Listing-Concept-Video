-- Phase 4C-0a: freeze the rendered execution prompt (ADR-0023)
--
-- The five Phase 4B-1c snapshot columns fix WHAT WAS ASKED FOR. This one fixes
-- WHAT WILL BE SENT, and they are not the same guarantee.
--
-- `requestCompiledPrompt` is the structure the request hash covers, but the
-- bytes a provider receives are a function of that structure AND the renderer's
-- code -- headings, section order, camera-motion phrasing, the trimming rule.
-- None of that is in the hash. A generation admitted under one renderer and
-- executed after a deploy could therefore have submitted text the customer's
-- approved request never described, under a hash that still validated.
--
-- Rendering once at admission and storing the result closes that gap: the worker
-- submits this string verbatim and never runs the renderer for an admitted
-- attempt, so renderer changes apply to new admissions only.
--
-- Deliberately NULLABLE, and deliberately NOT backfilled. Backfilling would mean
-- rendering old rows with today's renderer -- fabricating, for a request admitted
-- earlier, the very bytes this column exists to pin down. NULL therefore means
-- "predates the freeze contract and cannot be submitted", and consumers fail
-- closed (`frozenExecutionPromptFrom`). No existing `requestHash` is rewritten,
-- no historical row is deleted, and the 8-fact hash tuple is unchanged.
--
-- No index is added: this is execution payload fetched by primary key through
-- the row a queued job names, never a lookup key. Identity lookups continue to
-- use the existing (videoProjectId, requestHash) partial unique index.

ALTER TABLE "scene_generations"
  ADD COLUMN "requestRenderedPrompt" TEXT;
