import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authorizeOrganization, GroupService, type GroupCeilingRefusal, type Permission } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Group permissions against PostgreSQL (Phase 6G, ADR-0061): the table's
 * constraints and cascade, organization scoping, each change committed with
 * its audit row or not at all, what a member holds through its groups, and each
 * ceiling check judged on the group as the change commits.
 */

const ORG = "org_itest_gperm";
const OTHER_ORG = "org_itest_gperm_other";
const OWNER = "usr_itest_gperm_owner";
const ADMIN = "usr_itest_gperm_admin";
const MANAGER = "usr_itest_gperm_manager";
const VIEWER = "usr_itest_gperm_viewer";
const USERS = [OWNER, ADMIN, MANAGER, VIEWER];
// An audit entry naming an organization that does not exist breaks its foreign
// key, so it cannot be written.
const UNWRITABLE = "org_itest_gperm_missing";
const GROUP = "grp_itest_gperm_sales";
const SECOND_GROUP = "grp_itest_gperm_support";
const OTHER_GROUP = "grp_itest_gperm_elsewhere";

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
  ids: { generate: (p: string) => `${p}_itest_gperm_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const groups = new GroupService(deps);

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
      { organizationId: ORG, userId: VIEWER, role: "VIEWER" },
      { organizationId: OTHER_ORG, userId: OWNER, role: "OWNER" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: GROUP, organizationId: ORG, name: "Sales", createdByUserId: OWNER },
      { id: SECOND_GROUP, organizationId: ORG, name: "Support", createdByUserId: OWNER },
      { id: OTHER_GROUP, organizationId: OTHER_ORG, name: "Sales", createdByUserId: OWNER },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

const admit = () => null;
const refuse = (): GroupCeilingRefusal => ({ reason: "protected", permission: "billing.manage" });

const audit = (action: string, organizationId = ORG) => ({
  organizationId,
  actorUserId: OWNER,
  action,
  resourceType: "group",
  resourceId: GROUP,
  metadata: {},
});

function give(permission: Permission, groupId = GROUP, client: Prisma.TransactionClient = prisma) {
  return client.groupPermission.create({ data: { groupId, organizationId: ORG, permission, grantedByUserId: OWNER } });
}

function seat(userId: string, groupId = GROUP) {
  return prisma.groupMember.create({ data: { groupId, organizationId: ORG, userId, addedByUserId: OWNER } });
}

async function carried(groupId = GROUP): Promise<string[]> {
  return (await prisma.groupPermission.findMany({ where: { groupId }, orderBy: { permission: "asc" } })).map(
    (p) => p.permission,
  );
}

async function memberIds(groupId = GROUP): Promise<string[]> {
  return (await prisma.groupMember.findMany({ where: { groupId }, orderBy: { userId: "asc" } })).map((m) => m.userId);
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
 * for a lock, on it or on a contender queued before it: the interleaving a
 * race needs, made deterministic. (The suite's files run one at a time, so no
 * other session waits on a lock meanwhile.)
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

/** A change to the group's permissions in flight: the group locked as the repository locks it. */
function permissionChange(change: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  return async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT 1 FROM "groups" WHERE "id" = ${GROUP} FOR UPDATE`;
    await change(tx);
  };
}

/** An addition in flight: the group share-locked as the repository locks it. */
function addition(userId: string) {
  return async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT 1 FROM "groups" WHERE "id" = ${GROUP} FOR SHARE`;
    await tx.groupMember.create({ data: { groupId: GROUP, organizationId: ORG, userId, addedByUserId: OWNER } });
  };
}

function settledAs(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));
}

describe.skipIf(!HAS_DB)("the table holds only what a group may carry", () => {
  it.each(["disclosure.none", "video.share", "group.everything"])("refuses the stored permission %j", async (permission) => {
    await expect(
      prisma.$executeRaw`INSERT INTO "group_permissions" ("groupId", "organizationId", "permission", "grantedByUserId")
        VALUES (${GROUP}, ${ORG}, ${permission}, ${OWNER})`,
    ).rejects.toThrow(/group_permissions_permission_check/);
  });

  it("never links a group of one organization to another organization's permission row", async () => {
    await expect(
      prisma.groupPermission.create({
        data: { groupId: OTHER_GROUP, organizationId: ORG, permission: "audit.view", grantedByUserId: OWNER },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("removes a group's permissions with the group", async () => {
    await give("audit.view");
    await give("audit.view", SECOND_GROUP);
    await prisma.group.delete({ where: { id: GROUP } });
    expect([await carried(), await carried(SECOND_GROUP)]).toEqual([[], ["audit.view"]]);
  });
});

describe.skipIf(!HAS_DB)("what a member holds through its groups", () => {
  it("adds each of its groups' permissions once, within its own organization only", async () => {
    await give("audit.view");
    await give("audit.view", SECOND_GROUP);
    await give("unit.view", SECOND_GROUP);
    await seat(VIEWER);
    await seat(VIEWER, SECOND_GROUP);
    expect((await deps.repos.groups.listPermissionsForMember(ORG, VIEWER)).sort()).toEqual(["audit.view", "unit.view"]);
    expect(await deps.repos.groups.listPermissionsForMember(OTHER_ORG, VIEWER)).toEqual([]);
    expect(await deps.repos.groups.listPermissionsForMember(ORG, MANAGER)).toEqual([]);
    const { permissions } = await authorizeOrganization(deps, VIEWER, ORG, ["audit.view", "unit.view"]);
    expect(permissions).toEqual(expect.arrayContaining(["audit.view", "unit.view", "video.view"]));
  });

  it("never makes property.create effective for a VIEWER member", async () => {
    await give("property.create");
    await give("property.edit");
    await seat(VIEWER);
    const { permissions } = await authorizeOrganization(deps, VIEWER, ORG);
    expect(permissions).toContain("property.edit");
    expect(permissions).not.toContain("property.create");
  });
});

describe.skipIf(!HAS_DB)("every read and write is scoped by organization", () => {
  it("gives, takes and lists nothing of another organization's group", async () => {
    await give("audit.view");
    const input = { groupId: GROUP, organizationId: OTHER_ORG, permission: "unit.view" as const, grantedByUserId: OWNER };
    expect(await deps.repos.groups.grantPermission(input, admit, () => audit("x", OTHER_ORG))).toEqual({ outcome: "STALE" });
    expect(
      await deps.repos.groups.revokePermission(OTHER_ORG, GROUP, "audit.view", admit, () => audit("x", OTHER_ORG)),
    ).toEqual({ outcome: "STALE" });
    expect(await deps.repos.groups.listPermissions(OTHER_ORG, GROUP)).toEqual([]);
    expect(await carried()).toEqual(["audit.view"]);
    await expect(groups.grantPermission(OWNER, ORG, OTHER_GROUP, "audit.view")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.auditLog.count({ where: { organizationId: { in: [ORG, OTHER_ORG] } } })).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("each change commits with its audit entry or not at all", () => {
  const input = { groupId: GROUP, organizationId: ORG, permission: "audit.view" as const, grantedByUserId: OWNER };

  it("commits no permission whose audit entry cannot be written", async () => {
    await expect(
      deps.repos.groups.grantPermission(input, admit, () => audit("group.permission_granted", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await carried()).toEqual([]);
  });

  it("commits no revocation whose audit entry cannot be written", async () => {
    await give("audit.view");
    await expect(
      deps.repos.groups.revokePermission(ORG, GROUP, "audit.view", admit, () => audit("group.permission_revoked", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await carried()).toEqual(["audit.view"]);
  });

  it("records a grant and a revocation with the members each reached", async () => {
    await seat(MANAGER);
    await seat(VIEWER);
    await groups.grantPermission(ADMIN, ORG, GROUP, "audit.view");
    await groups.revokePermission(OWNER, ORG, GROUP, "audit.view");
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actorUserId, r.resourceType, r.resourceId, r.metadata])).toEqual(
      expect.arrayContaining([
        ["group.permission_granted", ADMIN, "group", GROUP, { permission: "audit.view", memberCount: 2 }],
        ["group.permission_revoked", OWNER, "group", GROUP, { permission: "audit.view", memberCount: 2 }],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("writes nothing for a permission already carried, or not carried", async () => {
    await give("audit.view");
    expect(await deps.repos.groups.grantPermission(input, admit, () => audit("x"))).toEqual({ outcome: "ALREADY_GRANTED" });
    expect(await deps.repos.groups.revokePermission(ORG, GROUP, "unit.view", admit, () => audit("x"))).toEqual({
      outcome: "NOT_GRANTED",
    });
    expect(await auditRows()).toEqual([]);
  });

  it("writes nothing for a change its check refuses", async () => {
    await give("unit.view");
    await seat(MANAGER);
    const member = { groupId: GROUP, organizationId: ORG, userId: VIEWER, addedByUserId: OWNER };
    const refused = { outcome: "REFUSED", refusal: refuse() };
    expect(await deps.repos.groups.grantPermission(input, refuse, () => audit("x"))).toEqual(refused);
    expect(await deps.repos.groups.revokePermission(ORG, GROUP, "unit.view", refuse, () => audit("x"))).toEqual(refused);
    expect(await deps.repos.groups.addMember(member, refuse, audit("x"))).toEqual(refused);
    expect(await deps.repos.groups.removeMember(ORG, GROUP, MANAGER, refuse, audit("x"))).toEqual(refused);
    expect(await deps.repos.groups.delete(ORG, GROUP, refuse, () => audit("x"))).toEqual(refused);
    expect([await carried(), await memberIds()]).toEqual([["unit.view"], [MANAGER]]);
    expect(await auditRows()).toEqual([]);
  });

  it("shows each check the group's members with their roles, and its permissions", async () => {
    await give("unit.view");
    await give("audit.view");
    await seat(VIEWER);
    await seat(MANAGER);
    const seen: unknown[] = [];
    const look = (locked: unknown) => (seen.push(locked), refuse());
    await deps.repos.groups.grantPermission(input, look, () => audit("x"));
    await deps.repos.groups.addMember({ groupId: GROUP, organizationId: ORG, userId: OWNER, addedByUserId: OWNER }, look, audit("x"));
    await deps.repos.groups.delete(ORG, GROUP, look, () => audit("x"));
    const locked = expect.objectContaining({
      members: [
        { userId: MANAGER, role: "MANAGER" },
        { userId: VIEWER, role: "VIEWER" },
      ],
      permissions: expect.arrayContaining(["audit.view", "unit.view"]),
    });
    expect(seen).toEqual([locked, locked, locked]);
  });
});

describe.skipIf(!HAS_DB)("each check is judged on the group as the change commits", () => {
  it("refuses an ADMIN's addition waiting on an OWNER giving the group billing.manage", async () => {
    const results = await contend(permissionChange((tx) => give("billing.manage", GROUP, tx)), [
      () => groups.addMember(ADMIN, ORG, GROUP, VIEWER),
    ]);
    expect(settledAs(results)).toEqual([expect.objectContaining({ code: "FORBIDDEN" })]);
    expect(await memberIds()).toEqual([]);
    const [refused] = await auditRows("group.change_refused");
    expect(refused?.metadata).toMatchObject({ operation: "add_member", reason: "protected", permission: "billing.manage" });
  });

  it("lets an ADMIN's removal waiting on an OWNER taking billing.manage away through", async () => {
    await give("billing.manage");
    await seat(VIEWER);
    const results = await contend(
      permissionChange((tx) => tx.groupPermission.deleteMany({ where: { groupId: GROUP, permission: "billing.manage" } })),
      [() => groups.removeMember(ADMIN, ORG, GROUP, VIEWER)],
    );
    expect(settledAs(results)).toEqual([undefined]);
    expect(await memberIds()).toEqual([]);
    expect(await auditRows("group.member_removed")).toHaveLength(1);
  });

  it("refuses an ADMIN's grant waiting on the addition of a member it may not manage", async () => {
    const results = await contend(addition(OWNER), [() => groups.grantPermission(ADMIN, ORG, GROUP, "video.generate")]);
    expect(settledAs(results)).toEqual([expect.objectContaining({ code: "FORBIDDEN" })]);
    expect(await carried()).toEqual([]);
    const [refused] = await auditRows("group.change_refused");
    expect(refused?.metadata).toMatchObject({ reason: "target_role", targetUserId: OWNER, targetRole: "OWNER" });
  });

  it("refuses an ADMIN's deletion waiting on the addition of a member it may not manage", async () => {
    await give("video.view");
    const results = await contend(addition(OWNER), [() => groups.delete(ADMIN, ORG, GROUP)]);
    expect(settledAs(results)).toEqual([expect.objectContaining({ code: "FORBIDDEN" })]);
    expect([await carried(), await memberIds()]).toEqual([["video.view"], [OWNER]]);
    expect(await auditRows("group.deleted")).toEqual([]);
  });

  it("refuses an ADMIN's deletion waiting on an OWNER giving the group billing.manage", async () => {
    const results = await contend(permissionChange((tx) => give("billing.manage", GROUP, tx)), [
      () => groups.delete(ADMIN, ORG, GROUP),
    ]);
    expect(settledAs(results)).toEqual([expect.objectContaining({ code: "FORBIDDEN" })]);
    expect(await carried()).toEqual(["billing.manage"]);
    const [refused] = await auditRows("group.change_refused");
    expect(refused?.metadata).toMatchObject({ operation: "delete", reason: "protected", permission: "billing.manage" });
  });

  it("gives a permission once, with one audit row, when two grants race", async () => {
    const results = await contend(permissionChange(() => Promise.resolve()), [
      () => groups.grantPermission(OWNER, ORG, GROUP, "audit.view"),
      () => groups.grantPermission(ADMIN, ORG, GROUP, "audit.view"),
    ]);
    expect(settledAs(results)).toEqual(expect.arrayContaining([{ granted: true }, { granted: false }]));
    expect(await carried()).toEqual(["audit.view"]);
    expect(await auditRows("group.permission_granted")).toHaveLength(1);
  });
});
