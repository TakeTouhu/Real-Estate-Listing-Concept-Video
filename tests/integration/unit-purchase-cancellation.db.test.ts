import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUnitEntitlementRepository,
  createUnitPurchaseCancellationRepository,
  createUnitPurchaseInvoicingRepository,
  createUnitPurchaseRepository,
} from "@app/database";
import {
  ctx,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  repositories,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Cancelling a mistaken Unit purchase against PostgreSQL (UP-5, ADR-0070).
 *
 * The usage arithmetic is proved without a database in
 * `packages/domain/src/entitlement/unit-purchase-cancellation.test.ts` and the
 * withdrawn-block rule in `allocation.test.ts`. What only a database can prove
 * is here: that a reservation admitted after a cancellation cannot draw on the
 * block, that one admitted before keeps its funding and returns nothing when it
 * is released, that the cancellation is written once, with its audit entry and
 * under the period's lock, and that the purchase and its block are never
 * rewritten.
 *
 * The period sits in March 2027, after every other suite's, so none overlaps.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);
const ledger = HAS_DB
  ? createUnitEntitlementRepository(prisma)
  : (null as unknown as ReturnType<typeof createUnitEntitlementRepository>);
const cancellations = HAS_DB
  ? createUnitPurchaseCancellationRepository(prisma)
  : (null as unknown as ReturnType<typeof createUnitPurchaseCancellationRepository>);

const CYCLE = "2027-03";
const PERIOD_ID = "uep_cancel_itest_a";
const STARTS_AT = new Date("2027-03-01T00:00:00.000Z");
const ENDS_AT = new Date("2027-04-01T00:00:00.000Z");
const IN_PERIOD = new Date("2027-03-10T00:00:00.000Z");
const OPERATOR = { name: "Aoi Tanaka", reason: "Bought by mistake" };

let seq = 0;

async function cleanup(): Promise<void> {
  await prisma.unitPurchaseCancellation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.unitPurchase.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await wipeOrchestration(prisma);
  await prisma.unitAddOnBlock.deleteMany({ where: { id: { startsWith: "uab_cancel_itest_" } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { id: { startsWith: "uep_cancel_itest_" } } });
  await prisma.auditLog.deleteMany({ where: { action: "unit_purchase.cancelled" } });
}

/** A Standard period: 15 Base Units, spent here so only blocks fund what follows. */
async function openPeriod(): Promise<void> {
  const opened = await ledger.openPeriod({
    id: PERIOD_ID,
    organizationId: ORG_A,
    planKey: "standard",
    billingCycleKey: CYCLE,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    commercialReference: "sub_cancel_itest",
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
}

/** A purchase of a Normal package and the block it bought, `day` days into the period. */
async function bought(day: number): Promise<string> {
  seq += 1;
  const purchasedAt = new Date(STARTS_AT.getTime() + day * 86_400_000);
  const granted = await ledger.grantAddOnBlock({
    id: `uab_cancel_itest_${seq}`,
    organizationId: ORG_A,
    entitlementPeriodId: PERIOD_ID,
    quality: "NORMAL",
    quantity: 10,
    commercialReference: `unit-purchase:upur_cancel_itest_${seq}`,
    purchasedAt,
    actorUserId: "usr_billing",
  });
  if (granted.kind !== "GRANTED") throw new Error(`block: ${granted.kind}`);
  const purchase = await prisma.unitPurchase.create({
    data: {
      id: `upur_cancel_itest_${seq}`,
      organizationId: ORG_A,
      entitlementPeriodId: PERIOD_ID,
      addOnBlockId: granted.block.id,
      quality: "NORMAL",
      priceYenExTax: 19_900,
      channel: "SALES_ASSISTED",
      contractReference: "VT-CANCEL-1",
      idempotencyKey: `key-${seq}`,
      approvedByUserId: "usr_billing",
      approvedAt: purchasedAt,
    },
  });
  return purchase.id;
}

const blockOf = (purchaseId: string) =>
  prisma.unitPurchase.findUniqueOrThrow({ where: { id: purchaseId } }).then((purchase) => purchase.addOnBlockId);

/** Reserve a Normal job of `units` Units (30 seconds each) in the period. */
async function reserve(units: number) {
  seq += 1;
  const created = await repos.jobs.create(
    ORG_A,
    {
      id: `genjob_cancel_${seq}`,
      videoProjectId: PROJECT_A,
      requestedByUserId: "usr_itest",
      qualityTier: "NORMAL",
      requestedDurationSeconds: units * 30,
    },
    ctx(),
  );
  if (created.kind !== "CREATED") throw new Error(`job: ${created.kind}`);
  const moved = await repos.jobs.transition({
    organizationId: ORG_A,
    id: created.job.id,
    expectedState: "CREATED",
    expectedVersion: 0,
    nextState: "RESERVING",
    context: ctx(),
  });
  if (moved.kind !== "APPLIED") throw new Error("job did not reach RESERVING");
  return repos.reservations.reserve(
    ORG_A,
    {
      reservationId: `genres_${created.job.id}`,
      generationJobId: created.job.id,
      expectedJobVersion: moved.value.stateVersion,
      reservedAt: IN_PERIOD,
    },
    ctx(),
  );
}

async function reserved(units: number) {
  const outcome = await reserve(units);
  if (outcome.kind !== "RESERVED") throw new Error(`expected RESERVED, got ${outcome.kind}`);
  return outcome.reservation;
}

async function spendBase(): Promise<void> {
  for (let left = 15; left > 0; left -= 3) await reserved(3);
}

async function fundingOf(reservationId: string) {
  return (await ledger.allocationsForReservation(ORG_A, reservationId)).map((a) => [a.addOnBlockId, a.quantity]);
}

async function blocks() {
  const balance = await ledger.balance(ORG_A, PERIOD_ID);
  if (balance === null) throw new Error("no balance");
  return balance.blocks.map((block) => [block.id, block.remainingUnits, block.withdrawn]);
}

const audits = () => prisma.auditLog.findMany({ where: { action: "unit_purchase.cancelled" } });

RUN("UP-5 — cancelling a mistaken Unit purchase", () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenants(prisma);
    await openPeriod();
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await cleanup();
    await prisma.$disconnect();
  });

  describe("withdrawing the unused Units", () => {
    it("lets no reservation admitted afterwards draw on the block, so the next eligible one funds it", async () => {
      await spendBase();
      const mistaken = await bought(1);
      const next = await bought(2);
      expect((await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR })).kind).toBe("CANCELLED");

      const after = await reserved(3);
      expect(await fundingOf(after.id)).toEqual([[await blockOf(next), 3]]);
      expect(await blocks()).toEqual([
        [await blockOf(mistaken), 0, true],
        [await blockOf(next), 7, false],
      ]);
    });

    it("refuses a reservation the withdrawn block alone could have funded, writing nothing", async () => {
      await spendBase();
      const mistaken = await bought(1);
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      const before = await prisma.generationReservation.count();

      expect(await reserve(1)).toMatchObject({ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 0 });
      expect(await prisma.generationReservation.count()).toBe(before);
    });

    it("leaves a generation admitted before it funded as it was, and returns nothing it releases", async () => {
      await spendBase();
      const mistaken = await bought(1);
      const running = await reserved(2);
      const funding = await fundingOf(running.id);
      expect(funding).toEqual([[await blockOf(mistaken), 2]]);

      const cancelled = await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      expect(cancelled).toMatchObject({ kind: "CANCELLED", purchase: { usage: { consumed: 0, inFlight: 2, unused: 8 } } });
      expect(await fundingOf(running.id)).toEqual(funding);

      const released = await repos.reservations.transition({
        organizationId: ORG_A,
        id: running.id,
        expectedState: "RESERVED",
        expectedVersion: running.stateVersion,
        nextState: "RELEASED",
        context: ctx(),
      });
      expect(released.kind).toBe("APPLIED");
      expect(await blocks()).toEqual([[await blockOf(mistaken), 0, true]]);
      expect(await reserve(1)).toMatchObject({ kind: "INSUFFICIENT_ENTITLEMENT" });
    });

    it("counts a generation released before the cancellation as having used nothing", async () => {
      await spendBase();
      const mistaken = await bought(1);
      const failed = await reserved(2);
      const released = await repos.reservations.transition({
        organizationId: ORG_A,
        id: failed.id,
        expectedState: "RESERVED",
        expectedVersion: failed.stateVersion,
        nextState: "RELEASED",
        context: ctx(),
      });
      expect(released.kind).toBe("APPLIED");
      expect(await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR })).toMatchObject({
        kind: "CANCELLED",
        purchase: { usage: { consumed: 0, inFlight: 0, unused: 10 } },
      });
    });

    it("withdraws nothing from another purchase, or from Base Units", async () => {
      const mistaken = await bought(1);
      const kept = await bought(2);
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      const balance = await ledger.balance(ORG_A, PERIOD_ID);
      expect(balance?.baseRemainingUnits).toBe(15);
      expect(await blocks()).toEqual([
        [await blockOf(mistaken), 0, true],
        [await blockOf(kept), 10, false],
      ]);
    });
  });

  describe("the cancellation record", () => {
    it("writes the cancellation and its audit entry, and never changes the purchase or its block", async () => {
      const mistaken = await bought(1);
      await spendBase();
      await reserved(1);
      const purchaseBefore = await prisma.unitPurchase.findUniqueOrThrow({ where: { id: mistaken } });
      const blockBefore = await prisma.unitAddOnBlock.findUniqueOrThrow({ where: { id: purchaseBefore.addOnBlockId } });
      const [{ now: startedBefore }] = await prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;

      const outcome = await cancellations.cancel({
        purchaseId: mistaken,
        operator: { name: "  Aoi Tanaka ", reason: " Bought by mistake  " },
      });

      const row = await prisma.unitPurchaseCancellation.findUniqueOrThrow({ where: { purchaseId: mistaken } });
      expect(row).toMatchObject({ organizationId: ORG_A, operatorName: "Aoi Tanaka", reason: "Bought by mistake" });
      expect(row.cancelledAt.getTime()).toBeGreaterThanOrEqual(startedBefore.getTime());
      expect(outcome).toEqual({
        kind: "CANCELLED",
        purchase: {
          purchaseId: mistaken,
          organizationId: ORG_A,
          organizationName: ORG_A,
          quality: "NORMAL",
          units: 10,
          priceYenExTax: 19_900,
          invoicePaid: true,
          contractReference: "VT-CANCEL-1",
          approvedAt: purchaseBefore.approvedAt,
          expiresAt: ENDS_AT,
          usage: { consumed: 0, inFlight: 1, unused: 9 },
          cancellation: { operatorName: "Aoi Tanaka", reason: "Bought by mistake", cancelledAt: row.cancelledAt },
        },
      });
      expect(
        (await audits()).map(({ organizationId, actorUserId, resourceType, resourceId, metadata }) => ({
          organizationId,
          actorUserId,
          resourceType,
          resourceId,
          metadata,
        })),
      ).toEqual([
        {
          organizationId: ORG_A,
          actorUserId: null,
          resourceType: "unit_purchase",
          resourceId: mistaken,
          metadata: {
            operator: "Aoi Tanaka",
            reason: "Bought by mistake",
            quality: "NORMAL",
            units: 10,
            priceYenExTax: 19_900,
            contractReference: "VT-CANCEL-1",
            approvedAt: purchaseBefore.approvedAt.toISOString(),
            unitsConsumed: 0,
            unitsInFlight: 1,
            unitsWithdrawn: 9,
          },
        },
      ]);
      expect(await prisma.unitPurchase.findUniqueOrThrow({ where: { id: mistaken } })).toEqual(purchaseBefore);
      expect(await prisma.unitAddOnBlock.findUniqueOrThrow({ where: { id: blockBefore.id } })).toEqual(blockBefore);
    });

    it("cancels once: a second cancellation finds the first and writes nothing", async () => {
      const mistaken = await bought(1);
      const first = await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      const second = await cancellations.cancel({ purchaseId: mistaken, operator: { name: "Someone else", reason: "Again" } });
      expect(second).toEqual({ ...first, kind: "ALREADY_CANCELLED" });
      expect(await prisma.unitPurchaseCancellation.count()).toBe(1);
      expect(await audits()).toHaveLength(1);
    });

    it("writes one of two cancellations sent at once", async () => {
      const mistaken = await bought(1);
      const outcomes = await Promise.all([
        cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR }),
        cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR }),
      ]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["ALREADY_CANCELLED", "CANCELLED"]);
      expect(await audits()).toHaveLength(1);
    });

    it("waits for a transaction holding the period's cost-admission lock", async () => {
      const mistaken = await bought(1);
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      let holding = () => {};
      const held = new Promise<void>((resolve) => {
        holding = () => resolve();
      });
      // The key formula the reservation path derives, written out on purpose:
      // if it ever changes, this barrier stops blocking and the test fails.
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(hashtext(${`paid-submission:${ORG_A}`}), hashtext(${`cycle:${CYCLE}`}))::text
          `;
          holding();
          await released;
        },
        { timeout: 30_000 },
      );
      await held;

      let finished = false;
      const cancelling = cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR }).finally(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      release();
      await holder;
      expect((await cancelling).kind).toBe("CANCELLED");
    });

    it("refuses a purchase that does not exist, writing nothing", async () => {
      expect(await cancellations.cancel({ purchaseId: "upur_nowhere", operator: OPERATOR })).toEqual({
        kind: "NOT_FOUND",
      });
      expect(await cancellations.find("upur_nowhere")).toBeNull();
      expect(await audits()).toEqual([]);
    });

    it("refuses a card-paid purchase, writing nothing", async () => {
      const card = await bought(1);
      await prisma.unitPurchase.update({ where: { id: card }, data: { channel: "SELF_SERVICE" } });
      expect(await cancellations.cancel({ purchaseId: card, operator: OPERATOR })).toMatchObject({
        kind: "CARD_PAID",
        purchase: { purchaseId: card, invoicePaid: false, cancellation: null },
      });
      expect(await prisma.unitPurchaseCancellation.count()).toBe(0);
      expect(await audits()).toEqual([]);
    });

    it("shows the purchase as a cancellation would find it, before and after", async () => {
      const mistaken = await bought(1);
      expect(await cancellations.find(mistaken)).toMatchObject({
        quality: "NORMAL",
        units: 10,
        priceYenExTax: 19_900,
        expiresAt: ENDS_AT,
        usage: { consumed: 0, inFlight: 0, unused: 10 },
        cancellation: null,
      });
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      expect(await cancellations.find(mistaken)).toMatchObject({
        cancellation: { operatorName: "Aoi Tanaka", reason: "Bought by mistake" },
      });
      expect(await audits()).toHaveLength(1);
    });
  });

  describe("what the table itself refuses", () => {
    it("refuses a cancellation outside its purchase's organization", async () => {
      const mistaken = await bought(1);
      await expect(
        prisma.unitPurchaseCancellation.create({
          data: { purchaseId: mistaken, organizationId: ORG_B, operatorName: "x", reason: "x" },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["an empty operator", { operatorName: "", reason: "x" }],
      ["an empty reason", { operatorName: "x", reason: "" }],
      ["an operator longer than 200 characters", { operatorName: "x".repeat(201), reason: "x" }],
      ["a reason longer than 500 characters", { operatorName: "x", reason: "x".repeat(501) }],
    ])("refuses %s", async (_, fields) => {
      const mistaken = await bought(1);
      await expect(
        prisma.unitPurchaseCancellation.create({ data: { purchaseId: mistaken, organizationId: ORG_A, ...fields } }),
      ).rejects.toThrow(/unit_purchase_cancellations_shape_check/);
    });

    it("refuses deleting a cancelled purchase", async () => {
      const mistaken = await bought(1);
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      await expect(prisma.unitPurchase.delete({ where: { id: mistaken } })).rejects.toThrow();
    });
  });

  describe("invoicing and the Units page", () => {
    it("lists a cancelled purchase as cancelled and invoices nothing for it", async () => {
      const mistaken = await bought(1);
      const kept = await bought(2);
      const window = { from: new Date("2026-04-01T00:00:00.000Z"), to: new Date("2026-05-01T00:00:00.000Z") };
      // Approved long enough ago for the window to have settled (ADR-0069 Decision 6).
      for (const [id, at] of [
        [mistaken, "2026-04-10T00:00:00.000Z"],
        [kept, "2026-04-11T00:00:00.000Z"],
      ] as const) {
        await prisma.unitPurchase.update({ where: { id }, data: { approvedAt: new Date(at) } });
      }
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      const cancelledAt = (await prisma.unitPurchaseCancellation.findUniqueOrThrow({ where: { purchaseId: mistaken } }))
        .cancelledAt;

      const exported = await createUnitPurchaseInvoicingRepository(prisma).exportForInvoicing({
        ...window,
        operator: { name: "Aoi Tanaka", reason: "April invoices" },
      });
      expect(exported).toMatchObject({
        kind: "EXPORTED",
        purchases: [
          { purchaseId: mistaken, priceYenExTax: 19_900, cancelledAt },
          { purchaseId: kept, priceYenExTax: 19_900, cancelledAt: null },
        ],
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG_A, action: "unit_purchase.exported" },
      });
      expect(audit.metadata).toMatchObject({ purchases: 2, priceYenExTax: 39_800, cancelled: 1, toInvoiceYenExTax: 19_900 });
      await prisma.auditLog.deleteMany({ where: { action: "unit_purchase.exported", organizationId: ORG_A } });
    });

    it("lists a cancelled purchase with when it was cancelled", async () => {
      const mistaken = await bought(1);
      const kept = await bought(2);
      await cancellations.cancel({ purchaseId: mistaken, operator: OPERATOR });
      const listed = await createUnitPurchaseRepository(prisma).listForPeriod(ORG_A, PERIOD_ID);
      expect(listed.map((purchase) => [purchase.id, purchase.cancelledAt instanceof Date])).toEqual([
        [mistaken, true],
        [kept, false],
      ]);
    });
  });
});
