// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { AuthService, OrganizationService } from "@app/domain";
import { createTestDeps, markEmailVerified, type TestDeps } from "@app/domain/testing";

/**
 * The verify page (AT-3b, ADR-0129): one press of a button opens an emailed
 * link, with no sign-in; a sign-in that has not verified its address sees
 * only this page, which names the address and sends the link again; every
 * other sign-in step sends that sign-in here. The session gate in
 * `lib/auth.ts` runs for real over in-memory repositories.
 */
const PASSWORD = "password-123456";

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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const verifyEmail = await import("./verify-email/page");
const VerifyEmailPage = verifyEmail.default;
const { default: LoginPage } = await import("./login/page");
const { default: MfaCodePage } = await import("./login/mfa/page");
const { default: SecurityPage } = await import("./security/page");

let deps: TestDeps;
let auth: AuthService;
let userId: string;

beforeEach(async () => {
  deps = createTestDeps();
  auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  identity.value = { deps, auth };
  env.value = { NODE_ENV: "test" };
  cookie.value = undefined;
  userId = (await auth.register({ email: "new@example.com", name: "New", password: PASSWORD })).id;
});

afterEach(cleanup);

type Params = { token?: string | string[]; notice?: string | string[]; error?: string };
const search = (params: Params = {}) => ({ searchParams: Promise.resolve(params) });

async function signIn(): Promise<void> {
  cookie.value = (await auth.login("new@example.com", PASSWORD)).token;
}

async function redirectOf(page: Promise<ReactElement>): Promise<string> {
  const error = await page.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Redirect)) throw new Error("expected a redirect");
  return error.message;
}

describe("opening a link", () => {
  it("asks for one press, posting the token, whoever is signed in", async () => {
    for (const signedIn of [false, true]) {
      if (signedIn) await signIn();
      render(await VerifyEmailPage(search({ token: "tok_abc-123" })));
      const form = screen.getByRole("button", { name: "Verify email address" }).closest("form")!;
      expect(form.getAttribute("method")).toBe("post");
      expect(form.getAttribute("action")).toBe("/api/auth/verify-email");
      const hidden = form.querySelector('input[type="hidden"]')!;
      expect([hidden.getAttribute("name"), hidden.getAttribute("value")]).toEqual(["token", "tok_abc-123"]);
      // Someone else may have signed up with this address: they are told not to press.
      expect(form.textContent).toContain("If you did not create an account with this address, close this page.");
      cleanup();
    }
  });

  it("offers no button for a token that is empty, repeated or over-long", async () => {
    for (const token of ["", ["a", "b"], "t".repeat(129)]) {
      render(await VerifyEmailPage(search({ token })));
      expect(screen.getByRole("heading", { name: "Link not valid" })).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
    render(await VerifyEmailPage(search({ token: "t".repeat(128) })));
    expect(screen.getByRole("button", { name: "Verify email address" })).toBeTruthy();
  });

  it("tells no page it leads to more than its origin, and keeps its forms' origin", () => {
    expect(verifyEmail.metadata).toEqual({ referrer: "strict-origin" });
  });
});

describe("after a link is opened", () => {
  it("says the address is verified, to anyone", async () => {
    render(await VerifyEmailPage(search({ notice: "verified" })));
    expect(screen.getByRole("heading", { name: "Email address verified" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Your email address is verified.");
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/");
  });

  it("says a link did not work to someone not signed in, and sends them on to sign in otherwise", async () => {
    render(await VerifyEmailPage(search({ notice: "invalid" })));
    expect(screen.getByRole("heading", { name: "Link not valid" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "This link does not work. It may have expired or been used already.",
    );
    expect(await redirectOf(VerifyEmailPage(search()))).toBe("/login");
    expect(await redirectOf(VerifyEmailPage(search({ notice: "sent" })))).toBe("/login");
  });
});

describe("a sign-in that has not verified its address", () => {
  it("sees the address, a button that sends the link again and one that signs out", async () => {
    await signIn();
    render(await VerifyEmailPage(search()));
    expect(screen.getByRole("heading", { name: "Verify your email address" })).toBeTruthy();
    expect(screen.getByText("new@example.com").tagName).toBe("STRONG");
    const resend = screen.getByRole("button", { name: "Send the link again" }).closest("form")!;
    expect([resend.getAttribute("method"), resend.getAttribute("action")]).toEqual([
      "post",
      "/api/auth/verify-email/resend",
    ]);
    const signOut = screen.getByRole("button", { name: "Sign out" }).closest("form")!;
    expect(signOut.getAttribute("action")).toBe("/api/auth/logout");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows only the notices it knows", async () => {
    await signIn();
    const shown: [string, "status" | "alert", string][] = [
      ["sent", "status", "We sent a new link to your email address."],
      ["not-sent", "alert", "The verification email could not be sent. Try again later."],
      ["invalid", "alert", "This link does not work. It may have expired or been used already."],
    ];
    for (const [notice, role, text] of shown) {
      render(await VerifyEmailPage(search({ notice })));
      expect(screen.getByRole(role).textContent).toBe(text);
      // With no email sent, there is no link to open yet.
      const ask = screen.getByText("new@example.com").parentElement!.textContent;
      expect(ask).toBe(
        notice === "not-sent"
          ? "To continue, have a link sent to new@example.com. It works once, for 24 hours."
          : "To continue, open the link we sent to new@example.com. It works once, for 24 hours.",
      );
      cleanup();
    }
    render(await VerifyEmailPage(search({ notice: "Your account is closed", error: "Your account is closed" })));
    expect(screen.queryByText("Your account is closed")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is sent here by the sign-in, code and security pages", async () => {
    await signIn();
    expect(await redirectOf(LoginPage(search()))).toBe("/verify-email");
    expect(await redirectOf(MfaCodePage(search()))).toBe("/verify-email");
    expect(await redirectOf(SecurityPage())).toBe("/verify-email");
  });
});

describe("a sign-in that has verified its address", () => {
  it("goes in, or to MFA set-up first when it must use MFA", async () => {
    markEmailVerified(deps, userId);
    await signIn();
    expect(await redirectOf(VerifyEmailPage(search()))).toBe("/");
    await new OrganizationService(deps).createOrganization(userId, { name: "Studio" });
    expect(await redirectOf(VerifyEmailPage(search({ notice: "sent" })))).toBe("/security");
    render(await VerifyEmailPage(search({ notice: "invalid" })));
    expect(screen.getByRole("heading", { name: "Link not valid" })).toBeTruthy();
  });
});
