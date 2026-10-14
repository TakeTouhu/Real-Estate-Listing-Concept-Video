import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { authorizeOrganization } from "./authorization";
import { GroupService } from "./group-service";
import { MembershipService } from "./membership-service";
import { OrganizationService } from "./organization-service";
import { PermissionGrantService } from "./permission-grant-service";
import {
  effectivePermissions,
  GROUP_GRANTABLE_PERMISSIONS,
  mayAssignRole,
  PROTECTED_PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from "./roles";
import type { AuditLog, Group } from "./types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

/**
 * Group permissions (ADR-0052 Decision 10, Phase 6G): every group change that
 * gives or takes a permission is checked as if each member it reaches were
 * granted, or revoked, that permission directly; `disclosure.none` is never on a
 * group; `property.create` is never effective for `VIEWER` or `BILLING`.
 */

const PASSWORD = "password-123456";

interface Fixture {
  readonly deps: TestDeps;
  readonly groups: GroupService;
  readonly grants: PermissionGrantService;
  readonly members: MembershipService;
  readonly orgId: string;
  readonly otherOrgId: string;
  /** The founding OWNER. */
  readonly ownerId: string;
  /** One member per template besides the founding OWNER. */
  readonly ids: Readonly<Record<Role, string>>;
}

let fx: Fixture;
let groupCount = 0;

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
  fx = {
    deps,
    groups: new GroupService(deps),
    grants: new PermissionGrantService(deps),
    members: new MembershipService(deps, { invitationTtlSeconds: 3600 }),
    orgId: organization.id,
    otherOrgId: other.organization.id,
    ownerId: owner.id,
    ids,
  };
});

function audits(action: string): AuditLog[] {
  return fx.deps.repos.auditLogs.all().filter((entry) => entry.action === action);
}

/** A group the founding OWNER creates, gives `permissions` and puts members of `roles` in. */
async function newGroup(permissions: readonly Permission[] = [], roles: readonly Role[] = []): Promise<Group> {
  const group = await fx.groups.create(fx.ownerId, fx.orgId, `Group ${(groupCount += 1)}`);
  for (const permission of permissions) await fx.groups.grantPermission(fx.ownerId, fx.orgId, group.id, permission);
  for (const role of roles) await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids[role]);
  return group;
}

async function effective(role: Role): Promise<readonly Permission[]> {
  return (await authorizeOrganization(fx.deps, fx.ids[role], fx.orgId)).permissions;
}

async function carried(group: Group): Promise<Permission[]> {
  return (await fx.deps.repos.groups.listPermissions(fx.orgId, group.id)).map((p) => p.permission).sort();
}

const NON_PROTECTED = GROUP_GRANTABLE_PERMISSIONS.filter((p) => !PROTECTED_PERMISSIONS.includes(p));

describe("giving a group a permission and taking it away", () => {
  it("lets an OWNER give a group everything a group may carry, for members of every role", async () => {
    const group = await newGroup([], ROLES);
    for (const permission of GROUP_GRANTABLE_PERMISSIONS) {
      await expect(fx.groups.grantPermission(fx.ownerId, fx.orgId, group.id, permission)).resolves.toEqual({ granted: true });
    }
    expect(await carried(group)).toEqual([...GROUP_GRANTABLE_PERMISSIONS].sort());
    expect(await effective("VIEWER")).toEqual(GROUP_GRANTABLE_PERMISSIONS.filter((p) => p !== "property.create"));
    for (const permission of GROUP_GRANTABLE_PERMISSIONS) {
      await fx.groups.revokePermission(fx.ownerId, fx.orgId, group.id, permission);
    }
    expect(await carried(group)).toEqual([]);
    expect(await effective("VIEWER")).toEqual(effectivePermissions("VIEWER", []));
  });

  it.each(["disclosure.none", "video.share"] as const)("refuses %s to a group, even an OWNER's, and audits it", async (permission) => {
    const group = await newGroup();
    await expect(fx.groups.grantPermission(fx.ownerId, fx.orgId, group.id, permission)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await carried(group)).toEqual([]);
    expect(audits("group.change_refused")).toEqual([
      expect.objectContaining({
        resourceType: "group",
        resourceId: group.id,
        metadata: { operation: "grant_permission", reason: "not_grantable", actorRole: "OWNER", groupId: group.id, permission },
      }),
    ]);
  });

  it.each(ROLES.filter((role) => !effectivePermissions(role, []).includes("permission.manage")))(
    "refuses a %s without permission.manage, either way, and audits it",
    async (role) => {
      const group = await newGroup(["audit.view"]);
      for (const attempt of [
        fx.groups.grantPermission(fx.ids[role], fx.orgId, group.id, "video.view"),
        fx.groups.revokePermission(fx.ids[role], fx.orgId, group.id, "audit.view"),
      ]) {
        await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(await carried(group)).toEqual(["audit.view"]);
      expect(audits("group.change_refused").map((a) => [a.metadata.operation, a.metadata.reason])).toEqual([
        ["grant_permission", "lacks_permission_manage"],
        ["revoke_permission", "lacks_permission_manage"],
      ]);
    },
  );

  it.each(GROUP_GRANTABLE_PERMISSIONS)("lets an ADMIN give and take %s only if it is not OWNER-only", async (permission) => {
    const group = await newGroup();
    const owned = await newGroup([permission]); // given by the OWNER, for the revocation
    const grant = fx.groups.grantPermission(fx.ids.ADMIN, fx.orgId, group.id, permission);
    const revoke = fx.groups.revokePermission(fx.ids.ADMIN, fx.orgId, owned.id, permission);
    if (!PROTECTED_PERMISSIONS.includes(permission)) {
      await expect(grant).resolves.toEqual({ granted: true });
      await expect(revoke).resolves.toBeUndefined();
      return;
    }
    await expect(grant).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(revoke).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect([await carried(group), await carried(owned)]).toEqual([[], [permission]]);
    expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["protected", "protected"]);
  });

  it.each(ROLES)("lets an ADMIN change the permissions of a group with a %s member only within its ceiling", async (role) => {
    const group = await newGroup(["audit.view"], [role]);
    const grant = fx.groups.grantPermission(fx.ids.ADMIN, fx.orgId, group.id, "video.generate");
    const revoke = fx.groups.revokePermission(fx.ids.ADMIN, fx.orgId, group.id, "audit.view");
    if (mayAssignRole("ADMIN", role)) {
      await expect(grant).resolves.toEqual({ granted: true });
      await expect(revoke).resolves.toBeUndefined();
      return;
    }
    await expect(grant).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(revoke).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await carried(group)).toEqual(["audit.view"]);
    const target = { reason: "target_role", targetUserId: fx.ids[role], targetRole: role };
    expect(audits("group.change_refused").map((a) => a.metadata)).toEqual([
      expect.objectContaining({ operation: "grant_permission", permission: "video.generate", ...target }),
      expect.objectContaining({ operation: "revoke_permission", permission: "audit.view", ...target }),
    ]);
  });

  it("lets a member holding permission.manage by grant give a group only what it holds, and reach no member", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.MANAGER, "permission.manage");
    const group = await newGroup();
    await expect(fx.groups.grantPermission(fx.ids.MANAGER, fx.orgId, group.id, "video.generate")).resolves.toEqual({
      granted: true,
    });
    await expect(fx.groups.grantPermission(fx.ids.MANAGER, fx.orgId, group.id, "audit.view")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER);
    await expect(fx.groups.grantPermission(fx.ids.MANAGER, fx.orgId, group.id, "video.view")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["not_held", "target_role"]);
    expect(await carried(group)).toEqual(["video.generate"]);
  });

  it("records each change with the permission and how many members it reached", async () => {
    const group = await newGroup([], ["MANAGER", "VIEWER"]);
    await fx.groups.grantPermission(fx.ids.ADMIN, fx.orgId, group.id, "audit.view");
    await expect(fx.groups.grantPermission(fx.ownerId, fx.orgId, group.id, "audit.view")).resolves.toEqual({
      granted: false,
    });
    await fx.groups.revokePermission(fx.ownerId, fx.orgId, group.id, "audit.view");
    const entry = (action: string, actorUserId: string) =>
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId,
        action,
        resourceType: "group",
        resourceId: group.id,
        metadata: { permission: "audit.view", memberCount: 2 },
      });
    expect([...audits("group.permission_granted"), ...audits("group.permission_revoked")]).toEqual([
      entry("group.permission_granted", fx.ids.ADMIN),
      entry("group.permission_revoked", fx.ownerId),
    ]);
  });

  it("answers NOT_FOUND for a permission the group does not carry, writing nothing", async () => {
    const group = await newGroup();
    await expect(fx.groups.revokePermission(fx.ownerId, fx.orgId, group.id, "audit.view")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The group carries no such permission",
    });
    expect(audits("group.permission_revoked")).toEqual([]);
  });

  it("reaches no group of another organization, and lists only with group.view", async () => {
    const elsewhere = await fx.groups.create(fx.ownerId, fx.otherOrgId, "Sales");
    for (const attempt of [
      fx.groups.grantPermission(fx.ownerId, fx.orgId, elsewhere.id, "audit.view"),
      fx.groups.revokePermission(fx.ownerId, fx.orgId, elsewhere.id, "audit.view"),
      fx.groups.listPermissions(fx.ownerId, fx.orgId, elsewhere.id),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const group = await newGroup(["audit.view"]);
    await expect(fx.groups.listPermissions(fx.ids.MANAGER, fx.orgId, group.id)).resolves.toEqual([
      expect.objectContaining({ groupId: group.id, permission: "audit.view", grantedByUserId: fx.ownerId }),
    ]);
    await expect(fx.groups.listPermissions(fx.ids.CREATOR, fx.orgId, group.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await fx.deps.repos.groups.listPermissions(fx.otherOrgId, group.id)).toEqual([]);
  });
});

describe("what a member holds through its groups", () => {
  it("adds up across groups and ends with the membership, the group, or the organization membership", async () => {
    const first = await newGroup(["audit.view"], ["VIEWER", "CREATOR"]);
    const second = await fx.groups.create(fx.ownerId, fx.orgId, "Support");
    await fx.groups.grantPermission(fx.ownerId, fx.orgId, second.id, "unit.view");
    await fx.groups.addMember(fx.ownerId, fx.orgId, second.id, fx.ids.VIEWER);
    expect(await effective("VIEWER")).toEqual(effectivePermissions("VIEWER", ["unit.view", "audit.view"]));
    await fx.groups.removeMember(fx.ownerId, fx.orgId, first.id, fx.ids.VIEWER);
    expect(await effective("VIEWER")).toEqual(effectivePermissions("VIEWER", ["unit.view"]));
    await fx.groups.delete(fx.ownerId, fx.orgId, second.id);
    expect(await effective("VIEWER")).toEqual(effectivePermissions("VIEWER", []));
    expect(await effective("CREATOR")).toContain("audit.view");
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.CREATOR);
    expect(await fx.deps.repos.groups.listPermissionsForMember(fx.orgId, fx.ids.CREATOR)).toEqual([]);
  });

  it("never makes property.create effective for a VIEWER or BILLING member", async () => {
    await newGroup(["property.create", "property.edit"], ["VIEWER", "BILLING", "CREATOR"]);
    for (const role of ["VIEWER", "BILLING"] as const) {
      expect(await effective(role)).toContain("property.edit");
      expect(await effective(role)).not.toContain("property.create");
    }
    expect(await effective("CREATOR")).toContain("property.create");
  });

  it("survives the member's role change", async () => {
    await newGroup(["audit.view"], ["VIEWER"]);
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.VIEWER, "CREATOR");
    expect(await effective("VIEWER")).toContain("audit.view");
  });

  it("never confers what a group may not carry, whatever is stored", () => {
    const fromGroups: Permission[] = ["disclosure.none", "video.share", "audit.view"];
    expect(effectivePermissions("VIEWER", [], fromGroups)).toEqual(effectivePermissions("VIEWER", ["audit.view"]));
    expect(effectivePermissions("VIEWER", ["disclosure.none"], fromGroups)).toContain("disclosure.none");
  });
});

describe("adding and removing a member of a group that carries permissions", () => {
  it("lets an ADMIN add and remove a member when the group carries only what it may grant", async () => {
    const group = await newGroup(NON_PROTECTED);
    await expect(fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER)).resolves.toEqual({ added: true });
    await expect(fx.groups.removeMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER)).resolves.toBeUndefined();
  });

  it.each(PROTECTED_PERMISSIONS.filter((p) => GROUP_GRANTABLE_PERMISSIONS.includes(p)))(
    "refuses an ADMIN adding or removing any member of a group carrying %s, and audits it",
    async (permission) => {
      const group = await newGroup(["video.view", permission], ["CREATOR"]);
      await expect(fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(fx.groups.removeMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.CREATOR)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect((await fx.deps.repos.groups.listMembers(fx.orgId, group.id)).map((m) => m.userId)).toEqual([fx.ids.CREATOR]);
      const refused = (operation: string, role: Role) => ({
        operation,
        reason: "protected",
        actorRole: "ADMIN",
        groupId: group.id,
        targetUserId: fx.ids[role],
        targetRole: role,
        permission,
      });
      expect(audits("group.change_refused").map((a) => a.metadata)).toEqual([
        refused("add_member", "VIEWER"),
        refused("remove_member", "CREATOR"),
      ]);
      await expect(fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER)).resolves.toEqual({ added: true });
      await expect(fx.groups.removeMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER)).resolves.toBeUndefined();
    },
  );

  it("refuses a MANAGER holding group.manage by grant, as in 6F", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.MANAGER, "group.manage");
    const group = await newGroup(["video.view"]);
    await expect(fx.groups.addMember(fx.ids.MANAGER, fx.orgId, group.id, fx.ids.VIEWER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["target_role"]);
  });
});

describe("deleting a group that carries permissions", () => {
  it("lets an ADMIN delete it when it carries only what the ADMIN may take, from members it may manage", async () => {
    const group = await newGroup(NON_PROTECTED, ["MANAGER", "CREATOR", "VIEWER"]);
    await fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id);
    expect(await fx.deps.repos.groups.listPermissions(fx.orgId, group.id)).toEqual([]);
    expect(await effective("VIEWER")).toEqual(effectivePermissions("VIEWER", []));
  });

  it("refuses an ADMIN a group carrying an OWNER-only permission, even with no member", async () => {
    const group = await newGroup(["billing.manage"]);
    await expect(fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(audits("group.change_refused").map((a) => a.metadata)).toEqual([
      { operation: "delete", reason: "protected", actorRole: "ADMIN", groupId: group.id, permission: "billing.manage" },
    ]);
    expect(await fx.deps.repos.groups.find(fx.orgId, group.id)).not.toBeNull();
  });

  it.each(["OWNER", "ADMIN", "BILLING"] as const)(
    "refuses an ADMIN a group carrying a permission with a %s member, but not one carrying none",
    async (role) => {
      const group = await newGroup(["video.view"], [role]);
      await expect(fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(audits("group.change_refused").map((a) => a.metadata)).toEqual([
        expect.objectContaining({ operation: "delete", reason: "target_role", targetUserId: fx.ids[role], permission: "video.view" }),
      ]);
      await fx.groups.revokePermission(fx.ownerId, fx.orgId, group.id, "video.view");
      await expect(fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id)).resolves.toBeUndefined();
    },
  );

  it("lets an OWNER delete any group", async () => {
    const group = await newGroup(["billing.manage", "permission.manage"], ROLES);
    await fx.groups.delete(fx.ownerId, fx.orgId, group.id);
    expect(await fx.deps.repos.groups.listPermissionsForMember(fx.orgId, fx.ids.VIEWER)).toEqual([]);
  });
});

describe("concurrent changes are judged on the group as each commits", () => {
  it("refuses an ADMIN's addition that commits after an OWNER gives the group billing.manage, and counts one before", async () => {
    const group = await newGroup();
    const [added, granted] = await Promise.allSettled([
      fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER),
      fx.groups.grantPermission(fx.ownerId, fx.orgId, group.id, "billing.manage"),
    ]);
    expect(granted.status).toBe("fulfilled");
    const [grant] = audits("group.permission_granted");
    if (added.status === "fulfilled") {
      expect(grant?.metadata.memberCount).toBe(1);
    } else {
      expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["protected"]);
      expect(grant?.metadata.memberCount).toBe(0);
    }
  });
});
