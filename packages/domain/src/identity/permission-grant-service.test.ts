import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { MembershipService } from "./membership-service";
import { PermissionGrantService } from "./permission-grant-service";
import { authorizeOrganization } from "./authorization";
import { PROTECTED_PERMISSIONS, ROLES, type Permission, type Role } from "./roles";
import type { AuditLog } from "./types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

/**
 * Individual permission grants under the grant ceiling (ADR-0052 Decision 10,
 * Phase 6D): who may grant or revoke what, the audit trail, and how grants reach
 * every permission check.
 */

const PASSWORD = "password-123456";

interface Fixture {
  readonly deps: TestDeps;
  readonly auth: AuthService;
  readonly grants: PermissionGrantService;
  readonly members: MembershipService;
  readonly orgId: string;
  readonly otherOrgId: string;
  readonly ownerId: string;
  /** One member per template besides the founding OWNER. */
  readonly ids: Readonly<Record<Role, string>>;
  readonly outsiderId: string;
}

let fx: Fixture;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  const { organization } = await organizations.createOrganization(owner.id, { name: "Org" });
  const other = await organizations.createOrganization(owner.id, { name: "Other" });
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await auth.register({ email: `member-${role.toLowerCase()}@example.com`, name: role, password: PASSWORD });
    await deps.repos.memberships.create({ organizationId: organization.id, userId: user.id, role });
    ids[role] = user.id;
  }
  const outsider = await auth.register({ email: "outsider@example.com", name: "Out", password: PASSWORD });
  fx = {
    deps,
    auth,
    grants: new PermissionGrantService(deps),
    members: new MembershipService(deps, { invitationTtlSeconds: 3600 }),
    orgId: organization.id,
    otherOrgId: other.organization.id,
    ownerId: owner.id,
    ids,
    outsiderId: outsider.id,
  };
});

function audits(action: string): AuditLog[] {
  return fx.deps.repos.auditLogs.all().filter((entry) => entry.action === action);
}

async function holds(userId: string, permission: Permission, organizationId = fx.orgId): Promise<boolean> {
  return authorizeOrganization(fx.deps, userId, organizationId, permission).then(
    () => true,
    () => false,
  );
}

async function grantsOf(userId: string): Promise<Permission[]> {
  return (await fx.deps.repos.permissionGrants.listForMember(fx.orgId, userId)).map((g) => g.permission);
}

describe("grant", () => {
  it("lets an OWNER give an ADMIN billing.manage, which every check then honours", async () => {
    expect(await holds(fx.ids.ADMIN, "billing.manage")).toBe(false);
    const grant = await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.ADMIN, "billing.manage");

    expect(grant).toMatchObject({ userId: fx.ids.ADMIN, permission: "billing.manage", grantedByUserId: fx.ownerId });
    expect(await holds(fx.ids.ADMIN, "billing.manage")).toBe(true);
    expect(audits("permission.granted")).toEqual([
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId: fx.ownerId,
        resourceType: "membership",
        resourceId: `${fx.orgId}:${fx.ids.ADMIN}`,
        metadata: { targetUserId: fx.ids.ADMIN, targetRole: "ADMIN", permission: "billing.manage" },
      }),
    ]);
  });

  it("lets an OWNER grant disclosure.none to themselves, which no template carries", async () => {
    expect(await holds(fx.ownerId, "disclosure.none")).toBe(false);
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ownerId, "disclosure.none");
    expect(await holds(fx.ownerId, "disclosure.none")).toBe(true);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER"] as const)(
    "lets an ADMIN give a %s a permission it holds itself",
    async (role) => {
      await fx.grants.grant(fx.ids.ADMIN, fx.orgId, fx.ids[role], "audit.view");
      expect(await holds(fx.ids[role], "audit.view")).toBe(true);
    },
  );

  it.each([...PROTECTED_PERMISSIONS])("refuses and audits an ADMIN granting %s", async (permission) => {
    await expect(fx.grants.grant(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, permission)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await grantsOf(fx.ids.CREATOR)).toEqual([]);
    expect(audits("permission.grant_refused")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ids.ADMIN,
        resourceId: `${fx.orgId}:${fx.ids.CREATOR}`,
        metadata: {
          operation: "grant",
          reason: "protected",
          actorRole: "ADMIN",
          targetUserId: fx.ids.CREATOR,
          targetRole: "CREATOR",
          permission,
        },
      }),
    ]);
  });

  it("refuses an ADMIN granting to itself, so it cannot climb past its ceiling", async () => {
    await expect(fx.grants.grant(fx.ids.ADMIN, fx.orgId, fx.ids.ADMIN, "billing.manage")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await holds(fx.ids.ADMIN, "billing.manage")).toBe(false);
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ reason: "target_role", targetRole: "ADMIN" });
  });

  it.each(["OWNER", "BILLING"] as const)("refuses an ADMIN granting anything to an %s", async (role) => {
    await expect(fx.grants.grant(fx.ids.ADMIN, fx.orgId, fx.ids[role], "audit.view")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ reason: "target_role", targetRole: role });
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses and audits a %s, which does not hold permission.manage, before reading the target",
    async (role) => {
      await expect(fx.grants.grant(fx.ids[role], fx.orgId, fx.ids.VIEWER, "audit.view")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(await grantsOf(fx.ids.VIEWER)).toEqual([]);
      expect(audits("permission.grant_refused")[0]!.metadata).toEqual({
        operation: "grant",
        reason: "lacks_permission_manage",
        actorRole: role,
        targetUserId: fx.ids.VIEWER,
        targetRole: null,
        permission: "audit.view",
      });
    },
  );

  it("gives a MANAGER granted permission.manage no one to grant to", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.MANAGER, "permission.manage");
    await expect(fx.grants.grant(fx.ids.MANAGER, fx.orgId, fx.ids.VIEWER, "video.generate")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ reason: "target_role" });
  });

  it("refuses video.share to everyone, an OWNER included", async () => {
    await expect(fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "video.share")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ reason: "not_grantable" });
  });

  it.each(["VIEWER", "BILLING"] as const)("refuses property.create to a %s, an OWNER included", async (role) => {
    await expect(fx.grants.grant(fx.ownerId, fx.orgId, fx.ids[role], "property.create")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await grantsOf(fx.ids[role])).toEqual([]);
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ reason: "recipient_ceiling" });
  });

  it("changes nothing, and audits nothing more, when the grant already exists", async () => {
    const first = await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.VIEWER, "audit.view");
    fx.deps.clock.advanceSeconds(60);
    const again = await fx.grants.grant(fx.ids.ADMIN, fx.orgId, fx.ids.VIEWER, "audit.view");
    expect(again).toEqual(first);
    expect(audits("permission.granted")).toHaveLength(1);
  });

  it("refuses a non-member without writing into the organization's audit trail", async () => {
    await expect(fx.grants.grant(fx.outsiderId, fx.orgId, fx.ids.VIEWER, "audit.view")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fx.deps.repos.auditLogs.listByOrganization(fx.orgId)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ action: "permission.grant_refused" })]),
    );
  });

  it("answers NOT_FOUND for a target that is not a member", async () => {
    await expect(fx.grants.grant(fx.ownerId, fx.orgId, fx.outsiderId, "audit.view")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("revoke", () => {
  it("lets an OWNER take billing.manage back from an ADMIN, prospectively and audited", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.ADMIN, "billing.manage");
    await fx.grants.revoke(fx.ownerId, fx.orgId, fx.ids.ADMIN, "billing.manage");

    expect(await holds(fx.ids.ADMIN, "billing.manage")).toBe(false);
    expect(audits("permission.revoked")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ownerId,
        resourceId: `${fx.orgId}:${fx.ids.ADMIN}`,
        metadata: { targetUserId: fx.ids.ADMIN, targetRole: "ADMIN", permission: "billing.manage" },
      }),
    ]);
  });

  it.each([...PROTECTED_PERMISSIONS])("refuses an ADMIN revoking an OWNER's %s grant", async (permission) => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, permission);
    await expect(fx.grants.revoke(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, permission)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await grantsOf(fx.ids.CREATOR)).toEqual([permission]);
    expect(audits("permission.grant_refused")[0]!.metadata).toMatchObject({ operation: "revoke", reason: "protected" });
  });

  it("lets an ADMIN revoke a non-protected grant from a member it manages", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "audit.view");
    await fx.grants.revoke(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, "audit.view");
    expect(await holds(fx.ids.CREATOR, "audit.view")).toBe(false);
  });

  it("answers NOT_FOUND, unaudited, when the member holds no such grant", async () => {
    await expect(fx.grants.revoke(fx.ownerId, fx.orgId, fx.ids.CREATOR, "audit.view")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(audits("permission.revoked")).toEqual([]);
  });

  it("does not take away what the member's template carries", async () => {
    await expect(fx.grants.revoke(fx.ownerId, fx.orgId, fx.ids.CREATOR, "video.generate")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await holds(fx.ids.CREATOR, "video.generate")).toBe(true);
  });
});

describe("effective permissions", () => {
  it("keeps a grant across a role change and recomputes from the new role", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "audit.view");
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "property.create");
    await fx.members.changeRole(fx.ids.ADMIN, fx.orgId, fx.ids.CREATOR, "VIEWER");

    expect(await holds(fx.ids.CREATOR, "audit.view")).toBe(true);
    // The recipient-role ceiling outlasts the grant, and the grant can still be taken back.
    expect(await holds(fx.ids.CREATOR, "property.create")).toBe(false);
    await fx.grants.revoke(fx.ownerId, fx.orgId, fx.ids.CREATOR, "property.create");
    expect(await grantsOf(fx.ids.CREATOR)).toEqual(["audit.view"]);
  });

  it("removes a member's grants with the membership", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "audit.view");
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.CREATOR);
    await fx.deps.repos.memberships.create({ organizationId: fx.orgId, userId: fx.ids.CREATOR, role: "CREATOR" });
    expect(await holds(fx.ids.CREATOR, "audit.view")).toBe(false);
  });

  it("never carries a grant into another organization", async () => {
    await fx.deps.repos.memberships.create({ organizationId: fx.otherOrgId, userId: fx.ids.CREATOR, role: "CREATOR" });
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "audit.view");
    expect(await holds(fx.ids.CREATOR, "audit.view")).toBe(true);
    expect(await holds(fx.ids.CREATOR, "audit.view", fx.otherOrgId)).toBe(false);
  });

  it("reaches the membership paths: a CREATOR granted member.view may list members", async () => {
    await expect(fx.members.listMembers(fx.ids.CREATOR, fx.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "member.view");
    await expect(fx.members.listMembers(fx.ids.CREATOR, fx.orgId)).resolves.toHaveLength(ROLES.length + 1);
  });

  it("reaches a role change's permission check, though not past the role ceiling", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.CREATOR, "permission.manage");
    await expect(fx.members.changeRole(fx.ids.CREATOR, fx.orgId, fx.ids.VIEWER, "CREATOR")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Refused by the ceiling, after the target was read, not for lacking the permission.
    const refused = fx.deps.repos.auditLogs.all().filter((entry) => entry.action === "member.role_change_refused");
    expect(refused[0]!.metadata).toMatchObject({ actorRole: "CREATOR", currentRole: "VIEWER" });
  });

  it("is reported with each organization a member belongs to", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.VIEWER, "audit.view");
    const [entry] = await new OrganizationService(fx.deps).listForUser(fx.ids.VIEWER);
    expect(entry).toMatchObject({ role: "VIEWER" });
    expect(entry!.permissions).toEqual(["organization.view", "property.view", "video.view", "video.download", "audit.view"]);
  });
});

describe("listForMember", () => {
  it("lists a member's individual grants for anyone holding member.view", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.VIEWER, "audit.view");
    const listed = await fx.grants.listForMember(fx.ids.BILLING, fx.orgId, fx.ids.VIEWER);
    expect(listed.map((g) => g.permission)).toEqual(["audit.view"]);
  });

  it("refuses a member without member.view, and answers NOT_FOUND for a non-member target", async () => {
    await expect(fx.grants.listForMember(fx.ids.CREATOR, fx.orgId, fx.ids.VIEWER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(fx.grants.listForMember(fx.ownerId, fx.orgId, fx.outsiderId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
