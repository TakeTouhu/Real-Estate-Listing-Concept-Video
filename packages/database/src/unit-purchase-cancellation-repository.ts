/**
 * Cancelling a mistaken Unit purchase (UP-5, ADR-0070).
 *
 * The cancellation and its audit entry commit together or not at all. The write
 * takes the purchase's period's cost-admission lock first, as a purchase and a
 * reservation do, then reads the purchase and its block's allocations under it.
 * So a reservation drawing on the block is either admitted before the
 * cancellation, and counted as in flight, or after it, and refused the block by
 * the ledger (`loadPeriodBalance`). Two cancellations of one purchase are
 * ordered the same way, and the second finds the first.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> inserts
 * ```
 *
 * The purchase is located before the lock only to name the period's lock key:
 * a purchase never changes period, and nothing is decided on that read.
 *
 * The cancellation is stamped with the database's clock, not the clock of the
 * machine that ran the command, as billing evidence an export compares with
 * the database's clock too.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  UNIT_PURCHASE_CANCELLED_AUDIT_ACTION,
  unitPurchaseUsage,
  type CancellableUnitPurchase,
  type UnitPurchaseCancellationRepository,
} from "@app/domain";
import { acquireCostAdmissionLock } from "./cost-admission-lock";

type Tx = Prisma.TransactionClient;

const PURCHASE_FACTS = {
  organization: { select: { name: true } },
  addOnBlock: {
    select: { quantity: true, allocations: { select: { quantity: true, reservation: { select: { state: true } } } } },
  },
  entitlementPeriod: { select: { endsAt: true } },
  cancellations: { select: { operatorName: true, reason: true, cancelledAt: true } },
} as const;

async function read(db: Tx | PrismaClient, purchaseId: string): Promise<CancellableUnitPurchase | null> {
  const row = await db.unitPurchase.findUnique({ where: { id: purchaseId }, include: PURCHASE_FACTS });
  if (row === null) return null;
  return {
    purchaseId: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    quality: row.quality,
    units: row.addOnBlock.quantity,
    priceYenExTax: row.priceYenExTax,
    invoicePaid: row.channel === "SALES_ASSISTED",
    contractReference: row.contractReference,
    approvedAt: row.approvedAt,
    expiresAt: row.entitlementPeriod.endsAt,
    usage: unitPurchaseUsage(
      row.addOnBlock.quantity,
      row.addOnBlock.allocations.map((allocation) => ({
        quantity: allocation.quantity,
        reservationState: allocation.reservation.state,
      })),
    ),
    cancellation: row.cancellations[0] ?? null,
  };
}

export function createUnitPurchaseCancellationRepository(prisma: PrismaClient): UnitPurchaseCancellationRepository {
  return {
    find(purchaseId) {
      return read(prisma, purchaseId);
    },

    cancel({ purchaseId, operator }) {
      return prisma.$transaction(async (tx) => {
        const located = await tx.unitPurchase.findUnique({
          where: { id: purchaseId },
          select: { organizationId: true, entitlementPeriod: { select: { billingCycleKey: true } } },
        });
        if (located === null) return { kind: "NOT_FOUND" as const };
        await acquireCostAdmissionLock(tx, located.organizationId, located.entitlementPeriod.billingCycleKey);

        const purchase = await read(tx, purchaseId);
        if (purchase === null) return { kind: "NOT_FOUND" as const };
        if (purchase.cancellation !== null) {
          return { kind: "ALREADY_CANCELLED" as const, purchase: { ...purchase, cancellation: purchase.cancellation } };
        }
        if (!purchase.invoicePaid) return { kind: "CARD_PAID" as const, purchase };

        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
        const cancellation = await tx.unitPurchaseCancellation.create({
          data: {
            purchaseId,
            organizationId: purchase.organizationId,
            operatorName: operator.name.trim(),
            reason: operator.reason.trim(),
            cancelledAt: now,
          },
          select: { operatorName: true, reason: true, cancelledAt: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId: purchase.organizationId,
            actorUserId: null,
            action: UNIT_PURCHASE_CANCELLED_AUDIT_ACTION,
            resourceType: "unit_purchase",
            resourceId: purchaseId,
            metadata: {
              operator: cancellation.operatorName,
              reason: cancellation.reason,
              quality: purchase.quality,
              units: purchase.units,
              priceYenExTax: purchase.priceYenExTax,
              contractReference: purchase.contractReference,
              approvedAt: purchase.approvedAt.toISOString(),
              unitsConsumed: purchase.usage.consumed,
              unitsInFlight: purchase.usage.inFlight,
              unitsWithdrawn: purchase.usage.unused,
            },
          },
        });
        return { kind: "CANCELLED" as const, purchase: { ...purchase, cancellation } };
      });
    },
  };
}
