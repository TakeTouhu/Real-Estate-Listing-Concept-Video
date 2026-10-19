// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  MfaService,
  OrganizationService,
  UnitsOverviewService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * The Units page (UP-1, ADR-0066 Decision 3): a member with `unit.view` sees the
 * plan, the period and what is left; `billing.view` adds how it is paid and the
 * period's purchases (UP-4, ADR-0069); anyone else is refused alike. The
 * dashboard links each organization to it.
 */
const PASSWORD = "password-123456";
const KEY = "44".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const units = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@/lib/units", () => ({ getUnitsOverviewService: () => units.value }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));

const { default: UnitsPage } = await import("./page");
const { default: DashboardPage } = await import("../../../page");

const iso = (value: string) => new Date(value);

let deps: TestDeps;
let auth: AuthService;
let reader: InMemoryUnitsReader;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-04-20T12:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  reader = new InMemoryUnitsReader();
  units.value = new UnitsOverviewService({ identity: deps, subscriptions: reader, ledger: reader, purchases: reader });
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  ownerId = (await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD })).id;
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio Kanda" }));
});

afterEach(cleanup);

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Sign in a new user, as a member holding `role` or as no member at all, with MFA set up. */
async function signInAs(role: Role | null): Promise<void> {
  const email = `${(role ?? "outsider").toLowerCase()}-${deps.ids.generate("u")}@example.com`;
  const userId = (await auth.register({ email, name: role ?? "Outsider", password: PASSWORD })).id;
  if (role !== null) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

async function renderUnits(role: Role | null): Promise<string> {
  await signInAs(role);
  const { container } = render(
    (await UnitsPage({ params: Promise.resolve({ organizationId: orgId }) })) as ReactElement,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function subscribe(planKey: "standard" | "premium" | "enterprise"): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-03-15T00:00:00.000Z"),
    commercialReference: "VT-1",
    createdAt: iso("2026-03-01T00:00:00.000Z"),
  });
}

describe("the Units page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    cookie.value = undefined;
    await expect(UnitsPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toThrow(
      "redirect /login",
    );
  });

  it.each([["VIEWER" as const], [null]])("refuses %s alike, without the organization's name", async (role) => {
    subscribe("standard");
    const text = await renderUnits(role);
    expect(screen.getByRole("alert").textContent).toBe("You cannot view this organization's Units.");
    expect(text).not.toContain("Studio Kanda");
    expect(text).not.toContain("Standard");
  });

  it("does not pass off an unexpected failure as a refusal", async () => {
    await signInAs("OWNER");
    units.value = { overview: () => Promise.reject(new AppError("INTERNAL_ERROR", "unreadable period")) };
    await expect(UnitsPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("says when the organization has no plan yet", async () => {
    const text = await renderUnits("OWNER");
    expect(text).toContain("Studio Kanda");
    expect(text).toContain("This organization has no plan yet. VTaVision sets it up when your contract starts.");
  });

  it("says when the plan starts, in Japan time", async () => {
    subscribe("premium");
    deps.clock.set(iso("2026-03-10T00:00:00.000Z"));
    const text = await renderUnits("MANAGER");
    expect(screen.getByRole("heading", { name: "Premium plan" })).toBeTruthy();
    expect(text).toContain("Your plan starts on 15 Mar 2026, 09:00 JST. Its Units are available from then.");
  });

  it("shows a MANAGER the Units this period, but not how the plan is paid", async () => {
    subscribe("standard");
    const text = await renderUnits("MANAGER");
    expect(screen.getByRole("heading", { name: "Standard plan" })).toBeTruthy();
    expect(text).toContain("This period runs from 15 Apr 2026, 09:00 JST to 15 May 2026, 09:00 JST.");
    expect(text).toContain("nothing carries over");
    expect(text).toContain("15 of 15 left. They fund Normal or HQ videos.");
    expect(text).toContain("Up to 1 of them can still fund HQ (HQ allowance: 1 included, 1 unused).");
    expect(text).toContain("None bought this period.");
    expect(text).toContain("The Standard plan does not sell HQ additional Units.");
    expect(text).not.toContain("Paid by");
    expect(text).not.toContain("¥");
  });

  it.each(["OWNER", "BILLING"] as const)("shows a %s how the plan is paid, excluding tax", async (role) => {
    subscribe("standard");
    const text = await renderUnits(role);
    expect(text).toContain("Paid by invoice · ¥49,800 excluding tax per month");
  });

  it("lists additional Units by quality, oldest first, with what is left", async () => {
    subscribe("premium");
    reader.periods.push({
      id: "uep_1",
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
    });
    reader.balances.set("uep_1", {
      baseRemainingUnits: 3,
      includedHighQualityRemainingUnits: 4,
      blocks: [
        { id: "b2", quality: "NORMAL", remainingUnits: 9, purchasedAtEpochMs: iso("2026-04-18T03:00:00.000Z").getTime() },
        {
          id: "b1",
          quality: "HIGH_QUALITY",
          remainingUnits: 1,
          purchasedAtEpochMs: iso("2026-04-16T00:30:00.000Z").getTime(),
        },
      ],
    });
    const text = await renderUnits("CREATOR");
    expect(text).toContain("3 of 40 left.");
    expect(text).toContain("Up to 3 of them can still fund HQ (HQ allowance: 5 included, 4 unused).");
    expect(text).toContain("Normal: 9 left · HQ: 1 left");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "HQ: 1 left · bought 16 Apr 2026, 09:30 JST",
      "Normal: 9 left · bought 18 Apr 2026, 12:00 JST",
    ]);
    expect(text).toContain("Normal additional Units fund only Normal videos, and HQ additional Units only HQ videos.");
    expect(text).not.toContain("does not sell HQ additional Units");
  });
});

describe("buying additional Units (UP-3)", () => {
  it.each(["OWNER", "BILLING"] as const)("links a %s to the purchase screen", async (role) => {
    subscribe("premium");
    await renderUnits(role);
    expect(screen.getByRole("link", { name: "Buy additional Units" }).getAttribute("href")).toBe(
      `/organizations/${orgId}/units/buy`,
    );
  });

  it.each(["ADMIN", "MANAGER", "CREATOR"] as const)("offers a %s no way to buy", async (role) => {
    subscribe("premium");
    await renderUnits(role);
    expect(screen.queryByRole("link", { name: "Buy additional Units" })).toBeNull();
  });

  it("says a purchase was approved when the route sends the customer back", async () => {
    subscribe("premium");
    await signInAs("BILLING");
    render(
      (await UnitsPage({
        params: Promise.resolve({ organizationId: orgId }),
        searchParams: Promise.resolve({ purchased: "1" }),
      })) as ReactElement,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Your purchase is approved. Its Units are ready to use, and VTaVision will invoice it.",
    );
  });

  it("says nothing of a purchase otherwise", async () => {
    subscribe("premium");
    await renderUnits("BILLING");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("this period's purchases (UP-4)", () => {
  function openPeriod(): void {
    reader.periods.push({
      id: "uep_1",
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
    });
  }

  function bought(id: string, quality: "NORMAL" | "HIGH_QUALITY", approvedAt: string, approvedByUserId: string): void {
    const [units, priceYenExTax] = quality === "NORMAL" ? [10, 35_900] : [2, 9_000];
    reader.purchases.push({
      id,
      organizationId: orgId,
      entitlementPeriodId: "uep_1",
      addOnBlockId: `uab_${id}`,
      quality,
      units,
      priceYenExTax,
      channel: "SALES_ASSISTED",
      contractReference: "VT-1",
      expiresAt: iso("2026-05-15T00:00:00.000Z"),
      idempotencyKey: `key_${id}`,
      approvedByUserId,
      approvedAt: iso(approvedAt),
    });
  }

  it("lists each package bought, its price, when and by whom, and that it is invoiced", async () => {
    subscribe("premium");
    openPeriod();
    bought("p2", "NORMAL", "2026-04-18T03:00:00.000Z", "usr_gone");
    bought("p1", "HIGH_QUALITY", "2026-04-16T00:30:00.000Z", ownerId);
    const text = await renderUnits("BILLING");
    const card = screen.getByRole("heading", { name: "Purchases this period" }).parentElement;
    expect([...(card?.querySelectorAll("li") ?? [])].map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "+2 HQ Units · ¥9,000 excluding tax · approved 16 Apr 2026, 09:30 JST by Owner",
      "+10 Normal Units · ¥35,900 excluding tax · approved 18 Apr 2026, 12:00 JST by a former member",
    ]);
    expect(text).toContain("VTaVision invoices each purchase under your contract, with consumption tax added.");
  });

  it("says when nothing was bought this period", async () => {
    subscribe("premium");
    const text = await renderUnits("OWNER");
    expect(screen.getByRole("heading", { name: "Purchases this period" })).toBeTruthy();
    expect(text).toContain("No purchases this period.");
    expect(text).not.toContain("VTaVision invoices each purchase");
  });

  it.each(["MANAGER", "CREATOR"] as const)("shows a %s no purchases", async (role) => {
    subscribe("premium");
    openPeriod();
    bought("p1", "NORMAL", "2026-04-16T00:30:00.000Z", ownerId);
    const text = await renderUnits(role);
    expect(screen.queryByRole("heading", { name: "Purchases this period" })).toBeNull();
    expect(text).not.toContain("¥");
  });
});

describe("the dashboard", () => {
  it("links each organization to its Units page", async () => {
    await signInAs("MANAGER");
    render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(screen.getByRole("link", { name: "Units and plan" }).getAttribute("href")).toBe(
      `/organizations/${orgId}/units`,
    );
  });
});
