import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, UnitPurchaseService, UnitsOverviewService, type Role } from "@app/domain";
import {
  createPrismaIdentityRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  createUnitPurchaseInvoicingRepository,
  createUnitPurchaseRepository,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * This period's purchases and the invoicing export against PostgreSQL (UP-4,
 * ADR-0069): the Units page lists a period's purchases with their approvers; the
 * export lists the invoice-paid purchases approved in a window, by organization,
 * contract and approval, and audits each organization it lists.
 */

const DOMAIN = "invoice.itest";
const ORG_A = "org_itest_invoice_a";
const ORG_B = "org_itest_invoice_b";
const ORGS = [ORG_A, ORG_B];
const PERIOD_END = new Date("2026-05-15T00:00:00.000Z");

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-04-16T00:00:00.000Z"));
let sequence = 0;
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_invoice_${(sequence += 1)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const subscriptions = createSubscriptionRepository(prisma);
const ledger = createUnitEntitlementRepository(prisma);
const purchases = createUnitPurchaseRepository(prisma);
const service = new UnitPurchaseService({ identity: deps, subscriptions, ledger, purchases });
const overview = new UnitsOverviewService({ identity: deps, subscriptions, ledger, purchases });
const invoicing = createUnitPurchaseInvoicingRepository(prisma);

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  await prisma.unitPurchase.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ organizationId: { in: ORGS } }, { actorUserId: { in: users.map((u) => u.id) } }] },
  });
  await prisma.organization.deleteMany({ where: { id: { in: ORGS } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

let billing: Record<string, string>;

async function member(organizationId: string, role: Role, name: string): Promise<string> {
  const id = (await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" })).id;
  await deps.repos.memberships.create({ organizationId, userId: id, role });
  return id;
}

async function organization(id: string, name: string): Promise<void> {
  await deps.repos.organizations.create({ id, name, slug: id.replaceAll("_", "-"), status: "ACTIVE" });
  const provisioned = await subscriptions.provision({
    id: `sub_${id}`,
    organizationId: id,
    planKey: "premium",
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2026-03-15T00:00:00.000Z"),
    commercialReference: `VT-${id}`,
    actorUserId: null,
  });
  expect(provisioned.kind).toBe("PROVISIONED");
}

/** Approve one package at `at`, by the organization's BILLING member. */
async function buy(organizationId: string, at: string, quality: "NORMAL" | "HIGH_QUALITY" = "NORMAL"): Promise<string> {
  clock.set(new Date(at));
  const [units, priceYenExTax] = quality === "NORMAL" ? [10, 35_900] : [2, 9_000];
  const outcome = await service.approve(billing[organizationId] ?? "", {
    organizationId,
    quality,
    expected: { units, priceYenExTax, periodEndsAt: PERIOD_END },
    idempotencyKey: `itest-${organizationId}-${at}`,
  });
  if (outcome.kind !== "APPROVED") throw new Error(`expected a purchase, got ${outcome.kind}`);
  return outcome.purchase.id;
}

beforeEach(async () => {
  await cleanup();
  await organization(ORG_A, "株式会社 =Kanda");
  await organization(ORG_B, "Studio B");
  billing = {
    [ORG_A]: await member(ORG_A, "BILLING", "billing-a"),
    [ORG_B]: await member(ORG_B, "BILLING", "billing-b"),
  };
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const OPERATOR = { name: "Aoi Tanaka", reason: "April invoices" };
const FROM = new Date("2026-04-17T00:00:00.000Z");
const TO = new Date("2026-04-19T00:00:00.000Z");
const NONE = { kind: "EXPORTED", purchases: [] };

const exportAudits = () =>
  prisma.auditLog.findMany({
    where: { organizationId: { in: ORGS }, action: "unit_purchase.exported" },
    orderBy: { organizationId: "asc" },
  });

describe("the invoicing export", () => {
  it("lists the invoice-paid purchases approved in the window, by organization, contract and approval", async () => {
    await buy(ORG_A, "2026-04-16T23:59:59.999Z");
    const b1 = await buy(ORG_B, "2026-04-17T00:00:00.000Z");
    const a2 = await buy(ORG_A, "2026-04-18T12:00:00.000Z", "HIGH_QUALITY");
    const a1 = await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await buy(ORG_B, "2026-04-19T00:00:00.000Z");

    const exported = await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR });

    const row = (purchaseId: string, organizationId: string, at: string) => ({
      purchaseId,
      organizationId,
      organizationName: organizationId === ORG_A ? "株式会社 =Kanda" : "Studio B",
      contractReference: `VT-${organizationId}`,
      approvedAt: new Date(at),
      expiresAt: PERIOD_END,
      cancelledAt: null,
    });
    const normal = { quality: "NORMAL", units: 10, priceYenExTax: 35_900 };
    expect(exported).toEqual({
      kind: "EXPORTED",
      purchases: [
        { ...row(a1, ORG_A, "2026-04-17T09:00:00.000Z"), ...normal },
        { ...row(a2, ORG_A, "2026-04-18T12:00:00.000Z"), quality: "HIGH_QUALITY", units: 2, priceYenExTax: 9_000 },
        { ...row(b1, ORG_B, "2026-04-17T00:00:00.000Z"), ...normal },
      ],
    });
  });

  it("never lists a card-paid purchase, which its payment processor charges", async () => {
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await prisma.unitPurchase.updateMany({ where: { organizationId: ORG_A }, data: { channel: "SELF_SERVICE" } });
    expect(await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR })).toEqual(NONE);
    expect(await exportAudits()).toEqual([]);
  });

  it("audits each organization it lists once, naming the operator, the window and what it listed", async () => {
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await buy(ORG_A, "2026-04-18T12:00:00.000Z", "HIGH_QUALITY");
    await buy(ORG_A, "2026-04-20T00:00:00.000Z");
    await buy(ORG_B, "2026-04-17T10:00:00.000Z");

    await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: { name: "  Aoi Tanaka ", reason: " April " } });

    const audits = (await exportAudits()).map((audit) => ({
      organizationId: audit.organizationId,
      actorUserId: audit.actorUserId,
      resourceType: audit.resourceType,
      resourceId: audit.resourceId,
      metadata: audit.metadata,
    }));
    expect(audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: null,
        resourceType: "organization",
        resourceId: ORG_A,
        metadata: {
          operator: "Aoi Tanaka",
          reason: "April",
          from: "2026-04-17T00:00:00.000Z",
          to: "2026-04-19T00:00:00.000Z",
          purchases: 2,
          priceYenExTax: 44_900,
          cancelled: 0,
          toInvoiceYenExTax: 44_900,
        },
      },
      {
        organizationId: ORG_B,
        actorUserId: null,
        resourceType: "organization",
        resourceId: ORG_B,
        metadata: {
          operator: "Aoi Tanaka",
          reason: "April",
          from: "2026-04-17T00:00:00.000Z",
          to: "2026-04-19T00:00:00.000Z",
          purchases: 1,
          priceYenExTax: 35_900,
          cancelled: 0,
          toInvoiceYenExTax: 35_900,
        },
      },
    ]);
  });

  it("lists and audits nothing for a window with no purchase", async () => {
    await buy(ORG_A, "2026-04-20T00:00:00.000Z");
    expect(await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR })).toEqual(NONE);
    expect(await exportAudits()).toEqual([]);
  });

  it("changes nothing it lists", async () => {
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    const before = await prisma.unitPurchase.findMany({ where: { organizationId: { in: ORGS } } });
    await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR });
    await invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR });
    expect(await prisma.unitPurchase.findMany({ where: { organizationId: { in: ORGS } } })).toEqual(before);
    expect(await exportAudits()).toHaveLength(2);
  });
});

describe("an export and the approvals it lists (Decision 6)", () => {
  const databaseNow = async () => (await prisma.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`)[0].now;
  const minutesBefore = (instant: Date, minutes: number) => new Date(instant.getTime() - minutes * 60_000);

  it("refuses a window that ended less than ten minutes ago by the database's clock, auditing nothing", async () => {
    const id = await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    const now = await databaseNow();
    await prisma.unitPurchase.update({ where: { id }, data: { approvedAt: minutesBefore(now, 10) } });
    const to = minutesBefore(now, 9);

    expect(await invoicing.exportForInvoicing({ from: minutesBefore(now, 60), to, operator: OPERATOR })).toEqual({
      kind: "NOT_SETTLED",
      settlesAt: new Date(to.getTime() + 10 * 60_000),
    });
    expect(await exportAudits()).toEqual([]);
  });

  it("exports a window that ended more than ten minutes ago", async () => {
    const id = await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    const now = await databaseNow();
    await prisma.unitPurchase.update({ where: { id }, data: { approvedAt: minutesBefore(now, 12) } });

    const request = { from: minutesBefore(now, 60), to: minutesBefore(now, 11), operator: OPERATOR };
    expect(await invoicing.exportForInvoicing(request)).toMatchObject({
      kind: "EXPORTED",
      purchases: [{ purchaseId: id }],
    });
  });

  it("waits for a write to the purchases still in flight, then lists what it committed", async () => {
    const id = await buy(ORG_A, "2026-04-16T12:00:00.000Z");
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let holding = () => {};
    const held = new Promise<void>((resolve) => {
      holding = () => resolve();
    });
    // An UPDATE takes the same ROW EXCLUSIVE lock as an approval's INSERT.
    const writing = prisma.$transaction(async (tx) => {
      await tx.unitPurchase.update({ where: { id }, data: { approvedAt: new Date("2026-04-17T09:00:00.000Z") } });
      holding();
      await released;
    });
    await held;

    let finished = false;
    const exporting = invoicing.exportForInvoicing({ from: FROM, to: TO, operator: OPERATOR }).finally(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    release();
    await writing;
    expect(await exporting).toMatchObject({ kind: "EXPORTED", purchases: [{ purchaseId: id }] });
  });
});

describe("this period's purchases on the Units page", () => {
  it("lists the period's purchases oldest first, with their approver, to a holder of billing.view", async () => {
    await buy(ORG_A, "2026-04-18T12:00:00.000Z", "HIGH_QUALITY");
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await buy(ORG_B, "2026-04-17T10:00:00.000Z");
    clock.set(new Date("2026-04-20T00:00:00.000Z"));
    const owner = await member(ORG_A, "OWNER", "owner-a");
    const creator = await member(ORG_A, "CREATOR", "creator-a");

    expect(await overview.overview(owner, ORG_A)).toMatchObject({
      kind: "ACTIVE",
      purchases: [
        {
          quality: "NORMAL",
          units: 10,
          priceYenExTax: 35_900,
          approvedAt: new Date("2026-04-17T09:00:00.000Z"),
          approvedBy: "billing-a",
        },
        {
          quality: "HIGH_QUALITY",
          units: 2,
          priceYenExTax: 9_000,
          approvedAt: new Date("2026-04-18T12:00:00.000Z"),
          approvedBy: "billing-a",
        },
      ],
    });
    expect(await overview.overview(creator, ORG_A)).toMatchObject({ kind: "ACTIVE", purchases: null });
  });

  it("names an approver who has left as no one", async () => {
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await prisma.membership.deleteMany({ where: { organizationId: ORG_A, userId: billing[ORG_A] ?? "" } });
    const owner = await member(ORG_A, "OWNER", "owner-a");
    expect(await overview.overview(owner, ORG_A)).toMatchObject({ purchases: [{ approvedBy: null }] });
  });

  it("reads one period of one organization", async () => {
    await buy(ORG_A, "2026-04-17T09:00:00.000Z");
    await buy(ORG_B, "2026-04-17T10:00:00.000Z");
    const listed = await purchases.listForPeriod(ORG_A, `uep_sub_${ORG_A}_1`);
    expect(listed.map((p) => [p.organizationId, p.units, p.expiresAt])).toEqual([[ORG_A, 10, PERIOD_END]]);
    expect(await purchases.listForPeriod(ORG_A, `uep_sub_${ORG_B}_1`)).toEqual([]);
  });
});
