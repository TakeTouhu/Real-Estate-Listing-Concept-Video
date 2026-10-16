import type {
  AuditLogRepository,
  Clock,
  CredentialRepository,
  DeletedGroup,
  GrantChangeAudit,
  GroupCeilingCheck,
  GroupChangeAudit,
  GroupCreation,
  GroupDeletion,
  GroupMemberAddition,
  GroupMemberRemoval,
  GroupPermissionGrant,
  GroupPermissionRevocation,
  GroupRename,
  GroupRepository,
  IdentityRepositories,
  IdentityServiceDeps,
  IdGenerator,
  InvitationAcceptance,
  InvitationRepository,
  MembershipChangeAudit,
  MembershipChangeOutcome,
  MembershipRepository,
  OrganizationRepository,
  PasswordHasher,
  PermissionGrantRepository,
  SessionRepository,
  SetMfaRequiredInput,
  TokenService,
  UserRepository,
} from "../identity/ports";
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
} from "../identity/types";
import { GROUP_GRANTABLE_PERMISSIONS, type Permission, type Role } from "../identity/roles";
import { InMemoryMfaRepository, type InMemorySessionStore } from "./in-memory-mfa";

/** Mutable clock for deterministic tests. */
export class TestClock implements Clock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}

/** Deterministic, sequential id generator. */
export function sequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    generate(prefix: string): string {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
  };
}

/** Fast, non-cryptographic hasher for tests only. */
export const fakePasswordHasher: PasswordHasher = {
  hash: (password: string) => Promise.resolve(`fake:${password}`),
  verify: (password: string, hash: string) => Promise.resolve(hash === `fake:${password}`),
};

/** Deterministic token service for tests. */
export function fakeTokenService(): TokenService {
  let counter = 0;
  return {
    generate: () => `token_${(counter += 1)}`,
    hash: (raw: string) => `hash:${raw}`,
  };
}

class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();
  constructor(private readonly clock: Clock) {}
  create(input: Omit<User, "createdAt" | "updatedAt">): Promise<User> {
    const now = this.clock.now();
    const user: User = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(user.id, user);
    return Promise.resolve(user);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByEmail(email: string): Promise<User | null> {
    return Promise.resolve([...this.byId.values()].find((u) => u.email === email) ?? null);
  }
}

class InMemoryCredentialRepository implements CredentialRepository {
  private readonly byUser = new Map<string, Credential>();
  constructor(private readonly clock: Clock) {}
  create(input: Omit<Credential, "createdAt" | "updatedAt">): Promise<Credential> {
    const now = this.clock.now();
    const credential: Credential = { ...input, createdAt: now, updatedAt: now };
    this.byUser.set(credential.userId, credential);
    return Promise.resolve(credential);
  }
  findByUserId(userId: string): Promise<Credential | null> {
    return Promise.resolve(this.byUser.get(userId) ?? null);
  }
}

class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly byId = new Map<string, Organization>();
  constructor(
    private readonly clock: Clock,
    private readonly auditLogs: AuditLogRepository,
    private readonly roleOf: (organizationId: string, userId: string) => Role | undefined,
  ) {}
  create(input: Omit<Organization, "createdAt" | "updatedAt" | "mfaRequired">): Promise<Organization> {
    const now = this.clock.now();
    const org: Organization = { ...input, mfaRequired: false, createdAt: now, updatedAt: now };
    this.byId.set(org.id, org);
    return Promise.resolve(org);
  }
  /** Checks and writes with no `await` in between, as the database's transaction does. */
  async setMfaRequired(input: SetMfaRequiredInput): Promise<"APPLIED" | "STALE"> {
    const org = this.byId.get(input.organizationId);
    const role = this.roleOf(input.organizationId, input.actorUserId);
    if (!org || org.mfaRequired !== input.expected || role !== input.actorRole) return "STALE";
    if (role !== "OWNER" && role !== "ADMIN") return "STALE";
    this.byId.set(org.id, { ...org, mfaRequired: input.required, updatedAt: this.clock.now() });
    await this.auditLogs.append(input.audit);
    return "APPLIED";
  }
  findById(id: string): Promise<Organization | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findBySlug(slug: string): Promise<Organization | null> {
    return Promise.resolve([...this.byId.values()].find((o) => o.slug === slug) ?? null);
  }
}

/**
 * Each change checks and writes with no `await` in between, so concurrent calls
 * interleave only between whole changes, as the database's transactions do.
 */
class InMemoryMembershipRepository implements MembershipRepository {
  private readonly rows = new Map<string, Membership>();
  constructor(
    private readonly clock: Clock,
    private readonly auditLogs: AuditLogRepository,
    /**
     * Mirrors the foreign keys: removing a membership removes its grants and
     * group memberships, and releases the Properties it was the responsible
     * user of. Answers how many it released.
     */
    private readonly onRemove: (organizationId: string, userId: string) => number,
  ) {}
  private key(organizationId: string, userId: string): string {
    return `${organizationId}::${userId}`;
  }
  create(input: Omit<Membership, "createdAt">): Promise<Membership> {
    return Promise.resolve(this.insert(input));
  }
  /** Synchronous insert, for an acceptance that must not yield before writing. */
  insert(input: Omit<Membership, "createdAt">): Membership {
    const membership: Membership = { ...input, createdAt: this.clock.now() };
    this.rows.set(this.key(input.organizationId, input.userId), membership);
    return membership;
  }
  has(organizationId: string, userId: string): boolean {
    return this.rows.has(this.key(organizationId, userId));
  }
  roleOf(organizationId: string, userId: string): Role | undefined {
    return this.rows.get(this.key(organizationId, userId))?.role;
  }
  find(organizationId: string, userId: string): Promise<Membership | null> {
    return Promise.resolve(this.rows.get(this.key(organizationId, userId)) ?? null);
  }
  listByOrganization(organizationId: string): Promise<Membership[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((m) => m.organizationId === organizationId),
    );
  }
  listByUser(userId: string): Promise<Membership[]> {
    return Promise.resolve([...this.rows.values()].filter((m) => m.userId === userId));
  }
  async changeRole(
    organizationId: string,
    userId: string,
    expectedRole: Role,
    role: Role,
    audit: MembershipChangeAudit,
  ): Promise<MembershipChangeOutcome> {
    const key = this.key(organizationId, userId);
    const existing = this.rows.get(key);
    if (existing?.role !== expectedRole) return "STALE";
    if (this.takesLastOwner(organizationId, expectedRole, role !== expectedRole)) return "LAST_OWNER";
    this.rows.set(key, { ...existing, role });
    await this.auditLogs.append(audit);
    return "APPLIED";
  }
  async remove(
    organizationId: string,
    userId: string,
    expectedRole: Role,
    audit: (unassignedPropertyCount: number) => MembershipChangeAudit,
  ): Promise<MembershipChangeOutcome> {
    const key = this.key(organizationId, userId);
    if (this.rows.get(key)?.role !== expectedRole) return "STALE";
    if (this.takesLastOwner(organizationId, expectedRole, true)) return "LAST_OWNER";
    this.rows.delete(key);
    const unassigned = this.onRemove(organizationId, userId);
    await this.auditLogs.append(audit(unassigned));
    return "APPLIED";
  }
  /** Whether a member holding `role`, losing it, is the organization's last OWNER. */
  private takesLastOwner(organizationId: string, role: Role, loses: boolean): boolean {
    if (role !== "OWNER" || !loses) return false;
    return [...this.rows.values()].filter((m) => m.organizationId === organizationId && m.role === "OWNER").length <= 1;
  }
}

class InMemoryPermissionGrantRepository implements PermissionGrantRepository {
  private readonly rows = new Map<string, PermissionGrant>();
  constructor(private readonly auditLogs: AuditLogRepository) {}
  private key(organizationId: string, userId: string, permission: Permission): string {
    return `${organizationId}::${userId}::${permission}`;
  }
  listForMember(organizationId: string, userId: string): Promise<PermissionGrant[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((g) => g.organizationId === organizationId && g.userId === userId),
    );
  }
  async insertIfAbsent(
    grant: PermissionGrant,
    audit: GrantChangeAudit,
  ): Promise<{ grant: PermissionGrant; created: boolean }> {
    const key = this.key(grant.organizationId, grant.userId, grant.permission);
    const existing = this.rows.get(key);
    if (existing) return { grant: existing, created: false };
    this.rows.set(key, grant);
    await this.auditLogs.append(audit);
    return { grant, created: true };
  }
  async remove(organizationId: string, userId: string, permission: Permission, audit: GrantChangeAudit): Promise<boolean> {
    if (!this.rows.delete(this.key(organizationId, userId, permission))) return false;
    await this.auditLogs.append(audit);
    return true;
  }
  removeAllForMember(organizationId: string, userId: string): void {
    for (const [key, grant] of this.rows) {
      if (grant.organizationId === organizationId && grant.userId === userId) this.rows.delete(key);
    }
  }
}

/**
 * Each change checks and writes with no `await` in between, as the membership
 * repository does, so a change's ceiling check always sees the group as the
 * change commits, as the database's group lock ensures.
 */
class InMemoryGroupRepository implements GroupRepository {
  private readonly groups = new Map<string, Group>();
  private readonly members = new Map<string, GroupMember>();
  private readonly permissions = new Map<string, GroupPermission>();
  constructor(
    private readonly clock: Clock,
    private readonly auditLogs: AuditLogRepository,
    /**
     * A member's role in the organization. Mirrors the membership foreign key:
     * only a member of the organization joins its groups.
     */
    private readonly roleOf: (organizationId: string, userId: string) => Role | undefined,
    /** Mirrors the Property foreign key: deleting a group ungroups its Properties. */
    private readonly properties: PropertyAssignmentLinks,
  ) {}
  /** Whether the organization has the group, as a foreign key sees it. */
  has(organizationId: string, groupId: string): boolean {
    return this.group(organizationId, groupId) !== undefined;
  }
  private memberKey(groupId: string, userId: string): string {
    return `${groupId}::${userId}`;
  }
  private permissionKey(groupId: string, permission: Permission): string {
    return `${groupId}::${permission}`;
  }
  private group(organizationId: string, groupId: string): Group | undefined {
    const group = this.groups.get(groupId);
    return group?.organizationId === organizationId ? group : undefined;
  }
  /** The group as a change's check sees it: members by user id, with their roles. */
  private locked(groupId: string): { members: { userId: string; role: Role }[]; permissions: Permission[] } {
    const members = [...this.members.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .flatMap((m) => {
        const role = this.roleOf(m.organizationId, m.userId);
        return role === undefined ? [] : [{ userId: m.userId, role }];
      });
    const permissions = [...this.permissions.values()].filter((p) => p.groupId === groupId).map((p) => p.permission);
    return { members, permissions };
  }
  private nameTaken(organizationId: string, name: string): boolean {
    return [...this.groups.values()].some((g) => g.organizationId === organizationId && g.name === name);
  }
  async create(input: Omit<Group, "createdAt" | "updatedAt">, audit: GroupChangeAudit): Promise<GroupCreation> {
    if (this.nameTaken(input.organizationId, input.name)) return { outcome: "NAME_TAKEN" };
    const now = this.clock.now();
    const group: Group = { ...input, createdAt: now, updatedAt: now };
    this.groups.set(group.id, group);
    await this.auditLogs.append(audit);
    return { outcome: "CREATED", group };
  }
  find(organizationId: string, groupId: string): Promise<Group | null> {
    return Promise.resolve(this.group(organizationId, groupId) ?? null);
  }
  listByOrganization(organizationId: string): Promise<Group[]> {
    return Promise.resolve(
      [...this.groups.values()]
        .filter((g) => g.organizationId === organizationId)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
  }
  async rename(
    organizationId: string,
    groupId: string,
    expectedName: string,
    name: string,
    audit: GroupChangeAudit,
  ): Promise<GroupRename> {
    const current = this.group(organizationId, groupId);
    if (current?.name !== expectedName) return { outcome: "STALE" };
    if (this.nameTaken(organizationId, name)) return { outcome: "NAME_TAKEN" };
    const group: Group = { ...current, name, updatedAt: this.clock.now() };
    this.groups.set(groupId, group);
    await this.auditLogs.append(audit);
    return { outcome: "RENAMED", group };
  }
  async delete(
    organizationId: string,
    groupId: string,
    check: GroupCeilingCheck,
    audit: (deleted: DeletedGroup) => GroupChangeAudit,
  ): Promise<GroupDeletion> {
    const group = this.group(organizationId, groupId);
    if (!group) return { outcome: "STALE" };
    const refusal = check(this.locked(groupId));
    if (refusal !== null) return { outcome: "REFUSED", refusal };
    for (const [key, permission] of this.permissions) {
      if (permission.groupId === groupId) this.permissions.delete(key);
    }
    const ungroupedPropertyCount = this.properties.ungroup(organizationId, groupId);
    let removedMemberCount = 0;
    for (const [key, member] of this.members) {
      if (member.groupId === groupId) {
        this.members.delete(key);
        removedMemberCount += 1;
      }
    }
    this.groups.delete(groupId);
    await this.auditLogs.append(audit({ name: group.name, removedMemberCount, ungroupedPropertyCount }));
    return { outcome: "DELETED", removedMemberCount };
  }
  listMembers(organizationId: string, groupId: string): Promise<GroupMember[]> {
    return Promise.resolve(
      [...this.members.values()]
        .filter((m) => m.groupId === groupId && m.organizationId === organizationId)
        .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)),
    );
  }
  listGroupIdsForMember(organizationId: string, userId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.members.values()]
        .filter((m) => m.organizationId === organizationId && m.userId === userId)
        .map((m) => m.groupId)
        .sort(),
    );
  }
  async addMember(
    member: Omit<GroupMember, "addedAt">,
    check: GroupCeilingCheck,
    audit: GroupChangeAudit,
  ): Promise<GroupMemberAddition> {
    if (!this.group(member.organizationId, member.groupId)) return { outcome: "STALE" };
    const refusal = check(this.locked(member.groupId));
    if (refusal !== null) return { outcome: "REFUSED", refusal };
    const key = this.memberKey(member.groupId, member.userId);
    if (this.members.has(key)) return { outcome: "ALREADY_IN_GROUP" };
    if (this.roleOf(member.organizationId, member.userId) === undefined) return { outcome: "STALE" };
    this.members.set(key, { ...member, addedAt: this.clock.now() });
    await this.auditLogs.append(audit);
    return { outcome: "ADDED" };
  }
  async removeMember(
    organizationId: string,
    groupId: string,
    userId: string,
    check: GroupCeilingCheck,
    audit: GroupChangeAudit,
  ): Promise<GroupMemberRemoval> {
    if (!this.group(organizationId, groupId)) return { outcome: "NOT_IN_GROUP" };
    const refusal = check(this.locked(groupId));
    if (refusal !== null) return { outcome: "REFUSED", refusal };
    if (!this.members.delete(this.memberKey(groupId, userId))) return { outcome: "NOT_IN_GROUP" };
    await this.auditLogs.append(audit);
    return { outcome: "REMOVED" };
  }
  listPermissions(organizationId: string, groupId: string): Promise<GroupPermission[]> {
    return Promise.resolve(
      [...this.permissions.values()].filter((p) => p.groupId === groupId && p.organizationId === organizationId),
    );
  }
  listPermissionsForMember(organizationId: string, userId: string): Promise<Permission[]> {
    const groupIds = new Set(
      [...this.members.values()]
        .filter((m) => m.organizationId === organizationId && m.userId === userId)
        .map((m) => m.groupId),
    );
    return Promise.resolve([
      ...new Set([...this.permissions.values()].filter((p) => groupIds.has(p.groupId)).map((p) => p.permission)),
    ]);
  }
  async grantPermission(
    permission: Omit<GroupPermission, "grantedAt">,
    check: GroupCeilingCheck,
    audit: (memberCount: number) => GroupChangeAudit,
  ): Promise<GroupPermissionGrant> {
    if (!this.group(permission.organizationId, permission.groupId)) return { outcome: "STALE" };
    const locked = this.locked(permission.groupId);
    const refusal = check(locked);
    if (refusal !== null) return { outcome: "REFUSED", refusal };
    if (locked.permissions.includes(permission.permission)) return { outcome: "ALREADY_GRANTED" };
    // Mirrors the database CHECK: a group never carries `disclosure.none` or `video.share`.
    if (!GROUP_GRANTABLE_PERMISSIONS.includes(permission.permission)) {
      throw new Error(`group_permissions_permission_check: ${permission.permission}`);
    }
    this.permissions.set(this.permissionKey(permission.groupId, permission.permission), {
      ...permission,
      grantedAt: this.clock.now(),
    });
    await this.auditLogs.append(audit(locked.members.length));
    return { outcome: "GRANTED" };
  }
  async revokePermission(
    organizationId: string,
    groupId: string,
    permission: Permission,
    check: GroupCeilingCheck,
    audit: (memberCount: number) => GroupChangeAudit,
  ): Promise<GroupPermissionRevocation> {
    if (!this.group(organizationId, groupId)) return { outcome: "STALE" };
    const locked = this.locked(groupId);
    const refusal = check(locked);
    if (refusal !== null) return { outcome: "REFUSED", refusal };
    if (!this.permissions.delete(this.permissionKey(groupId, permission))) return { outcome: "NOT_GRANTED" };
    await this.auditLogs.append(audit(locked.members.length));
    return { outcome: "REVOKED" };
  }
  removeAllForMember(organizationId: string, userId: string): void {
    for (const [key, member] of this.members) {
      if (member.organizationId === organizationId && member.userId === userId) this.members.delete(key);
    }
  }
}

class InMemoryInvitationRepository implements InvitationRepository {
  private readonly byId = new Map<string, Invitation>();
  constructor(
    private readonly clock: Clock,
    private readonly auditLogs: AuditLogRepository,
    private readonly memberships: InMemoryMembershipRepository,
  ) {}
  async create(input: Omit<Invitation, "createdAt">, audit: MembershipChangeAudit): Promise<Invitation> {
    const invitation: Invitation = { ...input, createdAt: this.clock.now() };
    this.byId.set(invitation.id, invitation);
    await this.auditLogs.append(audit);
    return invitation;
  }
  findByTokenHash(tokenHash: string): Promise<Invitation | null> {
    return Promise.resolve(
      [...this.byId.values()].find((i) => i.tokenHash === tokenHash) ?? null,
    );
  }
  findPending(organizationId: string, email: string): Promise<Invitation | null> {
    return Promise.resolve(
      [...this.byId.values()].find(
        (i) => i.organizationId === organizationId && i.email === email && i.status === "PENDING",
      ) ?? null,
    );
  }
  expire(invitationId: string): Promise<void> {
    const current = this.byId.get(invitationId);
    if (current?.status === "PENDING") this.byId.set(invitationId, { ...current, status: "EXPIRED" });
    return Promise.resolve();
  }
  async accept(
    invitation: Invitation,
    userId: string,
    acceptedAt: Date,
    audit: MembershipChangeAudit,
  ): Promise<InvitationAcceptance> {
    const current = this.byId.get(invitation.id);
    if (current?.status !== "PENDING") return { outcome: "STALE" };
    if (this.memberships.has(invitation.organizationId, userId)) return { outcome: "ALREADY_MEMBER" };
    this.byId.set(invitation.id, { ...current, status: "ACCEPTED", acceptedAt });
    const membership = this.memberships.insert({ organizationId: invitation.organizationId, userId, role: invitation.role });
    await this.auditLogs.append(audit);
    return { outcome: "ACCEPTED", membership };
  }
  listByOrganization(organizationId: string): Promise<Invitation[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((i) => i.organizationId === organizationId),
    );
  }
}

export class InMemorySessionRepository implements SessionRepository, InMemorySessionStore {
  private readonly byTokenHash = new Map<string, Session>();
  constructor(private readonly clock: Clock) {}
  create(input: Omit<Session, "createdAt" | "mfaVerifiedAt" | "mfaFailedAttempts">): Promise<Session> {
    const session: Session = { ...input, mfaVerifiedAt: null, mfaFailedAttempts: 0, createdAt: this.clock.now() };
    this.byTokenHash.set(session.tokenHash, session);
    return Promise.resolve(session);
  }
  findByTokenHash(tokenHash: string): Promise<Session | null> {
    return Promise.resolve(this.byTokenHash.get(tokenHash) ?? null);
  }
  deleteByTokenHash(tokenHash: string): Promise<void> {
    this.byTokenHash.delete(tokenHash);
    return Promise.resolve();
  }
  byId(sessionId: string): Session | null {
    return [...this.byTokenHash.values()].find((s) => s.id === sessionId) ?? null;
  }
  put(session: Session): void {
    this.byTokenHash.set(session.tokenHash, session);
  }
}

class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly rows: AuditLog[] = [];
  private counter = 0;
  constructor(private readonly clock: Clock) {}
  append(input: Omit<AuditLog, "id" | "createdAt">): Promise<AuditLog> {
    const entry: AuditLog = { ...input, id: `aud_${(this.counter += 1)}`, createdAt: this.clock.now() };
    this.rows.push(entry);
    return Promise.resolve(entry);
  }
  listByOrganization(organizationId: string): Promise<AuditLog[]> {
    return Promise.resolve(this.rows.filter((a) => a.organizationId === organizationId));
  }
  /** Test-only: all appended entries regardless of organization. */
  all(): AuditLog[] {
    return [...this.rows];
  }
}

/**
 * What a Property's two foreign keys see (ADR-0062), shared by the identity
 * doubles and an in-memory Property repository built on them: whether a
 * member or group exists, and, when one goes, the Properties it releases.
 */
export class PropertyAssignmentLinks {
  private readonly releasers: PropertyAssignmentReleaser[] = [];
  constructor(
    readonly isMember: (organizationId: string, userId: string) => boolean,
    readonly isGroup: (organizationId: string, groupId: string) => boolean,
  ) {}
  /** Called by a Property repository that keeps assignments. */
  register(releaser: PropertyAssignmentReleaser): void {
    this.releasers.push(releaser);
  }
  /** Unassign the member's Properties; how many. */
  unassign(organizationId: string, userId: string): number {
    return this.releasers.reduce((count, r) => count + r.unassign(organizationId, userId), 0);
  }
  /** Ungroup the group's Properties; how many. */
  ungroup(organizationId: string, groupId: string): number {
    return this.releasers.reduce((count, r) => count + r.ungroup(organizationId, groupId), 0);
  }
}

export interface PropertyAssignmentReleaser {
  unassign(organizationId: string, userId: string): number;
  ungroup(organizationId: string, groupId: string): number;
}

export interface TestRepositories extends IdentityRepositories {
  readonly sessions: InMemorySessionRepository;
  readonly mfa: InMemoryMfaRepository;
  readonly auditLogs: InMemoryAuditLogRepository;
  readonly propertyLinks: PropertyAssignmentLinks;
}

export function createInMemoryRepositories(clock: Clock): TestRepositories {
  const auditLogs = new InMemoryAuditLogRepository(clock);
  const permissionGrants = new InMemoryPermissionGrantRepository(auditLogs);
  const propertyLinks: PropertyAssignmentLinks = new PropertyAssignmentLinks(
    (organizationId, userId) => memberships.has(organizationId, userId),
    (organizationId, groupId) => groups.has(organizationId, groupId),
  );
  const groups = new InMemoryGroupRepository(
    clock,
    auditLogs,
    (organizationId, userId) => memberships.roleOf(organizationId, userId),
    propertyLinks,
  );
  const memberships: InMemoryMembershipRepository = new InMemoryMembershipRepository(clock, auditLogs, (organizationId, userId) => {
    permissionGrants.removeAllForMember(organizationId, userId);
    groups.removeAllForMember(organizationId, userId);
    return propertyLinks.unassign(organizationId, userId);
  });
  const sessions = new InMemorySessionRepository(clock);
  return {
    users: new InMemoryUserRepository(clock),
    credentials: new InMemoryCredentialRepository(clock),
    organizations: new InMemoryOrganizationRepository(clock, auditLogs, (organizationId, userId) =>
      memberships.roleOf(organizationId, userId),
    ),
    memberships,
    permissionGrants,
    groups,
    invitations: new InMemoryInvitationRepository(clock, auditLogs, memberships),
    sessions,
    mfa: new InMemoryMfaRepository(sessions, auditLogs),
    auditLogs,
    propertyLinks,
  };
}

export interface TestDeps extends IdentityServiceDeps {
  readonly repos: TestRepositories;
  readonly clock: TestClock;
}

/** Assemble a full in-memory IdentityServiceDeps for tests. */
export function createTestDeps(): TestDeps {
  const clock = new TestClock();
  return {
    repos: createInMemoryRepositories(clock),
    clock,
    ids: sequentialIdGenerator(),
    passwords: fakePasswordHasher,
    tokens: fakeTokenService(),
  };
}
