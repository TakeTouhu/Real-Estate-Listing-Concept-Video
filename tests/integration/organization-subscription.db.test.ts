import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  SUBSCRIPTION_AUDIT_ACTION,
} from "@app/database";
import {
  renewEntitlementPeriod,
  type GenerationQualityTier,
  type ProvisionSubscriptionInput,
} from "@app/domain";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  repositories,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The organization subscription and on-demand renewal against live PostgreSQL
 * (Phase 6B, ADR-0056).
 *
 * The month arithmetic is proved without a database in
 * `packages/domain/src/entitlement/subscription.test.ts`. What only a database
 * can prove is here: that a subscription is written once whatever races it, that
 * concurrent renewals open one period, that a renewed period funds a reservation,
 * and that no organization renews on another's subscription.
 *
 * Every renewal here falls in 2027 or later, so it never overlaps the shared
 * fixture's September 2026 period.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const subscriptions = HAS_DB
  ? createSubscriptionRepository(prisma)
  : (null as unknown as ReturnType<typeof createSubscriptionRepository>);
const ledger = HAS_DB
  ? createUnitEntitlementRepository(prisma)
  : (null as unknown as ReturnType<typeof createUnitEntitlementRepository>);
const renewal = { subscriptions, ledger };

const ANCHOR = new Date("2027-01-31T12:00:00.000Z");
const IN_FIRST = new Date("2027-02-10T00:00:00.000Z");
const IN_SECOND = new Date("2027-03-05T00:00:00.000Z");

function input(overrides: Partial<ProvisionSubscriptionInput> = {}): ProvisionSubscriptionInput {
  return {
    id: "sub_itest_a",
    organizationId: ORG_A,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: ANCHOR,
    commercialReference: "contract-itest-a",
    actorUserId: "usr_operator",
    ...overrides,
  };
}

async function provisioned(overrides: Partial<ProvisionSubscriptionInput> = {}) {
  const outcome = await subscriptions.provision(input(overrides));
  if (outcome.kind !== "PROVISIONED") throw new Error(`subscription: ${outcome.kind}`);
  return outcome.subscription;
}

async function wipeSubscriptions() {
  await prisma.unitEntitlementPeriod.deleteMany({ where: { id: { startsWith: "uep_sub_itest_" } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { id: { startsWith: "uep_itest_sub_" } } });
  await prisma.organizationSubscription.deleteMany({ where: { id: { startsWith: "sub_itest_" } } });
  await prisma.auditLog.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] }, action: SUBSCRIPTION_AUDIT_ACTION.Provisioned },
  });
}

let seq = 0;

async function reservingJob(quality: GenerationQualityTier, seconds: number) {
  seq += 1;
  const repos = repositories(prisma);
  const created = await repos.jobs.create(
    ORG_A,
    {
      id: `genjob_sub_${seq}`,
      videoProjectId: PROJECT_A,
      requestedByUserId: "usr_itest",
      qualityTier: quality,
      requestedDurationSeconds: seconds,
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
  return moved.value;
}

RUN("Phase 6B — the organization subscription and renewal", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await wipeSubscriptions();
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await wipeSubscriptions();
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  describe("provisioning", () => {
    it("records the subscription once, with an audit entry", async () => {
      const subscription = await provisioned();
      expect(subscription).toMatchObject({
        id: "sub_itest_a",
        organizationId: ORG_A,
        planKey: "standard",
        channel: "SALES_ASSISTED",
        anchorAt: ANCHOR,
        commercialReference: "contract-itest-a",
      });
      expect(await subscriptions.findByOrganization(ORG_A)).toEqual(subscription);
      const audit = await prisma.auditLog.findMany({
        where: { organizationId: ORG_A, action: SUBSCRIPTION_AUDIT_ACTION.Provisioned },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: "usr_operator",
        resourceType: "organization_subscription",
        resourceId: "sub_itest_a",
        metadata: {
          planKey: "standard",
          channel: "SALES_ASSISTED",
          anchorAt: "2027-01-31T12:00:00.000Z",
          commercialReference: "contract-itest-a",
        },
      });
    });

    it("answers a replay with the same facts, writing nothing", async () => {
      const first = await provisioned();
      expect(await subscriptions.provision(input())).toEqual({ kind: "ALREADY_PROVISIONED", subscription: first });
      expect(await prisma.organizationSubscription.count({ where: { organizationId: ORG_A } })).toBe(1);
      expect(
        await prisma.auditLog.count({ where: { organizationId: ORG_A, action: SUBSCRIPTION_AUDIT_ACTION.Provisioned } }),
      ).toBe(1);
    });

    it.each([
      ["another id", { id: "sub_itest_other" }],
      ["another plan", { planKey: "premium" }],
      ["another channel", { channel: "SELF_SERVICE" }],
      ["another anchor", { anchorAt: new Date("2027-02-01T00:00:00.000Z") }],
      ["another reference", { commercialReference: "contract-other" }],
    ] as const)("refuses %s for an organization that already has one", async (_name, overrides) => {
      const first = await provisioned();
      expect(await subscriptions.provision(input(overrides))).toEqual({ kind: "CONFLICT" });
      expect(await subscriptions.findByOrganization(ORG_A)).toEqual(first);
    });

    it("refuses Enterprise on the self-service channel, and so does the database", async () => {
      expect(await subscriptions.provision(input({ planKey: "enterprise", channel: "SELF_SERVICE" }))).toEqual({
        kind: "CHANNEL_NOT_OFFERED",
      });
      expect(await subscriptions.findByOrganization(ORG_A)).toBeNull();
      await expect(
        prisma.organizationSubscription.create({
          data: {
            id: "sub_itest_raw",
            organizationId: ORG_A,
            planKey: "ENTERPRISE",
            channel: "SELF_SERVICE",
            anchorAt: ANCHOR,
            commercialReference: "contract-raw",
          },
        }),
      ).rejects.toThrow(/organization_subscriptions_shape_check/);
    });

    it("refuses a subscription id another organization already holds", async () => {
      await provisioned();
      expect(
        await subscriptions.provision(input({ organizationId: ORG_B, commercialReference: "contract-itest-b" })),
      ).toEqual({ kind: "CONFLICT" });
      expect(await subscriptions.findByOrganization(ORG_B)).toBeNull();
    });

    it("refuses an organization that does not exist", async () => {
      expect(await subscriptions.provision(input({ organizationId: "org_itest_missing" }))).toEqual({
        kind: "ORGANIZATION_NOT_FOUND",
      });
    });

    it("answers the loser of a concurrent first provision as a sequential replay would", async () => {
      // Commit a rival provision from another connection exactly between this
      // provision's existence read and its insert. Only the unique index orders
      // them.
      let injected = false;
      const intercepted = prisma.$extends({
        query: {
          organizationSubscription: {
            async create({ args, query }) {
              if (!injected) {
                injected = true;
                const rival = await subscriptions.provision(input({ id: "sub_itest_rival" }));
                expect(rival.kind).toBe("PROVISIONED");
              }
              return query(args);
            },
          },
        },
      });
      const contender = createSubscriptionRepository(intercepted as unknown as PrismaClient);
      expect(await contender.provision(input())).toEqual({ kind: "CONFLICT" });
      expect(injected).toBe(true);
      expect((await subscriptions.findByOrganization(ORG_A))?.id).toBe("sub_itest_rival");
      expect(await prisma.organizationSubscription.count({ where: { organizationId: ORG_A } })).toBe(1);
    });

    it("answers an identical concurrent first provision as already provisioned", async () => {
      let injected = false;
      const intercepted = prisma.$extends({
        query: {
          organizationSubscription: {
            async create({ args, query }) {
              if (!injected) {
                injected = true;
                expect((await subscriptions.provision(input())).kind).toBe("PROVISIONED");
              }
              return query(args);
            },
          },
        },
      });
      const contender = createSubscriptionRepository(intercepted as unknown as PrismaClient);
      const outcome = await contender.provision(input());
      expect(outcome.kind).toBe("ALREADY_PROVISIONED");
      expect(injected).toBe(true);
    });
  });

  describe("renewal", () => {
    it("opens the period containing the instant, with the plan frozen on it", async () => {
      const subscription = await provisioned();
      const outcome = await renewEntitlementPeriod(renewal, ORG_A, IN_FIRST);
      expect(outcome.kind).toBe("OPENED");
      if (outcome.kind !== "OPENED") return;
      expect(outcome.period).toMatchObject({
        id: `uep_${subscription.id}_0`,
        organizationId: ORG_A,
        billingCycleKey: "2027-01-31T12:00:00.000Z",
        planKey: "standard",
        baseUnits: 15,
        includedHighQualityUnits: 1,
        highQualityAddOnAvailable: false,
        startsAt: new Date("2027-01-31T12:00:00.000Z"),
        endsAt: new Date("2027-02-28T12:00:00.000Z"),
        commercialReference: "subscription:sub_itest_a:0",
      });
      const audit = await prisma.auditLog.findFirst({
        where: { organizationId: ORG_A, action: "entitlement.period_opened", resourceId: outcome.period.id },
      });
      expect(audit?.actorUserId).toBeNull();
    });

    it("opens one period however many renewals race for it", async () => {
      await provisioned();
      const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => renewEntitlementPeriod(renewal, ORG_A, IN_FIRST)));
      expect(outcomes.filter((o) => o.kind === "OPENED")).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === "ALREADY_OPEN")).toHaveLength(4);
      expect(await prisma.unitEntitlementPeriod.count({ where: { id: { startsWith: "uep_sub_itest_a_" } } })).toBe(1);
    });

    it("opens the next period contiguously, with its own full Base Units", async () => {
      await provisioned();
      const first = await renewEntitlementPeriod(renewal, ORG_A, IN_FIRST);
      const second = await renewEntitlementPeriod(renewal, ORG_A, IN_SECOND);
      if (first.kind !== "OPENED" || second.kind !== "OPENED") throw new Error("renewal did not open");
      expect(second.period.startsAt).toEqual(first.period.endsAt);
      expect(second.period.endsAt).toEqual(new Date("2027-03-31T12:00:00.000Z"));

      const job = await reservingJob("NORMAL", 30);
      const reserved = await repositories(prisma).reservations.reserve(
        ORG_A,
        { reservationId: `genres_${job.id}`, generationJobId: job.id, expectedJobVersion: job.stateVersion, reservedAt: IN_FIRST },
        ctx(),
      );
      expect(reserved.kind).toBe("RESERVED");
      expect((await ledger.balance(ORG_A, first.period.id))?.baseRemainingUnits).toBe(14);
      expect((await ledger.balance(ORG_A, second.period.id))?.baseRemainingUnits).toBe(15);
    });

    it("funds a reservation made at the renewed instant", async () => {
      await provisioned({ planKey: "premium" });
      const job = await reservingJob("HIGH_QUALITY", 60);
      const repos = repositories(prisma);
      const reserve = () =>
        repos.reservations.reserve(
          ORG_A,
          { reservationId: `genres_${job.id}`, generationJobId: job.id, expectedJobVersion: job.stateVersion, reservedAt: IN_SECOND },
          ctx(),
        );
      // Before renewal there is nothing to fund it, and nothing is written.
      expect((await reserve()).kind).toBe("NO_ENTITLEMENT_PERIOD");

      const renewed = await renewEntitlementPeriod(renewal, ORG_A, IN_SECOND);
      if (renewed.kind !== "OPENED") throw new Error(`renewal: ${renewed.kind}`);
      const outcome = await reserve();
      expect(outcome.kind).toBe("RESERVED");
      const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { id: `genres_${job.id}` } });
      expect(reservation.entitlementPeriodId).toBe(renewed.period.id);
      expect(await ledger.balance(ORG_A, renewed.period.id)).toMatchObject({
        baseRemainingUnits: 38,
        includedHighQualityRemainingUnits: 3,
      });
    });

    it("surfaces a hand-opened period it would overlap, and writes nothing", async () => {
      await provisioned();
      const manual = await ledger.openPeriod({
        id: "uep_itest_sub_manual",
        organizationId: ORG_A,
        planKey: "standard",
        billingCycleKey: "2027-02",
        startsAt: new Date("2027-02-01T00:00:00.000Z"),
        endsAt: new Date("2027-03-01T00:00:00.000Z"),
        commercialReference: null,
        actorUserId: null,
      });
      expect(manual.kind).toBe("OPENED");
      expect(await renewEntitlementPeriod(renewal, ORG_A, IN_FIRST)).toEqual({ kind: "PERIOD_CONFLICT" });
      expect(await prisma.unitEntitlementPeriod.count({ where: { id: { startsWith: "uep_sub_itest_" } } })).toBe(0);
    });

    it("opens nothing before the anchor", async () => {
      await provisioned();
      expect(await renewEntitlementPeriod(renewal, ORG_A, new Date("2027-01-31T11:59:59.999Z"))).toEqual({
        kind: "NOT_STARTED",
      });
      expect(await prisma.unitEntitlementPeriod.count({ where: { id: { startsWith: "uep_sub_itest_" } } })).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("never renews one organization on another's subscription", async () => {
      await provisioned();
      expect(await subscriptions.findByOrganization(ORG_B)).toBeNull();
      expect(await renewEntitlementPeriod(renewal, ORG_B, IN_FIRST)).toEqual({ kind: "NO_SUBSCRIPTION" });
      expect(
        await prisma.unitEntitlementPeriod.count({
          where: { organizationId: ORG_B, startsAt: { gte: ANCHOR } },
        }),
      ).toBe(0);
    });

    it("keeps each organization's periods on its own subscription", async () => {
      await provisioned();
      await provisioned({ id: "sub_itest_b", organizationId: ORG_B, planKey: "premium", commercialReference: "contract-itest-b" });
      const a = await renewEntitlementPeriod(renewal, ORG_A, IN_FIRST);
      const b = await renewEntitlementPeriod(renewal, ORG_B, IN_FIRST);
      if (a.kind !== "OPENED" || b.kind !== "OPENED") throw new Error("renewal did not open");
      expect(a.period).toMatchObject({ organizationId: ORG_A, planKey: "standard", baseUnits: 15 });
      expect(b.period).toMatchObject({ organizationId: ORG_B, planKey: "premium", baseUnits: 40 });
      expect(b.period.id).toBe("uep_sub_itest_b_0");
    });
  });
});
