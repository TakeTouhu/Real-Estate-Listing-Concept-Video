import type {
  Group as DbGroup,
  GroupMember as DbGroupMember,
  GroupPermission as DbGroupPermission,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  isPermission,
  type Group,
  type GroupMember,
  type GroupPermission,
  type GroupRepository,
  type LockedGroup,
  type Permission,
} from "@app/domain";
import { auditLogData } from "./audit-log-data";
import { releaseProperties } from "./property-release";

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

function toPermission(value: string): Permission {
  if (!isPermission(value)) throw new Error(`Unknown permission on a group: ${value}`);
  return value;
}

function toGroupPermission(r: DbGroupPermission): GroupPermission {
  return {
    groupId: r.groupId,
    organizationId: r.organizationId,
    permission: toPermission(r.permission),
    grantedByUserId: r.grantedByUserId,
    grantedAt: r.grantedAt,
  };
}

/**
 * Lock a group's row and read it as a change's ceiling check needs it: its
 * members with their roles, and its permissions. Every change that gives or
 * takes a permission writes only under this lock, so what is read here is what
 * the change commits against. `UPDATE` excludes every other change to the
 * group; `SHARE` excludes only those, so additions and removals still run
 * alongside each other. Null when the group is gone.
 */
async function lockGroup(
  tx: Prisma.TransactionClient,
  organizationId: string,
  groupId: string,
  mode: "UPDATE" | "SHARE",
): Promise<(LockedGroup & { readonly name: string }) | null> {
  const [group] =
    mode === "UPDATE"
      ? await tx.$queryRaw<{ name: string }[]>`
          SELECT "name" FROM "groups"
          WHERE "id" = ${groupId} AND "organizationId" = ${organizationId}
          FOR UPDATE`
      : await tx.$queryRaw<{ name: string }[]>`
          SELECT "name" FROM "groups"
          WHERE "id" = ${groupId} AND "organizationId" = ${organizationId}
          FOR SHARE`;
  if (!group) return null;
  const members = await tx.groupMember.findMany({
    where: { groupId, organizationId },
    select: { userId: true, membership: { select: { role: true } } },
    orderBy: { userId: "asc" },
  });
  const permissions = await tx.groupPermission.findMany({ where: { groupId, organizationId }, select: { permission: true } });
  return {
    name: group.name,
    members: members.map((m) => ({ userId: m.userId, role: m.membership.role })),
    permissions: permissions.map((p) => toPermission(p.permission)),
  };
}

/**
 * The permissions a member holds through its groups. Read on every
 * authorization, and inside a purchase's transaction (UP-2): from the member's
 * group rows by their (organization, user) index, then each group's permissions
 * by key.
 */
export async function groupPermissionsForMember(
  db: Prisma.TransactionClient | PrismaClient,
  organizationId: string,
  userId: string,
): Promise<Permission[]> {
  const rows = await db.$queryRaw<{ permission: string }[]>`
    SELECT DISTINCT gp."permission"
    FROM "group_members" gm
    JOIN "group_permissions" gp ON gp."groupId" = gm."groupId" AND gp."organizationId" = gm."organizationId"
    WHERE gm."organizationId" = ${organizationId} AND gm."userId" = ${userId}`;
  return rows.map((r) => toPermission(r.permission));
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
 * Prisma-backed groups and their permissions (ADR-0060, ADR-0061). Every read
 * and write is scoped by organization, each change commits with its audit
 * entry or not at all, and each ceiling check runs under the group's lock.
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

    async delete(organizationId, groupId, check, audit) {
      return prisma.$transaction(async (tx) => {
        // Waits for, then excludes, every addition, removal, permission change
        // and rename in flight: each commits before the deletion (and is
        // judged, counted and named below) or finds the group gone.
        const group = await lockGroup(tx, organizationId, groupId, "UPDATE");
        if (!group) return { outcome: "STALE" } as const;
        const refusal = check(group);
        if (refusal !== null) return { outcome: "REFUSED", refusal } as const;
        // Ungroups its Properties (ADR-0052 Decision 11) before its members
        // go, locking Property rows before member rows as a member's removal
        // does. The group's lock keeps any new Property from joining it.
        const ungroupedPropertyCount = await releaseProperties(tx, organizationId, "groupId", groupId);
        // Counts the rows this deletion removes, not a concurrent removal's.
        const { count } = await tx.groupMember.deleteMany({ where: { groupId, organizationId } });
        await tx.group.delete({ where: { id: groupId } });
        await tx.auditLog.create({
          data: auditLogData(audit({ name: group.name, removedMemberCount: count, ungroupedPropertyCount })),
        });
        return { outcome: "DELETED", removedMemberCount: count } as const;
      });
    },

    async listMembers(organizationId, groupId) {
      return (
        await prisma.groupMember.findMany({ where: { groupId, organizationId }, orderBy: { userId: "asc" } })
      ).map(toGroupMember);
    },

    async listGroupIdsForMember(organizationId, userId) {
      return (
        await prisma.groupMember.findMany({ where: { organizationId, userId }, select: { groupId: true }, orderBy: { groupId: "asc" } })
      ).map((m) => m.groupId);
    },

    async addMember(member, check, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const group = await lockGroup(tx, member.organizationId, member.groupId, "SHARE");
          if (!group) return { outcome: "STALE" } as const;
          const refusal = check(group);
          if (refusal !== null) return { outcome: "REFUSED", refusal } as const;
          await tx.groupMember.create({ data: member });
          await tx.auditLog.create({ data: auditLogData(audit) });
          return { outcome: "ADDED" } as const;
        });
      } catch (error) {
        // The member is already in the group, also when a concurrent addition
        // won: nothing is written.
        if (isUniqueConflict(error, "GroupMember", "userId")) return { outcome: "ALREADY_IN_GROUP" };
        if (isMissingGroupOrMember(error)) return { outcome: "STALE" };
        throw error;
      }
    },

    async removeMember(organizationId, groupId, userId, check, audit) {
      return prisma.$transaction(async (tx) => {
        const group = await lockGroup(tx, organizationId, groupId, "SHARE");
        if (!group) return { outcome: "NOT_IN_GROUP" } as const;
        const refusal = check(group);
        if (refusal !== null) return { outcome: "REFUSED", refusal } as const;
        const { count } = await tx.groupMember.deleteMany({ where: { groupId, organizationId, userId } });
        if (count === 0) return { outcome: "NOT_IN_GROUP" } as const;
        await tx.auditLog.create({ data: auditLogData(audit) });
        return { outcome: "REMOVED" } as const;
      });
    },

    async listPermissions(organizationId, groupId) {
      return (await prisma.groupPermission.findMany({ where: { groupId, organizationId } })).map(toGroupPermission);
    },

    async listPermissionsForMember(organizationId, userId) {
      return groupPermissionsForMember(prisma, organizationId, userId);
    },

    async grantPermission(permission, check, audit) {
      return prisma.$transaction(async (tx) => {
        const group = await lockGroup(tx, permission.organizationId, permission.groupId, "UPDATE");
        if (!group) return { outcome: "STALE" } as const;
        const refusal = check(group);
        if (refusal !== null) return { outcome: "REFUSED", refusal } as const;
        // Every write of a group's permissions holds this lock, so the read is current.
        if (group.permissions.includes(permission.permission)) return { outcome: "ALREADY_GRANTED" } as const;
        await tx.groupPermission.create({ data: permission });
        await tx.auditLog.create({ data: auditLogData(audit(group.members.length)) });
        return { outcome: "GRANTED" } as const;
      });
    },

    async revokePermission(organizationId, groupId, permission, check, audit) {
      return prisma.$transaction(async (tx) => {
        const group = await lockGroup(tx, organizationId, groupId, "UPDATE");
        if (!group) return { outcome: "STALE" } as const;
        const refusal = check(group);
        if (refusal !== null) return { outcome: "REFUSED", refusal } as const;
        const { count } = await tx.groupPermission.deleteMany({ where: { groupId, organizationId, permission } });
        if (count === 0) return { outcome: "NOT_GRANTED" } as const;
        await tx.auditLog.create({ data: auditLogData(audit(group.members.length)) });
        return { outcome: "REVOKED" } as const;
      });
    },
  };
}
