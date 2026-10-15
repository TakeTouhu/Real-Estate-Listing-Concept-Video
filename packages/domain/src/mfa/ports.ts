import type { AuditLog } from "../identity/types";

/** A user's authenticator (TOTP) factor. A user has one exactly while MFA is on (ADR-0065). */
export interface MfaFactor {
  readonly userId: string;
  /** The TOTP secret as `MfaSecretCipher.seal` returned it; never the secret itself. */
  readonly sealedSecret: string;
  /** The 30-second step of the last code accepted; a code for it or an earlier step is refused. */
  readonly lastUsedStep: number;
  readonly enabledAt: Date;
}

/** The audit entry an MFA change commits together with the change itself. */
export type MfaAudit = Omit<AuditLog, "id" | "createdAt">;

/**
 * How a code ended. Only `ACCEPTED` wrote anything. `REJECTED`: the code was
 * already used (or MFA is off). `SESSION_ENDED`: the sign-in is gone.
 */
export type MfaCodeOutcome = "ACCEPTED" | "REJECTED" | "SESSION_ENDED";

/** `LOCKED`: this code was the last one allowed and ended the session. `SESSION_ENDED`: it was already gone. */
export type MfaFailureOutcome =
  | { readonly outcome: "COUNTED"; readonly attemptsLeft: number }
  | { readonly outcome: "LOCKED" | "SESSION_ENDED" };

export interface MfaEnableInput {
  readonly userId: string;
  readonly sessionId: string;
  /** The session's pending secret the code was checked against. */
  readonly sealedSecret: string;
  readonly step: number;
  readonly recoveryCodeHashes: readonly string[];
  readonly verifiedAt: Date;
  /** Built from whether the set-up replaced an earlier factor. */
  readonly audit: (replaced: boolean) => MfaAudit;
}

export interface MfaCodeInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly verifiedAt: Date;
}

/**
 * MFA state: a user's factor and recovery codes, and the MFA columns of a
 * session. Every change commits together with its audit entry.
 */
export interface MfaRepository {
  findFactor(userId: string): Promise<MfaFactor | null>;
  countRecoveryCodes(userId: string): Promise<number>;
  /** Keep a set-up secret on the session, replacing an earlier one; false when the session is gone. */
  savePendingSecret(sessionId: string, sealedSecret: string): Promise<boolean>;
  findPendingSecret(sessionId: string): Promise<string | null>;
  /**
   * Make the session's pending secret the user's factor, replace the recovery
   * codes, clear the pending secret and mark the session passed, atomically.
   * `STALE`, writing nothing, when the session is gone or holds another pending
   * secret, or when the user has a factor and the session has not passed it.
   */
  enable(input: MfaEnableInput): Promise<"ENABLED" | "STALE">;
  /** Accept an authenticator code for `step`, later than the last one used, and mark the session passed. */
  acceptTotpStep(input: MfaCodeInput & { readonly step: number; readonly audit: MfaAudit }): Promise<MfaCodeOutcome>;
  /** Use up a recovery code and mark the session passed; the audit entry is built from the codes left. */
  acceptRecoveryCode(
    input: MfaCodeInput & { readonly codeHash: string; readonly audit: (codesLeft: number) => MfaAudit },
  ): Promise<MfaCodeOutcome>;
  /** Count a wrong code against the session; at `limit` the session is deleted and `audit` recorded. */
  recordFailedCode(sessionId: string, limit: number, audit: MfaAudit): Promise<MfaFailureOutcome>;
  /** Replace the user's recovery codes; false, writing nothing, when MFA is off. */
  replaceRecoveryCodes(userId: string, codeHashes: readonly string[], audit: MfaAudit): Promise<boolean>;
  /** Delete the factor and its recovery codes for a code of `step`; false, writing nothing, when MFA is off or the step was used. */
  disable(userId: string, step: number, audit: MfaAudit): Promise<boolean>;
}

/** Seals TOTP secrets at rest (AES-256-GCM under `MFA_SECRET_KEY`). */
export interface MfaSecretCipher {
  /** Seal a secret for `userId`; the result names the key it was sealed under. */
  seal(secret: Uint8Array, userId: string): string;
  /** Open what `seal` returned for the same user; throws if altered, another user's, or under an unknown key. */
  open(sealed: string, userId: string): Uint8Array;
}

export interface MfaRandom {
  bytes(count: number): Uint8Array;
}
