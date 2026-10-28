import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CustomerPlanKey, GenerationQualityTier } from "@app/domain";
import { createBillingCycleRevenueReader, createUnitEntitlementRepository } from "@app/database";
import { HAS_DB } from "./orchestration-fixture";

/**
 * A billing cycle's revenue, read from PostgreSQL (GS-5b, ADR-0091).
 *
 * The rule itself is proved without a database in
 * `packages/domain/src/authorization/revenue.test.ts`. What only a database can
 * prove is here: that the reader finds the cycle's period by organization and
 * key, reads the plan it was opened on, counts its own purchases and no other
 * period's or organization's, and leaves out a cancelled one.
 *
 * The suite's own organizations, so no period overlaps another suite's.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const ledger = HAS_DB
  ? createUnitEntitlementRepository(prisma)
  : (null as unknown as ReturnType<typeof createUnitEntitlementRepository>);
const reader = HAS_DB
  ? createBillingCycleRevenueReader(prisma)
  : (null as unknown as ReturnType<typeof createBillingCycleRevenueReader>);

const ORG_A = "org_itest_revenue_a";
const ORG_B = "org_itest_revenue_b";
const ORGS = [ORG_A, ORG_B];

let seq = 0;

async function cleanup(): Promise<void> {
  await prisma.unitPurchaseCancellation.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitPurchase.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: ORGS } } });
}

/** A one-month period of `planKey`, keyed by its month. */
async function period(organizationId: string, planKey: CustomerPlanKey, month: string): Promise<string> {
  const id = `uep_revenue_itest_${organizationId}_${month}`;
  const startsAt = new Date(`${month}-01T00:00:00.000Z`);
  const endsAt = new Date(startsAt);
  endsAt.setUTCMonth(endsAt.getUTCMonth() + 1);
  const opened = await ledger.openPeriod({
    id,
    organizationId,
    planKey,
    billingCycleKey: month,
    startsAt,
    endsAt,
    commercialReference: `sub_revenue_itest_${organizationId}`,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
  return id;
}

/** A purchase on `periodId` at `price`, and the block it bought; cancelled when asked. */
async function bought(
  organizationId: string,
  periodId: string,
  price: number,
  options: { readonly quality?: GenerationQualityTier; readonly cancelled?: boolean } = {},
): Promise<void> {
  seq += 1;
  const quality = options.quality ?? "NORMAL";
  const granted = await ledger.grantAddOnBlock({
    id: `uab_revenue_itest_${seq}`,
    organizationId,
    entitlementPeriodId: periodId,
    quality,
    quantity: 5,
    commercialReference: `unit-purchase:upur_revenue_itest_${seq}`,
    purchasedAt: new Date(),
    actorUserId: "usr_billing",
  });
  if (granted.kind !== "GRANTED") throw new Error(`block: ${granted.kind}`);
  const purchase = await prisma.unitPurchase.create({
    data: {
      id: `upur_revenue_itest_${seq}`,
      organizationId,
      entitlementPeriodId: periodId,
      addOnBlockId: granted.block.id,
      quality,
      priceYenExTax: price,
      channel: "SALES_ASSISTED",
      contractReference: "VT-REVENUE-1",
      idempotencyKey: `revenue-key-${seq}`,
      approvedByUserId: "usr_billing",
      approvedAt: new Date(),
    },
  });
  if (options.cancelled === true) {
    await prisma.unitPurchaseCancellation.create({
      data: {
        purchaseId: purchase.id,
        organizationId,
        fault: "VTAVISION",
        operatorName: "Aoi Tanaka",
        reason: "Bought by mistake",
      },
    });
  }
}

const revenueOf = (organizationId: string, billingCycleKey: string) =>
  reader.revenueYen({ organizationId, billingCycleKey });

RUN("GS-5b — a billing cycle's revenue from its period", () => {
  beforeEach(async () => {
    for (const id of ORGS) {
      await prisma.organization.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.organization.deleteMany({ where: { id: { in: ORGS } } });
    await prisma.$disconnect();
  });

  it("is the plan's monthly price for a period with no purchase", async () => {
    await period(ORG_A, "standard", "2027-05");
    await period(ORG_A, "premium", "2027-06");
    expect(await revenueOf(ORG_A, "2027-05")).toBe(49_800);
    expect(await revenueOf(ORG_A, "2027-06")).toBe(119_800);
  });

  it("adds the period's purchases of either quality and leaves out a cancelled one", async () => {
    const standard = await period(ORG_A, "standard", "2027-05");
    await bought(ORG_A, standard, 19_900);
    await bought(ORG_A, standard, 19_900, { cancelled: true });
    const premium = await period(ORG_A, "premium", "2027-06");
    await bought(ORG_A, premium, 35_900);
    await bought(ORG_A, premium, 9_000, { quality: "HIGH_QUALITY" });
    expect(await revenueOf(ORG_A, "2027-05")).toBe(49_800 + 19_900);
    expect(await revenueOf(ORG_A, "2027-06")).toBe(119_800 + 35_900 + 9_000);
  });

  it("counts a period whose only purchase was cancelled as the plan's price", async () => {
    const standard = await period(ORG_A, "standard", "2027-05");
    await bought(ORG_A, standard, 19_900, { cancelled: true });
    expect(await revenueOf(ORG_A, "2027-05")).toBe(49_800);
  });

  it("is unknown for an Enterprise period, with or without purchases", async () => {
    const enterprise = await period(ORG_A, "enterprise", "2027-05");
    expect(await revenueOf(ORG_A, "2027-05")).toBeNull();
    await bought(ORG_A, enterprise, 89_400);
    expect(await revenueOf(ORG_A, "2027-05")).toBeNull();
  });

  it("is unknown for a cycle the organization has no period for", async () => {
    await period(ORG_A, "standard", "2027-05");
    expect(await revenueOf(ORG_A, "2027-06")).toBeNull();
  });

  it("reads only the asking organization's period, never another's with the same key", async () => {
    const theirs = await period(ORG_B, "premium", "2027-05");
    await bought(ORG_B, theirs, 35_900);
    expect(await revenueOf(ORG_A, "2027-05")).toBeNull();
    const ours = await period(ORG_A, "standard", "2027-05");
    await bought(ORG_A, ours, 19_900);
    expect(await revenueOf(ORG_A, "2027-05")).toBe(49_800 + 19_900);
    expect(await revenueOf(ORG_B, "2027-05")).toBe(119_800 + 35_900);
  });
});
