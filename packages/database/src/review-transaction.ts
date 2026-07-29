import type { PrismaClient } from "@prisma/client";
import type { ReviewRepositories, ReviewTransaction } from "@app/domain";
import { createPrismaAnalysisRepository } from "./analysis-repositories";
import { createPrismaPropertyRepositories } from "./property-repositories";

/**
 * Prisma-backed {@link ReviewTransaction}.
 *
 * Repositories are rebuilt against the transaction client inside `run`, so both
 * the analysis review update and the asset status update go through the *same*
 * transaction. Building them once outside would silently write outside it — the
 * failure this port exists to prevent.
 *
 * A throw inside the callback rolls the whole unit back and propagates; Prisma
 * commits only when the callback resolves.
 */
export function createPrismaReviewTransaction(prisma: PrismaClient): ReviewTransaction {
  return {
    run<T>(fn: (repos: ReviewRepositories) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => {
        // `tx` is a TransactionClient: structurally a PrismaClient minus the
        // connection-lifecycle methods, which these repositories never call.
        const scoped = tx as unknown as PrismaClient;
        return fn({
          analyses: createPrismaAnalysisRepository(scoped),
          assets: createPrismaPropertyRepositories(scoped).assets,
        });
      });
    },
  };
}
