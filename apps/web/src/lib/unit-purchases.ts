import { UnitPurchaseService } from "@app/domain";
import {
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseRepository,
  getPrismaClient,
} from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { getRateLimiter } from "./rate-limit";
import { PURCHASE_NOT_CONFIRMED } from "./unit-purchase-form";

let purchases: UnitPurchaseService | undefined;
let logger: Logger | undefined;

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

export function getUnitPurchaseLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "unit-purchase" } });
  return logger;
}

/**
 * One approval, counted by the approving account before the purchase service,
 * so before its permission is checked, its refusal audited or anything bought,
 * and never given back (ADR-0173 Decisions 1, 3 and 4): `null` when the limit
 * lets it through, else the text the buy page shows. Its own `try`, as the
 * route rethrows what is not an `AppError`: a limiter that cannot answer, or
 * cannot be built, refuses the approval with the page's own failure text, never
 * the limiter's, and is logged by its error code alone (Decision 9).
 */
export async function countUnitPurchase(actorUserId: string, log: Pick<Logger, "error">): Promise<string | null> {
  try {
    const now = getIdentityServices().deps.clock.now();
    const request = await getRateLimiter().account("UNIT_PURCHASE", actorUserId, now);
    return request.allowed ? null : request.message;
  } catch (error) {
    log.error("A purchase approval could not be counted", {
      code: error instanceof AppError ? error.code : "UNEXPECTED",
    });
    return PURCHASE_NOT_CONFIRMED;
  }
}
