import { AppError } from "@app/shared";
import { AuditAction, recordAudit } from "./audit";
import { authorizeOrganization, type AuthContext } from "./authorization";
import type { GroupCeilingRefusal, GroupChangeAudit, IdentityServiceDeps, LockedGroup } from "./ports";
import { groupGrantRefusal, mayAssignRole, PERMISSIONS, type GroupGrantRefusal, type Permission, type Role } from "./roles";
import type { Group, GroupMember, GroupPermission, Membership } from "./types";

export const GROUP_NAME_MAX_LENGTH = 100;

type GroupOperation =
  | "create"
  | "rename"
  | "delete"
  | "add_member"
  | "remove_member"
  | "grant_permission"
  | "revoke_permission";

/** Why a member's group change was refused, as its audit entry records it. */
export type GroupChangeRefusal =
  | "lacks_group_manage"
  | "lacks_permission_manage"
  | "protected_delete"
  | "target_role"
  | GroupGrantRefusal;

/** What a refused group change was aimed at, for its audit entry. */
interface RefusedTarget {
  readonly groupId: string | null;
  readonly targetUserId?: string;
  readonly targetRole?: Role;
  readonly permission?: Permission;
}

/**
 * Groups, who belongs to them, and the permissions they carry (ADR-0052
 * Decisions 10 and 11, ADR-0060, ADR-0061).
 *
 * Changing a group or its members needs the actor's effective `group.manage`.
 * Deleting a group is protected: it also needs the `OWNER` or `ADMIN` role, so
 * `group.manage` granted to any other role does not reach it. Adding or removing
 * a member is an authorization change on that member, so it is asked of the
 * role-assignment ceiling as a role change is: an `ADMIN` changes only
 * `MANAGER`, `CREATOR` and `VIEWER` members, never itself, and no lower role
 * changes anyone. Changing a group's permissions needs `permission.manage`.
 *
 * A change that gives or takes a permission — giving a group one or taking it
 * away, adding or removing a member of a group that carries any, deleting such
 * a group — is checked as if each member it reaches were granted, or revoked,
 * each permission directly (the grant ceiling, ADR-0058). That check is judged
 * on the group as the change commits, under the group's lock, so no route
 * through a group reaches past the ceiling.
 *
 * Every refusal of a member is audited, and every change commits together with
 * its audit entry. A group confers no row access yet.
 */
export class GroupService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  async create(actorUserId: string, organizationId: string, name: string): Promise<Group> {
    const actor = await this.requireGroupManage(actorUserId, organizationId, "create", { groupId: null });
    const groupName = normalizeGroupName(name);
    const id = this.deps.ids.generate("grp");
    const created = await this.deps.repos.groups.create(
      { id, organizationId, name: groupName, createdByUserId: actorUserId },
      changeAudit(actor, AuditAction.GroupCreated, id, { name: groupName }),
    );
    if (created.outcome === "NAME_TAKEN") throw nameTaken();
    return created.group;
  }

  /** Rename a group. Renaming to its current name changes nothing. */
  async rename(actorUserId: string, organizationId: string, groupId: string, name: string): Promise<Group> {
    const actor = await this.requireGroupManage(actorUserId, organizationId, "rename", { groupId });
    const groupName = normalizeGroupName(name);
    const group = await this.requireGroup(organizationId, groupId);
    if (group.name === groupName) return group;
    const renamed = await this.deps.repos.groups.rename(
      organizationId,
      groupId,
      group.name,
      groupName,
      changeAudit(actor, AuditAction.GroupRenamed, groupId, { name: groupName, previousName: group.name }),
    );
    if (renamed.outcome === "NAME_TAKEN") throw nameTaken();
    if (renamed.outcome === "STALE") {
      throw new AppError("VALIDATION_FAILED", "This group changed meanwhile; reload and try again");
    }
    return renamed.group;
  }

  /**
   * Delete a group. Its members stay in the organization; only their
   * membership of this group, and what it gave them, ends. The audit entry
   * names the group as the deletion locked it, so a rename committed meanwhile
   * is not misreported.
   */
  async delete(actorUserId: string, organizationId: string, groupId: string): Promise<void> {
    const actor = await this.requireGroupManage(actorUserId, organizationId, "delete", { groupId });
    if (actor.role !== "OWNER" && actor.role !== "ADMIN") {
      await this.refuse(actor, "delete", "protected_delete", { groupId });
    }
    const deleted = await this.deps.repos.groups.delete(
      organizationId,
      groupId,
      // Takes each of the group's permissions from each of its members.
      (locked) => permissionCeiling(actor, locked.permissions) ?? memberCeiling(actor, locked, locked.permissions),
      ({ name, removedMemberCount }) =>
        changeAudit(actor, AuditAction.GroupDeleted, groupId, { name, actorRole: actor.role, removedMemberCount }),
    );
    if (deleted.outcome === "REFUSED") {
      const { reason, ...refused } = deleted.refusal;
      await this.refuse(actor, "delete", reason, { groupId, ...refused });
    }
    if (deleted.outcome === "STALE") throw groupNotFound();
  }

  async list(actorUserId: string, organizationId: string): Promise<Group[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "group.view");
    return this.deps.repos.groups.listByOrganization(organizationId);
  }

  async listMembers(actorUserId: string, organizationId: string, groupId: string): Promise<GroupMember[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "group.view");
    await this.requireGroup(organizationId, groupId);
    return this.deps.repos.groups.listMembers(organizationId, groupId);
  }

  /** Add a member to a group. Adding one already in it changes nothing (`added: false`). */
  async addMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    targetUserId: string,
  ): Promise<{ readonly added: boolean }> {
    const { actor, target } = await this.authorizeMemberChange("add_member", actorUserId, organizationId, groupId, targetUserId);
    const added = await this.deps.repos.groups.addMember(
      { groupId, organizationId, userId: targetUserId, addedByUserId: actorUserId },
      // Gives the member each of the group's permissions.
      (locked) => permissionCeiling(actor, locked.permissions),
      memberAudit(actor, AuditAction.GroupMemberAdded, groupId, target),
    );
    if (added.outcome === "REFUSED") {
      await this.refuse(actor, "add_member", added.refusal.reason, {
        groupId,
        targetUserId,
        targetRole: target.role,
        permission: added.refusal.permission,
      });
    }
    if (added.outcome === "STALE") throw new AppError("NOT_FOUND", "The group or the member no longer exists");
    return { added: added.outcome === "ADDED" };
  }

  async removeMember(actorUserId: string, organizationId: string, groupId: string, targetUserId: string): Promise<void> {
    const { actor, target } = await this.authorizeMemberChange(
      "remove_member",
      actorUserId,
      organizationId,
      groupId,
      targetUserId,
    );
    const removed = await this.deps.repos.groups.removeMember(
      organizationId,
      groupId,
      targetUserId,
      // Takes each of the group's permissions from the member.
      (locked) => permissionCeiling(actor, locked.permissions),
      memberAudit(actor, AuditAction.GroupMemberRemoved, groupId, target),
    );
    if (removed.outcome === "REFUSED") {
      await this.refuse(actor, "remove_member", removed.refusal.reason, {
        groupId,
        targetUserId,
        targetRole: target.role,
        permission: removed.refusal.permission,
      });
    }
    if (removed.outcome === "NOT_IN_GROUP") throw new AppError("NOT_FOUND", "The member is not in this group");
  }

  /** A group's permissions, which each of its members holds. */
  async listPermissions(actorUserId: string, organizationId: string, groupId: string): Promise<GroupPermission[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "group.view");
    await this.requireGroup(organizationId, groupId);
    return this.deps.repos.groups.listPermissions(organizationId, groupId);
  }

  /**
   * Give a group a permission, which each of its members then holds. Giving it
   * one it already carries changes nothing (`granted: false`).
   */
  async grantPermission(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    permission: Permission,
  ): Promise<{ readonly granted: boolean }> {
    const actor = await this.authorizePermissionChange("grant_permission", actorUserId, organizationId, groupId, permission);
    const granted = await this.deps.repos.groups.grantPermission(
      { groupId, organizationId, permission, grantedByUserId: actorUserId },
      (locked) => memberCeiling(actor, locked, [permission]),
      (memberCount) => changeAudit(actor, AuditAction.GroupPermissionGranted, groupId, { permission, memberCount }),
    );
    if (granted.outcome === "REFUSED") {
      const { reason, ...refused } = granted.refusal;
      await this.refuse(actor, "grant_permission", reason, { groupId, ...refused });
    }
    if (granted.outcome === "STALE") throw groupNotFound();
    return { granted: granted.outcome === "GRANTED" };
  }

  /** Take a permission from a group. Revocation is prospective; nothing already done is undone. */
  async revokePermission(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    permission: Permission,
  ): Promise<void> {
    const actor = await this.authorizePermissionChange("revoke_permission", actorUserId, organizationId, groupId, permission);
    const revoked = await this.deps.repos.groups.revokePermission(
      organizationId,
      groupId,
      permission,
      (locked) => memberCeiling(actor, locked, [permission]),
      (memberCount) => changeAudit(actor, AuditAction.GroupPermissionRevoked, groupId, { permission, memberCount }),
    );
    if (revoked.outcome === "REFUSED") {
      const { reason, ...refused } = revoked.refusal;
      await this.refuse(actor, "revoke_permission", reason, { groupId, ...refused });
    }
    if (revoked.outcome === "STALE") throw groupNotFound();
    if (revoked.outcome === "NOT_GRANTED") throw new AppError("NOT_FOUND", "The group carries no such permission");
  }

  /**
   * The actor of a change to a group's permissions, holding `permission.manage`
   * and passing the ceiling's actor half; the member half is asked under the
   * group's lock.
   */
  private async authorizePermissionChange(
    operation: "grant_permission" | "revoke_permission",
    actorUserId: string,
    organizationId: string,
    groupId: string,
    permission: Permission,
  ): Promise<AuthContext> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId);
    if (!actor.permissions.includes("permission.manage")) {
      await this.refuse(actor, operation, "lacks_permission_manage", { groupId, permission });
    }
    await this.requireGroup(organizationId, groupId);
    const refusal = permissionCeiling(actor, [permission]);
    if (refusal !== null) await this.refuse(actor, operation, refusal.reason, { groupId, permission });
    return actor;
  }

  /** The actor and target of a membership change the actor may make, under the role-assignment ceiling. */
  private async authorizeMemberChange(
    operation: "add_member" | "remove_member",
    actorUserId: string,
    organizationId: string,
    groupId: string,
    targetUserId: string,
  ): Promise<{ actor: AuthContext; target: Membership }> {
    const actor = await this.requireGroupManage(actorUserId, organizationId, operation, { groupId, targetUserId });
    await this.requireGroup(organizationId, groupId);
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    if (!mayAssignRole(actor.role, target.role)) {
      await this.refuse(actor, operation, "target_role", { groupId, targetUserId, targetRole: target.role });
    }
    return { actor, target };
  }

  /**
   * The actor's authorization, holding `group.manage`. A non-member is refused
   * as any other organization access is, unaudited; a member lacking it is
   * refused and audited.
   */
  private async requireGroupManage(
    actorUserId: string,
    organizationId: string,
    operation: GroupOperation,
    refused: RefusedTarget,
  ): Promise<AuthContext> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId);
    if (!actor.permissions.includes("group.manage")) {
      await this.refuse(actor, operation, "lacks_group_manage", refused);
    }
    return actor;
  }

  /** A group of the organization; a group of another organization is not found. */
  private async requireGroup(organizationId: string, groupId: string): Promise<Group> {
    const group = await this.deps.repos.groups.find(organizationId, groupId);
    if (!group) throw groupNotFound();
    return group;
  }

  private async refuse(
    actor: AuthContext,
    operation: GroupOperation,
    reason: GroupChangeRefusal,
    refused: RefusedTarget,
  ): Promise<never> {
    await recordAudit(this.deps, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: AuditAction.GroupChangeRefused,
      resourceType: refused.groupId === null ? "organization" : "group",
      resourceId: refused.groupId ?? actor.organizationId,
      metadata: { operation, reason, actorRole: actor.role, ...refused },
    });
    throw new AppError("FORBIDDEN", `Role ${actor.role} may not ${operation.replace("_", " ")} here`);
  }
}

/** A group name as stored: trimmed, 1 to 100 characters. */
function normalizeGroupName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `A group name must be 1 to ${GROUP_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * The ceiling's actor half: the first of `permissions`, in vocabulary order,
 * that the actor may not give a group or take from it.
 */
function permissionCeiling(actor: AuthContext, permissions: readonly Permission[]): GroupCeilingRefusal | null {
  for (const permission of PERMISSIONS.filter((p) => permissions.includes(p))) {
    const reason = groupGrantRefusal(actor.role, actor.permissions, permission);
    if (reason !== null) return { reason, permission };
  }
  return null;
}

/**
 * The ceiling's member half: when a change gives or takes any of
 * `permissions`, the first member of the locked group whose role the actor may
 * not manage. A change that gives or takes nothing reaches no one.
 */
function memberCeiling(
  actor: AuthContext,
  locked: LockedGroup,
  permissions: readonly Permission[],
): GroupCeilingRefusal | null {
  const [permission] = PERMISSIONS.filter((p) => permissions.includes(p));
  if (permission === undefined) return null;
  const member = locked.members.find(({ role }) => !mayAssignRole(actor.role, role));
  return member ? { reason: "target_role", permission, targetUserId: member.userId, targetRole: member.role } : null;
}

function nameTaken(): AppError {
  return new AppError("VALIDATION_FAILED", "A group with this name already exists");
}

function groupNotFound(): AppError {
  return new AppError("NOT_FOUND", "Group not found");
}

function changeAudit(
  actor: AuthContext,
  action: string,
  groupId: string,
  metadata: Record<string, unknown>,
): GroupChangeAudit {
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action,
    resourceType: "group",
    resourceId: groupId,
    metadata,
  };
}

function memberAudit(actor: AuthContext, action: string, groupId: string, target: Membership): GroupChangeAudit {
  return changeAudit(actor, action, groupId, { targetUserId: target.userId, targetRole: target.role });
}
