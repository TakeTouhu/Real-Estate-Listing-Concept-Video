-- DS-3 — the disclosure mode, frozen at admission (ADR-0073).
--
-- ADR-0052 Decision 10: a generation's disclosure mode is chosen once, when it
-- is admitted, and never changed afterwards. One enum and two columns:
--
--   generation_jobs.disclosureMode                  the mode the job was admitted
--                                                   under
--   generation_deliverable_versions.disclosureMode  the mode each version is
--                                                   planned and delivered under,
--                                                   copied from its job
--
-- Only Mode A is built, so the enum has one value: THROUGHOUT, the disclosure
-- for the whole video. Mode B and Mode C add theirs when their rules are built.
--
-- **Existing rows are Mode A.** Nothing has been delivered and no route creates
-- a job, so every existing row is development data, and the approved plan
-- records it as Mode A. (No composition draws the disclosure before DS-5, so a
-- version composed earlier holds a video without it.) The column default exists
-- only for the ADD COLUMN statement and is dropped immediately, so every later
-- writer must name the mode. Existing versions keep their
-- `sha256:deliverable-input:v1` fingerprint, which is never rewritten.

-- CreateEnum
CREATE TYPE "DisclosureMode" AS ENUM ('THROUGHOUT');

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "disclosureMode" "DisclosureMode" NOT NULL DEFAULT 'THROUGHOUT';

ALTER TABLE "generation_jobs" ALTER COLUMN "disclosureMode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "generation_deliverable_versions" ADD COLUMN     "disclosureMode" "DisclosureMode" NOT NULL DEFAULT 'THROUGHOUT';

ALTER TABLE "generation_deliverable_versions" ALTER COLUMN "disclosureMode" DROP DEFAULT;
