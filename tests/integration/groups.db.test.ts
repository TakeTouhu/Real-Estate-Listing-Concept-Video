import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GroupService, MembershipService } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Groups against PostgreSQL (Phase 6F, ADR-0060): the tables' constraints and
 * cascades, organization scoping, each change committed with its audit row or
 * not at all, and changes racing each other.
 */

const ORG = "org_itest_groups";
const OTHER_ORG = "org_itest_groups_other";
const OWNER = "usr_itest_groups_owner";
const ADMIN = "usr_itest_groups_admin";
const MANAGER = "usr_itest_groups_manager";
const CREATOR = "usr_itest_groups_creator";
const VIEWER = "usr_itest_groups_viewer";
const USERS = [OWNER, ADMIN, MANAGER, CREATOR, VIEWER];
// An audit entry naming an organization that does not exist breaks its foreign
// key, so it cannot be written.
const UNWRITABLE = "org_itest_groups_missing";
const GROUP = "grp_itest_groups_sales";
const OTHER_GROUP = "grp_itest_groups_elsewhere";

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
  ids: { generate: (p: string) => `${p}_itest_groups_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const groups = new GroupService(deps);
const members = new MembershipService(deps, { invitationTtlSeconds: 3600 });

async function cleanup(): Promise<void> {
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
      { organizationId: ORG, userId: CREATOR, role: "CREATOR" },
      { organizationId: ORG, userId: VIEWER, role: "VIEWER" },
      { organizationId: OTHER_ORG, userId: OWNER, role: "OWNER" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: GROUP, organizationId: ORG, name: "Sales", createdByUserId: OWNER },
      { id: OTHER_GROUP, organizationId: OTHER_ORG, name: "Sales", createdByUserId: OWNER },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

/** A ceiling check that admits every change, for the repository's own behavior. */
const admit = () => null;

const audit = (action: string, organizationId = ORG) => ({
  organizationId,
  actorUserId: OWNER,
  action,
  resourceType: "group",
  resourceId: GROUP,
  metadata: {},
});

function seat(userId: string, groupId = GROUP) {
  return prisma.groupMember.create({ data: { groupId, organizationId: ORG, userId, addedByUserId: OWNER } });
}

async function memberIds(groupId = GROUP): Promise<string[]> {
  return (await prisma.groupMember.findMany({ where: { groupId }, orderBy: { userId: "asc" } })).map((m) => m.userId);
}

async function nameOf(groupId = GROUP): Promise<string | undefined> {
  return (await prisma.group.findUnique({ where: { id: groupId } }))?.name;
}

function auditRows(action?: string) {
  return prisma.auditLog.findMany({ where: { organizationId: ORG, ...(action === undefined ? {} : { action }) } });
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the contenders never all waited on the lock holder");
}

/**
 * Start `contenders` while another transaction runs `lock` and holds what it
 * locked, and let that transaction commit only once every contender is waiting
 * for a lock, on it or on a contender queued before it. Each contender has by
 * then read what it checks, and none has written: the interleaving a race
 * needs, made deterministic. (The suite's files run one at a time, so no other
 * session waits on a lock meanwhile.)
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
  const settled = Promise.allSettled(contenders.map((run) => run()));
  try {
    await until(async () => {
      const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      return (row?.waiting ?? 0) >= contenders.length;
    });
  } finally {
    release();
  }
  await holder;
  return settled;
}

const lockGroup = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT 1 FROM "groups" WHERE "id" = ${GROUP} FOR UPDATE`;

function refusals(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}

describe.skipIf(!HAS_DB)("the group tables hold only what the service may write", () => {
  it.each(["", " padded", "padded ", "x".repeat(101)])("refuses the stored name %j", async (name) => {
    await expect(
      prisma.$executeRaw`INSERT INTO "groups" ("id", "organizationId", "name", "createdByUserId", "updatedAt")
        VALUES ('grp_itest_groups_bad', ${ORG}, ${name}, ${OWNER}, now())`,
    ).rejects.toThrow(/groups_name_check/);
  });

  it("refuses a second group of the same name in one organization", async () => {
    await expect(
      prisma.group.create({ data: { id: "grp_itest_groups_dup", organizationId: ORG, name: "Sales", createdByUserId: OWNER } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("never links a group of one organization to a member of another", async () => {
    // OWNER is a member of both organizations, so each foreign key alone would hold.
    await expect(
      prisma.groupMember.create({ data: { groupId: OTHER_GROUP, organizationId: ORG, userId: OWNER, addedByUserId: OWNER } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.groupMember.create({ data: { groupId: GROUP, organizationId: OTHER_ORG, userId: OWNER, addedByUserId: OWNER } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("removes a member's group rows with its membership, and a group's with the group", async () => {
    await seat(CREATOR);
    await seat(VIEWER);
    await members.removeMember(OWNER, ORG, CREATOR);
    expect(await memberIds()).toEqual([VIEWER]);
    await prisma.group.delete({ where: { id: GROUP } });
    expect(await prisma.groupMember.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.membership.count({ where: { organizationId: ORG, userId: VIEWER } })).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("every read and write is scoped by organization", () => {
  it("finds, renames, deletes and lists nothing of another organization", async () => {
    await seat(CREATOR);
    expect(await deps.repos.groups.find(OTHER_ORG, GROUP)).toBeNull();
    expect(await deps.repos.groups.listMembers(OTHER_ORG, GROUP)).toEqual([]);
    expect((await deps.repos.groups.listByOrganization(ORG)).map((g) => g.id)).toEqual([GROUP]);
    expect(await deps.repos.groups.rename(OTHER_ORG, GROUP, "Sales", "Taken", audit("x", OTHER_ORG))).toEqual({
      outcome: "STALE",
    });
    expect(await deps.repos.groups.delete(OTHER_ORG, GROUP, admit, () => audit("x", OTHER_ORG))).toEqual({
      outcome: "STALE",
    });
    expect(await deps.repos.groups.removeMember(OTHER_ORG, GROUP, CREATOR, admit, audit("x", OTHER_ORG))).toEqual({
      outcome: "NOT_IN_GROUP",
    });
    expect([await nameOf(), await memberIds()]).toEqual(["Sales", [CREATOR]]);
    expect(await prisma.auditLog.count({ where: { organizationId: { in: [ORG, OTHER_ORG] } } })).toBe(0);
  });

  it("does not let the service reach another organization's group", async () => {
    await expect(groups.addMember(OWNER, ORG, OTHER_GROUP, CREATOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(groups.delete(OWNER, ORG, OTHER_GROUP)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await nameOf(OTHER_GROUP)).toBe("Sales");
  });
});

describe.skipIf(!HAS_DB)("each group change commits with its audit entry or not at all", () => {
  it("commits no group whose audit entry cannot be written", async () => {
    const input = { id: "grp_itest_groups_new", organizationId: ORG, name: "Support", createdByUserId: OWNER };
    await expect(deps.repos.groups.create(input, audit("group.created", UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await nameOf(input.id)).toBeUndefined();
  });

  it("commits no rename whose audit entry cannot be written", async () => {
    await expect(
      deps.repos.groups.rename(ORG, GROUP, "Sales", "Support", audit("group.renamed", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await nameOf()).toBe("Sales");
  });

  it("commits no deletion whose audit entry cannot be written, keeping the members", async () => {
    await seat(CREATOR);
    await expect(deps.repos.groups.delete(ORG, GROUP, admit, () => audit("group.deleted", UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect([await nameOf(), await memberIds()]).toEqual(["Sales", [CREATOR]]);
  });

  it("commits no addition whose audit entry cannot be written", async () => {
    const member = { groupId: GROUP, organizationId: ORG, userId: CREATOR, addedByUserId: OWNER };
    await expect(deps.repos.groups.addMember(member, admit, audit("group.member_added", UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await memberIds()).toEqual([]);
  });

  it("commits no removal whose audit entry cannot be written", async () => {
    await seat(CREATOR);
    await expect(
      deps.repos.groups.removeMember(ORG, GROUP, CREATOR, admit, audit("group.member_removed", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await memberIds()).toEqual([CREATOR]);
  });

  it("records creation, rename, addition, removal and deletion, each with its own audit row", async () => {
    const group = await groups.create(OWNER, ORG, " Support ");
    await groups.rename(ADMIN, ORG, group.id, "Field");
    await groups.addMember(ADMIN, ORG, group.id, MANAGER);
    await groups.addMember(OWNER, ORG, group.id, VIEWER);
    await groups.removeMember(ADMIN, ORG, group.id, VIEWER);
    await groups.delete(ADMIN, ORG, group.id);
    expect(await nameOf(group.id)).toBeUndefined();
    // Rows written within one millisecond tie on createdAt, so order is not asserted.
    const rows = await auditRows();
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => [r.action, r.actorUserId, r.resourceType, r.resourceId, r.metadata])).toEqual(
      expect.arrayContaining([
        ["group.created", OWNER, "group", group.id, { name: "Support" }],
        ["group.renamed", ADMIN, "group", group.id, { name: "Field", previousName: "Support" }],
        ["group.member_added", ADMIN, "group", group.id, { targetUserId: MANAGER, targetRole: "MANAGER" }],
        ["group.member_added", OWNER, "group", group.id, { targetUserId: VIEWER, targetRole: "VIEWER" }],
        ["group.member_removed", ADMIN, "group", group.id, { targetUserId: VIEWER, targetRole: "VIEWER" }],
        ["group.deleted", ADMIN, "group", group.id, { name: "Field", actorRole: "ADMIN", removedMemberCount: 1, ungroupedPropertyCount: 0 }],
      ]),
    );
  });
});

describe.skipIf(!HAS_DB)("a change checked against what is no longer true writes nothing", () => {
  it("does not rename a group that no longer has the name it was checked against", async () => {
    expect(await deps.repos.groups.rename(ORG, GROUP, "Support", "Field", audit("x"))).toEqual({ outcome: "STALE" });
    expect(await nameOf()).toBe("Sales");
    expect(await auditRows()).toEqual([]);
  });

  it("answers NAME_TAKEN for a name in use, writing nothing", async () => {
    await prisma.group.create({ data: { id: "grp_itest_groups_support", organizationId: ORG, name: "Support", createdByUserId: OWNER } });
    expect(await deps.repos.groups.rename(ORG, GROUP, "Sales", "Support", audit("x"))).toEqual({ outcome: "NAME_TAKEN" });
    const input = { id: "grp_itest_groups_third", organizationId: ORG, name: "Sales", createdByUserId: OWNER };
    expect(await deps.repos.groups.create(input, audit("x"))).toEqual({ outcome: "NAME_TAKEN" });
    expect(await auditRows()).toEqual([]);
  });

  it("adds no member to a group that is gone, nor one who left the organization", async () => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG, userId: CREATOR } } });
    const add = (groupId: string, userId: string) =>
      deps.repos.groups.addMember({ groupId, organizationId: ORG, userId, addedByUserId: OWNER }, admit, audit("x"));
    expect(await add(GROUP, CREATOR)).toEqual({ outcome: "STALE" });
    expect(await add("grp_itest_groups_missing", VIEWER)).toEqual({ outcome: "STALE" });
    expect(await memberIds()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("answers ALREADY_IN_GROUP for a member already in the group, writing nothing", async () => {
    await seat(CREATOR);
    const member = { groupId: GROUP, organizationId: ORG, userId: CREATOR, addedByUserId: ADMIN };
    expect(await deps.repos.groups.addMember(member, admit, audit("x"))).toEqual({ outcome: "ALREADY_IN_GROUP" });
    expect(await auditRows()).toEqual([]);
  });

  it("deletes nothing for a group that is gone", async () => {
    expect(await deps.repos.groups.delete(ORG, "grp_itest_groups_missing", admit, () => audit("x"))).toEqual({
      outcome: "STALE",
    });
    expect(await auditRows()).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("group changes racing each other", () => {
  it("adds a member once, with one audit row, when two additions race", async () => {
    const results = await contend(lockGroup, [
      () => groups.addMember(OWNER, ORG, GROUP, CREATOR),
      () => groups.addMember(ADMIN, ORG, GROUP, CREATOR),
    ]);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : r.reason))).toEqual(
      expect.arrayContaining([{ added: true }, { added: false }]),
    );
    expect(await memberIds()).toEqual([CREATOR]);
    expect(await auditRows("group.member_added")).toHaveLength(1);
  });

  it("creates one of two groups given the same name at once", async () => {
    const results = await contend(
      (tx) => tx.$queryRaw`SELECT 1 FROM "organizations" WHERE "id" = ${ORG} FOR UPDATE`,
      [() => groups.create(OWNER, ORG, "Support"), () => groups.create(ADMIN, ORG, "Support")],
    );
    expect(refusals(results)).toEqual([
      expect.objectContaining({ code: "VALIDATION_FAILED", message: "A group with this name already exists" }),
    ]);
    expect(await prisma.group.count({ where: { organizationId: ORG, name: "Support" } })).toBe(1);
    expect(await auditRows("group.created")).toHaveLength(1);
  });

  it("applies one of two renames checked against the same name", async () => {
    const results = await contend(lockGroup, [
      () => groups.rename(OWNER, ORG, GROUP, "East"),
      () => groups.rename(ADMIN, ORG, GROUP, "West"),
    ]);
    expect(refusals(results)).toEqual([
      expect.objectContaining({ code: "VALIDATION_FAILED", message: "This group changed meanwhile; reload and try again" }),
    ]);
    const renamed = await auditRows("group.renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.metadata).toEqual({ name: await nameOf(), previousName: "Sales" });
  });

  it("counts an addition that commits while the deletion waits for it", async () => {
    await seat(VIEWER);
    const results = await contend((tx) => tx.groupMember.create({
      data: { groupId: GROUP, organizationId: ORG, userId: CREATOR, addedByUserId: OWNER },
    }), [() => groups.delete(OWNER, ORG, GROUP)]);
    expect(refusals(results)).toEqual([]);
    expect(await memberIds()).toEqual([]);
    const [deleted] = await auditRows("group.deleted");
    expect(deleted?.metadata).toEqual({ name: "Sales", actorRole: "OWNER", removedMemberCount: 2, ungroupedPropertyCount: 0 });
  });

  it("does not count a member a concurrent removal took out first", async () => {
    await seat(CREATOR);
    await seat(VIEWER);
    const results = await contend(
      (tx) => tx.groupMember.deleteMany({ where: { groupId: GROUP, userId: CREATOR } }),
      [() => groups.delete(OWNER, ORG, GROUP)],
    );
    expect(refusals(results)).toEqual([]);
    const [deleted] = await auditRows("group.deleted");
    expect(deleted?.metadata).toEqual({ name: "Sales", actorRole: "OWNER", removedMemberCount: 1, ungroupedPropertyCount: 0 });
  });

  it("records the name a rename committed while the deletion waited for it", async () => {
    const results = await contend(
      (tx) => tx.group.update({ where: { id: GROUP }, data: { name: "Field" } }),
      [() => groups.delete(OWNER, ORG, GROUP)],
    );
    expect(refusals(results)).toEqual([]);
    expect(await nameOf()).toBeUndefined();
    const [deleted] = await auditRows("group.deleted");
    expect(deleted?.metadata).toEqual({ name: "Field", actorRole: "OWNER", removedMemberCount: 0, ungroupedPropertyCount: 0 });
  });

  it("refuses an addition waiting on a deletion of the group", async () => {
    const results = await contend(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "groups" WHERE "id" = ${GROUP} FOR UPDATE`;
        await tx.group.delete({ where: { id: GROUP } });
      },
      [() => groups.addMember(ADMIN, ORG, GROUP, CREATOR)],
    );
    expect(refusals(results)).toEqual([
      expect.objectContaining({ code: "NOT_FOUND", message: "The group or the member no longer exists" }),
    ]);
    expect(await prisma.groupMember.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await auditRows("group.member_added")).toEqual([]);
  });

  it("refuses an addition waiting on the member's removal from the organization", async () => {
    const results = await contend(
      (tx) => tx.membership.delete({ where: { organizationId_userId: { organizationId: ORG, userId: CREATOR } } }),
      [() => groups.addMember(ADMIN, ORG, GROUP, CREATOR)],
    );
    expect(refusals(results)).toEqual([
      expect.objectContaining({ code: "NOT_FOUND", message: "The group or the member no longer exists" }),
    ]);
    expect(await memberIds()).toEqual([]);
    expect(await auditRows("group.member_added")).toEqual([]);
  });
});
