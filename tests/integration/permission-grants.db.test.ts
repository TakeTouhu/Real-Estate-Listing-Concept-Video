import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipService, PermissionGrantService, authorizeOrganization } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Individual permission grants against PostgreSQL (Phase 6D, ADR-0058): the
 * table's CHECK and cascade, grants reaching authorization through the real
 * repositories, each grant change committed together with its audit row, and
 * concurrent grants and revocations each audited exactly once.
 */

const ORG_A = "org_itest_grants_a";
const ORG_B = "org_itest_grants_b";
const OWNER = "usr_itest_grants_owner";
const ADMIN = "usr_itest_grants_admin";
const CREATOR = "usr_itest_grants_creator";
const USERS = [OWNER, ADMIN, CREATOR];

const prisma = new PrismaClient();
const clock = new TestClock();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_grants_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const grants = new PermissionGrantService(deps);
const members = new MembershipService(deps, { invitationTtlSeconds: 3600 });

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

async function holds(userId: string, permission: "billing.manage" | "audit.view", organizationId = ORG_A) {
  return authorizeOrganization(deps, userId, organizationId, permission).then(
    () => true,
    () => false,
  );
}

function rawGrant(permission: string, userId = CREATOR) {
  return prisma.$executeRaw`INSERT INTO "member_permission_grants"
    ("organizationId", "userId", "permission", "grantedByUserId", "grantedAt")
    VALUES (${ORG_A}, ${userId}, ${permission}, ${OWNER}, now())`;
}

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  for (const id of USERS) {
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
  }
  for (const id of [ORG_A, ORG_B]) {
    await prisma.organization.create({ data: { id, name: id, slug: `slug-${id}` } });
  }
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG_A, userId: OWNER, role: "OWNER" },
      { organizationId: ORG_A, userId: ADMIN, role: "ADMIN" },
      { organizationId: ORG_A, userId: CREATOR, role: "CREATOR" },
      { organizationId: ORG_B, userId: CREATOR, role: "CREATOR" },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("the member_permission_grants table", () => {
  it("admits a grantable permission and refuses video.share or an unknown name", async () => {
    await rawGrant("audit.view");
    await expect(rawGrant("video.share")).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(rawGrant("billing:manage")).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it("refuses a grant to someone who is not a member of that organization", async () => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG_A, userId: CREATOR } } });
    await expect(rawGrant("audit.view")).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("removes a member's grants with the membership, in that organization only", async () => {
    await grants.grant(OWNER, ORG_A, CREATOR, "audit.view");
    await prisma.$executeRaw`INSERT INTO "member_permission_grants"
      ("organizationId", "userId", "permission", "grantedByUserId", "grantedAt")
      VALUES (${ORG_B}, ${CREATOR}, 'audit.view', ${OWNER}, now())`;

    await members.removeMember(OWNER, ORG_A, CREATOR);
    expect(await prisma.permissionGrant.findMany({ where: { userId: CREATOR } })).toEqual([
      expect.objectContaining({ organizationId: ORG_B, permission: "audit.view" }),
    ]);
  });
});

describe.skipIf(!HAS_DB)("the grant repository", () => {
  const input = (userId = CREATOR) => ({
    organizationId: ORG_A,
    userId,
    permission: "audit.view" as const,
    grantedByUserId: ADMIN,
    grantedAt: new Date("2026-10-13T00:00:00.000Z"),
  });
  // An audit entry naming an organization that does not exist breaks its
  // foreign key, so it cannot be written.
  const audit = (organizationId = ORG_A) => ({
    organizationId,
    actorUserId: ADMIN,
    action: "permission.granted",
    resourceType: "membership",
    resourceId: `${ORG_A}:${CREATOR}`,
    metadata: { permission: "audit.view" },
  });
  const UNWRITABLE = "org_itest_grants_missing";

  it("answers a grant that already exists as not created, returning the stored one and writing nothing", async () => {
    await rawGrant("audit.view");
    const { grant, created } = await deps.repos.permissionGrants.insertIfAbsent(input(), audit());
    expect(created).toBe(false);
    expect(grant.grantedByUserId).toBe(OWNER);
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it("surfaces any other failure instead of answering it as a replay", async () => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG_A, userId: CREATOR } } });
    await expect(deps.repos.permissionGrants.insertIfAbsent(input(), audit())).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("commits no grant whose audit entry cannot be written", async () => {
    await expect(deps.repos.permissionGrants.insertIfAbsent(input(), audit(UNWRITABLE))).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it("keeps a grant whose revocation's audit entry cannot be written", async () => {
    await rawGrant("audit.view");
    await expect(
      deps.repos.permissionGrants.remove(ORG_A, CREATOR, "audit.view", audit(UNWRITABLE)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it("writes nothing when there is no grant to remove", async () => {
    expect(await deps.repos.permissionGrants.remove(ORG_A, CREATOR, "audit.view", audit())).toBe(false);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("grants through the real repositories", () => {
  it("lets an OWNER give an ADMIN billing.manage, which authorization then honours, durably audited", async () => {
    expect(await holds(ADMIN, "billing.manage")).toBe(false);
    await grants.grant(OWNER, ORG_A, ADMIN, "billing.manage");
    expect(await holds(ADMIN, "billing.manage")).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { organizationId: ORG_A } });
    expect(audit).toEqual([
      expect.objectContaining({
        action: "permission.granted",
        actorUserId: OWNER,
        resourceId: `${ORG_A}:${ADMIN}`,
        metadata: { targetUserId: ADMIN, targetRole: "ADMIN", permission: "billing.manage" },
      }),
    ]);
  });

  it("never carries a grant into another organization the member belongs to", async () => {
    await grants.grant(OWNER, ORG_A, CREATOR, "audit.view");
    expect(await holds(CREATOR, "audit.view")).toBe(true);
    expect(await holds(CREATOR, "audit.view", ORG_B)).toBe(false);
  });

  it("revokes only the permission named, leaving the member's other grants", async () => {
    await grants.grant(OWNER, ORG_A, CREATOR, "audit.view");
    await grants.grant(OWNER, ORG_A, CREATOR, "audit.export");
    await grants.revoke(OWNER, ORG_A, CREATOR, "audit.view");
    expect((await deps.repos.permissionGrants.listForMember(ORG_A, CREATOR)).map((g) => g.permission)).toEqual([
      "audit.export",
    ]);
  });

  it("refuses an ADMIN granting itself billing.manage and records the refusal", async () => {
    await expect(grants.grant(ADMIN, ORG_A, ADMIN, "billing.manage")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A } })).toBe(0);
    const audit = await prisma.auditLog.findMany({ where: { organizationId: ORG_A } });
    expect(audit.map((row) => row.action)).toEqual(["permission.grant_refused"]);
    expect(audit[0]!.metadata).toMatchObject({ reason: "target_role", actorRole: "ADMIN", targetRole: "ADMIN" });
  });

  it("answers concurrent identical grants with one row and one audit entry", async () => {
    const results = await Promise.all([
      grants.grant(OWNER, ORG_A, CREATOR, "audit.view"),
      grants.grant(ADMIN, ORG_A, CREATOR, "audit.view"),
      grants.grant(OWNER, ORG_A, CREATOR, "audit.view"),
    ]);
    expect(new Set(results.map((grant) => grant.grantedByUserId)).size).toBe(1);
    expect(await prisma.permissionGrant.count({ where: { organizationId: ORG_A, userId: CREATOR } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: "permission.granted" } })).toBe(1);
  });

  it("lets only one of concurrent revocations succeed, audited once", async () => {
    await grants.grant(OWNER, ORG_A, CREATOR, "audit.view");
    const outcomes = await Promise.allSettled([
      grants.revoke(OWNER, ORG_A, CREATOR, "audit.view"),
      grants.revoke(ADMIN, ORG_A, CREATOR, "audit.view"),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "NOT_FOUND" }),
    });
    expect(await holds(CREATOR, "audit.view")).toBe(false);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: "permission.revoked" } })).toBe(1);
  });
});
