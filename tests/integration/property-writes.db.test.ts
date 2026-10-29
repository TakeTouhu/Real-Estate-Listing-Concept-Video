import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PropertyService, type PropertyRepository } from "@app/domain";
import { createPrismaIdentityRepositories, createPrismaPropertyRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * A Property's rename and deletion against PostgreSQL (ADR-0101): each writes
 * only its own fields, and only while the Property stands, so a rename that
 * read the Property before its deletion saved cannot write `ACTIVE` back, and
 * a deletion that read it before a rename saved cannot write the old name back.
 */

const ORG = "org_itest_pwrite";
const OTHER_ORG = "org_itest_pwrite_other";
const OWNER = "usr_itest_pwrite_owner";
const PROPERTY = "prp_itest_pwrite_harbor";
/** A Property of the other organization. */
const ELSEWHERE = "prp_itest_pwrite_elsewhere";

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const prisma = new PrismaClient();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(),
  ids: { generate: (p: string) => `${p}_itest_pwrite_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const repos = createPrismaPropertyRepositories(prisma);
const service = (properties: PropertyRepository = repos.properties) =>
  new PropertyService({ identity: deps, properties, assets: repos.assets, clock: deps.clock, ids: deps.ids });

async function cleanup(): Promise<void> {
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await prisma.user.deleteMany({ where: { id: OWNER } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.user.create({ data: { id: OWNER, email: `${OWNER}@example.com`, name: OWNER } });
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: id, slug: `slug-${id}` } });
  await prisma.membership.createMany({
    data: [ORG, OTHER_ORG].map((organizationId) => ({ organizationId, userId: OWNER, role: "OWNER" as const })),
  });
  await prisma.property.createMany({
    data: [
      { id: PROPERTY, organizationId: ORG, name: "Harbor", description: "Sea view" },
      { id: ELSEWHERE, organizationId: OTHER_ORG, name: "Elsewhere", description: null },
    ].map((row) => ({ ...row, propertyType: "APARTMENT" as const, createdBy: OWNER })),
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

const row = (id = PROPERTY) => prisma.property.findUniqueOrThrow({ where: { id } });
const audits = (action: string) =>
  prisma.auditLog.count({ where: { organizationId: ORG, action, resourceId: PROPERTY } });

/**
 * The repository with a pause after the service's read of the Property: `meanwhile`
 * runs there, as another request saving between this one's read and its write.
 */
function readThen(meanwhile: () => Promise<unknown>): PropertyRepository {
  let paused = false;
  return {
    ...repos.properties,
    async findById(organizationId, id) {
      const read = await repos.properties.findById(organizationId, id);
      if (!paused) {
        paused = true;
        await meanwhile();
      }
      return read;
    },
  };
}

describe.skipIf(!HAS_DB)("a Property's own writes", () => {
  it("writes only the fields a change names, never the status or the assignments", async () => {
    const before = await row();
    expect(await repos.properties.updateDetails(ORG, PROPERTY, { name: "Harbor Point" })).toMatchObject({
      name: "Harbor Point",
      description: "Sea view",
      status: "ACTIVE",
    });
    expect(await repos.properties.updateDetails(ORG, PROPERTY, { name: undefined, description: null })).toMatchObject({
      name: "Harbor Point",
      description: null,
    });
    const after = await row();
    expect(after).toEqual({ ...before, name: "Harbor Point", description: null, updatedAt: after.updatedAt });
  });

  it("keeps an archived Property archived when it is renamed", async () => {
    await prisma.property.update({ where: { id: PROPERTY }, data: { status: "ARCHIVED" } });
    expect(await repos.properties.updateDetails(ORG, PROPERTY, { name: "Old harbor" })).toMatchObject({
      name: "Old harbor",
      status: "ARCHIVED",
    });
    expect((await row()).status).toBe("ARCHIVED");
  });

  it("answers a change naming no field with the Property as stored", async () => {
    const before = await row();
    const answered = await repos.properties.updateDetails(ORG, PROPERTY, {});
    expect(answered).toMatchObject({ name: "Harbor", description: "Sea view", status: "ACTIVE" });
    expect(await row()).toMatchObject({ name: before.name, description: before.description, status: before.status });
  });

  it("writes nothing for a deleted Property, another organization's or none", async () => {
    expect(await repos.properties.markDeleted(ORG, PROPERTY)).toBe(true);
    const deleted = await row();
    const elsewhere = await row(ELSEWHERE);
    expect(await repos.properties.updateDetails(ORG, PROPERTY, { name: "Back" })).toBeNull();
    expect(await repos.properties.updateDetails(ORG, ELSEWHERE, { name: "Mine" })).toBeNull();
    expect(await repos.properties.updateDetails(ORG, "prp_itest_pwrite_none", { name: "None" })).toBeNull();
    expect(await row()).toEqual(deleted);
    expect(await row(ELSEWHERE)).toEqual(elsewhere);
  });

  it("marks a Property deleted once, writing its status alone", async () => {
    await repos.properties.updateDetails(ORG, PROPERTY, { name: "Renamed" });
    const elsewhere = await row(ELSEWHERE);
    expect(await repos.properties.markDeleted(OTHER_ORG, PROPERTY)).toBe(false);
    expect((await row()).status).toBe("ACTIVE");
    expect(await repos.properties.markDeleted(ORG, PROPERTY)).toBe(true);
    expect(await row()).toMatchObject({ name: "Renamed", description: "Sea view", status: "DELETED" });
    expect(await repos.properties.markDeleted(ORG, PROPERTY)).toBe(false);
    expect(await repos.properties.markDeleted(ORG, ELSEWHERE)).toBe(false);
    expect(await row(ELSEWHERE)).toEqual(elsewhere);
  });
});

describe.skipIf(!HAS_DB)("a rename and a deletion racing", () => {
  it("leaves the Property deleted when the deletion saves after the rename read it", async () => {
    const rename = service(readThen(() => service().remove(OWNER, ORG, PROPERTY)));
    await expect(rename.update(OWNER, ORG, PROPERTY, { name: "Too late" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await row()).toMatchObject({ name: "Harbor", status: "DELETED" });
    expect(await audits("property.updated")).toBe(0);
    expect(await audits("property.deleted")).toBe(1);
  });

  it("keeps the new name when the rename saves after the deletion read it", async () => {
    const deletion = service(readThen(() => service().update(OWNER, ORG, PROPERTY, { name: "Renamed first" })));
    await deletion.remove(OWNER, ORG, PROPERTY);
    expect(await row()).toMatchObject({ name: "Renamed first", description: "Sea view", status: "DELETED" });
    expect(await audits("property.updated")).toBe(1);
    expect(await audits("property.deleted")).toBe(1);
  });

  it("answers a second deletion that read the Property standing as not found, with one audit entry", async () => {
    const second = service(readThen(() => service().remove(OWNER, ORG, PROPERTY)));
    await expect(second.remove(OWNER, ORG, PROPERTY)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row()).status).toBe("DELETED");
    expect(await audits("property.deleted")).toBe(1);
  });

  it("keeps the name, type and address another rename changed when this one changes the description", async () => {
    const change = { name: "Harbor Point", propertyType: "OFFICE" as const, addressMasked: "Tokyo" };
    const rename = service(readThen(() => service().update(OWNER, ORG, PROPERTY, change)));
    await rename.update(OWNER, ORG, PROPERTY, { description: "Garden view" });
    expect(await row()).toMatchObject({ ...change, description: "Garden view", status: "ACTIVE" });
  });

  it("keeps a field another rename changed since this one read the Property", async () => {
    const rename = service(readThen(() => service().update(OWNER, ORG, PROPERTY, { description: "Garden view" })));
    await rename.update(OWNER, ORG, PROPERTY, { name: "Harbor Point" });
    expect(await row()).toMatchObject({ name: "Harbor Point", description: "Garden view", status: "ACTIVE" });
  });
});
