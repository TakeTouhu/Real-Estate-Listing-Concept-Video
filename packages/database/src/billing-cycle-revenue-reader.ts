/**
 * A billing cycle's revenue, read from its entitlement period (GS-5b,
 * ADR-0091).
 *
 * The rule is the domain's `billingCycleRevenueYen`: the plan the period was
 * opened on, its monthly price, and the period's Unit purchases with whether
 * each was cancelled. This reads those facts and nothing else: no seat, no
 * storage block, no invoice.
 *
 * One statement, so the period, its purchases and their cancellations are one
 * snapshot. The gate calls it while holding the cycle's cost-admission lock,
 * which a purchase's block grant and a cancellation also take, so neither can
 * commit between this read and the decision it feeds.
 */

import type { PrismaClient } from "@prisma/client";
import {
  billingCycleRevenueYen,
  yen,
  type BillingCycleRevenueReader,
  type CustomerPlanKey,
} from "@app/domain";

const PLAN_KEY_FROM_ROW: Readonly<Record<string, CustomerPlanKey>> = {
  STANDARD: "standard",
  PREMIUM: "premium",
  ENTERPRISE: "enterprise",
};

interface RevenueRow {
  readonly planKey: string;
  /** `null` on the one row of a period with no purchase. */
  readonly priceYenExTax: number | null;
  readonly cancelled: boolean;
}

export function createBillingCycleRevenueReader(prisma: PrismaClient): BillingCycleRevenueReader {
  return {
    async revenueYen({ organizationId, billingCycleKey }) {
      const rows = await prisma.$queryRaw<RevenueRow[]>`
        SELECT p."planKey"::text AS "planKey",
               u."priceYenExTax" AS "priceYenExTax",
               (c."purchaseId" IS NOT NULL) AS "cancelled"
          FROM "unit_entitlement_periods" p
          LEFT JOIN "unit_purchases" u
            ON u."entitlementPeriodId" = p."id" AND u."organizationId" = p."organizationId"
          LEFT JOIN "unit_purchase_cancellations" c
            ON c."purchaseId" = u."id" AND c."organizationId" = u."organizationId"
         WHERE p."organizationId" = ${organizationId}
           AND p."billingCycleKey" = ${billingCycleKey}
      `;
      const first = rows[0];
      // No period for this organization and cycle: nothing is known.
      if (first === undefined) return null;
      const planKey = PLAN_KEY_FROM_ROW[first.planKey];
      if (planKey === undefined) return null;
      const purchases = rows.flatMap((row) =>
        row.priceYenExTax === null ? [] : [{ priceYenExTax: yen(row.priceYenExTax), cancelled: row.cancelled }],
      );
      return billingCycleRevenueYen({ planKey, purchases });
    },
  };
}
