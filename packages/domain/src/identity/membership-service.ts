import { AppError } from "@app/shared";
import { AuditAction, recordAudit } from "./audit";
import { authorizeOrganization, effectivePermissionsOf, type AuthContext } from "./authorization";
import type { IdentityServiceDeps, MembershipChangeOutcome } from "./ports";
import { mayAssignRole, scopeForRole, type Permission, type Role } from "./roles";
import type { Invitation, Membership } from "./types";
import { normalizeEmail } from "./util";

export interface MembershipServiceOptions {
  readonly invitationTtlSeconds: number;
}

export interface InviteInput {
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
}

export interface InviteResult {
  readonly invitation: Invitation;
  /** Raw invitation token — returned once; only its hash is stored. */
  readonly token: string;
}

/** What a refused role change was trying to do, for its audit entry. */
interface RefusedChange {
  readonly operation: "invite" | "change_role" | "remove_member" | "accept_invitation";
  readonly resourceType: "organization" | "membership" | "invitation";
  readonly resourceId: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Who holds which role, under the role-assignment ceiling (ADR-0052 Decision 10).
 *
 * Every path that gives or takes a role — invitation, its acceptance, role
 * change, removal — asks `mayAssignRole` of every role it touches, so no member
 * can reach a role it could not assign directly. A member refused on any of
 * these paths is audited: a refused escalation attempt is an event, not a silent
 * no-op.
 *
 * Each change commits in one transaction with its audit entry, and only against
 * the state its checks read (ADR-0059): a member whose role changed meanwhile is
 * not changed again on the strength of the old role.
 */
export class MembershipService {
  constructor(
    private readonly deps: IdentityServiceDeps,
    private readonly options: MembershipServiceOptions,
  ) {}

  async invite(actorUserId: string, input: InviteInput): Promise<InviteResult> {
    const email = normalizeEmail(input.email);
    const refused: RefusedChange = {
      operation: "invite",
      resourceType: "organization",
      resourceId: input.organizationId,
      metadata: { email, requestedRole: input.role },
    };
    const actor = await this.requireMemberPermission(actorUserId, input.organizationId, "member.manage", refused);
    if (!mayAssignRole(actor.role, input.role)) await this.refuse(actor, refused);
    if (await this.deps.repos.invitations.findPending(input.organizationId, email)) {
      throw new AppError("VALIDATION_FAILED", "A pending invitation already exists for this email");
    }
    const token = this.deps.tokens.generate();
    const now = this.deps.clock.now();
    const id = this.deps.ids.generate("inv");
    const invitation = await this.deps.repos.invitations.create(
      {
        id,
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: this.deps.tokens.hash(token),
        status: "PENDING",
        invitedByUserId: actorUserId,
        expiresAt: new Date(now.getTime() + this.options.invitationTtlSeconds * 1000),
        acceptedAt: null,
      },
      {
        organizationId: input.organizationId,
        actorUserId,
        action: AuditAction.InvitationCreated,
        resourceType: "invitation",
        resourceId: id,
        metadata: { email, role: input.role },
      },
    );
    return { invitation, token };
  }

  async acceptInvitation(userId: string, token: string): Promise<Membership> {
    const invitation = await this.deps.repos.invitations.findByTokenHash(this.deps.tokens.hash(token));
    if (!invitation || invitation.status !== "PENDING") {
      throw new AppError("NOT_FOUND", "Invitation is invalid or already used");
    }
    if (invitation.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      await this.deps.repos.invitations.expire(invitation.id);
      throw new AppError("VALIDATION_FAILED", "Invitation has expired");
    }
    const existing = await this.deps.repos.memberships.find(invitation.organizationId, userId);
    if (existing) {
      throw new AppError("VALIDATION_FAILED", "User is already a member of this organization");
    }
    // Acceptance is where the role is actually granted, so the ceiling is asked
    // again of the inviter as it is now: an invitation outlives nothing its
    // inviter has since lost.
    const inviter = await this.deps.repos.memberships.find(invitation.organizationId, invitation.invitedByUserId);
    const inviterPermissions = inviter === null ? [] : await effectivePermissionsOf(this.deps, inviter);
    if (
      inviter === null ||
      !inviterPermissions.includes("member.manage") ||
      !mayAssignRole(inviter.role, invitation.role)
    ) {
      await recordAudit(this.deps, {
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: AuditAction.RoleChangeRefused,
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: {
          operation: "accept_invitation",
          requestedRole: invitation.role,
          invitedByUserId: invitation.invitedByUserId,
          inviterRole: inviter?.role ?? null,
        },
      });
      throw new AppError("FORBIDDEN", "This invitation can no longer be accepted");
    }
    // The checks above read; the acceptance writes only if the invitation is
    // still pending and the user still no member, so a concurrent acceptance
    // cannot make a second membership.
    const accepted = await this.deps.repos.invitations.accept(invitation, userId, this.deps.clock.now(), {
      organizationId: invitation.organizationId,
      actorUserId: userId,
      action: AuditAction.InvitationAccepted,
      resourceType: "membership",
      resourceId: `${invitation.organizationId}:${userId}`,
      metadata: { role: invitation.role, scope: scopeForRole(invitation.role) },
    });
    if (accepted.outcome === "STALE") throw new AppError("NOT_FOUND", "Invitation is invalid or already used");
    if (accepted.outcome === "ALREADY_MEMBER") {
      throw new AppError("VALIDATION_FAILED", "User is already a member of this organization");
    }
    return accepted.membership;
  }

  async listMembers(actorUserId: string, organizationId: string): Promise<Membership[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member.view");
    return this.deps.repos.memberships.listByOrganization(organizationId);
  }

  async changeRole(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    role: Role,
  ): Promise<Membership> {
    const refused = (currentRole: Role | null): RefusedChange => ({
      operation: "change_role",
      resourceType: "membership",
      resourceId: `${organizationId}:${targetUserId}`,
      metadata: { targetUserId, currentRole, requestedRole: role },
    });
    const actor = await this.requireMemberPermission(actorUserId, organizationId, "permission.manage", refused(null));
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    if (!mayAssignRole(actor.role, target.role) || !mayAssignRole(actor.role, role)) {
      await this.refuse(actor, refused(target.role));
    }
    // The ceiling was asked of the role just read: the change applies only while
    // the member still holds it, and never takes the last OWNER away.
    assertApplied(
      await this.deps.repos.memberships.changeRole(organizationId, targetUserId, target.role, role, {
        organizationId,
        actorUserId,
        action: AuditAction.MemberRoleChanged,
        resourceType: "membership",
        resourceId: `${organizationId}:${targetUserId}`,
        metadata: { targetUserId, role, previousRole: target.role, scope: scopeForRole(role) },
      }),
    );
    return { ...target, role };
  }

  async removeMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    const refused = (currentRole: Role | null): RefusedChange => ({
      operation: "remove_member",
      resourceType: "membership",
      resourceId: `${organizationId}:${targetUserId}`,
      metadata: { targetUserId, currentRole },
    });
    const actor = await this.requireMemberPermission(actorUserId, organizationId, "member.manage", refused(null));
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    // Removing a member takes its role away, so the ceiling is asked of it.
    if (!mayAssignRole(actor.role, target.role)) await this.refuse(actor, refused(target.role));
    assertApplied(
      await this.deps.repos.memberships.remove(organizationId, targetUserId, target.role, {
        organizationId,
        actorUserId,
        action: AuditAction.MemberRemoved,
        resourceType: "membership",
        resourceId: `${organizationId}:${targetUserId}`,
        metadata: {},
      }),
    );
  }

  /**
   * The actor's membership, holding `permission`. A non-member is refused as any
   * other organization access is, unaudited; a member lacking the permission is
   * refused and audited.
   */
  private async requireMemberPermission(
    actorUserId: string,
    organizationId: string,
    permission: Permission,
    refused: RefusedChange,
  ): Promise<AuthContext> {
    const actor = await authorizeOrganization(this.deps, actorUserId, organizationId);
    if (!actor.permissions.includes(permission)) await this.refuse(actor, refused);
    return actor;
  }

  private async refuse(actor: AuthContext, refused: RefusedChange): Promise<never> {
    await recordAudit(this.deps, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: AuditAction.RoleChangeRefused,
      resourceType: refused.resourceType,
      resourceId: refused.resourceId,
      metadata: { operation: refused.operation, actorRole: actor.role, ...refused.metadata },
    });
    throw new AppError("FORBIDDEN", `Role ${actor.role} may not make this role change`);
  }
}

/** A role change or removal that wrote nothing is refused, saying why. */
function assertApplied(outcome: MembershipChangeOutcome): void {
  if (outcome === "LAST_OWNER") throw new AppError("VALIDATION_FAILED", "Cannot remove or demote the last owner");
  if (outcome === "STALE") throw new AppError("VALIDATION_FAILED", "This member changed meanwhile; reload and try again");
}
