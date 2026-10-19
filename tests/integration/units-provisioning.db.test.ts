import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthService,
  UnitsOverviewService,
  provisionFromSalesContract,
  renewEntitlementPeriod,
  type Role,
} from "@app/domain";
import {
  createPrismaIdentityRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseRepository,
  SUBSCRIPTION_AUDIT_ACTION,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";
import { parseProvisionArguments, runProvisionSubscription } from "../../apps/ops/src/provision-subscription";

/**
 * Giving an organization its contract's plan, and what its members then see,
 * against PostgreSQL (UP-1, ADR-0066): the operator command writes one
 * subscription and one audit entry naming the operator and the reason; running
 * it again writes nothing; and the Units overview reads the plan and the ledger
 * without writing anything.
 */

const DOMAIN = "units.itest";
const ORG = "org_itest_units";
const ANCHOR = "2026-03-15T09:00:00+09:00";

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-04-20T03:00:00.000Z"));
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_units_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const subscriptions = createSubscriptionRepository(prisma);
const ledger = createUnitEntitlementRepository(prisma);
const purchases = createUnitPurchaseRepository(prisma);
const overview = new UnitsOverviewService({ identity: deps, subscriptions, ledger, purchases });

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: ORG } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ organizationId: ORG }, { actorUserId: { in: users.map((u) => u.id) } }] },
  });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

beforeEach(async () => {
  await cleanup();
  clock.set(new Date("2026-04-20T03:00:00.000Z"));
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function member(role: Role): Promise<string> {
  const id = (await auth.register({ email: `${role.toLowerCase()}@${DOMAIN}`, name: role, password: "password-123456" }))
    .id;
  await deps.repos.memberships.create({ organizationId: ORG, userId: id, role });
  return id;
}

async function organization(): Promise<void> {
  await deps.repos.organizations.create({ id: ORG, name: "Units", slug: "org-itest-units", status: "ACTIVE" });
}

/** The command line an operator would type, parsed and run. */
async function command(overrides: Record<string, string> = {}) {
  const options = {
    organization: ORG,
    plan: "premium",
    starts: ANCHOR,
    contract: "VT-ITEST-1",
    operator: "  Aoi Tanaka ",
    reason: "Signed order 12",
    ...overrides,
  };
  const parsed = parseProvisionArguments(Object.entries(options).flatMap(([name, value]) => [`--${name}`, value]));
  if (!parsed.ok) throw new Error(parsed.error);
  return runProvisionSubscription(subscriptions, parsed.value);
}

function provisionedAudits() {
  return prisma.auditLog.findMany({ where: { organizationId: ORG, action: SUBSCRIPTION_AUDIT_ACTION.Provisioned } });
}

describe("the operator command", () => {
  it("writes one sales-assisted subscription and an audit entry naming the operator and the reason", async () => {
    await organization();
    expect(await command()).toMatchObject({ exitCode: 0 });
    const row = await prisma.organizationSubscription.findUnique({ where: { organizationId: ORG } });
    expect(row).toMatchObject({
      id: `sub_${ORG}`,
      planKey: "PREMIUM",
      channel: "SALES_ASSISTED",
      anchorAt: new Date("2026-03-15T00:00:00.000Z"),
      commercialReference: "VT-ITEST-1",
    });
    const audits = await provisionedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      resourceType: "organization_subscription",
      resourceId: `sub_${ORG}`,
    });
    expect(audits[0]?.metadata).toEqual({
      planKey: "premium",
      channel: "SALES_ASSISTED",
      anchorAt: "2026-03-15T00:00:00.000Z",
      commercialReference: "VT-ITEST-1",
      operator: "Aoi Tanaka",
      reason: "Signed order 12",
    });
  });

  it("writes nothing when run again with the same contract, whoever runs it", async () => {
    await organization();
    await command();
    expect(await command({ operator: "Ren Sato", reason: "Re-run" })).toMatchObject({
      exitCode: 0,
      message: expect.stringContaining("Nothing was written"),
    });
    expect(await prisma.organizationSubscription.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await provisionedAudits()).toHaveLength(1);
  });

  it("refuses a different plan or contract, writing nothing and showing what is there", async () => {
    await organization();
    await command();
    const changes: Record<string, string>[] = [
      { plan: "standard" },
      { contract: "VT-ITEST-2" },
      { starts: "2026-04-01T00:00:00Z" },
    ];
    for (const overrides of changes) {
      const result = await command(overrides);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("already has Premium, invoice-paid, from 2026-03-15T00:00:00.000Z, reference VT-ITEST-1");
    }
    const row = await prisma.organizationSubscription.findUnique({ where: { organizationId: ORG } });
    expect(row).toMatchObject({ planKey: "PREMIUM", commercialReference: "VT-ITEST-1" });
    expect(await provisionedAudits()).toHaveLength(1);
  });

  it("stores the operator's name and reason trimmed, whoever calls the repository", async () => {
    await organization();
    const outcome = await provisionFromSalesContract(subscriptions, {
      organizationId: ORG,
      planKey: "standard",
      startsAt: new Date(ANCHOR),
      contractReference: "VT-ITEST-3",
      operator: { name: "\tRen Sato  ", reason: "  Order 7\n" },
    });
    expect(outcome.kind).toBe("PROVISIONED");
    expect((await provisionedAudits())[0]?.metadata).toMatchObject({ operator: "Ren Sato", reason: "Order 7" });
  });

  it("refuses an organization that does not exist, writing nothing", async () => {
    expect(await command()).toEqual({
      exitCode: 1,
      message: `Refused: there is no organization ${ORG}. Nothing was written.`,
    });
    expect(await prisma.organizationSubscription.count({ where: { organizationId: ORG } })).toBe(0);
  });
});

describe("the Units overview", () => {
  it("shows no plan until the command has run, then the current period, writing nothing", async () => {
    await organization();
    const owner = await member("OWNER");
    expect(await overview.overview(owner, ORG)).toEqual({ kind: "NO_PLAN" });
    await command();
    const auditsBefore = await prisma.auditLog.count({ where: { organizationId: ORG } });

    expect(await overview.overview(owner, ORG)).toEqual({
      kind: "ACTIVE",
      planKey: "premium",
      period: { startsAt: new Date("2026-04-15T00:00:00.000Z"), endsAt: new Date("2026-05-15T00:00:00.000Z") },
      baseUnits: { included: 40, remaining: 40 },
      highQuality: { includedCeiling: 5, ceilingRemaining: 5, fundableFromBase: 5 },
      highQualityAddOnAvailable: true,
      addOnBlocks: [],
      normalAddOnRemaining: 0,
      highQualityAddOnRemaining: 0,
      billing: { channel: "SALES_ASSISTED", monthlyPriceYenExTax: 119_800 },
      purchases: [],
      mayBuyUnits: true,
    });
    expect(await prisma.unitEntitlementPeriod.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(auditsBefore);
  });

  it("says when the plan starts, before its first period", async () => {
    await organization();
    const manager = await member("MANAGER");
    await command();
    clock.set(new Date("2026-03-14T23:59:59.999Z"));
    expect(await overview.overview(manager, ORG)).toEqual({
      kind: "NOT_STARTED",
      planKey: "premium",
      startsAt: new Date("2026-03-15T00:00:00.000Z"),
      billing: null,
    });
  });

  it("reads an opened period and its blocks from the ledger", async () => {
    await organization();
    const billing = await member("BILLING");
    await command();
    const renewed = await renewEntitlementPeriod({ subscriptions, ledger }, ORG, clock.now());
    if (renewed.kind !== "OPENED") throw new Error(`renewal: ${renewed.kind}`);
    for (const [id, quality, quantity, purchasedAt] of [
      ["blk_itest_units_2", "NORMAL", 10, "2026-04-18T00:00:00.000Z"],
      ["blk_itest_units_1", "HIGH_QUALITY", 2, "2026-04-16T00:00:00.000Z"],
    ] as const) {
      const granted = await ledger.grantAddOnBlock({
        id,
        organizationId: ORG,
        entitlementPeriodId: renewed.period.id,
        quality,
        quantity,
        commercialReference: `order-${id}`,
        purchasedAt: new Date(purchasedAt),
        actorUserId: billing,
      });
      if (granted.kind !== "GRANTED") throw new Error(`grant: ${granted.kind}`);
    }
    expect(await overview.overview(billing, ORG)).toMatchObject({
      kind: "ACTIVE",
      period: { startsAt: new Date("2026-04-15T00:00:00.000Z"), endsAt: new Date("2026-05-15T00:00:00.000Z") },
      baseUnits: { included: 40, remaining: 40 },
      addOnBlocks: [
        { quality: "HIGH_QUALITY", remainingUnits: 2, purchasedAt: new Date("2026-04-16T00:00:00.000Z") },
        { quality: "NORMAL", remainingUnits: 10, purchasedAt: new Date("2026-04-18T00:00:00.000Z") },
      ],
      normalAddOnRemaining: 10,
      highQualityAddOnRemaining: 2,
    });
  });

  it("refuses a VIEWER and a non-member", async () => {
    await organization();
    const viewer = await member("VIEWER");
    const outsider = (await auth.register({ email: `outsider@${DOMAIN}`, name: "Outsider", password: "password-123456" }))
      .id;
    await command();
    await expect(overview.overview(viewer, ORG)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(overview.overview(outsider, ORG)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
