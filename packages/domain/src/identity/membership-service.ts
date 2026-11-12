import { AppError } from "@app/shared";
import { isDeliverableEmailAddress, outgoingEmail, type OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { AuditAction, recordAudit } from "./audit";
import { ACCOUNT_LINK_TOKEN_MAX_LENGTH } from "./email-verification-service";
import { authorizeOrganization, effectivePermissionsOf, type AuthContext } from "./authorization";
import type { IdentityServiceDeps, InvitationAcceptance, InvitationCreation, MembershipChangeOutcome } from "./ports";
import { mayAssignRole, scopeForRole, type Permission, type Role } from "./roles";
import type { Invitation, Membership } from "./types";
import { normalizeEmail } from "./util";

/** How long an invitation works: 7 days, as the approved plan keeps it (ADR-0135). */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface MembershipServiceOptions {
  /** {@link INVITATION_TTL_SECONDS} in the product. */
  readonly invitationTtlSeconds: number;
  /**
   * The seats the organization's plan includes, or `null` while it has no plan
   * (ADR-0134). An invitation is refused without a plan, and beyond its seats
   * (ADR-0135).
   */
  readonly includedSeats: (organizationId: string) => Promise<number | null>;
  /** Where an invitation's email goes (ADR-0126). */
  readonly email: EmailSender;
  /**
   * The address of the page that accepts `token`. The application builds it
   * from its own configured base URL, never from a request's headers.
   */
  readonly invitationUrl: (token: string) => string;
}

export interface InviteInput {
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
}

export interface InviteResult {
  readonly invitation: Invitation;
  /**
   * Raw invitation token — returned once, and mailed; only its hash is stored.
   * It is the invitee's: no route or page may show it to the inviter.
   */
  readonly token: string;
}

/**
 * Why an invitation was not made (ADR-0135), as `details.reason` of the
 * `VALIDATION_FAILED` it is refused with. `INVALID_EMAIL`: mail cannot reach
 * the address. `NO_PLAN`: the organization has no plan, so no seats. The rest
 * are the {@link InvitationCreation} refusals.
 */
export type InvitationRefusal = "INVALID_EMAIL" | "NO_PLAN" | Exclude<InvitationCreation["outcome"], "CREATED">;

const REFUSAL_MESSAGES: Record<InvitationRefusal, string> = {
  INVALID_EMAIL: "This is not an email address we can send an invitation to",
  NO_PLAN: "This organization has no plan yet, so it has no seats to invite anyone to",
  ALREADY_INVITED: "A pending invitation already exists for this email",
  ALREADY_MEMBER: "This email already belongs to a member of this organization",
  NO_SEAT: "Every seat is taken by a member or a pending invitation",
};

function refuseInvitation(reason: InvitationRefusal): never {
  throw new AppError("VALIDATION_FAILED", REFUSAL_MESSAGES[reason], { details: { reason } });
}

/**
 * Why an invitation was not accepted (ADR-0137), as `details.reason` of the
 * `VALIDATION_FAILED` it is refused with. `EXPIRED`: its 7 days are over.
 * `EMAIL_NOT_VERIFIED`: the signed-in account has not verified its address,
 * whichever it is. `WRONG_ACCOUNT`: it has, and it is not the invited one.
 * `NO_PLAN`: the organization has no plan, so no seats. The rest are the
 * {@link InvitationAcceptance} refusals.
 */
export type AcceptanceRefusal =
  | "EXPIRED"
  | "EMAIL_NOT_VERIFIED"
  | "WRONG_ACCOUNT"
  | "NO_PLAN"
  | Exclude<InvitationAcceptance["outcome"], "ACCEPTED" | "STALE">;

const ACCEPTANCE_REFUSAL_MESSAGES: Record<AcceptanceRefusal, string> = {
  EXPIRED: "Invitation has expired",
  EMAIL_NOT_VERIFIED: "Verify your email address before accepting this invitation",
  WRONG_ACCOUNT: "This invitation was sent to another email address",
  NO_PLAN: "This organization has no plan yet, so it has no seat to join",
  ALREADY_MEMBER: "User is already a member of this organization",
  NO_SEAT: "Every seat of this organization is taken by a member",
};

function refuseAcceptance(reason: AcceptanceRefusal): never {
  throw new AppError("VALIDATION_FAILED", ACCEPTANCE_REFUSAL_MESSAGES[reason], { details: { reason } });
}

/**
 * Whether an invitation can still be accepted as far as its own state goes:
 * `PENDING`, and not expired at `now`. One that expired stays `PENDING` until
 * something marks it, so the status alone does not say (ADR-0134, ADR-0135).
 */
export function isOpenInvitation(invitation: Pick<Invitation, "status" | "expiresAt">, now: Date): boolean {
  return invitation.status === "PENDING" && invitation.expiresAt.getTime() > now.getTime();
}

const ROLE_NAMES: Record<Role, string> = {
  OWNER: "an Owner",
  ADMIN: "an Admin",
  MANAGER: "a Manager",
  CREATOR: "a Creator",
  VIEWER: "a Viewer",
  BILLING: "a Billing member",
};

/** How long a link works, in whole days, or else in hours, rounded up, as the email and the members page say it. */
export function linkLifetime(seconds: number): string {
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.ceil(seconds / 3_600);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The longest organization name an invitation email quotes; a longer one is cut. */
const EMAIL_ORGANIZATION_NAME_MAX_LENGTH = 100;

/**
 * The organization's name as an email quotes it. It is the customer's text,
 * taken with no limit, so control and formatting characters (line breaks,
 * escapes, bidirectional overrides) become spaces, and it is kept to one line
 * of {@link EMAIL_ORGANIZATION_NAME_MAX_LENGTH} characters.
 */
function quotedOrganizationName(name: string): string {
  const plain = name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const chars = [...plain];
  return chars.length > EMAIL_ORGANIZATION_NAME_MAX_LENGTH
    ? `${chars.slice(0, EMAIL_ORGANIZATION_NAME_MAX_LENGTH - 1).join("").trimEnd()}…`
    : plain;
}

/** The invitation email: who invites, as what, and one link, in plain text. */
export function invitationMessage(
  to: string,
  organizationName: string,
  role: Role,
  url: string,
  ttlSeconds: number,
): OutgoingEmail {
  return outgoingEmail({
    kind: "INVITATION",
    to,
    subject: "You are invited to join an organization on VTaVision",
    text: [
      `You are invited to join ${quotedOrganizationName(organizationName)} on VTaVision as ${ROLE_NAMES[role]}.`,
      "",
      "Open the link below to accept. You sign in, or create an account, with this email address.",
      "",
      url,
      "",
      `The invitation expires in ${linkLifetime(ttlSeconds)}.`,
      "If you did not expect this invitation, you can ignore this email.",
    ].join("\n"),
  });
}

/**
 * What an open invitation offers, as the page its link opens shows it
 * (ADR-0138): never the invited address, nor who invited.
 */
export interface InvitationOffer {
  /** The organization's name, as the invitation email quotes it. */
  readonly organizationName: string;
  readonly role: Role;
  /** The role as the invitation email words it: "a Creator". */
  readonly invitedAs: string;
}

/** What a refused role change was trying to do, for its audit entry. */
interface RefusedChange {
  readonly operation: "invite" | "cancel_invitation" | "change_role" | "remove_member" | "accept_invitation";
  readonly resourceType: "organization" | "membership" | "invitation";
  readonly resourceId: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Who holds which role, under the role-assignment ceiling (ADR-0052 Decision 10).
 *
 * Every path that gives or takes a role — invitation, its cancellation, its
 * acceptance, role change, removal — asks `mayAssignRole` of every role it
 * touches, so no member can reach a role it could not assign directly. A
 * member refused on any of these paths is audited: a refused escalation
 * attempt is an event, not a silent no-op.
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

  /**
   * Invite an address to the organization with a role, within its seats, and
   * mail it the link (ADR-0135). Every member takes a seat, and so does every
   * pending invitation that has not expired; the count is made in the
   * transaction that writes the invitation. The link and the email are built
   * before anything is written, so an application with no base address writes
   * nothing; the email is sent after the invitation and its audit entry are
   * kept, and a send that fails leaves the invitation pending.
   *
   * @throws AppError FORBIDDEN for a non-member, or for a member without
   *   `member.manage` or past its ceiling (audited);
   *   VALIDATION_FAILED with an {@link InvitationRefusal} as `details.reason`.
   */
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
    if (!isDeliverableEmailAddress(email)) refuseInvitation("INVALID_EMAIL");
    const includedSeats = await this.options.includedSeats(input.organizationId);
    if (includedSeats === null) refuseInvitation("NO_PLAN");
    const organization = await this.deps.repos.organizations.findById(input.organizationId);
    if (!organization) throw new AppError("NOT_FOUND", "Organization not found");

    const token = this.deps.tokens.generate();
    const now = this.deps.clock.now();
    const message = invitationMessage(
      email,
      organization.name,
      input.role,
      this.options.invitationUrl(token),
      this.options.invitationTtlSeconds,
    );
    const id = this.deps.ids.generate("inv");
    const created = await this.deps.repos.invitations.create(
      {
        id,
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: this.deps.tokens.hash(token),
        invitedByUserId: actorUserId,
        expiresAt: new Date(now.getTime() + this.options.invitationTtlSeconds * 1000),
      },
      {
        organizationId: input.organizationId,
        actorUserId,
        action: AuditAction.InvitationCreated,
        resourceType: "invitation",
        resourceId: id,
        metadata: { email, role: input.role },
      },
      { includedSeats, now },
    );
    if (created.outcome !== "CREATED") refuseInvitation(created.outcome);
    await this.options.email.send(message);
    return { invitation: created.invitation, token };
  }

  /**
   * Cancel a pending invitation before anyone accepts it (ADR-0135): it no
   * longer works, and its seat is free. Cancelling takes the invited role
   * away, so the ceiling is asked of it, as removing a member does.
   *
   * @throws AppError FORBIDDEN as {@link MembershipService.invite} does;
   *   NOT_FOUND for an invitation of another organization, or one no longer
   *   pending or expired.
   */
  async cancelInvitation(actorUserId: string, organizationId: string, invitationId: string): Promise<void> {
    const refused = (invitedRole: Role | null): RefusedChange => ({
      operation: "cancel_invitation",
      resourceType: "invitation",
      resourceId: invitationId,
      metadata: { invitedRole },
    });
    const actor = await this.requireMemberPermission(actorUserId, organizationId, "member.manage", refused(null));
    const now = this.deps.clock.now();
    const invitation = await this.deps.repos.invitations.find(organizationId, invitationId);
    if (!invitation || !isOpenInvitation(invitation, now)) {
      throw new AppError("NOT_FOUND", "This invitation is no longer pending");
    }
    if (!mayAssignRole(actor.role, invitation.role)) await this.refuse(actor, refused(invitation.role));
    const revoked = await this.deps.repos.invitations.revoke(organizationId, invitationId, now, {
      organizationId,
      actorUserId,
      action: AuditAction.InvitationRevoked,
      resourceType: "invitation",
      resourceId: invitationId,
      metadata: { email: invitation.email, role: invitation.role },
    });
    if (revoked === "STALE") throw new AppError("NOT_FOUND", "This invitation is no longer pending");
  }

  /**
   * What the invitation of `token` offers, for the page its link opens
   * (ADR-0138), or `null` for a token of no invitation, of one no longer
   * pending or expired, or of an organization gone. The token is the key, as
   * the email it came in is, so no sign-in is asked. It reads and writes
   * nothing more: an expired invitation is not marked, so a mail scanner that
   * opens the link changes nothing.
   */
  async describeInvitation(token: string): Promise<InvitationOffer | null> {
    if (token.length === 0 || token.length > ACCOUNT_LINK_TOKEN_MAX_LENGTH) return null;
    const invitation = await this.deps.repos.invitations.findByTokenHash(this.deps.tokens.hash(token));
    if (!invitation || !isOpenInvitation(invitation, this.deps.clock.now())) return null;
    const organization = await this.deps.repos.organizations.findById(invitation.organizationId);
    if (!organization) return null;
    return {
      organizationName: quotedOrganizationName(organization.name),
      role: invitation.role,
      invitedAs: ROLE_NAMES[invitation.role],
    };
  }

  /**
   * Accept an invitation as the signed-in user, with the invited role
   * (ADR-0137). Only an account whose address is the invited one, once that
   * address is verified, accepts: the link alone accepts for no one. The
   * inviter's ceiling and the organization's plan are asked again, and the
   * acceptance needs a seat, counting members only: the invitation held its
   * own seat while it was pending. The seats are counted, and the membership
   * written, in one transaction under the organization's lock, as inviting
   * does (ADR-0135), so two acceptances racing for the last seat make one
   * member.
   *
   * @throws AppError NOT_FOUND for a token of no pending invitation, or an
   *   account that is gone or disabled; FORBIDDEN when the inviter may no
   *   longer give the role (audited); VALIDATION_FAILED with an
   *   {@link AcceptanceRefusal} as `details.reason`.
   */
  async acceptInvitation(userId: string, token: string): Promise<Membership> {
    const now = this.deps.clock.now();
    const invitation = await this.deps.repos.invitations.findByTokenHash(this.deps.tokens.hash(token));
    if (!invitation || invitation.status !== "PENDING") {
      throw new AppError("NOT_FOUND", "Invitation is invalid or already used");
    }
    if (!isOpenInvitation(invitation, now)) {
      await this.deps.repos.invitations.expire(invitation.id);
      refuseAcceptance("EXPIRED");
    }
    // Who accepts comes before anything about the organization: the link may
    // have reached someone it was not sent to. Verification comes first, so
    // only an account that proved its mailbox learns whether its address is
    // the invited one: an account never verified tests no guessed address.
    // Both addresses are stored in lower case.
    const user = await this.deps.repos.users.findById(userId);
    if (!user || user.status !== "ACTIVE") throw new AppError("NOT_FOUND", "Account not found");
    if (user.emailVerifiedAt === null) refuseAcceptance("EMAIL_NOT_VERIFIED");
    if (user.email !== invitation.email) refuseAcceptance("WRONG_ACCOUNT");
    if (await this.deps.repos.memberships.find(invitation.organizationId, userId)) refuseAcceptance("ALREADY_MEMBER");
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
    const includedSeats = await this.options.includedSeats(invitation.organizationId);
    if (includedSeats === null) refuseAcceptance("NO_PLAN");
    // The checks above read; the acceptance writes only if the invitation is
    // still open, a seat is free and the user still no member, so a
    // concurrent acceptance cannot make a second membership or take the seat
    // twice.
    const accepted = await this.deps.repos.invitations.accept(
      invitation,
      userId,
      {
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: AuditAction.InvitationAccepted,
        resourceType: "membership",
        resourceId: `${invitation.organizationId}:${userId}`,
        metadata: { role: invitation.role, scope: scopeForRole(invitation.role) },
      },
      { includedSeats, clock: this.deps.clock },
    );
    if (accepted.outcome === "STALE") throw new AppError("NOT_FOUND", "Invitation is invalid or already used");
    if (accepted.outcome !== "ACCEPTED") refuseAcceptance(accepted.outcome);
    return accepted.membership;
  }

  async listMembers(actorUserId: string, organizationId: string): Promise<Membership[]> {
    await authorizeOrganization(this.deps, actorUserId, organizationId, "member.view");
    return this.deps.repos.memberships.listByOrganization(organizationId);
  }

  /**
   * Give a member another role (ADR-0057, ADR-0059), as the members page asks
   * (ADR-0139). The ceiling is asked of the role the member holds and of the
   * new one. The role decides the member's scope; grants, groups and Property
   * assignments stay (ADR-0052 Decision 10, ADR-0058). Given `seenRole`, the
   * role the page showed, the change applies only while the member holds it.
   * A change to the role the member holds writes and audits nothing.
   *
   * @throws AppError FORBIDDEN for a non-member, or for a member without
   *   `permission.manage` or past its ceiling (audited); NOT_FOUND for a
   *   target who is not a member of this organization; VALIDATION_FAILED with
   *   a {@link MembershipChangeRefusal} as `details.reason`, `STALE` too when
   *   the member no longer holds `seenRole`.
   */
  async changeRole(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    role: Role,
    seenRole?: Role,
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
    // Asked after the ceiling, so a wrong role seen never spares a refusal its entry.
    if (seenRole !== undefined && seenRole !== target.role) assertApplied("STALE");
    if (target.role === role) return target;
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

  /**
   * Remove a member from the organization (ADR-0057, ADR-0059), as the
   * members page asks (ADR-0140). The ceiling is asked of the role the member
   * holds. The Properties it is responsible for are left with none
   * (ADR-0062), and its grants and group memberships here go with it; its
   * account stays. Given `seenRole`, the role the page showed, the removal
   * applies only while the member holds it.
   *
   * @throws AppError FORBIDDEN for a non-member, or for a member without
   *   `member.manage` or past its ceiling (audited); NOT_FOUND for a target
   *   who is not a member of this organization; VALIDATION_FAILED with a
   *   {@link MembershipChangeRefusal} as `details.reason`, `STALE` too when
   *   the member no longer holds `seenRole`.
   */
  async removeMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    seenRole?: Role,
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
    // Asked after the ceiling, so a wrong role seen never spares a refusal its entry.
    if (seenRole !== undefined && seenRole !== target.role) assertApplied("STALE");
    assertApplied(
      // Its Properties become unassigned, and the entry counts them (ADR-0062).
      await this.deps.repos.memberships.remove(organizationId, targetUserId, target.role, (unassignedPropertyCount) => ({
        organizationId,
        actorUserId,
        action: AuditAction.MemberRemoved,
        resourceType: "membership",
        resourceId: `${organizationId}:${targetUserId}`,
        metadata: { unassignedPropertyCount },
      })),
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

/**
 * Why a role change or removal wrote nothing (ADR-0059), as `details.reason`
 * of the `VALIDATION_FAILED` it is refused with: it would leave no `OWNER`, or
 * the member's role changed after its ceiling was asked.
 */
export type MembershipChangeRefusal = Exclude<MembershipChangeOutcome, "APPLIED">;

const MEMBERSHIP_CHANGE_REFUSAL_MESSAGES: Record<MembershipChangeRefusal, string> = {
  LAST_OWNER: "Cannot remove or demote the last owner",
  STALE: "This member changed meanwhile; reload and try again",
};

/** A role change or removal that wrote nothing is refused, saying why. */
function assertApplied(outcome: MembershipChangeOutcome): void {
  if (outcome === "APPLIED") return;
  throw new AppError("VALIDATION_FAILED", MEMBERSHIP_CHANGE_REFUSAL_MESSAGES[outcome], {
    details: { reason: outcome },
  });
}
