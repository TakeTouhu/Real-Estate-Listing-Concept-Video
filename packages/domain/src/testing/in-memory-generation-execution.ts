import type {
  ClaimedSceneGeneration,
  SceneGenerationExecutionRepository,
  SystemGenerationCandidate,
} from "../generation/execution-ports";
import type { SceneGeneration } from "../generation/types";

/**
 * In-memory system-scoped execution repository, mirroring the **contract** of
 * the Prisma adapter rather than its mechanism.
 *
 * It models what a caller can observe: discovery is read-only and ordered
 * oldest-first, the claim is exclusive, and tenant identity is resolved from the
 * owning project rather than accepted from the caller. It deliberately does
 * **not** imitate `updateMany` semantics, row locking, or transaction
 * visibility — those are proven against real PostgreSQL in this milestone's
 * integration suite, and a hand-rolled imitation would be a second, unverified
 * source of truth for the one boundary that decides who may spend money.
 *
 * Ownership is a fixture for the same reason the tenant-facing double takes
 * one: reproducing the real `VideoProject` join without a database.
 */
export class InMemorySceneGenerationExecutionRepository
  implements SceneGenerationExecutionRepository
{
  private readonly byId = new Map<string, SceneGeneration>();
  /** projectId → organizationId, standing in for the `video_projects` row. */
  private readonly projectOwners = new Map<string, string>();

  /** Test fixture: declare that `videoProjectId` belongs to `organizationId`. */
  registerProject(organizationId: string, videoProjectId: string): void {
    this.projectOwners.set(videoProjectId, organizationId);
  }

  /** Test fixture: seed a persisted row, as admission would have written it. */
  seed(row: SceneGeneration): void {
    this.byId.set(row.id, row);
  }

  /** Test-only: every stored row, for assertions about what was written. */
  all(): readonly SceneGeneration[] {
    return [...this.byId.values()];
  }

  /**
   * The resolved tenant, or `undefined` when the fixture never registered one.
   *
   * A row whose project has no owner is not silently assigned to anybody: the
   * real adapter reaches `organizationId` through a required relation, so an
   * unregistered project is a fixture error, and surfacing it as "no candidate"
   * is better than inventing a tenant.
   */
  private ownerOf(row: SceneGeneration): string | undefined {
    return this.projectOwners.get(row.videoProjectId);
  }

  findNextQueuedForPreparation(): Promise<SystemGenerationCandidate | null> {
    const queued = [...this.byId.values()]
      .filter((row) => row.state === "QUEUED")
      // Oldest first, `id` breaking ties — the adapter's ordering, restated
      // here because a double that returned an arbitrary row would let an
      // ordering regression pass unit tests.
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );

    for (const generation of queued) {
      const organizationId = this.ownerOf(generation);
      if (organizationId !== undefined) return Promise.resolve({ organizationId, generation });
    }
    return Promise.resolve(null);
  }

  claimQueuedForSubmission(generationId: string): Promise<ClaimedSceneGeneration | null> {
    const existing = this.byId.get(generationId);
    // The compare-and-swap, single-threaded: the state check and the write
    // happen without an await between them, which is this double's stand-in for
    // the database deciding the race.
    if (!existing || existing.state !== "QUEUED") return Promise.resolve(null);

    const organizationId = this.ownerOf(existing);
    if (organizationId === undefined) return Promise.resolve(null);

    const claimed: SceneGeneration = { ...existing, state: "SUBMITTING" };
    this.byId.set(generationId, claimed);
    return Promise.resolve({ organizationId, generation: claimed });
  }
}
