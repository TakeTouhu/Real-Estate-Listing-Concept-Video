import type { SubscriptionRepository } from "../entitlement/subscription";
import { authorizeOrganization } from "../identity/authorization";
import type { IdentityServiceDeps } from "../identity/ports";
import { ROLES, mayAssignRole, type Role } from "../identity/roles";
import { holdsSeat, includedSeats } from "./seats";

/**
 * Who belongs to an organization, who is invited to it, and its seats, as a
 * holder of `member.view` sees them (AT-5, ADR-0134), and which roles the
 * viewer may invite with (AT-6b, ADR-0136), remove the members of (AT-8b,
 * ADR-0140) and give a member (AT-8a, ADR-0139).
 *
 * **Read only.** Viewing writes nothing and audits nothing, as a `member.view`
 * listing never has: an invitation past its expiry is left as it is and simply
 * not shown.
 */

export interface MembersOverviewMember {
  /** What changing the member's role names: the account's id, which accepts nothing. */
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: Date;
  /** Whether this member is the one viewing. */
  readonly you: boolean;
}

/** A pending invitation that has not expired. */
export interface MembersOverviewInvitation {
  /** What cancelling it names; it carries nothing that accepts it. */
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedAt: Date;
  readonly expiresAt: Date;
}

export interface MembersOverview {
  /** By role, `OWNER` first, then the longest-standing member first. */
  readonly members: readonly MembersOverviewMember[];
  /** Oldest first. */
  readonly invitations: readonly MembersOverviewInvitation[];
  /**
   * `null` while the organization has no plan. `taken` counts the members and
   * the invitations above, and is shown as it is even above `included`.
   */
  readonly seats: { readonly included: number; readonly taken: number } | null;
  /**
   * The roles the viewer may invite with, and so whose invitations it may
   * cancel and whose members it may remove (AT-8b, ADR-0140): with
   * `member.manage`, those its role may assign (ADR-0052 Decision 10);
   * without it, none. In the order of `ROLES`.
   */
  readonly invitableRoles: readonly Role[];
  /**
   * The roles the viewer may give a member, and so the members whose role it
   * may change, from one of these to another (AT-8a, ADR-0139): with
   * `permission.manage`, those its role may assign (ADR-0052 Decision 10);
   * without it, none. In the order of `ROLES`.
   */
  readonly assignableRoles: readonly Role[];
}

export interface MembersOverviewDeps {
  /** Members, invitations, accounts, authorization and the clock. */
  readonly identity: IdentityServiceDeps;
  readonly subscriptions: Pick<SubscriptionRepository, "findByOrganization">;
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class MembersOverviewService {
  constructor(private readonly deps: MembersOverviewDeps) {}

  /**
   * The organization's members, its pending invitations that have not expired,
   * and its seats.
   *
   * @throws AppError FORBIDDEN for a non-member, or a member without `member.view`.
   */
  async overview(actorUserId: string, organizationId: string): Promise<MembersOverview> {
    const { identity } = this.deps;
    const actor = await authorizeOrganization(identity, actorUserId, organizationId, "member.view");
    const now = identity.clock.now();
    const [memberships, invitations, subscription] = await Promise.all([
      identity.repos.memberships.listByOrganization(organizationId),
      identity.repos.invitations.listByOrganization(organizationId),
      this.deps.subscriptions.findByOrganization(organizationId),
    ]);
    // Asked for together, so the database client reads the accounts in one query.
    const users = await Promise.all(memberships.map(({ userId }) => identity.repos.users.findById(userId)));

    const members = memberships
      .map((membership, index) => ({ membership, user: users[index] ?? null }))
      .sort(
        (a, b) =>
          ROLES.indexOf(a.membership.role) - ROLES.indexOf(b.membership.role) ||
          a.membership.createdAt.getTime() - b.membership.createdAt.getTime() ||
          compareIds(a.membership.userId, b.membership.userId),
      )
      // An account removed between the two reads is no longer a member.
      .flatMap(({ membership, user }) =>
        user === null
          ? []
          : [
              {
                userId: membership.userId,
                name: user.name,
                email: user.email,
                role: membership.role,
                joinedAt: membership.createdAt,
                you: membership.userId === actorUserId,
              },
            ],
      );
    const pending = invitations
      .filter((invitation) => holdsSeat(invitation, now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id))
      .map(({ id, email, role, createdAt, expiresAt }) => ({ id, email, role, invitedAt: createdAt, expiresAt }));
    const included = includedSeats(subscription);
    const assignable = ROLES.filter((role) => mayAssignRole(actor.role, role));
    return {
      members,
      invitations: pending,
      seats: included === null ? null : { included, taken: members.length + pending.length },
      invitableRoles: actor.permissions.includes("member.manage") ? assignable : [],
      assignableRoles: actor.permissions.includes("permission.manage") ? assignable : [],
    };
  }
}
