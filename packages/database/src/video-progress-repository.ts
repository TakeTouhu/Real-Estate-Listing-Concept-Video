/**
 * A project's newest video, for its progress (GS-11a, ADR-0113). Read only.
 *
 * One statement, so the job's state, its reservation's and its scenes' are of
 * one moment: where a job's end and its Units coming back commit together, a
 * read never sees one without the other.
 *
 * The organization is the project's: a project of another organization reads
 * as one with no video, before anything of its jobs is returned.
 */

import type { PrismaClient } from "@prisma/client";
import {
  GENERATION_JOB_STATES,
  GENERATION_QUALITY_TIERS,
  GENERATION_RESERVATION_STATES,
  type VideoProgressRecord,
  type VideoProgressRepository,
} from "@app/domain";
import { AppError } from "@app/shared";

interface ProgressRow {
  readonly jobId: string;
  readonly jobState: string;
  readonly deliveredVersionId: string | null;
  readonly qualityTier: string;
  readonly durationSeconds: number;
  readonly requiredUnits: number;
  readonly reservationState: string | null;
  readonly sceneCount: number;
  readonly scenesReady: number;
}

export function createVideoProgressRepository(prisma: PrismaClient): VideoProgressRepository {
  return {
    async findLatest(organizationId, videoProjectId): Promise<VideoProgressRecord | null> {
      // Missing, either would widen the read past one project or one tenant.
      const ids: unknown[] = [organizationId, videoProjectId];
      if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new AppError("VALIDATION_FAILED", "A read of a project's video names one organization and one project");
      }
      // The newest job, as the start orders a project's jobs (ADR-0110).
      const rows = await prisma.$queryRaw<ProgressRow[]>`
        SELECT j."id"                         AS "jobId",
               j."state"::text                AS "jobState",
               j."currentDeliverableVersionId" AS "deliveredVersionId",
               j."qualityTier"::text          AS "qualityTier",
               j."requestedDurationSeconds"   AS "durationSeconds",
               j."requiredVideoUnits"         AS "requiredUnits",
               r."state"::text                AS "reservationState",
               (SELECT COUNT(*)::int
                  FROM "generation_scenes" s
                 WHERE s."generationJobId" = j."id") AS "sceneCount",
               (SELECT COUNT(*)::int
                  FROM "generation_scenes" s
                 WHERE s."generationJobId" = j."id"
                   AND s."state" = 'READY'::"GenerationSceneState") AS "scenesReady"
          FROM "generation_jobs" j
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
          LEFT JOIN "generation_reservations" r ON r."generationJobId" = j."id"
         WHERE j."videoProjectId" = ${videoProjectId}
           AND p."organizationId" = ${organizationId}
         ORDER BY j."createdAt" DESC, j."id" DESC
         LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return {
        jobId: row.jobId,
        jobState: member(GENERATION_JOB_STATES, row.jobState),
        deliveredVersionId: row.deliveredVersionId,
        qualityTier: member(GENERATION_QUALITY_TIERS, row.qualityTier),
        durationSeconds: row.durationSeconds,
        requiredUnits: row.requiredUnits,
        reservationState:
          row.reservationState === null ? null : member(GENERATION_RESERVATION_STATES, row.reservationState),
        sceneCount: row.sceneCount,
        scenesReady: row.scenesReady,
      };
    },
  };
}

// The columns are PostgreSQL enums, so a value outside the vocabulary cannot be
// read; this narrows the `::text` cast back to the domain's type without a cast.
function member<S extends string>(vocabulary: readonly S[], value: string): S {
  const found = vocabulary.find((s) => s === value);
  if (found === undefined) throw new AppError("INTERNAL_ERROR", "A video's state is outside its vocabulary");
  return found;
}
