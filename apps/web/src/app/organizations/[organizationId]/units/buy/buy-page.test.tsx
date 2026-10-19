// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  MfaService,
  OrganizationService,
  UnitPurchaseService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitPurchases, InMemoryUnitsReader, createTestDeps, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";
import type { OrganizationSubscription } from "@app/domain";

/**
 * Buying an additional Unit package (UP-3, ADR-0068): the screen a holder of
 * `billing.manage` sees, its confirmation step, and the route the step posts
 * to, over the in-memory purchase service.
 */
const PASSWORD = "password-123456";
const KEY = "55".repeat(32);
const SITE = "https://app.vtavision.test";

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const purchasing = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));
vi.mock("@/lib/unit-purchases", () => ({ getUnitPurchaseService: () => purchasing.value }));

const { default: BuyUnitsPage } = await import("./page");
const { POST } = await import("../../../../api/organizations/[organizationId]/unit-purchases/route");

const iso = (value: string) => new Date(value);
const PERIOD_END = iso("2026-05-15T00:00:00.000Z");

let deps: TestDeps;
let auth: AuthService;
let reader: InMemoryUnitsReader;
let store: InMemoryUnitPurchases;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  reader = new InMemoryUnitsReader();
  store = new InMemoryUnitPurchases(reader, deps);
  purchasing.value = new UnitPurchaseService({
    identity: deps,
    subscriptions: reader,
    ledger: store,
    purchases: store,
  });
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  ownerId = (await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD })).id;
  ({ organization: { id: orgId } } = await new OrganizationService(deps).createOrganization(ownerId, {
    name: "Studio Kanda",
  }));
});

afterEach(cleanup);

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in a new user, as a member holding `role` or as no member at all, with MFA set up; its id. */
async function signInAs(role: Role | null): Promise<string> {
  const email = `${(role ?? "outsider").toLowerCase()}-${deps.ids.generate("u")}@example.com`;
  const userId = (await auth.register({ email, name: role ?? "Outsider", password: PASSWORD })).id;
  if (role !== null) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
  return userId;
}

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

async function renderBuy(query: { package?: string; error?: string } = {}): Promise<string> {
  const { container } = render(
    (await BuyUnitsPage({
      params: Promise.resolve({ organizationId: orgId }),
      searchParams: Promise.resolve(query),
    })) as ReactElement,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/** The hidden fields of the confirmation step on screen. */
function confirmationFields(): Record<string, string> {
  const form = document.querySelector("form");
  if (form === null) throw new Error("expected the confirmation form");
  return Object.fromEntries([...form.querySelectorAll("input")].map((input) => [input.name, input.value]));
}

function approve(fields: Record<string, string>, headers: Record<string, string> = { origin: SITE }) {
  // A string: jsdom's URLSearchParams is not the one the Fetch API's Request accepts.
  const body = new URLSearchParams(fields).toString();
  const request = new Request(`${SITE}/api/organizations/${orgId}/unit-purchases`, {
    method: "POST",
    headers: { host: "app.vtavision.test", "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  return POST(request, { params: Promise.resolve({ organizationId: orgId }) });
}

/** Where a 303 sends the customer, and the message it carries. */
function landing(response: Response): { path: string; error: string | null; purchased: string | null } {
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location") ?? "");
  return { path: url.pathname, error: url.searchParams.get("error"), purchased: url.searchParams.get("purchased") };
}

describe("the purchase screen", () => {
  it("sends a signed-out visitor to sign in", async () => {
    cookie.value = undefined;
    await expect(renderBuy()).rejects.toThrow("redirect /login");
  });

  it.each([["ADMIN" as const], ["MANAGER" as const], ["VIEWER" as const], [null]])(
    "refuses %s alike, without the plan",
    async (role) => {
      subscribe();
      await signInAs(role);
      const text = await renderBuy();
      expect(screen.getByRole("alert").textContent).toBe("You cannot buy Units for this organization.");
      expect(text).not.toContain("Premium");
      expect(text).not.toContain("¥");
    },
  );

  it("does not pass off an unexpected failure as a refusal", async () => {
    await signInAs("OWNER");
    purchasing.value = { offers: () => Promise.reject(new AppError("INTERNAL_ERROR", "unreadable period")) };
    await expect(renderBuy()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("lists Premium's packages excluding tax, with their expiry", async () => {
    subscribe();
    await signInAs("BILLING");
    const text = await renderBuy();
    expect(screen.getByRole("heading", { name: "Buy additional Units" })).toBeTruthy();
    expect(text).toContain(
      "One package per purchase. Units bought now expire at the end of this period, 15 May 2026, 09:00 JST, and " +
        "nothing carries over.",
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "+10 Normal Units · ¥35,900 excluding tax · Review purchase",
      "+2 HQ Units · ¥9,000 excluding tax · Review purchase",
    ]);
    expect(screen.getAllByRole("link", { name: "Review purchase" }).map((link) => link.getAttribute("href"))).toEqual([
      "?package=NORMAL",
      "?package=HIGH_QUALITY",
    ]);
    expect(document.querySelector("form")).toBeNull();
  });

  it("offers Standard no HQ package, and says so", async () => {
    subscribe({ planKey: "standard" });
    await signInAs("OWNER");
    const text = await renderBuy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "+5 Normal Units · ¥19,900 excluding tax · Review purchase",
    ]);
    expect(text).toContain("The Standard plan does not sell HQ additional Units.");
  });

  it("refuses to confirm HQ on Standard, or a package that does not exist", async () => {
    subscribe({ planKey: "standard" });
    await signInAs("OWNER");
    for (const name of ["HIGH_QUALITY", "ULTRA"]) {
      await renderBuy({ package: name });
      expect(screen.getByRole("alert").textContent).toBe("Your plan does not sell that package.");
      expect(document.querySelector("form")).toBeNull();
      cleanup();
    }
  });

  it("lists Enterprise packages with no way to buy them here", async () => {
    subscribe({ planKey: "enterprise" });
    await signInAs("BILLING");
    const text = await renderBuy({ package: "NORMAL" });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "+25 Normal Units · ¥89,400 excluding tax",
      "+5 HQ Units · ¥22,400 excluding tax",
    ]);
    expect(text).toContain(
      "On the Enterprise plan, additional Units are bought through your VTaVision representative.",
    );
    expect(screen.queryByRole("link", { name: "Review purchase" })).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it.each([
    ["no plan", null, "This organization has no plan yet. VTaVision sets it up when your contract starts."],
    [
      "a plan not started",
      { anchorAt: iso("2026-05-01T00:00:00.000Z") },
      "Your plan starts on 1 May 2026, 09:00 JST. Additional Units can be bought from then.",
    ],
    [
      "a card-paid plan",
      { channel: "SELF_SERVICE" as const },
      "Your plan is paid by card, and additional Units cannot be bought by card yet.",
    ],
  ])("offers nothing to buy with %s", async (_what, overrides, words) => {
    if (overrides !== null) subscribe(overrides);
    await signInAs("OWNER");
    const text = await renderBuy({ package: "NORMAL" });
    expect(text).toContain(words);
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("offers nothing while the ledger holds a period the plan did not open", async () => {
    subscribe();
    reader.periods.push({
      id: "uep_by_hand",
      organizationId: orgId,
      billingCycleKey: "by-hand",
      planKey: "premium",
      baseUnits: 40,
      includedHighQualityUnits: 5,
      highQualityAddOnAvailable: true,
      startsAt: iso("2026-04-10T00:00:00.000Z"),
      endsAt: iso("2026-05-10T00:00:00.000Z"),
      commercialReference: "by hand",
      createdAt: iso("2026-04-10T00:00:00.000Z"),
    });
    await signInAs("OWNER");
    const text = await renderBuy({ package: "NORMAL" });
    expect(text).toContain("Additional Units cannot be bought here right now. Contact your VTaVision representative.");
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("shows the refusal it was sent back with", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ error: "The package or its price changed after you reviewed it." });
    expect(screen.getByRole("alert").textContent).toBe("The package or its price changed after you reviewed it.");
  });
});

describe("the confirmation step", () => {
  it("states the Units, the quality lock, the price, the expiry and the invoice before one approval", async () => {
    subscribe();
    await signInAs("BILLING");
    const text = await renderBuy({ package: "HIGH_QUALITY" });
    expect(screen.getByRole("heading", { name: "Review your purchase" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "+2 HQ Units" })).toBeTruthy();
    expect(text).toContain("HQ only: these Units fund HQ videos and never Normal videos.");
    expect(text).toContain("Price: ¥9,000 excluding tax. Consumption tax is added on the invoice.");
    expect(text).toContain(
      "They expire at the end of this period, 15 May 2026, 09:00 JST. Units left unused then do not carry over and " +
        "are not refunded.",
    );
    expect(text).toContain("VTaVision invoices this purchase under your contract VT-2026-001.");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Approve purchase for ¥9,000 excluding tax",
    ]);
    expect(document.querySelector("form")?.getAttribute("action")).toBe(`/api/organizations/${orgId}/unit-purchases`);
    expect(confirmationFields()).toEqual({
      quality: "HIGH_QUALITY",
      units: "2",
      priceYenExTax: "9000",
      periodEndsAt: PERIOD_END.toISOString(),
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(store.purchases).toEqual([]);
    expect(reader.periods).toEqual([]);
  });

  it("names Normal as Normal only", async () => {
    subscribe();
    await signInAs("OWNER");
    const text = await renderBuy({ package: "NORMAL" });
    expect(text).toContain("Normal only: these Units fund Normal videos and never HQ videos.");
  });

  it("carries a new key each time it is shown", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const first = confirmationFields().idempotencyKey;
    cleanup();
    await renderBuy({ package: "NORMAL" });
    expect(confirmationFields().idempotencyKey).not.toBe(first);
  });
});

describe("approving the purchase", () => {
  it("buys what the confirmation step showed, and sends the customer to the Units", async () => {
    subscribe();
    const billing = await signInAs("BILLING");
    await renderBuy({ package: "NORMAL" });
    const fields = confirmationFields();

    expect(landing(await approve(fields))).toEqual({
      path: `/organizations/${orgId}/units`,
      error: null,
      purchased: "1",
    });
    expect(store.purchases.map((p) => [p.quality, p.units, p.priceYenExTax, p.expiresAt, p.approvedByUserId])).toEqual([
      ["NORMAL", 10, 35_900, PERIOD_END, billing],
    ]);
    expect(store.purchases[0]?.idempotencyKey).toBe(fields.idempotencyKey);
  });

  it("buys once when the same confirmation is sent twice", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "HIGH_QUALITY" });
    const fields = confirmationFields();
    const first = landing(await approve(fields));
    expect(landing(await approve(fields))).toEqual(first);
    expect(store.purchases).toHaveLength(1);
  });

  it("does not call a purchase cancelled since approved when its confirmation is sent again", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const fields = confirmationFields();
    await approve(fields);
    const [bought] = store.purchases;
    if (bought === undefined) throw new Error("expected the purchase");
    store.purchases[0] = { ...bought, cancelledAt: iso("2026-04-20T13:00:00.000Z") };

    expect(landing(await approve(fields))).toEqual({
      path: `/organizations/${orgId}/units/buy`,
      error:
        "This confirmation was for a purchase VTaVision has since cancelled, which is not invoiced. Nothing new was bought. Review the purchase again.",
      purchased: null,
    });
    expect(store.purchases).toHaveLength(1);
  });

  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.example.net" }],
    ["another origin of the same site", { origin: "https://files.vtavision.test" }],
  ])("refuses a post from %s before reading anything", async (_what, headers) => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const response = await approve(confirmationFields(), headers);
    expect(response.status).toBe(403);
    expect(store.purchases).toEqual([]);
    expect(deps.repos.auditLogs.all().filter((entry) => entry.action.startsWith("unit_purchase."))).toEqual([]);
  });

  it("sends a signed-out visitor to sign in, buying nothing", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const fields = confirmationFields();
    cookie.value = undefined;
    expect(landing(await approve(fields)).path).toBe("/login");
    expect(store.purchases).toEqual([]);
  });

  it("sends a refusal back to the screen, buying nothing", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const fields = { ...confirmationFields(), priceYenExTax: "30000" };
    expect(landing(await approve(fields))).toEqual({
      path: `/organizations/${orgId}/units/buy`,
      error: "The package or its price changed after you reviewed it. Nothing was bought. Review it again.",
      purchased: null,
    });
    expect(store.purchases).toEqual([]);
  });

  it("refuses a member without billing.manage, audited, buying nothing", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const fields = confirmationFields();
    await signInAs("ADMIN");
    expect(landing(await approve(fields)).error).toBe(
      "You cannot buy Units for this organization. Nothing was bought.",
    );
    expect(store.purchases).toEqual([]);
    expect(deps.repos.auditLogs.all().map((entry) => entry.action)).toContain("unit_purchase.refused");
  });

  it("refuses a form it cannot read, buying nothing", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    const fields = { ...confirmationFields(), periodEndsAt: "15 May" };
    expect(landing(await approve(fields)).error).toBe(
      "The purchase request could not be read. Nothing was bought. Review the purchase again.",
    );
    expect(store.purchases).toEqual([]);
  });

  it("sends the customer to check before retrying when the purchase may have failed after the write", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    purchasing.value = { approve: () => Promise.reject(new AppError("INTERNAL_ERROR", "connection lost")) };
    expect(landing(await approve(confirmationFields())).error).toBe(
      "The purchase could not be confirmed. Check the Units page before trying again.",
    );
  });

  it("does not turn an unexpected failure into a message", async () => {
    subscribe();
    await signInAs("OWNER");
    await renderBuy({ package: "NORMAL" });
    purchasing.value = { approve: () => Promise.reject(new TypeError("bug")) };
    await expect(approve(confirmationFields())).rejects.toThrow("bug");
  });
});
