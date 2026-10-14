import type { Prisma } from "@prisma/client";
import type { AuditLog } from "@app/domain";

/** An audit entry as a row, for repositories that write one in their own transaction. */
export function auditLogData(input: Omit<AuditLog, "id" | "createdAt">): Prisma.AuditLogUncheckedCreateInput {
  return {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata as Prisma.InputJsonValue,
  };
}
