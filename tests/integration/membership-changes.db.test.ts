import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipService, type Invitation, type Role } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Membership changes against PostgreSQL (Phase 6E, ADR-0059): each change
 * commits with its audit row or not at all, writes nothing when what it was
 * checked against has changed, and never takes the last OWNER away, also when
 * two changes race.
 */

const ORG = "org_itest_members";
const OWNER = "usr_itest_members_owner";
const CO_OWNER = "usr_itest_members_co_owner";
const ADMIN = "usr_itest_members_admin";
const CREATOR = "usr_itest_members_creator";
const NEWCOMER = "usr_itest_members_newcomer";
const OTHER = "usr_itest_members_other";
const USERS = [OWNER, CO_OWNER, ADMIN, CREATOR, NEWCOMER, OTHER];
// An audit entry naming an organization that does not exist breaks its foreign
// key, so it cannot be written.
const UNWRITABLE = "org_itest_members_missing";
const LAST_OWNER = "Cannot remove or demote the last owner";

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
  ids: { generate: (p: string) => `${p}_itest_members_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const members = new MembershipService(deps, { invitationTtlSeconds: 3600 });

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  for (const id of USERS) await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: `slug-${ORG}` } });
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "OWNER" },
      { organizationId: ORG, userId: CO_OWNER, role: "OWNER" },
      { organizationId: ORG, userId: ADMIN, role: "ADMIN" },
      { organizationId: ORG, userId: CREATOR, role: "CREATOR" },
    ],
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
  resourceType: "membership",
  resourceId: `${ORG}:${CREATOR}`,
  metadata: {},
});

async function roleOf(userId: string): Promise<Role | undefined> {
  return (await deps.repos.memberships.find(ORG, userId))?.role;
}

function auditCount(): Promise<number> {
  return prisma.auditLog.count({ where: { organizationId: ORG } });
}

async function pendingInvitation(role: Role = "CREATOR"): Promise<Invitation> {
  const { invitation } = await members.invite(OWNER, { organizationId: ORG, email: "invitee@example.com", role });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  return invitation;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the contenders never all waited on the lock holder");
}

/**
 * Start `contenders` while another transaction holds the rows `lock` locks, and
 * release them only once every contender is waiting for a lock, on that
 * transaction or on a contender queued before it. Each contender has by then
 * read what it checks, and none has written: the interleaving a race needs,
 * made deterministic. (The suite's files run one at a time, so no other session
 * waits on a lock meanwhile.)
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

function lockMemberships(...userIds: string[]) {
  return (tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT 1 FROM "memberships"
      WHERE "organizationId" = ${ORG} AND "userId" IN (${Prisma.join(userIds)}) FOR UPDATE`;
}

function refusals(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}

describe.skipIf(!HAS_DB)("each membership change commits with its audit entry or not at all", () => {
  it("commits no invitation whose audit entry cannot be written", async () => {
    const invitation = {
      id: "inv_itest_members_unwritable",
      organizationId: ORG,
      email: "invitee@example.com",
      role: "CREATOR" as const,
      tokenHash: "hash:itest_members_unwritable",
      status: "PENDING" as const,
      invitedByUserId: OWNER,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      acceptedAt: null,
    };
    await expect(
      deps.repos.invitations.create(invitation, audit("invitation.created", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await prisma.invitation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("commits no acceptance whose audit entry cannot be written", async () => {
    const invitation = await pendingInvitation();
    await expect(
      deps.repos.invitations.accept(invitation, NEWCOMER, new Date(), audit("invitation.accepted", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await roleOf(NEWCOMER)).toBeUndefined();
    expect((await prisma.invitation.findUnique({ where: { id: invitation.id } }))?.status).toBe("PENDING");
  });

  it("commits no role change whose audit entry cannot be written", async () => {
    await expect(
      deps.repos.memberships.changeRole(ORG, CO_OWNER, "OWNER", "ADMIN", audit("member.role_changed", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await roleOf(CO_OWNER)).toBe("OWNER");
  });

  it("commits no removal whose audit entry cannot be written, keeping the member's grants", async () => {
    await prisma.permissionGrant.create({
      data: { organizationId: ORG, userId: CREATOR, permission: "audit.view", grantedByUserId: OWNER, grantedAt: new Date() },
    });
    await expect(
      deps.repos.memberships.remove(ORG, CREATOR, "CREATOR", () => audit("member.removed", UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await roleOf(CREATOR)).toBe("CREATOR");
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG, userId: CREATOR } })).toBe(1);
  });

  it("records invite, acceptance, role change and removal, each with its own audit row", async () => {
    const { invitation, token } = await members.invite(OWNER, {
      organizationId: ORG,
      email: "invitee@example.com",
      role: "VIEWER",
    });
    await members.acceptInvitation(NEWCOMER, token);
    await members.changeRole(OWNER, ORG, NEWCOMER, "MANAGER");
    await members.changeRole(OWNER, ORG, CO_OWNER, "ADMIN");
    await members.removeMember(OWNER, ORG, NEWCOMER);
    expect(await roleOf(NEWCOMER)).toBeUndefined();
    expect(await roleOf(CO_OWNER)).toBe("ADMIN");
    // Rows written within one millisecond tie on createdAt, so order is not asserted.
    const rows = await prisma.auditLog.findMany({ where: { organizationId: ORG } });
    const newcomer = `${ORG}:${NEWCOMER}`;
    const coOwner = `${ORG}:${CO_OWNER}`;
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => [r.action, r.actorUserId, r.resourceId, r.metadata])).toEqual(
      expect.arrayContaining([
        ["invitation.created", OWNER, invitation.id, { email: "invitee@example.com", role: "VIEWER" }],
        ["invitation.accepted", NEWCOMER, newcomer, { role: "VIEWER", scope: "OWN" }],
        ["member.role_changed", OWNER, newcomer, { targetUserId: NEWCOMER, role: "MANAGER", previousRole: "VIEWER", scope: "GROUP" }],
        ["member.role_changed", OWNER, coOwner, { targetUserId: CO_OWNER, role: "ADMIN", previousRole: "OWNER", scope: "ORGANIZATION" }],
        ["member.removed", OWNER, newcomer, { unassignedPropertyCount: 0 }],
      ]),
    );
  });
});

describe.skipIf(!HAS_DB)("a change checked against what is no longer true writes nothing", () => {
  it("does not change a member's role from one it no longer holds", async () => {
    expect(await deps.repos.memberships.changeRole(ORG, CREATOR, "MANAGER", "VIEWER", audit("x"))).toBe("STALE");
    expect(await roleOf(CREATOR)).toBe("CREATOR");
    expect(await auditCount()).toBe(0);
  });

  it("does not remove a member checked against a role it no longer holds", async () => {
    expect(await deps.repos.memberships.remove(ORG, CREATOR, "MANAGER", () => audit("x"))).toBe("STALE");
    expect(await roleOf(CREATOR)).toBe("CREATOR");
    expect(await auditCount()).toBe(0);
  });

  it("refuses to demote or remove the last OWNER", async () => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG, userId: CO_OWNER } } });
    expect(await deps.repos.memberships.changeRole(ORG, OWNER, "OWNER", "ADMIN", audit("x"))).toBe("LAST_OWNER");
    expect(await deps.repos.memberships.remove(ORG, OWNER, "OWNER", () => audit("x"))).toBe("LAST_OWNER");
    expect(await roleOf(OWNER)).toBe("OWNER");
    expect(await auditCount()).toBe(0);
  });

  it("answers STALE, not LAST_OWNER, for an OWNER change to a member who is no OWNER", async () => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG, userId: CO_OWNER } } });
    expect(await deps.repos.memberships.remove(ORG, ADMIN, "OWNER", () => audit("x"))).toBe("STALE");
    expect(await deps.repos.memberships.changeRole(ORG, ADMIN, "OWNER", "VIEWER", audit("x"))).toBe("STALE");
    expect(await roleOf(ADMIN)).toBe("ADMIN");
  });

  it("does not accept an invitation that is no longer pending", async () => {
    const invitation = await pendingInvitation();
    const first = await deps.repos.invitations.accept(invitation, NEWCOMER, new Date(), audit("invitation.accepted"));
    expect(first.outcome).toBe("ACCEPTED");
    const again = await deps.repos.invitations.accept(invitation, OTHER, new Date(), audit("invitation.accepted"));
    expect(again).toEqual({ outcome: "STALE" });
    expect(await roleOf(OTHER)).toBeUndefined();
    expect(await auditCount()).toBe(1);
  });

  it("does not accept an invitation for a user who is already a member, leaving it pending", async () => {
    const invitation = await pendingInvitation("VIEWER");
    expect(await deps.repos.invitations.accept(invitation, CREATOR, new Date(), audit("invitation.accepted"))).toEqual({
      outcome: "ALREADY_MEMBER",
    });
    expect(await roleOf(CREATOR)).toBe("CREATOR");
    expect((await prisma.invitation.findUnique({ where: { id: invitation.id } }))?.status).toBe("PENDING");
    expect(await auditCount()).toBe(0);
  });

  it("expires a pending invitation but never an accepted one", async () => {
    const accepted = await pendingInvitation();
    await deps.repos.invitations.accept(accepted, NEWCOMER, new Date(), audit("invitation.accepted"));
    await deps.repos.invitations.expire(accepted.id);
    expect((await prisma.invitation.findUnique({ where: { id: accepted.id } }))?.status).toBe("ACCEPTED");

    const { invitation: pending } = await members.invite(OWNER, { organizationId: ORG, email: "late@example.com", role: "VIEWER" });
    await deps.repos.invitations.expire(pending.id);
    expect((await prisma.invitation.findUnique({ where: { id: pending.id } }))?.status).toBe("EXPIRED");
  });
});

describe.skipIf(!HAS_DB)("membership changes racing each other", () => {
  it("lets exactly one of two OWNERs demoting each other at once succeed", async () => {
    const results = await contend(lockMemberships(OWNER, CO_OWNER), [
      () => members.changeRole(OWNER, ORG, CO_OWNER, "ADMIN"),
      () => members.changeRole(CO_OWNER, ORG, OWNER, "ADMIN"),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: LAST_OWNER })]);
    expect([await roleOf(OWNER), await roleOf(CO_OWNER)].sort()).toEqual(["ADMIN", "OWNER"]);
    expect(await auditCount()).toBe(1);
  });

  it("lets exactly one of two OWNERs removing each other at once succeed", async () => {
    const results = await contend(lockMemberships(OWNER, CO_OWNER), [
      () => members.removeMember(OWNER, ORG, CO_OWNER),
      () => members.removeMember(CO_OWNER, ORG, OWNER),
    ]);
    expect(refusals(results)).toEqual([expect.objectContaining({ code: "VALIDATION_FAILED", message: LAST_OWNER })]);
    expect(await prisma.membership.count({ where: { organizationId: ORG, role: "OWNER" } })).toBe(1);
    expect(await auditCount()).toBe(1);
  });

  it("makes one membership and one audit row of two acceptances of one invitation", async () => {
    const { invitation, token } = await members.invite(OWNER, {
      organizationId: ORG,
      email: "invitee@example.com",
      role: "CREATOR",
    });
    await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
    const results = await contend(
      (tx) => tx.$queryRaw`SELECT 1 FROM "invitations" WHERE "id" = ${invitation.id} FOR UPDATE`,
      [() => members.acceptInvitation(NEWCOMER, token), () => members.acceptInvitation(OTHER, token)],
    );
    expect(refusals(results)).toEqual([
      expect.objectContaining({ code: "NOT_FOUND", message: "Invitation is invalid or already used" }),
    ]);
    expect([await roleOf(NEWCOMER), await roleOf(OTHER)].filter(Boolean)).toEqual(["CREATOR"]);
    expect(await auditCount()).toBe(1);
  });
});
