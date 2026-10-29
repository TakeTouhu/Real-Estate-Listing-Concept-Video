/**
 * The attempt submission's persistence (GS-7c-2a, ADR-0097; GS-7d-2,
 * ADR-0100).
 *
 * Operations on orchestrated attempts, and nothing that sends one:
 *
 * - **Discovery.** The attempts waiting to be sent, oldest first, read without
 *   locks: a hint, which the paid-submission gate re-decides under its own
 *   locks (ADR-0096). Each comes with the organization its project names, so
 *   preparation can address its photo through the tenant-scoped repository,
 *   and with its job. A window starts after the caller's cursor (ADR-0098).
 * - **The ending of a refused preparation.** One `QUEUED` attempt whose
 *   preparation was refused for good is cancelled before submission, nothing
 *   having been sent, with its transition event, in one commit.
 * - **A deleted Property's attempts** (ADR-0100). Generating jobs' attempts
 *   whose Property was deleted, which discovery never offers, one of each job,
 *   read without locks; and the ending of one, cancelled before submission in
 *   the same way, with `PROPERTY_DELETED` as its code, once its Property is
 *   seen deleted under a lock.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock
 *   -> Property    FOR SHARE (a deleted Property's ending only)
 *   -> the attempt (its compare-and-set)
 * ```
 *
 * The transactions that take this lock (the gate, the submission outcome,
 * completion, reconciliation, Transactions H, K and L) take it before any row
 * lock, and nothing holding a photo or a Property lock waits for it (ADR-0096).
 * Taking it first keeps these endings out of every cycle with them. The
 * Property is held `FOR SHARE` after it, as the gate holds it, so a deletion
 * saving is waited for and then seen; a deletion is one statement and waits
 * for nothing held here. Nothing here locks a photo, a reservation or a job,
 * and nothing waits once the attempt is held. A writer that takes no such
 * lock, such as the attempt repository's own arm, is kept apart by the
 * compare-and-set below.
 */

import type { PrismaClient } from "@prisma/client";
import {
  ATTEMPT_ENDED_PROPERTY_DELETED_EVENT_TYPE,
  ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE,
  PROPERTY_DELETED_ATTEMPT_CODE,
  canTransitionAttempt,
  preparationRefusalEnding,
  validateAttemptSubmissionBatchLimit,
  validateAttemptSubmissionCursor,
  type AttemptSubmissionCandidate,
  type AttemptSubmissionRepository,
  type EndPreparationRefusalInput,
  type EndPreparationRefusalOutcome,
  type EndPropertyDeletedAttemptInput,
  type EndPropertyDeletedAttemptOutcome,
  type PropertyDeletedAttempt,
  type TransitionContext,
} from "@app/domain";
import { AppError } from "@app/shared";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { toGeneration } from "./generation-repositories";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export function createAttemptSubmissionRepository(prisma: PrismaClient): AttemptSubmissionRepository {
  return {
    async findSubmissionCandidates({ limit: requested, after: requestedAfter }) {
      // Validated here as well as by the caller: this method is public, and a
      // caller reaching it directly must not put `Infinity` into a SQL LIMIT.
      const limit = validateAttemptSubmissionBatchLimit(requested);
      const after = validateAttemptSubmissionCursor(requestedAfter);
      const rows = await prisma.sceneGeneration.findMany({
        where: {
          orchestrationState: "QUEUED",
          AND: [
            // Null read as `PRE_SUBMISSION`, as the gate reads it; the
            // all-or-none check gives every orchestrated row a certainty.
            { OR: [{ submissionCertainty: null }, { submissionCertainty: "PRE_SUBMISSION" }] },
            // After the cursor, in the order below (ADR-0098).
            after === null
              ? {}
              : {
                  OR: [
                    { createdAt: { gt: after.createdAt } },
                    { createdAt: after.createdAt, id: { gt: after.id } },
                  ],
                },
          ],
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
        include: {
          videoProject: { select: { organizationId: true } },
          generationSceneRequest: { select: { generationScene: { select: { generationJobId: true } } } },
        },
      });
      return rows.map((row): AttemptSubmissionCandidate => {
        // The filter above requires the request, so it is never absent here.
        const request = row.generationSceneRequest;
        if (request === null) throw new AppError("INTERNAL_ERROR", "An offered attempt must have a request");
        return {
          organizationId: row.videoProject.organizationId,
          generationJobId: request.generationScene.generationJobId,
          generation: toGeneration(row),
        };
      });
    },

    async endPreparationRefusal(input) {
      // Derived from the refusal, never supplied, and checked before anything
      // is read: a reason that may still pass ends nothing.
      const target = preparationRefusalEnding(input.reason);
      if (target === null || !canTransitionAttempt("QUEUED", target)) {
        throw new AppError("INTERNAL_ERROR", "Only a terminal preparation refusal ends an attempt");
      }
      return prisma.$transaction((tx) => endWithin(tx, input));
    },

    async findPropertyDeletedAttempts({ limit: requested }): Promise<readonly PropertyDeletedAttempt[]> {
      const limit = validateAttemptSubmissionBatchLimit(requested);
      // The ending's refusals mirrored, an attempt `QUEUED` before submission
      // and its Property deleted, with discovery's generating request and job.
      // The job's oldest attempt only: ending it fails the job, which
      // Transaction L closes, so a large job does not fill the window.
      return prisma.$queryRaw<PropertyDeletedAttempt[]>`
        SELECT o."organizationId", o."generationJobId", o."attemptId"
          FROM (SELECT DISTINCT ON (s."generationJobId")
                       vp."organizationId" AS "organizationId",
                       s."generationJobId" AS "generationJobId",
                       a."id" AS "attemptId",
                       a."createdAt" AS "createdAt"
                  FROM "scene_generations" a
                  JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
                  JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
                  JOIN "generation_jobs" j ON j."id" = s."generationJobId"
                  JOIN "video_projects" vp ON vp."id" = a."videoProjectId"
                  JOIN "properties" p ON p."id" = vp."propertyId"
                 WHERE a."orchestrationState" = 'QUEUED'::"GenerationAttemptState"
                   AND (a."submissionCertainty" IS NULL
                        OR a."submissionCertainty" = 'PRE_SUBMISSION'::"SubmissionCertainty")
                   AND r."state" = 'GENERATING'::"SceneGenerationRequestState"
                   AND j."state" = 'GENERATING'::"GenerationJobState"
                   AND p."status" = 'DELETED'::"PropertyStatus"
                 ORDER BY s."generationJobId", a."createdAt", a."id") o
         ORDER BY o."createdAt", o."attemptId"
         LIMIT ${limit}`;
    },

    async endPropertyDeletedAttempt(input): Promise<EndPropertyDeletedAttemptOutcome> {
      return prisma.$transaction((tx) => endPropertyDeletedWithin(tx, input));
    },
  };
}

async function endWithin(tx: Tx, input: EndPreparationRefusalInput): Promise<EndPreparationRefusalOutcome> {
  await lockCostAdmissionFor(tx, input.organizationId, input.attemptId);
  const row = await cancelBeforeSubmission(tx, input, input.reason, ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE);
  return row === null ? { kind: "NOT_QUEUED" } : { kind: "ENDED", attemptId: row.id, stateVersion: row.stateVersion };
}

async function endPropertyDeletedWithin(
  tx: Tx,
  input: EndPropertyDeletedAttemptInput,
): Promise<EndPropertyDeletedAttemptOutcome> {
  const { organizationId, attemptId } = input;
  await lockCostAdmissionFor(tx, organizationId, attemptId);

  // The attempt's Property, held as the gate holds it (ADR-0096), so the code
  // written is true at the commit. Tenant-scoped through the attempt's project.
  const properties = await tx.$queryRaw<{ status: string }[]>`
    SELECT pr."status"::text AS "status"
      FROM "scene_generations" a
      JOIN "video_projects" p ON p."id" = a."videoProjectId"
      JOIN "properties" pr ON pr."id" = p."propertyId"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
       AND pr."organizationId" = ${organizationId}
       FOR SHARE OF pr`;
  const property = properties[0];
  // Another tenant's id, or none: alike, and nothing about it is said.
  if (property === undefined) return { kind: "NOT_QUEUED" };
  if (property.status !== "DELETED") return { kind: "PROPERTY_NOT_DELETED" };

  const row = await cancelBeforeSubmission(
    tx,
    input,
    PROPERTY_DELETED_ATTEMPT_CODE,
    ATTEMPT_ENDED_PROPERTY_DELETED_EVENT_TYPE,
  );
  return row === null ? { kind: "NOT_QUEUED" } : { kind: "ENDED", attemptId: row.id, stateVersion: row.stateVersion };
}

/**
 * The cost-admission lock, first: the key the gate takes for this attempt, its
 * job's reservation's frozen billing cycle, or the organization's `unreserved`
 * key. Read before the lock, which is safe because it is frozen when the hold
 * is taken.
 */
async function lockCostAdmissionFor(tx: Tx, organizationId: string, attemptId: string): Promise<void> {
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
}

/**
 * The one write both endings make, under the cost-admission lock: the attempt
 * `QUEUED → CANCELLED_PRE_SUBMISSION` and its event, or nothing when it is not
 * `QUEUED` before submission in the organization.
 */
async function cancelBeforeSubmission(
  tx: Tx,
  input: { readonly organizationId: string; readonly attemptId: string; readonly context: TransitionContext },
  code: string,
  eventType: string,
): Promise<{ id: string; stateVersion: number } | null> {
  const { organizationId, attemptId } = input;

  // The compare-and-set. The gate's arm also requires the attempt `QUEUED`, so
  // exactly one of the two moves it: an ended attempt is never sent, and a sent
  // one is never ended here. The code is the durable one, so the state and the
  // code cannot describe different failures; the message is cleared, never left
  // from an earlier failure.
  const ended = await tx.$queryRaw<{ id: string; stateVersion: number }[]>`
    UPDATE "scene_generations" a
       SET "orchestrationState" = 'CANCELLED_PRE_SUBMISSION'::"GenerationAttemptState",
           "stateVersion" = a."stateVersion" + 1,
           "normalizedErrorCode" = ${code},
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
  if (row === undefined) return null;

  // The event, in the same commit.
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "ATTEMPT",
    aggregateId: attemptId,
    fromState: "QUEUED",
    toState: "CANCELLED_PRE_SUBMISSION",
    context: { ...input.context, eventType, reasonCode: code } satisfies TransitionContext,
  });
  return row;
}
