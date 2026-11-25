import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AuthService, OrganizationService, UnitPurchaseService, type Role } from "@app/domain";
import {
  InMemoryRateLimitStore,
  InMemoryUnitPurchases,
  InMemoryUnitsReader,
  createTestDeps,
  markEmailVerified,
  type TestDeps,
} from "@app/domain/testing";
import { AppError, RATE_LIMIT_DEFAULTS, type RateLimitSetting } from "@app/shared";
import { pathOf } from "./redirect-location";

/**
 * The purchase approval limit per account (ADR-0173): the route over the
 * in-memory purchase service, with the limit running for real on an in-memory
 * store made afresh for each test. What the screen and the service decide
 * otherwise is proved in `buy-page.test.tsx` and the service's own suites.
 */
const SITE = "https://app.vtavision.test";
const PASSWORD = "password-123456";
const REFUSED = "Too many purchase approvals. Nothing new was bought. Try again in 60 minutes.";
const NOT_CONFIRMED = "The purchase could not be confirmed. Check the Units page before trying again.";
const NOT_USABLE = "The purchase request could not be read. Nothing was bought. Review the purchase again.";
const FORBIDDEN = "You cannot buy Units for this organization. Nothing was bought.";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const held = vi.hoisted(() => ({ deps: null as unknown, service: null as unknown }));
const reported = vi.hoisted(() => ({ errors: [] as [string, unknown][] }));
const limits = vi.hoisted(() => ({ value: null as unknown, broken: null as Error | null }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve(currentUser.value) }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => ({ deps: held.deps }) }));
vi.mock("@/lib/unit-purchases", async (actual) => ({
  ...(await actual<typeof import("@/lib/unit-purchases")>()),
  getUnitPurchaseService: () => held.service,
  getUnitPurchaseLogger: () => ({
    error: (message: string, fields?: unknown) => void reported.errors.push([message, fields]),
  }),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  getRateLimiter: () => {
    if (limits.broken) throw limits.broken;
    return limits.value;
  },
}));
const { WebRateLimits } = await import("@/lib/rate-limit");
let warned: [string, unknown][];
const limitsOf = (settings: Partial<Record<RateLimitSetting, string>>, store = new InMemoryRateLimitStore()) =>
  new WebRateLimits(store, { ...RATE_LIMIT_DEFAULTS, ...settings, SESSION_SECRET: "x".repeat(32) }, {
    warn: (message: string, fields?: unknown) => void warned.push([message, fields]),
  });

const { POST } = await import("@/app/api/organizations/[organizationId]/unit-purchases/route");

let deps: TestDeps;
let auth: AuthService;
let store: InMemoryUnitPurchases;
let approvals: MockInstance;
let orgId: string;
let reader: InMemoryUnitsReader;
let ownerId: string;
let keys = 0;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(new Date("2026-04-20T12:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  reader = new InMemoryUnitsReader();
  store = new InMemoryUnitPurchases(reader, deps);
  const service = new UnitPurchaseService({ identity: deps, subscriptions: reader, ledger: store, purchases: store });
  approvals = vi.spyOn(service, "approve");
  held.deps = deps;
  held.service = service;
  reported.errors = [];
  warned = [];
  limits.value = limitsOf({});
  limits.broken = null;
  ownerId = await account();
  const created = await new OrganizationService(deps).createOrganization(ownerId, { name: "Kanda" });
  orgId = created.organization.id;
  subscribe(orgId);
  currentUser.value = { user: { id: ownerId } };
});

/** Premium, sold by the sales team, for the organization `id`. */
function subscribe(id: string): void {
  reader.subscriptions.set(id, {
    id: `sub_${id}`,
    organizationId: id,
    planKey: "premium",
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2026-03-15T00:00:00.000Z"),
    commercialReference: "VT-2026-001",
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
  });
}

/** A new verified account, a member holding `role` when one is given, and signed in; its id. */
async function account(role?: Role): Promise<string> {
  const email = `${deps.ids.generate("u")}@example.com`;
  const userId = (await auth.register({ email, name: "Member", password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  if (role !== undefined) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  currentUser.value = { user: { id: userId } };
  return userId;
}

/** Premium's Normal package as the confirmation step shows it, under a new key each time. */
function fields(): Record<string, string> {
  keys += 1;
  const periodEndsAt = "2026-05-15T00:00:00.000Z";
  return { quality: "NORMAL", units: "10", priceYenExTax: "35900", periodEndsAt, idempotencyKey: `key-${keys}` };
}

function approve(sent = fields(), headers: Record<string, string> = { origin: SITE }, type = "x-www-form-urlencoded") {
  const request = new Request(`${SITE}/api/organizations/${orgId}/unit-purchases`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": `application/${type}`, ...headers },
    body: type === "json" ? JSON.stringify(sent) : new URLSearchParams(sent).toString(),
  });
  return POST(request, { params: Promise.resolve({ organizationId: orgId }) });
}

/** Where a 303 sends the customer, with every query field it carries. */
function landing(response: Response): { path: string; query: [string, string][] } {
  expect(response.status).toBe(303);
  const url = pathOf(response);
  return { path: url.pathname, query: [...url.searchParams] };
}

const buyPage = () => `/organizations/${orgId}/units/buy`;
const refusedWith = (error: string) => ({ path: buyPage(), query: [["error", error]] });
const bought = () => ({ path: `/organizations/${orgId}/units`, query: [["purchased", "1"]] });
const audits = () => deps.repos.auditLogs.all().filter((entry) => entry.action.startsWith("unit_purchase."));
const limitedTo = (count: number) => (limits.value = limitsOf({ RATE_LIMIT_UNIT_PURCHASE: `${count}/3600` }));

describe("the purchase approval limit per account (ADR-0173)", () => {
  it("refuses past the limit back to the buy page with its wait, buying, auditing and asking nothing", async () => {
    limitedTo(2);
    expect(landing(await approve())).toEqual(bought());
    // An approval the service refuses is counted too.
    const stale = { ...fields(), priceYenExTax: "30000" };
    expect(landing(await approve(stale)).query[0]?.[1]).toMatch(/^The package or its price changed/);
    const audited = audits().length;

    const refused = await approve();
    expect(landing(refused)).toEqual(refusedWith(REFUSED));
    // A redirect back to a page: no Retry-After rides on it.
    expect(refused.headers.get("retry-after")).toBeNull();
    expect(approvals).toHaveBeenCalledTimes(2);
    expect(store.purchases).toHaveLength(1);
    expect(audits()).toHaveLength(audited);
    expect(reported.errors).toEqual([]);
    // Logged by its codes alone.
    expect(warned).toEqual([
      ["An attempt was refused by a rate limit", { code: "RATE_LIMITED", action: "UNIT_PURCHASE", dimension: "user" }],
    ]);
  });

  it("rounds a wait that is not whole minutes up, never down", async () => {
    limits.value = limitsOf({ RATE_LIMIT_UNIT_PURCHASE: "1/90" });
    expect(landing(await approve())).toEqual(bought());
    expect(landing(await approve())).toEqual(
      refusedWith("Too many purchase approvals. Nothing new was bought. Try again in 2 minutes."),
    );
  });

  it("keeps a count per account: another member of the organization is not held", async () => {
    limitedTo(1);
    expect(landing(await approve())).toEqual(bought());
    expect(landing(await approve())).toEqual(refusedWith(REFUSED));
    const billing = await account("BILLING");
    expect(landing(await approve())).toEqual(bought());
    expect(store.purchases.map((purchase) => purchase.approvedByUserId)).toEqual([ownerId, billing]);
  });

  it("follows the account into another organization it owns", async () => {
    limitedTo(1);
    expect(landing(await approve())).toEqual(bought());
    orgId = (await new OrganizationService(deps).createOrganization(ownerId, { name: "Jimbocho" })).organization.id;
    subscribe(orgId);
    expect(landing(await approve())).toEqual(refusedWith(REFUSED));
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(store.purchases).toHaveLength(1);
  });

  it("counts before the permission is checked, so a member's refused, audited attempts are bounded", async () => {
    limitedTo(1);
    await account("VIEWER");
    expect(landing(await approve())).toEqual(refusedWith(FORBIDDEN));
    expect(audits().map((entry) => entry.action)).toEqual(["unit_purchase.refused"]);
    expect(landing(await approve())).toEqual(refusedWith(REFUSED));
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(audits()).toHaveLength(1);
    expect(store.purchases).toEqual([]);
  });

  it("counts nothing before the origin, the session and the form are checked", async () => {
    limitedTo(1);
    expect((await approve(fields(), { origin: "https://evil.example.net" })).status).toBe(403);
    currentUser.value = null;
    expect(landing(await approve()).path).toBe("/login");
    currentUser.value = { user: { id: ownerId } };
    expect(landing(await approve(fields(), { origin: SITE }, "json"))).toEqual(refusedWith(NOT_USABLE));
    expect(landing(await approve({ ...fields(), quality: "4K" }))).toEqual(refusedWith(NOT_USABLE));
    expect(landing(await approve())).toEqual(bought());
    expect(approvals).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an application error", new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row"), "INTERNAL_ERROR"],
    ["any other error", new TypeError("The rate-limit store is gone"), "UNEXPECTED"],
  ])("fails closed on %s with the page's own text, never the limiter's, buying nothing", async (_, failure, code) => {
    const broken = new InMemoryRateLimitStore();
    broken.hit = () => Promise.reject(failure);
    limits.value = limitsOf({}, broken);
    expect(landing(await approve())).toEqual(refusedWith(NOT_CONFIRMED));
    expect(approvals).not.toHaveBeenCalled();
    expect(store.purchases).toEqual([]);
    expect(audits()).toEqual([]);
    expect(reported.errors).toEqual([["A purchase approval could not be counted", { code }]]);
  });

  it("fails closed when the limiter cannot be built, buying nothing", async () => {
    limits.broken = new TypeError("The limiter's settings are missing");
    expect(landing(await approve())).toEqual(refusedWith(NOT_CONFIRMED));
    expect(approvals).not.toHaveBeenCalled();
    expect(store.purchases).toEqual([]);
    expect(reported.errors).toEqual([["A purchase approval could not be counted", { code: "UNEXPECTED" }]]);
  });
});
