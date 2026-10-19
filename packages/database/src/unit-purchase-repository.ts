/**
 * The Unit purchase record's persistence (UP-2, ADR-0067).
 *
 * A purchase, the block it buys and their audit entries commit together or not
 * at all. The write takes the period's cost-admission lock first, as a grant
 * and a reservation do, so purchases into one period are ordered against each
 * other and against reservations drawing on it. Under that lock it re-reads
 * what the purchase was decided on and hands it to the domain's check:
 *
 * - **the period**, whose frozen plan prices the package;
 * - **the subscription**, for its plan, channel and contract;
 * - **the approver's effective permissions**, read under a share lock on its
 *   membership, so a role change or removal either commits first and is seen
 *   here or waits for this transaction.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> membership row (FOR SHARE) -> inserts
 * ```
 *
 * Nothing that locks a membership row waits for the cost-admission lock, so
 * this forms no cycle.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  effectivePermissions,
  isPermission,
  UNIT_PURCHASE_AUDIT_ACTION,
  type ApproveUnitPurchaseRecordOutcome,
  type Permission,
  type Role,
  type UnitPurchase,
  type UnitPurchaseRepository,
} from "@app/domain";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { groupPermissionsForMember } from "./group-repository";
import { toSubscription } from "./subscription-repository";
import { insertAddOnBlockWithin, toEntitlementPeriod } from "./unit-entitlement-repository";

type Tx = Prisma.TransactionClient;

/** A purchase's Units are its block's; its expiry is its period's end. */
const WITH_UNITS_AND_EXPIRY = {
  addOnBlock: { select: { quantity: true } },
  entitlementPeriod: { select: { endsAt: true } },
} as const;

type PurchaseRow = Prisma.UnitPurchaseGetPayload<{ include: typeof WITH_UNITS_AND_EXPIRY }>;

function toPurchase(row: PurchaseRow): UnitPurchase {
  return {
    id: row.id,
    organizationId: row.organizationId,
    entitlementPeriodId: row.entitlementPeriodId,
    addOnBlockId: row.addOnBlockId,
    quality: row.quality,
    units: row.addOnBlock.quantity,
    priceYenExTax: row.priceYenExTax,
    channel: row.channel,
    contractReference: row.contractReference,
    expiresAt: row.entitlementPeriod.endsAt,
    idempotencyKey: row.idempotencyKey,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
  };
}

async function findByKey(
  db: Tx | PrismaClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<UnitPurchase | null> {
  const row = await db.unitPurchase.findUnique({
    where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    include: WITH_UNITS_AND_EXPIRY,
  });
  return row === null ? null : toPurchase(row);
}

/** The approver's role and effective permissions now, or `null` once it is no longer a member. */
async function approverWithin(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<{ readonly role: Role; readonly permissions: readonly Permission[] } | null> {
  const [member] = await tx.$queryRaw<{ role: Role }[]>`
    SELECT "role" FROM "memberships"
    WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
    FOR SHARE`;
  if (member === undefined) return null;
  const grants = await tx.permissionGrant.findMany({ where: { organizationId, userId }, select: { permission: true } });
  const granted = grants.map(({ permission }) => {
    // The table's CHECK admits only the grantable vocabulary.
    if (!isPermission(permission)) throw new Error(`Unknown permission in grant: ${permission}`);
    return permission;
  });
  const fromGroups = await groupPermissionsForMember(tx, organizationId, userId);
  return { role: member.role, permissions: effectivePermissions(member.role, granted, fromGroups) };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createUnitPurchaseRepository(prisma: PrismaClient): UnitPurchaseRepository {
  const approveWithin: UnitPurchaseRepository["approve"] = (record, check) =>
    prisma.$transaction(async (tx): Promise<ApproveUnitPurchaseRecordOutcome> => {
      const periodRow = await tx.unitEntitlementPeriod.findFirst({
        where: { id: record.entitlementPeriodId, organizationId: record.organizationId },
      });
      if (periodRow === null) return { kind: "PERIOD_NOT_FOUND" };
      await acquireCostAdmissionLock(tx, record.organizationId, periodRow.billingCycleKey);

      const existing = await findByKey(tx, record.organizationId, record.idempotencyKey);
      if (existing !== null) return { kind: "EXISTING", purchase: existing };

      const approver = await approverWithin(tx, record.organizationId, record.approvedByUserId);
      const subscription = await tx.organizationSubscription.findUnique({
        where: { organizationId: record.organizationId },
      });
      const refusal = check({
        period: toEntitlementPeriod(periodRow),
        subscription: subscription === null ? null : toSubscription(subscription),
        approverPermissions: approver?.permissions ?? null,
      });
      if (refusal !== null) return { kind: "REFUSED", reason: refusal };

      const block = await insertAddOnBlockWithin(tx, periodRow, {
        id: record.addOnBlockId,
        organizationId: record.organizationId,
        entitlementPeriodId: record.entitlementPeriodId,
        quality: record.quality,
        quantity: record.units,
        commercialReference: `unit-purchase:${record.id}`,
        purchasedAt: record.approvedAt,
        actorUserId: record.approvedByUserId,
      });
      const row = await tx.unitPurchase.create({
        data: {
          id: record.id,
          organizationId: record.organizationId,
          entitlementPeriodId: record.entitlementPeriodId,
          addOnBlockId: block.id,
          quality: record.quality,
          priceYenExTax: record.priceYenExTax,
          channel: record.channel,
          contractReference: record.contractReference,
          idempotencyKey: record.idempotencyKey,
          approvedByUserId: record.approvedByUserId,
          approvedAt: record.approvedAt,
        },
        include: WITH_UNITS_AND_EXPIRY,
      });
      await tx.auditLog.create({
        data: {
          organizationId: record.organizationId,
          actorUserId: record.approvedByUserId,
          action: UNIT_PURCHASE_AUDIT_ACTION.Approved,
          resourceType: "unit_purchase",
          resourceId: row.id,
          metadata: {
            approverRole: approver?.role ?? null,
            entitlementPeriodId: row.entitlementPeriodId,
            addOnBlockId: row.addOnBlockId,
            quality: row.quality,
            units: row.addOnBlock.quantity,
            priceYenExTax: row.priceYenExTax,
            channel: row.channel,
            contractReference: row.contractReference,
            expiresAt: row.entitlementPeriod.endsAt.toISOString(),
          },
        },
      });
      return { kind: "APPROVED", purchase: toPurchase(row) };
    });

  return {
    findByIdempotencyKey(organizationId, idempotencyKey) {
      return findByKey(prisma, organizationId, idempotencyKey);
    },

    async listForPeriod(organizationId, entitlementPeriodId) {
      const rows = await prisma.unitPurchase.findMany({
        where: { organizationId, entitlementPeriodId },
        include: WITH_UNITS_AND_EXPIRY,
        orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      });
      return rows.map(toPurchase);
    },

    /**
     * Two approvals with one key into one period are ordered by the lock, and
     * the second finds the first. Into two periods they are not, and collide on
     * the key's unique index: the loser re-reads the winner and answers exactly
     * as the ordered case would.
     */
    async approve(record, check) {
      try {
        return await approveWithin(record, check);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await findByKey(prisma, record.organizationId, record.idempotencyKey);
        if (winner === null) throw error;
        return { kind: "EXISTING", purchase: winner };
      }
    },
  };
}
