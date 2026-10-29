/**
 * The ending of a waiting job that can never launch (GS-7d-1, ADR-0099).
 *
 * A started job waits `RESERVED` with its Units held until its organization
 * has a place (ADR-0095). One whose own rows make it impossible, a deleted
 * Property, a frozen fact the planner refuses or rows not as the start wrote
 * them, ends here in one transaction: the job fails and its reservation is
 * released (ADR-0052 Decision 19). The decision is the domain's
 * (`decideUnlaunchableJobEnding`); this module reads the locked rows into it
 * and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock (organization, the reservation's frozen cycle)
 *   -> GenerationReservation           FOR UPDATE
 *   -> Property                        FOR SHARE
 *   -> GenerationJob                   FOR UPDATE
 *   -> GenerationScene                 FOR SHARE, in position order
 *   -> SceneGenerationRequest          FOR UPDATE, in scene position order
 *   -> their attempts, counted         in a statement of their own
 * ```
 *
 * The cost-admission lock first and the reservation next, as every release
 * takes them (`cost-admission-lock.ts`): the paid-submission gate reads the
 * reservation under the same lock, so nothing is authorized against a Unit
 * this has just released. The Property is held `FOR SHARE` after the
 * reservation, as the gate holds it, so a deletion saving is waited for and
 * then seen. The launch holds the Property and the reservation `FOR SHARE`
 * before the job and takes no cost-admission lock; an ending holding the
 * reservation makes the launch wait at it, and whichever commits first leaves
 * the job the other refuses. The scenes and requests are locked and never
 * written: Transaction L cancels them once the job has failed (ADR-0084), as it
 * closes every failed job's open scenes. The requests are held `FOR UPDATE`,
 * which a new attempt's foreign-key check waits for, so no attempt is admitted
 * under them until this commits; their attempts are counted after that lock, in
 * a statement of their own, so one committed while this waited is seen.
 *
 * ## No work row
 *
 * An ended job is no longer waiting. The deleted-Property query mirrors every
 * refusal of the ending, so a job it would refuse is never offered.
 */

import {
  JOB_ENDED_UNLAUNCHABLE_EVENT_TYPE,
  JobLaunchDefect,
  RESERVATION_RELEASED_EVENT_TYPE,
  decideUnlaunchableJobEnding,
  validateJobLaunchBatchLimit,
  type EndUnlaunchableJobInput,
  type EndUnlaunchableJobOutcome,
  type JobLaunchLockedScene,
  type PropertyDeletedWaitingJob,
  type TransitionContext,
  type UnlaunchableJobEndingRepository,
} from "@app/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent, applyLockedTransition } from "./orchestration-repositories";

type Tx = Prisma.TransactionClient;

export function createUnlaunchableJobEndingRepository(prisma: PrismaClient): UnlaunchableJobEndingRepository {
  return {
    async findPropertyDeletedWaitingJobs(query): Promise<readonly PropertyDeletedWaitingJob[]> {
      const limit = validateJobLaunchBatchLimit(query.limit);
      // The ending's refusals, mirrored: a waiting job, a held reservation and
      // no attempt under any of its requests.
      return prisma.$queryRaw<PropertyDeletedWaitingJob[]>`
        SELECT vp."organizationId" AS "organizationId", j."id" AS "generationJobId"
          FROM "generation_jobs" j
          JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
          JOIN "properties" p ON p."id" = vp."propertyId"
          JOIN "generation_reservations" res ON res."generationJobId" = j."id"
         WHERE j."state" = 'RESERVED'
           AND p."status" = 'DELETED'
           AND res."state" = 'RESERVED'
           AND NOT EXISTS (
                 SELECT 1
                   FROM "scene_generations" a
                   JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
                   JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
                  WHERE s."generationJobId" = j."id")
         ORDER BY j."createdAt", j."id"
         LIMIT ${limit}`;
    },

    async endUnlaunchableJob(input): Promise<EndUnlaunchableJobOutcome> {
      return prisma.$transaction((tx) => endWithin(tx, input));
    },
  };
}

async function endWithin(tx: Tx, input: EndUnlaunchableJobInput): Promise<EndUnlaunchableJobOutcome> {
  const { organizationId, generationJobId } = input;

  // ---- 1. Locks, in the declared order. -----------------------------------
  // The key the gate takes for this job's attempts: its reservation's frozen
  // billing cycle, or the organization's `unreserved` key.
  const cycles = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey" AS "billingCycleKey"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}`;
  await acquireCostAdmissionLock(tx, organizationId, cycles[0]?.billingCycleKey ?? "unreserved");

  const reservations = await tx.$queryRaw<{ id: string; state: string }[]>`
    SELECT res."id", res."state"::text AS "state"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}
       FOR UPDATE OF res`;
  const reservation = reservations[0];

  const properties = await tx.$queryRaw<{ status: string }[]>`
    SELECT p."status"::text AS "status"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
      JOIN "properties" p ON p."id" = vp."propertyId"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}
       FOR SHARE OF p`;
  const property = properties[0];
  // Another tenant's id, or none: alike, and nothing about it is said.
  if (property === undefined) return { kind: "NOT_ENDED", reason: "NOT_WAITING" };

  const jobs = await tx.$queryRaw<
    { state: string; qualityTier: string; targetOutputResolution: string; targetAspectRatio: string }[]
  >`
    SELECT j."state"::text AS "state", j."qualityTier"::text AS "qualityTier",
           j."targetOutputResolution", j."targetAspectRatio"
      FROM "generation_jobs" j
     WHERE j."id" = ${generationJobId}
       FOR UPDATE OF j`;
  const job = jobs[0];
  if (job === undefined) return { kind: "NOT_ENDED", reason: "NOT_WAITING" };

  const scenes = await tx.$queryRaw<
    { id: string; state: string; durationSeconds: number; cameraMotion: string | null; compiledPrompt: string | null }[]
  >`
    SELECT s."id", s."state"::text AS "state", s."snapshotDurationSeconds" AS "durationSeconds",
           s."snapshotCameraMotion" AS "cameraMotion", s."snapshotCompiledPrompt" AS "compiledPrompt"
      FROM "generation_scenes" s
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position"
       FOR SHARE OF s`;

  const requests = await tx.$queryRaw<{ id: string; generationSceneId: string; kind: string; state: string }[]>`
    SELECT r."id", r."generationSceneId", r."kind"::text AS "kind", r."state"::text AS "state"
      FROM "scene_generation_requests" r
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position", r."id"
       FOR UPDATE OF r`;

  // Not a subquery of the statement above: a statement reads what was
  // committed when it began, even for a row it waited for, so an attempt
  // committed while that one waited on a request's lock would count as none.
  const counts = await tx.$queryRaw<{ requestId: string; attempts: number }[]>`
    SELECT a."generationSceneRequestId" AS "requestId", count(*)::int AS "attempts"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
     WHERE s."generationJobId" = ${generationJobId}
     GROUP BY a."generationSceneRequestId"`;
  const attemptsOf = new Map(counts.map((row) => [row.requestId, row.attempts]));

  // ---- 2. The decision. ---------------------------------------------------
  const lockedScenes: JobLaunchLockedScene[] = scenes.map((scene) => ({
    generationSceneId: scene.id,
    state: scene.state,
    durationSeconds: scene.durationSeconds,
    cameraMotion: scene.cameraMotion,
    compiledPrompt: scene.compiledPrompt,
    requests: requests
      .filter((request) => request.generationSceneId === scene.id)
      .map(({ id, kind, state }) => ({ id, kind, state, attempts: attemptsOf.get(id) ?? 0 })),
  }));
  const decision = decideUnlaunchableJobEnding({
    jobState: job.state,
    reservationState: reservation?.state ?? null,
    propertyDeleted: property.status === "DELETED",
    qualityTier: job.qualityTier,
    targetOutputResolution: job.targetOutputResolution,
    aspectRatio: job.targetAspectRatio,
    scenes: lockedScenes,
  });
  if (decision.kind === "KEEP") return { kind: "NOT_ENDED", reason: decision.reason };
  // The decision ends a job only under a held reservation.
  if (reservation === undefined) throw new JobLaunchDefect("ENDING_LOST_UNDER_LOCK");

  // ---- 3. The job fails and its Units come back. -------------------------
  const ended = (eventType: string): TransitionContext => ({
    ...input.context,
    eventType,
    reasonCode: decision.cause,
  });

  await applyLockedTransition(tx, {
    table: "generation_jobs",
    id: generationJobId,
    from: "RESERVED",
    to: "FAILED_TERMINAL",
  });
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "JOB",
    aggregateId: generationJobId,
    fromState: "RESERVED",
    toState: "FAILED_TERMINAL",
    context: ended(JOB_ENDED_UNLAUNCHABLE_EVENT_TYPE),
  });

  const released = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "generation_reservations"
       SET "state" = 'RELEASED'::"GenerationReservationState",
           "stateVersion" = "stateVersion" + 1,
           "releasedAt" = ${new Date(input.endedAt)},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${reservation.id}
       AND "state" = 'RESERVED'::"GenerationReservationState"
     RETURNING "id"`;
  if (released.length !== 1) throw new JobLaunchDefect("ENDING_LOST_UNDER_LOCK");
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "RESERVATION",
    aggregateId: reservation.id,
    fromState: "RESERVED",
    toState: "RELEASED",
    context: ended(RESERVATION_RELEASED_EVENT_TYPE),
  });

  return { kind: "ENDED", cause: decision.cause };
}
