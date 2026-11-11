import type { OrganizationSubscription } from "../entitlement/subscription";
import type { Invitation } from "../identity/types";
import { createCustomerPlanCatalog } from "../pricing/customer-plan-catalog";

/**
 * An organization's seats (ADR-0134). Every member takes one, the `OWNER`
 * included, and so does an invitation while it can still be accepted. Until
 * seat purchase is built, the seats are the plan's included users (Standard 3,
 * Premium 10, Enterprise 30), and an organization with no plan has none.
 */

/** The seats `subscription`'s plan includes; `null` while the organization has no plan. */
export function includedSeats(subscription: Pick<OrganizationSubscription, "planKey"> | null): number | null {
  if (subscription === null) return null;
  const plan = createCustomerPlanCatalog().find(subscription.planKey);
  if (plan === undefined) throw new Error(`No customer plan named ${subscription.planKey}`);
  return plan.includedUsers;
}

/**
 * Whether `invitation` holds a seat at `now`: it is pending and has not expired,
 * so it can still be accepted. An expired one holds none, whether or not it has
 * been marked `EXPIRED` yet.
 */
export function holdsSeat(invitation: Pick<Invitation, "status" | "expiresAt">, now: Date): boolean {
  return invitation.status === "PENDING" && invitation.expiresAt.getTime() > now.getTime();
}
