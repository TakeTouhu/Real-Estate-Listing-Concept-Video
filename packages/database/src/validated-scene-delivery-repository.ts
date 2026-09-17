/**
 * Transaction F — atomic validated Scene delivery.
 *
 * One repository operation owns the whole business fact: the locks, the
 * authority re-reads, the byte-identity and latest-attempt checks, the request
 * delivery, the Scene transition, the delivered pointer, the optional Job
 * advance, and every transition event. Splitting it would re-create the crash
 * boundary it exists to remove.
 *
 * ## Lock order
 *
 * ```text
 * GenerationJob → GenerationScene → SceneGenerationRequest → attempt → validation
 * ```
 *
 * Fixed, and taken in that order by every caller, so two concurrent deliveries
 * cannot deadlock by approaching the same rows from opposite ends. The **Job**
 * lock comes first and is what makes the readiness decision safe: two Scenes in
 * one Job finishing at the same instant must serialize on the Job row, so
 * exactly one transaction can observe itself as the last Scene and advance
 * `GENERATING -> SCENES_READY`. A read-then-update without that lock would let
 * both observe "one Scene still generating" and neither advance the Job, or
 * both advance it twice.
 *
 * No external I/O is reachable from inside the transaction: this file performs
 * database work only.
 */

import {
  JOB_SCENES_READY_EVENT_TYPE,
  SCENE_READY_EVENT_TYPE,
  SCENE_REQUEST_DELIVERED_EVENT_TYPE,
  VALIDATED_DELIVERY_REASON_CODE,
  ValidatedSceneDeliveryDefect,
  validateSceneDeliveryBatchLimit,
  type DeliverValidatedSceneInput,
  type ValidatedSceneDeliveryCandidate,
  type ValidatedSceneDeliveryOutcome,
  type ValidatedSceneDeliveryRepository,
} from "@app/domain";
import type { PrismaClient } from "@prisma/client";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Candidate row: identifiers only, deliberately not enough to act on. */
interface CandidateRow {
  readonly validationId: string;
  readonly sceneGenerationId: string;
  readonly generationSceneRequestId: string;
  readonly organizationId: string;
}

/**
 * Everything Transaction F needs, read once under the locks it has taken.
 *
 * One statement rather than five, so the values cannot disagree with each other
 * and so tenancy is proved in the same predicate that finds the rows.
 */
interface DeliveryContextRow {
  readonly organizationId: string;
  // --- attempt ---
  readonly attemptOrdinal: number | null;
  readonly orchestrationState: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  // --- validation ---
  readonly validationStatus: string | null;
  readonly validationValidatedAt: Date | null;
  readonly receiptSha256: string | null;
  readonly receiptSizeBytes: bigint | null;
  // --- request ---
  readonly requestId: string;
  readonly requestKind: string;
  readonly requestState: string;
  readonly requestVersion: number;
  // --- scene ---
  readonly sceneId: string;
  readonly sceneState: string;
  readonly sceneVersion: number;
  readonly sceneDeliveredRequestId: string | null;
  // --- job ---
  readonly jobId: string;
  readonly jobState: string;
  readonly jobVersion: number;
  /** The greatest attempt ordinal on this request, for latest-attempt authority. */
  readonly maxAttemptOrdinal: number | null;
}

export function createValidatedSceneDeliveryRepository(
  prisma: PrismaClient,
): ValidatedSceneDeliveryRepository {
  return {
    async findValidatedDeliveryCandidates({ limit: requested }) {
      // Validated here as well as in the runner, because this method is public:
      // a caller reaching it directly must not put `Infinity` into a SQL LIMIT.
      const limit = validateSceneDeliveryBatchLimit(requested);
      // No lock, no transaction, identifiers only. `deliverValidatedScene`
      // re-checks every condition under its own locks, so this cannot be
      // mistaken for authority. Deterministic order: oldest verdict first.
      //
      // Every condition the transaction refuses on is mirrored here, and that
      // is not redundancy — it is what keeps the bound useful. A row the
      // transaction will always refuse is still listable forever, so with
      // `ORDER BY validatedAt ASC LIMIT n` enough permanently-ineligible rows
      // sit at the head of the queue and starve work that could actually be
      // delivered. Superseded attempts and non-`GENERATING` Jobs are therefore
      // filtered out here as well, by the same durable facts the transaction
      // uses: `attemptOrdinal`, never `createdAt`.
      const rows = await prisma.$queryRaw<CandidateRow[]>`
        SELECT v."id"                       AS "validationId",
               a."id"                       AS "sceneGenerationId",
               a."generationSceneRequestId" AS "generationSceneRequestId",
               p."organizationId"           AS "organizationId"
          FROM "managed_output_media_validations" v
          JOIN "scene_generations" a  ON a."id" = v."sceneGenerationId"
          JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s  ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j    ON j."id" = s."generationJobId"
          JOIN "video_projects" p     ON p."id" = j."videoProjectId"
         WHERE v."status" = 'VALID'::"ManagedOutputMediaValidationStatus"
           AND v."validatedAt" IS NOT NULL
           AND a."orchestrationState" = 'OUTPUT_VERIFIED'::"GenerationAttemptState"
           AND a."generationSceneRequestId" IS NOT NULL
           AND r."state" = 'GENERATING'::"SceneGenerationRequestState"
           AND j."state" = 'GENERATING'::"GenerationJobState"
           AND a."attemptOrdinal" = (
                 SELECT MAX(sib."attemptOrdinal")
                   FROM "scene_generations" sib
                  WHERE sib."generationSceneRequestId" = a."generationSceneRequestId"
               )
         ORDER BY v."validatedAt" ASC, v."id" ASC
         LIMIT ${limit}
      `;
      return rows.map((row): ValidatedSceneDeliveryCandidate => ({
        validationId: row.validationId,
        sceneGenerationId: row.sceneGenerationId,
        generationSceneRequestId: row.generationSceneRequestId,
        organizationId: row.organizationId,
      }));
    },

    async deliverValidatedScene(input: DeliverValidatedSceneInput) {
      return prisma.$transaction(async (tx): Promise<ValidatedSceneDeliveryOutcome> => {
        // ---- 1. Locks, in the fixed order. ------------------------------
        // The Job lock is taken first and held for the whole transaction, so
        // two final-Scene deliveries in one Job serialize here and exactly one
        // can observe itself as the last.
        const locked = await lockChainForTenant(tx, input.organizationId, input.sceneGenerationId);
        if (!locked) return { kind: "NOT_FOUND" };

        // ---- 2. One authoritative read under those locks. ---------------
        const row = await readDeliveryContext(tx, input.organizationId, input.sceneGenerationId);
        if (row === null) return { kind: "NOT_FOUND" };

        // ---- 3. Idempotent replay, before anything is judged ineligible. -
        const replay = classifyAlreadyApplied(row);
        if (replay === "ALREADY_APPLIED") return { kind: "ALREADY_APPLIED" };
        if (replay === "PARTIAL") {
          // Request, Scene and pointer disagree about whether delivery
          // happened. Repairing would destroy the evidence of whatever wrote
          // half of it.
          throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");
        }

        // ---- 3b. A new delivery needs a Job that is still generating. ---
        // Deliberately *after* replay classification, so a genuine replay still
        // answers ALREADY_APPLIED once the Job has legitimately moved past
        // SCENES_READY.
        //
        // Without this, the last Scene of a `REVISING`, `CANCELLED` or
        // already-`SCENES_READY` Job could become READY and its request
        // DELIVERED while the Job stayed put. The delivered request then stops
        // being a candidate, so no later Transaction F call exists to perform
        // `GENERATING -> SCENES_READY`, and the Job is stranded with no way
        // back.
        if (row.jobState !== "GENERATING") return { kind: "NOT_ELIGIBLE" };

        // ---- 4. Media authority: the durable VALID verdict only. --------
        if (row.validationStatus !== "VALID" || row.validationValidatedAt === null) {
          return { kind: "NOT_ELIGIBLE" };
        }
        if (row.orchestrationState !== "OUTPUT_VERIFIED") return { kind: "NOT_ELIGIBLE" };
        if (row.requestState !== "GENERATING") return { kind: "NOT_ELIGIBLE" };

        // ---- 5. Byte identity: the verdict must be about these bytes. ---
        if (
          row.outputSha256 === null ||
          row.outputSizeBytes === null ||
          row.receiptSha256 !== row.outputSha256 ||
          row.receiptSizeBytes === null ||
          row.receiptSizeBytes !== row.outputSizeBytes
        ) {
          // Never repaired, never re-validated, never delivered anyway.
          throw new ValidatedSceneDeliveryDefect("RECEIPT_BINDING_CONFLICT");
        }

        // ---- 6. Latest-attempt authority, by durable ordinal. -----------
        // A delayed verdict from an older attempt must never deliver after the
        // request moved to a newer one. `createdAt` is not used: two attempts
        // admitted in the same millisecond have no order, and the ordinal does.
        if (
          row.attemptOrdinal === null ||
          row.maxAttemptOrdinal === null ||
          row.attemptOrdinal !== row.maxAttemptOrdinal
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }

        // ---- 7. The Scene must be where this request kind requires. -----
        const expectedSceneState: "GENERATING" | "REVISING" =
          row.requestKind === "USER_REGENERATION" ? "REVISING" : "GENERATING";
        if (row.sceneState !== expectedSceneState) {
          // `READY -> REVISING` belongs to the regeneration-start edge, not to
          // delivery, so a regeneration whose Scene never entered REVISING is a
          // defect rather than something to repair here.
          throw new ValidatedSceneDeliveryDefect("SCENE_STATE_CONFLICT");
        }

        // A regeneration *replaces* something. A `USER_REGENERATION` whose
        // Scene has no delivered request at all is not a regeneration: there is
        // nothing to regenerate, the customer spent an entitlement against a
        // predecessor that does not exist, and delivering would invent the
        // first delivery of the Scene under the wrong request kind. Fail closed
        // — the pointer is not created, the predecessor is not invented, and no
        // entitlement is consumed.
        if (row.requestKind === "USER_REGENERATION" && row.sceneDeliveredRequestId === null) {
          throw new ValidatedSceneDeliveryDefect("REGENERATION_PREDECESSOR_MISSING");
        }

        // A pointer that does exist must already name a delivered request *of
        // this Scene*. The composite foreign key makes a pointer to another
        // Scene's request impossible at the database level; this checks the
        // remaining case, a pointer to a request that never delivered.
        if (row.sceneDeliveredRequestId !== null) {
          const previous = await tx.sceneGenerationRequest.findFirst({
            where: { id: row.sceneDeliveredRequestId, generationSceneId: row.sceneId },
            select: { state: true },
          });
          if (previous === null) throw new ValidatedSceneDeliveryDefect("DELIVERY_POINTER_CONFLICT");
          if (previous.state !== "DELIVERED") {
            throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");
          }
        }

        // ---- 8. The writes. All of them, or none. -----------------------
        const deliveredAt = new Date();
        // One vocabulary for all three events. The reason code is this
        // transaction's, not the caller's: every row written here was written
        // because a durable media verdict said the bytes were valid, and a
        // caller-supplied reason would let two different causes share a code.
        const event = (eventType: string) => ({
          ...input.context,
          eventType,
          reasonCode: VALIDATED_DELIVERY_REASON_CODE,
        });

        const requestMoved = await tx.sceneGenerationRequest.updateMany({
          where: { id: row.requestId, state: "GENERATING", stateVersion: row.requestVersion },
          data: {
            state: "DELIVERED",
            stateVersion: row.requestVersion + 1,
            deliveredAt,
          },
        });
        if (requestMoved.count !== 1) return { kind: "NOT_ELIGIBLE" };

        await appendGenerationEvent(tx, {
          organizationId: row.organizationId,
          aggregateType: "SCENE_REQUEST",
          aggregateId: row.requestId,
          fromState: "GENERATING",
          toState: "DELIVERED",
          context: event(SCENE_REQUEST_DELIVERED_EVENT_TYPE),
        });

        const sceneMoved = await tx.generationScene.updateMany({
          where: {
            id: row.sceneId,
            state: expectedSceneState,
            stateVersion: row.sceneVersion,
          },
          data: {
            state: "READY",
            stateVersion: row.sceneVersion + 1,
            // The pointer switches; the previously delivered request row is
            // left exactly as it is, as history.
            currentDeliveredRequestId: row.requestId,
          },
        });
        // Not `NOT_ELIGIBLE`: the request is already delivered in this
        // transaction, and returning would *commit* that half. Under the locks
        // taken above this cannot happen; if it ever did, the only safe answer
        // is to roll the whole thing back.
        if (sceneMoved.count !== 1) {
          throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");
        }

        await appendGenerationEvent(tx, {
          organizationId: row.organizationId,
          aggregateType: "SCENE",
          aggregateId: row.sceneId,
          fromState: expectedSceneState,
          toState: "READY",
          context: event(SCENE_READY_EVENT_TYPE),
        });

        // ---- 9. Job readiness, still under the Job lock. ----------------
        // Counted after this Scene is READY, so "every Scene ready" includes
        // the one just delivered.
        const notReady = await tx.generationScene.count({
          where: { generationJobId: row.jobId, state: { not: "READY" } },
        });

        // The Job-state authority is the guard above; reaching here means the
        // Job was `GENERATING` when this transaction read it under its lock.
        // The compare-and-set still names the state, so the write itself can
        // never land on a Job that is not generating.
        let jobAdvanced = false;
        if (notReady === 0) {
          const jobMoved = await tx.generationJob.updateMany({
            where: { id: row.jobId, state: "GENERATING", stateVersion: row.jobVersion },
            data: { state: "SCENES_READY", stateVersion: row.jobVersion + 1 },
          });
          // Same reason as the Scene above: two aggregates are already written.
          if (jobMoved.count !== 1) {
            throw new ValidatedSceneDeliveryDefect("PARTIAL_DELIVERY_STATE");
          }
          await appendGenerationEvent(tx, {
            organizationId: row.organizationId,
            aggregateType: "JOB",
            aggregateId: row.jobId,
            fromState: "GENERATING",
            toState: "SCENES_READY",
            context: event(JOB_SCENES_READY_EVENT_TYPE),
          });
          jobAdvanced = true;
        }

        // Nothing beyond SCENES_READY: COMPOSITION_PENDING, composition, the
        // deliverable and quota CONSUME all belong to later transactions.
        return { kind: "DELIVERED", jobAdvanced };
      });
    },
  };
}

/**
 * Take the whole ancestry lock in one fixed order, proving tenancy as it goes.
 *
 * `FOR UPDATE OF j, s, r, a` locks the four mutable rows; the validation is read
 * under the same statement's visibility. A cross-tenant or unknown id matches no
 * row, locks nothing, and is reported as not found — the caller's organization
 * id is never trusted on its own.
 */
async function lockChainForTenant(
  tx: Tx,
  organizationId: string,
  sceneGenerationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT j."id"
      FROM "generation_jobs" j
      JOIN "generation_scenes" s ON s."generationJobId" = j."id"
      JOIN "scene_generation_requests" r ON r."generationSceneId" = s."id"
      JOIN "scene_generations" a ON a."generationSceneRequestId" = r."id"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE a."id" = ${sceneGenerationId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, s, r, a
  `;
  return rows.length > 0;
}

/** One authoritative read of every row Transaction F judges. */
async function readDeliveryContext(
  tx: Tx,
  organizationId: string,
  sceneGenerationId: string,
): Promise<DeliveryContextRow | null> {
  const rows = await tx.$queryRaw<DeliveryContextRow[]>`
    SELECT p."organizationId"            AS "organizationId",
           a."attemptOrdinal"            AS "attemptOrdinal",
           a."orchestrationState"::text  AS "orchestrationState",
           a."outputSha256"              AS "outputSha256",
           a."outputSizeBytes"           AS "outputSizeBytes",
           v."status"::text              AS "validationStatus",
           v."validatedAt"               AS "validationValidatedAt",
           v."receiptSha256"             AS "receiptSha256",
           v."receiptSizeBytes"          AS "receiptSizeBytes",
           r."id"                        AS "requestId",
           r."kind"::text                AS "requestKind",
           r."state"::text               AS "requestState",
           r."stateVersion"              AS "requestVersion",
           s."id"                        AS "sceneId",
           s."state"::text               AS "sceneState",
           s."stateVersion"              AS "sceneVersion",
           s."currentDeliveredRequestId" AS "sceneDeliveredRequestId",
           j."id"                        AS "jobId",
           j."state"::text               AS "jobState",
           j."stateVersion"              AS "jobVersion",
           (SELECT MAX(sib."attemptOrdinal")
              FROM "scene_generations" sib
             WHERE sib."generationSceneRequestId" = r."id") AS "maxAttemptOrdinal"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      LEFT JOIN "managed_output_media_validations" v ON v."sceneGenerationId" = a."id"
     WHERE a."id" = ${sceneGenerationId}
       AND p."organizationId" = ${organizationId}
     LIMIT 1
  `;
  // An attempt with no parent request cannot appear here at all: the inner join
  // on `scene_generation_requests` removes it, and the caller sees `NOT_FOUND`
  // rather than a half-populated context.
  return rows[0] ?? null;
}

/**
 * Whether this exact request has already been fully delivered.
 *
 * Only the complete shape counts as applied: the request `DELIVERED`, the Scene
 * `READY`, and the Scene's pointer naming this request. Anything in between is
 * `PARTIAL` — a state the application believes it cannot produce — and is
 * reported rather than repaired, because a half-applied delivery is evidence
 * about a defect and silently completing it would erase that evidence.
 */
function classifyAlreadyApplied(row: DeliveryContextRow): "NO" | "ALREADY_APPLIED" | "PARTIAL" {
  const requestDelivered = row.requestState === "DELIVERED";
  const pointsHere = row.sceneDeliveredRequestId === row.requestId;
  const sceneReady = row.sceneState === "READY";

  if (requestDelivered && pointsHere && sceneReady) return "ALREADY_APPLIED";
  // A delivered request whose Scene does not point at it, or a Scene pointing
  // at a request that never delivered, are both impossible after Transaction F.
  if (requestDelivered || (pointsHere && !requestDelivered)) return "PARTIAL";
  return "NO";
}
