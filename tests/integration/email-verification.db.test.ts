import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, EmailVerificationService, sha256TokenService, type OutgoingEmail } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, TestClock } from "@app/domain/testing";

/**
 * Email verification against PostgreSQL (AT-3a, ADR-0128): a link and its
 * audit entry commit together; the table keeps only a SHA-256 hex hash and a
 * window that ends after it starts; opening a link verifies the address, uses
 * the link and audits it in one transaction, exactly once however many times
 * it is opened at once; and deleting a user deletes its links.
 */

const DOMAIN = "email-verify.itest";
const BASE = "https://app.example.test/verify-email?token=";
const HOUR_MS = 60 * 60 * 1000;

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-11-09T00:00:00.000Z"));
const sent: OutgoingEmail[] = [];
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_email_verify_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: sha256TokenService,
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const verification = new EmailVerificationService({
  ...deps,
  email: {
    send: (email) => {
      sent.push(email);
      return Promise.resolve();
    },
  },
  verificationUrl: (token) => `${BASE}${token}`,
});

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { resourceId: { in: ids } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  sent.length = 0;
  clock.set(new Date("2026-11-09T00:00:00.000Z"));
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function user(name: string): Promise<string> {
  return (await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" })).id;
}

function lastToken(): string {
  const line = sent.at(-1)?.text.split("\n").find((l) => l.startsWith(BASE));
  if (!line) throw new Error("no link in the email");
  return line.slice(BASE.length);
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { resourceId: userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.action).filter((a) => a !== "user.registered");
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the opening never waited on the rival's lock");
}

function linkRow(userId: string, overrides: Record<string, unknown> = {}) {
  const createdAt = clock.now();
  return {
    id: `lnk_itest_email_verify_${Math.random().toString(36).slice(2, 12)}`,
    userId,
    purpose: "EMAIL_VERIFICATION" as const,
    tokenHash: sha256TokenService.hash(Math.random().toString(36)),
    email: `${userId}@${DOMAIN}`,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + HOUR_MS),
    ...overrides,
  };
}

function audit(userId: string, organizationId: string | null = null) {
  return {
    organizationId,
    actorUserId: userId,
    action: "test.link",
    resourceType: "user",
    resourceId: userId,
    metadata: {},
  };
}

describe("a new account", () => {
  it("is not verified", async () => {
    const id = await user("fresh");
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toBeNull();
    expect((await deps.repos.users.findById(id))?.emailVerifiedAt).toBeNull();
  });
});

describe("sending a link", () => {
  it("commits the link, as its token's SHA-256, with its audit entry", async () => {
    const id = await user("send");
    expect(await verification.sendVerificationLink(id)).toBe("SENT");
    const token = lastToken();
    const rows = await prisma.accountLink.findMany({ where: { userId: id } });
    expect(rows).toEqual([
      expect.objectContaining({
        userId: id,
        purpose: "EMAIL_VERIFICATION",
        tokenHash: sha256TokenService.hash(token),
        email: `send@${DOMAIN}`,
        createdAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 24 * HOUR_MS),
        usedAt: null,
      }),
    ]);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditActions(id)).toEqual(["user.email_verification_link_created"]);
  });

  it("rolls the link back when its audit entry fails", async () => {
    const id = await user("rollback");
    const row = linkRow(id, { email: `rollback@${DOMAIN}` });
    await expect(deps.repos.accountLinks.create(row, audit(id, "org_itest_email_verify_missing"))).rejects.toThrow();
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(0);
  });

  it("is refused by the table for a hash not SHA-256 hex, an empty window or a taken hash", async () => {
    const id = await user("checks");
    const unhashed = linkRow(id, { tokenHash: "hash:token_1" });
    await expect(deps.repos.accountLinks.create(unhashed, audit(id))).rejects.toThrow(/account_links_tokenHash_check/);
    const now = clock.now();
    await expect(deps.repos.accountLinks.create(linkRow(id, { expiresAt: now }), audit(id))).rejects.toThrow(
      /account_links_window_check/,
    );
    const first = linkRow(id);
    await deps.repos.accountLinks.create(first, audit(id));
    await expect(
      deps.repos.accountLinks.create(linkRow(id, { tokenHash: first.tokenHash }), audit(id)),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(1);
    expect(await auditActions(id)).toEqual(["test.link"]);
  });
});

describe("opening a link", () => {
  it("verifies the address, uses the link and audits it together", async () => {
    const id = await user("open");
    await verification.sendVerificationLink(id);
    clock.set(new Date(clock.now().getTime() + HOUR_MS));
    expect(await verification.verifyEmail(lastToken())).toBe("VERIFIED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toEqual(clock.now());
    expect((await prisma.accountLink.findFirstOrThrow({ where: { userId: id } })).usedAt).toEqual(clock.now());
    expect(await auditActions(id)).toEqual(["user.email_verification_link_created", "user.email_verified"]);
    expect(await verification.verifyEmail(lastToken())).toBe("ALREADY_VERIFIED");
    expect(await auditActions(id)).toHaveLength(2);
  });

  it("waits for a verification committing meanwhile, then writes nothing", async () => {
    const id = await user("rival");
    const email = `rival@${DOMAIN}`;
    const link = linkRow(id, { email });
    await deps.repos.accountLinks.create(link, audit(id));
    const verifiedAt = new Date(clock.now().getTime() - 1000);
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    // Another link's verification, holding the user's row until released.
    const rival = prisma.$transaction(
      async (tx) => {
        await tx.user.update({ where: { id }, data: { emailVerifiedAt: verifiedAt } });
        signalHeld();
        await released;
      },
      { timeout: 30_000 },
    );
    await Promise.race([held, rival]);
    const opening = deps.repos.accountLinks.useForEmailVerification({
      linkId: link.id,
      userId: id,
      email,
      usedAt: clock.now(),
      audit: audit(id),
    });
    try {
      // Released only once the opening waits on the rival's lock.
      await until(async () => {
        const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
        return (row?.waiting ?? 0) >= 1;
      });
    } finally {
      release();
    }
    await rival;
    expect(await opening).toBe("STALE");
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toEqual(verifiedAt);
    expect(await auditActions(id)).toEqual(["test.link"]);
  });

  it("verifies once when one link is opened several times and another at the same moment", async () => {
    const id = await user("race");
    await verification.sendVerificationLink(id);
    const first = lastToken();
    await verification.sendVerificationLink(id);
    const second = lastToken();
    const outcomes = await Promise.all(
      [first, second, first, second, first, first].map((token) => verification.verifyEmail(token)),
    );
    expect(outcomes.filter((o) => o === "VERIFIED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_VERIFIED")).toHaveLength(5);
    expect((await auditActions(id)).filter((a) => a === "user.email_verified")).toHaveLength(1);
    expect(await prisma.accountLink.count({ where: { userId: id, usedAt: { not: null } } })).toBe(1);
  });

  it("writes nothing for an account disabled, moved or verified, or a link expired or used", async () => {
    const id = await user("stale");
    const email = `stale@${DOMAIN}`;
    const link = linkRow(id, { email });
    await deps.repos.accountLinks.create(link, audit(id));
    const use = (usedAt: Date) =>
      deps.repos.accountLinks.useForEmailVerification({ linkId: link.id, userId: id, email, usedAt, audit: audit(id) });
    const now = clock.now();
    const linkUsedAt = async () => (await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt;
    const verifiedAt = async () => (await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt;

    await prisma.user.update({ where: { id }, data: { status: "DISABLED" } });
    expect(await use(now)).toBe("STALE");
    expect(await linkUsedAt()).toBeNull();
    await prisma.user.update({ where: { id }, data: { status: "ACTIVE", email: `moved@${DOMAIN}` } });
    expect(await use(now)).toBe("STALE");
    expect(await linkUsedAt()).toBeNull();
    await prisma.user.update({ where: { id }, data: { email, emailVerifiedAt: now } });
    expect(await use(now)).toBe("STALE");
    expect(await linkUsedAt()).toBeNull();
    await prisma.user.update({ where: { id }, data: { emailVerifiedAt: null } });
    expect(await use(link.expiresAt)).toBe("STALE");
    expect(await linkUsedAt()).toBeNull();
    await prisma.accountLink.update({ where: { id: link.id }, data: { usedAt: now } });
    expect(await use(now)).toBe("STALE");

    expect(await verifiedAt()).toBeNull();
    expect(await auditActions(id)).toEqual(["test.link"]);
  });

  it("is refused by the table for a use before the link was made, writing nothing", async () => {
    const id = await user("early");
    const email = `early@${DOMAIN}`;
    const link = linkRow(id, { email });
    await deps.repos.accountLinks.create(link, audit(id));
    await expect(
      deps.repos.accountLinks.useForEmailVerification({
        linkId: link.id,
        userId: id,
        email,
        usedAt: new Date(link.createdAt.getTime() - 1000),
        audit: audit(id),
      }),
    ).rejects.toThrow(/account_links_window_check/);
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toBeNull();
    expect(await auditActions(id)).toEqual(["test.link"]);
  });

  it("answers STALE for a link of another purpose", async () => {
    const id = await user("purpose");
    const email = `purpose@${DOMAIN}`;
    const link = linkRow(id, { email, purpose: "PASSWORD_RESET" });
    await deps.repos.accountLinks.create(link, audit(id));
    const outcome = await deps.repos.accountLinks.useForEmailVerification({
      linkId: link.id,
      userId: id,
      email,
      usedAt: clock.now(),
      audit: audit(id),
    });
    expect(outcome).toBe("STALE");
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
  });

  it("rolls the link and the address back when the audit entry fails", async () => {
    const id = await user("verify-rollback");
    const email = `verify-rollback@${DOMAIN}`;
    const link = linkRow(id, { email });
    await deps.repos.accountLinks.create(link, audit(id));
    await expect(
      deps.repos.accountLinks.useForEmailVerification({
        linkId: link.id,
        userId: id,
        email,
        usedAt: clock.now(),
        audit: audit(id, "org_itest_email_verify_missing"),
      }),
    ).rejects.toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toBeNull();
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
  });
});

describe("deleting a user", () => {
  it("deletes its links", async () => {
    const id = await user("delete");
    await verification.sendVerificationLink(id);
    await prisma.user.delete({ where: { id } });
    expect(await prisma.accountLink.count({ where: { userId: id } })).toBe(0);
  });
});
