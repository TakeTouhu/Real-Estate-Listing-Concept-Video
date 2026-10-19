import { UnitPurchaseService } from "@app/domain";
import {
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseRepository,
  getPrismaClient,
} from "@app/database";
import { getIdentityServices } from "./identity";

let purchases: UnitPurchaseService | undefined;

/**
 * Buying an additional Unit package (ADR-0067, ADR-0068). Server-only. It writes
 * through the purchase repository's one transaction and calls no payment
 * processor: an invoice-paid organization is invoiced under its contract.
 */
export function getUnitPurchaseService(): UnitPurchaseService {
  if (purchases) return purchases;
  const prisma = getPrismaClient();
  purchases = new UnitPurchaseService({
    identity: getIdentityServices().deps,
    subscriptions: createSubscriptionRepository(prisma),
    ledger: createUnitEntitlementRepository(prisma),
    purchases: createUnitPurchaseRepository(prisma),
  });
  return purchases;
}
