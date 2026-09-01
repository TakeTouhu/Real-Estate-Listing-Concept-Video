import type { Clock } from "../identity/ports";
import { ACTIVE_SCENE_GENERATION_STATES } from "../generation/state-machine";
import {
  ActiveGenerationConflictError,
  SceneGenerationNotFoundError,
  type NewSceneGeneration,
  type SceneGenerationRepository,
  type SceneGenerationUpdate,
} from "../generation/ports";
import type { SceneGeneration } from "../generation/types";

/**
 * In-memory scene-generation repository mirroring the **contract** of the Prisma
 * adapter — not its internals.
 *
 * It models what a caller can observe: tenant scope resolved through the owning
 * project, one active attempt per request identity, the neutral errors, and the
 * narrow succeeded lookup. It deliberately does **not** simulate `P2002`,
 * `P2003`, index names, or row locking; those are proven against real
 * PostgreSQL in Phases 4A-2a and 4A-2b, and a hand-rolled imitation of them
 * would be a second, unverified source of truth.
 *
 * The active-identity rule imports {@link ACTIVE_SCENE_GENERATION_STATES}
 * rather than restating it, so the double cannot drift from the domain — and
 * therefore cannot drift from the SQL predicate the domain's own test pins.
 *
 * Ownership is supplied as a fixture: tests register which organization owns
 * which project, which is the minimum needed to reproduce the real `create`
 * boundary check without a database.
 */
export class InMemorySceneGenerationRepository implements SceneGenerationRepository {
  private readonly byId = new Map<string, SceneGeneration>();
  /** projectId → organizationId, the fixture stand-in for the video_projects row. */
  private readonly projectOwners = new Map<string, string>();
  constructor(private readonly clock: Clock) {}

  /** Test fixture: declare that `videoProjectId` belongs to `organizationId`. */
  registerProject(organizationId: string, videoProjectId: string): void {
    this.projectOwners.set(videoProjectId, organizationId);
  }

  /** Test-only: every stored row, for assertions about what was written. */
  all(): readonly SceneGeneration[] {
    return [...this.byId.values()];
  }

  /**
   * Test fixture: place a **historical** row directly into the store, bypassing
   * `create`.
   *
   * This is the in-memory equivalent of seeding a legacy row with raw SQL, and
   * it exists because `NewSceneGeneration` deliberately cannot express one:
   * since ADR-0034 the current create port is V2-only, so a V1 attempt — or one
   * predating ADR-0018's snapshot or ADR-0023's prompt freeze — is not something
   * this application can write.
   *
   * Such rows still exist in the database and must stay readable, so tests need
   * a way to produce them. Routing that through a named seed rather than
   * loosening the create contract keeps the distinction visible: this is
   * history being restored, not an admission being made.
   *
   * It performs no tenant check and no active-request check on purpose — it is
   * standing in for data that is already there, not for a write.
   */
  seedHistorical(row: SceneGeneration): void {
    this.byId.set(row.id, row);
  }

  private owns(organizationId: string, videoProjectId: string): boolean {
    return this.projectOwners.get(videoProjectId) === organizationId;
  }

  private isActive(row: SceneGeneration): boolean {
    return ACTIVE_SCENE_GENERATION_STATES.includes(row.state);
  }

  create(organizationId: string, input: NewSceneGeneration): Promise<SceneGeneration> {
    // The tenant boundary, before anything else — exactly as the adapter does,
    // so a foreign caller never reaches the identity check and cannot learn
    // that another organization holds an active attempt.
    if (!this.owns(organizationId, input.videoProjectId)) {
      return Promise.reject(new SceneGenerationNotFoundError());
    }

    const collision = [...this.byId.values()].some(
      (row) =>
        row.videoProjectId === input.videoProjectId &&
        row.requestHash === input.requestHash &&
        this.isActive(row),
    );
    if (collision) return Promise.reject(new ActiveGenerationConflictError());

    const now = this.clock.now();
    const row: SceneGeneration = { ...input, createdAt: now, updatedAt: now };
    this.byId.set(row.id, row);
    return Promise.resolve(row);
  }

  findById(organizationId: string, id: string): Promise<SceneGeneration | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row && this.owns(organizationId, row.videoProjectId) ? row : null);
  }

  findActiveByRequestIdentity(
    organizationId: string,
    videoProjectId: string,
    requestHash: string,
  ): Promise<SceneGeneration | null> {
    if (!this.owns(organizationId, videoProjectId)) return Promise.resolve(null);
    const row = [...this.byId.values()].find(
      (candidate) =>
        candidate.videoProjectId === videoProjectId &&
        candidate.requestHash === requestHash &&
        this.isActive(candidate),
    );
    return Promise.resolve(row ?? null);
  }

  findLatestSucceededByRequestIdentity(
    organizationId: string,
    videoProjectId: string,
    requestHash: string,
  ): Promise<SceneGeneration | null> {
    if (!this.owns(organizationId, videoProjectId)) return Promise.resolve(null);
    // Exactly the adapter's ordering: `createdAt` descending, then `id`
    // descending. Not "some deterministic order" — the *same* one, or a service
    // test could observe a different row than production when two attempts share
    // a timestamp and lexical id order differs from insertion order, which is
    // precisely the case the double exists to model faithfully.
    //
    // `<` / `>` rather than `localeCompare`, matching `orderScenes` and staying
    // closer to PostgreSQL's ordering than a locale-sensitive comparison.
    const rows = [...this.byId.values()]
      .filter(
        (candidate) =>
          candidate.videoProjectId === videoProjectId &&
          candidate.requestHash === requestHash &&
          candidate.state === "SUCCEEDED",
      )
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    return Promise.resolve(rows[0] ?? null);
  }

  update(
    organizationId: string,
    id: string,
    changes: SceneGenerationUpdate,
  ): Promise<SceneGeneration> {
    const existing = this.byId.get(id);
    // "Not yours" and "not there" give the same answer, as they must.
    if (!existing || !this.owns(organizationId, existing.videoProjectId)) {
      return Promise.reject(new SceneGenerationNotFoundError());
    }

    // Enumerated, so identity and provenance cannot be written even if a caller
    // finds a way to smuggle them past the type. An absent key leaves the field
    // alone — which is what keeps a state-only update from clearing
    // providerPredictionId.
    const updated: SceneGeneration = {
      ...existing,
      state: changes.state ?? existing.state,
      providerPredictionId:
        changes.providerPredictionId === undefined
          ? existing.providerPredictionId
          : changes.providerPredictionId,
      submittedAt: changes.submittedAt === undefined ? existing.submittedAt : changes.submittedAt,
      lastPolledAt:
        changes.lastPolledAt === undefined ? existing.lastPolledAt : changes.lastPolledAt,
      normalizedErrorCode:
        changes.normalizedErrorCode === undefined
          ? existing.normalizedErrorCode
          : changes.normalizedErrorCode,
      normalizedErrorMessage:
        changes.normalizedErrorMessage === undefined
          ? existing.normalizedErrorMessage
          : changes.normalizedErrorMessage,
      outputStorageKey:
        changes.outputStorageKey === undefined
          ? existing.outputStorageKey
          : changes.outputStorageKey,
      updatedAt: this.clock.now(),
    };
    this.byId.set(id, updated);
    return Promise.resolve(updated);
  }
}
