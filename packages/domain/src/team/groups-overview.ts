import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import type { Role } from "../identity/roles";
import { compareMembers } from "./member-order";

/**
 * An organization's groups and who belongs to each, as a holder of
 * `group.view` sees them (AT-9a, ADR-0141), and what the viewer may do with
 * them: create and rename with `group.manage`, delete only as an `OWNER` or
 * `ADMIN` holding it too (ADR-0052 Decision 11, ADR-0060).
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

export interface GroupsOverviewGroup {
  readonly id: string;
  readonly name: string;
  /** By role, `OWNER` first, then the longest-standing member first. */
  readonly members: readonly GroupsOverviewMember[];
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
   * read of the grouped members' accounts, however many groups there are.
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
    const grouped = new Set(rows.map(({ userId }) => userId));
    // A member who left the organization between the reads is in no group.
    const inGroups = memberships.filter(({ userId }) => grouped.has(userId)).sort(compareMembers);
    // Asked for together, so the database client reads the accounts in one query.
    const users = await Promise.all(inGroups.map(({ userId }) => repos.users.findById(userId)));
    // The members page's own question: whose addresses the viewer may see (ADR-0134).
    const addresses = actor.permissions.includes("member.view");
    // An account removed between the reads is no longer a member.
    const members = inGroups.flatMap(({ userId, role }, index): GroupsOverviewMember[] => {
      const user = users[index];
      return user ? [{ userId, name: user.name, email: addresses ? user.email : null, role }] : [];
    });
    const manages = actor.permissions.includes("group.manage");
    return {
      groups: groups.map(({ id, name }) => {
        const ids = new Set(rows.filter(({ groupId }) => groupId === id).map(({ userId }) => userId));
        return { id, name, members: members.filter(({ userId }) => ids.has(userId)) };
      }),
      mayManage: manages,
      mayDelete: manages && (actor.role === "OWNER" || actor.role === "ADMIN"),
    };
  }
}
