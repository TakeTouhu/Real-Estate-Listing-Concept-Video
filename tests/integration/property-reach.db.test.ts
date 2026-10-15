import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AssetService, GroupService, PropertyService, type ObjectStorage, type Reach } from "@app/domain";
import { createPrismaIdentityRepositories, createPrismaPropertyRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Reach against PostgreSQL (Phase 6I-1, ADR-0064): the Property list filtered
 * in the query for each scope, and the Property and photo paths through the
 * real repositories, including a reassignment and a group membership change
 * taking effect on the next request.
 */

const ORG = "org_itest_reach";
const OTHER_ORG = "org_itest_reach_other";
const OWNER = "usr_itest_reach_owner";
const MANAGER = "usr_itest_reach_manager";
const CREATOR = "usr_itest_reach_creator";
const USERS = [OWNER, MANAGER, CREATOR];
const EAST = "grp_itest_reach_east";
const WEST = "grp_itest_reach_west";
const NORTH = "grp_itest_reach_north";
/** A group of the other organization that the MANAGER is in. */
const ELSEWHERE_GROUP = "grp_itest_reach_elsewhere";
const P = {
  unassigned: "prp_itest_reach_unassigned",
  creators: "prp_itest_reach_creators",
  east: "prp_itest_reach_east",
  west: "prp_itest_reach_west",
  north: "prp_itest_reach_north",
  deleted: "prp_itest_reach_deleted",
  elsewhere: "prp_itest_reach_elsewhere",
} as const;

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const prisma = new PrismaClient();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(),
  ids: { generate: (p: string) => `${p}_itest_reach_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const repos = createPrismaPropertyRepositories(prisma);
const properties = new PropertyService({ identity: deps, ...repos, clock: deps.clock, ids: deps.ids });
const groups = new GroupService(deps);

class NullStorage implements ObjectStorage {
  signed = 0;
  createSignedUploadUrl() {
    this.signed += 1;
    return Promise.resolve({ url: "upload://signed", expiresAt: new Date(0) });
  }
  createSignedDownloadUrl() {
    this.signed += 1;
    return Promise.resolve({ url: "download://signed", expiresAt: new Date(0) });
  }
  putObject() {
    return Promise.resolve();
  }
  getObject() {
    return Promise.resolve(null);
  }
  deleteObject() {
    return Promise.resolve();
  }
  exists() {
    return Promise.resolve(false);
  }
}
const storage = new NullStorage();
const assets = new AssetService({
  identity: deps,
  ...repos,
  storage,
  scanner: { scan: () => Promise.resolve({ verdict: "CLEAN" as const }) },
  images: { process: () => Promise.reject(new Error("not used")) },
  clock: deps.clock,
  ids: deps.ids,
});

async function cleanup(): Promise<void> {
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  // Properties before memberships and groups: their foreign keys refuse the cascade.
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  for (const id of USERS) await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: id, slug: `slug-${id}` } });
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "OWNER" },
      { organizationId: ORG, userId: MANAGER, role: "MANAGER" },
      { organizationId: ORG, userId: CREATOR, role: "CREATOR" },
      { organizationId: OTHER_ORG, userId: OWNER, role: "OWNER" },
      { organizationId: OTHER_ORG, userId: MANAGER, role: "MANAGER" },
    ],
  });
  await prisma.group.createMany({
    data: [
      ...[EAST, WEST, NORTH].map((id) => ({ id, organizationId: ORG, name: id, createdByUserId: OWNER })),
      { id: ELSEWHERE_GROUP, organizationId: OTHER_ORG, name: "East", createdByUserId: OWNER },
    ],
  });
  await prisma.groupMember.createMany({
    data: [
      { groupId: EAST, organizationId: ORG, userId: MANAGER, addedByUserId: OWNER },
      { groupId: WEST, organizationId: ORG, userId: MANAGER, addedByUserId: OWNER },
      { groupId: EAST, organizationId: ORG, userId: CREATOR, addedByUserId: OWNER },
      { groupId: ELSEWHERE_GROUP, organizationId: OTHER_ORG, userId: MANAGER, addedByUserId: OWNER },
    ],
  });
  const row = (id: string, extra: object = {}) => ({
    id,
    organizationId: ORG,
    name: id,
    propertyType: "APARTMENT" as const,
    createdBy: OWNER,
    ...extra,
  });
  await prisma.property.createMany({
    data: [
      row(P.unassigned),
      row(P.creators, { responsibleUserId: CREATOR }),
      row(P.east, { groupId: EAST }),
      row(P.west, { groupId: WEST }),
      row(P.north, { groupId: NORTH, responsibleUserId: MANAGER }),
      row(P.deleted, { groupId: EAST, responsibleUserId: CREATOR, status: "DELETED" as const }),
      { ...row(P.elsewhere, { groupId: ELSEWHERE_GROUP, responsibleUserId: MANAGER }), organizationId: OTHER_ORG },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

async function listed(reach: Reach): Promise<string[]> {
  return (await repos.properties.listReachable(reach)).map((p) => p.id).sort();
}

describe.skipIf(!HAS_DB)("the Property list filtered in the query", () => {
  it("ORGANIZATION lists every Property of the organization that is not deleted", async () => {
    expect(await listed({ scope: "ORGANIZATION", organizationId: ORG })).toEqual(
      [P.unassigned, P.creators, P.east, P.west, P.north].sort(),
    );
  });

  it("GROUP lists the union of the member's groups, and nothing for no group", async () => {
    expect(await listed({ scope: "GROUP", organizationId: ORG, groupIds: [EAST, WEST] })).toEqual([P.east, P.west].sort());
    expect(await listed({ scope: "GROUP", organizationId: ORG, groupIds: [] })).toEqual([]);
    // Another organization's group id names nothing here.
    expect(await listed({ scope: "GROUP", organizationId: ORG, groupIds: [ELSEWHERE_GROUP] })).toEqual([]);
  });

  it("OWN lists the Properties the member is the responsible user of", async () => {
    expect(await listed({ scope: "OWN", organizationId: ORG, userId: CREATOR })).toEqual([P.creators]);
    expect(await listed({ scope: "OWN", organizationId: ORG, userId: MANAGER })).toEqual([P.north]);
  });

  it("lists each member's reach through the service", async () => {
    expect((await properties.list(MANAGER, ORG)).map((p) => p.id).sort()).toEqual([P.east, P.west].sort());
    expect((await properties.list(CREATOR, ORG)).map((p) => p.id)).toEqual([P.creators]);
    expect((await properties.list(MANAGER, OTHER_ORG)).map((p) => p.id)).toEqual([P.elsewhere]);
  });
});

describe.skipIf(!HAS_DB)("single Property and photo paths", () => {
  it("answers a Property and its photos out of reach exactly as ones that do not exist", async () => {
    const { asset } = await assets.requestUpload(OWNER, { organizationId: ORG, propertyId: P.unassigned, originalFilename: "a.jpg", declaredSizeBytes: 10 });
    const signed = storage.signed;
    const missingProperty = await properties.get(CREATOR, ORG, "prp_itest_reach_missing").catch((e: unknown) => e);
    const missingPhoto = await assets.createDownloadUrl(CREATOR, ORG, "ast_itest_reach_missing").catch((e: unknown) => e);
    expect(await properties.get(CREATOR, ORG, P.unassigned).catch((e: unknown) => e)).toEqual(missingProperty);
    expect(await assets.list(CREATOR, ORG, P.unassigned)).toEqual([]);
    // The photo is still pending, so a reach check that let it through would answer its state instead.
    expect(await assets.createDownloadUrl(CREATOR, ORG, asset.id).catch((e: unknown) => e)).toEqual(missingPhoto);
    expect(await assets.retryUpload(CREATOR, ORG, asset.id).catch((e: unknown) => e)).toEqual(missingPhoto);
    expect(storage.signed).toBe(signed);
    expect(missingProperty).toMatchObject({ code: "NOT_FOUND", message: "Property not found" });
    expect(missingPhoto).toMatchObject({ code: "NOT_FOUND", message: "Asset not found" });
  });

  it("follows a reassignment and a group membership change on the next request", async () => {
    await expect(properties.get(CREATOR, ORG, P.unassigned)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await properties.assign(OWNER, ORG, P.unassigned, { responsibleUserId: CREATOR });
    expect((await properties.get(CREATOR, ORG, P.unassigned)).id).toBe(P.unassigned);

    expect((await properties.get(MANAGER, ORG, P.east)).id).toBe(P.east);
    await groups.removeMember(OWNER, ORG, EAST, MANAGER);
    await expect(properties.get(MANAGER, ORG, P.east)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await properties.list(MANAGER, ORG)).map((p) => p.id)).toEqual([P.west]);
  });
});
