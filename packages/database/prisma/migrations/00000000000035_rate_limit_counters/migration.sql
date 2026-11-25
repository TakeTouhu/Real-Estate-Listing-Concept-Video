-- RD-7b — abuse-limit counters (ADR-0169).
--
--   rate_limit_counters  one row per (policy, subject): the current window's
--                        start and count, and the cooldown's end and level
--
-- A subject is the HMAC-SHA-256 of what is limited (an address, an IP),
-- never the value. Each hit is one INSERT ... ON CONFLICT DO UPDATE in its
-- own statement, a give-back one UPDATE and a forget one DELETE; nothing
-- schedules a clean-up: a row is overwritten when its window has passed, and
-- rows past "expiresAt" are deleted two at a time by later hits.
--
-- New table only. No existing row is read, updated or deleted, and
-- migrations 0 through 34 are not touched.
--
-- The CHECK and the fill factor cannot be expressed in Prisma, so the schema
-- drift check does not see them (ADR-0011, docs/migration-notes.md).

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "policy" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lockLevel" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("policy","subject")
);

-- CreateIndex
CREATE INDEX "rate_limit_counters_expiresAt_idx" ON "rate_limit_counters"("expiresAt");

-- The policy's name is RATE_LIMIT_POLICY_NAME of @app/domain, the subject
-- 64 lowercase hex characters; counts are never negative; a level exists
-- exactly when a cooldown was set.
ALTER TABLE "rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_shape_check"
  CHECK (
        "policy" ~ '^(?=.{3,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$'
    AND "subject" ~ '^[0-9a-f]{64}$'
    AND "count" >= 0
    AND "lockLevel" >= 0
    AND ("lockLevel" = 0) = ("lockedUntil" IS NULL)
    AND "expiresAt" >= "windowStartedAt"
  );

-- Most hits change only "count", which no index covers: room on the page
-- lets PostgreSQL update the row in place without new index entries.
ALTER TABLE "rate_limit_counters" SET (fillfactor = 80);
