import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaSceneGenerationExecutionRepository,
  createPrismaSceneGenerationRepository,
} from "@app/database";
import { SCENE_GENERATION_STATES, type SceneGenerationState } from "@app/domain";

/**
 * The system-scoped execution boundary against live PostgreSQL.
 *
 * This is where the claim's exclusivity is actually proven. The in-memory
 * double checks the *contract* — what discovery returns, what a claim does —
 * but it is single-threaded, so it can only demonstrate that a second
 * sequential call is refused. Whether two concurrent callers can both win is a
 * question about the database, and it is the question that decides whether a
 * provider gets paid twice, so it is asked here of the real thing.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_ex_a";
const ORG_B = "org_itest_ex_b";
const PROP_A = "prp_itest_ex_a";
const PROP_B = "prp_itest_ex_b";
const PROJECT_A = "vpr_itest_ex_a";
const PROJECT_B = "vpr_itest_ex_b";

const prisma = new PrismaClient();
const execution = createPrismaSceneGenerationExecutionRepository(prisma);
const tenantFacing = createPrismaSceneGenerationRepository(prisma);

/** Insert a row directly: admission is not this suite's subject. */
function seedGeneration(
  id: string,
  state: SceneGenerationState,
  videoProjectId: string,
  createdAt?: Date,
) {
  return prisma.sceneGeneration.create({
    data: {
      id,
      videoProjectId,
      sourceStoryboardSceneId: "scn_itest_ex",
      assetId: "ast_itest_ex",
      sourceAnalysisRevision: 1,
      requestHash: `sha256:${id}`,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
      requestDurationSeconds: 5,
      requestCameraMotion: "SLOW_PAN_LEFT",
      requestAspectRatio: "16:9",
      requestResolution: "1080p",
      requestRenderedPrompt: `frozen:${id}`,
      state,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

async function seedTenant(organizationId: string, propertyId: string, projectId: string) {
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  });
  await prisma.property.create({
    data: {
      id: propertyId,
      organizationId,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_ex",
    },
  });
  await prisma.videoProject.create({
    data: {
      id: projectId,
      organizationId,
      propertyId,
      name: "Walkthrough",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      createdBy: "usr_itest_ex",
    },
  });
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.videoProject.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, PROJECT_A);
  await seedTenant(ORG_B, PROP_B, PROJECT_B);
});

afterAll(async () => {
  if (HAS_DB) await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("findNextQueuedForPreparation against PostgreSQL", () => {
  it("resolves organizationId through the VideoProject join", async () => {
    await seedGeneration("gen_ex_b", "QUEUED", PROJECT_B);

    const candidate = await execution.findNextQueuedForPreparation();

    expect(candidate!.generation.id).toBe("gen_ex_b");
    // The row itself has no organizationId column; this value came from the
    // parent project, which is the only authority for it.
    expect(candidate!.organizationId).toBe(ORG_B);
  });

  it("agrees with the tenant-facing repository about who owns the row", async () => {
    // The two ports must never disagree: one resolves the tenant, the other is
    // addressed by it. If they diverged, execution would act on a row the
    // customer-facing side would refuse to show that same customer.
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const { organizationId, generation } = (await execution.findNextQueuedForPreparation())!;
    const asTenantSees = await tenantFacing.findById(organizationId, generation.id);

    expect(asTenantSees).not.toBeNull();
    expect(asTenantSees!.id).toBe(generation.id);
    // And the other tenant genuinely cannot see it.
    expect(await tenantFacing.findById(ORG_B, generation.id)).toBeNull();
  });

  it("scans across tenants, oldest first", async () => {
    await seedGeneration("gen_ex_new", "QUEUED", PROJECT_A, new Date("2026-08-18T03:00:00.000Z"));
    await seedGeneration("gen_ex_old", "QUEUED", PROJECT_B, new Date("2026-08-18T01:00:00.000Z"));

    const candidate = await execution.findNextQueuedForPreparation();

    expect(candidate!.generation.id).toBe("gen_ex_old");
    expect(candidate!.organizationId).toBe(ORG_B);
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "never offers a %s row",
    async (state: SceneGenerationState) => {
      await seedGeneration("gen_ex_other", state, PROJECT_A);
      expect(await execution.findNextQueuedForPreparation()).toBeNull();
    },
  );

  it("writes nothing", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);
    const before = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });

    await execution.findNextQueuedForPreparation();

    const after = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });
    // `updatedAt` included: a stray write would move it even if state did not.
    expect(after).toEqual(before);
  });

  it("carries the frozen prompt and the immutable snapshot through the join", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const { generation } = (await execution.findNextQueuedForPreparation())!;

    expect(generation.requestRenderedPrompt).toBe("frozen:gen_ex_a");
    expect(generation.requestCompiledPrompt).not.toBeNull();
    expect(generation.requestHash).toBe("sha256:gen_ex_a");
  });
});

describe.skipIf(!HAS_DB)("claimQueuedForSubmission against PostgreSQL", () => {
  it("moves QUEUED to SUBMITTING and returns the post-claim row", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const claimed = await execution.claimQueuedForSubmission("gen_ex_a");

    expect(claimed!.generation.state).toBe("SUBMITTING");
    expect(claimed!.organizationId).toBe(ORG_A);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner when two callers race for the same row", async () => {
    // The assertion this whole suite exists for. Two concurrent claims, one
    // licence to spend money.
    await seedGeneration("gen_ex_race", "QUEUED", PROJECT_A);

    const results = await Promise.all([
      execution.claimQueuedForSubmission("gen_ex_race"),
      execution.claimQueuedForSubmission("gen_ex_race"),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_race" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner under wider contention", async () => {
    // Two is the minimum interesting case; eight makes an accidental pass far
    // less likely if the predicate were ever dropped from the update.
    await seedGeneration("gen_ex_race8", "QUEUED", PROJECT_A);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => execution.claimQueuedForSubmission("gen_ex_race8")),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "refuses a %s row and leaves it untouched",
    async (state: SceneGenerationState) => {
      await seedGeneration("gen_ex_state", state, PROJECT_A);

      expect(await execution.claimQueuedForSubmission("gen_ex_state")).toBeNull();

      const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_state" } });
      expect(persisted!.state).toBe(state);
    },
  );

  it("returns null for an id that does not exist", async () => {
    expect(await execution.claimQueuedForSubmission("gen_ex_missing")).toBeNull();
  });

  it("mutates state and updatedAt, and nothing else", async () => {
    // A claim that rewrote a snapshot field would change what a later milestone
    // submits, under a requestHash that still validated.
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);
    const before = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;

    await execution.claimQueuedForSubmission("gen_ex_a");

    const after = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.state).toBe("SUBMITTING");
  });

  it("claims a row belonging to whichever tenant owns it", async () => {
    await seedGeneration("gen_ex_b", "QUEUED", PROJECT_B);

    const claimed = await execution.claimQueuedForSubmission("gen_ex_b");

    expect(claimed!.organizationId).toBe(ORG_B);
    // And nothing leaked into the other tenant's view.
    expect(await tenantFacing.findById(ORG_A, "gen_ex_b")).toBeNull();
  });

  it("never hands back a row that a concurrent legal write moved elsewhere", async () => {
    // The TOCTOU window review found, exercised against the real database.
    //
    // `QUEUED → CANCELLED` is a legal transition and the tenant-facing `update`
    // carries no state predicate — it persists what it is asked to persist — so
    // a cancellation that observed `QUEUED` races the claim's re-read. If the
    // update and the read were not one transaction, the claim could win the CAS
    // and still return a row in `CANCELLED`, typed as a licence to submit.
    //
    // The guarantee asserted here is the one `ClaimedSceneGeneration` makes: a
    // non-null claim is in `SUBMITTING`. Never a row in some other state.
    await seedGeneration("gen_ex_toctou", "QUEUED", PROJECT_A);

    const [claimed] = await Promise.all([
      execution.claimQueuedForSubmission("gen_ex_toctou"),
      tenantFacing.update(ORG_A, "gen_ex_toctou", { state: "CANCELLED" }),
    ]);

    if (claimed !== null) expect(claimed.generation.state).toBe("SUBMITTING");
    // Whoever ran second wins the row's final state; either outcome is
    // consistent, and neither is a claim granted over cancelled work.
    const persisted = await prisma.sceneGeneration.findUnique({
      where: { id: "gen_ex_toctou" },
    });
    expect(["SUBMITTING", "CANCELLED"]).toContain(persisted!.state);
  });

  it("leaves other rows alone while claiming one", async () => {
    await seedGeneration("gen_ex_1", "QUEUED", PROJECT_A, new Date("2026-08-18T01:00:00.000Z"));
    await seedGeneration("gen_ex_2", "QUEUED", PROJECT_A, new Date("2026-08-18T02:00:00.000Z"));

    await execution.claimQueuedForSubmission("gen_ex_1");

    const other = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_2" } });
    expect(other!.state).toBe("QUEUED");
    // The next scan offers the remaining one, so a claim advances the queue.
    expect((await execution.findNextQueuedForPreparation())!.generation.id).toBe("gen_ex_2");
  });
});
