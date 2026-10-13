import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipService, ROLES, type Role } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * The role templates and the role-assignment ceiling against PostgreSQL
 * (Phase 6C, ADR-0057): the migrated `Role` type, every template round-tripping
 * through the real repositories, and the ceiling's refusals and changes landing
 * as durable audit rows.
 */

const ORG_A = "org_itest_roles_a";
const ORG_B = "org_itest_roles_b";
const OWNER = "usr_itest_roles_owner";
const ADMIN = "usr_itest_roles_admin";
const CREATOR = "usr_itest_roles_creator";
const OTHER_ADMIN = "usr_itest_roles_other_admin";
const USERS = [OWNER, ADMIN, CREATOR, OTHER_ADMIN];

const prisma = new PrismaClient();
const clock = new TestClock();
const repos = createPrismaIdentityRepositories(prisma);
const members = new MembershipService(
  {
    repos,
    clock,
    ids: { generate: (p) => `${p}_itest_roles_${Math.random().toString(36).slice(2, 12)}` },
    passwords: fakePasswordHasher,
    tokens: fakeTokenService(),
  },
  { invitationTtlSeconds: 3600 },
);

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

async function roleIn(organizationId: string, userId: string): Promise<string | undefined> {
  return (await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } }))
    ?.role;
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
      { organizationId: ORG_B, userId: OTHER_ADMIN, role: "ADMIN" },
      { organizationId: ORG_B, userId: CREATOR, role: "CREATOR" },
    ],
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("the migrated Role type", () => {
  it("holds exactly the six templates, in order", async () => {
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      SELECT unnest(enum_range(NULL::"Role"))::text AS value`;
    expect(rows.map((row) => row.value)).toEqual([...ROLES]);
  });

  it("refuses REVIEWER at the database", async () => {
    await expect(
      prisma.$executeRaw`UPDATE "memberships" SET "role" = 'REVIEWER'::"Role"
        WHERE "organizationId" = ${ORG_A} AND "userId" = ${CREATOR}`,
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await roleIn(ORG_A, CREATOR)).toBe("CREATOR");
  });

  it.each([...ROLES])("round-trips %s through the real membership and invitation repositories", async (role) => {
    await prisma.membership.delete({ where: { organizationId_userId: { organizationId: ORG_A, userId: CREATOR } } });
    await repos.memberships.create({ organizationId: ORG_A, userId: CREATOR, role });
    expect((await repos.memberships.find(ORG_A, CREATOR))?.role).toBe(role);

    const { invitation } = await members.invite(OWNER, { organizationId: ORG_A, email: "new@example.com", role });
    expect((await repos.invitations.findByTokenHash(invitation.tokenHash))?.role).toBe(role);
  });
});

describe.skipIf(!HAS_DB)("the role-assignment ceiling, durably", () => {
  it("refuses an ADMIN promoting itself to OWNER and records the refusal", async () => {
    await expect(members.changeRole(ADMIN, ORG_A, ADMIN, "OWNER")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roleIn(ORG_A, ADMIN)).toBe("ADMIN");

    const audit = await prisma.auditLog.findMany({ where: { organizationId: ORG_A } });
    expect(audit.map((row) => row.action)).toEqual(["member.role_change_refused"]);
    expect(audit[0]).toMatchObject({
      actorUserId: ADMIN,
      resourceType: "membership",
      resourceId: `${ORG_A}:${ADMIN}`,
      metadata: {
        operation: "change_role",
        actorRole: "ADMIN",
        targetUserId: ADMIN,
        currentRole: "ADMIN",
        requestedRole: "OWNER",
      },
    });
  });

  it("lets an OWNER make a member BILLING, recording the fixed Scope", async () => {
    const changed = await members.changeRole(OWNER, ORG_A, CREATOR, "BILLING" satisfies Role);
    expect(changed.role).toBe("BILLING");
    expect(await roleIn(ORG_A, CREATOR)).toBe("BILLING");
    // The same user's membership in another organization is untouched.
    expect(await roleIn(ORG_B, CREATOR)).toBe("CREATOR");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG_A, action: "member.role_changed" },
    });
    expect(audit.metadata).toEqual({
      targetUserId: CREATOR,
      role: "BILLING",
      previousRole: "CREATOR",
      scope: "ORGANIZATION",
    });
  });

  it("refuses another organization's ADMIN without writing into this organization's audit trail", async () => {
    await expect(members.changeRole(OTHER_ADMIN, ORG_A, CREATOR, "VIEWER")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await roleIn(ORG_A, CREATOR)).toBe("CREATOR");
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});
