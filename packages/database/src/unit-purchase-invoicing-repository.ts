/**
 * Listing invoice-paid Unit purchases for invoicing (UP-4, ADR-0069).
 *
 * The read and its audit entries share one transaction: an organization is
 * audited exactly when its purchases are returned, and nothing is returned
 * unless every audit entry was written.
 *
 * No purchase approved inside the window can be recorded after the read
 * (ADR-0069 Decision 6):
 *
 * - the window must have ended the settle time ago by the database's clock, so
 *   every approval stamped inside it has finished its request;
 * - the read runs under a `SHARE` lock on `unit_purchases`, which waits for
 *   every transaction still inserting one and holds new ones off until the
 *   audit entries commit. An approval waits for it only at its insert, holding
 *   nothing the audit entries then need, so it forms no cycle.
 */

import type { PrismaClient } from "@prisma/client";
import {
  UNIT_PURCHASE_EXPORT_AUDIT_ACTION,
  UNIT_PURCHASE_EXPORT_SETTLE_MS,
  yenToInvoiceExTax,
  type UnitPurchaseInvoicingRepository,
} from "@app/domain";

export function createUnitPurchaseInvoicingRepository(prisma: PrismaClient): UnitPurchaseInvoicingRepository {
  return {
    exportForInvoicing({ from, to, operator }) {
      return prisma.$transaction(async (tx) => {
        const settlesAt = new Date(to.getTime() + UNIT_PURCHASE_EXPORT_SETTLE_MS);
        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
        if (now.getTime() < settlesAt.getTime()) return { kind: "NOT_SETTLED" as const, settlesAt };
        await tx.$executeRaw`LOCK TABLE "unit_purchases" IN SHARE MODE`;

        const rows = await tx.unitPurchase.findMany({
          where: { channel: "SALES_ASSISTED", approvedAt: { gte: from, lt: to } },
          include: {
            organization: { select: { name: true } },
            addOnBlock: { select: { quantity: true } },
            entitlementPeriod: { select: { endsAt: true } },
            cancellations: { select: { cancelledAt: true } },
          },
          orderBy: [{ organizationId: "asc" }, { contractReference: "asc" }, { approvedAt: "asc" }, { id: "asc" }],
        });
        const purchases = rows.map((row) => ({
          purchaseId: row.id,
          organizationId: row.organizationId,
          organizationName: row.organization.name,
          contractReference: row.contractReference,
          quality: row.quality,
          units: row.addOnBlock.quantity,
          priceYenExTax: row.priceYenExTax,
          approvedAt: row.approvedAt,
          expiresAt: row.entitlementPeriod.endsAt,
          cancelledAt: row.cancellations[0]?.cancelledAt ?? null,
        }));

        const organizationIds = [...new Set(purchases.map((purchase) => purchase.organizationId))];
        for (const organizationId of organizationIds) {
          const listed = purchases.filter((purchase) => purchase.organizationId === organizationId);
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: null,
              action: UNIT_PURCHASE_EXPORT_AUDIT_ACTION,
              resourceType: "organization",
              resourceId: organizationId,
              metadata: {
                operator: operator.name.trim(),
                reason: operator.reason.trim(),
                from: from.toISOString(),
                to: to.toISOString(),
                purchases: listed.length,
                priceYenExTax: listed.reduce((sum, purchase) => sum + purchase.priceYenExTax, 0),
                cancelled: listed.filter((purchase) => purchase.cancelledAt !== null).length,
                toInvoiceYenExTax: listed.reduce((sum, purchase) => sum + yenToInvoiceExTax(purchase), 0),
              },
            },
          });
        }
        return { kind: "EXPORTED" as const, purchases };
      });
    },
  };
}
