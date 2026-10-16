import type {
  AuditLog as DbAuditLog,
  Credential as DbCredential,
  Invitation as DbInvitation,
  Membership as DbMembership,
  Organization as DbOrganization,
  PermissionGrant as DbPermissionGrant,
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
  PermissionGrantRepository,
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
  PermissionGrant,
  Session,
  User,
} from "@app/domain";
import { isPermission } from "@app/domain";
import { auditLogData } from "./audit-log-data";
import { createPrismaGroupRepository } from "./group-repository";
import { createPrismaMfaRepository } from "./mfa-repository";
import { releaseProperties } from "./property-release";

function toOrganization(r: DbOrganization): Organization {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    mfaRequired: r.mfaRequired,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Lock the organization's OWNER memberships, always in `userId` order so two
 * callers cannot deadlock, and say whether `userId` losing OWNER is refused:
 * `STALE` if it is no longer one of them, `LAST_OWNER` if no other remains. A
 * row a concurrent transaction demoted or removed while this one waited drops
 * out of the set once that transaction commits, so the count is never higher
 * than what is true when this transaction writes.
 */
async function ownerLossRefusal(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<"STALE" | "LAST_OWNER" | null> {
  const owners = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "memberships"
    WHERE "organizationId" = ${organizationId} AND "role" = 'OWNER'
    ORDER BY "userId"
    FOR UPDATE`;
  if (!owners.some((owner) => owner.userId === userId)) return "STALE";
  return owners.length > 1 ? null : "LAST_OWNER";
}

function toPermissionGrant(r: DbPermissionGrant): PermissionGrant {
  // The table's CHECK admits only the grantable vocabulary.
  if (!isPermission(r.permission)) throw new Error(`Unknown permission in grant: ${r.permission}`);
  return {
    organizationId: r.organizationId,
    userId: r.userId,
    permission: r.permission,
    grantedByUserId: r.grantedByUserId,
    grantedAt: r.grantedAt,
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
    mfaVerifiedAt: r.mfaVerifiedAt,
    mfaFailedAttempts: r.mfaFailedAttempts,
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
    async setMfaRequired(input) {
      return prisma.$transaction(async (tx) => {
        // Share-locks the actor's membership, so a role change waits for this
        // transaction or commits first and is seen here (ADR-0065 Decision 18).
        const [actor] = await tx.$queryRaw<{ role: Role }[]>`
          SELECT "role" FROM "memberships"
          WHERE "organizationId" = ${input.organizationId} AND "userId" = ${input.actorUserId}
          FOR SHARE`;
        if (actor?.role !== "OWNER" && actor?.role !== "ADMIN") return "STALE";
        const { count } = await tx.organization.updateMany({
          where: { id: input.organizationId, mfaRequired: input.expected },
          data: { mfaRequired: input.required },
        });
        if (count === 0) return "STALE";
        await tx.auditLog.create({ data: auditLogData(input.audit) });
        return "APPLIED";
      });
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
    async changeRole(organizationId, userId, expectedRole: Role, role: Role, audit) {
      return prisma.$transaction(async (tx) => {
        if (expectedRole === "OWNER" && role !== "OWNER") {
          const refusal = await ownerLossRefusal(tx, organizationId, userId);
          if (refusal) return refusal;
        }
        // Applies only while the member still holds the role it was checked against.
        const { count } = await tx.membership.updateMany({
          where: { organizationId, userId, role: expectedRole },
          data: { role },
        });
        if (count === 0) return "STALE";
        await tx.auditLog.create({ data: auditLogData(audit) });
        return "APPLIED";
      });
    },
    async remove(organizationId, userId, expectedRole: Role, audit) {
      return prisma.$transaction(async (tx) => {
        if (expectedRole === "OWNER") {
          const refusal = await ownerLossRefusal(tx, organizationId, userId);
          if (refusal) return refusal;
        }
        // Locks the member before its Properties are released: an assignment
        // naming it commits first, and is released and counted, or waits and
        // finds it gone.
        const [member] = await tx.$queryRaw<{ role: Role }[]>`
          SELECT "role" FROM "memberships"
          WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
          FOR UPDATE`;
        // Applies only while the member still holds the role it was checked against.
        if (member?.role !== expectedRole) return "STALE";
        const unassigned = await releaseProperties(tx, organizationId, "responsibleUserId", userId);
        // The member's grants and group memberships go with it (foreign-key cascade).
        await tx.membership.delete({ where: { organizationId_userId: { organizationId, userId } } });
        await tx.auditLog.create({ data: auditLogData(audit(unassigned)) });
        return "APPLIED";
      });
    },
  };

  const permissionGrants: PermissionGrantRepository = {
    async listForMember(organizationId, userId) {
      return (await prisma.permissionGrant.findMany({ where: { organizationId, userId } })).map(toPermissionGrant);
    },
    async insertIfAbsent(grant, audit) {
      const where = {
        organizationId_userId_permission: {
          organizationId: grant.organizationId,
          userId: grant.userId,
          permission: grant.permission,
        },
      };
      try {
        // The grant and its audit entry commit together, or neither does.
        return await prisma.$transaction(async (tx) => {
          const row = await tx.permissionGrant.create({ data: grant });
          await tx.auditLog.create({ data: auditLogData(audit) });
          return { grant: toPermissionGrant(row), created: true };
        });
      } catch (error) {
        // A concurrent grant of the same permission won the race: answer as a
        // replay, writing nothing.
        if ((error as { code?: unknown }).code !== "P2002") throw error;
        const existing = await prisma.permissionGrant.findUnique({ where });
        if (!existing) throw error;
        return { grant: toPermissionGrant(existing), created: false };
      }
    },
    async remove(organizationId, userId, permission, audit) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.permissionGrant.deleteMany({ where: { organizationId, userId, permission } });
        if (count === 0) return false;
        await tx.auditLog.create({ data: auditLogData(audit) });
        return true;
      });
    },
  };

  const invitations: InvitationRepository = {
    async create(input, audit) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.invitation.create({
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
        });
        await tx.auditLog.create({ data: auditLogData(audit) });
        return toInvitation(row);
      });
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
    async expire(invitationId) {
      await prisma.invitation.updateMany({ where: { id: invitationId, status: "PENDING" }, data: { status: "EXPIRED" } });
    },
    async accept(invitation, userId, acceptedAt, audit) {
      const { organizationId, role } = invitation;
      try {
        return await prisma.$transaction(async (tx) => {
          // Moves from PENDING exactly once: a concurrent acceptance waits on
          // this row, then finds it no longer pending and writes nothing.
          const { count } = await tx.invitation.updateMany({
            where: { id: invitation.id, status: "PENDING" },
            data: { status: "ACCEPTED", acceptedAt },
          });
          if (count === 0) return { outcome: "STALE" } as const;
          const row = await tx.membership.create({ data: { organizationId, userId, role } });
          await tx.auditLog.create({ data: auditLogData(audit) });
          return { outcome: "ACCEPTED", membership: toMembership(row) } as const;
        });
      } catch (error) {
        // The membership key refused the row: the user became a member
        // meanwhile, and the whole acceptance rolled back. Classified from the
        // error itself, not by reading the membership again, which a
        // concurrent removal could already have deleted.
        const { code, meta } = error as { code?: unknown; meta?: { modelName?: unknown } };
        if (code !== "P2002" || meta?.modelName !== "Membership") throw error;
        return { outcome: "ALREADY_MEMBER" };
      }
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
      return toAuditLog(await prisma.auditLog.create({ data: auditLogData(input) }));
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

  return {
    users,
    credentials,
    organizations,
    memberships,
    permissionGrants,
    groups: createPrismaGroupRepository(prisma),
    invitations,
    sessions,
    mfa: createPrismaMfaRepository(prisma),
    auditLogs,
  };
}
