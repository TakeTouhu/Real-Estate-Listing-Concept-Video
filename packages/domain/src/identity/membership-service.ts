import { AppError } from "@app/shared";
import { AuditAction, recordAudit } from "./audit";
import { authorizeOrganization } from "./authorization";
import type { IdentityServiceDeps } from "./ports";
import type { Role } from "./roles";
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

export class MembershipService {
  constructor(
    private readonly deps: IdentityServiceDeps,
    private readonly options: MembershipServiceOptions,
  ) {}

  async invite(actorUserId: string, input: InviteInput): Promise<InviteResult> {
    await authorizeOrganization(this.deps, actorUserId, input.organizationId, "member:manage");
    const email = normalizeEmail(input.email);
    if (await this.deps.repos.invitations.findPending(input.organizationId, email)) {
      throw new AppError("VALIDATION_FAILED", "A pending invitation already exists for this email");
    }
    const token = this.deps.tokens.generate();
    const now = this.deps.clock.now();
    const invitation = await this.deps.repos.invitations.create({
      id: this.deps.ids.generate("inv"),
      organizationId: input.organizationId,
      email,
      role: input.role,
      tokenHash: this.deps.tokens.hash(token),
      status: "PENDING",
      invitedByUserId: actorUserId,
      expiresAt: new Date(now.getTime() + this.options.invitationTtlSeconds * 1000),
      acceptedAt: null,
    });
    await recordAudit(this.deps, {
      organizationId: input.organizationId,
      actorUserId,
      action: AuditAction.InvitationCreated,
      resourceType: "invitation",
      resourceId: invitation.id,
      metadata: { email, role: input.role },
    });
    return { invitation, token };
  }

  async acceptInvitation(userId: string, token: string): Promise<Membership> {
    const invitation = await this.deps.repos.invitations.findByTokenHash(this.deps.tokens.hash(token));
    if (!invitation || invitation.status !== "PENDING") {
      throw new AppError("NOT_FOUND", "Invitation is invalid or already used");
    }
    if (invitation.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      await this.deps.repos.invitations.update({ ...invitation, status: "EXPIRED" });
      throw new AppError("VALIDATION_FAILED", "Invitation has expired");
    }
    const existing = await this.deps.repos.memberships.find(invitation.organizationId, userId);
    if (existing) {
      throw new AppError("VALIDATION_FAILED", "User is already a member of this organization");
    }
    const membership = await this.deps.repos.memberships.create({
      organizationId: invitation.organizationId,
      userId,
      role: invitation.role,
    });
    await this.deps.repos.invitations.update({
      ...invitation,
      status: "ACCEPTED",
      acceptedAt: this.deps.clock.now(),
    });
    await recordAudit(this.deps, {
      organizationId: invitation.organizationId,
      actorUserId: userId,
      action: AuditAction.InvitationAccepted,
      resourceType: "membership",
      resourceId: `${invitation.organizationId}:${userId}`,
      metadata: { role: invitation.role },
    });
    return membership;
  }

  async listMembers(actorUserId: string, organizationId: string): Promise<Membership[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member:read");
    return this.deps.repos.memberships.listByOrganization(organizationId);
  }

  async changeRole(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    role: Role,
  ): Promise<Membership> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member:manage");
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    if (target.role === "OWNER" && role !== "OWNER") {
      await this.assertNotLastOwner(organizationId, targetUserId);
    }
    const updated = await this.deps.repos.memberships.updateRole(organizationId, targetUserId, role);
    await recordAudit(this.deps, {
      organizationId,
      actorUserId,
      action: AuditAction.MemberRoleChanged,
      resourceType: "membership",
      resourceId: `${organizationId}:${targetUserId}`,
      metadata: { role, previousRole: target.role },
    });
    return updated;
  }

  async removeMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member:manage");
    const target = await this.deps.repos.memberships.find(organizationId, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "Membership not found");
    if (target.role === "OWNER") {
      await this.assertNotLastOwner(organizationId, targetUserId);
    }
    await this.deps.repos.memberships.remove(organizationId, targetUserId);
    await recordAudit(this.deps, {
      organizationId,
      actorUserId,
      action: AuditAction.MemberRemoved,
      resourceType: "membership",
      resourceId: `${organizationId}:${targetUserId}`,
    });
  }

  private async assertNotLastOwner(organizationId: string, targetUserId: string): Promise<void> {
    const members = await this.deps.repos.memberships.listByOrganization(organizationId);
    const owners = members.filter((m) => m.role === "OWNER");
    if (owners.length <= 1 && owners.some((m) => m.userId === targetUserId)) {
      throw new AppError("VALIDATION_FAILED", "Cannot remove or demote the last owner");
    }
  }
}
