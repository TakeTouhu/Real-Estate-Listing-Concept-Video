import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaStoryboardRepositories } from "@app/database";
import type { StoryboardScene, VideoProject } from "@app/domain";

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
    resolution: "1080p",
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
});

describe.skipIf(!HAS_DB)("video project persistence", () => {
  it("round-trips a project including its nullable settings and fingerprint", async () => {
    const created = await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
    expect(created.status).toBe("DRAFT");
    expect(created.compositionFingerprint).toBeNull();

    const updated = await repos.projects.update({
      ...created,
      status: "STORYBOARD_READY",
      compositionFingerprint: "sha256:abc",
      prompt: "bright and airy",
      negativePrompt: "no people",
    } as VideoProject);
    expect(updated.status).toBe("STORYBOARD_READY");
    expect(updated.compositionFingerprint).toBe("sha256:abc");
    expect(updated.negativePrompt).toBe("no people");
    // The database owns updatedAt; writing back a stale in-memory copy would
    // freeze it.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("never moves a project to another property, even if asked", async () => {
    const created = await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
    const moved = await repos.projects.update({ ...created, propertyId: PROP_B });
    expect(moved.propertyId).toBe(PROP_A);
  });

  it("does not return, or update, another organization's project", async () => {
    await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));

    expect(await repos.projects.findById(ORG_B, PROJECT_A)).toBeNull();
    expect(await repos.projects.listByProperty(ORG_B, PROP_A)).toEqual([]);
    await expect(
      repos.projects.update({
        ...(await repos.projects.findById(ORG_A, PROJECT_A))!,
        organizationId: ORG_B,
        name: "hijacked",
      }),
    ).rejects.toThrow();

    const untouched = await repos.projects.findById(ORG_A, PROJECT_A);
    expect(untouched!.name).toBe("Walkthrough");
  });
});

describe.skipIf(!HAS_DB)("storyboard scene persistence", () => {
  beforeEach(async () => {
    await repos.projects.create(project(PROJECT_A, ORG_A, PROP_A));
  });

  it("replaces a project's scenes wholesale and returns them in position order", async () => {
    await repos.scenes.replaceForProject(ORG_A, PROJECT_A, [
      scene("scn_1", 2, ASSET_A2),
      scene("scn_2", 1, ASSET_A1),
    ]);
    const first = await repos.scenes.listByProject(ORG_A, PROJECT_A);
    expect(first.map((s) => s.position)).toEqual([1, 2]);

    // Recomposition reuses position 1: the old rows must be gone, not merged.
    const replaced = await repos.scenes.replaceForProject(ORG_A, PROJECT_A, [
      scene("scn_3", 1, ASSET_A1, { sourceAnalysisRevision: 4 }),
    ]);
    expect(replaced.map((s) => s.id)).toEqual(["scn_3"]);
    expect(replaced[0]!.sourceAnalysisRevision).toBe(4);
  });

  it("rejects two scenes at the same position in one project", async () => {
    await expect(
      repos.scenes.replaceForProject(ORG_A, PROJECT_A, [
        scene("scn_1", 1, ASSET_A1),
        scene("scn_2", 1, ASSET_A2),
      ]),
    ).rejects.toThrow();
    expect(await repos.scenes.listByProject(ORG_A, PROJECT_A)).toEqual([]);
  });

  it("resolves tenant scope through the project, not a column on the scene", async () => {
    await repos.scenes.replaceForProject(ORG_A, PROJECT_A, [scene("scn_1", 1, ASSET_A1)]);
    expect(await repos.scenes.listByProject(ORG_B, PROJECT_A)).toEqual([]);
    await expect(
      repos.scenes.replaceForProject(ORG_B, PROJECT_A, [scene("scn_x", 1, ASSET_A1)]),
    ).rejects.toThrow();
    expect(await repos.scenes.listByProject(ORG_A, PROJECT_A)).toHaveLength(1);
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
    await repos.scenes.replaceForProject(ORG_A, PROJECT_A, [scene("scn_1", 1, ASSET_A1)]);
    await prisma.videoProject.delete({ where: { id: PROJECT_A } });
    expect(await prisma.storyboardScene.count({ where: { videoProjectId: PROJECT_A } })).toBe(0);
  });

  it("deletes scenes when their source asset is deleted", async () => {
    await repos.scenes.replaceForProject(ORG_A, PROJECT_A, [scene("scn_1", 1, ASSET_A1)]);
    await prisma.mediaAsset.delete({ where: { id: ASSET_A1 } });
    expect(await prisma.storyboardScene.count({ where: { videoProjectId: PROJECT_A } })).toBe(0);
  });
});
