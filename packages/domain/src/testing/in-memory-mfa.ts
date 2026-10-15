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
  MfaTotpMatch,
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

  async acceptTotpStep(input: MfaCodeInput & MfaTotpMatch & { readonly audit: MfaAudit }): Promise<MfaCodeOutcome> {
    const session = this.sessions.byId(input.sessionId);
    if (!session) return "SESSION_ENDED";
    const factor = this.current(input);
    if (!factor) return "REJECTED";
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

  async replaceRecoveryCodes(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly codeHashes: readonly string[];
    readonly audit: MfaAudit;
  }): Promise<"REPLACED" | "NOT_ENABLED" | "SESSION_ENDED"> {
    if (!this.passed(input.sessionId, input.userId)) return "SESSION_ENDED";
    if (!this.factors.has(input.userId)) return "NOT_ENABLED";
    this.codes.set(input.userId, new Set(input.codeHashes));
    await this.auditLogs.append(input.audit);
    return "REPLACED";
  }

  async disable(
    input: { readonly userId: string; readonly sessionId: string; readonly audit: MfaAudit } & MfaTotpMatch,
  ): Promise<MfaCodeOutcome> {
    if (!this.passed(input.sessionId, input.userId)) return "SESSION_ENDED";
    if (!this.current(input)) return "REJECTED";
    this.factors.delete(input.userId);
    this.codes.delete(input.userId);
    await this.auditLogs.append(input.audit);
    return "ACCEPTED";
  }

  /** The user's factor, if it is still the one `match` was checked against and `match.step` is unused. */
  private current(match: MfaTotpMatch & { readonly userId: string }): MfaFactor | null {
    const factor = this.factors.get(match.userId);
    return factor && factor.sealedSecret === match.sealedSecret && factor.lastUsedStep < match.step ? factor : null;
  }

  private passed(sessionId: string, userId: string): boolean {
    const session = this.sessions.byId(sessionId);
    return session !== null && session.userId === userId && session.mfaVerifiedAt !== null;
  }

  private pass(session: Session, at: Date): void {
    this.sessions.put({ ...session, mfaVerifiedAt: at, mfaFailedAttempts: 0 });
  }
}
