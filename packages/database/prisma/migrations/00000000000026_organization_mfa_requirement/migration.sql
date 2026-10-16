-- MFA-4: an organization may require MFA of all its members (ADR-0065
-- Decision 18, implementing ADR-0052 Decision 18).
--
-- `organizations.mfaRequired`: every member must use MFA, whatever their role.
-- Only an OWNER or ADMIN changes it, each change committed with its audit entry.
--
-- Additive only. Every existing organization reads as not requiring it, which
-- changes nothing for anyone. No existing row is updated or deleted, and
-- migrations 0 through 25 are not touched.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "mfaRequired" BOOLEAN NOT NULL DEFAULT false;
