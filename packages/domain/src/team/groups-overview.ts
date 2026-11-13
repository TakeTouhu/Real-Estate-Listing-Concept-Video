import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import { ROLES, type Role } from "../identity/roles";

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
  readonly email: string;
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

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class GroupsOverviewService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * The organization's groups with their members.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `group.view`.
   */
  async overview(actorUserId: string, organizationId: string): Promise<GroupsOverview> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId, "group.view");
    const { repos } = this.deps;
    const [groups, memberships] = await Promise.all([
      repos.groups.listByOrganization(organizationId),
      repos.memberships.listByOrganization(organizationId),
    ]);
    // Asked for together, so the database client reads them in as few queries as it can.
    const [groupMembers, users] = await Promise.all([
      Promise.all(groups.map(({ id }) => repos.groups.listMembers(organizationId, id))),
      Promise.all(memberships.map(({ userId }) => repos.users.findById(userId))),
    ]);
    // In the members page's order (ADR-0134); an account removed between the reads is no longer a member.
    const members = memberships
      .map((membership, index) => ({ membership, user: users[index] ?? null }))
      .sort(
        (a, b) =>
          ROLES.indexOf(a.membership.role) - ROLES.indexOf(b.membership.role) ||
          a.membership.createdAt.getTime() - b.membership.createdAt.getTime() ||
          compareIds(a.membership.userId, b.membership.userId),
      )
      .flatMap(({ membership: { userId, role }, user }): GroupsOverviewMember[] =>
        user === null ? [] : [{ userId, name: user.name, email: user.email, role }],
      );
    const manages = actor.permissions.includes("group.manage");
    return {
      groups: groups.map(({ id, name }, index) => {
        const ids = new Set((groupMembers[index] ?? []).map(({ userId }) => userId));
        // A member who left the organization between the reads is in no group.
        return { id, name, members: members.filter(({ userId }) => ids.has(userId)) };
      }),
      mayManage: manages,
      mayDelete: manages && (actor.role === "OWNER" || actor.role === "ADMIN"),
    };
  }
}
