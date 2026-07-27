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
