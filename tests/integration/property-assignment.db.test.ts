import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GroupService, MembershipService, PropertyService } from "@app/domain";
import { createPrismaIdentityRepositories, createPrismaPropertyRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Property assignment against PostgreSQL (Phase 6H, ADR-0062): the foreign keys
 * that keep a responsible user and a group inside the Property's organization,
 * each change committed with its audit row or not at all, and assignments
 * racing a member's removal, a group's deletion, each other, and both releases
 * at once.
 */

const ORG = "org_itest_assign";
const OTHER_ORG = "org_itest_assign_other";
const OWNER = "usr_itest_assign_owner";
const ADMIN = "usr_itest_assign_admin";
const MANAGER = "usr_itest_assign_manager";
const VIEWER = "usr_itest_assign_viewer";
const STRANGER = "usr_itest_assign_stranger";
const USERS = [OWNER, ADMIN, MANAGER, VIEWER, STRANGER];
// An audit entry naming an organization that does not exist breaks its foreign
// key, so it cannot be written.
const UNWRITABLE = "org_itest_assign_missing";
const GROUP = "grp_itest_assign_east";
const OTHER_GROUP = "grp_itest_assign_elsewhere";
const PROPERTY = "prp_itest_assign_harbor";
const SECOND = "prp_itest_assign_second";
/** A Property of the other organization. */
const ELSEWHERE = "prp_itest_assign_elsewhere";
const CHANGED = "The responsible user or group changed meanwhile; reload and try again";

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

/** Room for a lock holder, two contenders and the poll, whatever the host's default pool. */
function pooled(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("connection_limit", "8");
  return parsed.toString();
}

const prisma = new PrismaClient(
  HAS_DB ? { datasources: { db: { url: pooled(process.env.DATABASE_URL ?? "") } } } : undefined,
);
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(),
  ids: { generate: (p: string) => `${p}_itest_assign_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const repos = createPrismaPropertyRepositories(prisma);
const properties = new PropertyService({ identity: deps, ...repos, clock: deps.clock, ids: deps.ids });
const groups = new GroupService(deps);
const members = new MembershipService(deps, { invitationTtlSeconds: 3600 });

async function cleanup(): Promise<void> {
  // Properties first: their foreign keys refuse the memberships' and groups' cascade.
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
      { organizationId: ORG, userId: ADMIN, role: "ADMIN" },
      { organizationId: ORG, userId: MANAGER, role: "MANAGER" },
      { organizationId: ORG, userId: VIEWER, role: "VIEWER" },
      { organizationId: OTHER_ORG, userId: OWNER, role: "OWNER" },
      { organizationId: OTHER_ORG, userId: MANAGER, role: "MANAGER" },
      { organizationId: OTHER_ORG, userId: STRANGER, role: "VIEWER" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: GROUP, organizationId: ORG, name: "East", createdByUserId: OWNER },
      { id: OTHER_GROUP, organizationId: OTHER_ORG, name: "East", createdByUserId: OWNER },
    ],
  });
  await prisma.groupMember.createMany({
    data: [
      ...[MANAGER, VIEWER].map((userId) => ({ groupId: GROUP, organizationId: ORG, userId, addedByUserId: OWNER })),
      // The MANAGER's group in the other organization is not one of its groups here.
      { groupId: OTHER_GROUP, organizationId: OTHER_ORG, userId: MANAGER, addedByUserId: OWNER },
    ],
  });
  await prisma.property.createMany({
    data: [PROPERTY, SECOND].map((id) => ({
      id,
      organizationId: ORG,
      name: id,
      propertyType: "APARTMENT" as const,
      createdBy: OWNER,
    })),
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

const audit = (action: string, organizationId = ORG) => ({
  organizationId,
  actorUserId: OWNER,
  action,
  resourceType: "property",
  resourceId: PROPERTY,
  metadata: {},
});

const UNASSIGNED = { responsibleUserId: null, groupId: null };

function assign(next: { responsibleUserId?: string | null; groupId?: string | null }, id = PROPERTY) {
  return prisma.property.update({ where: { id }, data: next });
}

async function assignment(id = PROPERTY): Promise<{ responsibleUserId: string | null; groupId: string | null } | null> {
  return prisma.property.findUnique({ where: { id }, select: { responsibleUserId: true, groupId: true } });
}

function auditRows(action: string) {
  return prisma.auditLog.findMany({ where: { organizationId: ORG, action }, orderBy: { createdAt: "asc" } });
}

async function waiting(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
  return row?.waiting ?? 0;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the contenders never all waited on the lock holder");
}

/**
 * Run `lock` in a transaction and hold what it locked; start each contender
 * only once every one before it waits for a lock, so they queue in order; and
 * let the holder commit once all of them wait. The holder's own write, if it
 * makes one, commits first: the interleaving a race needs, made deterministic.
 * (The suite's files run one at a time, so no other session waits meanwhile.)
 */
async function contend(
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  contenders: (() => Promise<unknown>)[],
): Promise<PromiseSettledResult<unknown>[]> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld = (): void => undefined;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const holder = prisma.$transaction(
    async (tx) => {
      await lock(tx);
      signalHeld();
      await released;
    },
    { timeout: 30_000 },
  );
  await Promise.race([held, holder]);
  const started: Promise<unknown>[] = [];
  try {
    for (const [index, run] of contenders.entries()) {
      started.push(run());
      await until(async () => (await waiting()) >= index + 1);
    }
  } finally {
    release();
  }
  await holder;
  return Promise.allSettled(started);
}

const lockMember = (userId: string) => (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT 1 FROM "memberships" WHERE "organizationId" = ${ORG} AND "userId" = ${userId} FOR UPDATE`;
const lockGroup = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT 1 FROM "groups" WHERE "id" = ${GROUP} FOR UPDATE`;

function refusals(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}

describe.skipIf(!HAS_DB)("the foreign keys keep each assignment inside the organization", () => {
  it("never makes a member of another organization a Property's responsible user", async () => {
    // STRANGER is a member of the other organization only.
    await expect(assign({ responsibleUserId: STRANGER })).rejects.toMatchObject({ code: "P2003" });
    await expect(assign({ responsibleUserId: "usr_itest_assign_nobody" })).rejects.toMatchObject({ code: "P2003" });
    expect(await assignment()).toEqual(UNASSIGNED);
  });

  it("never gives a Property another organization's group", async () => {
    await expect(assign({ groupId: OTHER_GROUP })).rejects.toMatchObject({ code: "P2003" });
    expect(await assignment()).toEqual(UNASSIGNED);
  });

  it("refuses to drop a membership or group a Property still refers to", async () => {
    await assign({ responsibleUserId: VIEWER, groupId: GROUP });
    await expect(
      prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG, userId: VIEWER } } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.group.delete({ where: { id: GROUP } })).rejects.toMatchObject({ code: "P2003" });
    expect(await assignment()).toEqual({ responsibleUserId: VIEWER, groupId: GROUP });
  });
});

describe.skipIf(!HAS_DB)("each assignment commits with its audit entry or not at all", () => {
  const input = {
    id: "prp_itest_assign_new",
    organizationId: ORG,
    name: "New",
    propertyType: "HOUSE" as const,
    addressMasked: null,
    description: null,
    status: "ACTIVE" as const,
    createdBy: OWNER,
    responsibleUserId: VIEWER,
    groupId: GROUP,
  };

  it("commits no Property whose audit entry cannot be written", async () => {
    await expect(repos.properties.create(input, audit("property.created", UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await assignment(input.id)).toBeNull();
  });

  it("answers a creation naming a non-member or another organization's group as stale, writing nothing", async () => {
    for (const named of [{ responsibleUserId: STRANGER }, { groupId: OTHER_GROUP }]) {
      expect(await repos.properties.create({ ...input, ...named }, audit("property.created"))).toEqual({ outcome: "STALE" });
    }
    expect(await assignment(input.id)).toBeNull();
    expect(await auditRows("property.created")).toEqual([]);
  });

  it("commits no reassignment whose audit entry cannot be written", async () => {
    await expect(
      repos.properties.assign(ORG, PROPERTY, UNASSIGNED, { responsibleUserId: VIEWER, groupId: GROUP }, audit("x", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await assignment()).toEqual(UNASSIGNED);
  });

  it("applies a reassignment only to a live Property of the organization still holding what it expects", async () => {
    const next = { responsibleUserId: VIEWER, groupId: GROUP };
    expect(await repos.properties.assign(OTHER_ORG, PROPERTY, UNASSIGNED, next, audit("x", OTHER_ORG))).toEqual({ outcome: "STALE" });
    for (const stale of [{ responsibleUserId: MANAGER, groupId: null }, { responsibleUserId: null, groupId: GROUP }]) {
      expect(await repos.properties.assign(ORG, PROPERTY, stale, next, audit("x"))).toEqual({ outcome: "STALE" });
    }
    expect(await repos.properties.assign(ORG, PROPERTY, UNASSIGNED, { ...next, responsibleUserId: STRANGER }, audit("x"))).toEqual({
      outcome: "STALE",
    });
    await prisma.property.update({ where: { id: SECOND }, data: { status: "DELETED" } });
    expect(await repos.properties.assign(ORG, SECOND, UNASSIGNED, next, audit("x"))).toEqual({ outcome: "STALE" });
    expect([await assignment(), await assignment(SECOND)]).toEqual([UNASSIGNED, UNASSIGNED]);
    expect(await prisma.auditLog.count({ where: { organizationId: { in: [ORG, OTHER_ORG] } } })).toBe(0);
    const assigned = await repos.properties.assign(ORG, PROPERTY, UNASSIGNED, next, audit("x"));
    expect(assigned).toMatchObject({ outcome: "ASSIGNED", property: { id: PROPERTY, ...next } });
    expect(await auditRows("x")).toHaveLength(1);
  });

  it("keeps a group's Properties grouped when its deletion's audit entry cannot be written", async () => {
    await assign({ groupId: GROUP });
    const admit = () => null;
    await expect(
      deps.repos.groups.delete(ORG, GROUP, admit, () => ({ ...audit("group.deleted", UNWRITABLE), resourceType: "group" })),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await assignment()).toEqual({ responsibleUserId: null, groupId: GROUP });
  });

  it("keeps a member's Properties assigned when its removal's audit entry cannot be written", async () => {
    await assign({ responsibleUserId: VIEWER });
    await expect(
      deps.repos.memberships.remove(ORG, VIEWER, "VIEWER", () => audit("member.removed", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await assignment()).toEqual({ responsibleUserId: VIEWER, groupId: null });
  });
});

describe.skipIf(!HAS_DB)("the service against PostgreSQL", () => {
  it("never writes the assignments when a Property is edited, even from a stale snapshot", async () => {
    const before = await repos.properties.findById(ORG, PROPERTY);
    if (!before) throw new Error("fixture Property missing");
    await assign({ responsibleUserId: VIEWER, groupId: GROUP });
    const edited = await repos.properties.update({ ...before, name: "Edited" });
    expect(edited).toMatchObject({ name: "Edited", responsibleUserId: VIEWER, groupId: GROUP });
    expect(await assignment()).toEqual({ responsibleUserId: VIEWER, groupId: GROUP });
  });

  it("creates a Property with its initial assignments and their audit row, in one transaction", async () => {
    const owners = await properties.create(OWNER, {
      organizationId: ORG,
      name: "Owner's",
      propertyType: "OFFICE",
      rightsConfirmed: true,
      responsibleUserId: VIEWER,
      groupId: GROUP,
    });
    const managers = await properties.create(MANAGER, { organizationId: ORG, name: "Manager's", propertyType: "OFFICE", rightsConfirmed: true });
    expect([await assignment(owners.id), await assignment(managers.id)]).toEqual([
      { responsibleUserId: VIEWER, groupId: GROUP },
      { responsibleUserId: MANAGER, groupId: GROUP },
    ]);
    expect((await auditRows("property.created")).map((row) => row.metadata)).toEqual([
      { propertyType: "OFFICE", creatorRole: "OWNER", responsibleUserId: VIEWER, groupId: GROUP },
      { propertyType: "OFFICE", creatorRole: "MANAGER", responsibleUserId: MANAGER, groupId: GROUP },
    ]);
  });

  it("reassigns, recording previous and new", async () => {
    await assign({ responsibleUserId: VIEWER });
    const result = await properties.assign(ADMIN, ORG, PROPERTY, { responsibleUserId: MANAGER, groupId: GROUP });
    expect(result).toMatchObject({ changed: true, property: { responsibleUserId: MANAGER, groupId: GROUP } });
    expect((await auditRows("property.assignment_changed")).map((row) => row.metadata)).toEqual([
      { actorRole: "ADMIN", previousResponsibleUserId: VIEWER, responsibleUserId: MANAGER, previousGroupId: null, groupId: GROUP },
    ]);
  });

  it("ungroups a deleted group's Properties and unassigns a removed member's, counting each", async () => {
    await assign({ responsibleUserId: VIEWER, groupId: GROUP });
    await assign({ responsibleUserId: MANAGER, groupId: GROUP }, SECOND);
    await groups.delete(OWNER, ORG, GROUP);
    expect([await assignment(), await assignment(SECOND)]).toEqual([
      { responsibleUserId: VIEWER, groupId: null },
      { responsibleUserId: MANAGER, groupId: null },
    ]);
    await members.removeMember(OWNER, ORG, VIEWER);
    expect([await assignment(), await assignment(SECOND)]).toEqual([UNASSIGNED, { responsibleUserId: MANAGER, groupId: null }]);
    expect((await auditRows("group.deleted"))[0]?.metadata).toEqual({
      name: "East",
      actorRole: "OWNER",
      removedMemberCount: 2,
      ungroupedPropertyCount: 2,
    });
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 1 });
  });

  it("unassigns only this organization's Properties of a member who belongs to two", async () => {
    // The MANAGER is a member of both organizations and responsible in each.
    await prisma.property.create({
      data: {
        id: ELSEWHERE,
        organizationId: OTHER_ORG,
        name: ELSEWHERE,
        propertyType: "APARTMENT",
        createdBy: OWNER,
        responsibleUserId: MANAGER,
        groupId: OTHER_GROUP,
      },
    });
    await assign({ responsibleUserId: MANAGER });
    await members.removeMember(OWNER, ORG, MANAGER);
    expect([await assignment(), await assignment(ELSEWHERE)]).toEqual([
      UNASSIGNED,
      { responsibleUserId: MANAGER, groupId: OTHER_GROUP },
    ]);
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 1 });
  });
});

describe.skipIf(!HAS_DB)("assignments racing a member's removal or a group's deletion", () => {
  it("releases an assignment that commits while the member's removal waits for it", async () => {
    const results = await contend((tx) => tx.property.update({ where: { id: PROPERTY }, data: { responsibleUserId: VIEWER } }), [
      () => members.removeMember(OWNER, ORG, VIEWER),
    ]);
    expect(refusals(results)).toEqual([]);
    expect(await assignment()).toEqual(UNASSIGNED);
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 1 });
  });

  it("refuses an assignment to a member whose removal commits first", async () => {
    const results = await contend(lockMember(VIEWER), [
      () => members.removeMember(OWNER, ORG, VIEWER),
      () => properties.assign(OWNER, ORG, PROPERTY, { responsibleUserId: VIEWER }),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: CHANGED })]);
    expect(await assignment()).toEqual(UNASSIGNED);
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 0 });
    expect(await auditRows("property.assignment_changed")).toEqual([]);
  });

  it("ungroups an assignment that commits while the group's deletion waits for it", async () => {
    const results = await contend((tx) => tx.property.update({ where: { id: PROPERTY }, data: { groupId: GROUP } }), [
      () => groups.delete(OWNER, ORG, GROUP),
    ]);
    expect(refusals(results)).toEqual([]);
    expect(await assignment()).toEqual(UNASSIGNED);
    expect((await auditRows("group.deleted"))[0]?.metadata).toMatchObject({ ungroupedPropertyCount: 1 });
  });

  it("does not release a Property a reassignment took from the member first", async () => {
    await assign({ responsibleUserId: VIEWER });
    const results = await contend((tx) => tx.property.update({ where: { id: PROPERTY }, data: { responsibleUserId: MANAGER } }), [
      () => members.removeMember(OWNER, ORG, VIEWER),
    ]);
    expect(refusals(results)).toEqual([]);
    expect(await assignment()).toEqual({ responsibleUserId: MANAGER, groupId: null });
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 0 });
  });

  it("does not ungroup a Property a reassignment took from the group first", async () => {
    await assign({ groupId: GROUP });
    const results = await contend((tx) => tx.property.update({ where: { id: PROPERTY }, data: { groupId: null, responsibleUserId: VIEWER } }), [
      () => groups.delete(OWNER, ORG, GROUP),
    ]);
    expect(refusals(results)).toEqual([]);
    expect(await assignment()).toEqual({ responsibleUserId: VIEWER, groupId: null });
    expect((await auditRows("group.deleted"))[0]?.metadata).toMatchObject({ ungroupedPropertyCount: 0 });
  });

  it("refuses an assignment to a group whose deletion commits first", async () => {
    const results = await contend(lockGroup, [
      () => groups.delete(OWNER, ORG, GROUP),
      () => properties.assign(ADMIN, ORG, PROPERTY, { groupId: GROUP }),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: CHANGED })]);
    expect(await assignment()).toEqual(UNASSIGNED);
    expect((await auditRows("group.deleted"))[0]?.metadata).toMatchObject({ ungroupedPropertyCount: 0 });
  });

  it("releases a Property created while the member's removal waits for it", async () => {
    const results = await contend(
      (tx) =>
        tx.property.create({
          data: { id: "prp_itest_assign_raced", organizationId: ORG, name: "Raced", propertyType: "HOUSE", createdBy: OWNER, responsibleUserId: VIEWER },
        }),
      [() => members.removeMember(OWNER, ORG, VIEWER)],
    );
    expect(refusals(results)).toEqual([]);
    expect(await assignment("prp_itest_assign_raced")).toEqual(UNASSIGNED);
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 1 });
  });

  it("refuses a creation naming a member whose removal commits first", async () => {
    const results = await contend(lockMember(VIEWER), [
      () => members.removeMember(OWNER, ORG, VIEWER),
      () => properties.create(OWNER, { organizationId: ORG, name: "Late", propertyType: "HOUSE", rightsConfirmed: true, responsibleUserId: VIEWER }),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: CHANGED })]);
    expect(await prisma.property.count({ where: { organizationId: ORG, name: "Late" } })).toBe(0);
    expect(await auditRows("property.created")).toEqual([]);
  });

  it("refuses a MANAGER's creation in its group when the group's deletion commits first", async () => {
    const results = await contend(lockGroup, [
      () => groups.delete(OWNER, ORG, GROUP),
      () => properties.create(MANAGER, { organizationId: ORG, name: "Late", propertyType: "HOUSE", rightsConfirmed: true }),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: CHANGED })]);
    expect(await prisma.property.count({ where: { organizationId: ORG, name: "Late" } })).toBe(0);
    expect(await auditRows("property.created")).toEqual([]);
  });

  it("applies one of two reassignments checked against the same assignments", async () => {
    const results = await contend((tx) => tx.property.update({ where: { id: PROPERTY }, data: { responsibleUserId: VIEWER } }), [
      () => properties.assign(ADMIN, ORG, PROPERTY, { responsibleUserId: MANAGER }),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: CHANGED })]);
    expect(await assignment()).toEqual({ responsibleUserId: VIEWER, groupId: null });
    expect(await auditRows("property.assignment_changed")).toEqual([]);
  });

  it.each([
    ["the group's deletion", "the member's removal"],
    ["the member's removal", "the group's deletion"],
  ])("releases the same Properties from %s and %s, in either order, without deadlock", async (first) => {
    await assign({ responsibleUserId: VIEWER, groupId: GROUP });
    await assign({ responsibleUserId: VIEWER, groupId: GROUP }, SECOND);
    const deletion = () => groups.delete(OWNER, ORG, GROUP);
    const removal = () => members.removeMember(OWNER, ORG, VIEWER);
    const results = await contend(
      (tx) => tx.$queryRaw`SELECT 1 FROM "properties" WHERE "id" IN (${PROPERTY}, ${SECOND}) ORDER BY "id" FOR UPDATE`,
      first === "the group's deletion" ? [deletion, removal] : [removal, deletion],
    );
    expect(refusals(results)).toEqual([]);
    expect([await assignment(), await assignment(SECOND)]).toEqual([UNASSIGNED, UNASSIGNED]);
    expect((await auditRows("group.deleted"))[0]?.metadata).toMatchObject({
      // The member counts only when the deletion found it still in the group.
      removedMemberCount: first === "the group's deletion" ? 2 : 1,
      ungroupedPropertyCount: 2,
    });
    expect((await auditRows("member.removed"))[0]?.metadata).toEqual({ unassignedPropertyCount: 2 });
  });
});
