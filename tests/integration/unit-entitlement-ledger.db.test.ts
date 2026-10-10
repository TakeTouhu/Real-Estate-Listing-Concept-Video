import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDeliverableValidationRepository,
  createUnitEntitlementRepository,
} from "@app/database";
import {
  ISO_BMFF_CONTAINER,
  type CustomerPlanKey,
  type GenerationQualityTier,
  type ManagedOutputMediaFacts,
} from "@app/domain";
import { seedComposedDeliverable, seedRecomposedDeliverable } from "./deliverable-validation-fixture";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  repositories,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The Unit entitlement ledger against live PostgreSQL (Phase 6A).
 *
 * The ordering rules are proved without a database in
 * `packages/domain/src/entitlement/allocation.test.ts`. What only a database can
 * prove is here: that funding is frozen in the reserving commit and nowhere else,
 * that a short entitlement writes nothing, that concurrent reservations cannot
 * spend one Unit twice, that settlement moves every allocation once, and that no
 * tenant can draw on another's entitlement.
 *
 * Every period here sits after the shared fixture's September period, so the two
 * never overlap, and each is sized to the approved plan — no oversized blocks.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);
const ledger = HAS_DB
  ? createUnitEntitlementRepository(prisma)
  : (null as unknown as ReturnType<typeof createUnitEntitlementRepository>);

const NOVEMBER = { startsAt: new Date("2026-11-01T00:00:00.000Z"), endsAt: new Date("2026-12-01T00:00:00.000Z") };
const DECEMBER = { startsAt: new Date("2026-12-01T00:00:00.000Z"), endsAt: new Date("2027-01-01T00:00:00.000Z") };
const IN_NOVEMBER = new Date("2026-11-10T00:00:00.000Z");
const IN_DECEMBER = new Date("2026-12-10T00:00:00.000Z");

let seq = 0;

async function openPeriod(
  planKey: CustomerPlanKey,
  window: { startsAt: Date; endsAt: Date } = NOVEMBER,
  organizationId: string = ORG_A,
) {
  const key = window.startsAt.toISOString().slice(0, 7);
  const opened = await ledger.openPeriod({
    id: `uep_itest_${organizationId}_${key}`,
    organizationId,
    planKey,
    billingCycleKey: key,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    commercialReference: `sub_period_${key}`,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
  return opened.period;
}

async function grant(
  periodId: string,
  quality: GenerationQualityTier,
  quantity: number,
  purchasedAt: Date,
  organizationId: string = ORG_A,
) {
  seq += 1;
  const granted = await ledger.grantAddOnBlock({
    id: `uab_itest_${seq}`,
    organizationId,
    entitlementPeriodId: periodId,
    quality,
    quantity,
    commercialReference: `order_${seq}`,
    purchasedAt,
    actorUserId: "usr_billing",
  });
  if (granted.kind !== "GRANTED") throw new Error(`block: ${granted.kind}`);
  return granted.block;
}

/** A job in RESERVING, ready for Transaction B. Seconds decide its Units: 30 → 1, 60 → 2, 90 → 3. */
async function reservingJob(
  quality: GenerationQualityTier,
  seconds: number,
  organizationId: string = ORG_A,
) {
  seq += 1;
  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_ledger_${seq}`,
      videoProjectId: organizationId === ORG_A ? PROJECT_A : PROJECT_B,
      requestedByUserId: "usr_itest",
      qualityTier: quality,
      requestedDurationSeconds: seconds,
    },
    ctx(),
  );
  if (created.kind !== "CREATED") throw new Error(`job: ${created.kind}`);
  const moved = await repos.jobs.transition({
    organizationId,
    id: created.job.id,
    expectedState: "CREATED",
    expectedVersion: 0,
    nextState: "RESERVING",
    context: ctx(),
  });
  if (moved.kind !== "APPLIED") throw new Error("job did not reach RESERVING");
  return moved.value;
}

async function reserve(
  job: { id: string; stateVersion: number },
  at: Date = IN_NOVEMBER,
  organizationId: string = ORG_A,
  reservationId: string = `genres_${job.id}`,
) {
  return repos.reservations.reserve(
    organizationId,
    { reservationId, generationJobId: job.id, expectedJobVersion: job.stateVersion, reservedAt: at },
    ctx(),
  );
}

async function reserveNew(
  quality: GenerationQualityTier,
  seconds: number,
  at: Date = IN_NOVEMBER,
  organizationId: string = ORG_A,
) {
  const outcome = await reserve(await reservingJob(quality, seconds, organizationId), at, organizationId);
  if (outcome.kind !== "RESERVED") throw new Error(`expected RESERVED, got ${outcome.kind}`);
  return outcome;
}

/** Spend `units` Normal Base Units through real reservations, 3 at a time. */
async function spendNormalBase(units: number, at: Date = IN_NOVEMBER) {
  for (let left = units; left > 0; left -= 3) {
    await reserveNew("NORMAL", Math.min(left, 3) * 30, at);
  }
}

/** Spend `units` HQ Base Units, 2 at a time — 60-second HQ jobs. */
async function spendHighQualityBase(units: number, at: Date = IN_NOVEMBER) {
  for (let left = units; left > 0; left -= 2) {
    await reserveNew("HIGH_QUALITY", Math.min(left, 2) * 30, at);
  }
}

function shape(allocations: readonly { sourceType: string; addOnBlockId: string | null; quality: string; quantity: number }[]) {
  return allocations.map((a) => [a.sourceType, a.addOnBlockId, a.quality, a.quantity]);
}

async function balance(periodId: string, organizationId: string = ORG_A) {
  const found = await ledger.balance(organizationId, periodId);
  if (found === null) throw new Error("no balance");
  return found;
}

async function ledgerRowCounts() {
  return {
    reservations: await prisma.generationReservation.count(),
    allocations: await prisma.generationReservationAllocation.count(),
    reservationEvents: await prisma.generationTransitionEvent.count({
      where: { aggregateType: "RESERVATION" },
    }),
  };
}

async function wipeLedgerPeriods() {
  // The shared fixture's periods and blocks stay; this suite's are rebuilt per test.
  await prisma.unitAddOnBlock.deleteMany({ where: { id: { startsWith: "uab_itest_" } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { id: { startsWith: "uep_itest_" } } });
}

RUN("Phase 6A — the Unit entitlement ledger", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await wipeLedgerPeriods();
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    // The Transaction G suite below shares this client; it disconnects.
    await wipeOrchestration(prisma);
    await wipeLedgerPeriods();
  });

  describe("opening a period", () => {
    it.each([
      ["standard", 15, 1, false],
      ["premium", 40, 5, true],
      ["enterprise", 100, 10, true],
    ] as const)("%s freezes %i Base Units and an HQ ceiling of %i", async (plan, base, hq, hqAddOn) => {
      const period = await openPeriod(plan);
      expect([period.baseUnits, period.includedHighQualityUnits, period.highQualityAddOnAvailable]).toEqual([
        base,
        hq,
        hqAddOn,
      ]);
      expect(await balance(period.id)).toEqual({
        baseRemainingUnits: base,
        includedHighQualityRemainingUnits: hq,
        blocks: [],
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { resourceId: period.id, action: "entitlement.period_opened" },
      });
      expect(audit.organizationId).toBe(ORG_A);
    });

    it("replays the same period and refuses a conflicting or overlapping one", async () => {
      const period = await openPeriod("premium");
      const input = {
        id: period.id,
        organizationId: ORG_A,
        planKey: "premium" as const,
        billingCycleKey: period.billingCycleKey,
        startsAt: NOVEMBER.startsAt,
        endsAt: NOVEMBER.endsAt,
        commercialReference: period.commercialReference,
        actorUserId: null,
      };
      expect((await ledger.openPeriod(input)).kind).toBe("ALREADY_OPEN");
      expect((await ledger.openPeriod({ ...input, planKey: "standard" })).kind).toBe("CONFLICT");
      expect(
        (
          await ledger.openPeriod({
            ...input,
            id: "uep_itest_overlap",
            billingCycleKey: "overlap",
            startsAt: new Date("2026-11-20T00:00:00.000Z"),
            endsAt: new Date("2026-12-20T00:00:00.000Z"),
          })
        ).kind,
      ).toBe("OVERLAPS_EXISTING_PERIOD");
      expect(
        (await ledger.openPeriod({ ...input, id: "uep_itest_bad", billingCycleKey: "bad", endsAt: NOVEMBER.startsAt }))
          .kind,
      ).toBe("INVALID_PERIOD");
      expect(await prisma.unitEntitlementPeriod.count({ where: { organizationId: ORG_A } })).toBe(2);
    });
  });

  describe("granting quality-tagged blocks", () => {
    it("refuses an HQ block on Standard, which sells none", async () => {
      const period = await openPeriod("standard");
      const refused = await ledger.grantAddOnBlock({
        id: "uab_itest_hq_std",
        organizationId: ORG_A,
        entitlementPeriodId: period.id,
        quality: "HIGH_QUALITY",
        quantity: 2,
        commercialReference: "order_hq_std",
        purchasedAt: IN_NOVEMBER,
        actorUserId: null,
      });
      expect(refused.kind).toBe("HIGH_QUALITY_ADD_ON_NOT_AVAILABLE");
      expect(await prisma.unitAddOnBlock.count({ where: { id: "uab_itest_hq_std" } })).toBe(0);
    });

    it("credits a replayed purchase once and refuses a conflicting one", async () => {
      const period = await openPeriod("premium");
      const input = {
        id: "uab_itest_replay",
        organizationId: ORG_A,
        entitlementPeriodId: period.id,
        quality: "NORMAL" as const,
        quantity: 10,
        commercialReference: "order_replay",
        purchasedAt: IN_NOVEMBER,
        actorUserId: "usr_billing",
      };
      expect((await ledger.grantAddOnBlock(input)).kind).toBe("GRANTED");
      expect((await ledger.grantAddOnBlock(input)).kind).toBe("ALREADY_GRANTED");
      expect((await ledger.grantAddOnBlock({ ...input, quantity: 25 })).kind).toBe("CONFLICT");
      expect((await balance(period.id)).blocks.map((b) => b.remainingUnits)).toEqual([10]);
      expect(
        await prisma.auditLog.count({ where: { action: "entitlement.add_on_block_granted", resourceId: input.id } }),
      ).toBe(1);
    });
  });

  describe("eligibility-first funding, frozen at reservation", () => {
    it("funds 3 Normal Units on Premium as Base 2 + Normal add-on 1", async () => {
      const period = await openPeriod("premium");
      const block = await grant(period.id, "NORMAL", 10, IN_NOVEMBER);
      await spendNormalBase(38);
      expect((await balance(period.id)).baseRemainingUnits).toBe(2);

      const reserved = await reserveNew("NORMAL", 90);
      // Partial Base capacity is used, never skipped for the block that could cover it all.
      expect(shape(reserved.allocations)).toEqual([
        ["BASE", null, "NORMAL", 2],
        ["ADD_ON_BLOCK", block.id, "NORMAL", 1],
      ]);
      expect(reserved.allocations.map((a) => a.ordinal)).toEqual([1, 2]);
      expect(reserved.reservation.funding).toBe("ALLOCATED");
      // The instant that selected the period is the one the row records.
      expect(reserved.reservation.reservedAt).toEqual(IN_NOVEMBER);
      expect(reserved.reservation.entitlementPeriodId).toBe(period.id);
      expect(reserved.reservation.billingCycleKey).toBe(period.billingCycleKey);
      const after = await balance(period.id);
      expect(after.baseRemainingUnits).toBe(0);
      expect(after.blocks.map((b) => b.remainingUnits)).toEqual([9]);

      // The append-only history indexes the frozen rows: period, cycle and split.
      const events = await repos.events.listForAggregate(ORG_A, "RESERVATION", reserved.reservation.id);
      expect(events.map((e) => e.toState)).toEqual(["RESERVING", "RESERVED"]);
      expect(events[1]?.safeMetadata).toMatchObject({
        entitlementPeriodId: period.id,
        billingCycleKey: period.billingCycleKey,
        qualityTier: "NORMAL",
        totalVideoUnits: 3,
        baseAllocatedUnits: 2,
        addOnAllocatedUnits: 1,
        allocationCount: 2,
      });
    });

    it("spans several Normal blocks oldest first once Base is exhausted", async () => {
      const period = await openPeriod("standard");
      const newest = await grant(period.id, "NORMAL", 5, new Date("2026-11-03T00:00:00.000Z"));
      const oldest = await grant(period.id, "NORMAL", 1, new Date("2026-11-01T00:00:00.000Z"));
      const middle = await grant(period.id, "NORMAL", 1, new Date("2026-11-02T00:00:00.000Z"));
      await spendNormalBase(15);

      const reserved = await reserveNew("NORMAL", 90);
      expect(shape(reserved.allocations)).toEqual([
        ["ADD_ON_BLOCK", oldest.id, "NORMAL", 1],
        ["ADD_ON_BLOCK", middle.id, "NORMAL", 1],
        ["ADD_ON_BLOCK", newest.id, "NORMAL", 1],
      ]);
    });

    it("funds HQ from the remaining included HQ Base, then an HQ block", async () => {
      const period = await openPeriod("premium");
      const hqBlock = await grant(period.id, "HIGH_QUALITY", 2, IN_NOVEMBER);
      await spendHighQualityBase(4);
      expect((await balance(period.id)).includedHighQualityRemainingUnits).toBe(1);

      const reserved = await reserveNew("HIGH_QUALITY", 60);
      expect(shape(reserved.allocations)).toEqual([
        ["BASE", null, "HIGH_QUALITY", 1],
        ["ADD_ON_BLOCK", hqBlock.id, "HIGH_QUALITY", 1],
      ]);
      const after = await balance(period.id);
      expect(after.includedHighQualityRemainingUnits).toBe(0);
      // HQ Base draws count against the pool too; 35 Base Units remain for Normal work.
      expect(after.baseRemainingUnits).toBe(35);
      expect(shape((await reserveNew("NORMAL", 90)).allocations)).toEqual([["BASE", null, "NORMAL", 3]]);
    });

    it("spans several HQ blocks oldest first once the ceiling is spent", async () => {
      const period = await openPeriod("enterprise");
      const second = await grant(period.id, "HIGH_QUALITY", 5, new Date("2026-11-05T00:00:00.000Z"));
      const first = await grant(period.id, "HIGH_QUALITY", 1, new Date("2026-11-02T00:00:00.000Z"));
      await spendHighQualityBase(10);

      const reserved = await reserveNew("HIGH_QUALITY", 90);
      expect(shape(reserved.allocations)).toEqual([
        ["ADD_ON_BLOCK", first.id, "HIGH_QUALITY", 1],
        ["ADD_ON_BLOCK", second.id, "HIGH_QUALITY", 2],
      ]);
    });

    it("skips an older block of the other quality", async () => {
      const period = await openPeriod("premium");
      await grant(period.id, "NORMAL", 10, new Date("2026-11-01T00:00:00.000Z"));
      const hqBlock = await grant(period.id, "HIGH_QUALITY", 2, new Date("2026-11-02T00:00:00.000Z"));
      await spendHighQualityBase(5);

      const reserved = await reserveNew("HIGH_QUALITY", 60);
      expect(shape(reserved.allocations)).toEqual([["ADD_ON_BLOCK", hqBlock.id, "HIGH_QUALITY", 2]]);
    });

    it("refuses a 2-Unit Standard HQ job, with no Normal fallback", async () => {
      const period = await openPeriod("standard");
      await grant(period.id, "NORMAL", 5, IN_NOVEMBER);
      const job = await reservingJob("HIGH_QUALITY", 60);
      const before = await ledgerRowCounts();

      expect(await reserve(job)).toEqual({ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 1 });
      expect(await ledgerRowCounts()).toEqual(before);
      const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      expect([row.state, row.stateVersion]).toEqual(["RESERVING", job.stateVersion]);
    });
  });

  describe("all or nothing", () => {
    it("writes nothing at all when the eligible total is short", async () => {
      const period = await openPeriod("standard");
      await grant(period.id, "NORMAL", 1, IN_NOVEMBER);
      await spendNormalBase(14);
      const job = await reservingJob("NORMAL", 90);
      const before = await ledgerRowCounts();
      const balanceBefore = await balance(period.id);

      // 1 Base + 1 block = 2 eligible; 3 required.
      expect(await reserve(job)).toEqual({ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 2 });
      expect(await ledgerRowCounts()).toEqual(before);
      expect(await balance(period.id)).toEqual(balanceBefore);
      expect(await prisma.generationReservation.findUnique({ where: { generationJobId: job.id } })).toBeNull();
      const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      expect([row.state, row.stateVersion]).toEqual(["RESERVING", job.stateVersion]);
    });

    it("writes nothing when no period covers the reservation instant", async () => {
      await openPeriod("premium");
      const job = await reservingJob("NORMAL", 30);
      const before = await ledgerRowCounts();
      expect(await reserve(job, new Date("2027-03-01T00:00:00.000Z"))).toEqual({ kind: "NO_ENTITLEMENT_PERIOD" });
      expect(await ledgerRowCounts()).toEqual(before);
    });
  });

  describe("idempotency and concurrency", () => {
    it("creates no second allocation set for a duplicate reservation", async () => {
      await openPeriod("premium");
      const job = await reservingJob("NORMAL", 90);
      const first = await reserve(job);
      expect(first.kind).toBe("RESERVED");
      const before = await ledgerRowCounts();
      expect((await reserve(job, IN_NOVEMBER, ORG_A, "genres_dup_second")).kind).toBe("ALREADY_RESERVED");
      expect(await ledgerRowCounts()).toEqual(before);
    });

    it("answers a replay as ALREADY_RESERVED even when no period covers its instant", async () => {
      await openPeriod("premium");
      const job = await reservingJob("NORMAL", 30);
      expect((await reserve(job)).kind).toBe("RESERVED");
      const before = await ledgerRowCounts();
      const late = await reserve(job, new Date("2027-03-01T00:00:00.000Z"), ORG_A, "genres_late_replay");
      expect(late.kind).toBe("ALREADY_RESERVED");
      expect(await ledgerRowCounts()).toEqual(before);
    });

    it("lets exactly one of two concurrent reservations of one job win", async () => {
      await openPeriod("premium");
      const job = await reservingJob("NORMAL", 90);
      const outcomes = await Promise.all([
        reserve(job, IN_NOVEMBER, ORG_A, "genres_race_1"),
        reserve(job, IN_NOVEMBER, ORG_A, "genres_race_2"),
      ]);
      // The loser is told it was a duplicate — by the re-check under the lock if it
      // got past the first one — never LOST, and never a constraint error.
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["ALREADY_RESERVED", "RESERVED"]);
      expect(await prisma.generationReservationAllocation.count({ where: { reservation: { generationJobId: job.id } } })).toBe(1);
    });

    it("serializes two attempts on one job whose instants select different periods", async () => {
      await openPeriod("premium");
      await openPeriod("premium", DECEMBER);
      const job = await reservingJob("NORMAL", 30);
      const outcomes = await Promise.all([
        reserve(job, IN_NOVEMBER, ORG_A, "genres_cross_1"),
        reserve(job, IN_DECEMBER, ORG_A, "genres_cross_2"),
      ]);
      // Different cost-admission locks, one job: the second still waits for the
      // first and is answered as a replay, never LOST.
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["ALREADY_RESERVED", "RESERVED"]);
      expect(
        await prisma.generationReservationAllocation.count({ where: { reservation: { generationJobId: job.id } } }),
      ).toBe(1);
    });

    it("reads a balance from one snapshot even when a grant and a reservation commit mid-read", async () => {
      const period = await openPeriod("standard");
      await spendNormalBase(15);
      // Commit a new block and a reservation against it from another connection,
      // exactly between the balance read's block query and its allocation query.
      // Read under READ COMMITTED, the second query would see an allocation for a
      // block the first never returned, and a consistent ledger would throw.
      let injected = false;
      const intercepted = prisma.$extends({
        query: {
          generationReservationAllocation: {
            async findMany({ args, query }) {
              if (!injected) {
                injected = true;
                await grant(period.id, "NORMAL", 5, IN_NOVEMBER);
                await reserveNew("NORMAL", 30);
              }
              return query(args);
            },
          },
        },
      });
      const torn = createUnitEntitlementRepository(intercepted as unknown as PrismaClient);

      const read = await torn.balance(ORG_A, period.id);
      expect(injected).toBe(true);
      // The snapshot from before the injection: no block yet, Base spent.
      expect(read).toEqual({ baseRemainingUnits: 0, includedHighQualityRemainingUnits: 1, blocks: [] });
      expect((await balance(period.id)).blocks.map((b) => b.remainingUnits)).toEqual([4]);
    });

    it("cannot overspend under concurrent reservations of different jobs", async () => {
      const period = await openPeriod("standard");
      await spendNormalBase(13);
      const jobs = await Promise.all([1, 2, 3, 4, 5].map(() => reservingJob("NORMAL", 30)));

      const outcomes = await Promise.all(jobs.map((job) => reserve(job)));
      expect(outcomes.filter((o) => o.kind === "RESERVED")).toHaveLength(2);
      expect(outcomes.filter((o) => o.kind === "INSUFFICIENT_ENTITLEMENT")).toHaveLength(3);
      expect((await balance(period.id)).baseRemainingUnits).toBe(0);
      const baseHeld = await prisma.generationReservationAllocation.aggregate({
        where: { entitlementPeriodId: period.id, sourceType: "BASE" },
        _sum: { quantity: true },
      });
      expect(baseHeld._sum.quantity).toBe(15);
    });
  });

  describe("settlement uses the frozen allocations, exactly once", () => {
    it("releases every allocation once, and a replayed release changes nothing", async () => {
      const period = await openPeriod("premium");
      const block = await grant(period.id, "NORMAL", 10, IN_NOVEMBER);
      await spendNormalBase(38);
      const reserved = await reserveNew("NORMAL", 90);
      const frozen = await ledger.allocationsForReservation(ORG_A, reserved.reservation.id);

      const released = await repos.reservations.transition({
        organizationId: ORG_A,
        id: reserved.reservation.id,
        expectedState: "RESERVED",
        expectedVersion: reserved.reservation.stateVersion,
        nextState: "RELEASED",
        context: ctx(),
      });
      expect(released.kind).toBe("APPLIED");
      const afterRelease = await balance(period.id);
      expect(afterRelease.baseRemainingUnits).toBe(2);
      expect(afterRelease.blocks.find((b) => b.id === block.id)?.remainingUnits).toBe(10);

      const replay = await repos.reservations.transition({
        organizationId: ORG_A,
        id: reserved.reservation.id,
        expectedState: "RESERVED",
        expectedVersion: reserved.reservation.stateVersion,
        nextState: "RELEASED",
        context: ctx(),
      });
      expect(replay.kind).toBe("LOST");
      expect(await balance(period.id)).toEqual(afterRelease);
      // Nothing was reselected or rewritten: the frozen set is exactly what it was.
      expect(await ledger.allocationsForReservation(ORG_A, reserved.reservation.id)).toEqual(frozen);
    });

    it("does not rebind a reservation when the next period opens", async () => {
      const november = await openPeriod("standard");
      const reserved = await reserveNew("NORMAL", 60);
      const december = await openPeriod("standard", DECEMBER);

      // A hold that crosses the boundary keeps its period, its cycle and its funding.
      let version = reserved.reservation.stateVersion;
      for (const [from, to] of [
        ["RESERVED", "RECONCILIATION_HOLD"],
        ["RECONCILIATION_HOLD", "RESERVED"],
      ] as const) {
        const step = await repos.reservations.transition({
          organizationId: ORG_A,
          id: reserved.reservation.id,
          expectedState: from,
          expectedVersion: version,
          nextState: to,
          context: ctx(),
        });
        if (step.kind !== "APPLIED") throw new Error("expected APPLIED");
        version = step.value.stateVersion;
        expect([step.value.entitlementPeriodId, step.value.billingCycleKey]).toEqual([november.id, "2026-11"]);
      }
      expect(await ledger.allocationsForReservation(ORG_A, reserved.reservation.id)).toEqual(reserved.allocations);
      expect((await balance(december.id)).baseRemainingUnits).toBe(15);

      // Releasing it in December returns its Units to November, never to December.
      await repos.reservations.transition({
        organizationId: ORG_A,
        id: reserved.reservation.id,
        expectedState: "RESERVED",
        expectedVersion: version,
        nextState: "RELEASED",
        context: ctx(),
      });
      expect((await balance(november.id)).baseRemainingUnits).toBe(15);
      expect((await balance(december.id)).baseRemainingUnits).toBe(15);
    });

    it("assigns an instant on the boundary to the period that starts there", async () => {
      const november = await openPeriod("standard");
      const december = await openPeriod("standard", DECEMBER);
      // Periods are [startsAt, endsAt): November's end is December's start.
      const reserved = await reserveNew("NORMAL", 30, NOVEMBER.endsAt);
      expect(reserved.reservation.entitlementPeriodId).toBe(december.id);
      expect((await balance(november.id)).baseRemainingUnits).toBe(15);
      expect((await balance(december.id)).baseRemainingUnits).toBe(14);
    });

    it("carries nothing over: a new period draws only on its own Base and blocks", async () => {
      const november = await openPeriod("standard");
      await grant(november.id, "NORMAL", 5, IN_NOVEMBER);
      await openPeriod("standard", DECEMBER);
      await spendNormalBase(15, IN_DECEMBER);

      const job = await reservingJob("NORMAL", 30);
      // November's unused block is not December's.
      expect(await reserve(job, IN_DECEMBER)).toEqual({ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 0 });
    });
  });

  describe("tenant isolation", () => {
    it("never lets one organization draw on, read or name another's entitlement", async () => {
      const periodA = await openPeriod("premium");
      const blockA = await grant(periodA.id, "NORMAL", 10, IN_NOVEMBER);
      const reservedA = await reserveNew("NORMAL", 30);

      // Organization B has no November period: A's does not fund it.
      const jobB = await reservingJob("NORMAL", 30, ORG_B);
      expect(await reserve(jobB, IN_NOVEMBER, ORG_B)).toEqual({ kind: "NO_ENTITLEMENT_PERIOD" });
      // B cannot reserve A's job, read A's balance or allocations, or grant into A's period.
      const jobA = await reservingJob("NORMAL", 30);
      expect((await reserve(jobA, IN_NOVEMBER, ORG_B)).kind).toBe("LOST");
      expect(await ledger.balance(ORG_B, periodA.id)).toBeNull();
      expect(await ledger.allocationsForReservation(ORG_B, reservedA.reservation.id)).toEqual([]);
      expect(
        (
          await ledger.grantAddOnBlock({
            id: "uab_itest_cross",
            organizationId: ORG_B,
            entitlementPeriodId: periodA.id,
            quality: "NORMAL",
            quantity: 5,
            commercialReference: "order_cross",
            purchasedAt: IN_NOVEMBER,
            actorUserId: null,
          })
        ).kind,
      ).toBe("PERIOD_NOT_FOUND");

      // And the database refuses an allocation that crosses the boundary, whatever the code does.
      await expect(
        prisma.generationReservationAllocation.create({
          data: {
            id: "alloc_cross",
            reservationId: reservedA.reservation.id,
            organizationId: ORG_B,
            entitlementPeriodId: periodA.id,
            ordinal: 9,
            sourceType: "ADD_ON_BLOCK",
            addOnBlockId: blockA.id,
            quality: "NORMAL",
            quantity: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("the database holds the ledger's shape", () => {
    it("refuses a block allocation of the other quality, a Base row naming a block, and a second Base row", async () => {
      const period = await openPeriod("premium");
      const hqBlock = await grant(period.id, "HIGH_QUALITY", 2, IN_NOVEMBER);
      const reserved = await reserveNew("NORMAL", 30);
      const base = {
        reservationId: reserved.reservation.id,
        organizationId: ORG_A,
        entitlementPeriodId: period.id,
        quantity: 1,
      };
      await expect(
        prisma.generationReservationAllocation.create({
          data: { ...base, id: "alloc_q", ordinal: 5, sourceType: "ADD_ON_BLOCK", addOnBlockId: hqBlock.id, quality: "NORMAL" },
        }),
      ).rejects.toThrow(/addOnBlockId_entitlemen_fkey/);
      await expect(
        prisma.generationReservationAllocation.create({
          data: { ...base, id: "alloc_b", ordinal: 6, sourceType: "BASE", addOnBlockId: hqBlock.id, quality: "HIGH_QUALITY" },
        }),
      ).rejects.toThrow(/generation_reservation_allocations_shape_check/);
      await expect(
        prisma.generationReservationAllocation.create({
          data: { ...base, id: "alloc_2b", ordinal: 7, sourceType: "BASE", addOnBlockId: null, quality: "NORMAL" },
        }),
      ).rejects.toThrow(/Unique constraint failed/);
    });

    it("refuses an ALLOCATED reservation with no period, and a period whose HQ ceiling exceeds its Base", async () => {
      const job = await reservingJob("NORMAL", 30);
      await expect(
        prisma.generationReservation.create({
          data: {
            id: "genres_noperiod",
            generationJobId: job.id,
            billingCycleKey: "2026-11",
            billingCycleStartedAt: NOVEMBER.startsAt,
            billingCycleEndsAt: NOVEMBER.endsAt,
            funding: "ALLOCATED",
            reservedTotalVideoUnits: 1,
            reservedHighQualityUnits: 0,
          },
        }),
      ).rejects.toThrow(/generation_reservations_funding_period_check/);
      await expect(
        prisma.unitEntitlementPeriod.create({
          data: {
            id: "uep_itest_badhq",
            organizationId: ORG_A,
            billingCycleKey: "bad-hq",
            planKey: "STANDARD",
            baseUnits: 1,
            includedHighQualityUnits: 2,
            highQualityAddOnAvailable: false,
            startsAt: DECEMBER.startsAt,
            endsAt: DECEMBER.endsAt,
          },
        }),
      ).rejects.toThrow(/unit_entitlement_periods_shape_check/);
    });
  });
});

// ---------------------------------------------------------------------------
// Transaction G
// ---------------------------------------------------------------------------

const validation = HAS_DB
  ? createDeliverableValidationRepository(prisma)
  : (null as unknown as ReturnType<typeof createDeliverableValidationRepository>);
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
let leaseSeq = 0;

function facts(seconds: number): ManagedOutputMediaFacts {
  return {
    container: ISO_BMFF_CONTAINER,
    durationMs: seconds * 1_000,
    videoWidth: 1920,
    videoHeight: 1080,
    videoStreamCount: 1,
    audioStreamCount: 0,
  };
}

async function validateAndPublish(organizationId: string, deliverableVersionId: string, seconds: number) {
  leaseSeq += 1;
  const claim = await validation.claimDeliverableValidation({
    organizationId,
    deliverableVersionId,
    now: NOW,
    leaseToken: `vlease_ledger_${leaseSeq}`,
    leaseExpiresAt: NOW + 15 * 60_000,
  });
  if (claim.kind !== "CLAIMED") throw new Error(`claim: ${claim.kind}`);
  const finalized = await validation.finalizeValid({
    claim: claim.claim,
    facts: facts(seconds),
    validatedAt: NOW + 1_000,
    context: ctx(),
  });
  if (finalized.kind === "LEASE_LOST") throw new Error("expected a verdict");
  return { publication: finalized.publication };
}

RUN("Phase 6A — Transaction G spends the frozen funding", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await wipeLedgerPeriods();
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await wipeLedgerPeriods();
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  /** A 35-second, 2-Unit Normal deliverable funded Base 1 + block 1, composed and awaiting validation. */
  async function splitFundedDeliverable() {
    const period = await openPeriod("standard");
    const block = await grant(period.id, "NORMAL", 5, IN_NOVEMBER);
    await spendNormalBase(14);
    const composed = await seedComposedDeliverable(prisma, {
      sceneCount: 7,
      requestedDurationSeconds: 35,
      fundFromLedgerAt: IN_NOVEMBER,
    });
    const allocations = await ledger.allocationsForReservation(ORG_A, composed.reservationId);
    expect(shape(allocations)).toEqual([
      ["BASE", null, "NORMAL", 1],
      ["ADD_ON_BLOCK", block.id, "NORMAL", 1],
    ]);
    return { period, block, composed, allocations };
  }

  it("consumes the selected reservation once, settling every frozen allocation with it", async () => {
    const { period, composed, allocations } = await splitFundedDeliverable();
    const held = await balance(period.id);
    const { publication } = await validateAndPublish(ORG_A, composed.deliverableVersionId, 35);

    const published = await validation.publishDeliverable({ publication, publishedAt: NOW + 2_000, context: ctx() });
    expect(published.kind).toBe("PUBLISHED_AND_CONSUMED");
    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { id: composed.reservationId } });
    expect(reservation.state).toBe("CONSUMED");
    // Consumed Units stay spent — exactly as they were while held — and the frozen set is untouched.
    expect(await balance(period.id)).toEqual(held);
    expect(await ledger.allocationsForReservation(ORG_A, composed.reservationId)).toEqual(allocations);

    const replay = await validation.publishDeliverable({ publication, publishedAt: NOW + 3_000, context: ctx() });
    expect(replay.kind).toBe("ALREADY_PUBLISHED");
    expect(await balance(period.id)).toEqual(held);
    const consumedEvents = await prisma.generationTransitionEvent.count({
      where: { aggregateId: composed.reservationId, toState: "CONSUMED" },
    });
    expect(consumedEvents).toBe(1);

    // A consumed hold cannot be released afterwards, by any replayed release.
    const lateRelease = await repos.reservations.transition({
      organizationId: ORG_A,
      id: composed.reservationId,
      expectedState: "RESERVED",
      expectedVersion: 1,
      nextState: "RELEASED",
      context: ctx(),
    });
    expect(lateRelease.kind).toBe("LOST");
    expect(await balance(period.id)).toEqual(held);
  });

  it("never consumes an unrelated reservation", async () => {
    const { period, composed } = await splitFundedDeliverable();
    const bystander = await reserveNew("NORMAL", 30);
    const { publication } = await validateAndPublish(ORG_A, composed.deliverableVersionId, 35);
    await validation.publishDeliverable({ publication, publishedAt: NOW + 2_000, context: ctx() });

    const untouched = await prisma.generationReservation.findUniqueOrThrow({ where: { id: bystander.reservation.id } });
    expect([untouched.state, untouched.consumedAt]).toEqual(["RESERVED", null]);
    expect((await balance(period.id)).blocks[0]?.remainingUnits).toBe(3);
  });

  it("spends nothing on a replacement publication", async () => {
    const { period, composed } = await splitFundedDeliverable();
    const first = await validateAndPublish(ORG_A, composed.deliverableVersionId, 35);
    await validation.publishDeliverable({ publication: first.publication, publishedAt: NOW + 2_000, context: ctx() });
    const afterInitial = await balance(period.id);

    const recomposed = await seedRecomposedDeliverable(prisma, composed);
    const second = await validateAndPublish(ORG_A, recomposed.deliverableVersionId, 35);
    const replaced = await validation.publishDeliverable({
      publication: second.publication,
      publishedAt: NOW + 4_000,
      context: ctx(),
    });
    expect(replaced.kind).toBe("PUBLISHED_AS_REPLACEMENT");
    expect(await balance(period.id)).toEqual(afterInitial);
    expect(await prisma.generationReservationAllocation.count({ where: { reservationId: composed.reservationId } })).toBe(2);
  });

  it("refuses to spend a hold whose frozen funding no longer covers it, and commits nothing", async () => {
    const { composed, allocations } = await splitFundedDeliverable();
    const { publication } = await validateAndPublish(ORG_A, composed.deliverableVersionId, 35);
    await prisma.generationReservationAllocation.delete({ where: { id: allocations[1]?.id ?? "" } });

    await expect(
      validation.publishDeliverable({ publication, publishedAt: NOW + 2_000, context: ctx() }),
    ).rejects.toThrow(/frozen funding/);
    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { id: composed.reservationId } });
    expect(reservation.state).toBe("RESERVED");
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: composed.jobId } });
    expect([job.state, job.currentDeliverableVersionId]).toEqual(["DELIVERABLE_VALIDATING", null]);
  });
});
