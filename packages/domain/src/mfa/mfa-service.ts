import { AppError, base32Encode } from "@app/shared";
import { AuditAction } from "../identity/audit";
import type { IdentityServiceDeps } from "../identity/ports";
import type { Session } from "../identity/types";
import type { MfaAudit, MfaCodeOutcome, MfaFactor, MfaRandom, MfaSecretCipher } from "./ports";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-codes";
import { isMfaRequired } from "./requirement";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS, matchTotp } from "./totp";

/** Wrong codes one sign-in may enter; the last one ends it. */
export const MFA_MAX_FAILED_CODES = 5;
const SECRET_BYTES = 20;
const ISSUER = "VTaVision";

export interface MfaServiceDeps extends Pick<IdentityServiceDeps, "repos" | "clock"> {
  readonly cipher: MfaSecretCipher;
  readonly random: MfaRandom;
}

export interface MfaStatus {
  readonly enabled: boolean;
  /** The user's roles or permissions make MFA mandatory (ADR-0052 Decision 18). */
  readonly required: boolean;
  readonly recoveryCodesLeft: number;
}

export interface MfaSetup {
  /** The secret in base32, for typing into an authenticator app. */
  readonly secret: string;
  /** What an authenticator app reads from a QR code. */
  readonly otpauthUri: string;
}

/**
 * Authenticator-app MFA and recovery codes (ADR-0065). Every method acts for
 * the user of the session it is given; MFA belongs to the session, which
 * passes it once.
 */
export class MfaService {
  constructor(private readonly deps: MfaServiceDeps) {}

  async status(userId: string): Promise<MfaStatus> {
    const enabled = (await this.deps.repos.mfa.findFactor(userId)) !== null;
    return {
      enabled,
      required: await isMfaRequired(this.deps, userId),
      recoveryCodesLeft: enabled ? await this.deps.repos.mfa.countRecoveryCodes(userId) : 0,
    };
  }

  /**
   * Start setting up an authenticator in this session. With MFA already on,
   * only a session that passed it may, to move to a new device.
   */
  async beginSetup(session: Session): Promise<MfaSetup> {
    const user = await this.deps.repos.users.findById(session.userId);
    if (!user) throw signInAgain();
    if (session.mfaVerifiedAt === null && (await this.deps.repos.mfa.findFactor(user.id))) throw codeFirst();
    const secret = this.deps.random.bytes(SECRET_BYTES);
    if (!(await this.deps.repos.mfa.savePendingSecret(session.id, this.deps.cipher.seal(secret, user.id)))) {
      throw signInAgain();
    }
    const encoded = base32Encode(secret);
    const label = `${ISSUER}:${encodeURIComponent(user.email)}`;
    const parameters = `secret=${encoded}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
    return { secret: encoded, otpauthUri: `otpauth://totp/${label}?${parameters}` };
  }

  /**
   * Finish set-up with a first code: MFA on (or moved to the new device), a new
   * set of recovery codes, shown only here, and this session passed.
   */
  async confirmSetup(session: Session, code: string): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const sealed = await this.deps.repos.mfa.findPendingSecret(session.id);
    if (sealed === null) throw new AppError("VALIDATION_FAILED", "Start setting up MFA first");
    const now = this.deps.clock.now();
    const step = matchTotp(this.deps.cipher.open(sealed, session.userId), code, now, null);
    if (step === null) throw new AppError("VALIDATION_FAILED", "That code is not valid");
    const recoveryCodes = this.newRecoveryCodes();
    const outcome = await this.deps.repos.mfa.enable({
      userId: session.userId,
      sessionId: session.id,
      sealedSecret: sealed,
      step,
      recoveryCodeHashes: hashAll(recoveryCodes),
      verifiedAt: now,
      audit: (replaced) =>
        userAudit(session.userId, replaced ? AuditAction.MfaReplaced : AuditAction.MfaEnabled, {
          recoveryCodes: RECOVERY_CODE_COUNT,
        }),
    });
    if (outcome === "STALE") throw new AppError("VALIDATION_FAILED", "MFA set-up changed; start again");
    return { recoveryCodes };
  }

  /** Pass the second factor in this session with an authenticator code or a recovery code. */
  async verify(session: Session, code: string): Promise<void> {
    const factor = await this.requireFactor(session.userId);
    const input = { userId: session.userId, sessionId: session.id, verifiedAt: this.deps.clock.now() };
    const recoveryCode = normalizeRecoveryCode(code);
    let outcome: MfaCodeOutcome = "REJECTED";
    if (recoveryCode !== null) {
      outcome = await this.deps.repos.mfa.acceptRecoveryCode({
        ...input,
        codeHash: hashRecoveryCode(recoveryCode),
        audit: (codesLeft) =>
          sessionAudit(session, AuditAction.MfaChallengePassed, { method: "recovery_code", recoveryCodesLeft: codesLeft }),
      });
    } else {
      const step = this.match(factor, code);
      if (step !== null) {
        outcome = await this.deps.repos.mfa.acceptTotpStep({
          ...input,
          sealedSecret: factor.sealedSecret,
          step,
          audit: sessionAudit(session, AuditAction.MfaChallengePassed, { method: "authenticator" }),
        });
      }
    }
    if (outcome !== "ACCEPTED") await this.refuse(session, outcome);
  }

  /** Replace the recovery codes; the new ones are shown only here. */
  async regenerateRecoveryCodes(session: Session): Promise<readonly string[]> {
    if (session.mfaVerifiedAt === null) throw codeFirst();
    const recoveryCodes = this.newRecoveryCodes();
    const audit = userAudit(session.userId, AuditAction.MfaRecoveryCodesRegenerated, {
      recoveryCodes: RECOVERY_CODE_COUNT,
    });
    const outcome = await this.deps.repos.mfa.replaceRecoveryCodes({
      userId: session.userId,
      sessionId: session.id,
      codeHashes: hashAll(recoveryCodes),
      audit,
    });
    if (outcome === "SESSION_ENDED") throw signInAgain();
    if (outcome === "NOT_ENABLED") throw notEnabled();
    return recoveryCodes;
  }

  /** Turn MFA off with a current authenticator code; refused to anyone who must use it. */
  async disable(session: Session, code: string): Promise<void> {
    if (session.mfaVerifiedAt === null) throw codeFirst();
    const factor = await this.requireFactor(session.userId);
    if (await isMfaRequired(this.deps, session.userId)) {
      throw new AppError("FORBIDDEN", "Your role requires MFA, so it cannot be turned off");
    }
    const step = this.match(factor, code);
    const outcome: MfaCodeOutcome =
      step === null
        ? "REJECTED"
        : await this.deps.repos.mfa.disable({
            userId: session.userId,
            sessionId: session.id,
            sealedSecret: factor.sealedSecret,
            step,
            audit: userAudit(session.userId, AuditAction.MfaDisabled, {}),
          });
    if (outcome !== "ACCEPTED") await this.refuse(session, outcome);
  }

  private async requireFactor(userId: string): Promise<MfaFactor> {
    const factor = await this.deps.repos.mfa.findFactor(userId);
    if (!factor) throw notEnabled();
    return factor;
  }

  private match(factor: MfaFactor, code: string): number | null {
    const secret = this.deps.cipher.open(factor.sealedSecret, factor.userId);
    return matchTotp(secret, code, this.deps.clock.now(), factor.lastUsedStep);
  }

  /** Count a wrong code against the session, ending it at the limit, and throw. */
  private async refuse(session: Session, outcome: Exclude<MfaCodeOutcome, "ACCEPTED">): Promise<never> {
    if (outcome === "REJECTED") {
      const failure = await this.deps.repos.mfa.recordFailedCode(
        session.id,
        MFA_MAX_FAILED_CODES,
        sessionAudit(session, AuditAction.MfaChallengeLocked, { failedCodes: MFA_MAX_FAILED_CODES }),
      );
      if (failure.outcome === "COUNTED") {
        throw new AppError("VALIDATION_FAILED", "That code is not valid", {
          details: { attemptsLeft: failure.attemptsLeft },
        });
      }
      if (failure.outcome === "LOCKED") throw new AppError("UNAUTHENTICATED", "Too many wrong codes; sign in again");
    }
    throw signInAgain();
  }

  private newRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode(this.deps.random));
  }
}

function hashAll(recoveryCodes: readonly string[]): string[] {
  return recoveryCodes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)!));
}

/** MFA belongs to the person, so its audit entries name no organization. Never a secret, code or hash. */
function userAudit(userId: string, action: string, metadata: Record<string, unknown>): MfaAudit {
  return { organizationId: null, actorUserId: userId, action, resourceType: "user", resourceId: userId, metadata };
}

function sessionAudit(session: Session, action: string, metadata: Record<string, unknown>): MfaAudit {
  return {
    organizationId: null,
    actorUserId: session.userId,
    action,
    resourceType: "session",
    resourceId: session.id,
    metadata,
  };
}

const signInAgain = () => new AppError("UNAUTHENTICATED", "Sign in again");
const codeFirst = () => new AppError("FORBIDDEN", "Enter a code from your authenticator app first");
const notEnabled = () => new AppError("VALIDATION_FAILED", "MFA is not turned on");
