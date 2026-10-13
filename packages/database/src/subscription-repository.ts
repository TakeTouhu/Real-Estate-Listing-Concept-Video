/**
 * The organization subscription's persistence (Phase 6B, ADR-0056).
 *
 * One row per organization, written once by the billing layer or an operator
 * and read by renewal. It takes no lock: the unique organization id orders two
 * concurrent provisions, and the loser re-reads the winner and answers exactly as
 * a sequential replay would.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  provisionRefusal,
  type CustomerPlanKey,
  type OrganizationSubscription,
  type ProvisionSubscriptionInput,
  type ProvisionSubscriptionOutcome,
  type SubscriptionRepository,
} from "@app/domain";

type SubscriptionRow = Prisma.OrganizationSubscriptionGetPayload<object>;

const PLAN_KEY_TO_ROW = {
  standard: "STANDARD",
  premium: "PREMIUM",
  enterprise: "ENTERPRISE",
} as const satisfies Record<CustomerPlanKey, SubscriptionRow["planKey"]>;

const PLAN_KEY_FROM_ROW: Record<SubscriptionRow["planKey"], CustomerPlanKey> = {
  STANDARD: "standard",
  PREMIUM: "premium",
  ENTERPRISE: "enterprise",
};

export const SUBSCRIPTION_AUDIT_ACTION = {
  Provisioned: "subscription.provisioned",
} as const;

function toSubscription(row: SubscriptionRow): OrganizationSubscription {
  return {
    id: row.id,
    organizationId: row.organizationId,
    planKey: PLAN_KEY_FROM_ROW[row.planKey],
    channel: row.channel,
    anchorAt: row.anchorAt,
    commercialReference: row.commercialReference,
    createdAt: row.createdAt,
  };
}

function factsMatch(row: SubscriptionRow, input: ProvisionSubscriptionInput): boolean {
  return (
    row.id === input.id &&
    row.planKey === PLAN_KEY_TO_ROW[input.planKey] &&
    row.channel === input.channel &&
    row.anchorAt.getTime() === input.anchorAt.getTime() &&
    row.commercialReference === input.commercialReference
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createSubscriptionRepository(prisma: PrismaClient): SubscriptionRepository {
  function replayOf(row: SubscriptionRow, input: ProvisionSubscriptionInput): ProvisionSubscriptionOutcome {
    return factsMatch(row, input)
      ? { kind: "ALREADY_PROVISIONED", subscription: toSubscription(row) }
      : { kind: "CONFLICT" };
  }

  function provisionWithin(input: ProvisionSubscriptionInput): Promise<ProvisionSubscriptionOutcome> {
    return prisma.$transaction(async (tx): Promise<ProvisionSubscriptionOutcome> => {
      const existing = await tx.organizationSubscription.findUnique({
        where: { organizationId: input.organizationId },
      });
      if (existing !== null) return replayOf(existing, input);
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true },
      });
      if (organization === null) return { kind: "ORGANIZATION_NOT_FOUND" };

      const row = await tx.organizationSubscription.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          planKey: PLAN_KEY_TO_ROW[input.planKey],
          channel: input.channel,
          anchorAt: input.anchorAt,
          commercialReference: input.commercialReference,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: SUBSCRIPTION_AUDIT_ACTION.Provisioned,
          resourceType: "organization_subscription",
          resourceId: row.id,
          metadata: {
            planKey: input.planKey,
            channel: row.channel,
            anchorAt: row.anchorAt.toISOString(),
            commercialReference: row.commercialReference,
          },
        },
      });
      return { kind: "PROVISIONED", subscription: toSubscription(row) };
    });
  }

  return {
    /**
     * Record which plan an organization is on. Written once: a replay with the
     * same facts returns it, anything else is a conflict. Plan changes are a
     * later package and do not go through here.
     */
    async provision(input): Promise<ProvisionSubscriptionOutcome> {
      const refusal = provisionRefusal(input);
      if (refusal !== null) return { kind: refusal };
      try {
        return await provisionWithin(input);
      } catch (error) {
        // Two first provisions of one organization both pass the read above and
        // collide on the unique organization id, or on the id itself.
        if (!isUniqueViolation(error)) throw error;
        const winner = await prisma.organizationSubscription.findUnique({
          where: { organizationId: input.organizationId },
        });
        if (winner === null) return { kind: "CONFLICT" };
        return replayOf(winner, input);
      }
    },

    async findByOrganization(organizationId) {
      const row = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
      return row === null ? null : toSubscription(row);
    },
  };
}
