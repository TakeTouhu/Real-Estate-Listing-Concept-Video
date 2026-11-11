// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  MembersOverviewService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { InMemoryUnitsReader, createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";
import { AppError, hotp } from "@app/shared";

/**
 * The members page (AT-5, ADR-0134): a holder of `member.view` sees the seats,
 * the members and the pending invitations; anyone else is refused alike. The
 * dashboard links each organization to it.
 */
const PASSWORD = "password-123456";
const KEY = "55".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const members = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@/lib/members", () => ({ getMembersOverviewService: () => members.value }));
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));

const { default: MembersPage } = await import("./page");
const { default: DashboardPage } = await import("../../../page");

const iso = (value: string) => new Date(value);

let deps: TestDeps;
let auth: AuthService;
let reader: InMemoryUnitsReader;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  deps.clock.set(iso("2026-11-10T03:00:00.000Z"));
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  reader = new InMemoryUnitsReader();
  members.value = new MembersOverviewService({ identity: deps, subscriptions: reader });
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  ownerId = (await auth.register({ email: "owner@example.com", name: "Aiko Owner", password: PASSWORD })).id;
  markEmailVerified(deps, ownerId);
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
  const email = `ken.${(role ?? "outsider").toLowerCase()}@example.com`;
  const userId = (await auth.register({ email, name: `Ken ${role ?? "Outsider"}`, password: PASSWORD })).id;
  markEmailVerified(deps, userId);
  if (role !== null) await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
}

async function renderMembers(role: Role | null): Promise<string> {
  await signInAs(role);
  const { container } = render(
    (await MembersPage({ params: Promise.resolve({ organizationId: orgId }) })) as ReactElement,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function subscribe(planKey: "standard" | "premium" | "enterprise"): void {
  reader.subscriptions.set(orgId, {
    id: `sub_${orgId}`,
    organizationId: orgId,
    planKey,
    channel: "SALES_ASSISTED",
    anchorAt: iso("2026-10-15T00:00:00.000Z"),
    commercialReference: "VT-1",
    createdAt: iso("2026-10-01T00:00:00.000Z"),
  });
}

describe("the members page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    cookie.value = undefined;
    await expect(MembersPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toThrow(
      "redirect /login",
    );
  });

  it.each([["CREATOR" as const], [null]])("refuses %s alike, without the organization's name", async (role) => {
    subscribe("standard");
    const text = await renderMembers(role);
    expect(screen.getByRole("alert").textContent).toBe("You cannot view this organization's members.");
    expect(text).not.toContain("Studio Kanda");
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("Seats");
  });

  it("does not pass off an unexpected failure as a refusal", async () => {
    await signInAs("OWNER");
    members.value = { overview: () => Promise.reject(new AppError("INTERNAL_ERROR", "unreadable members")) };
    await expect(MembersPage({ params: Promise.resolve({ organizationId: orgId }) })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("says when the organization has no plan, and so no seats, yet", async () => {
    const text = await renderMembers("MANAGER");
    expect(text).toContain("Studio Kanda");
    expect(text).toContain(
      "This organization has no plan yet. Its seats come with the plan, which VTaVision sets up when your contract " +
        "starts.",
    );
    expect(text).not.toContain(" taken.");
  });

  it("shows the seats taken, the members and the pending invitations, in Japan time", async () => {
    subscribe("standard");
    await deps.repos.invitations.create(
      {
        id: "inv_1",
        organizationId: orgId,
        email: "new.hire@example.com",
        role: "VIEWER",
        tokenHash: "hash:inv_1",
        status: "PENDING",
        invitedByUserId: ownerId,
        expiresAt: iso("2026-11-17T03:00:00.000Z"),
        acceptedAt: null,
      },
      {
        organizationId: orgId,
        actorUserId: ownerId,
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: "inv_1",
        metadata: {},
      },
    );
    deps.clock.set(iso("2026-11-10T05:00:00.000Z"));
    const text = await renderMembers("BILLING");

    expect(text).toContain("3 of 3 taken.");
    expect(text).toContain(
      "Every member takes a seat, the owner included, and so does an invitation until it is accepted or expires.",
    );
    expect(screen.getByRole("heading", { name: "Members (2)" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "Aiko Owner · owner@example.com · Owner · joined 10 Nov 2026, 12:00 JST",
      "Ken BILLING (you) · ken.billing@example.com · Billing · joined 10 Nov 2026, 14:00 JST",
      "new.hire@example.com · Viewer · invited 10 Nov 2026, 12:00 JST, expires 17 Nov 2026, 12:00 JST",
    ]);
    expect(screen.getByRole("heading", { name: "Pending invitations (1)" })).toBeTruthy();
  });

  it("says when no invitation is pending", async () => {
    subscribe("premium");
    const text = await renderMembers("ADMIN");
    expect(text).toContain("2 of 10 taken.");
    expect(screen.getByRole("heading", { name: "Pending invitations (0)" })).toBeTruthy();
    expect(text).toContain("No pending invitations.");
  });
});

describe("the dashboard", () => {
  it("links each organization to its members page", async () => {
    await signInAs("MANAGER");
    render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(screen.getByRole("link", { name: "Members" }).getAttribute("href")).toBe(`/organizations/${orgId}/members`);
  });
});
