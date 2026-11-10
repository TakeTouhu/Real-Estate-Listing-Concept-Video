import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * Registering an account against PostgreSQL (AT-4a, ADR-0130): the user, its
 * password and `user.registered` commit together or not at all; an email
 * committed first rolls the registration back and is answered `EMAIL_TAKEN`;
 * and of several sign-ups for one email at once, one is made and the others
 * are told the email is taken.
 */

const DOMAIN = "register.itest";
const PREFIX = "usr_itest_register_";
const REGISTERED = "user.registered";

const prisma = new PrismaClient();
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock: new TestClock(new Date("2026-11-10T00:00:00.000Z")),
  ids: { generate: (p: string) => `${p}_itest_register_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { endsWith: `@${DOMAIN}` } }, { id: { startsWith: PREFIX } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: ids } }, { resourceId: { startsWith: PREFIX } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function registration(id: string, email: string, overrides: { auditOrganizationId?: string } = {}) {
  return {
    user: { id, email, name: "Itest", status: "ACTIVE" as const },
    passwordHash: "hash:itest",
    audit: {
      organizationId: overrides.auditOrganizationId ?? null,
      actorUserId: id,
      action: REGISTERED,
      resourceType: "user",
      resourceId: id,
      metadata: { email },
    },
  };
}

/** What exists of the user `id`: its row, its password and its audit rows. */
async function traces(id: string) {
  return {
    user: await prisma.user.count({ where: { id } }),
    credential: await prisma.credential.count({ where: { userId: id } }),
    audit: await prisma.auditLog.count({ where: { resourceId: id } }),
  };
}

describe("one transaction", () => {
  it("commits the user, its password and user.registered together", async () => {
    const user = await auth.register({ email: `New@${DOMAIN}`, name: "New", password: "password-123456" });

    expect(user).toMatchObject({ email: `new@${DOMAIN}`, name: "New", status: "ACTIVE", emailVerifiedAt: null });
    expect(await prisma.credential.findUnique({ where: { userId: user.id } })).toMatchObject({
      passwordHash: await fakePasswordHasher.hash("password-123456"),
    });
    expect(await prisma.auditLog.findMany({ where: { resourceId: user.id } })).toEqual([
      expect.objectContaining({
        organizationId: null,
        actorUserId: user.id,
        action: REGISTERED,
        resourceType: "user",
        metadata: { email: `new@${DOMAIN}` },
      }),
    ]);
  });

  it("leaves no user and no password when the audit row cannot be written", async () => {
    const id = `${PREFIX}no_audit`;
    // The entry names an organization that does not exist: its foreign key refuses it.
    const input = registration(id, `no-audit@${DOMAIN}`, { auditOrganizationId: "org_itest_register_missing" });
    await expect(deps.repos.users.register(input)).rejects.toMatchObject({
      code: "P2003",
      meta: { modelName: "AuditLog" },
    });
    expect(await traces(id)).toEqual({ user: 0, credential: 0, audit: 0 });
  });
});

describe("an email committed first", () => {
  it("writes nothing and answers EMAIL_TAKEN", async () => {
    const first = `${PREFIX}first`;
    const second = `${PREFIX}second`;
    const email = `taken@${DOMAIN}`;
    await expect(deps.repos.users.register(registration(first, email))).resolves.toMatchObject({ outcome: "CREATED" });
    await expect(deps.repos.users.register(registration(second, email))).resolves.toEqual({ outcome: "EMAIL_TAKEN" });
    expect(await traces(second)).toEqual({ user: 0, credential: 0, audit: 0 });
    expect(await traces(first)).toEqual({ user: 1, credential: 1, audit: 1 });
  });

  it("is not mistaken for another conflict: a taken id still fails", async () => {
    const id = `${PREFIX}same_id`;
    await deps.repos.users.register(registration(id, `a@${DOMAIN}`));
    await expect(deps.repos.users.register(registration(id, `b@${DOMAIN}`))).rejects.toMatchObject({
      code: "P2002",
      meta: { modelName: "User" },
    });
    expect(await prisma.user.count({ where: { email: `b@${DOMAIN}` } })).toBe(0);
    expect(await traces(id)).toEqual({ user: 1, credential: 1, audit: 1 });
  });

  it("makes one of several sign-ups for one email at once, and tells the others it is taken", async () => {
    const email = `race@${DOMAIN}`;
    // Every sign-up checks the email, and finds it free, before any of them
    // writes it: the transaction alone decides which one is made.
    const users = deps.repos.users;
    const found: unknown[] = [];
    let allChecked!: () => void;
    const checked = new Promise<void>((resolve) => (allChecked = resolve));
    const racing = new AuthService(
      {
        ...deps,
        repos: {
          ...deps.repos,
          users: {
            register: (input) => users.register(input),
            findById: (id) => users.findById(id),
            findByEmail: async (address) => {
              const user = await users.findByEmail(address);
              if (found.push(user) === 6) allChecked();
              await checked;
              return user;
            },
          },
        },
      },
      { sessionTtlSeconds: 3600 },
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => racing.register({ email, name: `R${i}`, password: "password-123456" })),
    );
    expect(found).toEqual([null, null, null, null, null, null]);
    const made = outcomes.filter((o) => o.status === "fulfilled");
    expect(made).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === "rejected")) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        code: "VALIDATION_FAILED",
        message: "Email is already registered",
      });
    }
    const [user] = await prisma.user.findMany({ where: { email } });
    expect(await traces(user!.id)).toEqual({ user: 1, credential: 1, audit: 1 });
    expect(await prisma.auditLog.count({ where: { action: REGISTERED, metadata: { equals: { email } } } })).toBe(1);
  });
});
