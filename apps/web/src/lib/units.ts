import { UnitsOverviewService } from "@app/domain";
import {
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseRepository,
  getPrismaClient,
} from "@app/database";
import { getIdentityServices } from "./identity";

let overview: UnitsOverviewService | undefined;

/**
 * What an organization has left to generate with (ADR-0066 Decision 3).
 * Server-only. It reads the subscription, the Unit ledger and the period's
 * purchases, and writes nothing.
 */
export function getUnitsOverviewService(): UnitsOverviewService {
  if (overview) return overview;
  const prisma = getPrismaClient();
  overview = new UnitsOverviewService({
    identity: getIdentityServices().deps,
    subscriptions: createSubscriptionRepository(prisma),
    ledger: createUnitEntitlementRepository(prisma),
    purchases: createUnitPurchaseRepository(prisma),
  });
  return overview;
}
