import type { Prisma } from "@prisma/client";

/**
 * Release every Property of the organization assigned to `id` as its
 * responsible user or its group (ADR-0062), and count them. Called by a
 * member's removal and a group's deletion, after each has locked the row the
 * Properties refer to, so no Property can be assigned to it meanwhile.
 *
 * The Properties are locked in id order first. Locked, each stays assigned to
 * `id` until this transaction ends, so the update releases exactly those, and
 * not one a concurrent reassignment took away while this waited. A removal and
 * a deletion that release the same Properties lock them in the same order, so
 * neither can hold one the other waits for while waiting for another.
 */
export async function releaseProperties(
  tx: Prisma.TransactionClient,
  organizationId: string,
  assignment: "responsibleUserId" | "groupId",
  id: string,
): Promise<number> {
  const rows =
    assignment === "groupId"
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "properties"
          WHERE "organizationId" = ${organizationId} AND "groupId" = ${id}
          ORDER BY "id"
          FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "properties"
          WHERE "organizationId" = ${organizationId} AND "responsibleUserId" = ${id}
          ORDER BY "id"
          FOR UPDATE`;
  const { count } = await tx.property.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: assignment === "groupId" ? { groupId: null } : { responsibleUserId: null },
  });
  return count;
}
