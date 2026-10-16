// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
 * The pages of the two-step sign-in (ADR-0065 Decisions 12 and 15): who
 * reaches the code page, the sign-in page and the security page, and where a
 * sign-in that must set MFA up goes. The session gate in `lib/auth.ts` runs for
 * real over in-memory repositories.
 */
const PASSWORD = "password-123456";
const KEY = "44".repeat(32);

class Redirect extends Error {}

const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirect(path);
  },
  useRouter: () => router,
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
  router.push.mockReset();
  router.refresh.mockReset();
  await auth.register({ email: "a@example.com", name: "A", password: PASSWORD });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/** Make the user an `OWNER`, who must use MFA. */
async function becomeOwner(): Promise<void> {
  const user = (await deps.repos.users.findByEmail("a@example.com"))!;
  await new OrganizationService(deps).createOrganization(user.id, { name: "Studio" });
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

  it("sends a sign-in that must set MFA up to the security page", async () => {
    await becomeOwner();
    await signIn();
    expect(await redirectOf(LoginPage(search()))).toBe("/security");
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

  it("sends a sign-in that must set MFA up, and owes no code, to the security page", async () => {
    await becomeOwner();
    await signIn();
    expect(await redirectOf(MfaCodePage(search()))).toBe("/security");
  });
});

describe("/security", () => {
  it("is not for a sign-in that owes a code", async () => {
    expect(await redirectOf(SecurityPage())).toBe("/login");
    await turnOnMfa(await signIn());
    await signIn();
    expect(await redirectOf(SecurityPage())).toBe("/login/mfa");
  });

  it("asks a sign-in that must use MFA to set it up before anything else (ADR-0065 Decision 15)", async () => {
    await becomeOwner();
    await signIn();
    render(await SecurityPage());
    expect(screen.getByText("Your role requires two-step sign-in (MFA). Set it up to continue.")).toBeTruthy();
    expect(screen.getByText("MFA is off. Your role requires it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up MFA" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to organizations" })).toBeNull();
    cleanup();

    env.value = { NODE_ENV: "test" };
    render(await SecurityPage());
    expect(screen.getByRole("alert").textContent).toBe("MFA is not available right now.");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("goes on in once a sign-in that had to set MFA up has done so", async () => {
    await becomeOwner();
    await signIn();
    render(await SecurityPage());
    const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(ok({ secret: "JBSWY3DPEHPK3PXP", qrCode: "data:image/svg+xml;base64,PHN2Zz4=" }))
        .mockResolvedValueOnce(ok({ recoveryCodes: ["ABCD-EFGH-JKMN-PQ00"] })),
    );
    await userEvent.click(screen.getByRole("button", { name: "Set up MFA" }));
    await userEvent.type(screen.getByLabelText("Code from your authenticator app"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Turn on MFA" }));
    await userEvent.click(screen.getByRole("button", { name: "I have saved them" }));
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("shows whether MFA is on, and says when it is not available", async () => {
    await signIn();
    render(await SecurityPage());
    expect(screen.getByText("MFA is off.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to organizations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    cleanup();

    env.value = { NODE_ENV: "test" };
    render(await SecurityPage());
    expect(screen.getByRole("alert").textContent).toBe("MFA is not available right now.");
  });

  it("shows MFA on for the sign-in that turned it on", async () => {
    await becomeOwner();
    await turnOnMfa(await signIn());
    render(await SecurityPage());
    expect(screen.getByText("MFA is on.")).toBeTruthy();
    expect(screen.getByText("Your role requires MFA, so it cannot be turned off.")).toBeTruthy();
  });
});
