/**
 * The failed job scene closure, Transaction L (ADR-0084).
 *
 * A failed job's open scenes can never be delivered. This closes one in one
 * transaction once nothing of it is at the provider: a scene that never started
 * is cancelled with its pending request; one that started fails, its attempt
 * still waiting to be sent is cancelled before submission, and its request
 * fails. The decision is the domain's (`decideFailedJobSceneClosure`); this
 * module reads the locked rows into it and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> GenerationJob -> GenerationScene
 *   -> SceneGenerationRequest -> SceneGeneration (attempts)
 * ```
 *
 * The advisory lock comes first because every writer that moves an attempt the
 * provider may hold takes it first (the paid-submission gate, the submission
 * outcome, completion, reconciliation), so no attempt of this scene changes
 * state while this decides. The job, scene, request and attempt follow in the
 * order Transactions F, H and K and media recovery take them. The reservation
 * is neither read nor locked: the settlement that failed the job released it,
 * and nothing here moves money.
 *
 * ## No sweep state
 *
 * There is no work row. A closed scene is no longer a candidate, and the
 * candidate query mirrors every condition the decision refuses on, so a scene
 * the closure would refuse is not offered until the fact it refused on changes.
 */

import {
  ATTEMPT_CANCELLED_PRE_SUBMISSION_EVENT_TYPE,
  FAILED_JOB_SCENE_CLOSURE_REASON_CODE,
  FailedJobSceneClosureDefect,
  GENERATION_ATTEMPT_STATES,
  GENERATION_JOB_STATES,
  GENERATION_SCENE_STATES,
  SCENE_CANCELLED_EVENT_TYPE,
  SCENE_FAILED_EVENT_TYPE,
  SCENE_GENERATION_REQUEST_KINDS,
  SCENE_GENERATION_REQUEST_STATES,
  SCENE_REQUEST_CANCELLED_EVENT_TYPE,
  SCENE_REQUEST_FAILED_EVENT_TYPE,
  TERMINAL_ATTEMPT_STATES,
  decideFailedJobSceneClosure,
  validateFailedJobSceneClosureBatchLimit,
  type CloseFailedJobSceneInput,
  type FailedJobSceneCandidate,
  type FailedJobSceneClosureOutcome,
  type FailedJobSceneClosureRepository,
  type TransitionContext,
} from "@app/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Attempt states nothing of which is at the provider: ended, or not yet sent. */
const NOT_IN_FLIGHT = Prisma.join([...TERMINAL_ATTEMPT_STATES, "QUEUED"]);

interface SceneRow {
  readonly sceneId: string;
  readonly sceneState: string;
  readonly currentDeliveredRequestId: string | null;
  readonly jobState: string;
}

interface RequestRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly deliveredAt: Date | null;
}

export function createFailedJobSceneClosureRepository(
  prisma: PrismaClient,
): FailedJobSceneClosureRepository {
  return {
    async findFailedJobSceneCandidates({ limit: requested }) {
      // Validated here as well as in the runner: this method is public.
      const limit = validateFailedJobSceneClosureBatchLimit(requested);
      // Every condition `decideFailedJobSceneClosure` refuses on is mirrored
      // here, so a scene it refuses cannot hold the head of the batch.
      const rows = await prisma.$queryRaw<FailedJobSceneCandidate[]>`
        SELECT p."organizationId" AS "organizationId",
               s."id"             AS "generationSceneId"
          FROM "generation_scenes" s
          JOIN "generation_jobs" j   ON j."id" = s."generationJobId"
          JOIN "video_projects" p    ON p."id" = j."videoProjectId"
         WHERE j."state" = 'FAILED_TERMINAL'::"GenerationJobState"
           AND s."state" IN ('PENDING'::"GenerationSceneState",
                             'GENERATING'::"GenerationSceneState")
           AND s."currentDeliveredRequestId" IS NULL
           AND (SELECT COUNT(*) FROM "scene_generation_requests" cr
                 WHERE cr."generationSceneId" = s."id") <= 1
           -- Its request, if any, is an undelivered initial one, pending or,
           -- under a started scene, generating.
           AND NOT EXISTS (
                 SELECT 1 FROM "scene_generation_requests" r
                  WHERE r."generationSceneId" = s."id"
                    AND NOT (r."kind" = 'INITIAL'::"SceneGenerationRequestKind"
                             AND r."deliveredAt" IS NULL
                             AND (r."state" = 'PENDING'::"SceneGenerationRequestState"
                                  OR (r."state" = 'GENERATING'::"SceneGenerationRequestState"
                                      AND s."state" = 'GENERATING'::"GenerationSceneState"))))
           -- No attempt under a pending request, none without a state, and none
           -- the provider may hold.
           AND NOT EXISTS (
                 SELECT 1 FROM "scene_generations" a
                   JOIN "scene_generation_requests" ar ON ar."id" = a."generationSceneRequestId"
                  WHERE ar."generationSceneId" = s."id"
                    AND (ar."state" = 'PENDING'::"SceneGenerationRequestState"
                         OR a."orchestrationState" IS NULL
                         OR a."orchestrationState"::text NOT IN (${NOT_IN_FLIGHT})))
         ORDER BY s."createdAt" ASC, s."id" ASC
         LIMIT ${limit}
      `;
      return rows.map((row) => ({
        organizationId: row.organizationId,
        generationSceneId: row.generationSceneId,
      }));
    },

    async closeFailedJobScene(input) {
      return prisma.$transaction((tx) => closeWithin(tx, input));
    },
  };
}

async function closeWithin(
  tx: Tx,
  input: CloseFailedJobSceneInput,
): Promise<FailedJobSceneClosureOutcome> {
  const { organizationId, generationSceneId: sceneId } = input;

  // ---- 1. Locks, in the declared order. -----------------------------------
  // The key the gate takes for this job's attempts: its reservation's frozen
  // billing cycle, or the organization's `unreserved` key.
  const cycles = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey" AS "billingCycleKey"
      FROM "generation_scenes" s
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE s."id" = ${sceneId}
       AND p."organizationId" = ${organizationId}
  `;
  await acquireCostAdmissionLock(tx, organizationId, cycles[0]?.billingCycleKey ?? "unreserved");

  const scenes = await tx.$queryRaw<SceneRow[]>`
    SELECT s."id"                        AS "sceneId",
           s."state"::text               AS "sceneState",
           s."currentDeliveredRequestId" AS "currentDeliveredRequestId",
           j."state"::text               AS "jobState"
      FROM "generation_scenes" s
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE s."id" = ${sceneId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, s
  `;
  const scene = scenes[0];
  if (scene === undefined) return { kind: "NOT_FOUND" };

  const requests = await tx.$queryRaw<RequestRow[]>`
    SELECT r."id", r."kind"::text AS "kind", r."state"::text AS "state", r."deliveredAt"
      FROM "scene_generation_requests" r
     WHERE r."generationSceneId" = ${sceneId}
     ORDER BY r."createdAt" ASC, r."id" ASC
       FOR UPDATE
  `;
  const attempts = await tx.$queryRaw<{ requestId: string; state: string | null }[]>`
    SELECT a."generationSceneRequestId" AS "requestId",
           a."orchestrationState"::text AS "state"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
     WHERE r."generationSceneId" = ${sceneId}
     ORDER BY a."attemptOrdinal" ASC
       FOR UPDATE OF a
  `;

  // ---- 2. The decision. ---------------------------------------------------
  const decision = decideFailedJobSceneClosure({
    jobState: member(GENERATION_JOB_STATES, scene.jobState),
    sceneState: member(GENERATION_SCENE_STATES, scene.sceneState),
    sceneNamesRendition: scene.currentDeliveredRequestId !== null,
    requests: requests.map((request) => ({
      kind: member(SCENE_GENERATION_REQUEST_KINDS, request.kind),
      state: member(SCENE_GENERATION_REQUEST_STATES, request.state),
      delivered: request.deliveredAt !== null,
      attemptStates: attempts
        .filter((a) => a.requestId === request.id)
        .map((a) => (a.state === null ? null : member(GENERATION_ATTEMPT_STATES, a.state))),
    })),
  });
  if (decision.kind === "NOT_CLOSABLE") return decision;

  // ---- 3. The closure. ----------------------------------------------------
  const record = (
    aggregateType: "ATTEMPT" | "SCENE_REQUEST" | "SCENE",
    aggregateId: string,
    fromState: string,
    toState: string,
    eventType: string,
  ) =>
    appendGenerationEvent(tx, {
      organizationId,
      aggregateType,
      aggregateId,
      fromState,
      toState,
      context: {
        ...input.context,
        eventType,
        reasonCode: FAILED_JOB_SCENE_CLOSURE_REASON_CODE,
      } satisfies TransitionContext,
    });

  const request = requests[0];
  if (request !== undefined && decision.request === "FAIL") {
    // The attempt waiting to be sent never will be: the gate refuses a
    // released Unit. Cancelled before submission, it is ended and its request
    // can fail truthfully.
    const cancelled = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "scene_generations"
         SET "orchestrationState" = 'CANCELLED_PRE_SUBMISSION'::"GenerationAttemptState",
             "stateVersion" = "stateVersion" + 1,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "generationSceneRequestId" = ${request.id}
         AND "orchestrationState" = 'QUEUED'::"GenerationAttemptState"
       RETURNING "id"
    `;
    expectRows(cancelled, decision.attemptsToCancel);
    for (const attempt of cancelled) {
      await record(
        "ATTEMPT",
        attempt.id,
        "QUEUED",
        "CANCELLED_PRE_SUBMISSION",
        ATTEMPT_CANCELLED_PRE_SUBMISSION_EVENT_TYPE,
      );
    }
    expectRows(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE "scene_generation_requests"
           SET "state" = 'FAILED_TERMINAL'::"SceneGenerationRequestState",
               "stateVersion" = "stateVersion" + 1,
               "failedAt" = ${new Date(input.closedAt)}
         WHERE "id" = ${request.id}
           AND "state" = 'GENERATING'::"SceneGenerationRequestState"
         RETURNING "id"
      `,
      1,
    );
    await record(
      "SCENE_REQUEST",
      request.id,
      "GENERATING",
      "FAILED_TERMINAL",
      SCENE_REQUEST_FAILED_EVENT_TYPE,
    );
  } else if (request !== undefined && decision.request === "CANCEL") {
    expectRows(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE "scene_generation_requests"
           SET "state" = 'CANCELLED'::"SceneGenerationRequestState",
               "stateVersion" = "stateVersion" + 1
         WHERE "id" = ${request.id}
           AND "state" = 'PENDING'::"SceneGenerationRequestState"
         RETURNING "id"
      `,
      1,
    );
    await record("SCENE_REQUEST", request.id, "PENDING", "CANCELLED", SCENE_REQUEST_CANCELLED_EVENT_TYPE);
  }

  const sceneFrom = decision.sceneTo === "CANCELLED" ? "PENDING" : "GENERATING";
  expectRows(
    await tx.$queryRaw<{ id: string }[]>`
      UPDATE "generation_scenes"
         SET "state" = ${decision.sceneTo}::"GenerationSceneState",
             "stateVersion" = "stateVersion" + 1,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${sceneId}
         AND "state" = ${sceneFrom}::"GenerationSceneState"
       RETURNING "id"
    `,
    1,
  );
  await record(
    "SCENE",
    sceneId,
    sceneFrom,
    decision.sceneTo,
    decision.sceneTo === "CANCELLED" ? SCENE_CANCELLED_EVENT_TYPE : SCENE_FAILED_EVENT_TYPE,
  );

  return { kind: "CLOSED", scene: decision.sceneTo, attemptsCancelled: decision.attemptsToCancel };
}

/** A write under locks this transaction holds matches exactly the rows it decided on. */
function expectRows(rows: readonly { id: string }[], expected: number): void {
  if (rows.length !== expected) throw new FailedJobSceneClosureDefect("CLOSURE_LOST_UNDER_LOCK");
}

// The columns are PostgreSQL enums, so a value outside the vocabulary cannot be
// read; this narrows the `::text` cast back to the domain's type without a cast.
function member<S extends string>(vocabulary: readonly S[], value: string): S {
  const found = vocabulary.find((s) => s === value);
  if (found === undefined) throw new FailedJobSceneClosureDefect("STATE_OUTSIDE_VOCABULARY");
  return found;
}
