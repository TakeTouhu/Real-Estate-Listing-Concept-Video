/**
 * Listing invoice-paid Unit purchases for invoicing (UP-4, ADR-0069).
 *
 * The read and its audit entries share one transaction: an organization is
 * audited exactly when its purchases are returned, and nothing is returned
 * unless every audit entry was written.
 */

import type { PrismaClient } from "@prisma/client";
import { UNIT_PURCHASE_EXPORT_AUDIT_ACTION, type UnitPurchaseInvoicingRepository } from "@app/domain";

export function createUnitPurchaseInvoicingRepository(prisma: PrismaClient): UnitPurchaseInvoicingRepository {
  return {
    exportForInvoicing({ from, to, operator }) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.unitPurchase.findMany({
          where: { channel: "SALES_ASSISTED", approvedAt: { gte: from, lt: to } },
          include: {
            organization: { select: { name: true } },
            addOnBlock: { select: { quantity: true } },
            entitlementPeriod: { select: { endsAt: true } },
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
              },
            },
          });
        }
        return purchases;
      });
    },
  };
}
