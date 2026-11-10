import type { AccountLink as DbAccountLink, PrismaClient } from "@prisma/client";
import type { AccountLink, AccountLinkRepository } from "@app/domain";
import { auditLogData } from "./audit-log-data";

function toAccountLink(r: DbAccountLink): AccountLink {
  return {
    id: r.id,
    userId: r.userId,
    purpose: r.purpose,
    tokenHash: r.tokenHash,
    email: r.email,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
  };
}

/**
 * One-time links mailed to users, in PostgreSQL (ADR-0128). Using a link locks
 * the user's row before it touches the link, so uses for one user run one at a
 * time; making a link touches no existing link.
 */
export function createPrismaAccountLinkRepository(prisma: PrismaClient): AccountLinkRepository {
  return {
    async create(link, audit) {
      return prisma.$transaction(async (tx) => {
        const { id, userId, purpose, tokenHash, email, createdAt, expiresAt } = link;
        // `createdAt` is the service's clock, which the window's CHECK compares
        // `expiresAt` and `usedAt` with.
        const row = await tx.accountLink.create({
          data: { id, userId, purpose, tokenHash, email, createdAt, expiresAt },
        });
        await tx.auditLog.create({ data: auditLogData(audit) });
        return toAccountLink(row);
      });
    },
    async findByTokenHash(tokenHash) {
      const r = await prisma.accountLink.findUnique({ where: { tokenHash } });
      return r ? toAccountLink(r) : null;
    },
    async useForEmailVerification(input) {
      return prisma.$transaction(async (tx) => {
        // A second opening of this link, or another link of the user's, waits
        // here and then sees the address verified. NO KEY UPDATE, the lock the
        // update below takes anyway, so a new link, which only references the
        // row, is not held up. A sign-in's FOR SHARE waits (ADR-0131).
        const [user] = await tx.$queryRaw<{ status: string; email: string; emailVerifiedAt: Date | null }[]>`
          SELECT "status", "email", "emailVerifiedAt" FROM "users" WHERE "id" = ${input.userId}
          FOR NO KEY UPDATE`;
        if (!user || user.status !== "ACTIVE" || user.email !== input.email || user.emailVerifiedAt !== null) {
          return "STALE";
        }
        const { count } = await tx.accountLink.updateMany({
          where: {
            id: input.linkId,
            userId: input.userId,
            purpose: "EMAIL_VERIFICATION",
            email: input.email,
            usedAt: null,
            expiresAt: { gt: input.usedAt },
          },
          data: { usedAt: input.usedAt },
        });
        if (count === 0) return "STALE";
        await tx.user.update({ where: { id: input.userId }, data: { emailVerifiedAt: input.usedAt } });
        await tx.auditLog.create({ data: auditLogData(input.audit) });
        return "APPLIED";
      });
    },
  };
}
