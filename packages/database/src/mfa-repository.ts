import type { Prisma, PrismaClient } from "@prisma/client";
import type { MfaRepository } from "@app/domain";
import { auditLogData } from "./audit-log-data";

/**
 * MFA state in PostgreSQL (ADR-0065). Every change locks the session row before
 * the factor row, so two changes never wait on each other in opposite orders.
 */
export function createPrismaMfaRepository(prisma: PrismaClient): MfaRepository {
  return {
    async findFactor(userId) {
      const r = await prisma.userMfaFactor.findUnique({ where: { userId } });
      return r ? { userId: r.userId, sealedSecret: r.secret, lastUsedStep: r.lastUsedStep, enabledAt: r.enabledAt } : null;
    },
    async countRecoveryCodes(userId) {
      return prisma.userMfaRecoveryCode.count({ where: { userId } });
    },
    async savePendingSecret(sessionId, sealedSecret) {
      const { count } = await prisma.session.updateMany({ where: { id: sessionId }, data: { mfaPendingSecret: sealedSecret } });
      return count === 1;
    },
    async findPendingSecret(sessionId) {
      const r = await prisma.session.findUnique({ where: { id: sessionId }, select: { mfaPendingSecret: true } });
      return r?.mfaPendingSecret ?? null;
    },
    async enable(input) {
      const { userId } = input;
      try {
        return await prisma.$transaction(async (tx) => {
          const session = await lockSession(tx, input.sessionId);
          if (session?.mfaPendingSecret !== input.sealedSecret) return "STALE";
          const replaced = await lockFactor(tx, userId);
          // A session that has not passed MFA can set it up, never replace it.
          if (replaced && session.mfaVerifiedAt === null) return "STALE";
          const data = { secret: input.sealedSecret, lastUsedStep: input.step, enabledAt: input.verifiedAt };
          if (replaced) {
            await tx.userMfaFactor.update({ where: { userId }, data });
            await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
          } else {
            await tx.userMfaFactor.create({ data: { userId, ...data } });
          }
          await tx.userMfaRecoveryCode.createMany({ data: input.recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })) });
          await tx.session.update({
            where: { id: input.sessionId },
            data: { mfaPendingSecret: null, mfaVerifiedAt: input.verifiedAt, mfaFailedAttempts: 0 },
          });
          await tx.auditLog.create({ data: auditLogData(input.audit(replaced)) });
          return "ENABLED";
        });
      } catch (error) {
        // Another session's first set-up created the factor meanwhile, and this
        // one rolled back whole.
        const { code, meta } = error as { code?: unknown; meta?: { modelName?: unknown } };
        if (code !== "P2002" || meta?.modelName !== "UserMfaFactor") throw error;
        return "STALE";
      }
    },
    async acceptTotpStep(input) {
      return prisma.$transaction(async (tx) => {
        if (!(await lockSession(tx, input.sessionId))) return "SESSION_ENDED";
        // Moves only forward, so a code is accepted once even by concurrent
        // requests; and only for the factor it was checked against.
        const { count } = await tx.userMfaFactor.updateMany({
          where: { userId: input.userId, secret: input.sealedSecret, lastUsedStep: { lt: input.step } },
          data: { lastUsedStep: input.step },
        });
        if (count === 0) return "REJECTED";
        await pass(tx, input.sessionId, input.verifiedAt);
        await tx.auditLog.create({ data: auditLogData(input.audit) });
        return "ACCEPTED";
      });
    },
    async acceptRecoveryCode(input) {
      return prisma.$transaction(async (tx) => {
        if (!(await lockSession(tx, input.sessionId))) return "SESSION_ENDED";
        if (!(await lockFactor(tx, input.userId))) return "REJECTED";
        const { count } = await tx.userMfaRecoveryCode.deleteMany({
          where: { userId: input.userId, codeHash: input.codeHash },
        });
        if (count === 0) return "REJECTED";
        const codesLeft = await tx.userMfaRecoveryCode.count({ where: { userId: input.userId } });
        await pass(tx, input.sessionId, input.verifiedAt);
        await tx.auditLog.create({ data: auditLogData(input.audit(codesLeft)) });
        return "ACCEPTED";
      });
    },
    async recordFailedCode(sessionId, limit, audit) {
      return prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ mfaFailedAttempts: number }[]>`
          UPDATE "sessions" SET "mfaFailedAttempts" = "mfaFailedAttempts" + 1
          WHERE "id" = ${sessionId}
          RETURNING "mfaFailedAttempts"`;
        if (!row) return { outcome: "SESSION_ENDED" } as const;
        if (row.mfaFailedAttempts < limit) {
          return { outcome: "COUNTED", attemptsLeft: limit - row.mfaFailedAttempts } as const;
        }
        await tx.session.delete({ where: { id: sessionId } });
        await tx.auditLog.create({ data: auditLogData(audit) });
        return { outcome: "LOCKED" } as const;
      });
    },
    async replaceRecoveryCodes({ userId, sessionId, codeHashes, audit }) {
      return prisma.$transaction(async (tx) => {
        if (!passed(await lockSession(tx, sessionId), userId)) return "SESSION_ENDED";
        if (!(await lockFactor(tx, userId))) return "NOT_ENABLED";
        await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
        await tx.userMfaRecoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userId, codeHash })) });
        await tx.auditLog.create({ data: auditLogData(audit) });
        return "REPLACED";
      });
    },
    async disable(input) {
      const { userId } = input;
      return prisma.$transaction(async (tx) => {
        if (!passed(await lockSession(tx, input.sessionId), userId)) return "SESSION_ENDED";
        // The recovery codes go with the factor (foreign-key cascade).
        const { count } = await tx.userMfaFactor.deleteMany({
          where: { userId, secret: input.sealedSecret, lastUsedStep: { lt: input.step } },
        });
        if (count === 0) return "REJECTED";
        await tx.auditLog.create({ data: auditLogData(input.audit) });
        return "ACCEPTED";
      });
    },
  };
}

interface LockedSession {
  readonly userId: string;
  readonly mfaVerifiedAt: Date | null;
  readonly mfaPendingSecret: string | null;
}

async function lockSession(tx: Prisma.TransactionClient, sessionId: string): Promise<LockedSession | null> {
  const [row] = await tx.$queryRaw<LockedSession[]>`
    SELECT "userId", "mfaVerifiedAt", "mfaPendingSecret" FROM "sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
  return row ?? null;
}

/** The session, as stored, is the user's and passed MFA: not ended since the caller read it. */
function passed(session: LockedSession | null, userId: string): boolean {
  return session !== null && session.userId === userId && session.mfaVerifiedAt !== null;
}

/** Lock the user's factor; false when MFA is off. */
async function lockFactor(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "user_mfa_factors" WHERE "userId" = ${userId} FOR UPDATE`;
  return rows.length > 0;
}

function pass(tx: Prisma.TransactionClient, sessionId: string, verifiedAt: Date): Promise<unknown> {
  return tx.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: verifiedAt, mfaFailedAttempts: 0 } });
}
