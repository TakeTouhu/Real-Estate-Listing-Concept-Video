import { MembersOverviewService } from "@app/domain";
import { createSubscriptionRepository, getPrismaClient } from "@app/database";
import { getIdentityServices } from "./identity";

let overview: MembersOverviewService | undefined;

/**
 * Who belongs to an organization, who is invited, and its seats (ADR-0134).
 * Server-only. It reads the members, their accounts, the invitations and the
 * subscription, and writes nothing.
 */
export function getMembersOverviewService(): MembersOverviewService {
  if (overview) return overview;
  overview = new MembersOverviewService({
    identity: getIdentityServices().deps,
    subscriptions: createSubscriptionRepository(getPrismaClient()),
  });
  return overview;
}
