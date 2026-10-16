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
  type Session,
} from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * The pages of the two-step sign-in (ADR-0065 Decision 12): who reaches the
 * code page, the sign-in page and the security page. The session gate in
 * `lib/auth.ts` runs for real over in-memory repositories.
 */
const PASSWORD = "password-123456";
const KEY = "44".repeat(32);

class Redirect extends Error {}

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirect(path);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const { default: LoginPage } = await import("./login/page");
const { default: MfaCodePage } = await import("./login/mfa/page");
const { default: SecurityPage } = await import("./security/page");

let deps: TestDeps;
let auth: AuthService;
let mfa: MfaService;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  mfa = new MfaService({ ...deps, cipher: createMfaSecretCipher(KEY), random: systemMfaRandom });
  identity.value = { deps, auth };
  env.value = { NODE_ENV: "test", MFA_SECRET_KEY: KEY };
  cookie.value = undefined;
  await auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
});

afterEach(() => cleanup());

const search = (params: { error?: string } = {}) => ({ searchParams: Promise.resolve(params) });

async function signIn(): Promise<Session> {
  const { token, session } = await auth.login("a@example.com", PASSWORD);
  cookie.value = token;
  return session;
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** Turn MFA on in this sign-in, which then counts as having passed it. */
async function turnOnMfa(session: Session): Promise<void> {
  const { secret } = await mfa.beginSetup(session);
  await mfa.confirmSetup(session, hotp(decodeBase32(secret), totpStep(deps.clock.now())));
}

async function redirectOf(page: Promise<ReactElement>): Promise<string> {
  const error = await page.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Redirect)) throw new Error("expected a redirect");
  return error.message;
}

describe("/login", () => {
  it("shows the sign-in forms, but sends a sign-in that owes a code to the code page", async () => {
    render(await LoginPage(search()));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();

    await turnOnMfa(await signIn());
    await signIn();
    expect(await redirectOf(LoginPage(search()))).toBe("/login/mfa");
  });
});

describe("/login/mfa", () => {
  it("is only for a sign-in that owes a code", async () => {
    expect(await redirectOf(MfaCodePage(search()))).toBe("/login");
    await signIn();
    expect(await redirectOf(MfaCodePage(search()))).toBe("/");

    await turnOnMfa(await signIn());
    await signIn();
    render(await MfaCodePage(search({ error: "That code is not valid. Attempts left: 4" })));
    expect(screen.getByLabelText("Code")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("That code is not valid. Attempts left: 4");
  });
});

describe("/security", () => {
  it("is only for a signed-in user", async () => {
    expect(await redirectOf(SecurityPage())).toBe("/login");
    await turnOnMfa(await signIn());
    await signIn();
    expect(await redirectOf(SecurityPage())).toBe("/login");
  });

  it("shows whether MFA is on, and says when it is not available", async () => {
    await signIn();
    render(await SecurityPage());
    expect(screen.getByText("MFA is off.")).toBeTruthy();
    cleanup();

    env.value = { NODE_ENV: "test" };
    render(await SecurityPage());
    expect(screen.getByRole("alert").textContent).toBe("MFA is not available right now.");
  });

  it("shows MFA on for the sign-in that turned it on", async () => {
    const user = (await deps.repos.users.findByEmail("a@example.com"))!;
    await new OrganizationService(deps).createOrganization(user.id, { name: "Studio" });
    await turnOnMfa(await signIn());
    render(await SecurityPage());
    expect(screen.getByText("MFA is on.")).toBeTruthy();
    expect(screen.getByText("Your role requires MFA, so it cannot be turned off.")).toBeTruthy();
  });
});
