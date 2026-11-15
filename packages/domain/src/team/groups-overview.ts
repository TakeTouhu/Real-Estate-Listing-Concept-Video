import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import { mayAssignRole, type Role } from "../identity/roles";
import { compareMembers } from "./member-order";

/**
 * An organization's groups and who belongs to each, as a holder of
 * `group.view` sees them (AT-9a, ADR-0141), and what the viewer may do with
 * them: create and rename with `group.manage`, delete only as an `OWNER` or
 * `ADMIN` holding it too (ADR-0052 Decision 11, ADR-0060), and add or remove a
 * member with `group.manage` and the role-assignment ceiling on the member's
 * role (AT-9c, ADR-0143).
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
  /** Whether the viewer may remove the member from the group: `group.manage` and the ceiling on their role. */
  readonly mayRemove: boolean;
}

export interface GroupsOverviewGroup {
  readonly id: string;
  readonly name: string;
  /** By role, `OWNER` first, then the longest-standing member first. */
  readonly members: readonly GroupsOverviewGroupMember[];
  /**
   * The organization's members not in the group whose role the viewer may
   * assign, in the same order, for a holder of `group.manage`; none for
   * anyone else.
   */
  readonly addable: readonly GroupsOverviewMember[];
}

export interface GroupsOverview {
  /** By name. */
  readonly groups: readonly GroupsOverviewGroup[];
  /** Whether the viewer holds `group.manage`, which creating and renaming a group need. */
  readonly mayManage: boolean;
  /**
   * Whether the viewer may delete a group: `group.manage` and the `OWNER` or
   * `ADMIN` role, which no grant gives (ADR-0052 Decision 11).
   */
  readonly mayDelete: boolean;
}

export class GroupsOverviewService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * The organization's groups with their members, in three reads and one
   * read of the accounts of the members in a group or the viewer may add to
   * one, however many groups there are.
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
    // Asked for together, so the database client reads the accounts in one query.
    const users = await Promise.all(shown.map(({ userId }) => repos.users.findById(userId)));
    // The members page's own question: whose addresses the viewer may see (ADR-0134).
    const addresses = actor.permissions.includes("member.view");
    // An account removed between the reads is no longer a member.
    const members = shown.flatMap(({ userId, role }, index): GroupsOverviewMember[] => {
      const user = users[index];
      return user ? [{ userId, name: user.name, email: addresses ? user.email : null, role }] : [];
    });
    return {
      groups: groups.map(({ id, name }) => {
        const ids = new Set(rows.filter(({ groupId }) => groupId === id).map(({ userId }) => userId));
        return {
          id,
          name,
          members: members.filter(({ userId }) => ids.has(userId)).map((m) => ({ ...m, mayRemove: mayChange(m.role) })),
          addable: members.filter(({ userId, role }) => !ids.has(userId) && mayChange(role)),
        };
      }),
      mayManage: manages,
      mayDelete: manages && (actor.role === "OWNER" || actor.role === "ADMIN"),
    };
  }
}
