import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "@app/domain";
import { createTestDeps, type TestDeps } from "@app/domain/testing";
import { readDevelopmentEmailOutbox } from "@app/storage";

/**
 * The web app's email verification wiring (AT-3b, ADR-0129): links built on
 * the configured base address, mail written to the development outbox, and
 * nothing written when either is missing. The domain service and the outbox
 * run for real; only the environment and the identity wiring are stubbed.
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const identity = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => identity.value }));

const {
  VERIFY_EMAIL_NOTICES,
  getEmailVerificationService,
  sendVerificationLinkTo,
  verificationUrl,
  verifyEmailNotice,
  verifyEmailPage,
} = await import("./email-verification");
const { nextPageFor } = await import("./auth");

const BASE = "http://localhost:3210";
let deps: TestDeps;
let outbox: string;
let userId: string;

beforeEach(async () => {
  deps = createTestDeps();
  identity.value = { deps };
  outbox = mkdtempSync(join(tmpdir(), "vtavision-outbox-test-"));
  env.value = { NODE_ENV: "test", EMAIL_OUTBOX_DIR: outbox, APP_BASE_URL: BASE };
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  userId = (await auth.register({ email: "new@example.com", name: "New", password: "password-123456" })).id;
});

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
});

const linkActions = () =>
  deps.repos.auditLogs.all().filter((entry) => entry.action === "user.email_verification_link_created");
const silentLog = () => ({ error: vi.fn() });

/** The link in the newest email, read from the outbox as a person would read their inbox. */
async function mailedLink(): Promise<URL> {
  const messages = await readDevelopmentEmailOutbox(outbox);
  const line = messages.at(-1)?.text.split("\n").find((text) => text.startsWith(`${BASE}/`));
  if (!line) throw new Error("no link mailed");
  return new URL(line);
}

describe("the links and pages", () => {
  it("builds a link to the verify page on the configured base address, the token encoded", () => {
    expect(verificationUrl(BASE, "abc_-9")).toBe(`${BASE}/verify-email?token=abc_-9`);
    expect(verificationUrl(`${BASE}/`, "abc")).toBe(`${BASE}/verify-email?token=abc`);
    expect(verificationUrl("https://app.example.com", "a+b/c=&d")).toBe(
      "https://app.example.com/verify-email?token=a%2Bb%2Fc%3D%26d",
    );
    expect(new URL(verificationUrl(BASE, "t")).pathname).toBe(nextPageFor("EMAIL_VERIFICATION_REQUIRED"));
  });

  it("names a notice only by a code it knows", () => {
    for (const notice of Object.keys(VERIFY_EMAIL_NOTICES)) expect(verifyEmailNotice(notice)).toBe(notice);
    for (const other of [undefined, "", "other", "__proto__", "toString", "constructor", "Sent", ["sent"]]) {
      expect(verifyEmailNotice(other)).toBeNull();
    }
  });

  it("sends a redirect to the verify page on the request's own address", () => {
    expect(verifyEmailPage("http://localhost:3000/api/auth/register").toString()).toBe(
      "http://localhost:3000/verify-email",
    );
    expect(verifyEmailPage("http://localhost:3000/api/auth/register?x=1", "not-sent").toString()).toBe(
      "http://localhost:3000/verify-email?notice=not-sent",
    );
  });
});

describe("sending a link", () => {
  it("writes the email to the outbox, with a link on the base address that verifies the account", async () => {
    expect(await sendVerificationLinkTo(userId, silentLog())).toBe("SENT");
    const messages = await readDevelopmentEmailOutbox(outbox);
    expect(messages.map(({ kind, to, subject }) => ({ kind, to, subject }))).toEqual([
      { kind: "EMAIL_VERIFICATION", to: "new@example.com", subject: "Verify your email address" },
    ]);
    const link = await mailedLink();
    expect(link.origin + link.pathname).toBe(`${BASE}/verify-email`);
    expect(await getEmailVerificationService().verifyEmail(link.searchParams.get("token")!)).toBe("VERIFIED");
    expect(deps.repos.users.peek(userId)?.emailVerifiedAt).toEqual(deps.clock.now());
  });

  it("answers ALREADY_VERIFIED for a verified account, sending nothing", async () => {
    await sendVerificationLinkTo(userId, silentLog());
    await getEmailVerificationService().verifyEmail((await mailedLink()).searchParams.get("token")!);
    expect(await sendVerificationLinkTo(userId, silentLog())).toBe("ALREADY_VERIFIED");
    expect(await readDevelopmentEmailOutbox(outbox)).toHaveLength(1);
  });

  for (const missing of ["EMAIL_OUTBOX_DIR", "APP_BASE_URL"]) {
    it(`writes and sends nothing without ${missing}, and logs only the code and the user`, async () => {
      env.value = { ...env.value, [missing]: undefined };
      const log = silentLog();
      expect(await sendVerificationLinkTo(userId, log)).toBe("NOT_SENT");
      expect(log.error).toHaveBeenCalledExactlyOnceWith("A verification email could not be sent", {
        code: "CONFIGURATION_ERROR",
        userId,
      });
      expect(linkActions()).toEqual([]);
      expect(await readDevelopmentEmailOutbox(outbox)).toEqual([]);
    });
  }

  it("logs a failure that is not the product's own error as UNEXPECTED", async () => {
    vi.spyOn(deps.repos.users, "findById").mockRejectedValueOnce(new Error("connection lost to new@example.com"));
    const log = silentLog();
    expect(await sendVerificationLinkTo(userId, log)).toBe("NOT_SENT");
    expect(log.error).toHaveBeenCalledExactlyOnceWith("A verification email could not be sent", {
      code: "UNEXPECTED",
      userId,
    });
  });

  it("opens a link with neither setting, since opening one sends nothing", async () => {
    await sendVerificationLinkTo(userId, silentLog());
    const token = (await mailedLink()).searchParams.get("token")!;
    env.value = { NODE_ENV: "test" };
    expect(await getEmailVerificationService().verifyEmail(token)).toBe("VERIFIED");
  });
});
