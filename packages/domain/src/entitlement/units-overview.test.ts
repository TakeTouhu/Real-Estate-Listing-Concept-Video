import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import type { GenerationQualityTier } from "../orchestration/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryUnitsReader } from "../testing/in-memory-units";
import type { UnitEntitlementPeriod } from "./ports";
import type { OrganizationSubscription } from "./subscription";
import type { UnitPurchase } from "./unit-purchase";
import { UnitsOverviewService } from "./units-overview";

/**
 * What an organization sees of its plan and Units (UP-1, ADR-0066 Decision 3):
 * `unit.view` to see the Units, `billing.view` as well for how the plan is paid
 * and the period's purchases (UP-4, ADR-0069), the ledger's period when there is
 * one and the subscription's otherwise, and nothing written either way. Every
 * instant is written out literally.
 */

const iso = (value: string) => new Date(value);

let deps: TestDeps;
let reader: InMemoryUnitsReader;
let service: UnitsOverviewService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  reader = new InMemoryUnitsReader();
  service = new UnitsOverviewService({ identity: deps, subscriptions: reader, ledger: reader, purchases: reader });
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const register = async (name: string) =>
    (await auth.register({ email: `${name}@example.com`, name, password: "password-123456" })).id;
  const owner = await register("owner");
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(owner, { name: "Org" }));
  ids = {
    OWNER: owner,
    ADMIN: await register("admin"),
    MANAGER: await register("manager"),
    CREATOR: await register("creator"),
    VIEWER: await register("viewer"),
    BILLING: await register("billing"),
    outsider: await register("outsider"),
  };
  for (const role of ["ADMIN", "MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
    await deps.repos.memberships.create({ organizationId: orgId, userId: ids[role], role });
  }
});

function subscribe(overrides: Partial<OrganizationSubscription> = {}): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-03-15T00:00:00.000Z"),
    commercialReference: "C-1",
    createdAt: iso("2026-03-01T00:00:00.000Z"),
    ...overrides,
  });
}

function premiumPeriod(): UnitEntitlementPeriod {
  const period: UnitEntitlementPeriod = {
    id: "uep_premium",
    organizationId: orgId,
    billingCycleKey: "2026-04-15T00:00:00.000Z",
    planKey: "premium",
    baseUnits: 40,
    includedHighQualityUnits: 5,
    highQualityAddOnAvailable: true,
    startsAt: iso("2026-04-15T00:00:00.000Z"),
    endsAt: iso("2026-05-15T00:00:00.000Z"),
    commercialReference: "subscription:x:1",
    createdAt: iso("2026-04-15T00:00:00.000Z"),
  };
  reader.periods.push(period);
  return period;
}

function bought(overrides: Partial<UnitPurchase> & Pick<UnitPurchase, "id" | "approvedAt">): void {
  reader.purchases.push({
    organizationId: orgId,
    entitlementPeriodId: "uep_premium",
    addOnBlockId: `uab_${overrides.id}`,
    quality: "NORMAL",
    units: 10,
    priceYenExTax: 35_900,
    channel: "SALES_ASSISTED",
    contractReference: "C-1",
    expiresAt: iso("2026-05-15T00:00:00.000Z"),
    idempotencyKey: `key_${overrides.id}`,
    approvedByUserId: ids.BILLING,
    cancelledAt: null,
    ...overrides,
  });
}

function listed(
  quality: GenerationQualityTier,
  units: number,
  price: number,
  at: string,
  by: string | null,
  cancelledAt: Date | null = null,
) {
  return { quality, units, priceYenExTax: price, approvedAt: iso(at), approvedBy: by, cancelledAt };
}

describe("who may see it", () => {
  it("refuses a non-member before reading anything about the plan", async () => {
    const find = vi.spyOn(reader, "findByOrganization");
    const period = vi.spyOn(reader, "findPeriodAt");
    await expect(service.overview(ids.outsider, orgId)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have access to this organization",
    });
    expect(find).not.toHaveBeenCalled();
    expect(period).not.toHaveBeenCalled();
  });

  it("refuses a VIEWER, whose role does not hold unit.view", async () => {
    subscribe();
    await expect(service.overview(ids.VIEWER, orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["OWNER", "ADMIN", "MANAGER", "CREATOR", "BILLING"] as const)("shows a %s the Units", async (role) => {
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect((await service.overview(ids[role], orgId)).kind).toBe("ACTIVE");
  });

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["BILLING", true],
    ["MANAGER", false],
    ["CREATOR", false],
  ] as const)("shows a %s how the plan is paid: %s", async (role, shown) => {
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    const overview = await service.overview(ids[role], orgId);
    if (overview.kind !== "ACTIVE") throw new Error("expected an active plan");
    expect(overview.billing).toEqual(shown ? { channel: "SALES_ASSISTED", monthlyPriceYenExTax: 49_800 } : null);
  });

  it.each([
    ["OWNER", true],
    ["BILLING", true],
    ["ADMIN", false],
    ["MANAGER", false],
    ["CREATOR", false],
  ] as const)("tells a %s whether it may buy Units: %s", async (role, may) => {
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids[role], orgId)).toMatchObject({ kind: "ACTIVE", mayBuyUnits: may });
  });

  it("lets an ADMIN buy Units once an OWNER grants it billing.manage", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.ADMIN, "billing.manage");
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids.ADMIN, orgId)).toMatchObject({ kind: "ACTIVE", mayBuyUnits: true });
  });

  it("shows how the plan is paid to a MANAGER granted billing.view", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "billing.view");
    subscribe({ planKey: "premium" });
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    const overview = await service.overview(ids.MANAGER, orgId);
    if (overview.kind !== "ACTIVE") throw new Error("expected an active plan");
    expect(overview.billing).toEqual({ channel: "SALES_ASSISTED", monthlyPriceYenExTax: 119_800 });
  });
});

describe("without a period in the ledger", () => {
  it("says there is no plan when there is no subscription", async () => {
    expect(await service.overview(ids.OWNER, orgId)).toEqual({ kind: "NO_PLAN" });
  });

  it("says when the plan starts, before its first period", async () => {
    subscribe({ planKey: "premium" });
    deps.clock.set(iso("2026-03-14T23:59:59.999Z"));
    expect(await service.overview(ids.OWNER, orgId)).toEqual({
      kind: "NOT_STARTED",
      planKey: "premium",
      startsAt: iso("2026-03-15T00:00:00.000Z"),
      billing: { channel: "SALES_ASSISTED", monthlyPriceYenExTax: 119_800 },
    });
    expect((await service.overview(ids.MANAGER, orgId)).kind).toBe("NOT_STARTED");
    expect(await service.overview(ids.MANAGER, orgId)).toMatchObject({ billing: null });
  });

  it("shows the current period as it would open: the whole allowance, no block", async () => {
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids.MANAGER, orgId)).toEqual({
      kind: "ACTIVE",
      planKey: "standard",
      period: { startsAt: iso("2026-04-15T00:00:00.000Z"), endsAt: iso("2026-05-15T00:00:00.000Z") },
      baseUnits: { included: 15, remaining: 15 },
      highQuality: { includedCeiling: 1, ceilingRemaining: 1, fundableFromBase: 1 },
      highQualityAddOnAvailable: false,
      addOnBlocks: [],
      normalAddOnRemaining: 0,
      highQualityAddOnRemaining: 0,
      billing: null,
      purchases: null,
      mayBuyUnits: false,
    });
  });

  it("starts the first period at the anchor itself", async () => {
    subscribe({ planKey: "enterprise" });
    deps.clock.set(iso("2026-03-15T00:00:00.000Z"));
    expect(await service.overview(ids.OWNER, orgId)).toMatchObject({
      kind: "ACTIVE",
      period: { startsAt: iso("2026-03-15T00:00:00.000Z"), endsAt: iso("2026-04-15T00:00:00.000Z") },
      baseUnits: { included: 100, remaining: 100 },
      highQuality: { includedCeiling: 10, ceilingRemaining: 10, fundableFromBase: 10 },
      highQualityAddOnAvailable: true,
    });
  });
});

describe("with a period in the ledger", () => {
  it("shows what the ledger says is left, blocks oldest first, a withdrawn one marked", async () => {
    subscribe({ planKey: "premium" });
    premiumPeriod();
    const at = (instant: string) => iso(instant).getTime();
    reader.balances.set("uep_premium", {
      baseRemainingUnits: 12,
      includedHighQualityRemainingUnits: 2,
      blocks: [
        { id: "b2", quality: "NORMAL", remainingUnits: 4, purchasedAtEpochMs: at("2026-04-18T00:00:00.000Z"), withdrawn: false },
        { id: "b1", quality: "HIGH_QUALITY", remainingUnits: 2, purchasedAtEpochMs: at("2026-04-16T00:00:00.000Z"), withdrawn: false },
        { id: "w1", quality: "NORMAL", remainingUnits: 0, purchasedAtEpochMs: at("2026-04-17T00:00:00.000Z"), withdrawn: true },
        { id: "a3", quality: "NORMAL", remainingUnits: 10, purchasedAtEpochMs: at("2026-04-18T00:00:00.000Z"), withdrawn: false },
      ],
    });
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids.BILLING, orgId)).toEqual({
      kind: "ACTIVE",
      planKey: "premium",
      period: { startsAt: iso("2026-04-15T00:00:00.000Z"), endsAt: iso("2026-05-15T00:00:00.000Z") },
      baseUnits: { included: 40, remaining: 12 },
      highQuality: { includedCeiling: 5, ceilingRemaining: 2, fundableFromBase: 2 },
      highQualityAddOnAvailable: true,
      addOnBlocks: [
        { quality: "HIGH_QUALITY", remainingUnits: 2, purchasedAt: iso("2026-04-16T00:00:00.000Z"), withdrawn: false },
        { quality: "NORMAL", remainingUnits: 0, purchasedAt: iso("2026-04-17T00:00:00.000Z"), withdrawn: true },
        { quality: "NORMAL", remainingUnits: 10, purchasedAt: iso("2026-04-18T00:00:00.000Z"), withdrawn: false },
        { quality: "NORMAL", remainingUnits: 4, purchasedAt: iso("2026-04-18T00:00:00.000Z"), withdrawn: false },
      ],
      normalAddOnRemaining: 14,
      highQualityAddOnRemaining: 2,
      billing: { channel: "SALES_ASSISTED", monthlyPriceYenExTax: 119_800 },
      purchases: [],
      mayBuyUnits: true,
    });
  });

  it.each([
    ["OWNER", true],
    ["BILLING", true],
    ["ADMIN", false],
    ["MANAGER", false],
  ] as const)("tells a %s on an open period whether it may buy Units: %s", async (role, may) => {
    subscribe({ planKey: "premium" });
    premiumPeriod();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids[role], orgId)).toMatchObject({ kind: "ACTIVE", mayBuyUnits: may });
  });

  it.each([
    [0, 3, 0],
    [7, 0, 0],
    [3, 5, 3],
    [5, 3, 3],
  ])("lets %i Base Units with %i of the HQ ceiling left fund %i HQ", async (base, ceiling, fundable) => {
    premiumPeriod();
    reader.balances.set("uep_premium", {
      baseRemainingUnits: base,
      includedHighQualityRemainingUnits: ceiling,
      blocks: [],
    });
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids.OWNER, orgId)).toMatchObject({
      highQuality: { includedCeiling: 5, ceilingRemaining: ceiling, fundableFromBase: fundable },
    });
  });

  it("shows a period opened without a subscription, with no billing facts", async () => {
    premiumPeriod();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    expect(await service.overview(ids.OWNER, orgId)).toMatchObject({
      kind: "ACTIVE",
      planKey: "premium",
      baseUnits: { included: 40, remaining: 40 },
      billing: null,
    });
  });

  it("uses only the period containing now, its end excluded", async () => {
    subscribe({ planKey: "premium" });
    premiumPeriod();
    deps.clock.set(iso("2026-05-15T00:00:00.000Z"));
    // The ledger's period has ended, so the next one is shown as it would open.
    expect(await service.overview(ids.OWNER, orgId)).toMatchObject({
      kind: "ACTIVE",
      period: { startsAt: iso("2026-05-15T00:00:00.000Z"), endsAt: iso("2026-06-15T00:00:00.000Z") },
    });
  });

  it("is an internal error when the period's balance cannot be read", async () => {
    premiumPeriod();
    vi.spyOn(reader, "balance").mockResolvedValueOnce(null);
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    await expect(service.overview(ids.OWNER, orgId)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("asks for the balance of this organization's period only", async () => {
    premiumPeriod();
    const balance = vi.spyOn(reader, "balance");
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    await service.overview(ids.OWNER, orgId);
    expect(balance).toHaveBeenCalledWith(orgId, "uep_premium");
  });
});

describe("the period's purchases", () => {
  beforeEach(() => {
    subscribe({ planKey: "premium" });
    premiumPeriod();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
  });

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["BILLING", true],
    ["MANAGER", false],
    ["CREATOR", false],
  ] as const)("shows a %s the period's purchases: %s", async (role, shown) => {
    bought({ id: "p1", approvedAt: iso("2026-04-16T01:00:00.000Z") });
    const expected = [listed("NORMAL", 10, 35_900, "2026-04-16T01:00:00.000Z", "billing")];
    const overview = await service.overview(ids[role], orgId);
    expect(overview).toMatchObject({ kind: "ACTIVE", purchases: shown ? expected : null });
  });

  it("shows them to a MANAGER granted billing.view", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.MANAGER, "billing.view");
    bought({ id: "p1", approvedAt: iso("2026-04-16T01:00:00.000Z") });
    expect(await service.overview(ids.MANAGER, orgId)).toMatchObject({ purchases: [{ approvedBy: "billing" }] });
  });

  it("does not read them for a viewer without billing.view", async () => {
    const list = vi.spyOn(reader, "listForPeriod");
    await service.overview(ids.MANAGER, orgId);
    expect(list).not.toHaveBeenCalled();
  });

  it("lists this period's, oldest first, each approver named and a former member not", async () => {
    bought({ id: "p3", approvedAt: iso("2026-04-19T00:00:00.000Z"), approvedByUserId: ids.OWNER });
    const hq = { quality: "HIGH_QUALITY", units: 2, priceYenExTax: 9_000 } as const;
    bought({ id: "p1", approvedAt: iso("2026-04-16T00:00:00.000Z"), ...hq });
    // Not a member now, as one who has left.
    bought({ id: "p2", approvedAt: iso("2026-04-18T00:00:00.000Z"), approvedByUserId: ids.outsider });
    bought({ id: "p4", approvedAt: iso("2026-04-17T00:00:00.000Z") });
    bought({ id: "old", approvedAt: iso("2026-03-20T00:00:00.000Z"), entitlementPeriodId: "uep_earlier" });
    bought({ id: "other", approvedAt: iso("2026-04-16T00:00:00.000Z"), organizationId: "org_other" });
    const findUser = vi.spyOn(deps.repos.users, "findById");
    const overview = await service.overview(ids.OWNER, orgId);
    if (overview.kind !== "ACTIVE") throw new Error("expected an active plan");
    expect(overview.purchases).toEqual([
      listed("HIGH_QUALITY", 2, 9_000, "2026-04-16T00:00:00.000Z", "billing"),
      listed("NORMAL", 10, 35_900, "2026-04-17T00:00:00.000Z", "billing"),
      listed("NORMAL", 10, 35_900, "2026-04-18T00:00:00.000Z", null),
      listed("NORMAL", 10, 35_900, "2026-04-19T00:00:00.000Z", "owner"),
    ]);
    // Once per approver still a member; never for one who has left.
    expect(findUser.mock.calls.map(([id]) => id).sort()).toEqual([ids.BILLING, ids.OWNER].sort());
  });

  it("says which were cancelled, and when", async () => {
    const cancelledAt = iso("2026-04-17T02:00:00.000Z");
    bought({ id: "p1", approvedAt: iso("2026-04-16T00:00:00.000Z"), cancelledAt });
    bought({ id: "p2", approvedAt: iso("2026-04-16T01:00:00.000Z") });
    expect(await service.overview(ids.BILLING, orgId)).toMatchObject({
      purchases: [
        listed("NORMAL", 10, 35_900, "2026-04-16T00:00:00.000Z", "billing", cancelledAt),
        listed("NORMAL", 10, 35_900, "2026-04-16T01:00:00.000Z", "billing", null),
      ],
    });
  });

  it("asks for this organization's current period only", async () => {
    const list = vi.spyOn(reader, "listForPeriod");
    await service.overview(ids.OWNER, orgId);
    expect(list).toHaveBeenCalledWith(orgId, "uep_premium");
  });

  it("lists none for a period nobody has opened, to a holder of billing.view only", async () => {
    reader.periods.length = 0;
    const list = vi.spyOn(reader, "listForPeriod");
    expect(await service.overview(ids.OWNER, orgId)).toMatchObject({ kind: "ACTIVE", purchases: [] });
    expect(await service.overview(ids.MANAGER, orgId)).toMatchObject({ kind: "ACTIVE", purchases: null });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("reading writes nothing", () => {
  it("audits nothing and changes no subscription or period", async () => {
    subscribe();
    deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
    const before = deps.repos.auditLogs.all().length;
    await service.overview(ids.OWNER, orgId);
    await service.overview(ids.MANAGER, orgId);
    expect(deps.repos.auditLogs.all()).toHaveLength(before);
    expect(reader.periods).toEqual([]);
    expect([...reader.subscriptions.keys()]).toEqual([orgId]);
  });
});
