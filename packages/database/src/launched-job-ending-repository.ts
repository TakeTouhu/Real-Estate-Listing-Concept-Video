/**
 * The ending of a deleted Property's launched job before its video is
 * assembled (GS-7d-3a, ADR-0102).
 *
 * A job launched and not yet being assembled (`GENERATING`, `SCENES_READY` or
 * `COMPOSITION_PENDING`) whose Property was deleted ends here in one
 * transaction: the job fails and its reservation is released (ADR-0052
 * Decision 19), as the product owner decided on 2026-10-29. The decision is the
 * domain's (`decideLaunchedJobEnding`); this module reads the locked rows into
 * it and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock (organization, the reservation's frozen cycle)
 *   -> GenerationReservation           FOR UPDATE
 *   -> Property                        FOR SHARE
 *   -> GenerationJob                   FOR UPDATE
 * ```
 *
 * The order of the waiting job's ending (ADR-0099) and of every release
 * (`cost-admission-lock.ts`): the paid-submission gate reads the reservation
 * under the same lock, so nothing is authorized against a Unit this has just
 * released, and Transactions H and K, which fail a generating job, are ordered
 * with this by it. The Property is held `FOR SHARE`, as the gate holds it, so a
 * deletion saving is waited for and then seen.
 *
 * The writers that move a launched job forward never hold the job while
 * waiting for a row this holds. Scene delivery (Transaction F) and the
 * composition claim (J1) lock the job first and take neither the reservation
 * nor the Property. Composition admission (Transaction I) locks the reservation
 * before the job, as this does, and no Property. Whichever locks the job first
 * commits first, and the other reads the state it left: a job claimed for
 * composition is refused here, and a job ended here is refused there.
 *
 * ## Nothing else is written
 *
 * The scenes, requests and attempts are neither locked nor written. Transaction
 * L closes a failed job's open scenes once nothing of them is at the provider
 * (ADR-0084), as it does after Transaction K, and the paid-submission gate
 * refuses an attempt of a released Unit. A delivered scene stays as it is. No
 * work row: an ended job is no longer offered, and the query mirrors every
 * refusal of the ending, so a job it would refuse is never offered.
 */

import {
  JOB_ENDED_PROPERTY_DELETED_EVENT_TYPE,
  JOB_STATES_BEFORE_ASSEMBLY,
  JobLaunchDefect,
  RESERVATION_RELEASED_EVENT_TYPE,
  decideLaunchedJobEnding,
  validateJobLaunchBatchLimit,
  type EndLaunchedJobInput,
  type EndLaunchedJobOutcome,
  type LaunchedJobEndingRepository,
  type PropertyDeletedLaunchedJob,
  type TransitionContext,
} from "@app/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent, applyLockedTransition } from "./orchestration-repositories";

type Tx = Prisma.TransactionClient;

const BEFORE_ASSEMBLY = Prisma.join([...JOB_STATES_BEFORE_ASSEMBLY]);

/** The cause every ending here records. */
const CAUSE = "PROPERTY_DELETED";

export function createLaunchedJobEndingRepository(prisma: PrismaClient): LaunchedJobEndingRepository {
  return {
    async findPropertyDeletedLaunchedJobs(query): Promise<readonly PropertyDeletedLaunchedJob[]> {
      const limit = validateJobLaunchBatchLimit(query.limit);
      // The ending's refusals, mirrored: a launched job not yet being assembled,
      // with no delivered video, a held reservation and a deleted Property.
      return prisma.$queryRaw<PropertyDeletedLaunchedJob[]>`
        SELECT vp."organizationId" AS "organizationId", j."id" AS "generationJobId"
          FROM "generation_jobs" j
          JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
          JOIN "properties" p ON p."id" = vp."propertyId" AND p."organizationId" = vp."organizationId"
          JOIN "generation_reservations" res ON res."generationJobId" = j."id"
         WHERE j."state"::text IN (${BEFORE_ASSEMBLY})
           AND j."currentDeliverableVersionId" IS NULL
           AND res."state" = 'RESERVED'
           AND p."status" = 'DELETED'
         ORDER BY j."createdAt", j."id"
         LIMIT ${limit}`;
    },

    async endPropertyDeletedLaunchedJob(input): Promise<EndLaunchedJobOutcome> {
      return prisma.$transaction((tx) => endWithin(tx, input));
    },
  };
}

async function endWithin(tx: Tx, input: EndLaunchedJobInput): Promise<EndLaunchedJobOutcome> {
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

  // The Property's own organization too, as the attempt's ending reads it (ADR-0100).
  const properties = await tx.$queryRaw<{ status: string }[]>`
    SELECT p."status"::text AS "status"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
      JOIN "properties" p ON p."id" = vp."propertyId"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}
       AND p."organizationId" = ${organizationId}
       FOR SHARE OF p`;
  const property = properties[0];

  // Tenant-scoped again, so another organization's id locks no job.
  const jobs = await tx.$queryRaw<{ state: string; currentDeliverableVersionId: string | null }[]>`
    SELECT j."state"::text AS "state", j."currentDeliverableVersionId"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}
       FOR UPDATE OF j`;
  const job = jobs[0];

  // ---- 2. The decision. ---------------------------------------------------
  // Another tenant's id, or none: no job, alike, and nothing about it is said.
  const decision = decideLaunchedJobEnding({
    jobState: job?.state ?? null,
    jobHoldsDeliverable: job !== undefined && job.currentDeliverableVersionId !== null,
    reservationState: reservation?.state ?? null,
    propertyDeleted: property?.status === "DELETED",
  });
  if (decision.kind === "KEEP") return { kind: "NOT_ENDED", reason: decision.reason };
  // The decision ends a job only under a held reservation.
  if (reservation === undefined) throw new JobLaunchDefect("ENDING_LOST_UNDER_LOCK");

  // ---- 3. The job fails and its Unit comes back. --------------------------
  const ended = (eventType: string): TransitionContext => ({ ...input.context, eventType, reasonCode: CAUSE });

  await applyLockedTransition(tx, {
    table: "generation_jobs",
    id: generationJobId,
    from: decision.from,
    to: "FAILED_TERMINAL",
  });
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "JOB",
    aggregateId: generationJobId,
    fromState: decision.from,
    toState: "FAILED_TERMINAL",
    context: ended(JOB_ENDED_PROPERTY_DELETED_EVENT_TYPE),
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

  return { kind: "ENDED", cause: CAUSE };
}
