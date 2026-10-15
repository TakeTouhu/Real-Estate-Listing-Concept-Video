import type { AuditLogRepository } from "./ports";
import type { AuditLog } from "./types";

/** Audit actions emitted by identity/organization writes (SecurityCompliance.md). */
export const AuditAction = {
  OrganizationCreated: "organization.created",
  UserRegistered: "user.registered",
  UserLoggedIn: "user.logged_in",
  SessionRevoked: "session.revoked",
  InvitationCreated: "invitation.created",
  InvitationAccepted: "invitation.accepted",
  MemberRoleChanged: "member.role_changed",
  MemberRemoved: "member.removed",
  /** A member's attempt to give or take a role past its ceiling (ADR-0052 Decision 10). */
  RoleChangeRefused: "member.role_change_refused",
  PermissionGranted: "permission.granted",
  PermissionRevoked: "permission.revoked",
  /** A member's attempt to grant or revoke a permission past its ceiling. */
  PermissionGrantRefused: "permission.grant_refused",
  GroupCreated: "group.created",
  GroupRenamed: "group.renamed",
  GroupDeleted: "group.deleted",
  GroupMemberAdded: "group.member_added",
  GroupMemberRemoved: "group.member_removed",
  GroupPermissionGranted: "group.permission_granted",
  GroupPermissionRevoked: "group.permission_revoked",
  /** A member's refused attempt to change a group or who belongs to it. */
  GroupChangeRefused: "group.change_refused",
  /** MFA turned on, or moved to a new authenticator (ADR-0065). */
  MfaEnabled: "mfa.enabled",
  MfaReplaced: "mfa.replaced",
  /** A sign-in passed MFA, saying whether by authenticator or recovery code. */
  MfaChallengePassed: "mfa.challenge_passed",
  /** A sign-in ended by too many wrong codes. */
  MfaChallengeLocked: "mfa.challenge_locked",
  MfaRecoveryCodesRegenerated: "mfa.recovery_codes_regenerated",
  MfaDisabled: "mfa.disabled",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface RecordAuditInput {
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  /** One of the AuditAction / PropertyAuditAction vocabularies. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata?: Record<string, unknown>;
}

/** Minimal dependency shape needed to append audit entries. */
export interface AuditSink {
  readonly repos: { readonly auditLogs: AuditLogRepository };
}

/**
 * Append a sanitized audit entry. Callers must pass only non-sensitive metadata
 * (no secrets, tokens, or password hashes).
 */
export function recordAudit(deps: AuditSink, input: RecordAuditInput): Promise<AuditLog> {
  return deps.repos.auditLogs.append({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata ?? {},
  });
}
