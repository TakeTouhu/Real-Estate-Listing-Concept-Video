import { describe, expect, it } from "vitest";
import type { MfaAudit } from "../mfa/ports";
import { createTestDeps } from "./in-memory";

/**
 * The in-memory MFA double answers as the PostgreSQL repository does
 * (`tests/integration/mfa.db.test.ts`). The service filters used steps before
 * it reaches the repository, so these call the double directly.
 */

const STEP = 1000;

async function enabled() {
  const deps = createTestDeps();
  const session = await deps.repos.sessions.create({ id: "ses_1", userId: "usr_1", tokenHash: "h1", expiresAt: new Date(1e13) });
  const audit: MfaAudit = { organizationId: null, actorUserId: "usr_1", action: "test", resourceType: "user", resourceId: "usr_1", metadata: {} };
  await deps.repos.mfa.savePendingSecret(session.id, "sealed");
  const outcome = await deps.repos.mfa.enable({
    userId: "usr_1",
    sessionId: session.id,
    sealedSecret: "sealed",
    step: STEP,
    recoveryCodeHashes: ["a".repeat(64)],
    verifiedAt: deps.clock.now(),
    audit: () => audit,
  });
  expect(outcome).toBe("ENABLED");
  const input = { userId: "usr_1", sessionId: session.id, verifiedAt: deps.clock.now(), sealedSecret: "sealed" };
  return { deps, session, audit, input };
}

describe("InMemoryMfaRepository", () => {
  it("accepts an authenticator step only when it is later than the last one used", async () => {
    const { deps, audit, input } = await enabled();
    expect(await deps.repos.mfa.acceptTotpStep({ ...input, step: STEP, audit })).toBe("REJECTED");
    expect(await deps.repos.mfa.acceptTotpStep({ ...input, step: STEP - 1, audit })).toBe("REJECTED");
    expect(await deps.repos.mfa.acceptTotpStep({ ...input, step: STEP + 1, audit })).toBe("ACCEPTED");
    expect((await deps.repos.mfa.findFactor("usr_1"))?.lastUsedStep).toBe(STEP + 1);
  });

  it("refuses a code checked against an authenticator since replaced", async () => {
    const { deps, audit, input } = await enabled();
    expect(await deps.repos.mfa.acceptTotpStep({ ...input, sealedSecret: "replaced", step: STEP + 1, audit })).toBe("REJECTED");
    expect(await deps.repos.mfa.disable({ ...input, sealedSecret: "replaced", step: STEP + 1, audit })).toBe("REJECTED");
    expect(await deps.repos.mfa.findFactor("usr_1")).toMatchObject({ lastUsedStep: STEP });
  });

  it("turns MFA off only for a step later than the last one used", async () => {
    const { deps, audit, input } = await enabled();
    expect(await deps.repos.mfa.disable({ ...input, step: STEP, audit })).toBe("REJECTED");
    expect(await deps.repos.mfa.disable({ ...input, step: STEP + 1, audit })).toBe("ACCEPTED");
    expect(await deps.repos.mfa.countRecoveryCodes("usr_1")).toBe(0);
  });

  it("replaces codes or turns MFA off only from a stored session that passed MFA", async () => {
    const { deps, session, audit, input } = await enabled();
    const unpassed = await deps.repos.sessions.create({ id: "ses_2", userId: "usr_1", tokenHash: "h2", expiresAt: new Date(1e13) });
    const others = await deps.repos.sessions.create({ id: "ses_3", userId: "usr_2", tokenHash: "h3", expiresAt: new Date(1e13) });
    deps.repos.sessions.put({ ...others, mfaVerifiedAt: deps.clock.now() });
    const change = { userId: "usr_1", codeHashes: ["b".repeat(64)], audit };
    for (const sessionId of [unpassed.id, others.id]) {
      expect(await deps.repos.mfa.replaceRecoveryCodes({ ...change, sessionId })).toBe("SESSION_ENDED");
      expect(await deps.repos.mfa.disable({ ...input, sessionId, step: STEP + 1, audit })).toBe("SESSION_ENDED");
    }
    await deps.repos.sessions.deleteByTokenHash(session.tokenHash);
    expect(await deps.repos.mfa.replaceRecoveryCodes({ ...change, sessionId: session.id })).toBe("SESSION_ENDED");
    expect(await deps.repos.mfa.disable({ ...input, step: STEP + 1, audit })).toBe("SESSION_ENDED");
    expect(await deps.repos.mfa.countRecoveryCodes("usr_1")).toBe(1);
    expect(await deps.repos.mfa.findFactor("usr_1")).not.toBeNull();
  });

  it("uses a recovery code once", async () => {
    const { deps, input } = await enabled();
    const accept = () => deps.repos.mfa.acceptRecoveryCode({ ...input, codeHash: "a".repeat(64), audit: () => ({}) as MfaAudit });
    expect(await accept()).toBe("ACCEPTED");
    expect(await accept()).toBe("REJECTED");
  });

  it("refuses to enable from an unpassed session once a factor exists, or for another pending secret", async () => {
    const { deps, audit } = await enabled();
    const other = await deps.repos.sessions.create({ id: "ses_2", userId: "usr_1", tokenHash: "h2", expiresAt: new Date(1e13) });
    await deps.repos.mfa.savePendingSecret(other.id, "sealed-2");
    const base = { userId: "usr_1", sessionId: other.id, step: STEP + 5, recoveryCodeHashes: [], verifiedAt: deps.clock.now(), audit: () => audit };
    expect(await deps.repos.mfa.enable({ ...base, sealedSecret: "sealed-2" })).toBe("STALE");
    expect(await deps.repos.mfa.enable({ ...base, sealedSecret: "sealed-3" })).toBe("STALE");
  });

  it("locks out at the limit and then reports the session gone", async () => {
    const { deps, session, audit } = await enabled();
    expect(await deps.repos.mfa.recordFailedCode(session.id, 2, audit)).toEqual({ outcome: "COUNTED", attemptsLeft: 1 });
    expect(await deps.repos.mfa.recordFailedCode(session.id, 2, audit)).toEqual({ outcome: "LOCKED" });
    expect(await deps.repos.mfa.recordFailedCode(session.id, 2, audit)).toEqual({ outcome: "SESSION_ENDED" });
  });
});
