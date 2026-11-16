import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import { groupGrantRefusal, mayAssignRole, PERMISSIONS, type Permission, type Role } from "../identity/roles";
import { compareMembers } from "./member-order";

/**
 * An organization's groups, who belongs to each and the permissions each
 * gives its members, as a holder of `group.view` sees them (AT-9a, ADR-0141;
 * AT-11c, ADR-0148), and what the viewer may do with them, as `GroupService`
 * decides: create and rename with `group.manage`; delete only as an `OWNER`
 * or `ADMIN` holding it too (ADR-0052 Decision 11, ADR-0060); add or remove a
 * member with `group.manage` and the role-assignment ceiling on the member's
 * role (AT-9c, ADR-0143); and give a group a permission or take one back with
 * `permission.manage`. Whatever gives or takes a permission is also asked of
 * the grant ceiling (ADR-0061), as the service asks it.
 *
 * **Read only.** Viewing writes nothing and audits nothing, as a `group.view`
 * listing never has.
 */

export interface GroupsOverviewMember {
  readonly userId: string;
  readonly name: string;
  /** The member's address, for a viewer who also holds `member.view`; `null` for anyone else. */
  readonly email: string | null;
  readonly role: Role;
}

export interface GroupsOverviewGroupMember extends GroupsOverviewMember {
  /**
   * Whether the viewer may remove the member from the group: `group.manage`,
   * the ceiling on their role, and the grant ceiling on taking each permission
   * the group gives (ADR-0148 Decision 2).
   */
  readonly mayRemove: boolean;
}

export interface GroupsOverviewGroup {
  readonly id: string;
  readonly name: string;
  /** By role, `OWNER` first, then the longest-standing member first. */
  readonly members: readonly GroupsOverviewGroupMember[];
  /**
   * The organization's members not in the group whose role the viewer may
   * assign, in the same order, for a holder of `group.manage` who may also
   * give each permission the group gives (ADR-0148 Decision 2); none for
   * anyone else.
   */
  readonly addable: readonly GroupsOverviewMember[];
  /** The permissions the group gives each of its members, in vocabulary order. */
  readonly permissions: readonly Permission[];
  /**
   * The permissions the viewer may give the group, in vocabulary order: ones
   * it does not give, for a holder of `permission.manage`, within the grant
   * ceiling for the viewer and for every member's role.
   */
  readonly givable: readonly Permission[];
  /** Those of `permissions` the viewer may take back from the group, under the same ceiling. */
  readonly revocable: readonly Permission[];
  /**
   * Whether the viewer may delete the group: `group.manage` and the `OWNER` or
   * `ADMIN` role, which no grant gives (ADR-0052 Decision 11), and, for a group
   * giving any permission, the ceiling on taking each from each member.
   */
  readonly mayDelete: boolean;
}

export interface GroupsOverview {
  /** By name. */
  readonly groups: readonly GroupsOverviewGroup[];
  /** Whether the viewer holds `group.manage`, which creating and renaming a group need. */
  readonly mayManage: boolean;
}

export class GroupsOverviewService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * The organization's groups with their members and permissions, in three
   * reads, then one of the groups' permissions and one of the accounts of the
   * members in a group or the viewer may add to one, however many groups
   * there are.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `group.view`.
   */
  async overview(actorUserId: string, organizationId: string): Promise<GroupsOverview> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId, "group.view");
    const { repos } = this.deps;
    const [groups, rows, memberships] = await Promise.all([
      repos.groups.listByOrganization(organizationId),
      repos.groups.listMembersByOrganization(organizationId),
      repos.memberships.listByOrganization(organizationId),
    ]);
    const manages = actor.permissions.includes("group.manage");
    // The group service's own first two questions of a membership change, asked of the roles as read.
    const mayChange = (role: Role) => manages && mayAssignRole(actor.role, role);
    const grouped = new Set(rows.map(({ userId }) => userId));
    // Members in some group, and those the viewer may add to one. One who left between the reads is neither.
    const shown = memberships.filter(({ userId, role }) => grouped.has(userId) || mayChange(role)).sort(compareMembers);
    // The accounts asked for together, so the database client reads them in one query.
    const [carried, users] = await Promise.all([
      repos.groups.listPermissionsOfGroups(organizationId, groups.map(({ id }) => id)),
      Promise.all(shown.map(({ userId }) => repos.users.findById(userId))),
    ]);
    // The members page's own question: whose addresses the viewer may see (ADR-0134).
    const addresses = actor.permissions.includes("member.view");
    // An account removed between the reads is no longer a member.
    const members = shown.flatMap(({ userId, role }, index): GroupsOverviewMember[] => {
      const user = users[index];
      return user ? [{ userId, name: user.name, email: addresses ? user.email : null, role }] : [];
    });
    // The grant ceiling's actor half (ADR-0061): whether the viewer may give a group `permission`, or take it.
    const mayPass = (permission: Permission) => groupGrantRefusal(actor.role, actor.permissions, permission) === null;
    const managesPermissions = actor.permissions.includes("permission.manage");
    const deletes = manages && (actor.role === "OWNER" || actor.role === "ADMIN");
    return {
      groups: groups.map(({ id, name }): GroupsOverviewGroup => {
        const ids = new Set(rows.filter(({ groupId }) => groupId === id).map(({ userId }) => userId));
        const own = members.filter(({ userId }) => ids.has(userId));
        const gives = new Set(carried.filter(({ groupId }) => groupId === id).map(({ permission }) => permission));
        const permissions = PERMISSIONS.filter((permission) => gives.has(permission));
        // What adding, removing or deleting gives or takes: each of the group's permissions.
        const passesAll = permissions.every(mayPass);
        // The ceiling's member half, for a change that gives or takes a permission: every member in reach.
        const reachesAll = own.every(({ role }) => mayAssignRole(actor.role, role));
        const mayChangePermission = (permission: Permission) => managesPermissions && reachesAll && mayPass(permission);
        return {
          id,
          name,
          members: own.map((m) => ({ ...m, mayRemove: mayChange(m.role) && passesAll })),
          addable: members.filter(({ userId, role }) => !ids.has(userId) && mayChange(role) && passesAll),
          permissions,
          givable: PERMISSIONS.filter((permission) => !gives.has(permission) && mayChangePermission(permission)),
          revocable: permissions.filter(mayChangePermission),
          mayDelete: deletes && passesAll && (permissions.length === 0 || reachesAll),
        };
      }),
      mayManage: manages,
    };
  }
}
