import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimitPolicy } from "@app/domain";
import { createPrismaRateLimitStore } from "@app/database";
import {
  RATE_LIMIT_CONTRACT_CASES,
  RATE_LIMIT_CONTRACT_SIGN_IN,
  RATE_LIMIT_CONTRACT_T0,
  replayRateLimitContract,
} from "@app/domain/testing";

/**
 * The abuse-limit counters in PostgreSQL (RD-7b, ADR-0169): migration 35's
 * table and CHECK, the contract cases every store must pass, no count lost
 * when hits arrive at once, expired rows deleted two at a time by later
 * hits, and times kept as UTC whatever the session's zone.
 */

/** A client with its own pool and session settings, read from DATABASE_URL. */
function clientWith(params: Record<string, string>): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? "");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

const prisma = new PrismaClient();
const many = clientWith({ connection_limit: "40" });
const tokyo = clientWith({ options: "-c TimeZone=Asia/Tokyo" });
const store = createPrismaRateLimitStore(prisma);

/** Three hits a minute, with no cooldown. */
const shortPolicy = rateLimitPolicy({
  name: "itest.short",
  limit: 3,
  windowSeconds: 60,
  cooldownBaseSeconds: 0,
  cooldownMaxSeconds: 0,
  decaySeconds: 0,
});
const subject = (n: number): string => n.toString(16).padStart(64, "0");
const at = (seconds: number): Date => new Date(RATE_LIMIT_CONTRACT_T0.getTime() + seconds * 1000);

/** Every row: a hit's prune reaches the whole table, so a row left by anything else would change what it deletes. */
async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "rate_limit_counters"`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await Promise.all([prisma.$disconnect(), many.$disconnect(), tokyo.$disconnect()]);
});

describe("the rule, on PostgreSQL", () => {
  it.each(RATE_LIMIT_CONTRACT_CASES.map((contract) => [contract.name, contract] as const))(
    "%s",
    async (_name, contract) => {
      expect(await replayRateLimitContract(store, contract)).toEqual([]);
      await cleanup();
    },
  );

  it("decides alike, and stores UTC, in a session whose zone is Tokyo", async () => {
    for (const prefix of ["C4:", "C6:", "C17:"]) {
      const contract = RATE_LIMIT_CONTRACT_CASES.find((c) => c.name.startsWith(prefix));
      expect(contract).toBeDefined();
      if (contract) expect(await replayRateLimitContract(createPrismaRateLimitStore(tokyo), contract)).toEqual([]);
      await cleanup();
    }
    await createPrismaRateLimitStore(tokyo).hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject(1), RATE_LIMIT_CONTRACT_T0);
    const [row] = await prisma.$queryRaw<{ windowStartedAt: Date }[]>`
      SELECT "windowStartedAt" FROM "rate_limit_counters" WHERE "policy" = 'contract.sign-in'`;
    expect(row?.windowStartedAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("gives back and prunes by UTC in a session whose zone is Tokyo", async () => {
    const inTokyo = createPrismaRateLimitStore(tokyo);
    const short = rateLimitPolicy({ ...shortPolicy, name: "itest.tokyo" });
    const first = await inTokyo.hit(short, subject(1), at(0));
    expect(first.allowed).toBe(true);
    if (first.allowed) await inTokyo.giveBack(short, subject(1), first.windowStartedAt);
    const counts = async (): Promise<number[]> => {
      const rows = await prisma.$queryRaw<{ count: number }[]>`
        SELECT "count" FROM "rate_limit_counters" WHERE "policy" = 'itest.tokyo' ORDER BY "subject"`;
      return rows.map((r) => r.count);
    };
    expect(await counts()).toEqual([0]);
    // The row of subject 1 ends at 60 s: a hit at 30 s keeps it, one at 61 s deletes it.
    await inTokyo.hit(short, subject(2), at(30));
    expect(await counts()).toEqual([0, 1]);
    await inTokyo.hit(short, subject(3), at(61));
    expect(await counts()).toEqual([1, 1]);
  });
});

describe("hits that arrive at once", () => {
  const wide = rateLimitPolicy({
    name: "itest.wide",
    limit: 99_999,
    windowSeconds: 3600,
    cooldownBaseSeconds: 0,
    cooldownMaxSeconds: 0,
    decaySeconds: 0,
  });
  const five = rateLimitPolicy({ ...RATE_LIMIT_CONTRACT_SIGN_IN, name: "itest.five" });
  const concurrent = createPrismaRateLimitStore(many);

  it("lose no count: 200 hits on one key give the counts 1 to 200", async () => {
    const decisions = await Promise.all(Array.from({ length: 200 }, () => concurrent.hit(wide, subject(7), at(0))));
    const counts = decisions.map((d) => (d.allowed ? d.count : -1)).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it("let exactly the limit through, then one cooldown at level 1", async () => {
    const decisions = await Promise.all(Array.from({ length: 50 }, () => concurrent.hit(five, subject(8), at(0))));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    const refusals = decisions.filter((d) => !d.allowed).map((d) => (d.allowed ? 0 : d.retryAt.getTime()));
    expect(new Set(refusals)).toEqual(new Set([at(900).getTime()]));
    const [row] = await prisma.$queryRaw<{ lockLevel: number }[]>`
      SELECT "lockLevel" FROM "rate_limit_counters" WHERE "policy" = 'itest.five'`;
    expect(row?.lockLevel).toBe(1);
  });

  it("race the prune without an error or a lost count, round after round", async () => {
    // Every row has expired, so each hit's prune contends with the others' for the same rows.
    const race = rateLimitPolicy({ ...wide, name: "itest.race", windowSeconds: 60 });
    const keys = Array.from({ length: 60 }, (_, n) => subject(100 + n));
    for (let round = 0; round < 3; round += 1) {
      await cleanup();
      for (const key of keys) await concurrent.hit(race, key, at(0));
      const hits = keys.flatMap((key) => Array.from({ length: 10 }, () => key));
      const decisions = await Promise.all(hits.map((key) => concurrent.hit(race, key, at(100))));
      expect(decisions.every((d) => d.allowed)).toBe(true);
      const rows = await prisma.$queryRaw<{ subject: string; count: number }[]>`
        SELECT "subject", "count" FROM "rate_limit_counters" WHERE "policy" = 'itest.race'`;
      expect(rows).toHaveLength(60);
      expect(new Set(rows.map((r) => r.count))).toEqual(new Set([10]));
    }
  });
});

describe("expired rows", () => {
  const short = shortPolicy;

  async function remaining(): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ subject: string }[]>`
      SELECT "subject" FROM "rate_limit_counters" WHERE "policy" = 'itest.short' ORDER BY "subject"`;
    return rows.map((r) => r.subject);
  }

  it("are deleted two at a time by later hits, the oldest first, never one that still decides", async () => {
    for (let n = 1; n <= 5; n += 1) await store.hit(short, subject(n), at(n));
    // At 64 s the rows hit at 1 s to 3 s have expired (60 s windows); those at 4 s and 5 s have not.
    await store.hit(short, subject(9), at(64));
    expect(await remaining()).toEqual([subject(3), subject(4), subject(5), subject(9)]);
    await store.hit(short, subject(9), at(64));
    expect(await remaining()).toEqual([subject(4), subject(5), subject(9)]);
  });

  it("keep a row whose cooldown has not decayed, so the next cooldown grows", async () => {
    for (let n = 0; n < 6; n += 1) await store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject(1), at(0));
    // Cooled down until 900 s at level 1; its window ends at 1800 s, its level decays at 900 s + 24 h.
    for (let n = 0; n < 3; n += 1) await store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject(2), at(4000));
    for (let n = 0; n < 5; n += 1) {
      expect((await store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject(1), at(4000))).allowed).toBe(true);
    }
    expect(await store.hit(RATE_LIMIT_CONTRACT_SIGN_IN, subject(1), at(4000))).toEqual({
      allowed: false,
      retryAt: at(5800),
    });
  });

  it("never take the key being hit, which starts a new window instead", async () => {
    await store.hit(short, subject(1), at(0));
    const decision = await store.hit(short, subject(1), at(120));
    expect(decision).toEqual({ allowed: true, windowStartedAt: at(120), count: 1 });
  });

  it("stay bounded under a spray of new keys", async () => {
    for (let n = 1; n <= 300; n += 1) await store.hit(short, subject(n), at(n));
    // Each row lives 60 s and each hit deletes up to two expired ones, so about 60 remain, not 300.
    const left = await remaining();
    expect(left.length).toBeLessThanOrEqual(62);
    expect(left).toContain(subject(300));
  });
});

describe("the table's CHECK", () => {
  it.each([
    ["an address as subject", "itest.raw", "owner@example.test", 1, null, 0],
    ["a subject in capitals", "itest.raw", "A".repeat(64), 1, null, 0],
    ["a policy without a dot", "itest", "a".repeat(64), 1, null, 0],
    ["a policy in capitals", "Itest.raw", "a".repeat(64), 1, null, 0],
    ["a policy of 65 characters", `itest.${"a".repeat(59)}`, "a".repeat(64), 1, null, 0],
    ["a negative count", "itest.raw", "a".repeat(64), -1, null, 0],
    ["a cooldown without a level", "itest.raw", "a".repeat(64), 0, at(10), 0],
    ["a level without a cooldown", "itest.raw", "a".repeat(64), 0, null, 1],
  ])("refuses %s", async (_reason, policy, subjectValue, count, lockedUntil, lockLevel) => {
    await expect(prisma.$executeRaw`
      INSERT INTO "rate_limit_counters"
        ("policy", "subject", "windowStartedAt", "count", "lockedUntil", "lockLevel", "expiresAt")
      VALUES (${policy}, ${subjectValue}, ${at(0)}, ${count}, ${lockedUntil}, ${lockLevel}, ${at(60)})`,
    ).rejects.toThrow(/rate_limit_counters_shape_check/);
  });

  it("takes the names the domain takes", async () => {
    await prisma.$executeRaw`
      INSERT INTO "rate_limit_counters"
        ("policy", "subject", "windowStartedAt", "count", "lockedUntil", "lockLevel", "expiresAt")
      VALUES (${`itest.${"a".repeat(58)}`}, ${"a".repeat(64)}, ${at(0)}, 0, NULL, 0, ${at(60)}),
             ('itest.password-reset-email', ${"b".repeat(64)}, ${at(0)}, 4, ${at(10)}, 1, ${at(60)})`;
    expect(await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "rate_limit_counters" WHERE "policy" LIKE 'itest.%'`).toEqual([{ n: 2n }]);
  });
});
