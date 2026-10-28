/**
 * The launch commit (GS-7b, ADR-0095): a waiting job starts, under its
 * organization's concurrent-job limit, oldest first.
 *
 * In one transaction: the organization's limit is read from its subscription,
 * its jobs holding a place are counted, the job is proved its oldest waiting
 * one, its rows are locked and found exactly as the start wrote them and as its
 * plan was made from, and then the job and every scene move to `GENERATING`
 * and each scene's first attempt is admitted through attempt admission
 * (`admitAttemptWithin`), which starts its request. Any refusal writes nothing.
 * The decision is the domain's (`decideJobLaunch`); this module reads the
 * locked rows into it and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * job-launch advisory lock (organization)
 *   -> VideoProject, Property          FOR SHARE
 *   -> GenerationReservation           FOR SHARE
 *   -> GenerationJob                   FOR UPDATE
 *   -> GenerationScene                 FOR UPDATE, in position order
 *   -> SceneGenerationRequest          FOR UPDATE, in scene position order
 * ```
 *
 * The advisory lock makes the count, the oldest-first choice and the start one
 * decision per organization; only this commit takes it. The project and its
 * Property are held as the start holds them (ADR-0088), so a deletion saving
 * waits for the launch, and a launch waits for a deletion already saving and
 * then refuses it. The reservation is held before the job, the system-wide
 * order, so no release can move it while the job starts against it; the
 * launch never writes it. The job, scenes and requests follow in the order
 * Transactions F, H, K and L and media recovery take them, and admission
 * assumes the request lock this commit holds.
 *
 * No cost-admission lock is taken: nothing here is sent or settled. The
 * attempts wait `QUEUED` for the paid-submission gate, which takes it.
 *
 * ## No work row
 *
 * A launched job is no longer waiting, so it is no longer a candidate. The
 * candidate query mirrors the commit's limit, its oldest-first choice and its
 * deleted-Property refusal.
 */

import {
  ATTEMPT_ADMITTED_AT_LAUNCH_EVENT_TYPE,
  JOB_LAUNCHED_EVENT_TYPE,
  JOB_LAUNCH_REASON_CODE,
  JOB_STATES_HOLDING_A_PLACE,
  JobLaunchDefect,
  SCENE_LAUNCHED_EVENT_TYPE,
  createCustomerPlanCatalog,
  decideJobLaunch,
  decideJobLaunchCapacity,
  validateJobLaunchBatchLimit,
  type CustomerPlanKey,
  type JobLaunchCandidate,
  type JobLaunchFacts,
  type JobLaunchLockedScene,
  type JobLaunchRepository,
  type JobLaunchSceneFacts,
  type LaunchJobInput,
  type LaunchJobOutcome,
  type TransitionContext,
} from "@app/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { acquireJobLaunchLock } from "./cost-admission-lock";
import { admitAttemptWithin, appendGenerationEvent, applyLockedTransition } from "./orchestration-repositories";

type Tx = Prisma.TransactionClient;

const PLAN_KEY_FROM_ROW: Record<string, CustomerPlanKey> = {
  STANDARD: "standard",
  PREMIUM: "premium",
  ENTERPRISE: "enterprise",
};

/** Each plan's limit, by the subscription column's value, for the candidate query. */
function limitsTable(): Prisma.Sql {
  const catalog = createCustomerPlanCatalog();
  return Prisma.join(
    Object.entries(PLAN_KEY_FROM_ROW).map(([row, key]) => {
      const plan = catalog.find(key);
      if (plan === undefined) throw new JobLaunchDefect("PLAN_NOT_IN_CATALOG");
      return Prisma.sql`(${row}::text, ${plan.concurrentJobs}::int)`;
    }),
  );
}

const HOLDING_A_PLACE = Prisma.join([...JOB_STATES_HOLDING_A_PLACE]);

export function createJobLaunchRepository(prisma: PrismaClient): JobLaunchRepository {
  return {
    async findJobLaunchCandidates(query): Promise<readonly JobLaunchCandidate[]> {
      const limit = validateJobLaunchBatchLimit(query.limit);
      // Each organization's oldest waiting job whose Property is not deleted,
      // where its plan's limit leaves a place: the commit's own three checks.
      const rows = await prisma.$queryRaw<{ organizationId: string; generationJobId: string }[]>`
        SELECT w."organizationId", w."generationJobId"
          FROM (
            SELECT DISTINCT ON (vp."organizationId")
                   vp."organizationId" AS "organizationId",
                   j."id"              AS "generationJobId",
                   j."createdAt"       AS "createdAt"
              FROM "generation_jobs" j
              JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
              JOIN "properties" p ON p."id" = vp."propertyId"
             WHERE j."state" = 'RESERVED'
               AND p."status" <> 'DELETED'
             ORDER BY vp."organizationId", j."createdAt", j."id"
          ) w
          JOIN "organization_subscriptions" sub ON sub."organizationId" = w."organizationId"
          JOIN (VALUES ${limitsTable()}) AS lim("planKey", "concurrentJobs")
            ON lim."planKey" = sub."planKey"::text
         WHERE (
                 SELECT count(*)
                   FROM "generation_jobs" h
                   JOIN "video_projects" hp ON hp."id" = h."videoProjectId"
                  WHERE hp."organizationId" = w."organizationId"
                    AND h."state"::text IN (${HOLDING_A_PLACE})
               ) < lim."concurrentJobs"
         ORDER BY w."createdAt", w."generationJobId"
         LIMIT ${limit}`;

      const candidates: JobLaunchCandidate[] = [];
      for (const row of rows) {
        candidates.push({ ...row, facts: await readFacts(prisma, row.generationJobId) });
      }
      return candidates;
    },

    async launchJob(input): Promise<LaunchJobOutcome> {
      if (input.attemptIds.length !== input.plan.scenes.length) {
        throw new JobLaunchDefect("ATTEMPT_IDS_NOT_FOR_PLAN");
      }
      try {
        return await prisma.$transaction((tx) => launchWithin(tx, input));
      } catch (error) {
        // The active-request index refused a first attempt: an identical
        // request of the same project, the same video started twice, is still
        // at work. The whole launch rolled back, and the job waits for it.
        if (isActiveRequestConflict(error)) return { kind: "SAME_REQUEST_RUNNING" };
        throw error;
      }
    },
  };
}

/**
 * The active-request index (`scene_generations_active_request_key`) refusing an
 * attempt: one project may not have two identical requests at work at once, so
 * the provider is never paid twice for the same work at the same time.
 */
function isActiveRequestConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const meta = error.meta as { modelName?: unknown; target?: unknown } | undefined;
  if (meta?.modelName !== "SceneGeneration" || !Array.isArray(meta.target)) return false;
  const fields = meta.target.map(String);
  return fields.length === 2 && fields.includes("videoProjectId") && fields.includes("requestHash");
}

/** The planner's facts, read without a lock; `null` for a job not of the start's shape. */
async function readFacts(prisma: PrismaClient, generationJobId: string): Promise<JobLaunchFacts | null> {
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: {
      qualityTier: true,
      targetOutputResolution: true,
      targetAspectRatio: true,
      scenes: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          snapshotDurationSeconds: true,
          snapshotCameraMotion: true,
          snapshotCompiledPrompt: true,
          requests: { select: { id: true, kind: true } },
        },
      },
    },
  });
  if (job === null || job.scenes.length === 0) return null;
  const scenes: JobLaunchSceneFacts[] = [];
  for (const scene of job.scenes) {
    const request = scene.requests[0];
    if (scene.requests.length !== 1 || request === undefined || request.kind !== "INITIAL") return null;
    scenes.push({
      generationSceneId: scene.id,
      initialRequestId: request.id,
      durationSeconds: scene.snapshotDurationSeconds,
      cameraMotion: scene.snapshotCameraMotion,
      compiledPrompt: scene.snapshotCompiledPrompt,
    });
  }
  return {
    qualityTier: job.qualityTier,
    targetOutputResolution: job.targetOutputResolution,
    aspectRatio: job.targetAspectRatio,
    scenes,
  };
}

async function launchWithin(tx: Tx, input: LaunchJobInput): Promise<LaunchJobOutcome> {
  const { organizationId, generationJobId } = input;

  // ---- The organization's one launch decision at a time. -----------------
  await acquireJobLaunchLock(tx, organizationId);

  // ---- Its limit, from the subscription in force now. --------------------
  // Read here rather than from the period the job reserved in, so a plan
  // changed since the start is the limit the launch obeys.
  const subscription = await tx.organizationSubscription.findUnique({
    where: { organizationId },
    select: { planKey: true },
  });
  if (subscription === null) return { kind: "NO_SUBSCRIPTION" };
  const planKey = PLAN_KEY_FROM_ROW[subscription.planKey];
  const plan = planKey === undefined ? undefined : createCustomerPlanCatalog().find(planKey);
  if (plan === undefined) throw new JobLaunchDefect("PLAN_NOT_IN_CATALOG");

  // ---- A free place. Every launch of this organization waits for this lock,
  // so a place counted free here is not taken by another launch meanwhile.
  const holding = await tx.generationJob.count({
    where: { state: { in: [...JOB_STATES_HOLDING_A_PLACE] }, videoProject: { organizationId } },
  });
  const capacity = decideJobLaunchCapacity({ concurrentJobs: plan.concurrentJobs, jobsHoldingAPlace: holding });
  if (capacity.kind === "AT_LIMIT") return { kind: "AT_LIMIT" };

  // ---- Oldest first, past a deleted Property's job. ----------------------
  const next = await tx.generationJob.findFirst({
    where: { state: "RESERVED", videoProject: { organizationId, property: { status: { not: "DELETED" } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (next !== null && next.id !== generationJobId) return { kind: "NOT_NEXT" };

  // ---- The rows, locked in the declared order. ---------------------------
  const projects = await tx.$queryRaw<{ propertyStatus: string }[]>`
    SELECT p."status"::text AS "propertyStatus"
      FROM "generation_jobs" j
      JOIN "video_projects" vp ON vp."id" = j."videoProjectId"
      JOIN "properties" p ON p."id" = vp."propertyId"
     WHERE j."id" = ${generationJobId} AND vp."organizationId" = ${organizationId}
       FOR SHARE OF vp, p`;
  const project = projects[0];
  // Another tenant's id, or none: alike, and nothing about it is said.
  if (project === undefined) return { kind: "NOT_LAUNCHABLE", reason: "NOT_WAITING" };

  const reservations = await tx.$queryRaw<{ state: string }[]>`
    SELECT res."state"::text AS "state"
      FROM "generation_reservations" res
     WHERE res."generationJobId" = ${generationJobId}
       FOR SHARE OF res`;

  const jobs = await tx.$queryRaw<
    { state: string; qualityTier: string; targetOutputResolution: string; targetAspectRatio: string }[]
  >`
    SELECT j."state"::text AS "state", j."qualityTier"::text AS "qualityTier",
           j."targetOutputResolution", j."targetAspectRatio"
      FROM "generation_jobs" j
     WHERE j."id" = ${generationJobId}
       FOR UPDATE OF j`;
  const job = jobs[0];
  if (job === undefined) return { kind: "NOT_LAUNCHABLE", reason: "NOT_WAITING" };

  const scenes = await tx.$queryRaw<
    {
      id: string;
      state: string;
      durationSeconds: number;
      cameraMotion: string | null;
      compiledPrompt: string | null;
    }[]
  >`
    SELECT s."id", s."state"::text AS "state", s."snapshotDurationSeconds" AS "durationSeconds",
           s."snapshotCameraMotion" AS "cameraMotion", s."snapshotCompiledPrompt" AS "compiledPrompt"
      FROM "generation_scenes" s
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position"
       FOR UPDATE OF s`;

  const requests = await tx.$queryRaw<
    { id: string; generationSceneId: string; kind: string; state: string; attempts: number }[]
  >`
    SELECT r."id", r."generationSceneId", r."kind"::text AS "kind", r."state"::text AS "state",
           (SELECT count(*)::int FROM "scene_generations" a WHERE a."generationSceneRequestId" = r."id")
             AS "attempts"
      FROM "scene_generation_requests" r
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
     WHERE s."generationJobId" = ${generationJobId}
     ORDER BY s."position", r."id"
       FOR UPDATE OF r`;

  const lockedScenes: JobLaunchLockedScene[] = scenes.map((scene) => ({
    generationSceneId: scene.id,
    state: scene.state,
    durationSeconds: scene.durationSeconds,
    cameraMotion: scene.cameraMotion,
    compiledPrompt: scene.compiledPrompt,
    requests: requests
      .filter((request) => request.generationSceneId === scene.id)
      .map(({ id, kind, state, attempts }) => ({ id, kind, state, attempts })),
  }));

  const decision = decideJobLaunch({
    locked: {
      jobState: job.state,
      reservationState: reservations[0]?.state ?? null,
      propertyDeleted: project.propertyStatus === "DELETED",
      qualityTier: job.qualityTier,
      targetOutputResolution: job.targetOutputResolution,
      aspectRatio: job.targetAspectRatio,
      scenes: lockedScenes,
    },
    facts: input.facts,
    plan: input.plan,
  });
  if (decision.kind === "REFUSE") return { kind: "NOT_LAUNCHABLE", reason: decision.reason };

  // ---- The job and its scenes start, and each first attempt is admitted. --
  const launched = (eventType: string): TransitionContext => ({
    ...input.context,
    eventType,
    reasonCode: JOB_LAUNCH_REASON_CODE,
  });

  await applyLockedTransition(tx, {
    table: "generation_jobs",
    id: generationJobId,
    from: "RESERVED",
    to: "GENERATING",
  });
  await appendGenerationEvent(tx, {
    organizationId,
    aggregateType: "JOB",
    aggregateId: generationJobId,
    fromState: "RESERVED",
    toState: "GENERATING",
    context: launched(JOB_LAUNCHED_EVENT_TYPE),
  });

  const { route } = input.plan;
  const attemptIds: string[] = [];
  for (const [index, admission] of input.plan.scenes.entries()) {
    await applyLockedTransition(tx, {
      table: "generation_scenes",
      id: admission.generationSceneId,
      from: "PENDING",
      to: "GENERATING",
    });
    await appendGenerationEvent(tx, {
      organizationId,
      aggregateType: "SCENE",
      aggregateId: admission.generationSceneId,
      fromState: "PENDING",
      toState: "GENERATING",
      context: launched(SCENE_LAUNCHED_EVENT_TYPE),
    });

    const ids = input.attemptIds[index]!;
    const admitted = await admitAttemptWithin(
      tx,
      organizationId,
      {
        id: ids.attemptId,
        generationSceneRequestId: admission.generationSceneRequestId,
        providerName: route.providerName,
        providerModelId: route.providerModelId,
        requestModelKey: route.requestModelKey,
        requestRenderedPrompt: admission.requestRenderedPrompt,
        requestNativeGenerationResolution: route.requestNativeGenerationResolution,
        requestResolutionNormalization: route.requestResolutionNormalization,
        requestNativeMeetsTarget: route.requestNativeMeetsTarget,
        pricingSnapshotId: ids.pricingSnapshotId,
        pricingSnapshot: admission.pricingSnapshot,
        fxSnapshot: admission.fxSnapshot,
      },
      launched(ATTEMPT_ADMITTED_AT_LAUNCH_EVENT_TYPE),
    );
    // Every request was found pending with no attempt under its lock, and the
    // plan priced each one for its own scene: a refusal here is a defect, and
    // throwing it rolls back the job and every scene with it.
    if (admitted.kind !== "ADMITTED" || admitted.attempt.attemptKind !== "PRIMARY") {
      throw new JobLaunchDefect("ADMISSION_REFUSED");
    }
    attemptIds.push(admitted.attempt.id);
  }

  return { kind: "LAUNCHED", generationJobId, attemptIds };
}
