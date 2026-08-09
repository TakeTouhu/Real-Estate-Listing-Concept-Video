import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaStoryboardRepositories } from "@app/database";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  TERMINAL_SCENE_GENERATION_STATES,
  type SceneGenerationState,
} from "@app/domain";

/**
 * Scene-generation persistence against live PostgreSQL.
 *
 * Phase 4A-2a adds the table and its invariants; the repository port and the
 * neutral conflict translation are Phase 4A-2b. So these tests drive Prisma
 * directly on purpose — the subject is what the *database* guarantees, not what
 * an adapter reports.
 *
 * The invariants are financial rather than merely structural. A generation row
 * can record a paid external call, so the things proven here are: it survives
 * the operations that routinely destroy what it points at, it cannot be
 * duplicated while an attempt is still live, and it cannot be swept away by a
 * cascade nobody thought about.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_gen_a";
const ORG_B = "org_itest_gen_b";
const PROP_A = "prp_itest_gen_a";
const PROP_B = "prp_itest_gen_b";
const ASSET_A = "ast_itest_gen_a";
const ASSET_B = "ast_itest_gen_b";
const PROJECT_A = "vpr_itest_gen_a";
const PROJECT_A2 = "vpr_itest_gen_a2";
const PROJECT_B = "vpr_itest_gen_b";
const HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_HASH = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const prisma = new PrismaClient();
const storyboards = createPrismaStoryboardRepositories(prisma);

interface GenerationOverrides {
  readonly videoProjectId?: string;
  readonly requestHash?: string;
  readonly state?: SceneGenerationState;
  readonly sourceStoryboardSceneId?: string;
  readonly assetId?: string;
}

function generation(id: string, overrides: GenerationOverrides = {}) {
  return {
    id,
    videoProjectId: overrides.videoProjectId ?? PROJECT_A,
    sourceStoryboardSceneId: overrides.sourceStoryboardSceneId ?? "scn_itest_gen_1",
    assetId: overrides.assetId ?? ASSET_A,
    sourceAnalysisRevision: 1,
    requestHash: overrides.requestHash ?? HASH,
    providerName: "fake",
    providerModelId: "fake/image-to-video",
    state: overrides.state ?? ("QUEUED" as const),
  };
}

function seedProject(id: string, organizationId: string, propertyId: string) {
  return prisma.videoProject.create({
    data: {
      id,
      organizationId,
      propertyId,
      name: "Walkthrough",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      createdBy: "usr_itest_gen",
    },
  });
}

async function seedTenant(organizationId: string, propertyId: string, assetId: string) {
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  });
  await prisma.property.create({
    data: {
      id: propertyId,
      organizationId,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_gen",
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      organizationId,
      propertyId,
      storageKey: `org/${organizationId}/${assetId}.jpg`,
      originalFilename: "seed.jpg",
      status: "READY",
      createdBy: "usr_itest_gen",
    },
  });
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.videoProject.deleteMany({ where: { organizationId } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

/** The Prisma error shape, narrowed without `any`. */
function errorOf(error: unknown): { code?: string; meta?: Record<string, unknown>; name: string } {
  const e = error as { code?: string; meta?: Record<string, unknown>; constructor: { name: string } };
  return { code: e.code, meta: e.meta, name: e.constructor.name };
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, ASSET_A);
  await seedTenant(ORG_B, PROP_B, ASSET_B);
  await seedProject(PROJECT_A, ORG_A, PROP_A);
  await seedProject(PROJECT_A2, ORG_A, PROP_A);
  await seedProject(PROJECT_B, ORG_B, PROP_B);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("scene generation persistence", () => {
  it("round-trips every persisted field", async () => {
    const submittedAt = new Date("2026-08-09T10:00:00.000Z");
    const lastPolledAt = new Date("2026-08-09T10:00:30.000Z");
    await prisma.sceneGeneration.create({
      data: {
        ...generation("gen_full"),
        state: "SUCCEEDED",
        providerPredictionId: "pred_internal_abc",
        submittedAt,
        lastPolledAt,
        normalizedErrorCode: "PROVIDER",
        normalizedErrorMessage: "the provider reported a transient failure",
        outputStorageKey: "org/org_itest_gen_a/generations/gen_full.mp4",
      },
    });

    const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: "gen_full" } });
    expect(row.videoProjectId).toBe(PROJECT_A);
    expect(row.sourceStoryboardSceneId).toBe("scn_itest_gen_1");
    expect(row.assetId).toBe(ASSET_A);
    expect(row.sourceAnalysisRevision).toBe(1);
    expect(row.requestHash).toBe(HASH);
    expect(row.providerName).toBe("fake");
    expect(row.providerModelId).toBe("fake/image-to-video");
    expect(row.state).toBe("SUCCEEDED");
    expect(row.providerPredictionId).toBe("pred_internal_abc");
    expect(row.submittedAt).toEqual(submittedAt);
    expect(row.lastPolledAt).toEqual(lastPolledAt);
    expect(row.normalizedErrorCode).toBe("PROVIDER");
    expect(row.normalizedErrorMessage).toBe("the provider reported a transient failure");
    expect(row.outputStorageKey).toBe("org/org_itest_gen_a/generations/gen_full.mp4");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("round-trips the internal execution fields as null, and defaults to QUEUED", async () => {
    // A freshly created attempt has sent nothing: no prediction, no timestamps,
    // no diagnostics, no output. Every one of those has to be genuinely absent
    // rather than an empty string standing in for "not yet".
    await prisma.sceneGeneration.create({ data: generation("gen_null") });

    const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: "gen_null" } });
    expect(row.state).toBe("QUEUED");
    expect(row.providerPredictionId).toBeNull();
    expect(row.submittedAt).toBeNull();
    expect(row.lastPolledAt).toBeNull();
    expect(row.normalizedErrorCode).toBeNull();
    expect(row.normalizedErrorMessage).toBeNull();
    expect(row.outputStorageKey).toBeNull();
  });

  it("persists no temporary provider output URL column at all", async () => {
    // Phase 4D copies a completed output into managed storage; a URL that
    // expires must never be what the system relies on later.
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'scene_generations'`,
    );
    const names = columns.map((c) => c.column_name.toLowerCase());
    expect(names.some((n) => n.includes("url"))).toBe(false);
    expect(names).toContain("outputstoragekey");
  });
});

describe.skipIf(!HAS_DB)("ownership and tenancy", () => {
  it("resolves the tenant through the owning project, with no organization column", async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'scene_generations'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain("organizationId");
  });

  it("finds a generation when scoped to the owning organization", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_scoped") });

    const found = await prisma.sceneGeneration.findFirst({
      where: { id: "gen_scoped", videoProject: { organizationId: ORG_A } },
    });
    expect(found?.id).toBe("gen_scoped");
    expect(found?.videoProjectId).toBe(PROJECT_A);
  });

  it("makes another organization's generation indistinguishable from missing", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_scoped") });

    const foreign = await prisma.sceneGeneration.findFirst({
      where: { id: "gen_scoped", videoProject: { organizationId: ORG_B } },
    });
    const absent = await prisma.sceneGeneration.findFirst({
      where: { id: "gen_does_not_exist", videoProject: { organizationId: ORG_B } },
    });
    // Same answer for "not yours" and "not there": nothing in the result can
    // reveal that the row exists under another tenant.
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
  });

  it("enforces the video-project foreign key", async () => {
    const error = await prisma.sceneGeneration
      .create({ data: generation("gen_orphan", { videoProjectId: "vpr_nonexistent" }) })
      .then(() => null, errorOf);
    expect(error?.code).toBe("P2003");
  });

  it("refuses to delete a project while a generation attempt exists", async () => {
    // RESTRICT, not CASCADE. This is the fail-closed guarantee: a future
    // physical deletion path has to resolve retention policy deliberately
    // rather than silently erasing a paid attempt's record.
    await prisma.sceneGeneration.create({ data: generation("gen_restrict") });

    const error = await prisma.videoProject
      .delete({ where: { id: PROJECT_A } })
      .then(() => null, errorOf);
    expect(error?.code).toBe("P2003");
    expect(await prisma.sceneGeneration.count({ where: { id: "gen_restrict" } })).toBe(1);
    expect(await prisma.videoProject.count({ where: { id: PROJECT_A } })).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("provenance columns carry no foreign key", () => {
  it("accepts a storyboard scene id that does not exist", async () => {
    await prisma.sceneGeneration.create({
      data: generation("gen_prov_scene", { sourceStoryboardSceneId: "scn_never_existed" }),
    });
    const row = await prisma.sceneGeneration.findUniqueOrThrow({
      where: { id: "gen_prov_scene" },
    });
    expect(row.sourceStoryboardSceneId).toBe("scn_never_existed");
  });

  it("accepts an asset id that does not exist", async () => {
    await prisma.sceneGeneration.create({
      data: generation("gen_prov_asset", { assetId: "ast_never_existed" }),
    });
    const row = await prisma.sceneGeneration.findUniqueOrThrow({
      where: { id: "gen_prov_asset" },
    });
    expect(row.assetId).toBe("ast_never_existed");
  });

  it("declares a foreign key only for the video project", async () => {
    const constraints = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'scene_generations'
          AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(constraints.map((c) => c.column_name)).toEqual(["videoProjectId"]);
  });
});

describe.skipIf(!HAS_DB)("survival of storyboard recomposition", () => {
  it("outlives the real replaceForProject path with its provenance intact", async () => {
    // The headline acceptance test. Recomposition is routine, it deletes every
    // scene row and re-inserts with fresh ids, and an attempt that may have
    // been billed must not go with them.
    const [original] = await storyboards.scenes.replaceForProject(ORG_A, PROJECT_A, [
      {
        id: "scn_original",
        videoProjectId: PROJECT_A,
        propertyId: PROP_A,
        assetId: ASSET_A,
        position: 1,
        roomType: "KITCHEN",
        durationSeconds: 5,
        cameraMotion: null,
        compiledPrompt: null,
        sourceAnalysisRevision: 1,
      },
    ]);
    expect(original?.id).toBe("scn_original");

    await prisma.sceneGeneration.create({
      data: generation("gen_survivor", {
        sourceStoryboardSceneId: "scn_original",
        state: "PROCESSING",
      }),
    });

    // Recompose exactly as StoryboardService does: whole-sequence replacement.
    await storyboards.scenes.replaceForProject(ORG_A, PROJECT_A, [
      {
        id: "scn_recomposed",
        videoProjectId: PROJECT_A,
        propertyId: PROP_A,
        assetId: ASSET_A,
        position: 1,
        roomType: "LIVING_ROOM",
        durationSeconds: 6,
        cameraMotion: null,
        compiledPrompt: null,
        sourceAnalysisRevision: 2,
      },
    ]);

    // The scene it referenced is genuinely gone.
    expect(await prisma.storyboardScene.count({ where: { id: "scn_original" } })).toBe(0);
    expect(await prisma.storyboardScene.count({ where: { id: "scn_recomposed" } })).toBe(1);

    // The attempt, its provenance, and its ownership are untouched.
    const survivor = await prisma.sceneGeneration.findUniqueOrThrow({
      where: { id: "gen_survivor" },
      include: { videoProject: true },
    });
    expect(survivor.sourceStoryboardSceneId).toBe("scn_original");
    expect(survivor.state).toBe("PROCESSING");
    expect(survivor.videoProjectId).toBe(PROJECT_A);
    expect(survivor.videoProject.organizationId).toBe(ORG_A);
  });
});

describe.skipIf(!HAS_DB)("the active-request identity", () => {
  it.each(ACTIVE_SCENE_GENERATION_STATES)("is held while an attempt is %s", async (state) => {
    await prisma.sceneGeneration.create({ data: generation("gen_holder", { state }) });

    const error = await prisma.sceneGeneration
      .create({ data: generation("gen_duplicate") })
      .then(() => null, errorOf);

    expect(error?.code).toBe("P2002");
    expect(await prisma.sceneGeneration.count({ where: { requestHash: HASH } })).toBe(1);
  });

  it.each(TERMINAL_SCENE_GENERATION_STATES)("is released once an attempt is %s", async (state) => {
    // A finished attempt must not block a deliberate regeneration.
    await prisma.sceneGeneration.create({ data: generation("gen_finished", { state }) });
    await prisma.sceneGeneration.create({ data: generation("gen_next") });

    const rows = await prisma.sceneGeneration.findMany({ where: { requestHash: HASH } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "QUEUED")).toHaveLength(1);
  });

  it("is released when an active attempt moves to a terminal state", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_active") });
    await prisma.sceneGeneration.update({
      where: { id: "gen_active" },
      data: { state: "FAILED_TERMINAL" },
    });

    await prisma.sceneGeneration.create({ data: generation("gen_retry") });
    expect(await prisma.sceneGeneration.count({ where: { requestHash: HASH } })).toBe(2);
  });

  it("is scoped per project — the same hash under another project does not collide", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_p1") });
    await prisma.sceneGeneration.create({
      data: generation("gen_p2", { videoProjectId: PROJECT_A2 }),
    });
    expect(await prisma.sceneGeneration.count({ where: { requestHash: HASH } })).toBe(2);
  });

  it("does not collide across different hashes in one project", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_h1") });
    await prisma.sceneGeneration.create({
      data: generation("gen_h2", { requestHash: OTHER_HASH }),
    });
    expect(await prisma.sceneGeneration.count({ where: { videoProjectId: PROJECT_A } })).toBe(2);
  });

  it("does not collide across tenants", async () => {
    await prisma.sceneGeneration.create({ data: generation("gen_t1") });
    await prisma.sceneGeneration.create({
      data: generation("gen_t2", { videoProjectId: PROJECT_B, assetId: ASSET_B }),
    });
    expect(await prisma.sceneGeneration.count({ where: { requestHash: HASH } })).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("concurrency", () => {
  it("lets exactly one of two racing inserts win the identity", async () => {
    // The invariant exists for concurrent workers, so it is tested
    // concurrently. Both promises are started before either is awaited — a
    // serial duplicate would prove nothing about a real race.
    const results = await Promise.allSettled([
      prisma.sceneGeneration.create({ data: generation("gen_race_1") }),
      prisma.sceneGeneration.create({ data: generation("gen_race_2") }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser fails on the uniqueness invariant, not on something incidental.
    const error = errorOf((rejected[0] as PromiseRejectedResult).reason);
    expect(error.code).toBe("P2002");

    // And the database holds exactly one active row for that identity.
    const active = await prisma.sceneGeneration.findMany({
      where: { videoProjectId: PROJECT_A, requestHash: HASH },
    });
    expect(active).toHaveLength(1);
    expect(ACTIVE_SCENE_GENERATION_STATES).toContain(active[0]!.state);
  });
});

describe.skipIf(!HAS_DB)("the collision error shape, captured for Phase 4A-2b", () => {
  it("reports P2002 identifying the covered fields, not the index name", async () => {
    // Recorded here rather than translated: the adapter's neutral error is
    // Phase 4A-2b. `analysis-repositories.ts` carries the lesson that matching
    // on an index name silently never fires, because Prisma reports the fields
    // a constraint covers. This pins the real shape so 4A-2b matches reality
    // instead of memory.
    await prisma.sceneGeneration.create({ data: generation("gen_shape_1") });
    const error = await prisma.sceneGeneration
      .create({ data: generation("gen_shape_2") })
      .then(() => null, errorOf);

    expect(error?.name).toBe("PrismaClientKnownRequestError");
    expect(error?.code).toBe("P2002");
    expect(error?.meta).toMatchObject({
      modelName: "SceneGeneration",
      target: ["videoProjectId", "requestHash"],
    });
    // The hand-written index name is NOT what Prisma surfaces.
    expect(JSON.stringify(error?.meta)).not.toContain("scene_generations_active_request_key");
  });
});
