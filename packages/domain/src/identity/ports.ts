import type {
  AuditLog,
  Credential,
  Group,
  GroupMember,
  GroupPermission,
  Invitation,
  Membership,
  Organization,
  PermissionGrant,
  Session,
  User,
} from "./types";
import type { GroupGrantRefusal, Permission, Role } from "./roles";

/** Injectable clock so services are deterministic under test. */
export interface Clock {
  now(): Date;
}

/** Injectable id generator (prefix -> opaque public id). */
export interface IdGenerator {
  generate(prefix: string): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenService {
  /** Generate a raw secret token (returned once to the caller). */
  generate(): string;
  /** Hash a raw token for storage/lookup. */
  hash(raw: string): string;
}

// --- Repository ports -------------------------------------------------------

export interface UserRepository {
  create(input: Omit<User, "createdAt" | "updatedAt">): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
}

export interface CredentialRepository {
  create(input: Omit<Credential, "createdAt" | "updatedAt">): Promise<Credential>;
  findByUserId(userId: string): Promise<Credential | null>;
}

export interface OrganizationRepository {
  create(input: Omit<Organization, "createdAt" | "updatedAt">): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
  findBySlug(slug: string): Promise<Organization | null>;
}

/** The audit entry a membership change commits together with the change itself. */
export type MembershipChangeAudit = Omit<AuditLog, "id" | "createdAt">;

/**
 * How a role change or removal ended. Only `APPLIED` wrote anything. `STALE`:
 * the member no longer holds the role the change was checked against, or is
 * gone. `LAST_OWNER`: the change would leave the organization without an OWNER.
 */
export type MembershipChangeOutcome = "APPLIED" | "STALE" | "LAST_OWNER";

export interface MembershipRepository {
  create(input: Omit<Membership, "createdAt">): Promise<Membership>;
  find(organizationId: string, userId: string): Promise<Membership | null>;
  listByOrganization(organizationId: string): Promise<Membership[]>;
  listByUser(userId: string): Promise<Membership[]>;
  /**
   * Change a member's role from `expectedRole` to `role` and record `audit`,
   * atomically. Taking an OWNER away counts the organization's OWNERs under a
   * lock on them, so two concurrent changes can never each leave the other as
   * the last OWNER.
   */
  changeRole(
    organizationId: string,
    userId: string,
    expectedRole: Role,
    role: Role,
    audit: MembershipChangeAudit,
  ): Promise<MembershipChangeOutcome>;
  /**
   * Remove a member holding `expectedRole`, with its grants and group
   * memberships, and record the audit entry `audit` builds from the number of
   * Properties it was the responsible user of, atomically; as `changeRole`.
   * Those Properties become unassigned (ADR-0062). The membership row is locked
   * first, so an assignment naming the member commits before (and is released
   * and counted) or finds the member gone.
   */
  remove(
    organizationId: string,
    userId: string,
    expectedRole: Role,
    audit: (unassignedPropertyCount: number) => MembershipChangeAudit,
  ): Promise<MembershipChangeOutcome>;
}

/**
 * How an acceptance ended. Only `ACCEPTED` wrote anything. `STALE`: the
 * invitation is no longer pending (a concurrent acceptance won).
 * `ALREADY_MEMBER`: the user is already a member of the organization.
 */
export type InvitationAcceptance =
  | { readonly outcome: "ACCEPTED"; readonly membership: Membership }
  | { readonly outcome: "STALE" }
  | { readonly outcome: "ALREADY_MEMBER" };

export interface InvitationRepository {
  /** Record an invitation and its audit entry atomically. */
  create(input: Omit<Invitation, "createdAt">, audit: MembershipChangeAudit): Promise<Invitation>;
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  findPending(organizationId: string, email: string): Promise<Invitation | null>;
  /** Mark an invitation EXPIRED if it is still pending; otherwise leave it as it is. */
  expire(invitationId: string): Promise<void>;
  /**
   * Accept a pending invitation atomically: the user's membership with the
   * invitation's role, the invitation ACCEPTED at `acceptedAt`, and `audit`.
   */
  accept(invitation: Invitation, userId: string, acceptedAt: Date, audit: MembershipChangeAudit): Promise<InvitationAcceptance>;
  listByOrganization(organizationId: string): Promise<Invitation[]>;
}

/** The audit entry a grant change commits together with the change itself. */
export type GrantChangeAudit = Omit<AuditLog, "id" | "createdAt">;

export interface PermissionGrantRepository {
  /** A member's grants, in no particular order. */
  listForMember(organizationId: string, userId: string): Promise<PermissionGrant[]>;
  /**
   * Record a grant and its audit entry atomically, unless the member already
   * holds it. `created` is false when it already existed — including when a
   * concurrent grant won the race — and then nothing is written: the existing
   * grant is returned unchanged.
   */
  insertIfAbsent(
    grant: PermissionGrant,
    audit: GrantChangeAudit,
  ): Promise<{ readonly grant: PermissionGrant; readonly created: boolean }>;
  /**
   * Remove a grant and record its audit entry atomically; false, writing
   * nothing, when there was none to remove.
   */
  remove(organizationId: string, userId: string, permission: Permission, audit: GrantChangeAudit): Promise<boolean>;
}

/** The audit entry a group change commits together with the change itself. */
export type GroupChangeAudit = Omit<AuditLog, "id" | "createdAt">;

/** How a group creation ended; `NAME_TAKEN` wrote nothing. */
export type GroupCreation =
  | { readonly outcome: "CREATED"; readonly group: Group }
  | { readonly outcome: "NAME_TAKEN" };

/**
 * How a rename ended. Only `RENAMED` wrote anything. `STALE`: the group is gone,
 * or no longer has the name the rename was checked against. `NAME_TAKEN`:
 * another group of the organization has the new name.
 */
export type GroupRename =
  | { readonly outcome: "RENAMED"; readonly group: Group }
  | { readonly outcome: "STALE" }
  | { readonly outcome: "NAME_TAKEN" };

/**
 * A group as a change sees it once the group row is locked: its members with
 * the roles they hold, and the permissions it carries (ADR-0061).
 */
export interface LockedGroup {
  readonly members: readonly { readonly userId: string; readonly role: Role }[];
  readonly permissions: readonly Permission[];
}

/** Why the grant ceiling refused a group change, judged on the group as locked. */
export interface GroupCeilingRefusal {
  readonly reason: GroupGrantRefusal | "target_role";
  readonly permission: Permission;
  /** The first member out of the actor's reach, for `target_role`. */
  readonly targetUserId?: string;
  readonly targetRole?: Role;
}

/**
 * The grant ceiling on a group change, asked of the group as locked, inside the
 * change's transaction; `null` admits the change.
 */
export type GroupCeilingCheck = (locked: LockedGroup) => GroupCeilingRefusal | null;

/** A change the ceiling refused under the group's lock; nothing was written. */
export interface GroupChangeRefused {
  readonly outcome: "REFUSED";
  readonly refusal: GroupCeilingRefusal;
}

/** What a deletion removed: the group's name as locked, how many members, and how many Properties it ungrouped. */
export interface DeletedGroup {
  readonly name: string;
  readonly removedMemberCount: number;
  readonly ungroupedPropertyCount: number;
}

/** How a deletion ended; `STALE` (the group is already gone) wrote nothing. */
export type GroupDeletion =
  | { readonly outcome: "DELETED"; readonly removedMemberCount: number }
  | { readonly outcome: "STALE" }
  | GroupChangeRefused;

/**
 * How adding a member ended. Only `ADDED` wrote anything. `ALREADY_IN_GROUP`
 * also answers a concurrent addition that won. `STALE`: the group, or the
 * member's membership of the organization, is gone.
 */
export type GroupMemberAddition = { readonly outcome: "ADDED" | "ALREADY_IN_GROUP" | "STALE" } | GroupChangeRefused;

/** How removing a member ended. Only `REMOVED` wrote anything; `NOT_IN_GROUP` also answers a group that is gone. */
export type GroupMemberRemoval = { readonly outcome: "REMOVED" | "NOT_IN_GROUP" } | GroupChangeRefused;

/** How giving a group a permission ended. Only `GRANTED` wrote anything; `STALE`: the group is gone. */
export type GroupPermissionGrant = { readonly outcome: "GRANTED" | "ALREADY_GRANTED" | "STALE" } | GroupChangeRefused;

/** How taking a permission from a group ended. Only `REVOKED` wrote anything; `STALE`: the group is gone. */
export type GroupPermissionRevocation = { readonly outcome: "REVOKED" | "NOT_GRANTED" | "STALE" } | GroupChangeRefused;

/** Groups and their members. Every call is scoped by organization. */
export interface GroupRepository {
  /** Record a group and its audit entry atomically. */
  create(input: Omit<Group, "createdAt" | "updatedAt">, audit: GroupChangeAudit): Promise<GroupCreation>;
  find(organizationId: string, groupId: string): Promise<Group | null>;
  /** The organization's groups, by name. */
  listByOrganization(organizationId: string): Promise<Group[]>;
  /** Rename a group still named `expectedName`, with its audit entry, atomically. */
  rename(
    organizationId: string,
    groupId: string,
    expectedName: string,
    name: string,
    audit: GroupChangeAudit,
  ): Promise<GroupRename>;
  /**
   * Delete a group with its member and permission rows, if `check` admits it,
   * ungrouping its Properties (ADR-0052 Decision 11), with the audit entry
   * `audit` builds from the group as locked and what the deletion removed and
   * ungrouped, atomically. The group row is locked (`FOR UPDATE`) before
   * `check` reads it, so every change to the group's members, permissions or
   * name, and every Property assigned to it, either commits before (and is
   * judged, counted and named) or finds the group gone.
   */
  delete(
    organizationId: string,
    groupId: string,
    check: GroupCeilingCheck,
    audit: (deleted: DeletedGroup) => GroupChangeAudit,
  ): Promise<GroupDeletion>;
  /** A group's members, by user id. */
  listMembers(organizationId: string, groupId: string): Promise<GroupMember[]>;
  /** The ids of the groups a member belongs to, in id order. */
  listGroupIdsForMember(organizationId: string, userId: string): Promise<string[]>;
  /**
   * Add a member, if `check` admits it, and record its audit entry atomically,
   * unless it is already in the group. The group row is share-locked before
   * `check` reads it: additions and removals run alongside one another, never
   * alongside a change to the group's permissions.
   */
  addMember(
    member: Omit<GroupMember, "addedAt">,
    check: GroupCeilingCheck,
    audit: GroupChangeAudit,
  ): Promise<GroupMemberAddition>;
  /** Remove a member, if `check` admits it, and record its audit entry atomically; locked as `addMember`. */
  removeMember(
    organizationId: string,
    groupId: string,
    userId: string,
    check: GroupCeilingCheck,
    audit: GroupChangeAudit,
  ): Promise<GroupMemberRemoval>;
  /** A group's permissions, in no particular order. */
  listPermissions(organizationId: string, groupId: string): Promise<GroupPermission[]>;
  /** Every permission a member holds through the groups it belongs to, each once. */
  listPermissionsForMember(organizationId: string, userId: string): Promise<Permission[]>;
  /**
   * Give a group a permission, if `check` admits it, with the audit entry
   * `audit` builds from the number of members it reaches, atomically, unless
   * the group already carries it. The group row is locked (`FOR UPDATE`) before
   * `check` reads it.
   */
  grantPermission(
    permission: Omit<GroupPermission, "grantedAt">,
    check: GroupCeilingCheck,
    audit: (memberCount: number) => GroupChangeAudit,
  ): Promise<GroupPermissionGrant>;
  /** Take a permission from a group, if `check` admits it; locked and recorded as `grantPermission`. */
  revokePermission(
    organizationId: string,
    groupId: string,
    permission: Permission,
    check: GroupCeilingCheck,
    audit: (memberCount: number) => GroupChangeAudit,
  ): Promise<GroupPermissionRevocation>;
}

export interface SessionRepository {
  create(input: Omit<Session, "createdAt">): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
}

export interface AuditLogRepository {
  append(input: Omit<AuditLog, "id" | "createdAt">): Promise<AuditLog>;
  listByOrganization(organizationId: string): Promise<AuditLog[]>;
}

/** Aggregate of all repositories + service ports passed to domain services. */
export interface IdentityRepositories {
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly organizations: OrganizationRepository;
  readonly memberships: MembershipRepository;
  /** Removing a membership removes its grants with it. */
  readonly permissionGrants: PermissionGrantRepository;
  /** Removing a membership removes it from every group, and so ends what its groups gave it. */
  readonly groups: GroupRepository;
  readonly invitations: InvitationRepository;
  readonly sessions: SessionRepository;
  readonly auditLogs: AuditLogRepository;
}

export interface IdentityServiceDeps {
  readonly repos: IdentityRepositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenService;
}
