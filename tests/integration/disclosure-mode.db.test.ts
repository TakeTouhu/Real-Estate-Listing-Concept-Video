import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DISCLOSURE_MODES, computeDeliverableInputFingerprint, type DisclosureMode } from "@app/domain";
import { createDeliverableCompositionPlanRepository } from "@app/database";
import { sha256Hex } from "@app/shared";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  repositories,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import { DIGEST, SIZE, seedPlanChain, type PlanChain } from "./deliverable-composition-fixture";

/**
 * The disclosure mode, frozen at admission (DS-3, ADR-0073), against live
 * PostgreSQL.
 *
 * Admission stores the mode it is given and refuses one that is not built
 * before writing anything. Transaction I copies the job's mode onto the
 * version and binds it into the v2 fingerprint. A plan stored under v1, before
 * migration 29, is never rewritten: replayed, it fails closed.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);
const plans = createDeliverableCompositionPlanRepository(prisma);

/** Not a mode admission accepts: what Mode C's evidence will spell, before it is built. */
const UNBUILT = "NONE" as string as DisclosureMode;

let versionSeq = 0;

async function admitPlan(jobId: string) {
  versionSeq += 1;
  return plans.admitCompositionPlan({
    organizationId: ORG_A,
    generationJobId: jobId,
    deliverableVersionId: `gdv_itest_mode_${versionSeq}`,
    context: ctx(),
  });
}

/** The scenes as the fixture seeded them, in the fingerprint's shape. */
function scenesOf(chain: PlanChain) {
  return chain.scenes.map((scene) => ({
    position: scene.position,
    generationSceneId: scene.sceneId,
    sceneGenerationRequestId: scene.requestId,
    sceneGenerationAttemptId: scene.attemptId,
    mediaValidationId: scene.validationId,
    sourceSha256: DIGEST,
    sourceSizeBytes: BigInt(SIZE),
  }));
}

RUN("the disclosure mode, frozen at admission (DS-3)", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("job admission", () => {
    it("stores the mode it is given and returns it", async () => {
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_mode_a",
          videoProjectId: PROJECT_A,
          requestedByUserId: "usr_itest",
          qualityTier: "NORMAL",
          requestedDurationSeconds: 30,
          disclosureMode: "THROUGHOUT",
        },
        ctx(),
      );
      if (created.kind !== "CREATED") throw new Error(created.kind);
      expect(created.job.disclosureMode).toBe("THROUGHOUT");
      const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: "genjob_mode_a" } });
      expect(row.disclosureMode).toBe("THROUGHOUT");
      expect((await repos.jobs.findById(ORG_A, "genjob_mode_a"))?.disclosureMode).toBe("THROUGHOUT");
    });

    it("refuses a mode that is not built, before writing anything", async () => {
      const jobs = await prisma.generationJob.count();
      const events = await prisma.generationTransitionEvent.count();
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_mode_unbuilt",
          videoProjectId: PROJECT_A,
          requestedByUserId: "usr_itest",
          qualityTier: "NORMAL",
          requestedDurationSeconds: 30,
          disclosureMode: UNBUILT,
        },
        ctx(),
      );
      expect(created).toEqual({ kind: "DISCLOSURE_MODE_NOT_SUPPORTED" });
      expect(await prisma.generationJob.count()).toBe(jobs);
      expect(await prisma.generationTransitionEvent.count()).toBe(events);
    });
  });

  describe("the stored shape", () => {
    it("has exactly the domain's modes", async () => {
      const labels = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'DisclosureMode'
         ORDER BY e.enumsortorder`;
      expect(labels.map(({ label }) => label)).toEqual([...DISCLOSURE_MODES]);
    });

    it("requires the mode on every job and version, with no default to fall back on", async () => {
      const columns = await prisma.$queryRaw<
        { table: string; nullable: string; fallback: string | null; type: string }[]
      >`
        SELECT table_name AS "table", is_nullable AS nullable, column_default AS fallback, udt_name AS type
          FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name = 'disclosureMode'
         ORDER BY table_name`;
      expect(columns).toEqual([
        { table: "generation_deliverable_versions", nullable: "NO", fallback: null, type: "DisclosureMode" },
        { table: "generation_jobs", nullable: "NO", fallback: null, type: "DisclosureMode" },
      ]);
    });

    it("refuses a mode it does not know", async () => {
      const chain = await seedPlanChain(prisma);
      await expect(
        prisma.$executeRaw`UPDATE "generation_jobs" SET "disclosureMode" = 'NONE' WHERE "id" = ${chain.jobId}`,
      ).rejects.toThrow(/invalid input value for enum "DisclosureMode"/);
    });
  });

  describe("composition plan admission (Transaction I)", () => {
    it("copies the job's mode onto the version and binds it into the v2 fingerprint", async () => {
      const chain = await seedPlanChain(prisma);
      const planned = await admitPlan(chain.jobId);
      if (planned.kind !== "PLANNED") throw new Error(planned.kind);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
      const version = await prisma.generationDeliverableVersion.findUniqueOrThrow({
        where: { id: planned.deliverableVersionId },
      });
      expect(version.disclosureMode).toBe(job.disclosureMode);
      expect(version.inputFingerprint).toBe(
        computeDeliverableInputFingerprint(
          {
            targetOutputResolution: job.targetOutputResolution,
            targetAspectRatio: job.targetAspectRatio,
            requestedDurationSeconds: job.requestedDurationSeconds,
            disclosureMode: version.disclosureMode,
          },
          scenesOf(chain),
        ),
      );
      expect(version.inputFingerprint.startsWith("sha256:deliverable-input:v2:")).toBe(true);
    });

    it("fails closed when replaying a plan stored under v1, and leaves it as it was", async () => {
      const chain = await seedPlanChain(prisma);
      const planned = await admitPlan(chain.jobId);
      if (planned.kind !== "PLANNED") throw new Error(planned.kind);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });

      // Exactly what Transaction I stored for these inputs before migration 29:
      // the v1 prefix over a three-element target, with no mode.
      const v1 = `sha256:deliverable-input:v1:${sha256Hex(
        JSON.stringify([
          [job.targetOutputResolution, job.targetAspectRatio, job.requestedDurationSeconds],
          scenesOf(chain).map((scene) => [
            scene.position,
            scene.generationSceneId,
            scene.sceneGenerationRequestId,
            scene.sceneGenerationAttemptId,
            scene.mediaValidationId,
            scene.sourceSha256,
            scene.sourceSizeBytes.toString(),
          ]),
        ]),
      )}`;
      await prisma.generationDeliverableVersion.update({
        where: { id: planned.deliverableVersionId },
        data: { inputFingerprint: v1 },
      });

      await expect(admitPlan(chain.jobId)).rejects.toMatchObject({ code: "PARTIAL_PLAN_STATE" });
      const after = await prisma.generationDeliverableVersion.findUniqueOrThrow({
        where: { id: planned.deliverableVersionId },
      });
      expect(after.inputFingerprint).toBe(v1);
      expect(await prisma.generationDeliverableVersion.count({ where: { generationJobId: chain.jobId } })).toBe(1);
    });
  });
});
