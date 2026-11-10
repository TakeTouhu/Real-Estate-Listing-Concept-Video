import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";
import { PasswordResetService, passwordResetMessage } from "./password-reset-service";

/**
 * Password reset links (AT-4b-1, ADR-0131): a link mailed to the account's
 * address, kept for 1 hour as its token's hash with an audit entry naming no
 * actor before the email leaves. Asking answers the same whether or not the
 * address has an account. A sign-in that checked a password replaced meanwhile
 * makes no session, so a reset (AT-4b-2) can end every session.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const OLD = "password-123456";
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

describe("a sign-in", () => {
  it("makes no session when the password it checked is replaced before the session is made", async () => {
    const { deps, auth, userId } = await setup();
    const verify = deps.passwords.verify.bind(deps.passwords);
    vi.spyOn(deps.passwords, "verify").mockImplementationOnce(async (password, hash) => {
      const ok = await verify(password, hash);
      // What a reset does to the password, between the check and the session.
      const credential = deps.repos.credentials.peek(userId)!;
      deps.repos.credentials.insert({ ...credential, passwordHash: await deps.passwords.hash("replaced-password") });
      return ok;
    });
    await expect(auth.login("owner@example.test", OLD)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Invalid email or password",
    });
    expect(deps.repos.auditLogs.all().filter((e) => e.action === "user.logged_in")).toEqual([]);
    await expect(auth.login("owner@example.test", "replaced-password")).resolves.toMatchObject({
      user: { id: userId },
    });
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

  it("is used by no application yet: the pages and routes arrive in AT-4c", () => {
    const users = sourceFiles(join(REPO_ROOT, "apps")).filter((file) =>
      /PasswordResetService|requestReset\(/.test(readFileSync(file, "utf8")),
    );
    expect(users).toEqual([]);
  });
});
