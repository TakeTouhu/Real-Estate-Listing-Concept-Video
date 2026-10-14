import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth-service";
import { OrganizationService } from "./organization-service";
import { MembershipService } from "./membership-service";
import { PermissionGrantService } from "./permission-grant-service";
import { GROUP_NAME_MAX_LENGTH, GroupService } from "./group-service";
import { mayAssignRole, ROLES, type Role } from "./roles";
import type { AuditLog, Group } from "./types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";

/**
 * Groups and group membership (ADR-0052 Decisions 10 and 11, Phase 6F): who may
 * change a group or its members, the protected deletion, names, tenant
 * isolation, the audit trail, and concurrent changes.
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
    groups: new GroupService(deps),
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

async function memberIds(groupId: string, organizationId = fx.orgId): Promise<string[]> {
  return (await fx.deps.repos.groups.listMembers(organizationId, groupId)).map((m) => m.userId);
}

function newGroup(name = "Sales"): Promise<Group> {
  return fx.groups.create(fx.ownerId, fx.orgId, name);
}

describe("creating and renaming a group", () => {
  it("lets an OWNER create a group, recording who created it", async () => {
    const group = await newGroup("  Tokyo team  ");
    expect(group).toMatchObject({ organizationId: fx.orgId, name: "Tokyo team", createdByUserId: fx.ownerId });
    expect(await fx.deps.repos.groups.find(fx.orgId, group.id)).toEqual(group);
    expect(audits("group.created")).toEqual([
      expect.objectContaining({
        organizationId: fx.orgId,
        actorUserId: fx.ownerId,
        resourceType: "group",
        resourceId: group.id,
        metadata: { name: "Tokyo team" },
      }),
    ]);
  });

  it.each(ROLES)("lets a %s create a group only if its template holds group.manage", async (role) => {
    const may = role === "OWNER" || role === "ADMIN";
    const attempt = fx.groups.create(fx.ids[role], fx.orgId, "Team");
    if (may) {
      await expect(attempt).resolves.toMatchObject({ name: "Team" });
      return;
    }
    await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await fx.deps.repos.groups.listByOrganization(fx.orgId)).toEqual([]);
    expect(audits("group.change_refused")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ids[role],
        resourceType: "organization",
        resourceId: fx.orgId,
        metadata: { operation: "create", reason: "lacks_group_manage", actorRole: role, groupId: null },
      }),
    ]);
  });

  it("lets a MANAGER granted group.manage create and rename a group", async () => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids.MANAGER, "group.manage");
    const group = await fx.groups.create(fx.ids.MANAGER, fx.orgId, "Field");
    const renamed = await fx.groups.rename(fx.ids.MANAGER, fx.orgId, group.id, "Field staff");
    expect(renamed).toMatchObject({ id: group.id, name: "Field staff" });
  });

  it("refuses a non-member without auditing into the organization", async () => {
    await expect(fx.groups.create(fx.outsiderId, fx.orgId, "Team")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(audits("group.change_refused")).toEqual([]);
  });

  it("renames a group, recording the previous name", async () => {
    const group = await newGroup("Sales");
    const renamed = await fx.groups.rename(fx.ids.ADMIN, fx.orgId, group.id, " Sales East ");
    expect(renamed).toMatchObject({ id: group.id, name: "Sales East" });
    expect((await fx.deps.repos.groups.find(fx.orgId, group.id))?.name).toBe("Sales East");
    expect(audits("group.renamed")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ids.ADMIN,
        resourceId: group.id,
        metadata: { name: "Sales East", previousName: "Sales" },
      }),
    ]);
  });

  it("changes nothing when a group is renamed to its current name", async () => {
    const group = await newGroup("Sales");
    expect(await fx.groups.rename(fx.ownerId, fx.orgId, group.id, " Sales ")).toEqual(group);
    expect(audits("group.renamed")).toEqual([]);
  });

  it("refuses a CREATOR's rename, auditing it against the group", async () => {
    const group = await newGroup();
    await expect(fx.groups.rename(fx.ids.CREATOR, fx.orgId, group.id, "Other")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await fx.deps.repos.groups.find(fx.orgId, group.id))?.name).toBe("Sales");
    expect(audits("group.change_refused")).toEqual([
      expect.objectContaining({
        resourceType: "group",
        resourceId: group.id,
        metadata: { operation: "rename", reason: "lacks_group_manage", actorRole: "CREATOR", groupId: group.id },
      }),
    ]);
  });
});

describe("group names", () => {
  it.each(["", "   ", "x".repeat(GROUP_NAME_MAX_LENGTH + 1)])("refuses the name %j", async (name) => {
    await expect(newGroup(name)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(audits("group.created")).toEqual([]);
  });

  it("accepts a name of the maximum length", async () => {
    const name = "x".repeat(GROUP_NAME_MAX_LENGTH);
    expect((await newGroup(name)).name).toBe(name);
  });

  it("refuses a second group of the same name in one organization, but not in another", async () => {
    await newGroup("Sales");
    await expect(newGroup(" Sales")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "A group with this name already exists",
    });
    await expect(fx.groups.create(fx.ownerId, fx.otherOrgId, "Sales")).resolves.toMatchObject({ name: "Sales" });
    expect(audits("group.created")).toHaveLength(2);
  });

  it("refuses a rename to another group's name, writing nothing", async () => {
    await newGroup("Sales");
    const support = await newGroup("Support");
    await expect(fx.groups.rename(fx.ownerId, fx.orgId, support.id, "Sales")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "A group with this name already exists",
    });
    expect((await fx.deps.repos.groups.find(fx.orgId, support.id))?.name).toBe("Support");
    expect(audits("group.renamed")).toEqual([]);
  });

  it("validates the name only once the actor may change groups", async () => {
    await expect(fx.groups.create(fx.ids.VIEWER, fx.orgId, "")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("deleting a group", () => {
  it.each(["OWNER", "ADMIN"] as const)("lets an %s delete a group; its members stay in the organization", async (role) => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.MANAGER);
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.CREATOR);
    await fx.groups.delete(fx.ids[role], fx.orgId, group.id);
    expect(await fx.deps.repos.groups.find(fx.orgId, group.id)).toBeNull();
    expect(await memberIds(group.id)).toEqual([]);
    expect((await fx.deps.repos.memberships.find(fx.orgId, fx.ids.MANAGER))?.role).toBe("MANAGER");
    expect(audits("group.deleted")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ids[role],
        resourceType: "group",
        resourceId: group.id,
        metadata: { name: "Sales", actorRole: role, removedMemberCount: 2 },
      }),
    ]);
  });

  it.each(["MANAGER", "CREATOR"] as const)("refuses a %s holding group.manage by grant", async (role) => {
    await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids[role], "group.manage");
    const group = await newGroup();
    await expect(fx.groups.delete(fx.ids[role], fx.orgId, group.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await fx.deps.repos.groups.find(fx.orgId, group.id)).not.toBeNull();
    expect(audits("group.change_refused")).toEqual([
      expect.objectContaining({
        resourceId: group.id,
        metadata: { operation: "delete", reason: "protected_delete", actorRole: role, groupId: group.id },
      }),
    ]);
  });

  it.each(["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const)(
    "refuses a %s without group.manage as lacking it",
    async (role) => {
      const group = await newGroup();
      await expect(fx.groups.delete(fx.ids[role], fx.orgId, group.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["lacks_group_manage"]);
    },
  );

  it("does not find a missing group, nor another organization's", async () => {
    const elsewhere = await fx.groups.create(fx.ownerId, fx.otherOrgId, "Sales");
    await expect(fx.groups.delete(fx.ownerId, fx.orgId, "grp_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fx.groups.delete(fx.ownerId, fx.orgId, elsewhere.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fx.deps.repos.groups.find(fx.otherOrgId, elsewhere.id)).not.toBeNull();
    expect(audits("group.deleted")).toEqual([]);
  });
});

describe("listing groups and members", () => {
  it("lists the organization's groups by name to a holder of group.view only", async () => {
    await newGroup("Support");
    await newGroup("Field");
    await fx.groups.create(fx.ownerId, fx.otherOrgId, "Elsewhere");
    expect((await fx.groups.list(fx.ids.MANAGER, fx.orgId)).map((g) => g.name)).toEqual(["Field", "Support"]);
    await expect(fx.groups.list(fx.ids.CREATOR, fx.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fx.groups.list(fx.outsiderId, fx.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists a group's members, and finds no group of another organization", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER);
    expect(await fx.groups.listMembers(fx.ids.ADMIN, fx.orgId, group.id)).toEqual([
      expect.objectContaining({ groupId: group.id, userId: fx.ids.VIEWER, addedByUserId: fx.ownerId }),
    ]);
    await expect(fx.groups.listMembers(fx.ownerId, fx.otherOrgId, group.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(fx.groups.listMembers(fx.ids.VIEWER, fx.orgId, group.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("group membership under the role-assignment ceiling", () => {
  const pairs = ROLES.flatMap((actor) => ROLES.map((target) => [actor, target] as const));

  it.each(pairs.filter(([actor]) => actor === "OWNER" || actor === "ADMIN"))(
    "lets an %s add a %s only within its ceiling",
    async (actor, target) => {
      const group = await newGroup();
      const attempt = fx.groups.addMember(fx.ids[actor], fx.orgId, group.id, fx.ids[target]);
      if (mayAssignRole(actor, target)) {
        await expect(attempt).resolves.toEqual({ added: true });
        expect(await memberIds(group.id)).toEqual([fx.ids[target]]);
        expect(audits("group.member_added")).toEqual([
          expect.objectContaining({
            actorUserId: fx.ids[actor],
            resourceType: "group",
            resourceId: group.id,
            metadata: { targetUserId: fx.ids[target], targetRole: target },
          }),
        ]);
        return;
      }
      await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await memberIds(group.id)).toEqual([]);
      expect(audits("group.change_refused")).toEqual([
        expect.objectContaining({
          actorUserId: fx.ids[actor],
          resourceId: group.id,
          metadata: {
            operation: "add_member",
            reason: "target_role",
            actorRole: actor,
            groupId: group.id,
            targetUserId: fx.ids[target],
            targetRole: target,
          },
        }),
      ]);
    },
  );

  it("never lets an ADMIN add itself to a group", async () => {
    const group = await newGroup();
    await expect(fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.ADMIN)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await memberIds(group.id)).toEqual([]);
  });

  it("lets an OWNER add itself", async () => {
    const group = await newGroup();
    await expect(fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ownerId)).resolves.toEqual({ added: true });
  });

  it.each(["MANAGER", "CREATOR"] as const)(
    "lets a %s granted group.manage add no one, itself included",
    async (role) => {
      await fx.grants.grant(fx.ownerId, fx.orgId, fx.ids[role], "group.manage");
      const group = await newGroup();
      for (const target of [fx.ids[role], fx.ids.VIEWER]) {
        await expect(fx.groups.addMember(fx.ids[role], fx.orgId, group.id, target)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      }
      expect(await memberIds(group.id)).toEqual([]);
      expect(audits("group.change_refused").map((a) => a.metadata.reason)).toEqual(["target_role", "target_role"]);
    },
  );

  it("refuses a member without group.manage before reading the target", async () => {
    const group = await newGroup();
    await expect(fx.groups.addMember(fx.ids.MANAGER, fx.orgId, group.id, fx.ids.VIEWER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(audits("group.change_refused")).toEqual([
      expect.objectContaining({
        metadata: {
          operation: "add_member",
          reason: "lacks_group_manage",
          actorRole: "MANAGER",
          groupId: group.id,
          targetUserId: fx.ids.VIEWER,
        },
      }),
    ]);
  });

  it("adds a member already in the group as a no-op with one audit entry", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.CREATOR);
    await expect(fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.CREATOR)).resolves.toEqual({
      added: false,
    });
    expect(audits("group.member_added")).toHaveLength(1);
  });

  it("adds no one who is not a member of the organization, nor to another organization's group", async () => {
    const group = await newGroup();
    const elsewhere = await fx.groups.create(fx.ownerId, fx.otherOrgId, "Sales");
    await expect(fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.outsiderId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Membership not found",
    });
    await expect(fx.groups.addMember(fx.ownerId, fx.orgId, elsewhere.id, fx.ids.CREATOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Group not found",
    });
    expect(await memberIds(group.id)).toEqual([]);
    expect(await memberIds(elsewhere.id, fx.otherOrgId)).toEqual([]);
  });

  it("lets a member belong to several groups", async () => {
    const sales = await newGroup("Sales");
    const support = await newGroup("Support");
    await fx.groups.addMember(fx.ownerId, fx.orgId, sales.id, fx.ids.MANAGER);
    await fx.groups.addMember(fx.ownerId, fx.orgId, support.id, fx.ids.MANAGER);
    expect(await memberIds(sales.id)).toEqual([fx.ids.MANAGER]);
    expect(await memberIds(support.id)).toEqual([fx.ids.MANAGER]);
  });

  it("removes a member within the ceiling, auditing it", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER);
    await fx.groups.removeMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER);
    expect(await memberIds(group.id)).toEqual([]);
    expect(audits("group.member_removed")).toEqual([
      expect.objectContaining({
        actorUserId: fx.ids.ADMIN,
        resourceId: group.id,
        metadata: { targetUserId: fx.ids.VIEWER, targetRole: "VIEWER" },
      }),
    ]);
  });

  it("does not let an ADMIN remove an ADMIN an OWNER added", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.ADMIN);
    await expect(fx.groups.removeMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.ADMIN)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await memberIds(group.id)).toEqual([fx.ids.ADMIN]);
    expect(audits("group.change_refused").map((a) => a.metadata)).toEqual([
      expect.objectContaining({ operation: "remove_member", reason: "target_role", targetRole: "ADMIN" }),
    ]);
  });

  it("removes no one who is not in the group", async () => {
    const group = await newGroup();
    await expect(fx.groups.removeMember(fx.ownerId, fx.orgId, group.id, fx.ids.CREATOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The member is not in this group",
    });
    expect(audits("group.member_removed")).toEqual([]);
  });
});

describe("group membership and the organization's membership", () => {
  it("ends every group membership of a member removed from the organization", async () => {
    const sales = await newGroup("Sales");
    const support = await newGroup("Support");
    await fx.groups.addMember(fx.ownerId, fx.orgId, sales.id, fx.ids.CREATOR);
    await fx.groups.addMember(fx.ownerId, fx.orgId, support.id, fx.ids.CREATOR);
    await fx.groups.addMember(fx.ownerId, fx.orgId, support.id, fx.ids.VIEWER);
    await fx.members.removeMember(fx.ownerId, fx.orgId, fx.ids.CREATOR);
    expect(await memberIds(sales.id)).toEqual([]);
    expect(await memberIds(support.id)).toEqual([fx.ids.VIEWER]);
  });

  it("keeps group memberships across a role change", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.CREATOR);
    await fx.members.changeRole(fx.ownerId, fx.orgId, fx.ids.CREATOR, "MANAGER");
    expect(await memberIds(group.id)).toEqual([fx.ids.CREATOR]);
  });
});

describe("group changes made concurrently", () => {
  it("adds a member once, with one audit entry, when two additions race", async () => {
    const group = await newGroup();
    const results = await Promise.all([
      fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.CREATOR),
      fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.CREATOR),
    ]);
    expect(results.map((r) => r.added).sort()).toEqual([false, true]);
    expect(audits("group.member_added")).toHaveLength(1);
  });

  it("creates one of two groups given the same name at once", async () => {
    const results = await Promise.allSettled([newGroup("Sales"), fx.groups.create(fx.ids.ADMIN, fx.orgId, "Sales")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "VALIDATION_FAILED" }) }),
    ]);
    expect(audits("group.created")).toHaveLength(1);
  });

  it("removes a member once when two removals race", async () => {
    const group = await newGroup();
    await fx.groups.addMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER);
    const results = await Promise.allSettled([
      fx.groups.removeMember(fx.ownerId, fx.orgId, group.id, fx.ids.VIEWER),
      fx.groups.removeMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.VIEWER),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "NOT_FOUND" }) }),
    ]);
    expect(audits("group.member_removed")).toHaveLength(1);
  });

  it("does not rename a group renamed meanwhile", async () => {
    const group = await newGroup("Sales");
    const results = await Promise.allSettled([
      fx.groups.rename(fx.ownerId, fx.orgId, group.id, "East"),
      fx.groups.rename(fx.ids.ADMIN, fx.orgId, group.id, "West"),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ message: "This group changed meanwhile; reload and try again" }),
      }),
    ]);
    const [renamed] = audits("group.renamed");
    expect(audits("group.renamed")).toHaveLength(1);
    expect(renamed?.metadata.previousName).toBe("Sales");
  });

  it("deletes a group once when two deletions race", async () => {
    const group = await newGroup();
    const results = await Promise.allSettled([
      fx.groups.delete(fx.ownerId, fx.orgId, group.id),
      fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "NOT_FOUND", message: "Group not found" }) }),
    ]);
    expect(audits("group.deleted")).toHaveLength(1);
  });

  it("counts an addition that lands before a concurrent deletion, or refuses it", async () => {
    const group = await newGroup();
    const [deleted, added] = await Promise.allSettled([
      fx.groups.delete(fx.ownerId, fx.orgId, group.id),
      fx.groups.addMember(fx.ids.ADMIN, fx.orgId, group.id, fx.ids.CREATOR),
    ]);
    expect(deleted.status).toBe("fulfilled");
    const [deletion] = audits("group.deleted");
    if (added.status === "fulfilled") {
      expect(deletion?.metadata.removedMemberCount).toBe(1);
    } else {
      expect(added.reason).toMatchObject({ code: "NOT_FOUND" });
      expect(deletion?.metadata.removedMemberCount).toBe(0);
    }
    expect(await memberIds(group.id)).toEqual([]);
  });

  it("names a deleted group as it was when deleted, after a concurrent rename", async () => {
    const group = await newGroup("Sales");
    const [renamed, deleted] = await Promise.allSettled([
      fx.groups.rename(fx.ownerId, fx.orgId, group.id, "Field"),
      fx.groups.delete(fx.ids.ADMIN, fx.orgId, group.id),
    ]);
    expect(deleted.status).toBe("fulfilled");
    // A rename that succeeded committed before the deletion, so its name is the one deleted.
    const [deletion] = audits("group.deleted");
    expect(deletion?.metadata.name).toBe(renamed.status === "fulfilled" ? "Field" : "Sales");
  });
});

describe("the in-memory group repository mirrors the database's constraints", () => {
  it("adds no member to a missing group, nor one who is not a member of the organization", async () => {
    const group = await newGroup();
    const entry = {
      organizationId: fx.orgId,
      actorUserId: fx.ownerId,
      action: "x",
      resourceType: "group",
      resourceId: group.id,
      metadata: {},
    };
    const add = (groupId: string, userId: string) =>
      fx.deps.repos.groups.addMember({ groupId, organizationId: fx.orgId, userId, addedByUserId: fx.ownerId }, entry);
    expect(await add(group.id, fx.outsiderId)).toBe("STALE");
    expect(await add("grp_missing", fx.ids.CREATOR)).toBe("STALE");
    expect(await memberIds(group.id)).toEqual([]);
    expect(fx.deps.repos.auditLogs.all().filter((a) => a.action === "x")).toEqual([]);
  });
});
