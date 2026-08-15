import type { SceneGeneration as DbSceneGeneration, PrismaClient } from "@prisma/client";
import type {
  NewSceneGeneration,
  SceneGeneration,
  SceneGenerationRepository,
  SceneGenerationUpdate,
} from "@app/domain";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  ActiveGenerationConflictError,
  SceneGenerationNotFoundError,
} from "@app/domain";

/**
 * The fields the active-request partial unique index covers.
 *
 * Matched as an exact, order-insensitive **set**. Two failure modes are being
 * avoided at once:
 *
 * - Matching the index *name* would silently never fire. Prisma identifies a
 *   constraint by the fields it covers, not by a hand-written index name, and
 *   `analysis-repositories.ts` carries the scar from an earlier version that
 *   got this wrong. Verified against live PostgreSQL in Phase 4A-2a: the
 *   collision arrives as `P2002` with
 *   `meta.target = ["videoProjectId", "requestHash"]`, and the string
 *   `scene_generations_active_request_key` appears nowhere in it.
 * - Matching too loosely would misclassify. A future unique constraint over a
 *   *superset* — say `(videoProjectId, requestHash, providerName)` — is a
 *   different invariant with different meaning, so cardinality is checked as
 *   well as membership. Substring matching, as the older `covers()` helper
 *   does, is deliberately not reused here.
 */
const ACTIVE_REQUEST_TARGET = ["videoProjectId", "requestHash"] as const;

/**
 * Translate the storage-specific uniqueness violation into the domain's neutral
 * conflict type, and leave everything else strictly alone.
 *
 * Only the active-request collision is translated. A duplicate primary key is
 * also `P2002` and must **not** become an `ActiveGenerationConflictError`; a
 * foreign-key failure (`P2003`) must not either. Both propagate unchanged, so a
 * future worker can classify a genuine database failure as a database failure
 * rather than as "someone else got there first".
 */
function translateWriteError(error: unknown): unknown {
  if ((error as { code?: unknown }).code !== "P2002") return error;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (!Array.isArray(target)) return error;
  const fields = target.map(String);
  const isActiveRequest =
    fields.length === ACTIVE_REQUEST_TARGET.length &&
    ACTIVE_REQUEST_TARGET.every((field) => fields.includes(field));
  return isActiveRequest ? new ActiveGenerationConflictError() : error;
}

function toGeneration(r: DbSceneGeneration): SceneGeneration {
  return {
    id: r.id,
    videoProjectId: r.videoProjectId,
    sourceStoryboardSceneId: r.sourceStoryboardSceneId,
    assetId: r.assetId,
    sourceAnalysisRevision: r.sourceAnalysisRevision,
    requestHash: r.requestHash,
    providerName: r.providerName,
    providerModelId: r.providerModelId,
    // The immutable request snapshot (ADR-0018). Mapped explicitly like every
    // other field; a legacy row simply carries nulls through, which is what
    // lets `generationRequestFactsFrom` fail closed instead of guessing.
    requestCompiledPrompt: r.requestCompiledPrompt,
    requestDurationSeconds: r.requestDurationSeconds,
    requestCameraMotion: r.requestCameraMotion,
    requestAspectRatio: r.requestAspectRatio,
    requestResolution: r.requestResolution,
    state: r.state,
    providerPredictionId: r.providerPredictionId,
    submittedAt: r.submittedAt,
    lastPolledAt: r.lastPolledAt,
    normalizedErrorCode: r.normalizedErrorCode,
    normalizedErrorMessage: r.normalizedErrorMessage,
    outputStorageKey: r.outputStorageKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Prisma-backed scene-generation persistence.
 *
 * Generations carry no organization column, so their tenant scope is resolved
 * through the owning project on **every** operation —
 * `videoProject: { organizationId }` is a join predicate inside the query, not
 * an application-side check that could be forgotten or short-circuited. Reads
 * return `null` and writes throw {@link SceneGenerationNotFoundError} when a row
 * is not this tenant's, which is the same answer they give when it does not
 * exist at all.
 *
 * `create` is the one operation that cannot express the boundary as a predicate
 * on the row being written — the row does not exist yet, and its project id is
 * caller-supplied. It therefore verifies ownership of the target project first,
 * and refuses with the same neutral not-found error. Review caught the earlier
 * version of this method, which trusted `input.videoProjectId` outright.
 *
 * The adapter persists what it is asked to persist. It holds no state machine:
 * whether a requested transition is legal is decided by the domain, and there
 * are no SQL triggers.
 */
export function createPrismaSceneGenerationRepository(
  prisma: PrismaClient,
): SceneGenerationRepository {
  return {
    async create(organizationId: string, input: NewSceneGeneration) {
      // The tenant boundary, and it must come BEFORE the insert.
      //
      // `input.videoProjectId` is caller-supplied. Without this check a caller
      // could write an attempt into another organization's project — and then
      // read that organization's state back out, because a colliding request
      // would answer ActiveGenerationConflictError and so disclose that the
      // other tenant has an attempt in flight for that exact request. Checking
      // first means a foreign caller never reaches the active-request index.
      //
      // This is a boundary check only. It is emphatically **not**
      // `find active -> if absent -> create`: the partial unique index remains
      // the sole concurrency and idempotency authority, and the collision below
      // is still handled.
      const project = await prisma.videoProject.findFirst({
        where: { id: input.videoProjectId, organizationId },
        select: { id: true },
      });
      // A project that does not exist and one belonging to another tenant give
      // the same answer, so this cannot be used to probe for either.
      if (!project) throw new SceneGenerationNotFoundError();

      try {
        // Enumerated rather than spread, so a future field on the entity cannot
        // become a silent write, and neither timestamp can be supplied.
        const row = await prisma.sceneGeneration.create({
          data: {
            id: input.id,
            videoProjectId: input.videoProjectId,
            sourceStoryboardSceneId: input.sourceStoryboardSceneId,
            assetId: input.assetId,
            sourceAnalysisRevision: input.sourceAnalysisRevision,
            requestHash: input.requestHash,
            providerName: input.providerName,
            providerModelId: input.providerModelId,
            requestCompiledPrompt: input.requestCompiledPrompt,
            requestDurationSeconds: input.requestDurationSeconds,
            requestCameraMotion: input.requestCameraMotion,
            requestAspectRatio: input.requestAspectRatio,
            requestResolution: input.requestResolution,
            state: input.state,
            providerPredictionId: input.providerPredictionId,
            submittedAt: input.submittedAt,
            lastPolledAt: input.lastPolledAt,
            normalizedErrorCode: input.normalizedErrorCode,
            normalizedErrorMessage: input.normalizedErrorMessage,
            outputStorageKey: input.outputStorageKey,
          },
        });
        return toGeneration(row);
      } catch (error) {
        throw translateWriteError(error);
      }
    },

    async findById(organizationId: string, id: string) {
      const row = await prisma.sceneGeneration.findFirst({
        where: { id, videoProject: { organizationId } },
      });
      return row ? toGeneration(row) : null;
    },

    async findActiveByRequestIdentity(
      organizationId: string,
      videoProjectId: string,
      requestHash: string,
    ) {
      const row = await prisma.sceneGeneration.findFirst({
        where: {
          videoProjectId,
          requestHash,
          // The domain's set, imported rather than restated. A state added to
          // ACTIVE_SCENE_GENERATION_STATES becomes visible here automatically,
          // and the migration's matching predicate is guarded by its own test.
          state: { in: [...ACTIVE_SCENE_GENERATION_STATES] },
          videoProject: { organizationId },
        },
      });
      return row ? toGeneration(row) : null;
    },

    async findLatestSucceededByRequestIdentity(
      organizationId: string,
      videoProjectId: string,
      requestHash: string,
    ) {
      const row = await prisma.sceneGeneration.findFirst({
        where: {
          videoProjectId,
          requestHash,
          state: "SUCCEEDED",
          videoProject: { organizationId },
        },
        // Explicit and total. `createdAt` alone can tie — two attempts written
        // in the same millisecond are entirely possible — so `id` breaks it,
        // and the caller gets the same row every time rather than whatever the
        // planner happened to return.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return row ? toGeneration(row) : null;
    },

    async update(organizationId: string, id: string, changes: SceneGenerationUpdate) {
      // `changes` cannot express identity, provenance, or either timestamp, so
      // the fields enumerated here are exactly the mutable set. An absent key
      // arrives as `undefined`, which Prisma reads as "leave alone" — that is
      // what keeps a state-only update from disturbing providerPredictionId.
      //
      // updateMany scopes the write by organization through the project
      // relation, so another tenant's row matches nothing rather than being
      // overwritten.
      const changed = await prisma.sceneGeneration.updateMany({
        where: { id, videoProject: { organizationId } },
        data: {
          state: changes.state,
          providerPredictionId: changes.providerPredictionId,
          submittedAt: changes.submittedAt,
          lastPolledAt: changes.lastPolledAt,
          normalizedErrorCode: changes.normalizedErrorCode,
          normalizedErrorMessage: changes.normalizedErrorMessage,
          outputStorageKey: changes.outputStorageKey,
        },
      });
      // Zero rows means "not yours, or not there" — deliberately the same
      // answer for both, so an update cannot be used to probe for rows in
      // another organization.
      if (changed.count === 0) throw new SceneGenerationNotFoundError();

      // Reloaded under the SAME scope. An unscoped read here would quietly
      // widen what this method can return.
      const row = await prisma.sceneGeneration.findFirstOrThrow({
        where: { id, videoProject: { organizationId } },
      });
      return toGeneration(row);
    },
  };
}
