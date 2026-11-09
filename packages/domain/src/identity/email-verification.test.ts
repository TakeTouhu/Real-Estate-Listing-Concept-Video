import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OutgoingEmail } from "../email/outgoing-email";
import type { EmailSender } from "../email/ports";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { AuthService } from "./auth-service";
import {
  ACCOUNT_LINK_TOKEN_MAX_LENGTH,
  EMAIL_VERIFICATION_LINK_TTL_SECONDS,
  EmailVerificationService,
  emailVerificationMessage,
} from "./email-verification-service";

/**
 * Email verification (AT-3a, ADR-0128): a link mailed to the account's
 * address, kept as its token's hash with an audit entry before the email
 * leaves, which verifies that address once, within 24 hours, while the
 * account is active and still has that address. The web app sends it at
 * sign-up and on request, and opens it from the verify page (AT-3b,
 * ADR-0129).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const HOUR = 60 * 60;
const BASE = "https://app.example.test/verify-email?token=";

class RecordingSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  failing = false;
  send(email: OutgoingEmail): Promise<void> {
    if (this.failing) return Promise.reject(new Error("delivery refused"));
    this.sent.push(email);
    return Promise.resolve();
  }
}

interface Setup {
  deps: TestDeps;
  sender: RecordingSender;
  verification: EmailVerificationService;
  userId: string;
}

async function setup(): Promise<Setup> {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const userId = (await auth.register({ email: "Owner@Example.test", name: "Owner", password: "password-123456" })).id;
  const sender = new RecordingSender();
  const verification = new EmailVerificationService({
    ...deps,
    email: sender,
    verificationUrl: (token) => `${BASE}${token}`,
  });
  return { deps, sender, verification, userId };
}

/** The token in the most recent email. */
function lastToken(sender: RecordingSender): string {
  const text = sender.sent.at(-1)?.text ?? "";
  const line = text.split("\n").find((l) => l.startsWith(BASE));
  if (!line) throw new Error("no link in the email");
  return line.slice(BASE.length);
}

function verificationAudit(deps: TestDeps) {
  return deps.repos.auditLogs.all().filter((entry) => entry.action !== "user.registered");
}

describe("the verification email", () => {
  it("is one plain-text link with what it does, when it ends and what to do if unasked", () => {
    const email = emailVerificationMessage("person@example.test", `${BASE}abc`);
    expect(email).toEqual({
      kind: "EMAIL_VERIFICATION",
      to: "person@example.test",
      subject: "Verify your email address",
      text: [
        "Open the link below to verify the email address of your account.",
        "",
        `${BASE}abc`,
        "",
        "The link works once and expires in 24 hours.",
        "If you did not create an account, you can ignore this email.",
      ].join("\n"),
    });
  });

  it("states the lifetime the link is given", () => {
    expect(EMAIL_VERIFICATION_LINK_TTL_SECONDS).toBe(24 * HOUR);
  });
});

describe("sending a verification link", () => {
  it("keeps the link as its token's hash with one audit entry, then mails the link to the account", async () => {
    const { deps, sender, verification, userId } = await setup();
    const now = deps.clock.now();
    const order: string[] = [];
    const create = deps.repos.accountLinks.create.bind(deps.repos.accountLinks);
    vi.spyOn(deps.repos.accountLinks, "create").mockImplementation((link, audit) => {
      order.push("kept");
      return create(link, audit);
    });
    const send = sender.send.bind(sender);
    vi.spyOn(sender, "send").mockImplementation((email) => {
      order.push("sent");
      return send(email);
    });

    expect(await verification.sendVerificationLink(userId)).toBe("SENT");

    expect(order).toEqual(["kept", "sent"]);
    expect(sender.sent).toHaveLength(1);
    const token = lastToken(sender);
    expect(sender.sent[0]).toEqual(emailVerificationMessage("owner@example.test", `${BASE}${token}`));
    const link = await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token));
    expect(link).toEqual({
      id: expect.any(String),
      userId,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: deps.tokens.hash(token),
      email: "owner@example.test",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * HOUR * 1000),
      usedAt: null,
    });
    // Only the hash is kept; the token itself finds nothing.
    expect(await deps.repos.accountLinks.findByTokenHash(token)).toBeNull();
    expect(verificationAudit(deps)).toEqual([
      expect.objectContaining({
        organizationId: null,
        actorUserId: userId,
        action: "user.email_verification_link_created",
        resourceType: "user",
        resourceId: userId,
        metadata: { linkId: link?.id, email: "owner@example.test" },
      }),
    ]);
  });

  it("makes a new link each time, and the earlier one still works", async () => {
    const { deps, sender, verification, userId } = await setup();
    await verification.sendVerificationLink(userId);
    const first = lastToken(sender);
    await verification.sendVerificationLink(userId);
    const second = lastToken(sender);
    expect(second).not.toBe(first);
    expect(verificationAudit(deps).map((entry) => entry.action)).toEqual([
      "user.email_verification_link_created",
      "user.email_verification_link_created",
    ]);

    expect(await verification.verifyEmail(first)).toBe("VERIFIED");
    expect(await verification.verifyEmail(second)).toBe("ALREADY_VERIFIED");
  });

  it("makes and sends nothing for an address already verified", async () => {
    const { deps, sender, verification, userId } = await setup();
    await verification.sendVerificationLink(userId);
    await verification.verifyEmail(lastToken(sender));
    const create = vi.spyOn(deps.repos.accountLinks, "create");
    const audit = verificationAudit(deps).length;

    expect(await verification.sendVerificationLink(userId)).toBe("ALREADY_VERIFIED");
    expect(create).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(1);
    expect(verificationAudit(deps)).toHaveLength(audit);
  });

  it("refuses an unknown or disabled account, writing and sending nothing", async () => {
    const { deps, sender, verification, userId } = await setup();
    const create = vi.spyOn(deps.repos.accountLinks, "create");
    const notFound = { code: "NOT_FOUND", message: "Account not found" };
    await expect(verification.sendVerificationLink("usr_missing")).rejects.toMatchObject(notFound);
    const user = deps.repos.users.peek(userId);
    if (!user) throw new Error("no user");
    deps.repos.users.put({ ...user, status: "DISABLED" });
    await expect(verification.sendVerificationLink(userId)).rejects.toMatchObject(notFound);
    expect(create).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([]);
    expect(verificationAudit(deps)).toEqual([]);
  });

  it("refuses an address mail cannot reach before anything is written", async () => {
    const { deps, sender, verification, userId } = await setup();
    const user = deps.repos.users.peek(userId);
    if (!user) throw new Error("no user");
    deps.repos.users.put({ ...user, email: "名前@example.test" });
    const create = vi.spyOn(deps.repos.accountLinks, "create");
    await expect(verification.sendVerificationLink(userId)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The email's recipient is not an address mail can be sent to",
    });
    expect(create).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([]);
    expect(verificationAudit(deps)).toEqual([]);
  });

  it("keeps no link and sends nothing when the link's audit entry cannot be written", async () => {
    const { deps, sender, verification, userId } = await setup();
    const create = vi.spyOn(deps.repos.accountLinks, "create");
    vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit down"));
    await expect(verification.sendVerificationLink(userId)).rejects.toThrow("audit down");
    expect(sender.sent).toEqual([]);
    const tried = create.mock.calls[0]?.[0];
    if (!tried) throw new Error("no link tried");
    expect(await deps.repos.accountLinks.findByTokenHash(tried.tokenHash)).toBeNull();
  });

  it("keeps the link when the email is not accepted, so asking again is safe", async () => {
    const { deps, sender, verification, userId } = await setup();
    sender.failing = true;
    await expect(verification.sendVerificationLink(userId)).rejects.toThrow("delivery refused");
    // The link was made; the entry says no more than that.
    const actions = verificationAudit(deps).map((entry) => entry.action);
    expect(actions).toEqual(["user.email_verification_link_created"]);
    sender.failing = false;
    expect(await verification.sendVerificationLink(userId)).toBe("SENT");
    expect(await verification.verifyEmail(lastToken(sender))).toBe("VERIFIED");
  });
});

describe("opening a verification link", () => {
  async function sent(): Promise<Setup & { token: string }> {
    const s = await setup();
    await s.verification.sendVerificationLink(s.userId);
    return { ...s, token: lastToken(s.sender) };
  }

  it("verifies the address and uses the link at the same moment, with one audit entry", async () => {
    const { deps, verification, userId, token } = await sent();
    deps.clock.advanceSeconds(HOUR);
    const now = deps.clock.now();

    expect(await verification.verifyEmail(token)).toBe("VERIFIED");

    expect((await deps.repos.users.findById(userId))?.emailVerifiedAt).toEqual(now);
    const link = await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token));
    expect(link?.usedAt).toEqual(now);
    expect(verificationAudit(deps).at(-1)).toEqual(
      expect.objectContaining({
        organizationId: null,
        actorUserId: userId,
        action: "user.email_verified",
        resourceType: "user",
        resourceId: userId,
        metadata: { linkId: link?.id, email: "owner@example.test" },
      }),
    );
  });

  it("answers ALREADY_VERIFIED when opened again, writing nothing", async () => {
    const { deps, verification, token } = await sent();
    await verification.verifyEmail(token);
    const use = vi.spyOn(deps.repos.accountLinks, "useForEmailVerification");
    const audit = verificationAudit(deps).length;
    expect(await verification.verifyEmail(token)).toBe("ALREADY_VERIFIED");
    expect(use).not.toHaveBeenCalled();
    expect(verificationAudit(deps)).toHaveLength(audit);
  });

  it("works until the last moment before 24 hours and not at 24 hours", async () => {
    const early = await sent();
    early.deps.clock.advanceSeconds(24 * HOUR - 0.001);
    expect(await early.verification.verifyEmail(early.token)).toBe("VERIFIED");

    const late = await sent();
    late.deps.clock.advanceSeconds(24 * HOUR);
    const use = vi.spyOn(late.deps.repos.accountLinks, "useForEmailVerification");
    expect(await late.verification.verifyEmail(late.token)).toBe("INVALID");
    expect(use).not.toHaveBeenCalled();
    expect((await late.deps.repos.users.findById(late.userId))?.emailVerifiedAt).toBeNull();
  });

  it("answers INVALID for a token that is empty, not text or unknown, without a lookup for the first two", async () => {
    const { deps, verification } = await sent();
    const find = vi.spyOn(deps.repos.accountLinks, "findByTokenHash");
    expect(await verification.verifyEmail("")).toBe("INVALID");
    expect(await verification.verifyEmail(42 as unknown as string)).toBe("INVALID");
    expect(find).not.toHaveBeenCalled();
    expect(await verification.verifyEmail("token_unknown")).toBe("INVALID");
  });

  it("looks up no token longer than 128 characters, and still verifies with one of 128 (ADR-0129)", async () => {
    expect(ACCOUNT_LINK_TOKEN_MAX_LENGTH).toBe(128);
    for (const length of [129, 128]) {
      const { deps, verification, userId } = await setup();
      const token = "t".repeat(length);
      const now = deps.clock.now();
      await deps.repos.accountLinks.create(
        {
          id: `lnk_${length}`,
          userId,
          purpose: "EMAIL_VERIFICATION",
          tokenHash: deps.tokens.hash(token),
          email: "owner@example.test",
          createdAt: now,
          expiresAt: new Date(now.getTime() + HOUR * 1000),
        },
        {
          organizationId: null,
          actorUserId: userId,
          action: "test",
          resourceType: "user",
          resourceId: userId,
          metadata: {},
        },
      );
      const find = vi.spyOn(deps.repos.accountLinks, "findByTokenHash");
      expect(await verification.verifyEmail(token)).toBe(length === 128 ? "VERIFIED" : "INVALID");
      expect(find).toHaveBeenCalledTimes(length === 128 ? 1 : 0);
    }
  });

  it("answers INVALID for a link made for another purpose", async () => {
    const { deps, verification, userId } = await setup();
    const now = deps.clock.now();
    await deps.repos.accountLinks.create(
      {
        id: "lnk_reset",
        userId,
        purpose: "PASSWORD_RESET",
        tokenHash: deps.tokens.hash("reset-token"),
        email: "owner@example.test",
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR * 1000),
      },
      {
        organizationId: null,
        actorUserId: userId,
        action: "test",
        resourceType: "user",
        resourceId: userId,
        metadata: {},
      },
    );
    const use = vi.spyOn(deps.repos.accountLinks, "useForEmailVerification");
    expect(await verification.verifyEmail("reset-token")).toBe("INVALID");
    expect(use).not.toHaveBeenCalled();
    expect((await deps.repos.users.findById(userId))?.emailVerifiedAt).toBeNull();
  });

  it("answers INVALID once the account is disabled, gone, or has another address", async () => {
    const disabled = await sent();
    const user = disabled.deps.repos.users.peek(disabled.userId);
    if (!user) throw new Error("no user");
    disabled.deps.repos.users.put({ ...user, status: "DISABLED" });
    const disabledUse = vi.spyOn(disabled.deps.repos.accountLinks, "useForEmailVerification");
    expect(await disabled.verification.verifyEmail(disabled.token)).toBe("INVALID");
    expect(disabledUse).not.toHaveBeenCalled();

    const gone = await sent();
    vi.spyOn(gone.deps.repos.users, "findById").mockResolvedValue(null);
    expect(await gone.verification.verifyEmail(gone.token)).toBe("INVALID");

    const moved = await sent();
    const before = moved.deps.repos.users.peek(moved.userId);
    if (!before) throw new Error("no user");
    moved.deps.repos.users.put({ ...before, email: "elsewhere@example.test" });
    const movedUse = vi.spyOn(moved.deps.repos.accountLinks, "useForEmailVerification");
    expect(await moved.verification.verifyEmail(moved.token)).toBe("INVALID");
    expect(movedUse).not.toHaveBeenCalled();
    expect(moved.deps.repos.users.peek(moved.userId)?.emailVerifiedAt).toBeNull();
  });

  it("answers INVALID for a link already used while the address is not verified", async () => {
    const { deps, verification, token } = await sent();
    const link = await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token));
    if (!link) throw new Error("no link");
    vi.spyOn(deps.repos.accountLinks, "findByTokenHash").mockResolvedValue({ ...link, usedAt: deps.clock.now() });
    const use = vi.spyOn(deps.repos.accountLinks, "useForEmailVerification");
    expect(await verification.verifyEmail(token)).toBe("INVALID");
    expect(use).not.toHaveBeenCalled();
  });

  it("answers VERIFIED once and ALREADY_VERIFIED to the rest when opened several times at once", async () => {
    const { deps, sender, verification, userId, token } = await sent();
    await verification.sendVerificationLink(userId);
    const other = lastToken(sender);
    const outcomes = await Promise.all([token, token, other, token].map((t) => verification.verifyEmail(t)));
    expect(outcomes.filter((o) => o === "VERIFIED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_VERIFIED")).toHaveLength(3);
    expect(verificationAudit(deps).filter((entry) => entry.action === "user.email_verified")).toHaveLength(1);
  });

  it("answers INVALID when another link verified a different address meanwhile", async () => {
    const { deps, verification, userId, token } = await sent();
    vi.spyOn(deps.repos.accountLinks, "useForEmailVerification").mockImplementation(() => {
      const user = deps.repos.users.peek(userId);
      if (!user) throw new Error("no user");
      deps.repos.users.put({ ...user, email: "elsewhere@example.test", emailVerifiedAt: deps.clock.now() });
      return Promise.resolve("STALE");
    });
    expect(await verification.verifyEmail(token)).toBe("INVALID");
  });

  it("answers INVALID when the write was refused and the address is still not verified", async () => {
    const { deps, verification, token } = await sent();
    vi.spyOn(deps.repos.accountLinks, "useForEmailVerification").mockResolvedValue("STALE");
    expect(await verification.verifyEmail(token)).toBe("INVALID");
  });

  it("changes nothing when the audit entry cannot be written", async () => {
    const { deps, verification, userId, token } = await sent();
    vi.spyOn(deps.repos.auditLogs, "append").mockRejectedValueOnce(new Error("audit down"));
    await expect(verification.verifyEmail(token)).rejects.toThrow("audit down");
    expect(deps.repos.users.peek(userId)?.emailVerifiedAt).toBeNull();
    expect((await deps.repos.accountLinks.findByTokenHash(deps.tokens.hash(token)))?.usedAt).toBeNull();
    expect(await verification.verifyEmail(token)).toBe("VERIFIED");
  });
});

describe("the in-memory links", () => {
  const AUDIT = {
    organizationId: null,
    actorUserId: "usr_1",
    action: "test",
    resourceType: "user",
    resourceId: "usr_1",
    metadata: {},
  };

  async function withLink() {
    const s = await setup();
    const now = s.deps.clock.now();
    const link = {
      id: "lnk_a",
      userId: s.userId,
      purpose: "EMAIL_VERIFICATION" as const,
      tokenHash: "hash:a",
      email: "owner@example.test",
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUR * 1000),
    };
    await s.deps.repos.accountLinks.create(link, AUDIT);
    const use = (overrides: { usedAt?: Date } = {}) =>
      s.deps.repos.accountLinks.useForEmailVerification({
        linkId: link.id,
        userId: s.userId,
        email: link.email,
        usedAt: overrides.usedAt ?? now,
        audit: AUDIT,
      });
    return { ...s, link, use, now };
  }

  it("refuses what the table refuses: a taken id or hash, an unknown user, an empty window", async () => {
    const { deps, link, now } = await withLink();
    const links = deps.repos.accountLinks;
    await expect(links.create({ ...link, tokenHash: "hash:b" }, AUDIT)).rejects.toThrow("`id`");
    await expect(links.create({ ...link, id: "lnk_b" }, AUDIT)).rejects.toThrow("`tokenHash`");
    const unknownUser = { ...link, id: "lnk_c", tokenHash: "hash:c", userId: "usr_missing" };
    await expect(links.create(unknownUser, AUDIT)).rejects.toThrow("account_links_userId_fkey");
    await expect(links.create({ ...link, id: "lnk_d", tokenHash: "hash:d", expiresAt: now }, AUDIT)).rejects.toThrow(
      "account_links_window_check",
    );
    expect((await links.findByTokenHash("hash:a"))?.id).toBe("lnk_a");
    for (const hash of ["hash:b", "hash:c", "hash:d"]) expect(await links.findByTokenHash(hash)).toBeNull();
  });

  it("answers STALE and writes nothing for a disabled, moved or verified account", async () => {
    const { deps, userId, use } = await withLink();
    const user = deps.repos.users.peek(userId);
    if (!user) throw new Error("no user");
    for (const changed of [
      { ...user, status: "DISABLED" as const },
      { ...user, email: "elsewhere@example.test" },
      { ...user, emailVerifiedAt: deps.clock.now() },
    ]) {
      deps.repos.users.put(changed);
      expect(await use()).toBe("STALE");
      expect(deps.repos.users.peek(userId)).toEqual(changed);
      expect((await deps.repos.accountLinks.findByTokenHash("hash:a"))?.usedAt).toBeNull();
    }
  });

  it("refuses a use before the link was made, as the table's CHECK does, writing nothing", async () => {
    const { deps, userId, link, use } = await withLink();
    await expect(use({ usedAt: new Date(link.createdAt.getTime() - 1) })).rejects.toThrow("account_links_window_check");
    expect(deps.repos.users.peek(userId)?.emailVerifiedAt).toBeNull();
    expect((await deps.repos.accountLinks.findByTokenHash("hash:a"))?.usedAt).toBeNull();
  });

  it("answers STALE and writes nothing for a link expired, used or of another purpose", async () => {
    const expired = await withLink();
    expect(await expired.use({ usedAt: expired.link.expiresAt })).toBe("STALE");
    expect(expired.deps.repos.users.peek(expired.userId)?.emailVerifiedAt).toBeNull();

    const used = await withLink();
    expect(await used.use()).toBe("APPLIED");
    const user = used.deps.repos.users.peek(used.userId);
    if (!user) throw new Error("no user");
    used.deps.repos.users.put({ ...user, emailVerifiedAt: null });
    expect(await used.use()).toBe("STALE");
    expect(used.deps.repos.users.peek(used.userId)?.emailVerifiedAt).toBeNull();

    const other = await setup();
    const now = other.deps.clock.now();
    await other.deps.repos.accountLinks.create(
      {
        id: "lnk_reset",
        userId: other.userId,
        purpose: "PASSWORD_RESET",
        tokenHash: "hash:reset",
        email: "owner@example.test",
        createdAt: now,
        expiresAt: new Date(now.getTime() + HOUR * 1000),
      },
      AUDIT,
    );
    const outcome = await other.deps.repos.accountLinks.useForEmailVerification({
      linkId: "lnk_reset",
      userId: other.userId,
      email: "owner@example.test",
      usedAt: now,
      audit: AUDIT,
    });
    expect(outcome).toBe("STALE");
    expect((await other.deps.repos.accountLinks.findByTokenHash("hash:reset"))?.usedAt).toBeNull();
  });
});

describe("who uses it", () => {
  /** Comments stripped, so prose naming a symbol is not mistaken for using it. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  function sourceFiles(dir: string): { name: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
      return [{ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) }];
    });
  }

  it("is built in one web module, sends from it alone and verifies from one route; the worker never uses it", () => {
    const files = sourceFiles(join(REPO_ROOT, "apps"));
    expect(files.map(({ name }) => name)).toContain("apps/web/src/lib/identity.ts");
    const users = (names: readonly string[]) =>
      files.filter(({ text }) => names.some((name) => text.includes(name))).map(({ name }) => name);
    // ADR-0129: sign-up and the resend route send through `sendVerificationLinkTo`; the verify route opens a link.
    expect(users(["new EmailVerificationService", ".sendVerificationLink("])).toEqual([
      "apps/web/src/lib/email-verification.ts",
    ]);
    expect(users([".verifyEmail("])).toEqual(["apps/web/src/app/api/auth/verify-email/route.ts"]);
    // Whether an address is verified is read by the domain's sign-in step alone, and links by the repository.
    expect(users(["emailVerifiedAt", "accountLinks"])).toEqual([]);
  });
});
