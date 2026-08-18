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
      // The update and the re-read share one transaction, and that is
      // load-bearing rather than tidiness.
      //
      // `updateMany` returns a count, not rows, so the claimed row must be read
      // back. Outside a transaction that read is a TOCTOU window, and the window
      // is reachable: `QUEUED → CANCELLED` is a legal transition, and
      // `SceneGenerationRepository.update` deliberately carries no state
      // predicate — it "persists what it is asked to persist", leaving legality
      // to `assertTransition`. So a cancellation that observed `QUEUED` can
      // commit between the two statements and this method would hand back a row
      // in `CANCELLED` while typing it as claimed — a caller's licence to submit,
      // issued for work someone else already stopped.
      //
      // Inside a transaction the `UPDATE` holds a row lock until commit, so that
      // cancellation blocks rather than interleaving, and the `SELECT` sees this
      // transaction's own write.
      return prisma.$transaction(async (tx) => {
        // The compare-and-swap. `state: "QUEUED"` inside the predicate is what
        // makes this exclusive: two workers issuing this concurrently for the
        // same id produce one update and one no-op, decided by the database
        // rather than by anything this process observed beforehand.
        //
        // `updateMany` rather than `update` is also deliberate — `update`
        // requires a unique selector and would throw when the predicate does not
        // match, turning "someone else won the race" into an exception. Losing a
        // race is an ordinary outcome, so it is reported as `null`.
        const { count } = await tx.sceneGeneration.updateMany({
          where: { id: generationId, state: "QUEUED" },
          data: { state: "SUBMITTING" },
        });
        if (count === 0) return null;

        const row = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });

        // Two refusals rather than an assertion, because a claim that is not
        // demonstrably in `SUBMITTING` must never be granted:
        //
        // - a missing row cannot happen today (`scene_generations` has no
        //   deletion path, and its `ON DELETE RESTRICT` parent exists to keep
        //   paid-attempt history), so this is defensive;
        // - a row in any other state would mean the lock did not hold, which is
        //   the failure this transaction exists to prevent. Returning `null`
        //   reuses the vocabulary the caller already handles — "you did not get
        //   this one" — rather than inventing an error the domain has not
        //   defined.
        if (!row || row.state !== "SUBMITTING") return null;
        return toCandidate(row) satisfies ClaimedSceneGeneration;
      });
    },
  };
}
