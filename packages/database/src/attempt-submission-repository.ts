/**
 * The attempt submission's persistence (GS-7c-2a, ADR-0097).
 *
 * Two operations on orchestrated attempts, and nothing that sends one:
 *
 * - **Discovery.** The attempts waiting to be sent, oldest first, read without
 *   locks: a hint, which the paid-submission gate re-decides under its own
 *   locks (ADR-0096). Each comes with the organization its project names, so
 *   preparation can address its photo through the tenant-scoped repository.
 * - **The ending of a refused preparation.** One `QUEUED` attempt whose
 *   preparation was refused for good is cancelled before submission, nothing
 *   having been sent, with its transition event, in one commit.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> the attempt (its compare-and-set)
 * ```
 *
 * The lock every writer of an attempt's orchestration state takes first: the
 * gate, the submission outcome, completion, reconciliation, Transactions H, K
 * and L. Taking it first keeps this ending out of every cycle with them; nothing
 * here locks a photo, a Property, a reservation or a job, and nothing waits
 * once the attempt is held.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE,
  canTransitionAttempt,
  preparationRefusalEnding,
  validateAttemptSubmissionBatchLimit,
  type AttemptSubmissionRepository,
  type EndPreparationRefusalInput,
  type EndPreparationRefusalOutcome,
  type SystemGenerationCandidate,
  type TransitionContext,
} from "@app/domain";
import { AppError } from "@app/shared";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { toGeneration } from "./generation-repositories";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export function createAttemptSubmissionRepository(prisma: PrismaClient): AttemptSubmissionRepository {
  return {
    async findSubmissionCandidates({ limit: requested }) {
      // Validated here as well as by the caller: this method is public, and a
      // caller reaching it directly must not put `Infinity` into a SQL LIMIT.
      const limit = validateAttemptSubmissionBatchLimit(requested);
      const rows = await prisma.sceneGeneration.findMany({
        where: {
          orchestrationState: "QUEUED",
          OR: [{ submissionCertainty: null }, { submissionCertainty: "PRE_SUBMISSION" }],
          generationSceneRequest: {
            state: "GENERATING",
            generationScene: { generationJob: { state: "GENERATING" } },
          },
          // The gate refuses a deleted Property's attempt for good (ADR-0096);
          // offered, such attempts would fill the window ahead of others.
          videoProject: { property: { status: { not: "DELETED" } } },
        },
        // Oldest first, `id` breaking ties, as every other sweep orders.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
        include: { videoProject: { select: { organizationId: true } } },
      });
      return rows.map(
        (row): SystemGenerationCandidate => ({
          organizationId: row.videoProject.organizationId,
          generation: toGeneration(row),
        }),
      );
    },

    async endPreparationRefusal(input) {
      // Derived from the refusal, never supplied, and checked before anything
      // is read: a reason that may still pass ends nothing.
      const target = preparationRefusalEnding(input.reason);
      if (target === null || !canTransitionAttempt("QUEUED", target)) {
        throw new AppError("INTERNAL_ERROR", "Only a terminal preparation refusal ends an attempt");
      }
      return prisma.$transaction((tx) => endWithin(tx, input, target));
    },
  };
}

async function endWithin(
  tx: Tx,
  input: EndPreparationRefusalInput,
  target: "CANCELLED_PRE_SUBMISSION",
): Promise<EndPreparationRefusalOutcome> {
  const { organizationId, attemptId } = input;

  // ---- 1. The cost-admission lock, first. ---------------------------------
  // The key the gate takes for this attempt: its job's reservation's frozen
  // billing cycle, or the organization's `unreserved` key. Read before the lock,
  // which is safe because it is frozen when the hold is taken.
  const cycles = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey" AS "billingCycleKey"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
  `;
  await acquireCostAdmissionLock(tx, organizationId, cycles[0]?.billingCycleKey ?? "unreserved");

  // ---- 2. The compare-and-set. -------------------------------------------
  // On the predicate the gate's arm competes on, so exactly one of the two
  // moves a `QUEUED` attempt: a refused attempt is never sent, and a sent one is
  // never ended here. The reason is the durable code, so the state and the code
  // cannot describe different failures; the message is cleared, never left from
  // an earlier failure.
  const ended = await tx.$queryRaw<{ id: string; stateVersion: number }[]>`
    UPDATE "scene_generations" a
       SET "orchestrationState" = 'CANCELLED_PRE_SUBMISSION'::"GenerationAttemptState",
           "stateVersion" = a."stateVersion" + 1,
           "normalizedErrorCode" = ${input.reason},
           "normalizedErrorMessage" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
      FROM "video_projects" p
     WHERE a."id" = ${attemptId}
       AND p."id" = a."videoProjectId"
       AND p."organizationId" = ${organizationId}
       AND a."orchestrationState" = 'QUEUED'::"GenerationAttemptState"
       AND (a."submissionCertainty" IS NULL
            OR a."submissionCertainty" = 'PRE_SUBMISSION'::"SubmissionCertainty")
    RETURNING a."id", a."stateVersion"
  `;
  const row = ended[0];
  if (row === undefined) return { kind: "NOT_QUEUED" };

  // ---- 3. The event, in the same commit. ---------------------------------
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "ATTEMPT",
    aggregateId: attemptId,
    fromState: "QUEUED",
    toState: target,
    context: {
      ...input.context,
      eventType: ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE,
      reasonCode: input.reason,
    } satisfies TransitionContext,
  });

  return { kind: "ENDED", attemptId: row.id, stateVersion: row.stateVersion };
}
