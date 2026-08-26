import type { SceneGeneration as DbSceneGeneration, PrismaClient } from "@prisma/client";
import type {
  ClaimedSceneGeneration,
  FailedSceneGeneration,
  PreflightRefusalReason,
  SceneGeneration,
  SceneGenerationExecutionRepository,
  SystemGenerationCandidate,
} from "@app/domain";
import { assertTransition, preflightFailureStateFor } from "@app/domain";
import { AppError } from "@app/shared";
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
 * Rebuild the mapped row with its state narrowed to one the caller has already
 * proved.
 *
 * `state` is passed separately rather than read back off the row, so the value
 * in the returned object is the one the invariant check above it tested — not a
 * second read that a cast would have to assume still agrees. Nothing is
 * asserted away: `toGeneration` produces the row, and only the field whose value
 * has just been verified is replaced, with the same value.
 */
function inState<S extends SceneGeneration["state"]>(
  row: DbSceneGenerationWithProject,
  state: S,
): Omit<SceneGeneration, "state"> & { readonly state: S } {
  return { ...toGeneration(row), state };
}

/**
 * The system-scoped execution boundary, backed by PostgreSQL.
 *
 * **This adapter is trusted, and its trust is bounded by its surface.** It is
 * the only place in the system where a `SceneGeneration` is reachable without
 * naming its organization first, which is exactly why it is three methods long
 * and lives apart from `createPrismaSceneGenerationRepository`. Every method
 * here *resolves* tenant identity and hands it back; none accepts one.
 *
 * Discovery runs without a transaction because it writes nothing. The claim and
 * the preflight-failure park each run inside one, and it is worth being exact
 * about what that buys: **the transaction guarantees only that the method never
 * hands back a row other than the one it moved itself.** It does not make every
 * future writer of this row safe. A writer that starts after that transaction commits
 * is entirely unaffected by it, and `SceneGenerationRepository.update` carries
 * no state predicate — so any future competing transition (cancellation above
 * all) must carry its own expected-state predicate. That requirement is
 * recorded as a hard prerequisite in `docs/decisions/TODO.md`; it is not
 * something this adapter can provide on its behalf.
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
      // Legality first, and from the domain rather than restated here. This
      // adapter decides *who* gets to make the move; whether `QUEUED →
      // SUBMITTING` is a legal move at all is the state machine's answer, and
      // asking it is what keeps a hard-coded pair in a persistence file from
      // quietly becoming a second state machine.
      assertTransition("QUEUED", "SUBMITTING");

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
      // transaction's own write. That is the full extent of the guarantee: it
      // says nothing about a writer that starts after this commit.
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

        // Past this point `null` is no longer available, and that is the whole
        // point of the distinction. `null` has exactly one meaning to a caller:
        // *this caller did not win a QUEUED claim*, an ordinary outcome it
        // handles by moving on to other work. The database has just told us the
        // opposite — `count === 1`, this caller **did** win — so anything that
        // goes wrong from here is an invariant failure, not a lost race.
        //
        // Reporting it as `null` would launder a broken invariant into a
        // routine one, and the row would be left in `SUBMITTING` with every
        // worker believing it belongs to someone else: stalled work that no
        // alarm ever fires for. Throwing inside the transaction rolls the claim
        // back instead, so the row returns to `QUEUED` and stays discoverable.
        //
        // Neither branch is reachable today. A missing row would need a
        // deletion path `scene_generations` does not have (its parent is `ON
        // DELETE RESTRICT`, precisely to keep paid-attempt history); a row in
        // another state would mean the row lock did not hold. Both are
        // impossible-by-construction rather than impossible-by-hope, which is
        // why they are asserted rather than assumed.
        if (!row) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation disappeared within its own claim transaction",
            { details: { generationId } },
          );
        }
        // The tenant is the one thing this method promises to have *resolved*.
        // The relation is required in the schema, so this is a type-level
        // impossibility rather than a plausible runtime path — but returning a
        // claim without an organization would be worse than any of the other
        // failures here, so it is checked rather than trusted.
        if (row.videoProject === null || row.videoProject === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation has no resolvable owning VideoProject",
            { details: { generationId } },
          );
        }
        if (row.state !== "SUBMITTING") {
          throw new AppError(
            "INTERNAL_ERROR",
            "Claimed scene generation was not SUBMITTING after a won claim",
            { details: { generationId, state: row.state } },
          );
        }
        return {
          organizationId: row.videoProject.organizationId,
          // `SUBMITTING` is not asserted here — it was just proved, two lines
          // up, against the row this transaction wrote and locked.
          generation: inState(row, "SUBMITTING"),
        } satisfies ClaimedSceneGeneration;
      });
    },

    async failQueuedPreflight(generationId: string, reason: PreflightRefusalReason) {
      // The target is derived from the refusal, not chosen here and not accepted
      // from a caller. `preflightFailureStateFor` routes the reason through its
      // disposition, so this adapter has no opinion about which refusals are
      // recoverable — restating that opinion in a persistence file is how the
      // durable record starts disagreeing with the domain.
      const target = preflightFailureStateFor(reason);

      // Legality from the domain, exactly as the claim does it. Both new edges
      // are legal only because nothing has been sent yet; asking the state
      // machine rather than assuming is what keeps this file from becoming a
      // second transition table.
      assertTransition("QUEUED", target);

      // Same transaction shape as the claim, for the same reason: `updateMany`
      // returns a count rather than rows, so the parked row must be read back,
      // and outside a transaction that read is a TOCTOU window a legal
      // `QUEUED -> CANCELLED` can commit inside. Within the transaction the
      // `UPDATE` holds the row lock until commit, so the `SELECT` sees this
      // transaction's own write and nothing else's.
      return prisma.$transaction(async (tx) => {
        // The compare-and-swap, competing on the identical predicate the claim
        // uses. That shared predicate is the whole safety argument for R1: two
        // writers, one row, one `state = 'QUEUED'` — the database picks one, and
        // a preflight failure can therefore never overwrite a row that has
        // already been claimed and may already have been paid for.
        //
        // `normalizedErrorMessage: null` is written **explicitly**, not omitted.
        // Omitting it would leave whatever message the column already held, and
        // a future explicit requeue policy can bring a row back to `QUEUED` with
        // a message from an earlier failure still on it. The durable code would
        // then describe this refusal while the durable message described the
        // previous one — a diagnostic that is worse than none, because it reads
        // as authoritative.
        const { count } = await tx.sceneGeneration.updateMany({
          where: { id: generationId, state: "QUEUED" },
          data: { state: target, normalizedErrorCode: reason, normalizedErrorMessage: null },
        });
        if (count === 0) return null;

        const row = await tx.sceneGeneration.findUnique({
          where: { id: generationId },
          include: { videoProject: { select: { organizationId: true } } },
        });

        // Past here `null` is unavailable, for the reason it is unavailable in
        // the claim: `null` means *this caller did not win*, and the database
        // has just said the opposite. Reporting an invariant failure as a lost
        // race would leave a row parked in a failure state that no caller
        // believes it wrote. Throwing inside the transaction rolls the write
        // back, so the row stays `QUEUED` and stays discoverable — which is the
        // safe direction here precisely because nothing was submitted.
        if (!row) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Failed scene generation disappeared within its own preflight-failure transaction",
            { details: { generationId } },
          );
        }
        if (row.videoProject === null || row.videoProject === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Failed scene generation has no resolvable owning VideoProject",
            { details: { generationId } },
          );
        }
        if (row.state !== target) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation was not in its derived failure state after a won preflight failure",
            { details: { generationId, state: row.state, expected: target } },
          );
        }
        // The diagnostics are checked, not assumed, because they are the whole
        // product of this method: a parked row whose code did not persist is
        // indistinguishable from one parked for some other reason entirely.
        if (row.normalizedErrorCode !== reason) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation did not carry its refusal reason after a won preflight failure",
            { details: { generationId, reason } },
          );
        }
        if (row.normalizedErrorMessage !== null) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Scene generation retained a stale diagnostic message after a won preflight failure",
            { details: { generationId } },
          );
        }
        return {
          organizationId: row.videoProject.organizationId,
          // Likewise `target`: the check above compared it against the row, so
          // this narrows to a value already verified rather than a claim.
          generation: inState(row, target),
        } satisfies FailedSceneGeneration;
      });
    },
  };
}
