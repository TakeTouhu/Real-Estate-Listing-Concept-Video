import type { Permission, Role } from "./roles";

export type OrganizationStatus = "ACTIVE" | "SUSPENDED";
export type UserStatus = "ACTIVE" | "DISABLED";
export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: OrganizationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Credential {
  readonly userId: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Membership {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;
  readonly createdAt: Date;
}

/** One individual permission granted to one member (ADR-0052 Decision 10). */
export interface PermissionGrant {
  readonly organizationId: string;
  readonly userId: string;
  readonly permission: Permission;
  readonly grantedByUserId: string;
  readonly grantedAt: Date;
}

/** A named set of an organization's members (ADR-0052 Decision 10, ADR-0060). */
export interface Group {
  readonly id: string;
  readonly organizationId: string;
  /** Trimmed, 1 to 100 characters, unique within the organization. */
  readonly name: string;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One permission a group carries for every one of its members (ADR-0061).
 * Never `disclosure.none`, which only an individual grant carries.
 */
export interface GroupPermission {
  readonly groupId: string;
  readonly organizationId: string;
  readonly permission: Permission;
  readonly grantedByUserId: string;
  readonly grantedAt: Date;
}

/** One member of one group; the member belongs to the group's organization. */
export interface GroupMember {
  readonly groupId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly addedByUserId: string;
  readonly addedAt: Date;
}

export interface Invitation {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
  readonly tokenHash: string;
  readonly status: InvitationStatus;
  readonly invitedByUserId: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface AuditLog {
  readonly id: string;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}
