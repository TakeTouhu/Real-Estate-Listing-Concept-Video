import type { AuditLogRepository } from "../identity/ports";
import type { Session } from "../identity/types";
import type {
  MfaAudit,
  MfaCodeInput,
  MfaCodeOutcome,
  MfaEnableInput,
  MfaFactor,
  MfaFailureOutcome,
  MfaRepository,
} from "../mfa/ports";

/** What the MFA double reads and writes of the session double. */
export interface InMemorySessionStore {
  byId(sessionId: string): Session | null;
  put(session: Session): void;
  deleteByTokenHash(tokenHash: string): Promise<void>;
}

/** MFA state in memory, with the PostgreSQL repository's outcomes (ADR-0065). */
export class InMemoryMfaRepository implements MfaRepository {
  private readonly factors = new Map<string, MfaFactor>();
  private readonly codes = new Map<string, Set<string>>();
  /** By session id; a pending secret goes with its session. */
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly sessions: InMemorySessionStore,
    private readonly auditLogs: Pick<AuditLogRepository, "append">,
  ) {}

  findFactor(userId: string): Promise<MfaFactor | null> {
    return Promise.resolve(this.factors.get(userId) ?? null);
  }

  countRecoveryCodes(userId: string): Promise<number> {
    return Promise.resolve(this.codes.get(userId)?.size ?? 0);
  }

  savePendingSecret(sessionId: string, sealedSecret: string): Promise<boolean> {
    if (!this.sessions.byId(sessionId)) return Promise.resolve(false);
    this.pending.set(sessionId, sealedSecret);
    return Promise.resolve(true);
  }

  findPendingSecret(sessionId: string): Promise<string | null> {
    return Promise.resolve(this.sessions.byId(sessionId) ? (this.pending.get(sessionId) ?? null) : null);
  }

  async enable(input: MfaEnableInput): Promise<"ENABLED" | "STALE"> {
    const session = this.sessions.byId(input.sessionId);
    if (!session || this.pending.get(input.sessionId) !== input.sealedSecret) return "STALE";
    const replaced = this.factors.has(input.userId);
    if (replaced && session.mfaVerifiedAt === null) return "STALE";
    this.factors.set(input.userId, {
      userId: input.userId,
      sealedSecret: input.sealedSecret,
      lastUsedStep: input.step,
      enabledAt: input.verifiedAt,
    });
    this.codes.set(input.userId, new Set(input.recoveryCodeHashes));
    this.pending.delete(input.sessionId);
    this.pass(session, input.verifiedAt);
    await this.auditLogs.append(input.audit(replaced));
    return "ENABLED";
  }

  async acceptTotpStep(input: MfaCodeInput & { readonly step: number; readonly audit: MfaAudit }): Promise<MfaCodeOutcome> {
    const session = this.sessions.byId(input.sessionId);
    if (!session) return "SESSION_ENDED";
    const factor = this.factors.get(input.userId);
    if (!factor || factor.lastUsedStep >= input.step) return "REJECTED";
    this.factors.set(input.userId, { ...factor, lastUsedStep: input.step });
    this.pass(session, input.verifiedAt);
    await this.auditLogs.append(input.audit);
    return "ACCEPTED";
  }

  async acceptRecoveryCode(
    input: MfaCodeInput & { readonly codeHash: string; readonly audit: (codesLeft: number) => MfaAudit },
  ): Promise<MfaCodeOutcome> {
    const session = this.sessions.byId(input.sessionId);
    if (!session) return "SESSION_ENDED";
    const codes = this.codes.get(input.userId);
    if (!this.factors.has(input.userId) || !codes?.delete(input.codeHash)) return "REJECTED";
    this.pass(session, input.verifiedAt);
    await this.auditLogs.append(input.audit(codes.size));
    return "ACCEPTED";
  }

  async recordFailedCode(sessionId: string, limit: number, audit: MfaAudit): Promise<MfaFailureOutcome> {
    const session = this.sessions.byId(sessionId);
    if (!session) return { outcome: "SESSION_ENDED" };
    const attempts = session.mfaFailedAttempts + 1;
    if (attempts < limit) {
      this.sessions.put({ ...session, mfaFailedAttempts: attempts });
      return { outcome: "COUNTED", attemptsLeft: limit - attempts };
    }
    await this.sessions.deleteByTokenHash(session.tokenHash);
    await this.auditLogs.append(audit);
    return { outcome: "LOCKED" };
  }

  async replaceRecoveryCodes(userId: string, codeHashes: readonly string[], audit: MfaAudit): Promise<boolean> {
    if (!this.factors.has(userId)) return false;
    this.codes.set(userId, new Set(codeHashes));
    await this.auditLogs.append(audit);
    return true;
  }

  async disable(userId: string, step: number, audit: MfaAudit): Promise<boolean> {
    const factor = this.factors.get(userId);
    if (!factor || factor.lastUsedStep >= step) return false;
    this.factors.delete(userId);
    this.codes.delete(userId);
    await this.auditLogs.append(audit);
    return true;
  }

  private pass(session: Session, at: Date): void {
    this.sessions.put({ ...session, mfaVerifiedAt: at, mfaFailedAttempts: 0 });
  }
}
