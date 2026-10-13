import { AppError } from "@app/shared";
import { AuditAction, recordAudit } from "./audit";
import { authorizeOrganization, type AuthContext } from "./authorization";
import type { GrantChangeAudit, IdentityServiceDeps } from "./ports";
import { grantRefusal, type GrantRefusal, type Permission, type Role } from "./roles";
import type { Membership, PermissionGrant } from "./types";

/**
 * Individual permission grants, under the grant ceiling (ADR-0052 Decision 10).
 *
 * Granting or revoking needs the actor's effective `permission.manage`, and then
 * `grantRefusal`: the target's role must be one the actor may manage,
 * `permission.manage` / `billing.manage` / `disclosure.none` are `OWNER`-only,
 * and anyone else delegates only what it holds. Every refusal of a member is
 * audited; a refused escalation is an event, not a silent no-op. A grant or
 * revocation commits together with its own audit entry, so authority never
 * changes unrecorded.
 *
 * A grant answers *what* a member may do, never *which* rows it reaches: Scope
 * stays fixed by role.
 */
export class PermissionGrantService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /** Grant `permission` to a member. Granting one it already holds changes nothing. */
  async grant(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    permission: Permission,
  ): Promise<PermissionGrant> {
    const { target } = await this.authorizeChange("grant", actorUserId, organizationId, targetUserId, permission);
    const { grant } = await this.deps.repos.permissionGrants.insertIfAbsent(
      {
        organizationId,
        userId: targetUserId,
        permission,
        grantedByUserId: actorUserId,
        grantedAt: this.deps.clock.now(),
      },
      changeAudit(AuditAction.PermissionGranted, actorUserId, target, permission),
    );
    return grant;
  }

  /** Revoke an individual grant. Revocation is prospective; nothing already done is undone. */
  async revoke(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    permission: Permission,
  ): Promise<void> {
    const { target } = await this.authorizeChange("revoke", actorUserId, organizationId, targetUserId, permission);
    const audit = changeAudit(AuditAction.PermissionRevoked, actorUserId, target, permission);
    if (!(await this.deps.repos.permissionGrants.remove(organizationId, targetUserId, permission, audit))) {
      throw new AppError("NOT_FOUND", "The member holds no such individual grant");
    }
  }

  /** A member's individual grants (not its template's permissions). */
  async listForMember(actorUserId: string, organizationId: string, targetUserId: string): Promise<PermissionGrant[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member.view");
    if (!(await this.deps.repos.memberships.find(organizationId, targetUserId))) {
      throw new AppError("NOT_FOUND", "Membership not found");
    }
    return this.deps.repos.permissionGrants.listForMember(organizationId, targetUserId);
  }

  /**
   * The actor and target of a grant change the actor may make. A non-member is
   * refused as any other organization access is, unaudited; a member is refused
   * and audited, first for lacking `permission.manage`, then past the ceiling.
   */
  private async authorizeChange(
    operation: "grant" | "revoke",
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    permission: Permission,
  ): Promise<{ actor: AuthContext; target: Membership }> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId);
    if (!actor.permissions.includes("permission.manage")) {
      await this.refuse(actor, operation, targetUserId, null, permission, "lacks_permission_manage");
    }
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    const refusal = grantRefusal(operation, actor.role, actor.permissions, target.role, permission);
    if (refusal !== null) await this.refuse(actor, operation, targetUserId, target.role, permission, refusal);
    return { actor, target };
  }

  private async refuse(
    actor: AuthContext,
    operation: "grant" | "revoke",
    targetUserId: string,
    targetRole: Role | null,
    permission: Permission,
    reason: GrantRefusal | "lacks_permission_manage",
  ): Promise<never> {
    await recordAudit(this.deps, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: AuditAction.PermissionGrantRefused,
      resourceType: "membership",
      resourceId: `${actor.organizationId}:${targetUserId}`,
      metadata: { operation, reason, actorRole: actor.role, targetUserId, targetRole, permission },
    });
    throw new AppError("FORBIDDEN", `Role ${actor.role} may not ${operation} '${permission}' here`);
  }
}

/** The audit entry a grant change commits with it. */
function changeAudit(
  action: typeof AuditAction.PermissionGranted | typeof AuditAction.PermissionRevoked,
  actorUserId: string,
  target: Membership,
  permission: Permission,
): GrantChangeAudit {
  return {
    organizationId: target.organizationId,
    actorUserId,
    action,
    resourceType: "membership",
    resourceId: `${target.organizationId}:${target.userId}`,
    metadata: { targetUserId: target.userId, targetRole: target.role, permission },
  };
}
