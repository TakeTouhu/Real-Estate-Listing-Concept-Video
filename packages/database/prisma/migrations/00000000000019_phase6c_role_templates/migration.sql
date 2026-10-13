-- Phase 6C: the six role templates of ADR-0052 Decision 10.
--
-- MANAGER, VIEWER and BILLING are added; REVIEWER is removed (ADR-0052
-- Decision 2: there is no final-video approval and no Reviewer role). Existing
-- REVIEWER memberships and invitations become VIEWER, the least-privileged
-- template. Every other value keeps its name; a value this mapping does not know
-- fails the cast and aborts the migration rather than being guessed.
--
-- PostgreSQL cannot drop an enum value, so the type is recreated.

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'CREATOR', 'VIEWER', 'BILLING');
ALTER TABLE "memberships" ALTER COLUMN "role" TYPE "Role_new"
  USING (CASE "role"::text WHEN 'REVIEWER' THEN 'VIEWER' ELSE "role"::text END)::"Role_new";
ALTER TABLE "invitations" ALTER COLUMN "role" TYPE "Role_new"
  USING (CASE "role"::text WHEN 'REVIEWER' THEN 'VIEWER' ELSE "role"::text END)::"Role_new";
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
COMMIT;
