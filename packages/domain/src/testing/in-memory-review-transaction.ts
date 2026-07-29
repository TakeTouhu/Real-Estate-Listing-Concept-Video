import type { ReviewRepositories, ReviewTransaction } from "../analysis/ports";
import type { InMemoryAssetAnalysisRepository } from "./in-memory-analysis";
import type { InMemoryMediaAssetRepository } from "./in-memory-property";

/**
 * In-memory {@link ReviewTransaction} with real rollback semantics: state is
 * captured before the callback runs and restored if it throws, so a partially
 * applied unit of work is impossible here exactly as it is in PostgreSQL.
 *
 * Without the restore, tests would pass against a double that commits partial
 * writes while the Prisma implementation does not — the failure the port exists
 * to prevent would be invisible in unit tests.
 */
export class InMemoryReviewTransaction implements ReviewTransaction {
  constructor(
    private readonly analyses: InMemoryAssetAnalysisRepository,
    private readonly assets: InMemoryMediaAssetRepository,
  ) {}

  async run<T>(fn: (repos: ReviewRepositories) => Promise<T>): Promise<T> {
    const analysesBefore = this.analyses.snapshot();
    const assetsBefore = this.assets.snapshot();
    try {
      return await fn({ analyses: this.analyses, assets: this.assets });
    } catch (error) {
      this.analyses.restore(analysesBefore);
      this.assets.restore(assetsBefore);
      throw error;
    }
  }
}
