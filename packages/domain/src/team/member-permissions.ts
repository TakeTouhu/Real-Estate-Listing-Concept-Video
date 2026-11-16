import { AppError } from "@app/shared";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import {
  GRANTABLE_PERMISSIONS,
  effectivePermissions,
  grantRefusal,
  hasPermission,
  scopeForRole,
  type Permission,
  type Role,
  type Scope,
} from "../identity/roles";

/**
 * What one member of an organization may do, and where each permission comes
 * from, as a holder of `member.view` sees it (AT-11a, ADR-0146), and which
 * individual grants the viewer may give or take back (AT-11b, ADR-0147).
 *
 * **Read only.** Viewing writes nothing and audits nothing, as a `member.view`
 * listing never has.
 */

export interface MemberPermission {
  readonly permission: Permission;
  /** Whether the member may do it now: `effectivePermissions` of its role, grants and groups. */
  readonly effective: boolean;
  /** Whether its role's template gives it. */
  readonly fromRole: boolean;
  /** Whether an individual grant gives it. */
  readonly granted: boolean;
  /** How many of the member's groups give it. No group carries `disclosure.none` (a database check). */
  readonly groupCount: number;
  /** Those groups' names, by name, for a viewer holding `group.view`; `null` for anyone else. */
  readonly groupNames: readonly string[] | null;
  /**
   * Whether the viewer may give it to the member individually: the member holds no such grant, and the viewer's
   * `permission.manage` and the grant ceiling allow it, as `PermissionGrantService.grant` decides (ADR-0058).
   */
  readonly mayGrant: boolean;
  /** Whether the viewer may take back the member's individual grant of it: they hold one, and the ceiling allows it. */
  readonly mayRevoke: boolean;
}

export interface MemberPermissions {
  readonly member: {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly role: Role;
    /** Whether this member is the one viewing. */
    readonly you: boolean;
  };
  /** Which Properties the member's permissions over Properties apply to: fixed by role. */
  readonly scope: Scope;
  /** Every permission a member can hold, in vocabulary order: all but `video.share`, which no one holds. */
  readonly permissions: readonly MemberPermission[];
}

export class MemberPermissionsService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * A member's permissions and their sources: its role, its individual grants
   * and the permissions of the groups it belongs to.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `member.view`.
   * @throws AppError NOT_FOUND when `memberUserId` is not a member of the organization.
   */
  async view(actorUserId: string, organizationId: string, memberUserId: string): Promise<MemberPermissions> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId, "member.view");
    const { repos } = this.deps;
    const membership = await repos.memberships.find(organizationId, memberUserId);
    if (!membership) throw new AppError("NOT_FOUND", "Membership not found");
    const [user, grants, groupIds, groups] = await Promise.all([
      repos.users.findById(memberUserId),
      repos.permissionGrants.listForMember(organizationId, memberUserId),
      repos.groups.listGroupIdsForMember(organizationId, memberUserId),
      repos.groups.listByOrganization(organizationId),
    ]);
    // An account removed between the reads is no longer a member.
    if (!user) throw new AppError("NOT_FOUND", "Membership not found");
    const own = groups.filter(({ id }) => groupIds.includes(id));
    const carried = await Promise.all(own.map(({ id }) => repos.groups.listPermissions(organizationId, id)));
    const granted = grants.map(({ permission }) => permission);
    const effective = effectivePermissions(
      membership.role,
      granted,
      carried.flatMap((rows) => rows.map(({ permission }) => permission)),
    );
    const namesShown = actor.permissions.includes("group.view");
    const manages = actor.permissions.includes("permission.manage");
    const allows = (operation: "grant" | "revoke", permission: Permission) =>
      manages && grantRefusal(operation, actor.role, actor.permissions, membership.role, permission) === null;
    return {
      member: {
        userId: memberUserId,
        name: user.name,
        email: user.email,
        role: membership.role,
        you: memberUserId === actorUserId,
      },
      scope: scopeForRole(membership.role),
      permissions: GRANTABLE_PERMISSIONS.map((permission) => {
        const giving = own.filter((_, index) => carried[index]?.some((row) => row.permission === permission));
        const held = granted.includes(permission);
        return {
          permission,
          effective: effective.includes(permission),
          fromRole: hasPermission(membership.role, permission),
          granted: held,
          groupCount: giving.length,
          groupNames: namesShown ? giving.map(({ name }) => name) : null,
          mayGrant: !held && allows("grant", permission),
          mayRevoke: held && allows("revoke", permission),
        };
      }),
    };
  }
}
