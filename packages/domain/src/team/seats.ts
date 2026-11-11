import type { OrganizationSubscription, SubscriptionRepository } from "../entitlement/subscription";
import { isOpenInvitation } from "../identity/membership-service";
import type { Invitation } from "../identity/types";
import { createCustomerPlanCatalog } from "../pricing/customer-plan-catalog";

/**
 * An organization's seats (ADR-0134). Every member takes one, the `OWNER`
 * included, and so does a pending invitation until it expires. Until seat
 * purchase is built, the seats are the plan's included users (Standard 3,
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
 * at the boundary acceptance uses. It holds its seat even where acceptance would
 * now refuse it for another reason (its inviter has left, say). An expired one
 * holds none, whether or not it has been marked `EXPIRED` yet.
 */
export function holdsSeat(invitation: Pick<Invitation, "status" | "expiresAt">, now: Date): boolean {
  return isOpenInvitation(invitation, now);
}

/**
 * The seats each organization's plan includes, read from its subscription, for
 * the membership service's invitations (ADR-0135). A plan whose first period
 * has not started yet gives its seats as well.
 */
export function includedSeatsFrom(
  subscriptions: Pick<SubscriptionRepository, "findByOrganization">,
): (organizationId: string) => Promise<number | null> {
  return async (organizationId) => includedSeats(await subscriptions.findByOrganization(organizationId));
}
