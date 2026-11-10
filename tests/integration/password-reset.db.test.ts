import { type Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, PasswordResetService, sha256TokenService, type OutgoingEmail } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, TestClock } from "@app/domain/testing";

/**
 * Password reset against PostgreSQL (AT-4b, ADR-0131 and ADR-0132): a link and
 * its audit entry commit together, as the token's SHA-256; an address with no
 * account writes nothing. A reset replaces the password, uses the link, ends
 * every session of the account, deletes its other unused reset links and
 * audits it in one transaction, exactly once however many times the link is
 * opened at once, and leaves MFA and the verified address as they are. A
 * sign-in and a reset on one account wait for each other, whichever comes
 * first, and no session made with the old password survives.
 */

const DOMAIN = "password-reset.itest";
const BASE = "https://app.example.test/reset-password?token=";
const OLD = "password-123456";
const NEW = "another-password-789";

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-11-10T00:00:00.000Z"));
const sent: OutgoingEmail[] = [];
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_reset_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: sha256TokenService,
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const reset = new PasswordResetService({
  ...deps,
  email: {
    send: (email) => {
      sent.push(email);
      return Promise.resolve();
    },
  },
  resetUrl: (token) => `${BASE}${token}`,
});

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { resourceId: { in: ids } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  sent.length = 0;
  clock.set(new Date("2026-11-10T00:00:00.000Z"));
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function user(name: string): Promise<string> {
  return (await auth.register({ email: `${name}@${DOMAIN}`, name, password: OLD })).id;
}

async function linkFor(name: string): Promise<string> {
  await reset.requestReset(`${name}@${DOMAIN}`);
  const line = sent.at(-1)?.text.split("\n").find((l) => l.startsWith(BASE));
  if (!line) throw new Error("no link in the email");
  return line.slice(BASE.length);
}

async function actions(userId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { resourceId: userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.action).filter((a) => a !== "user.registered");
}

/** Until a statement locking the user `FOR <lock>` waits behind the backend `holder`. */
async function untilBlocked(holder: number, lock: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const blocked = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND ${holder}::int = ANY(pg_blocking_pids(pid))
        AND query LIKE '%"users"%' AND query LIKE ${`%FOR ${lock}%`}`;
    if (blocked.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`nothing waited FOR ${lock} behind backend ${holder}`);
}

/**
 * Runs `work` in a transaction that stays open until `release` is called,
 * answering that transaction's backend pid once `work` is done.
 */
function holding(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld = (_pid: number): void => undefined;
  const held = new Promise<number>((resolve) => (signalHeld = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await work(tx);
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      signalHeld(backend!.pid);
      await released;
    },
    { timeout: 30_000 },
  );
  return { pid: Promise.race([held, done.then(() => -1)]), release, done };
}

describe("asking for a link", () => {
  it("commits the link, as its token's SHA-256, with an entry naming no actor", async () => {
    const id = await user("ask");
    const token = await linkFor("ask");
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { tokenHash: sha256TokenService.hash(token) } });
    expect(link).toMatchObject({ userId: id, purpose: "PASSWORD_RESET", email: `ask@${DOMAIN}`, usedAt: null });
    expect(link.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(link.expiresAt.getTime() - link.createdAt.getTime()).toBe(60 * 60 * 1000);
    expect(await prisma.auditLog.findMany({ where: { resourceId: id, action: "user.password_reset_link_created" } }))
      .toEqual([expect.objectContaining({ actorUserId: null, metadata: { linkId: link.id, email: `ask@${DOMAIN}` } })]);
  });

  it("writes nothing for an address with no account", async () => {
    await reset.requestReset(`nobody@${DOMAIN}`);
    expect(sent).toEqual([]);
    expect(await prisma.accountLink.count({ where: { email: `nobody@${DOMAIN}` } })).toBe(0);
  });
});

describe("a reset", () => {
  it("replaces the password, uses the link, ends every session and deletes other reset links, together", async () => {
    const id = await user("reset");
    const otherId = await user("bystander");
    await auth.login(`reset@${DOMAIN}`, OLD);
    await auth.login(`reset@${DOMAIN}`, OLD);
    await auth.login(`bystander@${DOMAIN}`, OLD);
    const verifiedAt = new Date("2026-11-09T12:00:00.000Z");
    await prisma.user.update({ where: { id }, data: { emailVerifiedAt: verifiedAt } });
    await prisma.userMfaFactor.create({
      data: { userId: id, secret: "k1:sealed", lastUsedStep: 1, enabledAt: verifiedAt },
    });
    const older = await linkFor("reset");
    const token = await linkFor("reset");

    expect(await reset.resetPassword(token, NEW)).toBe("RESET");

    expect(await prisma.credential.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({
      passwordHash: await fakePasswordHasher.hash(NEW),
    });
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: otherId } })).toBe(1);
    const links = await prisma.accountLink.findMany({ where: { userId: id, purpose: "PASSWORD_RESET" } });
    const used = { tokenHash: sha256TokenService.hash(token), usedAt: clock.now() };
    expect(links).toEqual([expect.objectContaining(used)]);
    expect(await reset.resetPassword(older, NEW)).toBe("INVALID");
    expect(await prisma.userMfaFactor.count({ where: { userId: id } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toEqual(verifiedAt);
    expect(await actions(id)).toEqual([
      "user.password_reset_link_created",
      "user.password_reset_link_created",
      "user.password_reset",
    ]);
  });

  it("rolls everything back when its audit entry fails", async () => {
    const id = await user("rollback");
    await auth.login(`rollback@${DOMAIN}`, OLD);
    const other = await linkFor("rollback");
    const token = await linkFor("rollback");
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { tokenHash: sha256TokenService.hash(token) } });
    // The entry names an organization that does not exist: its foreign key refuses it.
    const outcome = deps.repos.accountLinks.useForPasswordReset({
      linkId: link.id,
      userId: id,
      email: link.email,
      usedAt: clock.now(),
      passwordHash: await fakePasswordHasher.hash(NEW),
      audit: {
        organizationId: "org_itest_reset_missing",
        actorUserId: id,
        action: "user.password_reset",
        resourceType: "user",
        resourceId: id,
        metadata: {},
      },
    });
    await expect(outcome).rejects.toMatchObject({ code: "P2003", meta: { modelName: "AuditLog" } });
    expect(await prisma.credential.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({
      passwordHash: await fakePasswordHasher.hash(OLD),
    });
    expect(await prisma.session.count({ where: { userId: id } })).toBe(1);
    expect(await prisma.accountLink.count({ where: { userId: id, usedAt: null } })).toBe(2);
    expect(await reset.checkResetLink(other)).toBe("USABLE");
  });

  it("writes nothing for an account with no password, and leaves the link unused", async () => {
    const id = await user("nopassword");
    const token = await linkFor("nopassword");
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { tokenHash: sha256TokenService.hash(token) } });
    await prisma.credential.delete({ where: { userId: id } });
    const input = { linkId: link.id, userId: id, email: link.email, usedAt: clock.now(), passwordHash: "fake:x" };
    const audit = { organizationId: null, actorUserId: id, action: "test.reset", resourceType: "user", resourceId: id };
    expect(await deps.repos.accountLinks.useForPasswordReset({ ...input, audit: { ...audit, metadata: {} } })).toBe(
      "STALE",
    );
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
    expect(await prisma.credential.count({ where: { userId: id } })).toBe(0);
    expect(await actions(id)).toEqual(["user.password_reset_link_created"]);
  });

  it("writes nothing when the link expired, or the account changed, by the time it is used", async () => {
    const id = await user("late");
    const token = await linkFor("late");
    const link = await prisma.accountLink.findUniqueOrThrow({ where: { tokenHash: sha256TokenService.hash(token) } });
    const passwordHash = await fakePasswordHasher.hash(NEW);
    const audit = { organizationId: null, actorUserId: id, action: "test.reset", resourceType: "user", resourceId: id };
    const use = (usedAt: Date) =>
      deps.repos.accountLinks.useForPasswordReset({
        linkId: link.id,
        userId: id,
        email: link.email,
        usedAt,
        passwordHash,
        audit: { ...audit, metadata: {} },
      });
    expect(await use(link.expiresAt)).toBe("STALE");
    await prisma.user.update({ where: { id }, data: { status: "DISABLED" } });
    expect(await use(clock.now())).toBe("STALE");
    await prisma.user.update({ where: { id }, data: { status: "ACTIVE", email: `moved@${DOMAIN}` } });
    expect(await use(clock.now())).toBe("STALE");
    expect((await prisma.accountLink.findUniqueOrThrow({ where: { id: link.id } })).usedAt).toBeNull();
    expect(await prisma.credential.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({
      passwordHash: await fakePasswordHasher.hash(OLD),
    });
    await prisma.user.update({ where: { id }, data: { email: link.email } });
    expect(await use(clock.now())).toBe("APPLIED");
  });

  it("resets once when one link is opened several times at once", async () => {
    const id = await user("race");
    const token = await linkFor("race");
    const outcomes = await Promise.all(
      ["first-password-1", "second-password-2", "third-password-3", "fourth-password-4"].map((p) =>
        reset.resetPassword(token, p),
      ),
    );
    expect(outcomes.filter((o) => o === "RESET")).toHaveLength(1);
    expect((await actions(id)).filter((a) => a === "user.password_reset")).toHaveLength(1);
  });
});

describe("a sign-in and a reset on one account", () => {
  it("a sign-in waits for a reset holding the account, then makes no session with the old password", async () => {
    const id = await user("signin");
    // A reset's writes, holding the user's row until released.
    const rival = holding(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${id} FOR NO KEY UPDATE`;
      const passwordHash = await fakePasswordHasher.hash(NEW);
      await tx.credential.update({ where: { userId: id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: id } });
    });
    const rivalPid = await rival.pid;
    expect(rivalPid).toBeGreaterThan(0);
    const signIn = { id: `ses_itest_reset_${Date.now()}`, userId: id, tokenHash: sha256TokenService.hash("signin") };
    const expiresAt = new Date(clock.now().getTime() + 60_000);
    // The password the sign-in checked before the reset took the account.
    const creating = deps.repos.sessions.create({ ...signIn, expiresAt }, await fakePasswordHasher.hash(OLD));
    void creating.catch(() => undefined);
    try {
      await untilBlocked(rivalPid, "SHARE");
    } finally {
      rival.release();
    }
    await rival.done;
    expect(await creating).toBeNull();
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
  });

  it("a reset waits for a sign-in holding the account, then ends the session it made", async () => {
    const id = await user("signedin");
    const token = await linkFor("signedin");
    const expiresAt = new Date(clock.now().getTime() + 60_000);
    // A sign-in's writes, holding the user's row until released.
    const rival = holding(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${id} FOR SHARE`;
      const tokenHash = sha256TokenService.hash("signedin");
      await tx.session.create({ data: { id: `ses_itest_reset_${Date.now()}`, userId: id, tokenHash, expiresAt } });
    });
    const rivalPid = await rival.pid;
    expect(rivalPid).toBeGreaterThan(0);
    const resetting = reset.resetPassword(token, NEW);
    void resetting.catch(() => undefined);
    try {
      await untilBlocked(rivalPid, "NO KEY UPDATE");
    } finally {
      rival.release();
    }
    await rival.done;
    expect(await resetting).toBe("RESET");
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
  });

  it("makes its session while the password it checked is still the account's", async () => {
    const id = await user("current");
    const input = { id: `ses_itest_reset_${Date.now()}`, userId: id, tokenHash: sha256TokenService.hash("cur") };
    const expiresAt = new Date(clock.now().getTime() + 60_000);
    expect(await deps.repos.sessions.create({ ...input, expiresAt }, "fake:wrong")).toBeNull();
    const current = await fakePasswordHasher.hash(OLD);
    const made = await deps.repos.sessions.create({ ...input, expiresAt }, current);
    expect(made).toMatchObject({ id: input.id, userId: id });
  });
});
