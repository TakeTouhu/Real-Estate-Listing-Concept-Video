import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * The web app's password reset wiring (AT-4c, ADR-0133): links on the
 * configured base address, mail written to the development outbox, the
 * notices the page shows, and failures logged by their error code alone. The
 * domain service and the outbox run for real; only the environment and the
 * identity wiring are stubbed.
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const {
  RESET_PASSWORD_NOTICES,
  askForResetLink,
  openResetLink,
  resetPasswordNotice,
  resetPasswordPage,
  resetPasswordWith,
  resetUrl,
} = await import("./password-reset");

const BASE = "http://localhost:3210";
let deps: TestDeps;
let outbox: string;

beforeEach(async () => {
  deps = createTestDeps();
  identity.value = { deps };
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-reset-lib-"));
  env.value = { NODE_ENV: "test", EMAIL_OUTBOX_DIR: outbox, APP_BASE_URL: BASE };
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  await auth.register({ email: "user@example.com", name: "User", password: "password-123456" });
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const logged = () => ({ error: vi.fn() });

describe("the links and pages", () => {
  it("builds the emailed link on the base address, and a redirect on the request's", () => {
    expect(resetUrl(BASE, "a+b/c")).toBe(`${BASE}/reset-password?token=a%2Bb%2Fc`);
    expect(resetPasswordPage("https://app.example/api/auth/reset-password?x=1", "sent").toString()).toBe(
      "https://app.example/reset-password?notice=sent",
    );
  });

  it("names only its own notices", () => {
    for (const notice of Object.keys(RESET_PASSWORD_NOTICES)) expect(resetPasswordNotice(notice)).toBe(notice);
    for (const other of [undefined, "", "toString", "SENT", "Your password was changed", ["sent"]]) {
      expect(resetPasswordNotice(other)).toBeNull();
    }
  });
});

describe("asking for a link", () => {
  it("mails a link on APP_BASE_URL to the reset page", async () => {
    const log = logged();
    await askForResetLink("user@example.com", log);
    const [mail] = await readDevelopmentEmailOutbox(outbox);
    const link = mail!.text.split("\n").find((line) => line.startsWith(`${BASE}/`));
    expect(new URL(link!).pathname).toBe("/reset-password");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("resolves the same on any failure, logging its code and never the address", async () => {
    for (const unset of ["EMAIL_OUTBOX_DIR", "APP_BASE_URL"]) {
      env.value = { NODE_ENV: "test", EMAIL_OUTBOX_DIR: outbox, APP_BASE_URL: BASE, [unset]: undefined };
      const log = logged();
      await expect(askForResetLink("user@example.com", log)).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith("A password reset link could not be sent", {
        code: "CONFIGURATION_ERROR",
      });
    }
    const log = logged();
    vi.spyOn(deps.repos.users, "findByEmail").mockRejectedValueOnce(new Error("user@example.com is down"));
    await expect(askForResetLink("user@example.com", log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("A password reset link could not be sent", { code: "UNEXPECTED" });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("user@example.com");
  });
});

describe("choosing a new password", () => {
  async function token(): Promise<string> {
    await askForResetLink("user@example.com", logged());
    const [mail] = await readDevelopmentEmailOutbox(outbox);
    const link = mail!.text.split("\n").find((line) => line.startsWith(`${BASE}/`));
    return new URL(link!).searchParams.get("token")!;
  }

  it("opens a link writing nothing, and says failed, logging only the code, when it cannot be checked", async () => {
    const usable = await token();
    const log = logged();
    const audit = deps.repos.auditLogs.all().length;
    expect(await openResetLink(usable, log)).toBe("usable");
    expect(await openResetLink("unknown", log)).toBe("invalid");
    expect(await openResetLink([usable, usable], log)).toBe("invalid");
    expect(log.error).not.toHaveBeenCalled();
    vi.spyOn(deps.repos.accountLinks, "findByTokenHash").mockRejectedValueOnce(new Error(usable));
    expect(await openResetLink(usable, log)).toBe("failed");
    expect(log.error).toHaveBeenCalledWith("A password reset link could not be checked", { code: "UNEXPECTED" });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(usable);
    expect(deps.repos.auditLogs.all()).toHaveLength(audit);
    expect(await openResetLink(usable, log)).toBe("usable");
  });

  it("needs no outbox or base address", async () => {
    const usable = await token();
    env.value = { NODE_ENV: "test" };
    expect(await resetPasswordWith(usable, "new-password-1", logged())).toBe("reset");
  });

  it("names each outcome, logging only an unexpected failure, by its code", async () => {
    const usable = await token();
    const log = logged();
    expect(await resetPasswordWith("unknown", "new-password-1", log)).toBe("invalid");
    expect(await resetPasswordWith(usable, "short", log)).toBe("too-short");
    expect(log.error).not.toHaveBeenCalled();
    vi.spyOn(deps.repos.accountLinks, "useForPasswordReset").mockRejectedValueOnce(new Error(usable));
    expect(await resetPasswordWith(usable, "new-password-1", log)).toBe("failed");
    expect(log.error).toHaveBeenCalledWith("A password could not be reset", { code: "UNEXPECTED" });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(usable);
    expect(await resetPasswordWith(usable, "new-password-1", log)).toBe("reset");
  });
});
