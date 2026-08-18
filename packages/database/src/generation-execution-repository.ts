import type { SceneGeneration as DbSceneGeneration, PrismaClient } from "@prisma/client";
import type {
  ClaimedSceneGeneration,
  SceneGenerationExecutionRepository,
  SystemGenerationCandidate,
} from "@app/domain";
import { toGeneration } from "./generation-repositories";

/**
 * The rows a `VideoProject` join must yield for tenant resolution.
 *
 * `organizationId` is read from the parent, never from the generation row —
 * `scene_generations` has no such column, and adding one was rejected: a
 * duplicated tenant id can disagree with its parent, and the moment it does,
 * one of the two is silently wrong.
 */
type DbSceneGenerationWithProject = DbSceneGeneration & {
  readonly videoProject: { readonly organizationId: string };
};

function toCandidate(row: DbSceneGenerationWithProject): SystemGenerationCandidate {
  return { organizationId: row.videoProject.organizationId, generation: toGeneration(row) };
}

/**
 * The system-scoped execution boundary, backed by PostgreSQL.
 *
 * **This adapter is trusted, and its trust is bounded by its surface.** It is
 * the only place in the system where a `SceneGeneration` is reachable without
 * naming its organization first, which is exactly why it is two methods long
 * and lives apart from `createPrismaSceneGenerationRepository`. Every method
 * here *resolves* tenant identity and hands it back; none accepts one.
 *
 * No transaction wraps either method. Neither needs one: discovery writes
 * nothing, and the claim is a single conditional `UPDATE` whose predicate is the
 * concurrency control.
 */
export function createPrismaSceneGenerationExecutionRepository(
  prisma: PrismaClient,
): SceneGenerationExecutionRepository {
  return {
    async findNextQueuedForPreparation() {
      const row = await prisma.sceneGeneration.findFirst({
        where: { state: "QUEUED" },
        // Oldest first, with `id` breaking ties so two rows written in the same
        // millisecond still order deterministically — the same convention
        // `findLatestSucceededByRequestIdentity` uses, inverted.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { videoProject: { select: { organizationId: true } } },
      });
      return row ? toCandidate(row) : null;
    },

    async claimQueuedForSubmission(generationId: string) {
      // The compare-and-swap. `state: "QUEUED"` inside the predicate is what
      // makes this exclusive: two workers issuing this concurrently for the same
      // id produce one update and one no-op, decided by the database rather than
      // by anything this process observed beforehand.
      //
      // `updateMany` rather than `update` is deliberate — `update` requires a
      // unique selector and would throw when the predicate does not match, which
      // would turn "someone else won the race" into an exception. Losing a race
      // is an ordinary outcome, so it is reported as `null`.
      const { count } = await prisma.sceneGeneration.updateMany({
        where: { id: generationId, state: "QUEUED" },
        data: { state: "SUBMITTING" },
      });
      if (count === 0) return null;

      // Re-read the row this call just won, with its tenant. A second query is
      // unavoidable — `updateMany` returns a count, not rows — but it is safe:
      // this caller holds the only claim, so nothing else may move the row out
      // of `SUBMITTING` (the state machine gives that transition to whoever
      // submits, and that is this caller).
      const row = await prisma.sceneGeneration.findUnique({
        where: { id: generationId },
        include: { videoProject: { select: { organizationId: true } } },
      });
      // Defensive rather than expected: a row cannot vanish between the update
      // and this read — `scene_generations` has no deletion path, and its
      // `ON DELETE RESTRICT` parent relation exists precisely to keep paid
      // attempt history. Returning `null` rather than asserting keeps the
      // adapter free of a failure vocabulary the domain has not defined.
      return row ? ({ ...toCandidate(row) } satisfies ClaimedSceneGeneration) : null;
    },
  };
}
