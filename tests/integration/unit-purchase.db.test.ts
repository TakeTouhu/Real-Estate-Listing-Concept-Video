import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthService,
  PermissionGrantService,
  UnitPurchaseService,
  UnitsOverviewService,
  unitPurchaseRefusal,
  type ApproveUnitPurchaseInput,
  type Role,
  type UnitPurchaseRecord,
} from "@app/domain";
import {
  createPrismaIdentityRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseRepository,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Buying an additional Unit package against PostgreSQL (UP-2, ADR-0067): the
 * purchase, its block and their audit entries commit together or not at all;
 * a replayed or concurrent double submit buys once; the approver's permission is
 * re-read inside the transaction; and the schema keeps a purchase tied to a
 * block of its own period, quality and organization.
 */

const DOMAIN = "purchase.itest";
const ORG = "org_itest_purchase";
const OTHER_ORG = "org_itest_purchase_other";
const NOW = new Date("2026-04-20T09:00:00.000Z");
const PERIOD_END = new Date("2026-05-15T00:00:00.000Z");

const prisma = new PrismaClient();
const clock = new TestClock(NOW);
let sequence = 0;
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_purchase_${(sequence += 1)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const subscriptions = createSubscriptionRepository(prisma);
const ledger = createUnitEntitlementRepository(prisma);
const purchases = createUnitPurchaseRepository(prisma);
const service = new UnitPurchaseService({ identity: deps, subscriptions, ledger, purchases });

async function cleanup(): Promise<void> {
  const orgs = [ORG, OTHER_ORG];
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  await prisma.unitPurchase.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: orgs } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ organizationId: { in: orgs } }, { actorUserId: { in: users.map((u) => u.id) } }] },
  });
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

let ids: Record<Role, string>;

async function member(organizationId: string, role: Role, name: string): Promise<string> {
  const id = (await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" })).id;
  await deps.repos.memberships.create({ organizationId, userId: id, role });
  return id;
}

async function organization(id: string, planKey: "standard" | "premium" = "premium"): Promise<void> {
  await deps.repos.organizations.create({ id, name: id, slug: id.replaceAll("_", "-"), status: "ACTIVE" });
  const provisioned = await subscriptions.provision({
    id: `sub_${id}`,
    organizationId: id,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2026-03-15T00:00:00.000Z"),
    commercialReference: `VT-${id}`,
    actorUserId: null,
  });
  expect(provisioned.kind).toBe("PROVISIONED");
}

beforeEach(async () => {
  await cleanup();
  clock.set(NOW);
  await organization(ORG);
  ids = {
    OWNER: await member(ORG, "OWNER", "owner"),
    ADMIN: await member(ORG, "ADMIN", "admin"),
    MANAGER: await member(ORG, "MANAGER", "manager"),
    CREATOR: await member(ORG, "CREATOR", "creator"),
    VIEWER: await member(ORG, "VIEWER", "viewer"),
    BILLING: await member(ORG, "BILLING", "billing"),
  };
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function request(overrides: Partial<ApproveUnitPurchaseInput> = {}): ApproveUnitPurchaseInput {
  return {
    organizationId: ORG,
    quality: "NORMAL",
    expected: { units: 10, priceYenExTax: 35_900, periodEndsAt: PERIOD_END },
    idempotencyKey: "itest-key-1",
    ...overrides,
  };
}

const PERIOD_1 = `uep_sub_${ORG}_1`;

function record(overrides: Partial<UnitPurchaseRecord> = {}): UnitPurchaseRecord {
  return {
    id: "upur_itest_direct",
    addOnBlockId: "uab_itest_direct",
    organizationId: ORG,
    entitlementPeriodId: PERIOD_1,
    quality: "NORMAL",
    units: 10,
    priceYenExTax: 35_900,
    channel: "SALES_ASSISTED",
    contractReference: `VT-${ORG}`,
    idempotencyKey: "itest-direct",
    approvedByUserId: ids.BILLING,
    approvedAt: NOW,
    ...overrides,
  };
}

async function openPeriod1(): Promise<void> {
  const opened = await ledger.openPeriod({
    id: PERIOD_1,
    organizationId: ORG,
    planKey: "premium",
    billingCycleKey: "2026-04-15T00:00:00.000Z",
    startsAt: new Date("2026-04-15T00:00:00.000Z"),
    endsAt: PERIOD_END,
    commercialReference: `subscription:sub_${ORG}:1`,
    actorUserId: null,
  });
  expect(opened.kind).toBe("OPENED");
}

const written = async (organizationId = ORG) => ({
  purchases: await prisma.unitPurchase.count({ where: { organizationId } }),
  blocks: await prisma.unitAddOnBlock.count({ where: { organizationId } }),
  audits: (
    await prisma.auditLog.findMany({
      where: { organizationId, action: { in: ["entitlement.add_on_block_granted", "unit_purchase.approved"] } },
      select: { action: true },
      orderBy: { action: "asc" },
    })
  ).map((a) => a.action),
});

describe("one transaction", () => {
  it("writes the purchase, its block and both audit entries, and the Units are usable at once", async () => {
    const outcome = await service.approve(ids.BILLING, request());
    if (outcome.kind !== "APPROVED") throw new Error(`expected a purchase, got ${outcome.kind}`);
    const { id, addOnBlockId } = outcome.purchase;

    expect(await prisma.unitPurchase.findUniqueOrThrow({ where: { id } })).toMatchObject({
      organizationId: ORG,
      entitlementPeriodId: PERIOD_1,
      addOnBlockId,
      quality: "NORMAL",
      priceYenExTax: 35_900,
      channel: "SALES_ASSISTED",
      contractReference: `VT-${ORG}`,
      idempotencyKey: "itest-key-1",
      approvedByUserId: ids.BILLING,
      approvedAt: NOW,
    });
    expect(await prisma.unitAddOnBlock.findUniqueOrThrow({ where: { id: addOnBlockId } })).toMatchObject({
      entitlementPeriodId: PERIOD_1,
      quality: "NORMAL",
      quantity: 10,
      commercialReference: `unit-purchase:${id}`,
      purchasedAt: NOW,
    });
    const approved = await prisma.auditLog.findFirstOrThrow({ where: { action: "unit_purchase.approved" } });
    expect(approved).toMatchObject({
      organizationId: ORG,
      actorUserId: ids.BILLING,
      resourceType: "unit_purchase",
      resourceId: id,
    });
    expect(approved.metadata).toEqual({
      approverRole: "BILLING",
      entitlementPeriodId: PERIOD_1,
      addOnBlockId,
      quality: "NORMAL",
      units: 10,
      priceYenExTax: 35_900,
      channel: "SALES_ASSISTED",
      contractReference: `VT-${ORG}`,
      expiresAt: "2026-05-15T00:00:00.000Z",
    });
    expect(await written()).toEqual({
      purchases: 1,
      blocks: 1,
      audits: ["entitlement.add_on_block_granted", "unit_purchase.approved"],
    });

    const units = new UnitsOverviewService({ identity: deps, subscriptions, ledger });
    const overview = await units.overview(ids.CREATOR, ORG);
    expect(overview).toMatchObject({ kind: "ACTIVE", normalAddOnRemaining: 10, highQualityAddOnRemaining: 0 });
  });

  it("writes nothing at all when the purchase row is refused after its block was inserted", async () => {
    await openPeriod1();
    // A zero price passes no check of the database's: the CHECK refuses the
    // purchase row, after the block and its audit entry were already inserted.
    await expect(purchases.approve(record({ priceYenExTax: 0 }), () => null)).rejects.toThrow(
      /unit_purchases_shape_check/,
    );
    expect(await written()).toEqual({ purchases: 0, blocks: 0, audits: [] });
  });

  it("surfaces a collision that is not the key's, writing nothing", async () => {
    await openPeriod1();
    await ledger.grantAddOnBlock({
      id: "uab_itest_taken",
      organizationId: ORG,
      entitlementPeriodId: PERIOD_1,
      quality: "NORMAL",
      quantity: 1,
      commercialReference: "order-1",
      purchasedAt: NOW,
      actorUserId: null,
    });
    await expect(purchases.approve(record({ addOnBlockId: "uab_itest_taken" }), () => null)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await prisma.unitPurchase.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.unitAddOnBlock.count({ where: { organizationId: ORG } })).toBe(1);
  });
});

describe("bought once", () => {
  it("answers a replay with the purchase it made", async () => {
    const first = await service.approve(ids.BILLING, request());
    expect((await service.approve(ids.BILLING, request())).kind).toBe("ALREADY_APPROVED");
    expect(first.kind).toBe("APPROVED");
    expect(await written()).toMatchObject({ purchases: 1, blocks: 1 });
  });

  it("buys once when a double submit arrives concurrently", async () => {
    const outcomes = await Promise.all([
      service.approve(ids.BILLING, request()),
      service.approve(ids.BILLING, request()),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["ALREADY_APPROVED", "APPROVED"]);
    expect(await written()).toMatchObject({ purchases: 1, blocks: 1 });
  });

  it("buys twice under two keys, concurrently", async () => {
    const outcomes = await Promise.all([
      service.approve(ids.BILLING, request()),
      service.approve(ids.OWNER, request({ idempotencyKey: "itest-key-2" })),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(["APPROVED", "APPROVED"]);
    expect(await written()).toMatchObject({ purchases: 2, blocks: 2 });
  });

  it("answers a same-key approval into another period as the winner's when it loses the insert", async () => {
    await openPeriod1();
    const period2 = await ledger.openPeriod({
      id: "uep_itest_purchase_2",
      organizationId: ORG,
      planKey: "premium",
      billingCycleKey: "2026-05-15T00:00:00.000Z",
      startsAt: PERIOD_END,
      endsAt: new Date("2026-06-15T00:00:00.000Z"),
      commercialReference: "period-2",
      actorUserId: null,
    });
    expect(period2.kind).toBe("OPENED");
    // Different periods take different locks, so neither waits for the other
    // before the key's unique index decides.
    const outcomes = await Promise.all([
      purchases.approve(record(), () => null),
      purchases.approve(
        record({
          id: "upur_itest_other",
          addOnBlockId: "uab_itest_other",
          entitlementPeriodId: "uep_itest_purchase_2",
        }),
        () => null,
      ),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["APPROVED", "EXISTING"]);
    expect(await written()).toMatchObject({ purchases: 1, blocks: 1 });
  });

  it("records an HQ package as HQ Units, its block holding them", async () => {
    const hq = { units: 2, priceYenExTax: 9_000, periodEndsAt: PERIOD_END };
    const outcome = await service.approve(ids.OWNER, request({ quality: "HIGH_QUALITY", expected: hq }));
    if (outcome.kind !== "APPROVED") throw new Error("expected a purchase");
    expect([outcome.purchase.quality, outcome.purchase.units, outcome.purchase.priceYenExTax]).toEqual([
      "HIGH_QUALITY",
      2,
      9_000,
    ]);
    expect((await service.approve(ids.OWNER, request({ quality: "HIGH_QUALITY", expected: hq }))).kind).toBe(
      "ALREADY_APPROVED",
    );
  });

  it("scopes a key to its organization", async () => {
    await organization(OTHER_ORG);
    const otherBilling = await member(OTHER_ORG, "BILLING", "other-billing");
    expect((await service.approve(ids.BILLING, request())).kind).toBe("APPROVED");
    expect((await service.approve(otherBilling, request({ organizationId: OTHER_ORG }))).kind).toBe("APPROVED");
    expect(await purchases.findByIdempotencyKey(OTHER_ORG, "itest-key-1")).toMatchObject({
      organizationId: OTHER_ORG,
      approvedByUserId: otherBilling,
    });
  });
});

describe("re-checked inside the transaction", () => {
  const check = (facts: Parameters<Parameters<typeof purchases.approve>[1]>[0]) =>
    unitPurchaseRefusal(request(), facts, NOW);

  it("reads the approver's permissions there: its role, its grants, and whether it is still a member", async () => {
    await openPeriod1();
    expect(await purchases.approve(record({ approvedByUserId: ids.ADMIN }), check)).toEqual({
      kind: "REFUSED",
      reason: "LACKS_BILLING_MANAGE",
    });
    expect(await purchases.approve(record({ approvedByUserId: "usr_not_a_member" }), check)).toEqual({
      kind: "REFUSED",
      reason: "LACKS_BILLING_MANAGE",
    });
    await new PermissionGrantService(deps).grant(ids.OWNER, ORG, ids.ADMIN, "billing.manage");
    expect((await purchases.approve(record({ approvedByUserId: ids.ADMIN }), check)).kind).toBe("APPROVED");
  });

  it("counts billing.manage held through a group", async () => {
    await openPeriod1();
    const group = { groupId: "grp_itest_purchase", organizationId: ORG };
    await prisma.group.create({
      data: { id: group.groupId, organizationId: ORG, name: "Finance", createdByUserId: ids.OWNER },
    });
    await prisma.groupMember.create({
      data: { ...group, userId: ids.MANAGER, addedByUserId: ids.OWNER },
    });
    expect(await purchases.approve(record({ approvedByUserId: ids.MANAGER }), check)).toEqual({
      kind: "REFUSED",
      reason: "LACKS_BILLING_MANAGE",
    });
    await prisma.groupPermission.create({
      data: { ...group, permission: "billing.manage", grantedByUserId: ids.OWNER },
    });
    expect((await purchases.approve(record({ approvedByUserId: ids.MANAGER }), check)).kind).toBe("APPROVED");
  });

  it("finds a purchase already holding the key before checking anything", async () => {
    await openPeriod1();
    const first = await purchases.approve(record(), () => null);
    if (first.kind !== "APPROVED") throw new Error("expected a purchase");
    const again = await purchases.approve(record({ id: "upur_itest_again", addOnBlockId: "uab_itest_again" }), () => {
      throw new Error("the check must not run for a key already used");
    });
    expect(again).toEqual({ kind: "EXISTING", purchase: first.purchase });
  });

  it("refuses an approver removed after it was authorized, writing nothing", async () => {
    await openPeriod1();
    await deps.repos.memberships.remove(ORG, ids.BILLING, "BILLING", () => ({
      organizationId: ORG,
      actorUserId: ids.OWNER,
      action: "member.removed",
      resourceType: "membership",
      resourceId: `${ORG}:${ids.BILLING}`,
      metadata: {},
    }));
    expect(await purchases.approve(record(), check)).toEqual({ kind: "REFUSED", reason: "LACKS_BILLING_MANAGE" });
    expect(await written()).toEqual({ purchases: 0, blocks: 0, audits: [] });
  });

  it("hands the check the period it locked and the subscription it read", async () => {
    await openPeriod1();
    let seen: unknown;
    await purchases.approve(record(), (facts) => {
      seen = [facts.period?.planKey, facts.period?.endsAt, facts.subscription?.commercialReference];
      return "PERIOD_CHANGED";
    });
    expect(seen).toEqual(["premium", PERIOD_END, `VT-${ORG}`]);
    expect(await written()).toEqual({ purchases: 0, blocks: 0, audits: [] });
  });

  it("finds no period of another organization", async () => {
    await openPeriod1();
    await organization(OTHER_ORG);
    expect(await purchases.approve(record({ organizationId: OTHER_ORG }), () => null)).toEqual({
      kind: "PERIOD_NOT_FOUND",
    });
  });
});

describe("what the purchase screen offers (UP-3)", () => {
  it("shows the period as it would open, opening nothing, and offers what a purchase then accepts", async () => {
    const before = await service.offers(ids.BILLING, ORG);
    expect(before).toEqual({
      kind: "AVAILABLE",
      planKey: "premium",
      packages: [
        { quality: "NORMAL", units: 10, priceYenExTax: 35_900 },
        { quality: "HIGH_QUALITY", units: 2, priceYenExTax: 9_000 },
      ],
      periodEndsAt: PERIOD_END,
      contractReference: `VT-${ORG}`,
    });
    expect(await prisma.unitEntitlementPeriod.count({ where: { organizationId: ORG } })).toBe(0);
    if (before.kind !== "AVAILABLE") throw new Error("expected packages on offer");

    const [normal] = before.packages;
    if (normal === undefined) throw new Error("expected a Normal package");
    const outcome = await service.approve(ids.BILLING, {
      organizationId: ORG,
      quality: normal.quality,
      expected: { units: normal.units, priceYenExTax: normal.priceYenExTax, periodEndsAt: before.periodEndsAt },
      idempotencyKey: "itest-offered",
    });
    expect(outcome.kind).toBe("APPROVED");
    expect(await service.offers(ids.BILLING, ORG)).toEqual(before);
  });

  it("offers nothing while the ledger holds a period the plan did not open, as approving buys none", async () => {
    const opened = await ledger.openPeriod({
      id: "uep_itest_by_hand",
      organizationId: ORG,
      planKey: "premium",
      billingCycleKey: "by-hand",
      startsAt: new Date("2026-04-10T00:00:00.000Z"),
      endsAt: new Date("2026-05-10T00:00:00.000Z"),
      commercialReference: "by hand",
      actorUserId: null,
    });
    expect(opened.kind).toBe("OPENED");

    expect(await service.offers(ids.BILLING, ORG)).toEqual({ kind: "PERIOD_CONFLICT" });
    await expect(service.approve(ids.BILLING, request())).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await written()).toEqual({ purchases: 0, blocks: 0, audits: [] });
  });

  it("refuses a member without billing.manage, writing nothing", async () => {
    await expect(service.offers(ids.ADMIN, ORG)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: "unit_purchase.refused" } })).toBe(0);
  });
});

describe("the schema", () => {
  async function insert(overrides: Partial<Prisma.UnitPurchaseUncheckedCreateInput>) {
    return prisma.unitPurchase.create({
      data: {
        id: "upur_itest_raw",
        organizationId: ORG,
        entitlementPeriodId: PERIOD_1,
        addOnBlockId: "uab_itest_raw",
        quality: "NORMAL",
        priceYenExTax: 35_900,
        channel: "SALES_ASSISTED",
        contractReference: "VT-1",
        idempotencyKey: "raw",
        approvedByUserId: ids.BILLING,
        approvedAt: NOW,
        ...overrides,
      },
    });
  }

  beforeEach(async () => {
    await openPeriod1();
    await ledger.grantAddOnBlock({
      id: "uab_itest_raw",
      organizationId: ORG,
      entitlementPeriodId: PERIOD_1,
      quality: "NORMAL",
      quantity: 10,
      commercialReference: "raw-order",
      purchasedAt: NOW,
      actorUserId: null,
    });
  });

  it("accepts a purchase of its own block", async () => {
    await expect(insert({})).resolves.toMatchObject({ id: "upur_itest_raw" });
  });

  it("refuses a purchase naming its block with another quality", async () => {
    await expect(insert({ quality: "HIGH_QUALITY" })).rejects.toThrow(/Foreign key constraint/);
  });

  it("refuses a purchase in another organization than its period's", async () => {
    await organization(OTHER_ORG);
    await expect(insert({ organizationId: OTHER_ORG })).rejects.toThrow(/Foreign key constraint/);
  });

  it("refuses a second purchase of one block", async () => {
    await insert({});
    await expect(insert({ id: "upur_itest_raw_2", idempotencyKey: "raw-2" })).rejects.toThrow(/Unique constraint/);
  });

  it.each([
    ["a zero price", { priceYenExTax: 0 }],
    ["an empty contract", { contractReference: "" }],
    ["an empty key", { idempotencyKey: "" }],
    ["a key of 201 characters", { idempotencyKey: "k".repeat(201) }],
  ])("refuses %s", async (_what, overrides) => {
    await expect(insert(overrides)).rejects.toThrow(/unit_purchases_shape_check/);
  });

  it("keeps the purchase and its block when the approver's user is deleted", async () => {
    await insert({});
    await prisma.membership.deleteMany({ where: { userId: ids.BILLING } });
    await prisma.session.deleteMany({ where: { userId: ids.BILLING } });
    await prisma.credential.deleteMany({ where: { userId: ids.BILLING } });
    await prisma.user.delete({ where: { id: ids.BILLING } });
    expect(await prisma.unitPurchase.count({ where: { id: "upur_itest_raw" } })).toBe(1);
  });

  it("restricts deleting the block or the organization under a purchase", async () => {
    await insert({});
    await expect(prisma.unitAddOnBlock.delete({ where: { id: "uab_itest_raw" } })).rejects.toThrow(
      /unit_purchases_addOnBlockId_entitlementPeriodId_quality_fkey/,
    );
    // The subscription restricts it too; without it, the purchase still does.
    await prisma.organizationSubscription.delete({ where: { organizationId: ORG } });
    await expect(prisma.organization.delete({ where: { id: ORG } })).rejects.toThrow(
      /unit_purchases_organizationId_fkey/,
    );
  });
});
