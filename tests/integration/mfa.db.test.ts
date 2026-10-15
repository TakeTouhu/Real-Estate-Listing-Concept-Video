import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthService,
  MFA_MAX_FAILED_CODES,
  MfaService,
  createMfaSecretCipher,
  hashRecoveryCode,
  systemMfaRandom,
  totpStep,
  type MfaAudit,
  type Session,
} from "@app/domain";
import { createPrismaIdentityRepositories } from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";
import { hotp } from "@app/shared";

/**
 * MFA against PostgreSQL (MFA-1, ADR-0065): migration 25's tables, cascades and
 * CHECKs; the whole set-up, sign-in, recovery and turn-off cycle through the
 * real repositories; each change committed with its audit row or not at all;
 * and concurrent codes accepted, or counted, exactly once.
 */

const DOMAIN = "mfa.itest";
const PASSWORD = "password-123456";
const ORG = "org_itest_mfa";

const prisma = new PrismaClient();
const clock = new TestClock(new Date("2026-03-01T00:00:00.000Z"));
const cipher = createMfaSecretCipher("33".repeat(32));
const deps = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (p: string) => `${p}_itest_mfa_${Math.random().toString(36).slice(2, 12)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
const mfa = new MfaService({ ...deps, cipher, random: systemMfaRandom });

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { organizationId: ORG }] } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function signIn(name = "a"): Promise<Session> {
  const email = `${name}@${DOMAIN}`;
  if (!(await deps.repos.users.findByEmail(email))) await auth.register({ email, name, password: PASSWORD });
  return (await auth.login(email, PASSWORD)).session;
}

async function stored(session: Session) {
  return prisma.session.findUnique({ where: { id: session.id } });
}

function code(secret: Uint8Array, offsetSteps = 0): string {
  return hotp(secret, totpStep(clock.now()) + offsetSteps);
}

/** Set up MFA and return the raw secret, read back through the cipher. */
async function enroll(session: Session): Promise<{ secret: Uint8Array; recoveryCodes: readonly string[] }> {
  await mfa.beginSetup(session);
  const pending = await deps.repos.mfa.findPendingSecret(session.id);
  const secret = cipher.open(pending!, session.userId);
  const { recoveryCodes } = await mfa.confirmSetup(session, code(secret));
  return { secret, recoveryCodes };
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { actorUserId: userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.action).filter((a) => a.startsWith("mfa."));
}

/** An audit entry PostgreSQL cannot store, so the transaction carrying it rolls back. */
const unstorable: MfaAudit = {
  organizationId: "org_itest_mfa_missing",
  actorUserId: null,
  action: "mfa.test",
  resourceType: "user",
  resourceId: "x",
  metadata: {},
};

describe("migration 25", () => {
  it("starts a session without MFA passed and with no wrong codes", async () => {
    const session = await signIn();
    expect(await stored(session)).toMatchObject({ mfaVerifiedAt: null, mfaFailedAttempts: 0, mfaPendingSecret: null });
    expect(session).toMatchObject({ mfaVerifiedAt: null, mfaFailedAttempts: 0 });
  });

  it("stores a recovery code only as a 64-character hex hash", async () => {
    const session = await signIn();
    await enroll(session);
    await expect(
      prisma.userMfaRecoveryCode.create({ data: { userId: session.userId, codeHash: "ABCD-EFGH-JKMN-PQRS" } }),
    ).rejects.toThrow(/user_mfa_recovery_codes_codeHash_check/);
    const rows = await prisma.userMfaRecoveryCode.findMany({ where: { userId: session.userId } });
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a negative wrong-code count", async () => {
    const session = await signIn();
    await expect(prisma.session.update({ where: { id: session.id }, data: { mfaFailedAttempts: -1 } })).rejects.toThrow(
      /sessions_mfaFailedAttempts_check/,
    );
  });

  it("removes the recovery codes with the factor, and the factor with the user", async () => {
    const session = await signIn();
    await enroll(session);
    await prisma.userMfaFactor.delete({ where: { userId: session.userId } });
    expect(await prisma.userMfaRecoveryCode.count({ where: { userId: session.userId } })).toBe(0);
    await enroll(await signIn());
    await prisma.user.delete({ where: { id: session.userId } });
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(0);
  });

  it("stores the secret sealed, never in base32 or raw", async () => {
    const session = await signIn();
    const { secret } = await mfa.beginSetup(session);
    const factorless = await stored(session);
    expect(factorless?.mfaPendingSecret).not.toContain(secret);
    await mfa.confirmSetup(session, code(cipher.open(factorless!.mfaPendingSecret!, session.userId)));
    const factor = await prisma.userMfaFactor.findUnique({ where: { userId: session.userId } });
    expect(factor?.secret).toMatch(/^[0-9a-f]{12}\./);
    expect(factor?.secret).not.toContain(secret);
    expect((await stored(session))?.mfaPendingSecret).toBeNull();
  });
});

describe("the MFA cycle through PostgreSQL", () => {
  it("sets up, passes by authenticator and by recovery code, replaces codes and turns off, auditing each", async () => {
    const first = await signIn();
    const { secret, recoveryCodes } = await enroll(first);
    expect((await stored(first))?.mfaVerifiedAt).toEqual(clock.now());

    clock.advanceSeconds(30);
    const second = await signIn();
    await mfa.verify(second, code(secret));
    expect((await stored(second))?.mfaVerifiedAt).not.toBeNull();

    const third = await signIn();
    await mfa.verify(third, recoveryCodes[0]!);
    expect(await mfa.status(first.userId)).toEqual({ enabled: true, required: false, recoveryCodesLeft: 9 });

    const fresh = await mfa.regenerateRecoveryCodes((await deps.repos.sessions.findByTokenHash(first.tokenHash))!);
    expect(await prisma.userMfaRecoveryCode.count({ where: { userId: first.userId } })).toBe(10);
    expect(fresh).not.toContain(recoveryCodes[1]);

    clock.advanceSeconds(30);
    await mfa.disable((await deps.repos.sessions.findByTokenHash(first.tokenHash))!, code(secret));
    expect(await prisma.userMfaFactor.count({ where: { userId: first.userId } })).toBe(0);
    expect(await prisma.userMfaRecoveryCode.count({ where: { userId: first.userId } })).toBe(0);

    expect(await auditActions(first.userId)).toEqual([
      "mfa.enabled",
      "mfa.challenge_passed",
      "mfa.challenge_passed",
      "mfa.recovery_codes_regenerated",
      "mfa.disabled",
    ]);
    const passed = await prisma.auditLog.findMany({ where: { actorUserId: first.userId, action: "mfa.challenge_passed" } });
    expect(passed.map((r) => r.metadata)).toEqual([{ method: "authenticator" }, { method: "recovery_code", recoveryCodesLeft: 9 }]);
    expect(passed.every((r) => r.organizationId === null)).toBe(true);
  });

  it("reads the requirement from current memberships, and refuses to turn MFA off for an OWNER", async () => {
    const session = await signIn();
    const { secret } = await enroll(session);
    await prisma.organization.create({ data: { id: ORG, name: "MFA", slug: "itest-mfa" } });
    await prisma.membership.create({ data: { organizationId: ORG, userId: session.userId, role: "OWNER" } });
    expect((await mfa.status(session.userId)).required).toBe(true);
    clock.advanceSeconds(30);
    await expect(mfa.disable((await deps.repos.sessions.findByTokenHash(session.tokenHash))!, code(secret))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(1);
  });

  it("ends the sign-in at the fifth wrong code, deleting the session and auditing once", async () => {
    const session = await signIn();
    await enroll(session);
    const next = await signIn();
    for (let i = 1; i < MFA_MAX_FAILED_CODES; i += 1) {
      await expect(mfa.verify(next, "000000")).rejects.toMatchObject({ details: { attemptsLeft: MFA_MAX_FAILED_CODES - i } });
    }
    await expect(mfa.verify(next, "000000")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await stored(next)).toBeNull();
    expect((await auditActions(session.userId)).filter((a) => a === "mfa.challenge_locked")).toHaveLength(1);
  });
});

describe("what the repository refuses", () => {
  it("does not let a set-up started before MFA was turned on replace it from a session that has not passed it", async () => {
    const early = await signIn();
    await mfa.beginSetup(early);
    const earlySecret = cipher.open((await deps.repos.mfa.findPendingSecret(early.id))!, early.userId);
    const { secret } = await enroll(await signIn());
    await expect(mfa.confirmSetup(early, code(earlySecret))).rejects.toMatchObject({
      message: "MFA set-up changed; start again",
    });
    const factor = await deps.repos.mfa.findFactor(early.userId);
    expect(Buffer.from(cipher.open(factor!.sealedSecret, early.userId)).equals(Buffer.from(secret))).toBe(true);
    expect((await stored(early))?.mfaVerifiedAt).toBeNull();
  });

  it("enables only the secret the session holds as pending", async () => {
    const session = await signIn();
    await mfa.beginSetup(session);
    const other = cipher.seal(new Uint8Array(20).fill(9), session.userId);
    const outcome = await deps.repos.mfa.enable({
      userId: session.userId,
      sessionId: session.id,
      sealedSecret: other,
      step: totpStep(clock.now()),
      recoveryCodeHashes: [],
      verifiedAt: clock.now(),
      audit: () => unstorable,
    });
    expect(outcome).toBe("STALE");
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(0);
  });

  it("turns MFA off only for a step later than the last one used", async () => {
    const session = await signIn();
    await enroll(session);
    const step = totpStep(clock.now());
    const audit = { ...unstorable, organizationId: null, actorUserId: session.userId };
    expect(await deps.repos.mfa.disable(session.userId, step, audit)).toBe(false);
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(1);
    expect(await deps.repos.mfa.disable(session.userId, step + 1, audit)).toBe(true);
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(0);
  });

  it("starts counting wrong codes again once a code is accepted", async () => {
    const { secret } = await enroll(await signIn());
    clock.advanceSeconds(30);
    const session = await signIn();
    for (let i = 1; i < MFA_MAX_FAILED_CODES; i += 1) await expect(mfa.verify(session, "000000")).rejects.toThrow();
    expect((await stored(session))?.mfaFailedAttempts).toBe(MFA_MAX_FAILED_CODES - 1);
    await mfa.verify(session, code(secret));
    expect((await stored(session))?.mfaFailedAttempts).toBe(0);
  });
});

describe("each change commits with its audit row, or not at all", () => {
  it("leaves MFA off and the session unpassed when set-up cannot be audited", async () => {
    const session = await signIn();
    await mfa.beginSetup(session);
    const sealed = (await deps.repos.mfa.findPendingSecret(session.id))!;
    const step = totpStep(clock.now());
    await expect(
      deps.repos.mfa.enable({
        userId: session.userId,
        sessionId: session.id,
        sealedSecret: sealed,
        step,
        recoveryCodeHashes: [hashRecoveryCode("0000000000000000")],
        verifiedAt: clock.now(),
        audit: () => unstorable,
      }),
    ).rejects.toThrow();
    expect(await prisma.userMfaFactor.count({ where: { userId: session.userId } })).toBe(0);
    expect(await prisma.userMfaRecoveryCode.count({ where: { userId: session.userId } })).toBe(0);
    expect(await stored(session)).toMatchObject({ mfaVerifiedAt: null, mfaPendingSecret: sealed });
  });

  it("keeps the code usable and the session unpassed when acceptance cannot be audited", async () => {
    const { recoveryCodes } = await enroll(await signIn());
    clock.advanceSeconds(30);
    const session = await signIn();
    const step = totpStep(clock.now());
    const base = { userId: session.userId, sessionId: session.id, verifiedAt: clock.now() };
    await expect(deps.repos.mfa.acceptTotpStep({ ...base, step, audit: unstorable })).rejects.toThrow();
    const codeHash = hashRecoveryCode(recoveryCodes[0]!.replace(/-/g, ""));
    await expect(deps.repos.mfa.acceptRecoveryCode({ ...base, codeHash, audit: () => unstorable })).rejects.toThrow();
    expect((await deps.repos.mfa.findFactor(session.userId))?.lastUsedStep).toBe(step - 1);
    expect(await mfa.status(session.userId)).toMatchObject({ recoveryCodesLeft: 10 });
    expect((await stored(session))?.mfaVerifiedAt).toBeNull();
  });

  it("keeps the session when its lock-out cannot be audited", async () => {
    const session = await signIn();
    await prisma.session.update({ where: { id: session.id }, data: { mfaFailedAttempts: MFA_MAX_FAILED_CODES - 1 } });
    await expect(deps.repos.mfa.recordFailedCode(session.id, MFA_MAX_FAILED_CODES, unstorable)).rejects.toThrow();
    expect((await stored(session))?.mfaFailedAttempts).toBe(MFA_MAX_FAILED_CODES - 1);
  });
});

describe("concurrency", () => {
  it("accepts one authenticator code once across concurrent sign-ins", async () => {
    const { secret } = await enroll(await signIn());
    clock.advanceSeconds(30);
    const sessions = await Promise.all(Array.from({ length: 6 }, () => signIn()));
    const value = code(secret);
    const results = await Promise.allSettled(sessions.map((s) => mfa.verify(s, value)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const passed = await prisma.session.count({ where: { id: { in: sessions.map((s) => s.id) }, mfaVerifiedAt: { not: null } } });
    expect(passed).toBe(1);
    expect((await auditActions(sessions[0]!.userId)).filter((a) => a === "mfa.challenge_passed")).toHaveLength(1);
  });

  it("accepts one recovery code once across concurrent sign-ins", async () => {
    const { recoveryCodes } = await enroll(await signIn());
    const sessions = await Promise.all(Array.from({ length: 6 }, () => signIn()));
    const results = await Promise.allSettled(sessions.map((s) => mfa.verify(s, recoveryCodes[0]!)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await mfa.status(sessions[0]!.userId)).toMatchObject({ recoveryCodesLeft: 9 });
  });

  it("says exactly how many recovery codes are left when several are used at once", async () => {
    const { recoveryCodes } = await enroll(await signIn());
    const sessions = await Promise.all(Array.from({ length: 5 }, () => signIn()));
    await Promise.all(sessions.map((s, i) => mfa.verify(s, recoveryCodes[i]!)));
    const passed = await prisma.auditLog.findMany({
      where: { actorUserId: sessions[0]!.userId, action: "mfa.challenge_passed" },
    });
    const left = passed.map((r) => (r.metadata as { recoveryCodesLeft: number }).recoveryCodesLeft).sort();
    expect(left).toEqual([5, 6, 7, 8, 9]);
  });

  it("counts concurrent wrong codes exactly, ending the session once", async () => {
    const owner = await signIn();
    await enroll(owner);
    const session = await signIn();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => mfa.verify(session, "000000")));
    const messages = results.map((r) => (r.status === "rejected" ? (r.reason as Error).message : "accepted"));
    expect(messages.filter((m) => m === "That code is not valid")).toHaveLength(MFA_MAX_FAILED_CODES - 1);
    expect(messages.filter((m) => m === "Too many wrong codes; sign in again")).toHaveLength(1);
    expect(messages.filter((m) => m === "Sign in again")).toHaveLength(8 - MFA_MAX_FAILED_CODES);
    expect(await stored(session)).toBeNull();
    expect((await auditActions(owner.userId)).filter((a) => a === "mfa.challenge_locked")).toHaveLength(1);
  });

  it("lets only one of two concurrent first set-ups turn MFA on", async () => {
    const a = await signIn();
    const b = await signIn();
    const secrets: Uint8Array[] = [];
    for (const session of [a, b]) {
      await mfa.beginSetup(session);
      secrets.push(cipher.open((await deps.repos.mfa.findPendingSecret(session.id))!, session.userId));
    }
    const results = await Promise.allSettled([mfa.confirmSetup(a, code(secrets[0]!)), mfa.confirmSetup(b, code(secrets[1]!))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "VALIDATION_FAILED", message: "MFA set-up changed; start again" });
    expect(await prisma.userMfaRecoveryCode.count({ where: { userId: a.userId } })).toBe(10);
    expect((await auditActions(a.userId)).filter((x) => x === "mfa.enabled")).toHaveLength(1);
  });
});
