// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  AuthService,
  MfaService,
  OrganizationService,
  createMfaSecretCipher,
  systemMfaRandom,
  totpStep,
  type Role,
} from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * The dashboard's organization MFA requirement (MFA-4, ADR-0065 Decision 18):
 * every member sees whether it is on; only an `OWNER` or `ADMIN` gets the
 * control, which posts the opposite value.
 */
const PASSWORD = "password-123456";
const KEY = "44".repeat(32);

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));

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
vi.mock("@/lib/property", () => ({ getPropertyServices: () => ({ properties: { list: () => Promise.resolve([]) } }) }));

const { default: DashboardPage } = await import("./page");

let deps: TestDeps;
let auth: AuthService;
let organizations: OrganizationService;
let orgId: string;
let ownerId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  organizations = new OrganizationService(deps);
  identity.value = { deps, auth, organizations };
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  ownerId = (await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD })).id;
  ({ organization: { id: orgId } } = await organizations.createOrganization(ownerId, { name: "Studio" }));
});

afterEach(cleanup);

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Render the dashboard for a new member holding `role`, signed in with MFA set up. */
async function renderAs(role: Role): Promise<void> {
  const email = `${role.toLowerCase()}-${deps.ids.generate("u")}@example.com`;
  const userId = (await auth.register({ email, name: role, password: PASSWORD })).id;
  await deps.repos.memberships.create({ organizationId: orgId, userId, role });
  const { token, session } = await auth.login(email, PASSWORD);
  const mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
  cookie.value = token;
  render((await DashboardPage({ searchParams: Promise.resolve({}) })) as ReactElement);
}

const control = () => screen.queryByRole("button", { name: /MFA of every member/ });
const value = () => (document.querySelector('input[name="required"]') as HTMLInputElement | null)?.value;

describe("the dashboard's MFA requirement", () => {
  it("shows a member it is off, and gives no control to a MANAGER, CREATOR, VIEWER or BILLING", async () => {
    for (const role of ["MANAGER", "CREATOR", "VIEWER", "BILLING"] as const) {
      await renderAs(role);
      expect(screen.getByText("Two-step sign-in (MFA) is not required of every member.")).toBeTruthy();
      expect(control()).toBeNull();
      cleanup();
    }
  });

  it.each(["OWNER", "ADMIN"] as const)("gives an %s the control, posting the opposite value", async (role) => {
    await renderAs(role);
    expect(control()?.textContent).toBe("Require MFA of every member");
    expect(control()?.closest("form")?.getAttribute("action")).toBe(`/api/organizations/${orgId}/mfa-requirement`);
    expect(control()?.closest("form")?.getAttribute("method")).toBe("post");
    expect(value()).toBe("true");
    cleanup();

    await organizations.setMfaRequirement(ownerId, orgId, true);
    await renderAs(role);
    expect(screen.getByText("Every member must use two-step sign-in (MFA).")).toBeTruthy();
    expect(control()?.textContent).toBe("Stop requiring MFA of every member");
    expect(value()).toBe("false");
  });

  it("shows a member that it is on", async () => {
    await organizations.setMfaRequirement(ownerId, orgId, true);
    await renderAs("VIEWER");
    expect(screen.getByText("Every member must use two-step sign-in (MFA).")).toBeTruthy();
    expect(control()).toBeNull();
  });
});
