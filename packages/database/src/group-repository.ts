import type { Group as DbGroup, GroupMember as DbGroupMember, PrismaClient } from "@prisma/client";
import type { Group, GroupMember, GroupRepository } from "@app/domain";
import { auditLogData } from "./audit-log-data";

function toGroup(r: DbGroup): Group {
  return {
    id: r.id,
    organizationId: r.organizationId,
    name: r.name,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toGroupMember(r: DbGroupMember): GroupMember {
  return {
    groupId: r.groupId,
    organizationId: r.organizationId,
    userId: r.userId,
    addedByUserId: r.addedByUserId,
    addedAt: r.addedAt,
  };
}

interface KnownError {
  readonly code?: unknown;
  readonly meta?: { readonly modelName?: unknown; readonly target?: unknown };
}

/** A unique-key conflict on `model`'s `field`, recognized from the error itself. */
function isUniqueConflict(error: unknown, model: string, field: string): boolean {
  const { code, meta } = error as KnownError;
  return code === "P2002" && meta?.modelName === model && Array.isArray(meta.target) && meta.target.includes(field);
}

/**
 * A `group_members` foreign key refusing the row: its group, or its member's
 * membership of the organization, does not exist. (An audit row's own foreign
 * key is the audit log's, and stays an error.)
 */
function isMissingGroupOrMember(error: unknown): boolean {
  const { code, meta } = error as KnownError;
  return code === "P2003" && meta?.modelName === "GroupMember";
}

/**
 * Prisma-backed groups (ADR-0060). Every read and write is scoped by
 * organization, and each change commits with its audit entry or not at all.
 */
export function createPrismaGroupRepository(prisma: PrismaClient): GroupRepository {
  return {
    async create(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.group.create({ data: input });
          await tx.auditLog.create({ data: auditLogData(audit) });
          return { outcome: "CREATED", group: toGroup(row) } as const;
        });
      } catch (error) {
        if (!isUniqueConflict(error, "Group", "name")) throw error;
        return { outcome: "NAME_TAKEN" };
      }
    },

    async find(organizationId, groupId) {
      const r = await prisma.group.findUnique({ where: { id_organizationId: { id: groupId, organizationId } } });
      return r ? toGroup(r) : null;
    },

    async listByOrganization(organizationId) {
      return (await prisma.group.findMany({ where: { organizationId }, orderBy: { name: "asc" } })).map(toGroup);
    },

    async rename(organizationId, groupId, expectedName, name, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          // Applies only while the group still has the name it was checked against.
          const { count } = await tx.group.updateMany({
            where: { id: groupId, organizationId, name: expectedName },
            data: { name },
          });
          if (count === 0) return { outcome: "STALE" } as const;
          await tx.auditLog.create({ data: auditLogData(audit) });
          const row = await tx.group.findUniqueOrThrow({ where: { id: groupId } });
          return { outcome: "RENAMED", group: toGroup(row) } as const;
        });
      } catch (error) {
        if (!isUniqueConflict(error, "Group", "name")) throw error;
        return { outcome: "NAME_TAKEN" };
      }
    },

    async delete(organizationId, groupId, audit) {
      return prisma.$transaction(async (tx) => {
        // An addition's foreign-key check holds a share lock on the group row,
        // which this lock waits for and then excludes: an addition commits
        // before the deletion (and is counted below) or finds the group gone.
        // A rename's update waits the same way, and the name read here is the
        // one it committed, so the audit entry names the group as deleted.
        const locked = await tx.$queryRaw<{ name: string }[]>`
          SELECT "name" FROM "groups"
          WHERE "id" = ${groupId} AND "organizationId" = ${organizationId}
          FOR UPDATE`;
        const [group] = locked;
        if (!group) return { outcome: "STALE" } as const;
        // Counts the rows this deletion removes, not a concurrent removal's.
        const { count } = await tx.groupMember.deleteMany({ where: { groupId, organizationId } });
        await tx.group.delete({ where: { id: groupId } });
        await tx.auditLog.create({ data: auditLogData(audit({ name: group.name, removedMemberCount: count })) });
        return { outcome: "DELETED", removedMemberCount: count } as const;
      });
    },

    async listMembers(organizationId, groupId) {
      return (
        await prisma.groupMember.findMany({ where: { groupId, organizationId }, orderBy: { userId: "asc" } })
      ).map(toGroupMember);
    },

    async addMember(member, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          await tx.groupMember.create({ data: member });
          await tx.auditLog.create({ data: auditLogData(audit) });
          return "ADDED" as const;
        });
      } catch (error) {
        // The member is already in the group, also when a concurrent addition
        // won: nothing is written.
        if (isUniqueConflict(error, "GroupMember", "userId")) return "ALREADY_IN_GROUP";
        if (isMissingGroupOrMember(error)) return "STALE";
        throw error;
      }
    },

    async removeMember(organizationId, groupId, userId, audit) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.groupMember.deleteMany({ where: { groupId, organizationId, userId } });
        if (count === 0) return false;
        await tx.auditLog.create({ data: auditLogData(audit) });
        return true;
      });
    },
  };
}
