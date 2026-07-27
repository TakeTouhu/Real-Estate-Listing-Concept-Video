import type {
  AuditLog as DbAuditLog,
  Credential as DbCredential,
  Invitation as DbInvitation,
  Membership as DbMembership,
  Organization as DbOrganization,
  PrismaClient,
  Session as DbSession,
  User as DbUser,
  Prisma,
} from "@prisma/client";
import type {
  AuditLogRepository,
  CredentialRepository,
  IdentityRepositories,
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
  Role,
  SessionRepository,
  UserRepository,
} from "@app/domain";
import type {
  AuditLog,
  Credential,
  Invitation,
  Membership,
  Organization,
  Session,
  User,
} from "@app/domain";

function toOrganization(r: DbOrganization): Organization {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toUser(r: DbUser): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toCredential(r: DbCredential): Credential {
  return {
    userId: r.userId,
    passwordHash: r.passwordHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toMembership(r: DbMembership): Membership {
  return { organizationId: r.organizationId, userId: r.userId, role: r.role, createdAt: r.createdAt };
}

function toInvitation(r: DbInvitation): Invitation {
  return {
    id: r.id,
    organizationId: r.organizationId,
    email: r.email,
    role: r.role,
    tokenHash: r.tokenHash,
    status: r.status,
    invitedByUserId: r.invitedByUserId,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt,
  };
}

function toSession(r: DbSession): Session {
  return {
    id: r.id,
    userId: r.userId,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

function toAuditLog(r: DbAuditLog): AuditLog {
  return {
    id: r.id,
    organizationId: r.organizationId,
    actorUserId: r.actorUserId,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
  };
}

/**
 * Prisma-backed implementations of the domain identity repository ports. All
 * organization-scoped reads filter by organizationId, upholding tenant
 * isolation in the data-access layer (SecurityCompliance.md).
 */
export function createPrismaIdentityRepositories(prisma: PrismaClient): IdentityRepositories {
  const users: UserRepository = {
    async create(input) {
      return toUser(
        await prisma.user.create({
          data: { id: input.id, email: input.email, name: input.name, status: input.status },
        }),
      );
    },
    async findById(id) {
      const r = await prisma.user.findUnique({ where: { id } });
      return r ? toUser(r) : null;
    },
    async findByEmail(email) {
      const r = await prisma.user.findUnique({ where: { email } });
      return r ? toUser(r) : null;
    },
  };

  const credentials: CredentialRepository = {
    async create(input) {
      return toCredential(
        await prisma.credential.create({
          data: { userId: input.userId, passwordHash: input.passwordHash },
        }),
      );
    },
    async findByUserId(userId) {
      const r = await prisma.credential.findUnique({ where: { userId } });
      return r ? toCredential(r) : null;
    },
  };

  const organizations: OrganizationRepository = {
    async create(input) {
      return toOrganization(
        await prisma.organization.create({
          data: { id: input.id, name: input.name, slug: input.slug, status: input.status },
        }),
      );
    },
    async findById(id) {
      const r = await prisma.organization.findUnique({ where: { id } });
      return r ? toOrganization(r) : null;
    },
    async findBySlug(slug) {
      const r = await prisma.organization.findUnique({ where: { slug } });
      return r ? toOrganization(r) : null;
    },
  };

  const memberships: MembershipRepository = {
    async create(input) {
      return toMembership(
        await prisma.membership.create({
          data: { organizationId: input.organizationId, userId: input.userId, role: input.role },
        }),
      );
    },
    async find(organizationId, userId) {
      const r = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });
      return r ? toMembership(r) : null;
    },
    async listByOrganization(organizationId) {
      return (await prisma.membership.findMany({ where: { organizationId } })).map(toMembership);
    },
    async listByUser(userId) {
      return (await prisma.membership.findMany({ where: { userId } })).map(toMembership);
    },
    async updateRole(organizationId, userId, role: Role) {
      return toMembership(
        await prisma.membership.update({
          where: { organizationId_userId: { organizationId, userId } },
          data: { role },
        }),
      );
    },
    async remove(organizationId, userId) {
      await prisma.membership.delete({
        where: { organizationId_userId: { organizationId, userId } },
      });
    },
  };

  const invitations: InvitationRepository = {
    async create(input) {
      return toInvitation(
        await prisma.invitation.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            email: input.email,
            role: input.role,
            tokenHash: input.tokenHash,
            status: input.status,
            invitedByUserId: input.invitedByUserId,
            expiresAt: input.expiresAt,
            acceptedAt: input.acceptedAt,
          },
        }),
      );
    },
    async findByTokenHash(tokenHash) {
      const r = await prisma.invitation.findUnique({ where: { tokenHash } });
      return r ? toInvitation(r) : null;
    },
    async findPending(organizationId, email) {
      const r = await prisma.invitation.findFirst({
        where: { organizationId, email, status: "PENDING" },
      });
      return r ? toInvitation(r) : null;
    },
    async update(invitation) {
      return toInvitation(
        await prisma.invitation.update({
          where: { id: invitation.id },
          data: { status: invitation.status, acceptedAt: invitation.acceptedAt },
        }),
      );
    },
    async listByOrganization(organizationId) {
      return (await prisma.invitation.findMany({ where: { organizationId } })).map(toInvitation);
    },
  };

  const sessions: SessionRepository = {
    async create(input) {
      return toSession(
        await prisma.session.create({
          data: {
            id: input.id,
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          },
        }),
      );
    },
    async findByTokenHash(tokenHash) {
      const r = await prisma.session.findUnique({ where: { tokenHash } });
      return r ? toSession(r) : null;
    },
    async deleteByTokenHash(tokenHash) {
      await prisma.session.deleteMany({ where: { tokenHash } });
    },
  };

  const auditLogs: AuditLogRepository = {
    async append(input) {
      return toAuditLog(
        await prisma.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            metadata: input.metadata as Prisma.InputJsonValue,
          },
        }),
      );
    },
    async listByOrganization(organizationId) {
      return (
        await prisma.auditLog.findMany({
          where: { organizationId },
          orderBy: { createdAt: "asc" },
        })
      ).map(toAuditLog);
    },
  };

  return { users, credentials, organizations, memberships, invitations, sessions, auditLogs };
}
