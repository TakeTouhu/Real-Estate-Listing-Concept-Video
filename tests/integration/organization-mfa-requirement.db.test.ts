import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, OrganizationService, isMfaRequired, type Role } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * An organization's MFA requirement against PostgreSQL (MFA-4, ADR-0065
 * Decision 18): migration 26's column and default; the change committed with
 * its audit row or not at all; and refused, writing nothing, when the value or
 * the actor's role moved after it was read.
 */

const DOMAIN = "org-mfa.itest";
const ORG = "org_itest_org_mfa";
const CHANGED = "organization.mfa_requirement_changed";

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-03-01T00:00:00.000Z"));
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_org_mfa_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const organizations = new OrganizationService(deps);

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ id: ORG }, { id: { startsWith: "org_itest_org_mfa_" } }] },
    select: { id: true },
  });
  const orgIds = orgs.map((o) => o.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { organizationId: { in: orgIds } }] } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function user(name: string): Promise<string> {
  return (await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" })).id;
}

async function organizationWith(roles: Partial<Record<Role, string>>): Promise<void> {
  await deps.repos.organizations.create({ id: ORG, name: "Org", slug: "org-itest-org-mfa", status: "ACTIVE" });
  for (const [role, userId] of Object.entries(roles) as [Role, string][]) {
    await deps.repos.memberships.create({ organizationId: ORG, userId, role });
  }
}

async function required(): Promise<boolean | undefined> {
  return (await prisma.organization.findUnique({ where: { id: ORG } }))?.mfaRequired;
}

function changedRows() {
  return prisma.auditLog.findMany({ where: { organizationId: ORG, action: CHANGED } });
}

const audit = (actorUserId: string, organizationId = ORG) => ({
  organizationId,
  actorUserId,
  action: CHANGED,
  resourceType: "organization",
  resourceId: ORG,
  metadata: { required: true },
});

describe("migration 26", () => {
  it("adds organizations.mfaRequired: NOT NULL, false by default", async () => {
    const owner = await user("owner");
    await organizationWith({ OWNER: owner });
    expect(await required()).toBe(false);
    expect((await deps.repos.organizations.findById(ORG))?.mfaRequired).toBe(false);
    const [column] = await prisma.$queryRaw<{ data_type: string; is_nullable: string; column_default: string }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'organizations' AND column_name = 'mfaRequired'`;
    expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
  });
});

describe("setMfaRequired", () => {
  it("writes the change and its audit row together", async () => {
    const owner = await user("owner");
    await organizationWith({ OWNER: owner });
    const outcome = await deps.repos.organizations.setMfaRequired({
      organizationId: ORG,
      actorUserId: owner,
      expected: false,
      required: true,
      audit: audit(owner),
    });
    expect(outcome).toBe("APPLIED");
    expect(await required()).toBe(true);
    expect(await changedRows()).toHaveLength(1);
  });

  it("writes neither when the audit row cannot be written", async () => {
    const owner = await user("owner");
    await organizationWith({ OWNER: owner });
    await expect(
      deps.repos.organizations.setMfaRequired({
        organizationId: ORG,
        actorUserId: owner,
        expected: false,
        required: true,
        audit: audit(owner, "org_itest_org_mfa_missing"),
      }),
    ).rejects.toThrow();
    expect(await required()).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: CHANGED, actorUserId: owner } })).toBe(0);
  });

  it("is STALE, writing nothing, when the value is not the one read", async () => {
    const owner = await user("owner");
    await organizationWith({ OWNER: owner });
    const outcome = await deps.repos.organizations.setMfaRequired({
      organizationId: ORG,
      actorUserId: owner,
      expected: true,
      required: false,
      audit: audit(owner),
    });
    expect(outcome).toBe("STALE");
    expect(await required()).toBe(false);
    expect(await changedRows()).toHaveLength(0);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "is STALE, writing nothing, when the actor is now a %s",
    async (role) => {
      const owner = await user("owner");
      const actor = await user("actor");
      await organizationWith({ OWNER: owner, [role]: actor });
      const outcome = await deps.repos.organizations.setMfaRequired({
        organizationId: ORG,
        actorUserId: actor,
        expected: false,
        required: true,
        audit: audit(actor),
      });
      expect(outcome).toBe("STALE");
      expect(await required()).toBe(false);
      expect(await changedRows()).toHaveLength(0);
    },
  );

  it("is STALE for an actor who is no longer a member", async () => {
    const owner = await user("owner");
    const outsider = await user("outsider");
    await organizationWith({ OWNER: owner });
    const outcome = await deps.repos.organizations.setMfaRequired({
      organizationId: ORG,
      actorUserId: outsider,
      expected: false,
      required: true,
      audit: audit(outsider),
    });
    expect(outcome).toBe("STALE");
    expect(await required()).toBe(false);
  });

  it("applies exactly one of two changes made at once from the same value", async () => {
    const owner = await user("owner");
    const admin = await user("admin");
    await organizationWith({ OWNER: owner, ADMIN: admin });
    for (const value of [true, false]) {
      const outcomes = await Promise.all(
        [owner, admin].map((actorUserId) =>
          deps.repos.organizations.setMfaRequired({
            organizationId: ORG,
            actorUserId,
            expected: !value,
            required: value,
            audit: audit(actorUserId),
          }),
        ),
      );
      expect(outcomes.sort()).toEqual(["APPLIED", "STALE"]);
      expect(await required()).toBe(value);
    }
    expect(await changedRows()).toHaveLength(2);
  });

  it("waits for a demotion of its actor in flight, then sees it and writes nothing", async () => {
    const owner = await user("owner");
    const admin = await user("admin");
    await organizationWith({ OWNER: owner, ADMIN: admin });
    let settled = false;
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.membership.updateMany({ where: { organizationId: ORG, userId: admin }, data: { role: "MANAGER" } });
      const pending = deps.repos.organizations
        .setMfaRequired({ organizationId: ORG, actorUserId: admin, expected: false, required: true, audit: audit(admin) })
        .finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      return { pending };
    });
    expect(await outcome.pending).toBe("STALE");
    expect(await required()).toBe(false);
    expect(await changedRows()).toHaveLength(0);
  });
});

describe("through the service and the real repositories", () => {
  it("lets an ADMIN require MFA of everyone, which then applies to every member", async () => {
    const owner = await user("owner");
    const admin = await user("admin");
    const viewer = await user("viewer");
    await organizationWith({ OWNER: owner, ADMIN: admin, VIEWER: viewer });
    expect(await isMfaRequired(deps, viewer)).toBe(false);
    const result = await organizations.setMfaRequirement(admin, ORG, true);
    expect(result).toMatchObject({ changed: true, organization: { mfaRequired: true } });
    expect(await isMfaRequired(deps, viewer)).toBe(true);
    const [row] = await changedRows();
    expect(row).toMatchObject({ actorUserId: admin, resourceType: "organization", resourceId: ORG });
    expect(row?.metadata).toEqual({ actorRole: "ADMIN", required: true });
  });

  it("refuses a MANAGER and audits the refusal, changing nothing", async () => {
    const owner = await user("owner");
    const manager = await user("manager");
    await organizationWith({ OWNER: owner, MANAGER: manager });
    await expect(organizations.setMfaRequirement(manager, ORG, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await required()).toBe(false);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: "organization.mfa_requirement_refused" } }),
    ).toBe(1);
    expect(await changedRows()).toHaveLength(0);
  });

  it("creates an organization that requires no MFA of its members", async () => {
    const owner = await user("owner");
    const { organization } = await organizations.createOrganization(owner, { name: "Fresh" });
    expect(organization.mfaRequired).toBe(false);
    expect((await prisma.organization.findUnique({ where: { id: organization.id } }))?.mfaRequired).toBe(false);
  });
});
