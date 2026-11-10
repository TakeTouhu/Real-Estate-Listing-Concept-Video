import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, PasswordResetService, sha256TokenService, type OutgoingEmail } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, TestClock } from "@app/domain/testing";

/**
 * Password reset links against PostgreSQL (AT-4b-1, ADR-0131): a link and its
 * audit entry commit together, as the token's SHA-256; an address with no
 * account writes nothing; a sign-in that checked the old password waits for a
 * transaction holding the account, as a reset will (AT-4b-2), and then makes
 * no session.
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

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the sign-in never waited on the reset's lock");
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

describe("a sign-in while the password is being replaced", () => {
  it("waits for a reset holding the account, then makes no session with the old password", async () => {
    const id = await user("signin");
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let signalHeld = (_pid: number): void => undefined;
    const held = new Promise<number>((resolve) => (signalHeld = resolve));
    // What a reset will write, holding the user's row until released.
    const rival = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${id} FOR NO KEY UPDATE`;
        const passwordHash = await fakePasswordHasher.hash(NEW);
        await tx.credential.update({ where: { userId: id }, data: { passwordHash } });
        await tx.session.deleteMany({ where: { userId: id } });
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        signalHeld(backend!.pid);
        await released;
      },
      { timeout: 30_000 },
    );
    const rivalPid = await Promise.race([held, rival.then(() => -1)]);
    expect(rivalPid).toBeGreaterThan(0);
    const signIn = { id: `ses_itest_reset_${Date.now()}`, userId: id, tokenHash: sha256TokenService.hash("signin") };
    const expiresAt = new Date(clock.now().getTime() + 60_000);
    // The password the sign-in checked before the reset took the account.
    const creating = deps.repos.sessions.create({ ...signIn, expiresAt }, await fakePasswordHasher.hash(OLD));
    void creating.catch(() => undefined);
    try {
      // The sign-in's lock on the user, waiting behind this rival.
      await until(async () => {
        const blocked = await prisma.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${rivalPid}::int = ANY(pg_blocking_pids(pid))
            AND query LIKE '%"users"%' AND query LIKE '%FOR SHARE%'`;
        return blocked.length > 0;
      });
    } finally {
      release();
    }
    await rival;
    expect(await creating).toBeNull();
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
