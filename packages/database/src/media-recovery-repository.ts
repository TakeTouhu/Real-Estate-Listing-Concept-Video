/**
 * Bounded automatic media-failure recovery admission.
 *
 * Two operations, and the split matters. `findAutomaticMediaRecoveryCandidates`
 * is a bounded hint that carries only the facts *planning* needs;
 * `admitAutomaticMediaRecovery` re-checks every authority under its own locks
 * and creates the attempt through the same admission code path the generic API
 * uses.
 *
 * ## Planning already finished
 *
 * This file performs database work only. It never resolves a pricing contract,
 * never fetches an exchange rate, never consults the model catalog and never
 * calls a provider — all of that happened in the planner, outside any
 * transaction, and arrives here as a finished `PricingSnapshot` and
 * `FxSnapshot`. There is deliberately no method that takes a callback, so no
 * future external I/O can be smuggled inside an open transaction.
 *
 * ## Lock order
 *
 * ```text
 * GenerationJob → GenerationScene → SceneGenerationRequest → source attempt → validation
 * ```
 *
 * The same high-level ordering Transaction F uses, so the two can never form a
 * deadlock cycle. The **request** lock is what makes the sibling count and the
 * recovery cap safe: two workers holding the same terminal failure must
 * serialize before either reads "how many recoveries exist".
 */

import {
  AutomaticMediaRecoveryDefect,
  isMediaFailureKind,
  isResolutionNormalization,
  mediaRecoveryReasonCode,
  MEDIA_RECOVERY_ADMITTED_EVENT_TYPE,
  automaticMediaRecoveryAllowed,
  validateMediaRecoveryBatchLimit,
  type AdmitAutomaticMediaRecoveryInput,
  type AutomaticMediaRecoveryCandidate,
  type AutomaticMediaRecoveryOutcome,
  type AutomaticMediaRecoveryRepository,
  type MediaFailureKind,
} from "@app/domain";
import type { PrismaClient } from "@prisma/client";
import { admitAttemptWithin } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** One candidate row, exactly the shape planning consumes. */
interface CandidateRow {
  readonly organizationId: string;
  readonly sourceValidationId: string;
  readonly sourceAttemptId: string;
  readonly generationSceneRequestId: string;
  readonly mediaFailureKind: string;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string;
  readonly requestNativeGenerationResolution: string;
  readonly requestResolutionNormalization: string;
  readonly requestNativeMeetsTarget: boolean;
  readonly targetOutputResolution: string;
  readonly sceneDurationSeconds: number;
  readonly jobQualityTier: string;
  readonly persistedPricingIdentity: unknown;
  readonly persistedPricingContractFingerprint: string;
}

/** Everything the admission authority judges, read once under its locks. */
interface RecoveryContextRow {
  readonly organizationId: string;
  // --- source attempt ---
  readonly sourceAttemptId: string;
  readonly attemptOrdinal: number | null;
  readonly attemptKind: string | null;
  readonly orchestrationState: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string | null;
  readonly requestRenderedPrompt: string | null;
  readonly requestNativeGenerationResolution: string | null;
  readonly requestResolutionNormalization: string | null;
  readonly requestNativeMeetsTarget: boolean | null;
  // --- validation ---
  readonly validationId: string | null;
  readonly validationAttemptId: string | null;
  readonly validationStatus: string | null;
  readonly validationValidatedAt: Date | null;
  readonly receiptSha256: string | null;
  readonly receiptSizeBytes: bigint | null;
  // --- request ---
  readonly requestId: string;
  readonly requestKind: string;
  readonly requestState: string;
  // --- scene ---
  readonly sceneId: string;
  readonly sceneState: string;
  readonly sceneDeliveredRequestId: string | null;
  // --- job ---
  readonly jobState: string;
  /** The greatest attempt ordinal on this request, for latest-attempt authority. */
  readonly maxAttemptOrdinal: number | null;
  /** Every SYSTEM_RECOVERY attempt under this request — the cost circuit breaker. */
  readonly systemRecoveryCount: number;
}

export function createAutomaticMediaRecoveryRepository(
  prisma: PrismaClient,
): AutomaticMediaRecoveryRepository {
  return {
    async findAutomaticMediaRecoveryCandidates({ limit: requested }) {
      const limit = validateMediaRecoveryBatchLimit(requested);
      // Every condition that can never become true again is filtered here as
      // well as re-checked in the transaction. A permanently ineligible row in
      // an `ORDER BY validatedAt ASC LIMIT n` sweep occupies the bound forever
      // and starves work that could actually be recovered — most importantly a
      // request whose one automatic recovery has already been spent.
      const rows = await prisma.$queryRaw<CandidateRow[]>`
        SELECT p."organizationId"                     AS "organizationId",
               v."id"                                 AS "sourceValidationId",
               a."id"                                 AS "sourceAttemptId",
               a."generationSceneRequestId"           AS "generationSceneRequestId",
               v."status"::text                       AS "mediaFailureKind",
               a."providerName"                       AS "providerName",
               a."providerModelId"                    AS "providerModelId",
               a."requestModelKey"                    AS "requestModelKey",
               a."requestNativeGenerationResolution"  AS "requestNativeGenerationResolution",
               a."requestResolutionNormalization"     AS "requestResolutionNormalization",
               a."requestNativeMeetsTarget"           AS "requestNativeMeetsTarget",
               j."targetOutputResolution"             AS "targetOutputResolution",
               s."snapshotDurationSeconds"            AS "sceneDurationSeconds",
               j."qualityTier"::text                  AS "jobQualityTier",
               ps."identityJson"                      AS "persistedPricingIdentity",
               ps."contractFingerprint"               AS "persistedPricingContractFingerprint"
          FROM "managed_output_media_validations" v
          JOIN "scene_generations" a          ON a."id" = v."sceneGenerationId"
          JOIN "generation_pricing_snapshots" ps ON ps."sceneGenerationId" = a."id"
          JOIN "scene_generation_requests" r   ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s           ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j             ON j."id" = s."generationJobId"
          JOIN "video_projects" p              ON p."id" = j."videoProjectId"
         WHERE v."status" IN (
                 'INVALID_MEDIA'::"ManagedOutputMediaValidationStatus",
                 'INTEGRITY_MISMATCH'::"ManagedOutputMediaValidationStatus"
               )
           AND v."validatedAt" IS NOT NULL
           AND a."orchestrationState" = 'OUTPUT_VERIFIED'::"GenerationAttemptState"
           AND a."generationSceneRequestId" IS NOT NULL
           -- V2-complete: a recovery reproduces a route, and a row missing any
           -- part of that route cannot be reproduced at all.
           AND a."attemptKind" IS NOT NULL
           AND a."submissionCertainty" IS NOT NULL
           AND a."requestModelKey" IS NOT NULL
           AND a."requestRenderedPrompt" IS NOT NULL
           AND a."requestNativeGenerationResolution" IS NOT NULL
           AND a."requestResolutionNormalization" IS NOT NULL
           AND a."requestNativeMeetsTarget" IS NOT NULL
           AND a."attemptOrdinal" = (
                 SELECT MAX(sib."attemptOrdinal")
                   FROM "scene_generations" sib
                  WHERE sib."generationSceneRequestId" = a."generationSceneRequestId"
               )
           AND r."state" = 'GENERATING'::"SceneGenerationRequestState"
           AND j."state" = 'GENERATING'::"GenerationJobState"
           AND (
                 (
                   r."kind" = 'INITIAL'::"SceneGenerationRequestKind"
                   AND s."state" = 'GENERATING'::"GenerationSceneState"
                 )
                 OR (
                   r."kind" = 'USER_REGENERATION'::"SceneGenerationRequestKind"
                   AND s."state" = 'REVISING'::"GenerationSceneState"
                   AND s."currentDeliveredRequestId" IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                       FROM "scene_generation_requests" pr
                      WHERE pr."id" = s."currentDeliveredRequestId"
                        AND pr."generationSceneId" = s."id"
                        AND pr."state" = 'DELIVERED'::"SceneGenerationRequestState"
                   )
                 )
               )
           -- The cost circuit breaker, in the sweep as well as the transaction.
           AND NOT EXISTS (
                 SELECT 1
                   FROM "scene_generations" sr
                  WHERE sr."generationSceneRequestId" = a."generationSceneRequestId"
                    AND sr."attemptKind" = 'SYSTEM_RECOVERY'::"GenerationAttemptKind"
               )
         ORDER BY v."validatedAt" ASC, v."id" ASC
         LIMIT ${limit}
      `;

      return rows.flatMap((row): AutomaticMediaRecoveryCandidate[] => {
        // The enum is closed in the database, so this cannot fail; narrowing it
        // through the domain's own guard is what keeps the candidate type honest
        // rather than a cast.
        if (!isMediaFailureKind(row.mediaFailureKind)) return [];
        if (row.jobQualityTier !== "NORMAL" && row.jobQualityTier !== "HIGH_QUALITY") return [];
        return [
          {
            organizationId: row.organizationId,
            sourceValidationId: row.sourceValidationId,
            sourceAttemptId: row.sourceAttemptId,
            generationSceneRequestId: row.generationSceneRequestId,
            mediaFailureKind: row.mediaFailureKind,
            route: {
              providerName: row.providerName,
              providerModelId: row.providerModelId,
              requestModelKey: row.requestModelKey,
              requestNativeGenerationResolution: row.requestNativeGenerationResolution,
              requestResolutionNormalization: row.requestResolutionNormalization,
              requestNativeMeetsTarget: row.requestNativeMeetsTarget,
            },
            targetOutputResolution: row.targetOutputResolution,
            sceneDurationSeconds: row.sceneDurationSeconds,
            jobQualityTier: row.jobQualityTier,
            persistedPricingIdentity: row.persistedPricingIdentity,
            persistedPricingContractFingerprint: row.persistedPricingContractFingerprint,
          },
        ];
      });
    },

    async admitAutomaticMediaRecovery(input: AdmitAutomaticMediaRecoveryInput) {
      return prisma.$transaction(async (tx): Promise<AutomaticMediaRecoveryOutcome> => {
        // ---- 1. Locks, Job first, in the fixed order. -------------------
        const locked = await lockRecoveryChainForTenant(
          tx,
          input.organizationId,
          input.sourceAttemptId,
        );
        if (!locked) return { kind: "NOT_FOUND" };

        // ---- 2. One authoritative read under those locks. ---------------
        const row = await readRecoveryContext(tx, input.organizationId, input.sourceAttemptId);
        if (row === null) return { kind: "NOT_FOUND" };

        // ---- 3. The validation must be the one that was planned against. -
        if (row.validationId === null || row.validationId !== input.sourceValidationId) {
          return { kind: "NOT_ELIGIBLE" };
        }
        if (row.validationAttemptId !== row.sourceAttemptId) {
          throw new AutomaticMediaRecoveryDefect("SOURCE_VALIDATION_MISBOUND");
        }

        // ---- 4. Terminal media failure only. ----------------------------
        // A positive test for the two failure verdicts. `VALID` belongs to
        // Transaction F and must never create a recovery attempt; `PENDING` and
        // `RUNNING` have decided nothing yet.
        if (
          row.validationStatus === null ||
          !isMediaFailureKind(row.validationStatus) ||
          row.validationValidatedAt === null
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }
        const failureKind: MediaFailureKind = row.validationStatus;

        if (row.orchestrationState !== "OUTPUT_VERIFIED") return { kind: "NOT_ELIGIBLE" };

        // ---- 5. The verdict must describe the source attempt's bytes. ---
        if (
          row.outputSha256 === null ||
          row.outputSizeBytes === null ||
          row.receiptSha256 !== row.outputSha256 ||
          row.receiptSizeBytes === null ||
          row.receiptSizeBytes !== row.outputSizeBytes
        ) {
          // Never repaired, never re-validated, and no recovery is created
          // anyway: a verdict about other bytes says nothing about this attempt.
          throw new AutomaticMediaRecoveryDefect("SOURCE_RECEIPT_BINDING_CONFLICT");
        }

        // ---- 6. The cost circuit breaker, before latest-attempt. --------
        // Ordering matters. Once a recovery exists it is the latest attempt, so
        // the source failure is no longer latest — and that is precisely the
        // idempotent replay case, not an eligibility failure.
        if (!automaticMediaRecoveryAllowed(row.systemRecoveryCount)) {
          // The source is still the newest attempt, so this is the recovery's
          // own failure: the one automatic retry is spent. Nothing is
          // terminalized here — that is Phase 6C's decision.
          if (row.attemptOrdinal !== null && row.attemptOrdinal === row.maxAttemptOrdinal) {
            return { kind: "RECOVERY_LIMIT_REACHED" };
          }
          // A newer attempt exists and a recovery exists: this exact source
          // failure was already answered while this worker was planning.
          return { kind: "ALREADY_RECOVERED" };
        }

        // ---- 7. Latest-attempt authority, by durable ordinal. -----------
        if (
          row.attemptOrdinal === null ||
          row.maxAttemptOrdinal === null ||
          row.attemptOrdinal !== row.maxAttemptOrdinal
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }

        // ---- 8. The customer-facing chain must be exactly where it was. -
        if (row.requestState !== "GENERATING") return { kind: "NOT_ELIGIBLE" };
        if (row.jobState !== "GENERATING") return { kind: "NOT_ELIGIBLE" };

        const expectedSceneState =
          row.requestKind === "USER_REGENERATION" ? "REVISING" : "GENERATING";
        if (row.sceneState !== expectedSceneState) return { kind: "NOT_ELIGIBLE" };

        if (row.requestKind === "USER_REGENERATION") {
          // A regeneration replaces a delivered predecessor; recovering one
          // whose predecessor is missing would retry work that answers nothing.
          if (row.sceneDeliveredRequestId === null) return { kind: "NOT_ELIGIBLE" };
          const previous = await tx.sceneGenerationRequest.findFirst({
            where: { id: row.sceneDeliveredRequestId, generationSceneId: row.sceneId },
            select: { state: true },
          });
          if (previous === null || previous.state !== "DELIVERED") {
            return { kind: "NOT_ELIGIBLE" };
          }
        }

        // ---- 9. The route the recovery must reproduce, from the source. -
        // Narrowed through the domain's own guard rather than cast: the column
        // is a database enum, and a row that somehow holds anything else is a
        // route this application cannot reproduce.
        if (
          row.requestModelKey === null ||
          row.requestRenderedPrompt === null ||
          row.requestNativeGenerationResolution === null ||
          row.requestResolutionNormalization === null ||
          !isResolutionNormalization(row.requestResolutionNormalization) ||
          row.requestNativeMeetsTarget === null ||
          row.attemptKind === null
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }
        const normalization = row.requestResolutionNormalization;

        // The fresh plan must be for this exact route. The planner produced it
        // from this candidate, so a disagreement here is an internal defect
        // rather than a reason to price the retry differently.
        const identity = input.pricingSnapshot.identity;
        if (
          input.pricingSnapshot.provider !== row.providerName ||
          identity.pricingModelKey !== row.requestModelKey ||
          identity.nativeTier !== row.requestNativeGenerationResolution
        ) {
          throw new AutomaticMediaRecoveryDefect("RECOVERY_ROUTE_MISMATCH");
        }
        if (input.pricingSnapshot.fxSnapshotId !== input.fxSnapshot.id) {
          throw new AutomaticMediaRecoveryDefect("RECOVERY_FX_BINDING_CONFLICT");
        }

        // ---- 10. One admission path, not a second implementation. -------
        // The request lock is already held, so the derivations inside —
        // attempt kind, ordinal, request hash, pricing and FX binding, the
        // first event — see settled state. The kind derives to SYSTEM_RECOVERY
        // because a PRIMARY already exists, and the request stays GENERATING
        // because only a PRIMARY starts it.
        const admitted = await admitAttemptWithin(
          tx,
          input.organizationId,
          {
            id: input.attemptId,
            generationSceneRequestId: row.requestId,
            // The source attempt's immutable route, copied exactly. No fallback
            // provider, no ranking, no re-render: "retry the same work once".
            providerName: row.providerName,
            providerModelId: row.providerModelId,
            requestModelKey: row.requestModelKey,
            requestRenderedPrompt: row.requestRenderedPrompt,
            requestNativeGenerationResolution: row.requestNativeGenerationResolution,
            requestResolutionNormalization: normalization,
            requestNativeMeetsTarget: row.requestNativeMeetsTarget,
            pricingSnapshotId: input.pricingSnapshotId,
            pricingSnapshot: input.pricingSnapshot,
            fxSnapshot: input.fxSnapshot,
          },
          {
            ...input.context,
            eventType: MEDIA_RECOVERY_ADMITTED_EVENT_TYPE,
            // Why this attempt exists, in application-owned vocabulary. No probe
            // output, no invalid reason object, no provider body, no prompt.
            reasonCode: mediaRecoveryReasonCode(failureKind),
          },
        );

        switch (admitted.kind) {
          case "ADMITTED":
            return {
              kind: "ADMITTED",
              attemptId: admitted.attempt.id,
              attemptOrdinal: admitted.attempt.attemptOrdinal,
            };
          // A live sibling means provider work is still running for this
          // request; recovery is sequential, so this is an ordinary refusal.
          case "ATTEMPT_ALREADY_ACTIVE":
          case "REQUEST_NOT_ADMITTING":
          case "SCENE_FACTS_INCOMPLETE":
          case "REQUEST_NOT_FOUND":
            return { kind: "NOT_ELIGIBLE" };
          // Both bindings were produced by the planner from this candidate, so
          // a rejection here is an internal inconsistency, not an input error.
          case "PRICING_BINDING_INVALID":
            throw new AutomaticMediaRecoveryDefect("RECOVERY_ROUTE_MISMATCH");
          case "FX_BINDING_INVALID":
            throw new AutomaticMediaRecoveryDefect("RECOVERY_FX_BINDING_CONFLICT");
        }
      });
    },
  };
}

/**
 * Take the whole recovery chain lock in the fixed order, proving tenancy.
 *
 * `FOR UPDATE OF j, s, r, a` locks the four mutable rows. The request lock is
 * what `admitAttemptWithin` assumes it already holds, and is what makes the
 * sibling count and the recovery cap safe against a second worker.
 */
async function lockRecoveryChainForTenant(
  tx: Tx,
  organizationId: string,
  sourceAttemptId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT j."id"
      FROM "generation_jobs" j
      JOIN "generation_scenes" s ON s."generationJobId" = j."id"
      JOIN "scene_generation_requests" r ON r."generationSceneId" = s."id"
      JOIN "scene_generations" a ON a."generationSceneRequestId" = r."id"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE a."id" = ${sourceAttemptId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF j, s, r, a
  `;
  return rows.length > 0;
}

/** One authoritative read of every row the recovery authority judges. */
async function readRecoveryContext(
  tx: Tx,
  organizationId: string,
  sourceAttemptId: string,
): Promise<RecoveryContextRow | null> {
  const rows = await tx.$queryRaw<RecoveryContextRow[]>`
    SELECT p."organizationId"                     AS "organizationId",
           a."id"                                 AS "sourceAttemptId",
           a."attemptOrdinal"                     AS "attemptOrdinal",
           a."attemptKind"::text                  AS "attemptKind",
           a."orchestrationState"::text           AS "orchestrationState",
           a."outputSha256"                       AS "outputSha256",
           a."outputSizeBytes"                    AS "outputSizeBytes",
           a."providerName"                       AS "providerName",
           a."providerModelId"                    AS "providerModelId",
           a."requestModelKey"                    AS "requestModelKey",
           a."requestRenderedPrompt"              AS "requestRenderedPrompt",
           a."requestNativeGenerationResolution"  AS "requestNativeGenerationResolution",
           a."requestResolutionNormalization"     AS "requestResolutionNormalization",
           a."requestNativeMeetsTarget"           AS "requestNativeMeetsTarget",
           v."id"                                 AS "validationId",
           v."sceneGenerationId"                  AS "validationAttemptId",
           v."status"::text                       AS "validationStatus",
           v."validatedAt"                        AS "validationValidatedAt",
           v."receiptSha256"                      AS "receiptSha256",
           v."receiptSizeBytes"                   AS "receiptSizeBytes",
           r."id"                                 AS "requestId",
           r."kind"::text                         AS "requestKind",
           r."state"::text                        AS "requestState",
           s."id"                                 AS "sceneId",
           s."state"::text                        AS "sceneState",
           s."currentDeliveredRequestId"          AS "sceneDeliveredRequestId",
           j."state"::text                        AS "jobState",
           (SELECT MAX(sib."attemptOrdinal")
              FROM "scene_generations" sib
             WHERE sib."generationSceneRequestId" = r."id") AS "maxAttemptOrdinal",
           (SELECT COUNT(*)::int
              FROM "scene_generations" sr
             WHERE sr."generationSceneRequestId" = r."id"
               AND sr."attemptKind" = 'SYSTEM_RECOVERY'::"GenerationAttemptKind"
           ) AS "systemRecoveryCount"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      LEFT JOIN "managed_output_media_validations" v ON v."sceneGenerationId" = a."id"
     WHERE a."id" = ${sourceAttemptId}
       AND p."organizationId" = ${organizationId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}
