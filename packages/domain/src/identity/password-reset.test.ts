import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";
import { ACCOUNT_LINK_TOKEN_MAX_LENGTH, EmailVerificationService } from "./email-verification-service";
import { PasswordResetService, passwordResetMessage } from "./password-reset-service";

/**
 * Password reset (AT-4b, ADR-0131 and ADR-0132): a link mailed to the
 * account's address, kept for 1 hour as its token's hash with an audit entry
 * naming no actor before the email leaves. Asking answers the same whether or
 * not the address has an account. Within the hour the link replaces the
 * password once, ends every session of the account and deletes its other
 * unused reset links, in one transaction. A sign-in that checked the old
 * password makes no session once a reset commits.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const OLD = "password-123456";
const NEW = "another-password-789";
const BASE = "https://app.example.test/reset-password?token=";
const HOUR_MS = 60 * 60 * 1000;

class RecordingSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  failing = false;
  send(email: OutgoingEmail): Promise<void> {
    if (this.failing) return Promise.reject(new Error("delivery refused"));
    this.sent.push(email);
    return Promise.resolve();
  }
}

async function setup() {
  const deps: TestDeps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const userId = (await auth.register({ email: "Owner@Example.test", name: "Owner", password: OLD })).id;
  const sender = new RecordingSender();
  const reset = new PasswordResetService({ ...deps, email: sender, resetUrl: (token) => `${BASE}${token}` });
  return { deps, auth, sender, reset, userId };
}

/** The token in the most recent email. */
function lastToken(sender: RecordingSender): string {
  const line = sender.sent.at(-1)?.text.split("\n").find((l) => l.startsWith(BASE));
  if (!line) throw new Error("no link in the email");
  return line.slice(BASE.length);
}

/** The token in the most recent verification email (`verify:` links). */
function lastVerificationToken(sender: RecordingSender): string {
  const line = sender.sent.at(-1)?.text.split("\n").find((l) => l.startsWith("verify:"));
  if (!line) throw new Error("no verification link in the email");
  return line.slice("verify:".length);
}

function actions(deps: TestDeps): string[] {
  return deps.repos.auditLogs
    .all()
    .map((entry) => entry.action)
    .filter((action) => action !== "user.registered" && action !== "user.logged_in");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the reset email", () => {
  it("carries the link, says it works once for 1 hour and signs the account out everywhere", () => {
    const message = passwordResetMessage("owner@example.test", `${BASE}abc`);
    expect(message).toMatchObject({ kind: "PASSWORD_RESET", to: "owner@example.test", subject: "Reset your password" });
    expect(message.text.split("\n")).toEqual(
      expect.arrayContaining([
        `${BASE}abc`,
        "The link works once and expires in 1 hour.",
        "Choosing a new password signs your account out everywhere.",
      ]),
    );
  });
});

describe("asking for a link", () => {
  it("keeps the link's hash for 1 hour with an entry naming no actor, then mails it", async () => {
    const { deps, sender, reset, userId } = await setup();
    await expect(reset.requestReset("  OWNER@example.TEST ")).resolves.toBeUndefined();
    const token = lastToken(sender);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("owner@example.test");
    const link = await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token));
    expect(link).toMatchObject({ userId, purpose: "PASSWORD_RESET", email: "owner@example.test", usedAt: null });
    expect(link!.expiresAt.getTime() - link!.createdAt.getTime()).toBe(HOUR_MS);
    expect(deps.repos.auditLogs.all().at(-1)).toMatchObject({
      organizationId: null,
      actorUserId: null,
      action: "user.password_reset_link_created",
      resourceType: "user",
      resourceId: userId,
      metadata: { linkId: link!.id, email: "owner@example.test" },
    });
  });

  it("answers the same and does nothing for no account, a disabled one or an address mail cannot reach", async () => {
    const { deps, sender, reset, userId } = await setup();
    deps.repos.users.put({ ...deps.repos.users.peek(userId)!, status: "DISABLED" });
    // An account from before sign-up refused such addresses (ADR-0129).
    const old = { id: "usr_old", email: "old@localhost", name: "Old", status: "ACTIVE" as const };
    const registered = { organizationId: null, actorUserId: old.id, action: "user.registered", resourceType: "user" };
    await deps.repos.users.register({
      user: old,
      passwordHash: "fake:x",
      audit: { ...registered, resourceId: old.id, metadata: {} },
    });
    for (const address of ["nobody@example.test", "owner@example.test", "not an address", "old@localhost"]) {
      await expect(reset.requestReset(address)).resolves.toBeUndefined();
    }
    expect(sender.sent).toEqual([]);
    expect(actions(deps)).toEqual([]);
  });

  it("keeps no link and sends nothing when its audit entry fails", async () => {
    const { deps, sender, reset } = await setup();
    const generated = vi.spyOn(deps.tokens, "generate");
    vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit store down"));
    await expect(reset.requestReset("owner@example.test")).rejects.toThrow("audit store down");
    expect(sender.sent).toEqual([]);
    expect(generated).toHaveBeenCalledTimes(1);
    const token = generated.mock.results[0]!.value as string;
    expect(await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token))).toBeNull();
  });
});

describe("resetting the password", () => {
  it("replaces the password, uses the link and ends every session of the account, in one entry", async () => {
    const { deps, auth, sender, reset, userId } = await setup();
    const other = await auth.register({ email: "other@example.test", name: "Other", password: OLD });
    const mine = [await auth.login("owner@example.test", OLD), await auth.login("owner@example.test", OLD)];
    const theirs = await auth.login("other@example.test", OLD);
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    expect(await reset.checkResetLink(token)).toBe("USABLE");

    expect(await reset.resetPassword(token, NEW)).toBe("RESET");

    for (const { token: session } of mine) expect(await auth.resolveSession(session)).toBeNull();
    expect(await auth.resolveSession(theirs.token)).toMatchObject({ user: { id: other.id } });
    await expect(auth.login("owner@example.test", OLD)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(auth.login("owner@example.test", NEW)).resolves.toMatchObject({ user: { id: userId } });
    expect(await reset.checkResetLink(token)).toBe("INVALID");
    expect(await reset.resetPassword(token, "yet-another-password")).toBe("INVALID");
    const link = await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token));
    expect(deps.repos.auditLogs.all().filter((e) => e.action === "user.password_reset")).toEqual([
      expect.objectContaining({
        organizationId: null,
        actorUserId: userId,
        resourceType: "user",
        resourceId: userId,
        metadata: { linkId: link!.id, email: "owner@example.test" },
      }),
    ]);
  });

  it("deletes the account's other unused reset links, and leaves its verification links and address", async () => {
    const { deps, sender, reset, userId } = await setup();
    const verifyUrl = (t: string): string => `verify:${t}`;
    const verification = new EmailVerificationService({ ...deps, email: sender, verificationUrl: verifyUrl });
    await verification.sendVerificationLink(userId);
    const verifying = lastVerificationToken(sender);
    await reset.requestReset("owner@example.test");
    const first = lastToken(sender);
    await reset.requestReset("owner@example.test");
    const second = lastToken(sender);
    expect(await reset.resetPassword(second, NEW)).toBe("RESET");
    expect(await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(first))).toBeNull();
    expect(await reset.resetPassword(first, "yet-another-password")).toBe("INVALID");
    expect(await verification.verifyEmail(verifying)).toBe("VERIFIED");
  });

  it("works until the hour ends, and not at its end", async () => {
    const { deps, sender, reset } = await setup();
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    const start = deps.clock.now().getTime();
    deps.clock.set(new Date(start + HOUR_MS));
    expect(await reset.checkResetLink(token)).toBe("INVALID");
    expect(await reset.resetPassword(token, NEW)).toBe("INVALID");
    deps.clock.set(new Date(start + HOUR_MS - 1));
    expect(await reset.resetPassword(token, NEW)).toBe("RESET");
  });

  it("refuses a password under 10 characters and leaves the link usable, but checks the link first", async () => {
    const { sender, reset } = await setup();
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    await expect(reset.resetPassword(token, "123456789")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Password is too short",
    });
    expect(await reset.checkResetLink(token)).toBe("USABLE");
    expect(await reset.resetPassword("unknown-token", "short")).toBe("INVALID");
    expect(await reset.resetPassword(token, "1234567890")).toBe("RESET");
  });

  it("resets nothing for an unknown, overlong or verification token, or an account changed since", async () => {
    const { deps, sender, reset, userId } = await setup();
    const verifyUrl = (t: string): string => `verify:${t}`;
    const verification = new EmailVerificationService({ ...deps, email: sender, verificationUrl: verifyUrl });
    await verification.sendVerificationLink(userId);
    const verifying = lastVerificationToken(sender);
    for (const token of ["", verifying, "unknown-token", "x".repeat(129)]) {
      expect(await reset.checkResetLink(token)).toBe("INVALID");
      expect(await reset.resetPassword(token, NEW)).toBe("INVALID");
    }
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    const user = deps.repos.users.peek(userId)!;
    for (const changed of [{ ...user, status: "DISABLED" as const }, { ...user, email: "moved@example.test" }]) {
      deps.repos.users.put(changed);
      expect(await reset.checkResetLink(token)).toBe("INVALID");
      expect(await reset.resetPassword(token, NEW)).toBe("INVALID");
    }
    deps.repos.users.put(user);
    deps.repos.credentials.remove(userId);
    expect(await reset.checkResetLink(token)).toBe("INVALID");
    expect(await reset.resetPassword(token, NEW)).toBe("INVALID");
    expect(actions(deps).filter((a) => a === "user.password_reset")).toEqual([]);
  });

  it("looks up no token that is empty, not text or over 128 characters, and still resets with one of 128", async () => {
    expect(ACCOUNT_LINK_TOKEN_MAX_LENGTH).toBe(128);
    for (const length of [129, 128]) {
      const { deps, reset, userId } = await setup();
      const token = "t".repeat(length);
      const now = deps.clock.now();
      const link = { id: `lnk_${length}`, userId, purpose: "PASSWORD_RESET" as const, email: "owner@example.test" };
      const audit = { organizationId: null, actorUserId: null, action: "test", resourceType: "user", metadata: {} };
      await deps.repos.accountLinks.create(
        { ...link, tokenHash: deps.tokens.hash(token), createdAt: now, expiresAt: new Date(now.getTime() + HOUR_MS) },
        { ...audit, resourceId: userId },
      );
      const find = vi.spyOn(deps.repos.accountLinks, "findByTokenHash");
      const expected = length === 128 ? ["USABLE", "RESET"] : ["INVALID", "INVALID"];
      expect([await reset.checkResetLink(token), await reset.resetPassword(token, NEW)]).toEqual(expected);
      expect(find).toHaveBeenCalledTimes(length === 128 ? 2 : 0);
      if (length === 128) continue;
      for (const odd of ["", 42 as unknown as string]) {
        expect(await reset.checkResetLink(odd)).toBe("INVALID");
        expect(await reset.resetPassword(odd, NEW)).toBe("INVALID");
      }
      expect(find).not.toHaveBeenCalled();
    }
  });

  it("refuses a password that is not text, for a usable link", async () => {
    const { sender, reset } = await setup();
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    await expect(reset.resetPassword(token, 1234567890 as unknown as string)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await reset.checkResetLink(token)).toBe("USABLE");
  });

  it("resets once when one link is opened twice at once", async () => {
    const { deps, sender, reset } = await setup();
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    const outcomes = await Promise.all([NEW, "third-password-1"].map((p) => reset.resetPassword(token, p)));
    expect(outcomes.sort()).toEqual(["INVALID", "RESET"]);
    expect(actions(deps).filter((a) => a === "user.password_reset")).toHaveLength(1);
  });

  it("changes nothing when its audit entry fails", async () => {
    const { deps, auth, sender, reset } = await setup();
    const session = await auth.login("owner@example.test", OLD);
    await reset.requestReset("owner@example.test");
    const other = lastToken(sender);
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit store down"));
    await expect(reset.resetPassword(token, NEW)).rejects.toThrow("audit store down");
    expect(await auth.resolveSession(session.token)).not.toBeNull();
    await expect(auth.login("owner@example.test", OLD)).resolves.toBeDefined();
    expect(await reset.checkResetLink(token)).toBe("USABLE");
    expect(await reset.checkResetLink(other)).toBe("USABLE");
  });
});

describe("a sign-in during a reset", () => {
  it("makes no session when the reset commits after its password was checked", async () => {
    const { deps, auth, sender, reset, userId } = await setup();
    await reset.requestReset("owner@example.test");
    const token = lastToken(sender);
    const verify = deps.passwords.verify.bind(deps.passwords);
    vi.spyOn(deps.passwords, "verify").mockImplementationOnce(async (password, hash) => {
      const ok = await verify(password, hash);
      expect(await reset.resetPassword(token, NEW)).toBe("RESET");
      return ok;
    });
    await expect(auth.login("owner@example.test", OLD)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Invalid email or password",
    });
    expect(actions(deps).filter((a) => a === "user.password_reset")).toHaveLength(1);
    expect(deps.repos.auditLogs.all().filter((e) => e.action === "user.logged_in")).toEqual([]);
    await expect(auth.login("owner@example.test", NEW)).resolves.toMatchObject({ user: { id: userId } });
  });
});

describe("who uses it", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
    });
  }

  it("is used only by the web app's reset page and its wiring (AT-4c, ADR-0133), never by the worker", () => {
    const users = sourceFiles(join(REPO_ROOT, "apps")).filter((file) =>
      /PasswordResetService|requestReset\(|resetPassword\(|checkResetLink\(/.test(readFileSync(file, "utf8")),
    );
    expect(users.map((file) => file.slice(REPO_ROOT.length + 1)).sort()).toEqual([
      "apps/web/src/app/reset-password/page.tsx",
      "apps/web/src/lib/password-reset.ts",
    ]);
  });
});
