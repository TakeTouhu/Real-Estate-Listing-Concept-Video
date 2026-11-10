// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, PasswordResetService, type OutgoingEmail } from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";

/**
 * The reset page (AT-4c, ADR-0133): with no sign-in, it asks for a link,
 * shows the new-password form only for a link that would reset a password,
 * writing nothing, and shows only the notices it knows. The domain service
 * runs for real over in-memory repositories.
 */
const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => (cookie.value ? { value: cookie.value } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect to ${path}`);
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const resetPassword = await import("./reset-password/page");
const { RESET_PASSWORD_NOTICES } = await import("@/lib/password-reset");
const ResetPasswordPage = resetPassword.default;
const { default: LoginPage } = await import("./login/page");

let deps: TestDeps;
let mailed: OutgoingEmail[];
let service: PasswordResetService;

beforeEach(async () => {
  deps = createTestDeps();
  identity.value = { deps };
  // Opening a link needs no outbox and no base address.
  env.value = { NODE_ENV: "test" };
  cookie.value = undefined;
  await new AuthService(deps, { sessionTtlSeconds: 3600 }).register({
    email: "user@example.com",
    name: "User",
    password: "password-123456",
  });
  mailed = [];
  service = new PasswordResetService({
    ...deps,
    email: { send: async (message) => void mailed.push(message) },
    resetUrl: (token) => `https://app.example/reset-password?token=${token}`,
  });
});

afterEach(cleanup);

type Params = { token?: string | string[]; notice?: string | string[]; error?: string };
const search = (params: Params = {}) => ({ searchParams: Promise.resolve(params) });

async function mailedToken(): Promise<string> {
  await service.requestReset("user@example.com");
  const line = mailed.at(-1)!.text.split("\n").find((text) => text.startsWith("https://app.example/"));
  return new URL(line!).searchParams.get("token")!;
}

function askingForm(): HTMLFormElement {
  const form = screen.getByRole("button", { name: "Send the link" }).closest("form")!;
  expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual([
    "post",
    "/api/auth/reset-password/request",
  ]);
  expect(screen.getByLabelText("Email").getAttribute("name")).toBe("email");
  return form;
}

describe("asking for a link", () => {
  it("asks for the account's email address, from the sign-in page's link", async () => {
    render(await LoginPage(search()));
    expect(screen.getByRole("link", { name: "Forgot your password?" }).getAttribute("href")).toBe("/reset-password");
    cleanup();
    render(await ResetPasswordPage(search()));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    askingForm();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText(/New password/)).toBeNull();
  });

  it("shows only the notices it knows, with the form to ask again", async () => {
    const shown: ["sent" | "too-short" | "failed", "status" | "alert"][] = [
      ["sent", "status"],
      ["too-short", "alert"],
      ["failed", "alert"],
    ];
    for (const [notice, role] of shown) {
      render(await ResetPasswordPage(search({ notice })));
      expect(screen.getByRole(role).textContent).toBe(RESET_PASSWORD_NOTICES[notice]);
      askingForm();
      cleanup();
    }
    expect(RESET_PASSWORD_NOTICES.sent).toBe(
      "If an account uses that email address, we sent it a link to choose a new password. It works once, for 1 hour.",
    );
    render(await ResetPasswordPage(search({ notice: "Your account is closed", error: "Your account is closed" })));
    expect(screen.queryByText("Your account is closed")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the password was changed, and leads to sign in", async () => {
    render(await ResetPasswordPage(search({ notice: "reset" })));
    expect(screen.getByRole("heading", { name: "Password changed" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Your password was changed, and your account was signed out everywhere. Sign in with your new password.",
    );
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("opening a link", () => {
  it("shows the new-password form for a usable link, posting the token, and writes nothing", async () => {
    const token = await mailedToken();
    const audit = deps.repos.auditLogs.all().length;
    for (let opened = 0; opened < 2; opened += 1) {
      render(await ResetPasswordPage(search({ token, notice: "invalid" })));
      expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeTruthy();
      const form = screen.getByRole("button", { name: "Change password" }).closest("form")!;
      expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["post", "/api/auth/reset-password"]);
      const hidden = form.querySelector('input[type="hidden"]')!;
      expect([hidden.getAttribute("name"), hidden.getAttribute("value")]).toEqual(["token", token]);
      const password = screen.getByLabelText("New password (min 10 characters)");
      expect([password.getAttribute("name"), password.getAttribute("type")]).toEqual(["password", "password"]);
      expect([password.getAttribute("minlength"), password.getAttribute("autocomplete")]).toEqual([
        "10",
        "new-password",
      ]);
      expect(screen.queryByRole("alert")).toBeNull();
      cleanup();
    }
    expect(deps.repos.auditLogs.all()).toHaveLength(audit);
    expect(await service.checkResetLink(token)).toBe("USABLE");
  });

  it("offers no password form for a link that resets nothing, only the form to ask again", async () => {
    const token = await mailedToken();
    await service.resetPassword(token, "new-password-1");
    for (const unusable of [token, "", ["a", "b"], "unknown", "t".repeat(129)]) {
      render(await ResetPasswordPage(search({ token: unusable })));
      expect(screen.getByRole("heading", { name: "Link not valid" })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toBe(
        "This link does not work. It may have expired or been used already. You can ask for a new one.",
      );
      askingForm();
      expect(screen.queryByLabelText(/New password/)).toBeNull();
      // The token is not echoed back into the page.
      for (const echoed of [token, ...(typeof unusable === "string" && unusable !== "" ? [unusable] : [])]) {
        expect(document.body.innerHTML).not.toContain(echoed);
      }
      cleanup();
    }
  });

  it("says something went wrong, with no password form, when the link cannot be checked", async () => {
    const token = await mailedToken();
    vi.spyOn(deps.repos.accountLinks, "findByTokenHash").mockRejectedValueOnce(new Error("database is down"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    render(await ResetPasswordPage(search({ token })));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(RESET_PASSWORD_NOTICES.failed);
    askingForm();
    expect(screen.queryByLabelText(/New password/)).toBeNull();
    expect(document.body.innerHTML).not.toContain(token);
    vi.restoreAllMocks();
  });

  it("tells no page it leads to more than its origin", () => {
    expect(resetPassword.metadata).toEqual({ referrer: "strict-origin" });
  });
});
