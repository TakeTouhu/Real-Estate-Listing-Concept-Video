import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AnalysisService,
  PropertyService,
  StoryboardService,
  createOfflinePromptModerator,
  type ImageAnalysisProvider,
} from "@app/domain";
import {
  createPrismaAnalysisRepository,
  createPrismaIdentityRepositories,
  createPrismaPropertyRepositories,
  createPrismaReviewTransaction,
  createPrismaStoryboardRepositories,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";
import { LocalObjectStorage } from "@app/storage";

/**
 * Reach on the content under a Property against PostgreSQL (Phase 6I-2,
 * ADR-0064): analyses, their review, video projects and storyboards through
 * the real repositories, for a `CREATOR` and a `MANAGER`, a deleted Property,
 * and a reassignment taking effect on the next request.
 */

const ORG = "org_itest_creach";
const OWNER = "usr_itest_creach_owner";
const MANAGER = "usr_itest_creach_manager";
const CREATOR = "usr_itest_creach_creator";
const USERS = [OWNER, MANAGER, CREATOR];
const EAST = "grp_itest_creach_east";
const P = {
  mine: "prp_itest_creach_mine",
  east: "prp_itest_creach_east",
  unassigned: "prp_itest_creach_unassigned",
  deleted: "prp_itest_creach_deleted",
} as const;
const photo = (propertyId: string) => `ast_${propertyId}`;
const PROJECT_INPUT = { name: "Tour", durationSeconds: 30, aspectRatio: "16:9", targetOutputResolution: "1080p" } as const;

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const prisma = new PrismaClient();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(),
  ids: { generate: (p: string) => `${p}_itest_creach_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const repos = createPrismaPropertyRepositories(prisma);
const analyses = createPrismaAnalysisRepository(prisma);
const properties = new PropertyService({ identity: deps, ...repos, clock: deps.clock, ids: deps.ids });
const provider: ImageAnalysisProvider = {
  name: "unused",
  analyze: () => Promise.reject(new Error("not used")),
  normalizeError: () => ({ kind: "PROVIDER", retryable: true, code: "e", messageSanitized: "failed" }),
};
const analysis = new AnalysisService({
  identity: deps,
  properties: repos.properties,
  assets: repos.assets,
  analyses,
  storage: new LocalObjectStorage({ secret: "itest-secret-0000000000000000" }),
  provider,
  reviewTx: createPrismaReviewTransaction(prisma),
  clock: deps.clock,
  ids: deps.ids,
});
const storyboard = new StoryboardService({
  identity: deps,
  properties: repos.properties,
  assets: repos.assets,
  analyses,
  storyboards: createPrismaStoryboardRepositories(prisma),
  moderator: createOfflinePromptModerator(),
  ids: deps.ids,
});

async function cleanup(): Promise<void> {
  await prisma.videoProject.deleteMany({ where: { organizationId: ORG } });
  await prisma.assetAnalysis.deleteMany({ where: { organizationId: ORG } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  // Properties before memberships and groups: their foreign keys refuse the cascade.
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

/** A video project of each live Property, keyed by Property. */
let projects: Record<"mine" | "east" | "unassigned", string>;

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  for (const id of USERS) await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: `slug-${ORG}` } });
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "OWNER" },
      { organizationId: ORG, userId: MANAGER, role: "MANAGER" },
      { organizationId: ORG, userId: CREATOR, role: "CREATOR" },
    ],
  });
  await prisma.group.create({ data: { id: EAST, organizationId: ORG, name: "East", createdByUserId: OWNER } });
  await prisma.groupMember.create({ data: { groupId: EAST, organizationId: ORG, userId: MANAGER, addedByUserId: OWNER } });
  const row = (id: string, extra: object = {}) => ({ id, organizationId: ORG, name: id, propertyType: "APARTMENT" as const, createdBy: OWNER, ...extra });
  await prisma.property.createMany({
    data: [
      row(P.mine, { responsibleUserId: CREATOR }),
      row(P.east, { groupId: EAST }),
      row(P.unassigned),
      row(P.deleted, { responsibleUserId: CREATOR, groupId: EAST, status: "DELETED" as const }),
    ],
  });
  for (const propertyId of [P.mine, P.east, P.unassigned]) {
    await prisma.mediaAsset.create({
      data: {
        id: photo(propertyId),
        organizationId: ORG,
        propertyId,
        storageKey: `org/${ORG}/p/${propertyId}.jpg`,
        originalFilename: "seed.jpg",
        mimeType: "image/jpeg",
        width: 1600,
        height: 1200,
        status: "READY",
        createdBy: OWNER,
      },
    });
    await prisma.assetAnalysis.create({
      data: {
        id: `ana_${propertyId}`,
        organizationId: ORG,
        assetId: photo(propertyId),
        provider: "fixed",
        status: "SUCCEEDED",
        roomType: "KITCHEN",
        confidence: 0.9,
        detectedObjects: [],
        safetyFlags: [],
        analysisRevision: 1,
        reviewStatus: "UNREVIEWED",
      },
    });
  }
  projects = {
    mine: (await storyboard.createProject(OWNER, ORG, P.mine, PROJECT_INPUT)).id,
    east: (await storyboard.createProject(OWNER, ORG, P.east, PROJECT_INPUT)).id,
    unassigned: (await storyboard.createProject(OWNER, ORG, P.unassigned, PROJECT_INPUT)).id,
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

const notFound = (message: string) => ({ code: "NOT_FOUND", message });

describe.skipIf(!HAS_DB)("reach on analyses, video projects and storyboards in PostgreSQL", () => {
  it("lets a CREATOR read and review only under the Property it is responsible for", async () => {
    expect((await analysis.listForProperty(CREATOR, ORG, P.mine)).map((a) => a.assetId)).toEqual([photo(P.mine)]);
    expect((await storyboard.listProjects(CREATOR, ORG, P.mine)).map((p) => p.id)).toEqual([projects.mine]);
    expect((await storyboard.getStoryboard(CREATOR, ORG, projects.mine)).project.id).toBe(projects.mine);

    for (const key of ["east", "unassigned"] as const) {
      expect(await analysis.listForProperty(CREATOR, ORG, P[key])).toEqual([]);
      await expect(analysis.getForAsset(CREATOR, ORG, photo(P[key]))).rejects.toMatchObject(notFound("Analysis not found for this asset"));
      await expect(analysis.approve(CREATOR, ORG, photo(P[key]))).rejects.toMatchObject(notFound("Analysis not found for this asset"));
      await expect(storyboard.listProjects(CREATOR, ORG, P[key])).rejects.toMatchObject(notFound("Property not found"));
      await expect(storyboard.getStoryboard(CREATOR, ORG, projects[key])).rejects.toMatchObject(notFound("Video project not found"));
    }
    const untouched = await prisma.assetAnalysis.findMany({ where: { organizationId: ORG, reviewStatus: { not: "UNREVIEWED" } } });
    expect(untouched).toEqual([]);
  });

  it("lets a MANAGER reach its group's Property and nothing else", async () => {
    expect((await analysis.listForProperty(MANAGER, ORG, P.east)).map((a) => a.assetId)).toEqual([photo(P.east)]);
    expect((await analysis.approve(MANAGER, ORG, photo(P.east))).reviewStatus).toBe("APPROVED");
    expect((await storyboard.getStoryboard(MANAGER, ORG, projects.east)).project.id).toBe(projects.east);
    expect(await analysis.listForProperty(MANAGER, ORG, P.mine)).toEqual([]);
    await expect(storyboard.getStoryboard(MANAGER, ORG, projects.unassigned)).rejects.toMatchObject(notFound("Video project not found"));
  });

  it("takes no new video project under a deleted Property and lists none, even for an OWNER", async () => {
    await expect(storyboard.createProject(OWNER, ORG, P.deleted, PROJECT_INPUT)).rejects.toMatchObject(notFound("Property not found"));
    await expect(storyboard.listProjects(OWNER, ORG, P.deleted)).rejects.toMatchObject(notFound("Property not found"));
    expect(await prisma.videoProject.count({ where: { propertyId: P.deleted } })).toBe(0);
  });

  it("follows a reassignment on the next request", async () => {
    await expect(analysis.getForAsset(CREATOR, ORG, photo(P.unassigned))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await properties.assign(OWNER, ORG, P.unassigned, { responsibleUserId: CREATOR });
    expect((await analysis.getForAsset(CREATOR, ORG, photo(P.unassigned))).assetId).toBe(photo(P.unassigned));
    expect((await storyboard.getStoryboard(CREATOR, ORG, projects.unassigned)).project.id).toBe(projects.unassigned);
  });
});
