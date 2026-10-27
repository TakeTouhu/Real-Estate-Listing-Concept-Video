import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaStoryboardRepositories } from "@app/database";
import type { StoryboardScene } from "@app/domain";

/**
 * Storyboard persistence against live PostgreSQL.
 *
 * The point of interest is tenant modelling: `storyboard_scenes` carries no
 * organization column, so isolation has to come from the owning project on
 * reads and from the composite foreign keys on writes. Both are proven here
 * against the real database rather than asserted in prose.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_sb_a";
const ORG_B = "org_itest_sb_b";
const PROP_A = "prp_itest_sb_a";
const PROP_B = "prp_itest_sb_b";
const ASSET_A1 = "ast_itest_sb_a1";
const ASSET_A2 = "ast_itest_sb_a2";
const ASSET_B1 = "ast_itest_sb_b1";
const PROJECT_A = "vpr_itest_sb_a";

const prisma = new PrismaClient();
/** A second connection, to hold a lock while the code under test runs. */
const holder = new PrismaClient();
const repos = createPrismaStoryboardRepositories(prisma);

function project(id: string, organizationId: string, propertyId: string) {
  return {
    id,
    organizationId,
    propertyId,
    name: "Walkthrough",
    status: "DRAFT" as const,
    durationSeconds: 30,
    aspectRatio: "16:9",
    targetOutputResolution: "1080p" as const,
    stylePreset: null,
    cameraMotion: null,
    prompt: null,
    negativePrompt: null,
    includeMusic: false,
    includeCaptions: false,
    brandTemplateId: null,
    compositionFingerprint: null,
    createdBy: "usr_itest_sb",
  };
}

function scene(
  id: string,
  position: number,
  assetId: string,
  overrides: Partial<Omit<StoryboardScene, "createdAt" | "updatedAt">> = {},
) {
  return {
    id,
    videoProjectId: PROJECT_A,
    propertyId: PROP_A,
    assetId,
    position,
    roomType: "KITCHEN" as const,
    durationSeconds: 5,
    cameraMotion: "SLOW_PAN",
    compiledPrompt: null,
    sourceAnalysisRevision: 1,
    ...overrides,
  };
}

/** One composition of `scenes`, from inputs whose fingerprint is `fingerprint`. */
function composed(
  scenes: ReturnType<typeof scene>[],
  fingerprint = "sha256:first",
): { scenes: ReturnType<typeof scene>[]; compositionFingerprint: string } {
  return { scenes, compositionFingerprint: fingerprint };
}

async function seedProperty(organizationId: string, propertyId: string, assetIds: string[]) {
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  });
  await prisma.property.create({
    data: {
      id: propertyId,
      organizationId,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_sb",
    },
  });
  for (const assetId of assetIds) {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        organizationId,
        propertyId,
        storageKey: `org/${organizationId}/${assetId}.jpg`,
        originalFilename: "seed.jpg",
        status: "READY",
        createdBy: "usr_itest_sb",
      },
    });
  }
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.videoProject.deleteMany({ where: { organizationId } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedProperty(ORG_A, PROP_A, [ASSET_A1, ASSET_A2]);
  await seedProperty(ORG_B, PROP_B, [ASSET_B1]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
  await holder.$disconnect();
});

/** Resolves once, when `promise` settles; never rejects. */
function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

/** Give a blocked call a real chance to finish, so "still blocked" means it. */
async function breathe(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Run `body` in a transaction on the second connection and keep it open until
 * the returned `release` is called.
 */
function holdOpen(body: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = holder.$transaction(
    async (tx) => {
      await body(tx);
      await held;
    },
    { timeout: 20_000 },
  );
  return { release, done };
}

describe.skipIf(!HAS_DB)("video project persistence", () => {
  it("round-trips a project including its nullable settings and fingerprint", async () => {
    const created = await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
    expect(created.status).toBe("DRAFT");
    expect(created.compositionFingerprint).toBeNull();

    const updated = await repos.projects.update(ORG_A, PROJECT_A, {
      status: "STORYBOARD_READY",
      compositionFingerprint: "sha256:abc",
      prompt: "bright and airy",
      negativePrompt: "no people",
    });
    expect(updated.status).toBe("STORYBOARD_READY");
    expect(updated.compositionFingerprint).toBe("sha256:abc");
    expect(updated.negativePrompt).toBe("no people");
    // The database owns updatedAt; the update contract cannot express it, so a
    // stale in-memory copy can never freeze the column.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("leaves unmentioned fields alone, and identity untouched", async () => {
    const created = await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
    const updated = await repos.projects.update(ORG_A, PROJECT_A, { name: "Renamed" });

    expect(updated.name).toBe("Renamed");
    expect(updated.durationSeconds).toBe(created.durationSeconds);
    expect(updated.aspectRatio).toBe(created.aspectRatio);
    expect(updated.status).toBe("DRAFT");
    // propertyId, organizationId and createdAt are not expressible in the
    // update contract at all — this asserts they also do not drift.
    expect(updated.propertyId).toBe(PROP_A);
    expect(updated.organizationId).toBe(ORG_A);
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("does not return, or update, another organization's project", async () => {
    await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));

    expect(await repos.projects.findById(ORG_B, PROJECT_A)).toBeNull();
    expect(await repos.projects.listByProperty(ORG_B, PROP_A)).toEqual([]);
    await expect(
      repos.projects.update(ORG_B, PROJECT_A, { name: "hijacked" }),
    ).rejects.toThrow();

    const untouched = await repos.projects.findById(ORG_A, PROJECT_A);
    expect(untouched!.name).toBe("Walkthrough");
  });
});

describe.skipIf(!HAS_DB)("storyboard scene persistence", () => {
  beforeEach(async () => {
    await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
  });

  it("replaces a project's scenes wholesale, returns them in position order, and marks the project", async () => {
    const saved = await repos.scenes.saveComposition(
      ORG_A,
      PROJECT_A,
      composed([scene("scn_1", 2, ASSET_A2), scene("scn_2", 1, ASSET_A1)]),
    );
    // What the commit left, as stored: in position order, with the database's
    // timestamps, not the input echoed back.
    expect(saved.scenes.map((s) => s.id)).toEqual(["scn_2", "scn_1"]);
    const first = await repos.scenes.listByProject(ORG_A, PROJECT_A);
    expect(first.map((s) => s.position)).toEqual([1, 2]);
    expect(saved.scenes.map((s) => s.createdAt.getTime())).toEqual(first.map((s) => s.createdAt.getTime()));

    // Recomposition reuses position 1: the old rows must be gone, not merged.
    const replaced = await repos.scenes.saveComposition(
      ORG_A,
      PROJECT_A,
      composed([scene("scn_3", 1, ASSET_A1, { sourceAnalysisRevision: 4 })], "sha256:second"),
    );
    expect(replaced.scenes.map((s) => s.id)).toEqual(["scn_3"]);
    expect(replaced.scenes[0]!.sourceAnalysisRevision).toBe(4);
    expect(replaced.project.status).toBe("STORYBOARD_READY");
    expect(replaced.project.compositionFingerprint).toBe("sha256:second");
  });

  it("rejects two scenes at the same position in one project", async () => {
    await expect(
      repos.scenes.saveComposition(
        ORG_A,
        PROJECT_A,
        composed([scene("scn_1", 1, ASSET_A1), scene("scn_2", 1, ASSET_A2)]),
      ),
    ).rejects.toThrow();
    expect(await repos.scenes.listByProject(ORG_A, PROJECT_A)).toEqual([]);
  });

  it("resolves tenant scope through the project, not a column on the scene", async () => {
    await repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_1", 1, ASSET_A1)]));
    expect(await repos.scenes.listByProject(ORG_B, PROJECT_A)).toEqual([]);
    await expect(
      repos.scenes.saveComposition(ORG_B, PROJECT_A, composed([scene("scn_x", 1, ASSET_A1)], "sha256:x")),
    ).rejects.toThrow();
    expect(await repos.scenes.listByProject(ORG_A, PROJECT_A)).toHaveLength(1);
    expect((await repos.projects.findById(ORG_A, PROJECT_A))!.compositionFingerprint).toBe("sha256:first");
  });

  it("cannot store a scene whose asset belongs to another property, and so another tenant", async () => {
    // The composite foreign key on (assetId, propertyId) makes this a database
    // error, not an application-layer convention that could be forgotten.
    await expect(
      prisma.storyboardScene.create({
        data: scene("scn_cross", 1, ASSET_B1),
      }),
    ).rejects.toThrow();
    expect(await repos.scenes.listByProject(ORG_A, PROJECT_A)).toEqual([]);
  });

  it("deletes scenes when their project is deleted", async () => {
    await repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_1", 1, ASSET_A1)]));
    await prisma.videoProject.delete({ where: { id: PROJECT_A } });
    expect(await prisma.storyboardScene.count({ where: { videoProjectId: PROJECT_A } })).toBe(0);
  });

  it("deletes scenes when their source asset is deleted", async () => {
    await repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_1", 1, ASSET_A1)]));
    await prisma.mediaAsset.delete({ where: { id: ASSET_A1 } });
    expect(await prisma.storyboardScene.count({ where: { videoProjectId: PROJECT_A } })).toBe(0);
  });
});

/**
 * ADR-0086: a composition's scenes, status and fingerprint are one commit, and
 * the project row is the lock that orders compositions and the start step.
 */
describe.skipIf(!HAS_DB)("one composition, one commit", () => {
  beforeEach(async () => {
    await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
    await repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_1", 1, ASSET_A1)]));
  });

  it("leaves the previous composition whole when the next cannot be saved", async () => {
    await expect(
      repos.scenes.saveComposition(
        ORG_A,
        PROJECT_A,
        composed([scene("scn_2", 1, ASSET_A1), scene("scn_3", 1, ASSET_A2)], "sha256:second"),
      ),
    ).rejects.toThrow();

    expect((await repos.scenes.listByProject(ORG_A, PROJECT_A)).map((s) => s.id)).toEqual(["scn_1"]);
    const unchanged = await repos.projects.findById(ORG_A, PROJECT_A);
    expect(unchanged!.status).toBe("STORYBOARD_READY");
    expect(unchanged!.compositionFingerprint).toBe("sha256:first");
  });

  it("waits for a composition already saving, then replaces it whole", async () => {
    // The holder is a composition half-way through: the project locked, its
    // own scene inserted at position 1. Without the lock, the second would
    // insert its own position 1 beside it and fail on the unique index once the
    // first commits.
    const first = holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_A} FOR NO KEY UPDATE`;
      await tx.storyboardScene.deleteMany({ where: { videoProjectId: PROJECT_A } });
      await tx.storyboardScene.create({ data: scene("scn_held", 1, ASSET_A1) });
      await tx.videoProject.update({ where: { id: PROJECT_A }, data: { compositionFingerprint: "sha256:held" } });
    });
    await breathe(4);
    const second = settled(
      repos.scenes.saveComposition(
        ORG_A,
        PROJECT_A,
        composed([scene("scn_4", 1, ASSET_A2), scene("scn_5", 2, ASSET_A1)], "sha256:second"),
      ),
    );
    await breathe();
    expect(second.done()).toBe(false);

    first.release();
    await first.done;
    const saved = await second.value;
    expect(saved.scenes.map((s) => s.id)).toEqual(["scn_4", "scn_5"]);
    expect(saved.project.compositionFingerprint).toBe("sha256:second");
    expect((await repos.scenes.listByProject(ORG_A, PROJECT_A)).map((s) => s.id)).toEqual(["scn_4", "scn_5"]);
  });

  it("lets two compositions of one project both save, one after the other", async () => {
    // A reader holds the project, so both start before either can commit.
    // Sharing the row, or not locking it, both would write their scenes at
    // once: one fails on the position index or deadlocks with the other.
    const reader = holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_A} FOR SHARE`;
    });
    await breathe(4);
    const saves = [
      composed([scene("scn_b1", 1, ASSET_A1), scene("scn_b2", 2, ASSET_A2)], "sha256:b"),
      composed([scene("scn_c1", 1, ASSET_A2), scene("scn_c2", 2, ASSET_A1)], "sha256:c"),
    ].map((composition) => repos.scenes.saveComposition(ORG_A, PROJECT_A, composition));
    await breathe(4);
    reader.release();
    await reader.done;

    const outcomes = await Promise.allSettled(saves);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    // Whichever committed last, the project carries its scenes and its
    // fingerprint together.
    const final = await repos.projects.findById(ORG_A, PROJECT_A);
    const ids = (await repos.scenes.listByProject(ORG_A, PROJECT_A)).map((s) => s.id);
    expect(
      final!.compositionFingerprint === "sha256:b" ? ["scn_b1", "scn_b2"] : ["scn_c1", "scn_c2"],
    ).toEqual(ids);
    expect(["sha256:b", "sha256:c"]).toContain(final!.compositionFingerprint);
  });

  it("waits for a reader holding the project FOR SHARE, as the start step does", async () => {
    const reader = holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_A} FOR SHARE`;
    });
    await breathe(4);
    const saving = settled(
      repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_6", 1, ASSET_A2)], "sha256:second")),
    );
    await breathe();
    expect(saving.done()).toBe(false);
    // Until the reader is done it still sees the composition it locked.
    expect((await repos.scenes.listByProject(ORG_A, PROJECT_A)).map((s) => s.id)).toEqual(["scn_1"]);

    reader.release();
    await reader.done;
    expect((await saving.value).project.compositionFingerprint).toBe("sha256:second");
  });

  it("does not wait for a row that only references the project", async () => {
    // A foreign-key check holds the project FOR KEY SHARE, as a job or an
    // attempt being inserted against it does. The composition's lock must not
    // conflict with it.
    const referencing = holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_A} FOR KEY SHARE`;
    });
    await breathe(4);
    const saving = settled(
      repos.scenes.saveComposition(ORG_A, PROJECT_A, composed([scene("scn_7", 1, ASSET_A2)], "sha256:second")),
    );
    await breathe();
    const finishedWhileHeld = saving.done();
    referencing.release();
    await referencing.done;
    expect(finishedWhileHeld).toBe(true);
    expect((await saving.value).scenes.map((s) => s.id)).toEqual(["scn_7"]);
  });
});
