import type {
  AuditLogRepository,
  Clock,
  CredentialRepository,
  IdentityRepositories,
  IdentityServiceDeps,
  IdGenerator,
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
  PasswordHasher,
  SessionRepository,
  TokenService,
  UserRepository,
} from "../identity/ports";
import type {
  AuditLog,
  Credential,
  Invitation,
  Membership,
  Organization,
  Session,
  User,
} from "../identity/types";
import type { Role } from "../identity/roles";

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
  constructor(private readonly clock: Clock) {}
  create(input: Omit<Organization, "createdAt" | "updatedAt">): Promise<Organization> {
    const now = this.clock.now();
    const org: Organization = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(org.id, org);
    return Promise.resolve(org);
  }
  findById(id: string): Promise<Organization | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findBySlug(slug: string): Promise<Organization | null> {
    return Promise.resolve([...this.byId.values()].find((o) => o.slug === slug) ?? null);
  }
}

class InMemoryMembershipRepository implements MembershipRepository {
  private readonly rows = new Map<string, Membership>();
  constructor(private readonly clock: Clock) {}
  private key(organizationId: string, userId: string): string {
    return `${organizationId}::${userId}`;
  }
  create(input: Omit<Membership, "createdAt">): Promise<Membership> {
    const membership: Membership = { ...input, createdAt: this.clock.now() };
    this.rows.set(this.key(input.organizationId, input.userId), membership);
    return Promise.resolve(membership);
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
  updateRole(organizationId: string, userId: string, role: Role): Promise<Membership> {
    const key = this.key(organizationId, userId);
    const existing = this.rows.get(key);
    if (!existing) throw new Error("membership not found");
    const updated: Membership = { ...existing, role };
    this.rows.set(key, updated);
    return Promise.resolve(updated);
  }
  remove(organizationId: string, userId: string): Promise<void> {
    this.rows.delete(this.key(organizationId, userId));
    return Promise.resolve();
  }
}

class InMemoryInvitationRepository implements InvitationRepository {
  private readonly byId = new Map<string, Invitation>();
  constructor(private readonly clock: Clock) {}
  create(input: Omit<Invitation, "createdAt">): Promise<Invitation> {
    const invitation: Invitation = { ...input, createdAt: this.clock.now() };
    this.byId.set(invitation.id, invitation);
    return Promise.resolve(invitation);
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
  update(invitation: Invitation): Promise<Invitation> {
    this.byId.set(invitation.id, invitation);
    return Promise.resolve(invitation);
  }
  listByOrganization(organizationId: string): Promise<Invitation[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((i) => i.organizationId === organizationId),
    );
  }
}

class InMemorySessionRepository implements SessionRepository {
  private readonly byTokenHash = new Map<string, Session>();
  constructor(private readonly clock: Clock) {}
  create(input: Omit<Session, "createdAt">): Promise<Session> {
    const session: Session = { ...input, createdAt: this.clock.now() };
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

export interface TestRepositories extends IdentityRepositories {
  readonly auditLogs: InMemoryAuditLogRepository;
}

export function createInMemoryRepositories(clock: Clock): TestRepositories {
  return {
    users: new InMemoryUserRepository(clock),
    credentials: new InMemoryCredentialRepository(clock),
    organizations: new InMemoryOrganizationRepository(clock),
    memberships: new InMemoryMembershipRepository(clock),
    invitations: new InMemoryInvitationRepository(clock),
    sessions: new InMemorySessionRepository(clock),
    auditLogs: new InMemoryAuditLogRepository(clock),
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
