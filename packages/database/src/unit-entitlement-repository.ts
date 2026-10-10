/**
 * The Unit entitlement ledger's persistence (Phase 6A, ADR-0055).
 *
 * Periods and blocks are written here, by the inputs a later billing layer will
 * supply. Reservations are not: they draw on the ledger inside Transaction B
 * (`orchestration-repositories.ts:reserve`), which reuses `loadPeriodBalance`
 * from this file so the balance it allocates against is computed exactly the way
 * the read side computes it.
 *
 * ## Locks
 *
 * - **Opening a period** takes an organization-scoped advisory lock of its own,
 *   only to make the overlap check and the insert one decision. It takes no
 *   other lock, so it cannot form a cycle with anything.
 * - **Granting a block** takes the cost-admission lock for the period's
 *   organization and cycle — the outermost lock in the system — so a grant and a
 *   reservation against the same period are ordered. It takes nothing after it
 *   but its own inserts.
 * - **Reading a balance** takes no lock. Callers that act on a balance hold the
 *   cost-admission lock themselves.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  entitlementSnapshotForPlan,
  periodEntitlementBalance,
  type CustomerPlanKey,
  type GenerationReservationAllocation,
  type GrantAddOnBlockInput,
  type GrantAddOnBlockOutcome,
  type OpenEntitlementPeriodInput,
  type OpenEntitlementPeriodOutcome,
  type PeriodEntitlementBalance,
  type UnitAddOnBlock,
  type UnitEntitlementPeriod,
  type UnitEntitlementRepository,
} from "@app/domain";
import { AppError } from "@app/shared";
import {
  acquireCostAdmissionLock,
  acquireEntitlementPeriodOpeningLock,
} from "./cost-admission-lock";

type Tx = Prisma.TransactionClient;
type PeriodRow = Prisma.UnitEntitlementPeriodGetPayload<object>;
type BlockRow = Prisma.UnitAddOnBlockGetPayload<object>;
type AllocationRow = Prisma.GenerationReservationAllocationGetPayload<object>;

const PLAN_KEY_TO_ROW = {
  standard: "STANDARD",
  premium: "PREMIUM",
  enterprise: "ENTERPRISE",
} as const satisfies Record<CustomerPlanKey, PeriodRow["planKey"]>;

const PLAN_KEY_FROM_ROW: Record<PeriodRow["planKey"], CustomerPlanKey> = {
  STANDARD: "standard",
  PREMIUM: "premium",
  ENTERPRISE: "enterprise",
};

/** Audit actions the ledger writes to `audit_logs`. */
export const ENTITLEMENT_AUDIT_ACTION = {
  PeriodOpened: "entitlement.period_opened",
  AddOnBlockGranted: "entitlement.add_on_block_granted",
} as const;

export function toEntitlementPeriod(row: PeriodRow): UnitEntitlementPeriod {
  return {
    id: row.id,
    organizationId: row.organizationId,
    billingCycleKey: row.billingCycleKey,
    planKey: PLAN_KEY_FROM_ROW[row.planKey],
    baseUnits: row.baseUnits,
    includedHighQualityUnits: row.includedHighQualityUnits,
    highQualityAddOnAvailable: row.highQualityAddOnAvailable,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    commercialReference: row.commercialReference,
    createdAt: row.createdAt,
  };
}

function toBlock(row: BlockRow): UnitAddOnBlock {
  return {
    id: row.id,
    organizationId: row.organizationId,
    entitlementPeriodId: row.entitlementPeriodId,
    quality: row.quality,
    quantity: row.quantity,
    commercialReference: row.commercialReference,
    purchasedAt: row.purchasedAt,
    createdAt: row.createdAt,
  };
}

export function toAllocation(row: AllocationRow): GenerationReservationAllocation {
  return {
    id: row.id,
    reservationId: row.reservationId,
    organizationId: row.organizationId,
    entitlementPeriodId: row.entitlementPeriodId,
    ordinal: row.ordinal,
    sourceType: row.sourceType,
    addOnBlockId: row.addOnBlockId,
    quality: row.quality,
    quantity: row.quantity,
    createdAt: row.createdAt,
  };
}

/**
 * The organization's period whose bounds contain `at`, or `null`.
 *
 * Overlap is refused when a period is opened, so more than one match means the
 * ledger is inconsistent; spending against an ambiguous period would be choosing
 * one at random, so it is a defect rather than a pick.
 */
export async function findPeriodContaining(
  tx: Tx | PrismaClient,
  organizationId: string,
  at: Date,
): Promise<UnitEntitlementPeriod | null> {
  const rows = await tx.unitEntitlementPeriod.findMany({
    where: { organizationId, startsAt: { lte: at }, endsAt: { gt: at } },
    take: 2,
  });
  if (rows.length > 1) {
    throw new AppError("INTERNAL_ERROR", "Overlapping Unit entitlement periods", {
      details: { organizationId },
    });
  }
  const row = rows[0];
  return row === undefined ? null : toEntitlementPeriod(row);
}

/**
 * What remains of a period, computed by the domain from the period's plan
 * snapshot, its blocks and every allocation drawn against it with that
 * allocation's reservation state.
 *
 * Every allocation is loaded, released ones included, and the domain decides
 * which still occupy entitlement. A `WHERE state <> 'RELEASED'` here would be a
 * second statement of the release rule, and the two could disagree.
 */
export async function loadPeriodBalance(
  tx: Tx | PrismaClient,
  period: UnitEntitlementPeriod,
): Promise<PeriodEntitlementBalance> {
  const blocks = await tx.unitAddOnBlock.findMany({
    where: { entitlementPeriodId: period.id, organizationId: period.organizationId },
  });
  const allocations = await tx.generationReservationAllocation.findMany({
    where: { entitlementPeriodId: period.id, organizationId: period.organizationId },
    select: {
      sourceType: true,
      addOnBlockId: true,
      quality: true,
      quantity: true,
      reservation: { select: { state: true } },
    },
  });
  return periodEntitlementBalance({
    plan: {
      baseUnits: period.baseUnits,
      includedHighQualityUnits: period.includedHighQualityUnits,
    },
    blocks: blocks.map((block) => ({
      id: block.id,
      quality: block.quality,
      quantity: block.quantity,
      purchasedAtEpochMs: block.purchasedAt.getTime(),
    })),
    allocations: allocations.map((allocation) => ({
      sourceType: allocation.sourceType,
      addOnBlockId: allocation.addOnBlockId,
      quality: allocation.quality,
      quantity: allocation.quantity,
      reservationState: allocation.reservation.state,
    })),
  });
}

function periodFactsMatch(row: PeriodRow, input: OpenEntitlementPeriodInput): boolean {
  return (
    row.id === input.id &&
    PLAN_KEY_FROM_ROW[row.planKey] === input.planKey &&
    row.startsAt.getTime() === input.startsAt.getTime() &&
    row.endsAt.getTime() === input.endsAt.getTime() &&
    row.commercialReference === input.commercialReference
  );
}

function blockFactsMatch(row: BlockRow, input: GrantAddOnBlockInput): boolean {
  return (
    row.id === input.id &&
    row.entitlementPeriodId === input.entitlementPeriodId &&
    row.quality === input.quality &&
    row.quantity === input.quantity &&
    row.purchasedAt.getTime() === input.purchasedAt.getTime()
  );
}

function isValidInstant(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function createUnitEntitlementRepository(prisma: PrismaClient): UnitEntitlementRepository {
  return {
    /**
     * Open one organization's entitlement for one period.
     *
     * The plan snapshot is derived from the catalog, never accepted. Replaying
     * the same period returns it; reusing its key with different facts, or
     * overlapping any other period of the organization, is refused.
     */
    async openPeriod(input): Promise<OpenEntitlementPeriodOutcome> {
      if (
        !isValidInstant(input.startsAt) ||
        !isValidInstant(input.endsAt) ||
        input.endsAt.getTime() <= input.startsAt.getTime() ||
        input.billingCycleKey.length === 0 ||
        input.commercialReference === ""
      ) {
        return { kind: "INVALID_PERIOD" };
      }
      const snapshot = entitlementSnapshotForPlan(input.planKey);

      return prisma.$transaction(async (tx): Promise<OpenEntitlementPeriodOutcome> => {
        await acquireEntitlementPeriodOpeningLock(tx, input.organizationId);

        const sameKey = await tx.unitEntitlementPeriod.findUnique({
          where: {
            organizationId_billingCycleKey: {
              organizationId: input.organizationId,
              billingCycleKey: input.billingCycleKey,
            },
          },
        });
        if (sameKey !== null) {
          return periodFactsMatch(sameKey, input)
            ? { kind: "ALREADY_OPEN", period: toEntitlementPeriod(sameKey) }
            : { kind: "CONFLICT" };
        }

        const overlapping = await tx.unitEntitlementPeriod.findFirst({
          where: {
            organizationId: input.organizationId,
            startsAt: { lt: input.endsAt },
            endsAt: { gt: input.startsAt },
          },
          select: { id: true },
        });
        if (overlapping !== null) return { kind: "OVERLAPS_EXISTING_PERIOD" };

        const row = await tx.unitEntitlementPeriod.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            billingCycleKey: input.billingCycleKey,
            planKey: PLAN_KEY_TO_ROW[snapshot.planKey],
            baseUnits: snapshot.baseUnits,
            includedHighQualityUnits: snapshot.includedHighQualityUnits,
            highQualityAddOnAvailable: snapshot.highQualityAddOnAvailable,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            commercialReference: input.commercialReference,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            action: ENTITLEMENT_AUDIT_ACTION.PeriodOpened,
            resourceType: "unit_entitlement_period",
            resourceId: row.id,
            metadata: {
              billingCycleKey: row.billingCycleKey,
              planKey: input.planKey,
              baseUnits: row.baseUnits,
              includedHighQualityUnits: row.includedHighQualityUnits,
              startsAt: row.startsAt.toISOString(),
              endsAt: row.endsAt.toISOString(),
            },
          },
        });
        return { kind: "OPENED", period: toEntitlementPeriod(row) };
      });
    },

    /**
     * Grant one purchased, quality-locked block to a period.
     *
     * Ordered against reservations on the same period by the cost-admission
     * lock. An HQ block on a plan that sells none is refused: the ledger must be
     * able to refuse an ineligible block, not only skip one.
     */
    async grantAddOnBlock(input): Promise<GrantAddOnBlockOutcome> {
      if (
        !Number.isSafeInteger(input.quantity) ||
        input.quantity <= 0 ||
        input.commercialReference.length === 0 ||
        !isValidInstant(input.purchasedAt)
      ) {
        return { kind: "INVALID_BLOCK" };
      }

      return prisma.$transaction(async (tx): Promise<GrantAddOnBlockOutcome> => {
        const periodRow = await tx.unitEntitlementPeriod.findFirst({
          where: { id: input.entitlementPeriodId, organizationId: input.organizationId },
        });
        if (periodRow === null) return { kind: "PERIOD_NOT_FOUND" };
        await acquireCostAdmissionLock(tx, input.organizationId, periodRow.billingCycleKey);

        const existing = await tx.unitAddOnBlock.findUnique({
          where: {
            organizationId_commercialReference: {
              organizationId: input.organizationId,
              commercialReference: input.commercialReference,
            },
          },
        });
        if (existing !== null) {
          return blockFactsMatch(existing, input)
            ? { kind: "ALREADY_GRANTED", block: toBlock(existing) }
            : { kind: "CONFLICT" };
        }
        if (input.quality === "HIGH_QUALITY" && !periodRow.highQualityAddOnAvailable) {
          return { kind: "HIGH_QUALITY_ADD_ON_NOT_AVAILABLE" };
        }

        const row = await tx.unitAddOnBlock.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            entitlementPeriodId: input.entitlementPeriodId,
            quality: input.quality,
            quantity: input.quantity,
            commercialReference: input.commercialReference,
            purchasedAt: input.purchasedAt,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            action: ENTITLEMENT_AUDIT_ACTION.AddOnBlockGranted,
            resourceType: "unit_add_on_block",
            resourceId: row.id,
            metadata: {
              entitlementPeriodId: row.entitlementPeriodId,
              billingCycleKey: periodRow.billingCycleKey,
              quality: row.quality,
              quantity: row.quantity,
              commercialReference: row.commercialReference,
              purchasedAt: row.purchasedAt.toISOString(),
            },
          },
        });
        return { kind: "GRANTED", block: toBlock(row) };
      });
    },

    async findPeriodAt(organizationId, at) {
      return findPeriodContaining(prisma, organizationId, at);
    },

    async balance(organizationId, entitlementPeriodId) {
      const row = await prisma.unitEntitlementPeriod.findFirst({
        where: { id: entitlementPeriodId, organizationId },
      });
      return row === null ? null : loadPeriodBalance(prisma, toEntitlementPeriod(row));
    },

    async allocationsForReservation(organizationId, reservationId) {
      const rows = await prisma.generationReservationAllocation.findMany({
        where: { reservationId, organizationId },
        orderBy: { ordinal: "asc" },
      });
      return rows.map(toAllocation);
    },
  };
}

