import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { PermissionGrantService } from "../identity/permission-grant-service";
import type { Role } from "../identity/roles";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryUnitPurchases } from "../testing/in-memory-unit-purchases";
import { InMemoryUnitsReader } from "../testing/in-memory-units";
import type { OrganizationSubscription } from "./subscription";
import {
  addOnPackageOffer,
  isReplayOf,
  unitPurchaseRefusal,
  UnitPurchaseService,
  type ApproveUnitPurchaseInput,
  type UnitPurchase,
} from "./unit-purchase";

/**
 * Buying an additional Unit package (UP-2, ADR-0067): one package per approval,
 * by a holder of `billing.manage`, at the price and expiry the confirmation step
 * showed, re-checked when it is written, bought once however often it is sent.
 * Every price and instant is written out literally.
 */

const iso = (value: string) => new Date(value);

/** Renewal period 1 of a subscription anchored on 15 March: 15 April to 15 May. */
const NOW = iso("2026-04-20T09:00:00.000Z");
const PERIOD_END = iso("2026-05-15T00:00:00.000Z");

let deps: TestDeps;
let reader: InMemoryUnitsReader;
let store: InMemoryUnitPurchases;
let service: UnitPurchaseService;
let orgId: string;
let ids: Record<Role | "outsider", string>;

beforeEach(async () => {
  deps = createTestDeps();
  reader = new InMemoryUnitsReader();
  store = new InMemoryUnitPurchases(reader, deps);
  service = new UnitPurchaseService({ identity: deps, subscriptions: reader, ledger: store, purchases: store });
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
  deps.clock.set(NOW);
});

function subscribe(overrides: Partial<OrganizationSubscription> = {}): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey: "premium",
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-03-15T00:00:00.000Z"),
    commercialReference: "VT-2026-001",
    createdAt: iso("2026-03-01T00:00:00.000Z"),
    ...overrides,
  });
}

function request(overrides: Partial<ApproveUnitPurchaseInput> = {}): ApproveUnitPurchaseInput {
  return {
    organizationId: orgId,
    quality: "NORMAL",
    expected: { units: 10, priceYenExTax: 35_900, periodEndsAt: PERIOD_END },
    idempotencyKey: "key-1",
    ...overrides,
  };
}

const refusals = () => deps.repos.auditLogs.all().filter((entry) => entry.action === "unit_purchase.refused");

describe("the packages a plan sells", () => {
  it.each([
    ["standard", "NORMAL", { units: 5, priceYenExTax: 19_900 }],
    ["standard", "HIGH_QUALITY", null],
    ["premium", "NORMAL", { units: 10, priceYenExTax: 35_900 }],
    ["premium", "HIGH_QUALITY", { units: 2, priceYenExTax: 9_000 }],
    ["enterprise", "NORMAL", { units: 25, priceYenExTax: 89_400 }],
    ["enterprise", "HIGH_QUALITY", { units: 5, priceYenExTax: 22_400 }],
  ] as const)("%s %s", (plan, quality, offer) => {
    expect(addOnPackageOffer(plan, quality)).toEqual(offer === null ? null : { quality, ...offer });
  });
});

describe("who may buy", () => {
  beforeEach(() => subscribe());

  it("refuses a non-member before reading anything, unaudited", async () => {
    const find = vi.spyOn(store, "findByIdempotencyKey");
    await expect(service.approve(ids.outsider, request())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have access to this organization",
    });
    expect(find).not.toHaveBeenCalled();
    expect(deps.repos.auditLogs.all().filter((entry) => entry.action.startsWith("unit_purchase."))).toEqual([]);
  });

  it.each(["ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const)("refuses %s, audited", async (role) => {
    const find = vi.spyOn(store, "findByIdempotencyKey");
    await expect(service.approve(ids[role], request())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: `Role ${role} may not buy Units here`,
    });
    expect(find).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        actorUserId: ids[role],
        resourceType: "organization",
        resourceId: orgId,
        metadata: {
          reason: "LACKS_BILLING_MANAGE",
          actorRole: role,
          quality: "NORMAL",
          expectedUnits: 10,
          expectedPriceYenExTax: 35_900,
          expectedPeriodEndsAt: "2026-05-15T00:00:00.000Z",
        },
      }),
    ]);
    expect(store.purchases).toEqual([]);
  });

  it.each(["OWNER", "BILLING"] as const)("lets %s buy", async (role) => {
    expect((await service.approve(ids[role], request())).kind).toBe("APPROVED");
  });

  it("lets an ADMIN buy once an OWNER grants it billing.manage", async () => {
    await new PermissionGrantService(deps).grant(ids.OWNER, orgId, ids.ADMIN, "billing.manage");
    expect((await service.approve(ids.ADMIN, request())).kind).toBe("APPROVED");
  });
});

describe("what a purchase buys", () => {
  it("buys the package into the current period, opening it, at the approved price", async () => {
    subscribe();
    const outcome = await service.approve(ids.BILLING, request());
    expect(outcome).toEqual({
      kind: "APPROVED",
      purchase: {
        id: "upur_1",
        organizationId: orgId,
        entitlementPeriodId: `uep_sub_${orgId}_1`,
        addOnBlockId: "uab_1",
        quality: "NORMAL",
        units: 10,
        priceYenExTax: 35_900,
        channel: "SALES_ASSISTED",
        contractReference: "VT-2026-001",
        expiresAt: PERIOD_END,
        idempotencyKey: "key-1",
        approvedByUserId: ids.BILLING,
        approvedAt: NOW,
      },
    });
    expect(reader.periods.map((p) => [p.id, p.startsAt, p.endsAt, p.planKey])).toEqual([
      [`uep_sub_${orgId}_1`, iso("2026-04-15T00:00:00.000Z"), PERIOD_END, "premium"],
    ]);
    expect(store.blocks).toEqual([
      expect.objectContaining({ id: "uab_1", quality: "NORMAL", quantity: 10, purchasedAt: NOW }),
    ]);
    expect(refusals()).toEqual([]);
  });

  it("buys HQ only as an HQ package", async () => {
    subscribe();
    const outcome = await service.approve(
      ids.OWNER,
      request({ quality: "HIGH_QUALITY", expected: { units: 2, priceYenExTax: 9_000, periodEndsAt: PERIOD_END } }),
    );
    if (outcome.kind !== "APPROVED") throw new Error("expected a purchase");
    expect([outcome.purchase.quality, outcome.purchase.units, outcome.purchase.priceYenExTax]).toEqual([
      "HIGH_QUALITY",
      2,
      9_000,
    ]);
  });

  it("adds a second purchase to the period already open, under a key of its own", async () => {
    subscribe();
    await service.approve(ids.BILLING, request());
    await service.approve(ids.BILLING, request({ idempotencyKey: "key-2" }));
    expect(reader.periods).toHaveLength(1);
    expect(store.purchases.map((p) => [p.id, p.entitlementPeriodId])).toEqual([
      ["upur_1", `uep_sub_${orgId}_1`],
      ["upur_2", `uep_sub_${orgId}_1`],
    ]);
  });

  it("buys for a Standard plan's Normal package", async () => {
    subscribe({ planKey: "standard" });
    const outcome = await service.approve(
      ids.BILLING,
      request({ expected: { units: 5, priceYenExTax: 19_900, periodEndsAt: PERIOD_END } }),
    );
    expect(outcome.kind).toBe("APPROVED");
  });
});

describe("what is refused, audited, with nothing bought", () => {
  async function refused(input: ApproveUnitPurchaseInput, reason: string) {
    expect(await service.approve(ids.BILLING, input)).toEqual({ kind: "REFUSED", reason });
    expect(refusals().map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ reason, actorRole: "BILLING" }),
    ]);
    expect(store.purchases).toEqual([]);
    expect(store.blocks).toEqual([]);
  }

  it("refuses an organization with no plan, opening nothing", async () => {
    await refused(request(), "NO_PLAN");
    expect(reader.periods).toEqual([]);
  });

  it("refuses before the plan starts", async () => {
    subscribe({ anchorAt: iso("2026-04-20T09:00:00.001Z") });
    await refused(request(), "NOT_STARTED");
    expect(reader.periods).toEqual([]);
  });

  it("sends an Enterprise purchase through sales", async () => {
    subscribe({ planKey: "enterprise" });
    const shown = { units: 25, priceYenExTax: 89_400, periodEndsAt: PERIOD_END };
    await refused(request({ expected: shown }), "THROUGH_SALES");
    expect(reader.periods).toEqual([]);
  });

  it("refuses a card-paid plan, since card payment is not built", async () => {
    subscribe({ channel: "SELF_SERVICE" });
    await refused(request(), "CARD_PAYMENT_NOT_AVAILABLE");
  });

  it("never sells HQ on Standard", async () => {
    subscribe({ planKey: "standard" });
    await refused(
      request({ quality: "HIGH_QUALITY", expected: { units: 2, priceYenExTax: 9_000, periodEndsAt: PERIOD_END } }),
      "NOT_OFFERED",
    );
  });

  it.each([
    ["Units", { units: 9, priceYenExTax: 35_900 }],
    ["price", { units: 10, priceYenExTax: 35_800 }],
  ])("refuses when the %s shown differ", async (_what, shown) => {
    subscribe();
    await refused(request({ expected: { ...shown, periodEndsAt: PERIOD_END } }), "OFFER_CHANGED");
    expect(reader.periods).toEqual([]);
  });

  it("refuses when the period shown is not the current one", async () => {
    subscribe();
    const lastPeriodEnd = iso("2026-04-15T00:00:00.000Z");
    const shown = { units: 10, priceYenExTax: 35_900, periodEndsAt: lastPeriodEnd };
    await refused(request({ expected: shown }), "PERIOD_CHANGED");
    expect(refusals()[0]?.metadata).toMatchObject({ expectedPeriodEndsAt: "2026-04-15T00:00:00.000Z" });
  });
});

describe("one purchase however often it is sent", () => {
  beforeEach(() => subscribe());

  it("answers a replay with the purchase it made, writing nothing", async () => {
    const first = await service.approve(ids.BILLING, request());
    if (first.kind !== "APPROVED") throw new Error("expected a purchase");
    const before = deps.repos.auditLogs.all().length;
    const replayed = await service.approve(ids.BILLING, request());
    expect(replayed).toEqual({ kind: "ALREADY_APPROVED", purchase: first.purchase });
    expect(store.purchases).toHaveLength(1);
    expect(store.blocks).toHaveLength(1);
    expect(deps.repos.auditLogs.all()).toHaveLength(before);
  });

  it("still answers the replay after the period has ended", async () => {
    await service.approve(ids.BILLING, request());
    deps.clock.set(iso("2026-05-20T00:00:00.000Z"));
    expect((await service.approve(ids.BILLING, request())).kind).toBe("ALREADY_APPROVED");
    expect(reader.periods).toHaveLength(1);
  });

  it.each([
    ["another quality", { quality: "HIGH_QUALITY" as const }],
    ["another price", { expected: { units: 10, priceYenExTax: 36_000, periodEndsAt: PERIOD_END } }],
  ])("refuses the key reused for %s", async (_what, overrides) => {
    await service.approve(ids.BILLING, request());
    expect(await service.approve(ids.BILLING, request(overrides))).toEqual({
      kind: "REFUSED",
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(store.purchases).toHaveLength(1);
    expect(refusals().map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ reason: "IDEMPOTENCY_KEY_REUSED" }),
    ]);
  });

  it("refuses the key reused by another approver", async () => {
    await service.approve(ids.BILLING, request());
    expect(await service.approve(ids.OWNER, request())).toEqual({ kind: "REFUSED", reason: "IDEMPOTENCY_KEY_REUSED" });
  });
});

describe("re-checked when written", () => {
  beforeEach(() => subscribe());

  it("refuses an approver who lost billing.manage before the write, audited", async () => {
    const approve = store.approve.bind(store);
    vi.spyOn(store, "approve").mockImplementation(async (record, check) => {
      await deps.repos.memberships.remove(orgId, ids.BILLING, "BILLING", () => ({
        organizationId: orgId,
        actorUserId: ids.OWNER,
        action: "member.removed",
        resourceType: "membership",
        resourceId: `${orgId}:${ids.BILLING}`,
        metadata: {},
      }));
      return approve(record, check);
    });
    await expect(service.approve(ids.BILLING, request())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(refusals().map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ reason: "LACKS_BILLING_MANAGE", actorRole: "BILLING" }),
    ]);
    expect(store.purchases).toEqual([]);
  });

  it("answers a key another approval wrote first as that approval's replay", async () => {
    const other: UnitPurchase = {
      id: "upur_other",
      organizationId: orgId,
      entitlementPeriodId: `uep_sub_${orgId}_1`,
      addOnBlockId: "uab_other",
      quality: "NORMAL",
      units: 10,
      priceYenExTax: 35_900,
      channel: "SALES_ASSISTED",
      contractReference: "VT-2026-001",
      expiresAt: PERIOD_END,
      idempotencyKey: "key-1",
      approvedByUserId: ids.BILLING,
      approvedAt: NOW,
    };
    vi.spyOn(store, "approve").mockResolvedValue({ kind: "EXISTING", purchase: other });
    expect(await service.approve(ids.BILLING, request())).toEqual({ kind: "ALREADY_APPROVED", purchase: other });
    vi.spyOn(store, "approve").mockResolvedValue({ kind: "EXISTING", purchase: { ...other, quality: "HIGH_QUALITY" } });
    const reused = await service.approve(ids.BILLING, request());
    expect(reused).toEqual({ kind: "REFUSED", reason: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("passes the write a check of the facts read there, not the ones read before", async () => {
    let checked: unknown = "not called";
    vi.spyOn(store, "approve").mockImplementation(async (_record, check) => {
      checked = check({
        subscription: reader.subscriptions.get(orgId) ?? null,
        period: { planKey: "premium", endsAt: iso("2026-06-15T00:00:00.000Z") },
        approverPermissions: ["billing.manage"],
      });
      return { kind: "REFUSED", reason: "PERIOD_CHANGED" };
    });
    expect(await service.approve(ids.BILLING, request())).toEqual({ kind: "REFUSED", reason: "PERIOD_CHANGED" });
    expect(checked).toBe("PERIOD_CHANGED");
  });

  it("buys nothing when the period it opened cannot be found again", async () => {
    vi.spyOn(store, "approve").mockResolvedValue({ kind: "PERIOD_NOT_FOUND" });
    await expect(service.approve(ids.BILLING, request())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The current Unit period could not be read",
    });
  });

  it("buys nothing when the current period collides with one opened by hand", async () => {
    reader.periods.push({
      id: "uep_by_hand",
      organizationId: orgId,
      billingCycleKey: "by-hand",
      planKey: "premium",
      baseUnits: 40,
      includedHighQualityUnits: 5,
      highQualityAddOnAvailable: true,
      startsAt: iso("2026-04-01T00:00:00.000Z"),
      endsAt: iso("2026-05-01T00:00:00.000Z"),
      commercialReference: "by hand",
      createdAt: iso("2026-04-01T00:00:00.000Z"),
    });
    await expect(service.approve(ids.BILLING, request())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The current Unit period could not be opened",
    });
    expect(store.purchases).toEqual([]);
  });
});

describe("an unusable request", () => {
  beforeEach(() => subscribe());

  it.each([
    ["an empty key", { idempotencyKey: "" }],
    ["a key of 201 characters", { idempotencyKey: "k".repeat(201) }],
    ["fractional Units", { expected: { units: 1.5, priceYenExTax: 35_900, periodEndsAt: PERIOD_END } }],
    ["a fractional price", { expected: { units: 10, priceYenExTax: 0.5, periodEndsAt: PERIOD_END } }],
    ["an invalid expiry", { expected: { units: 10, priceYenExTax: 35_900, periodEndsAt: new Date(Number.NaN) } }],
  ])("refuses %s before anything else, unaudited", async (_what, overrides) => {
    await expect(service.approve(ids.outsider, request(overrides))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The purchase request is not usable",
    });
    expect(deps.repos.auditLogs.all().filter((entry) => entry.action.startsWith("unit_purchase."))).toEqual([]);
  });

  it("accepts a key of 200 characters", async () => {
    expect((await service.approve(ids.BILLING, request({ idempotencyKey: "k".repeat(200) }))).kind).toBe("APPROVED");
  });
});

describe("the check", () => {
  const subscription: OrganizationSubscription = {
    id: "sub_x",
    organizationId: "org_x",
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-03-15T00:00:00.000Z"),
    commercialReference: "C-1",
    createdAt: iso("2026-03-01T00:00:00.000Z"),
  };
  const hq = {
    quality: "HIGH_QUALITY" as const,
    expected: { units: 2, priceYenExTax: 9_000, periodEndsAt: PERIOD_END },
  };

  it("prices the package from the plan frozen on the period it joins", () => {
    const facts = { subscription, approverPermissions: ["billing.manage" as const] };
    expect(unitPurchaseRefusal(hq, { ...facts, period: null }, NOW)).toBe("NOT_OFFERED");
    expect(unitPurchaseRefusal(hq, { ...facts, period: { planKey: "premium", endsAt: PERIOD_END } }, NOW)).toBeNull();
    expect(unitPurchaseRefusal(hq, { ...facts, period: { planKey: "enterprise", endsAt: PERIOD_END } }, NOW)).toBe(
      "THROUGH_SALES",
    );
  });

  it("starts the plan at its anchor, inclusive", () => {
    const facts = { subscription, period: null, approverPermissions: ["billing.manage" as const] };
    const normal = {
      quality: "NORMAL" as const,
      expected: { units: 5, priceYenExTax: 19_900, periodEndsAt: PERIOD_END },
    };
    expect(unitPurchaseRefusal(normal, facts, subscription.anchorAt)).toBeNull();
    expect(unitPurchaseRefusal(normal, facts, iso("2026-03-14T23:59:59.999Z"))).toBe("NOT_STARTED");
  });

  it("refuses an approver who is no longer a member", () => {
    expect(unitPurchaseRefusal(hq, { subscription, period: null, approverPermissions: null }, NOW)).toBe(
      "LACKS_BILLING_MANAGE",
    );
  });
});

describe("what counts as a replay", () => {
  const purchase: UnitPurchase = {
    id: "upur_1",
    organizationId: "org_x",
    entitlementPeriodId: "uep_1",
    addOnBlockId: "uab_1",
    quality: "NORMAL",
    units: 10,
    priceYenExTax: 35_900,
    channel: "SALES_ASSISTED",
    contractReference: "C-1",
    expiresAt: PERIOD_END,
    idempotencyKey: "key-1",
    approvedByUserId: "usr_1",
    approvedAt: NOW,
  };
  const input: ApproveUnitPurchaseInput = {
    organizationId: "org_x",
    quality: "NORMAL",
    expected: { units: 10, priceYenExTax: 35_900, periodEndsAt: PERIOD_END },
    idempotencyKey: "key-1",
  };

  it("is the same approver, quality, Units, price and expiry", () => {
    expect(isReplayOf(purchase, input, "usr_1")).toBe(true);
    expect(isReplayOf(purchase, input, "usr_2")).toBe(false);
    expect(isReplayOf(purchase, { ...input, quality: "HIGH_QUALITY" }, "usr_1")).toBe(false);
    expect(isReplayOf(purchase, { ...input, expected: { ...input.expected, units: 11 } }, "usr_1")).toBe(false);
    expect(isReplayOf(purchase, { ...input, expected: { ...input.expected, priceYenExTax: 1 } }, "usr_1")).toBe(false);
    expect(isReplayOf(purchase, { ...input, expected: { ...input.expected, periodEndsAt: NOW } }, "usr_1")).toBe(false);
  });
});
