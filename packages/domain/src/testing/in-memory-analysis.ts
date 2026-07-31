import type { Clock } from "../identity/ports";
import type { AssetAnalysisRepository } from "../analysis/ports";
import type { AssetAnalysis } from "../analysis/types";

/** Thrown when a second analysis is created for an asset that already has one. */
export class DuplicateAnalysisError extends Error {
  constructor(readonly assetId: string) {
    super(`analysis already exists for asset ${assetId}`);
    this.name = "DuplicateAnalysisError";
  }
}

/**
 * In-memory analysis repository mirroring the tenant-scoping contract of the
 * Prisma adapter: every lookup is filtered by organizationId, so another
 * tenant's row is invisible rather than merely forbidden.
 *
 * It also mirrors the unique index on `asset_analyses.assetId` — including
 * rejecting asynchronously, the way a database constraint violation surfaces —
 * so the service's concurrency reconciliation is exercised realistically.
 */
export class InMemoryAssetAnalysisRepository implements AssetAnalysisRepository {
  private readonly byId = new Map<string, AssetAnalysis>();
  constructor(private readonly clock: Clock) {}

  /** Test-only: capture state so a transaction double can roll back. */
  snapshot(): Map<string, AssetAnalysis> {
    return new Map(this.byId);
  }

  /** Test-only: discard writes made since {@link snapshot}. */
  restore(state: Map<string, AssetAnalysis>): void {
    this.byId.clear();
    for (const [id, row] of state) this.byId.set(id, row);
  }

  create(input: Omit<AssetAnalysis, "createdAt" | "updatedAt">): Promise<AssetAnalysis> {
    if ([...this.byId.values()].some((a) => a.assetId === input.assetId)) {
      return Promise.reject(new DuplicateAnalysisError(input.assetId));
    }
    const now = this.clock.now();
    const row: AssetAnalysis = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(row.id, row);
    return Promise.resolve(row);
  }

  findById(organizationId: string, id: string): Promise<AssetAnalysis | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row && row.organizationId === organizationId ? row : null);
  }

  findByAssetId(organizationId: string, assetId: string): Promise<AssetAnalysis | null> {
    return Promise.resolve(
      [...this.byId.values()].find(
        (a) => a.organizationId === organizationId && a.assetId === assetId,
      ) ?? null,
    );
  }

  listByAssetIds(organizationId: string, assetIds: readonly string[]): Promise<AssetAnalysis[]> {
    if (assetIds.length === 0) return Promise.resolve([]);
    const wanted = new Set(assetIds);
    return Promise.resolve(
      [...this.byId.values()]
        .filter((a) => a.organizationId === organizationId && wanted.has(a.assetId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  update(analysis: AssetAnalysis): Promise<AssetAnalysis> {
    if (!this.byId.has(analysis.id)) {
      return Promise.reject(new Error(`analysis ${analysis.id} not found`));
    }
    // Mirrors the partial unique index
    // (organizationId, duplicateGroup) WHERE reviewStatus = 'APPROVED'.
    // The error carries the real constraint name because the service maps the
    // conflict by that name; a double that let two approvals through would make
    // the duplicate-conflict tests prove nothing.
    if (analysis.reviewStatus === "APPROVED" && analysis.duplicateGroup) {
      const conflict = [...this.byId.values()].some(
        (a) =>
          a.id !== analysis.id &&
          a.organizationId === analysis.organizationId &&
          a.duplicateGroup === analysis.duplicateGroup &&
          a.reviewStatus === "APPROVED",
      );
      if (conflict) {
        return Promise.reject(
          new Error(
            'duplicate key value violates unique constraint "asset_analyses_org_dupgroup_approved_key"',
          ),
        );
      }
    }
    this.byId.set(analysis.id, analysis);
    return Promise.resolve(analysis);
  }

  /** Test-only: every stored row regardless of organization. */
  all(): AssetAnalysis[] {
    return [...this.byId.values()];
  }
}
