/**
 * The attempt failure settlement, Transaction K (ADR-0083).
 *
 * A scene request whose attempts have all ended, the newest without a video,
 * will never be delivered. This settles its job in one transaction: an initial
 * generation fails and its Unit is released; a scene regeneration rolls back to
 * the video the customer already holds. The decision is the domain's
 * (`decideAttemptFailureSettlement`); this module reads the locked rows into it
 * and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> GenerationReservation -> GenerationJob
 *   -> GenerationScene -> SceneGenerationRequest
 * ```
 *
 * The order Transaction H takes (`media-failure-resolution-repository.ts`), and
 * the order every entitlement release takes: the paid-submission gate reads the
 * reservation under the same advisory lock, so no attempt crosses the provider
 * boundary against a Unit this has just released. The billing-cycle key is read
 * before the lock, which is safe because it is frozen when the hold is taken.
 *
 * The attempts are read, not locked. Nothing can add one without the request
 * lock (attempt admission takes it first), and every attempt this settles on has
 * ended, so none of them can move.
 *
 * ## No sweep state
 *
 * There is no work row. A settled request is no longer a candidate, and the
 * candidate query mirrors every condition the decision refuses on, so a request
 * the settlement would refuse is never offered and cannot hold the head of the
 * batch.
 */

import {
  ATTEMPT_FAILURE_SETTLEMENT_REASON_CODE,
  AttemptFailureSettlementDefect,
  GENERATION_ATTEMPT_STATES,
  GENERATION_JOB_STATES,
  GENERATION_RESERVATION_STATES,
  GENERATION_SCENE_STATES,
  JOB_REVISION_ROLLED_BACK_EVENT_TYPE,
  JOB_SCENE_FAILED_EVENT_TYPE,
  RESERVATION_RELEASED_EVENT_TYPE,
  SCENE_FAILED_EVENT_TYPE,
  SCENE_GENERATION_REQUEST_KINDS,
  SCENE_GENERATION_REQUEST_STATES,
  SCENE_REQUEST_FAILED_EVENT_TYPE,
  SCENE_REVISION_ROLLED_BACK_EVENT_TYPE,
  TERMINAL_ATTEMPT_STATES,
  decideAttemptFailureSettlement,
  endedWithoutOutput,
  validateAttemptFailureSettlementBatchLimit,
  type AttemptFailureCandidate,
  type AttemptFailureSettlementOutcome,
  type AttemptFailureSettlementRepository,
  type SettleAttemptFailureInput,
  type TransitionContext,
} from "@app/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** The terminal attempt states, and the ones of them that produced nothing. */
const ENDED = Prisma.join([...TERMINAL_ATTEMPT_STATES]);
const ENDED_WITHOUT_OUTPUT = Prisma.join(TERMINAL_ATTEMPT_STATES.filter(endedWithoutOutput));

interface ChainRow {
  readonly requestId: string;
  readonly requestKind: string;
  readonly requestState: string;
  readonly requestDeliveredAt: Date | null;
  readonly sceneId: string;
  readonly sceneState: string;
  readonly currentDeliveredRequestId: string | null;
  readonly jobId: string;
  readonly jobState: string;
  readonly currentDeliverableVersionId: string | null;
}

export function createAttemptFailureSettlementRepository(
  prisma: PrismaClient,
): AttemptFailureSettlementRepository {
  return {
    async findAttemptFailureCandidates({ limit: requested }) {
      // Validated here as well as in the runner: this method is public, and a
      // caller reaching it directly must not put `Infinity` into a SQL LIMIT.
      const limit = validateAttemptFailureSettlementBatchLimit(requested);
      // Every condition `decideAttemptFailureSettlement` refuses on is mirrored
      // here. A request the settlement always refuses would otherwise be listed
      // forever, and enough of them at the head of `ORDER BY ... LIMIT` would
      // starve every request that can be settled.
      const rows = await prisma.$queryRaw<AttemptFailureCandidate[]>`
        SELECT p."organizationId"  AS "organizationId",
               r."id"              AS "generationSceneRequestId"
          FROM "scene_generation_requests" r
          JOIN "generation_scenes" s      ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j        ON j."id" = s."generationJobId"
          JOIN "video_projects" p         ON p."id" = j."videoProjectId"
          JOIN "generation_reservations" res ON res."generationJobId" = j."id"
         WHERE r."state" = 'GENERATING'::"SceneGenerationRequestState"
           AND r."deliveredAt" IS NULL
           AND j."state" = 'GENERATING'::"GenerationJobState"
           AND NOT EXISTS (
                 SELECT 1 FROM "scene_generations" unended
                  WHERE unended."generationSceneRequestId" = r."id"
                    AND (unended."orchestrationState" IS NULL
                         OR unended."orchestrationState"::text NOT IN (${ENDED})))
           AND (SELECT newest."orchestrationState"::text
                  FROM "scene_generations" newest
                 WHERE newest."generationSceneRequestId" = r."id"
                 ORDER BY newest."attemptOrdinal" DESC
                 LIMIT 1) IN (${ENDED_WITHOUT_OUTPUT})
           AND (
                 (r."kind" = 'INITIAL'::"SceneGenerationRequestKind"
                  AND s."state" = 'GENERATING'::"GenerationSceneState"
                  AND s."currentDeliveredRequestId" IS NULL
                  AND j."currentDeliverableVersionId" IS NULL
                  AND res."state" IN ('RESERVED'::"GenerationReservationState",
                                      'RECONCILIATION_HOLD'::"GenerationReservationState",
                                      'RELEASED'::"GenerationReservationState"))
              OR (r."kind" = 'USER_REGENERATION'::"SceneGenerationRequestKind"
                  AND s."state" = 'REVISING'::"GenerationSceneState"
                  AND j."currentDeliverableVersionId" IS NOT NULL
                  AND res."state" = 'CONSUMED'::"GenerationReservationState"
                  AND EXISTS (
                        SELECT 1 FROM "scene_generation_requests" pr
                         WHERE pr."id" = s."currentDeliveredRequestId"
                           AND pr."generationSceneId" = s."id"
                           AND pr."id" <> r."id"
                           AND pr."state" = 'DELIVERED'::"SceneGenerationRequestState")
                  AND NOT EXISTS (
                        SELECT 1 FROM "generation_scenes" sib
                         WHERE sib."generationJobId" = j."id"
                           AND sib."id" <> s."id"
                           AND sib."state" <> 'READY'::"GenerationSceneState")
                  AND NOT EXISTS (
                        SELECT 1 FROM "scene_generation_requests" orr
                          JOIN "generation_scenes" os ON os."id" = orr."generationSceneId"
                         WHERE os."generationJobId" = j."id"
                           AND orr."id" <> r."id"
                           AND orr."kind" = 'USER_REGENERATION'::"SceneGenerationRequestKind"
                           AND orr."state" IN ('PENDING'::"SceneGenerationRequestState",
                                               'GENERATING'::"SceneGenerationRequestState")))
               )
         ORDER BY r."createdAt" ASC, r."id" ASC
         LIMIT ${limit}
      `;
      return rows.map((row) => ({
        organizationId: row.organizationId,
        generationSceneRequestId: row.generationSceneRequestId,
      }));
    },

    async settleAttemptFailure(input) {
      return prisma.$transaction((tx) => settleWithin(tx, input));
    },
  };
}

async function settleWithin(
  tx: Tx,
  input: SettleAttemptFailureInput,
): Promise<AttemptFailureSettlementOutcome> {
  const { organizationId, generationSceneRequestId: requestId } = input;

  // ---- 1. Locks, in the declared order. -----------------------------------
  const cycles = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey" AS "billingCycleKey"
      FROM "scene_generation_requests" r
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE r."id" = ${requestId}
       AND p."organizationId" = ${organizationId}
  `;
  await acquireCostAdmissionLock(tx, organizationId, cycles[0]?.billingCycleKey ?? "unreserved");

  const reservations = await tx.$queryRaw<{ id: string; state: string }[]>`
    SELECT res."id", res."state"::text AS "state"
      FROM "scene_generation_requests" r
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE r."id" = ${requestId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res
  `;
  const reservation = reservations[0] ?? null;

  const chains = await tx.$queryRaw<ChainRow[]>`
    SELECT r."id"                          AS "requestId",
           r."kind"::text                  AS "requestKind",
           r."state"::text                 AS "requestState",
           r."deliveredAt"                 AS "requestDeliveredAt",
           s."id"                          AS "sceneId",
           s."state"::text                 AS "sceneState",
           s."currentDeliveredRequestId"   AS "currentDeliveredRequestId",
           j."id"                          AS "jobId",
           j."state"::text                 AS "jobState",
           j."currentDeliverableVersionId" AS "currentDeliverableVersionId"
      FROM "scene_generation_requests" r
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE r."id" = ${requestId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, s, r
  `;
  const chain = chains[0];
  if (chain === undefined) return { kind: "NOT_FOUND" };

  // ---- 2. The rest of the facts, under those locks. -----------------------
  const attempts = await tx.$queryRaw<{ state: string | null }[]>`
    SELECT a."orchestrationState"::text AS "state"
      FROM "scene_generations" a
     WHERE a."generationSceneRequestId" = ${requestId}
     ORDER BY a."attemptOrdinal" ASC
  `;
  const [counts] = await tx.$queryRaw<
    { predecessorDelivered: boolean; otherScenesNotReady: number; otherOpenRegenerations: number }[]
  >`
    SELECT EXISTS (
             SELECT 1 FROM "scene_generation_requests" pr
              WHERE pr."id" = ${chain.currentDeliveredRequestId}
                AND pr."generationSceneId" = ${chain.sceneId}
                AND pr."id" <> ${requestId}
                AND pr."state" = 'DELIVERED'::"SceneGenerationRequestState"
           ) AS "predecessorDelivered",
           (SELECT COUNT(*)::int FROM "generation_scenes" sib
             WHERE sib."generationJobId" = ${chain.jobId}
               AND sib."id" <> ${chain.sceneId}
               AND sib."state" <> 'READY'::"GenerationSceneState") AS "otherScenesNotReady",
           (SELECT COUNT(*)::int FROM "scene_generation_requests" orr
              JOIN "generation_scenes" os ON os."id" = orr."generationSceneId"
             WHERE os."generationJobId" = ${chain.jobId}
               AND orr."id" <> ${requestId}
               AND orr."kind" = 'USER_REGENERATION'::"SceneGenerationRequestKind"
               AND orr."state" IN ('PENDING'::"SceneGenerationRequestState",
                                   'GENERATING'::"SceneGenerationRequestState")
           ) AS "otherOpenRegenerations"
  `;

  const decision = decideAttemptFailureSettlement({
    requestKind: member(SCENE_GENERATION_REQUEST_KINDS, chain.requestKind),
    requestState: member(SCENE_GENERATION_REQUEST_STATES, chain.requestState),
    requestDelivered: chain.requestDeliveredAt !== null,
    attemptStates: attempts.map((a) =>
      a.state === null ? null : member(GENERATION_ATTEMPT_STATES, a.state),
    ),
    sceneState: member(GENERATION_SCENE_STATES, chain.sceneState),
    sceneDelivered:
      chain.currentDeliveredRequestId === null
        ? "NONE"
        : counts?.predecessorDelivered === true
          ? "DELIVERED_PREDECESSOR"
          : "OTHER",
    jobState: member(GENERATION_JOB_STATES, chain.jobState),
    jobHoldsDeliverable: chain.currentDeliverableVersionId !== null,
    reservationState:
      reservation === null ? null : member(GENERATION_RESERVATION_STATES, reservation.state),
    otherScenesNotReady: counts?.otherScenesNotReady ?? 0,
    otherOpenRegenerations: counts?.otherOpenRegenerations ?? 0,
  });
  if (decision.kind === "NOT_SETTLEABLE") return decision;

  // ---- 3. The settlement. -------------------------------------------------
  const at = new Date(input.settledAt);
  const event = (eventType: string): TransitionContext => ({
    ...input.context,
    eventType,
    reasonCode: ATTEMPT_FAILURE_SETTLEMENT_REASON_CODE,
  });
  const record = (
    aggregateType: "SCENE_REQUEST" | "SCENE" | "JOB" | "RESERVATION",
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
      context: event(eventType),
    });

  // The request fails either way, and its failure spends no regeneration right:
  // a right is spent on delivery, and this request delivered nothing.
  expectOne(
    await tx.$queryRaw<{ id: string }[]>`
      UPDATE "scene_generation_requests"
         SET "state" = 'FAILED_TERMINAL'::"SceneGenerationRequestState",
             "stateVersion" = "stateVersion" + 1,
             "failedAt" = ${at}
       WHERE "id" = ${requestId}
         AND "state" = 'GENERATING'::"SceneGenerationRequestState"
       RETURNING "id"
    `,
  );
  await record(
    "SCENE_REQUEST",
    requestId,
    "GENERATING",
    "FAILED_TERMINAL",
    SCENE_REQUEST_FAILED_EVENT_TYPE,
  );

  if (decision.kind === "ROLL_BACK_REGENERATION") {
    // The scene returns to READY and the job to DELIVERABLE_READY with both
    // delivered pointers untouched: they name the customer's video. The
    // reservation is not written at all: it was consumed by that video.
    await moveScene(tx, chain.sceneId, "REVISING", "READY");
    await record("SCENE", chain.sceneId, "REVISING", "READY", SCENE_REVISION_ROLLED_BACK_EVENT_TYPE);
    await moveJob(tx, chain.jobId, "DELIVERABLE_READY");
    await record(
      "JOB",
      chain.jobId,
      "GENERATING",
      "DELIVERABLE_READY",
      JOB_REVISION_ROLLED_BACK_EVENT_TYPE,
    );
    return { kind: "SETTLED", settlement: "REGENERATION_ROLLED_BACK", unitReleased: false };
  }

  await moveScene(tx, chain.sceneId, "GENERATING", "FAILED_TERMINAL");
  await record("SCENE", chain.sceneId, "GENERATING", "FAILED_TERMINAL", SCENE_FAILED_EVENT_TYPE);
  await moveJob(tx, chain.jobId, "FAILED_TERMINAL");
  await record("JOB", chain.jobId, "GENERATING", "FAILED_TERMINAL", JOB_SCENE_FAILED_EVENT_TYPE);

  // Reconciliation already released a Unit whose submission it gave up on
  // (ADR-0037 Decision 6); then only the job was left to settle.
  if (decision.releaseFrom === null || reservation === null) {
    return { kind: "SETTLED", settlement: "INITIAL_FAILED", unitReleased: false };
  }
  // The customer's Unit comes back (ADR-0052 Decision 19).
  expectOne(
    await tx.$queryRaw<{ id: string }[]>`
      UPDATE "generation_reservations"
         SET "state" = 'RELEASED'::"GenerationReservationState",
             "stateVersion" = "stateVersion" + 1,
             "releasedAt" = ${at},
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${reservation.id}
         AND "state" = ${decision.releaseFrom}::"GenerationReservationState"
       RETURNING "id"
    `,
  );
  await record(
    "RESERVATION",
    reservation.id,
    decision.releaseFrom,
    "RELEASED",
    RESERVATION_RELEASED_EVENT_TYPE,
  );
  return { kind: "SETTLED", settlement: "INITIAL_FAILED", unitReleased: true };
}

async function moveScene(tx: Tx, sceneId: string, from: string, to: string): Promise<void> {
  expectOne(
    await tx.$queryRaw<{ id: string }[]>`
      UPDATE "generation_scenes"
         SET "state" = ${to}::"GenerationSceneState",
             "stateVersion" = "stateVersion" + 1,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${sceneId}
         AND "state" = ${from}::"GenerationSceneState"
       RETURNING "id"
    `,
  );
}

async function moveJob(tx: Tx, jobId: string, to: string): Promise<void> {
  expectOne(
    await tx.$queryRaw<{ id: string }[]>`
      UPDATE "generation_jobs"
         SET "state" = ${to}::"GenerationJobState",
             "stateVersion" = "stateVersion" + 1,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = ${jobId}
         AND "state" = 'GENERATING'::"GenerationJobState"
       RETURNING "id"
    `,
  );
}

/** Zero rows under a lock this transaction holds is a defect, not a race. */
function expectOne(rows: readonly { id: string }[]): void {
  if (rows.length !== 1) throw new AttemptFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
}

// The columns are PostgreSQL enums, so a value outside the vocabulary cannot be
// read; this narrows the `::text` cast back to the domain's type without a cast.
function member<S extends string>(vocabulary: readonly S[], value: string): S {
  const found = vocabulary.find((s) => s === value);
  if (found === undefined) throw new AttemptFailureSettlementDefect("STATE_OUTSIDE_VOCABULARY");
  return found;
}
