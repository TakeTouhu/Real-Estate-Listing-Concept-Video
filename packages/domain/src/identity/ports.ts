import type {
  AuditLog,
  Credential,
  Invitation,
  Membership,
  Organization,
  Session,
  User,
} from "./types";
import type { Role } from "./roles";

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

export interface MembershipRepository {
  create(input: Omit<Membership, "createdAt">): Promise<Membership>;
  find(organizationId: string, userId: string): Promise<Membership | null>;
  listByOrganization(organizationId: string): Promise<Membership[]>;
  listByUser(userId: string): Promise<Membership[]>;
  updateRole(organizationId: string, userId: string, role: Role): Promise<Membership>;
  remove(organizationId: string, userId: string): Promise<void>;
}

export interface InvitationRepository {
  create(input: Omit<Invitation, "createdAt">): Promise<Invitation>;
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  findPending(organizationId: string, email: string): Promise<Invitation | null>;
  update(invitation: Invitation): Promise<Invitation>;
  listByOrganization(organizationId: string): Promise<Invitation[]>;
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
