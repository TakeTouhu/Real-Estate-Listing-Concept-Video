import { hotp } from "@app/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import type { Session } from "../identity/types";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { createMfaSecretCipher, systemMfaRandom } from "./adapters";
import { MFA_MAX_FAILED_CODES, MfaService } from "./mfa-service";
import { hashRecoveryCode, normalizeRecoveryCode } from "./recovery-codes";
import { totpStep } from "./totp";

const PASSWORD = "password-123456";
const EMAIL = "a+mfa@example.com";

interface Ctx {
  readonly deps: TestDeps;
  readonly auth: AuthService;
  readonly mfa: MfaService;
}

function setup(): Ctx {
  const deps = createTestDeps();
  return {
    deps,
    auth: new AuthService(deps, { sessionTtlSeconds: 3600 }),
    mfa: new MfaService({ ...deps, cipher: createMfaSecretCipher("11".repeat(32)), random: systemMfaRandom }),
  };
}

function decodeBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

describe("MfaService (ADR-0065)", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  async function signIn(email = EMAIL): Promise<Session> {
    if (!(await ctx.deps.repos.users.findByEmail(email))) {
      await ctx.auth.register({ email, name: "A", password: PASSWORD });
    }
    return (await ctx.auth.login(email, PASSWORD)).session;
  }

  /** The session as stored now. */
  function current(session: Session): Session {
    const stored = ctx.deps.repos.sessions.byId(session.id);
    if (!stored) throw new Error("session is gone");
    return stored;
  }

  function code(secret: string, offsetSteps = 0): string {
    return hotp(decodeBase32(secret), totpStep(ctx.deps.clock.now()) + offsetSteps);
  }

  async function enroll(session: Session): Promise<{ secret: string; recoveryCodes: readonly string[]; session: Session }> {
    const { secret } = await ctx.mfa.beginSetup(session);
    const { recoveryCodes } = await ctx.mfa.confirmSetup(session, code(secret));
    return { secret, recoveryCodes, session: current(session) };
  }

  function actions(): string[] {
    return ctx.deps.repos.auditLogs.all().map((entry) => entry.action);
  }

  describe("setting up", () => {
    it("gives a base32 secret and an otpauth URI for the user, and keeps only a sealed secret on the session", async () => {
      const session = await signIn();
      const setup = await ctx.mfa.beginSetup(session);
      expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.otpauthUri).toBe(
        `otpauth://totp/VTaVision:a%2Bmfa%40example.com?secret=${setup.secret}&issuer=VTaVision&algorithm=SHA1&digits=6&period=30`,
      );
      const pending = await ctx.deps.repos.mfa.findPendingSecret(session.id);
      expect(pending).not.toBeNull();
      expect(pending).not.toContain(setup.secret);
      expect(await ctx.deps.repos.mfa.findFactor(session.userId)).toBeNull();
    });

    it("turns MFA on with the first code, shows 10 recovery codes once, stores only their hashes, and passes the session", async () => {
      const session = await signIn();
      const { recoveryCodes, session: after } = await enroll(session);
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const recoveryCode of recoveryCodes) expect(recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(after.mfaVerifiedAt).toEqual(ctx.deps.clock.now());
      expect(await ctx.mfa.status(session.userId)).toEqual({ enabled: true, required: false, recoveryCodesLeft: 10 });
      expect(await ctx.deps.repos.mfa.findPendingSecret(session.id)).toBeNull();
      const entry = ctx.deps.repos.auditLogs.all().find((e) => e.action === "mfa.enabled");
      expect(entry).toMatchObject({ organizationId: null, actorUserId: session.userId, resourceType: "user", resourceId: session.userId });
      expect(entry?.metadata).toEqual({ recoveryCodes: 10 });
    });

    it("refuses a wrong first code, writing nothing and counting nothing", async () => {
      const session = await signIn();
      const { secret } = await ctx.mfa.beginSetup(session);
      for (let i = 0; i < MFA_MAX_FAILED_CODES + 1; i += 1) {
        await expect(ctx.mfa.confirmSetup(session, code(secret, 3))).rejects.toMatchObject({
          code: "VALIDATION_FAILED",
          message: "That code is not valid",
        });
      }
      expect(await ctx.deps.repos.mfa.findFactor(session.userId)).toBeNull();
      expect(current(session)).toMatchObject({ mfaVerifiedAt: null, mfaFailedAttempts: 0 });
      expect(actions()).not.toContain("mfa.enabled");
    });

    it("refuses to confirm a set-up never started in this session", async () => {
      const session = await signIn();
      const { secret } = await ctx.mfa.beginSetup(session);
      const other = await signIn();
      await expect(ctx.mfa.confirmSetup(other, code(secret))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "Start setting up MFA first",
      });
    });

    it("confirms only the latest secret when set-up is started again", async () => {
      const session = await signIn();
      const first = await ctx.mfa.beginSetup(session);
      const second = await ctx.mfa.beginSetup(session);
      await expect(ctx.mfa.confirmSetup(session, code(first.secret))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await ctx.mfa.confirmSetup(session, code(second.secret));
      expect(await ctx.deps.repos.mfa.findFactor(session.userId)).not.toBeNull();
    });

    it("lets only a session that passed MFA set it up again, moving it to the new authenticator", async () => {
      const { secret: oldSecret, recoveryCodes: oldCodes, session } = await enroll(await signIn());
      const unpassed = await signIn();
      await expect(ctx.mfa.beginSetup(unpassed)).rejects.toMatchObject({ code: "FORBIDDEN" });

      ctx.deps.clock.advanceSeconds(30);
      const { secret } = await ctx.mfa.beginSetup(session);
      const { recoveryCodes } = await ctx.mfa.confirmSetup(session, code(secret));
      expect(actions().filter((a) => a === "mfa.replaced")).toHaveLength(1);
      expect(recoveryCodes.some((c) => oldCodes.includes(c))).toBe(false);

      ctx.deps.clock.advanceSeconds(30);
      const next = await signIn();
      await expect(ctx.mfa.verify(next, code(oldSecret))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(ctx.mfa.verify(next, oldCodes[0]!)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await ctx.mfa.verify(next, code(secret));
      expect(current(next).mfaVerifiedAt).not.toBeNull();
    });

    it("does not let a set-up started before MFA was turned on replace it from a session that has not passed it", async () => {
      const attacker = await signIn();
      const started = await ctx.mfa.beginSetup(attacker);
      const { secret } = await enroll(await signIn());
      await expect(ctx.mfa.confirmSetup(attacker, code(started.secret))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "MFA set-up changed; start again",
      });
      const factor = await ctx.deps.repos.mfa.findFactor(attacker.userId);
      expect(factor && createMfaSecretCipher("11".repeat(32)).open(factor.sealedSecret, factor.userId)).toEqual(
        decodeBase32(secret),
      );
    });

    it("asks a session that has ended to sign in again", async () => {
      const session = await signIn();
      await ctx.deps.repos.sessions.deleteByTokenHash(session.tokenHash);
      await expect(ctx.mfa.beginSetup(session)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  describe("passing MFA in a sign-in", () => {
    it("accepts a current authenticator code once", async () => {
      const { secret } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(30);
      const session = await signIn();
      await ctx.mfa.verify(session, code(secret));
      expect(current(session).mfaVerifiedAt).toEqual(ctx.deps.clock.now());
      const entry = ctx.deps.repos.auditLogs.all().at(-1);
      expect(entry).toMatchObject({ action: "mfa.challenge_passed", resourceType: "session", resourceId: session.id });
      expect(entry?.metadata).toEqual({ method: "authenticator" });

      const again = await signIn();
      await expect(ctx.mfa.verify(again, code(secret))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(current(again).mfaFailedAttempts).toBe(1);
    });

    it("accepts the previous and next step for clock drift, never two steps away", async () => {
      const { secret } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(300);
      await ctx.mfa.verify(await signIn(), code(secret, -1));
      await ctx.mfa.verify(await signIn(), code(secret, 1));
      ctx.deps.clock.advanceSeconds(300);
      await expect(ctx.mfa.verify(await signIn(), code(secret, 2))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(ctx.mfa.verify(await signIn(), code(secret, -2))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("refuses an earlier step once a later one was used", async () => {
      const { secret } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(60);
      await ctx.mfa.verify(await signIn(), code(secret, 1));
      await expect(ctx.mfa.verify(await signIn(), code(secret))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("accepts each recovery code once, however it is typed, and says how many are left", async () => {
      const { recoveryCodes } = await enroll(await signIn());
      const session = await signIn();
      await ctx.mfa.verify(session, recoveryCodes[0]!.toLowerCase().replace(/-/g, " "));
      expect(current(session).mfaVerifiedAt).not.toBeNull();
      expect(ctx.deps.repos.auditLogs.all().at(-1)?.metadata).toEqual({ method: "recovery_code", recoveryCodesLeft: 9 });
      expect((await ctx.mfa.status(session.userId)).recoveryCodesLeft).toBe(9);
      await expect(ctx.mfa.verify(await signIn(), recoveryCodes[0]!)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await ctx.mfa.verify(await signIn(), recoveryCodes[1]!);
    });

    it("refuses another user's recovery code", async () => {
      const { recoveryCodes } = await enroll(await signIn());
      await enroll(await signIn("b@example.com"));
      await expect(ctx.mfa.verify(await signIn("b@example.com"), recoveryCodes[0]!)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    });

    it(`ends the sign-in at the ${MFA_MAX_FAILED_CODES}th wrong code, auditing it once`, async () => {
      await enroll(await signIn());
      const { token } = await ctx.auth.login(EMAIL, PASSWORD);
      const session = (await ctx.auth.resolveSession(token))!.session;
      for (let left = MFA_MAX_FAILED_CODES - 1; left >= 1; left -= 1) {
        await expect(ctx.mfa.verify(session, "000000")).rejects.toMatchObject({
          code: "VALIDATION_FAILED",
          details: { attemptsLeft: left },
        });
      }
      await expect(ctx.mfa.verify(session, "AAAA-AAAA-AAAA-AAAA")).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        message: "Too many wrong codes; sign in again",
      });
      expect(await ctx.auth.resolveSession(token)).toBeNull();
      const locked = ctx.deps.repos.auditLogs.all().filter((e) => e.action === "mfa.challenge_locked");
      expect(locked).toEqual([
        expect.objectContaining({ resourceType: "session", resourceId: session.id, metadata: { failedCodes: 5 } }),
      ]);
      await expect(ctx.mfa.verify(session, "000000")).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "Sign in again" });
      expect(ctx.deps.repos.auditLogs.all().filter((e) => e.action === "mfa.challenge_locked")).toHaveLength(1);
    });

    it("starts counting again after a code is accepted", async () => {
      const { secret } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(30);
      const session = await signIn();
      for (let i = 0; i < MFA_MAX_FAILED_CODES - 1; i += 1) {
        await expect(ctx.mfa.verify(session, "000000")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
      await ctx.mfa.verify(session, code(secret));
      expect(current(session).mfaFailedAttempts).toBe(0);
    });

    it("refuses when MFA is not on, counting nothing", async () => {
      const session = await signIn();
      await expect(ctx.mfa.verify(session, "000000")).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "MFA is not turned on",
      });
      expect(current(session).mfaFailedAttempts).toBe(0);
    });

    it("asks a session that has ended to sign in again, without counting", async () => {
      const { secret, recoveryCodes } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(30);
      const session = await signIn();
      await ctx.deps.repos.sessions.deleteByTokenHash(session.tokenHash);
      await expect(ctx.mfa.verify(session, code(secret))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(ctx.mfa.verify(session, recoveryCodes[0]!)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect((await ctx.mfa.status(session.userId)).recoveryCodesLeft).toBe(10);
    });
  });

  describe("recovery codes", () => {
    it("are replaced as a set by a session that passed MFA", async () => {
      const { recoveryCodes: old, session } = await enroll(await signIn());
      const fresh = await ctx.mfa.regenerateRecoveryCodes(session);
      expect(fresh).toHaveLength(10);
      expect(fresh.some((c) => old.includes(c))).toBe(false);
      expect(actions()).toContain("mfa.recovery_codes_regenerated");
      await expect(ctx.mfa.verify(await signIn(), old[0]!)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await ctx.mfa.verify(await signIn(), fresh[0]!);
    });

    it("are not replaced from a session that has not passed MFA, or with MFA off", async () => {
      await enroll(await signIn());
      await expect(ctx.mfa.regenerateRecoveryCodes(await signIn())).rejects.toMatchObject({ code: "FORBIDDEN" });
      const other = await signIn("b@example.com");
      await expect(ctx.mfa.regenerateRecoveryCodes({ ...other, mfaVerifiedAt: new Date() })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "MFA is not turned on",
      });
    });
  });

  describe("turning MFA off", () => {
    it("works for a user who need not use it, with a current authenticator code", async () => {
      const { secret, session } = await enroll(await signIn());
      ctx.deps.clock.advanceSeconds(30);
      await ctx.mfa.disable(session, code(secret));
      expect(await ctx.mfa.status(session.userId)).toEqual({ enabled: false, required: false, recoveryCodesLeft: 0 });
      expect(actions()).toContain("mfa.disabled");
    });

    it("is refused to a user who must use MFA", async () => {
      const { secret, session } = await enroll(await signIn());
      await ctx.deps.repos.memberships.create({ organizationId: "org_1", userId: session.userId, role: "OWNER" });
      ctx.deps.clock.advanceSeconds(30);
      await expect(ctx.mfa.disable(session, code(secret))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await ctx.mfa.status(session.userId)).enabled).toBe(true);
      expect(await ctx.mfa.status(session.userId)).toMatchObject({ required: true });
    });

    it("needs a session that passed MFA and a code not yet used; a wrong one counts", async () => {
      const { secret, recoveryCodes, session } = await enroll(await signIn());
      await expect(ctx.mfa.disable(await signIn(), code(secret, 1))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(ctx.mfa.disable(session, code(secret))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(ctx.mfa.disable(session, recoveryCodes[0]!)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(current(session).mfaFailedAttempts).toBe(2);
      expect((await ctx.mfa.status(session.userId)).enabled).toBe(true);
    });
  });

  it("never writes a secret, a code or a hash into the audit log", async () => {
    const { secret, recoveryCodes, session } = await enroll(await signIn());
    const regenerated = await ctx.mfa.regenerateRecoveryCodes(session);
    ctx.deps.clock.advanceSeconds(30);
    await ctx.mfa.verify(await signIn(), regenerated[0]!);
    const failed = await signIn();
    for (let i = 0; i < MFA_MAX_FAILED_CODES; i += 1) await ctx.mfa.verify(failed, "123456").catch(() => undefined);
    await ctx.mfa.disable(session, code(secret));
    const logged = JSON.stringify(ctx.deps.repos.auditLogs.all());
    const forbidden = [secret, ...recoveryCodes, ...regenerated].flatMap((value) => {
      const normalized = normalizeRecoveryCode(value);
      return normalized ? [value, normalized, hashRecoveryCode(normalized)] : [value];
    });
    for (const value of forbidden) expect(logged).not.toContain(value);
    expect(actions().filter((a) => a.startsWith("mfa."))).toEqual([
      "mfa.enabled",
      "mfa.recovery_codes_regenerated",
      "mfa.challenge_passed",
      "mfa.challenge_locked",
      "mfa.disabled",
    ]);
  });
});
