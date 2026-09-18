/**
 * Durable media-failure resolution work, and Transaction H.
 *
 * ## Two jobs, one file, on purpose
 *
 * The work lifecycle (`claim` → `defer` / `resolve*`) and the settlement
 * (`settleExhaustedMediaFailure`) are separate transactions with very different
 * lock footprints, but they share one invariant that is easy to break if they
 * drift apart: **the work row is resolved in the same commit as the customer
 * mutation it authorized.** A settlement that committed the customer's failure
 * and then resolved its work row separately would, on a crash between the two,
 * leave a claimable work item pointing at a job that has already been settled —
 * and the next worker would have to decide whether to settle it again.
 *
 * ## The lock order, in full
 *
 * ```text
 * cost-admission advisory lock
 *   -> GenerationReservation   FOR UPDATE
 *   -> GenerationJob           FOR UPDATE
 *   -> GenerationScene         FOR UPDATE
 *   -> SceneGenerationRequest  FOR UPDATE
 *   -> SceneGeneration (source attempt) FOR UPDATE
 *   -> ManagedOutputMediaValidation     FOR UPDATE
 *   -> resolution work row              FOR UPDATE
 * ```
 *
 * The advisory lock is first because the paid-submission gate takes it first,
 * and the reservation row is second for the same reason. That is not symmetry
 * for its own sake — it is the whole point. Settlement *releases* a reservation,
 * which is precisely the mutation the authorization path protects itself
 * against:
 *
 * ```text
 * T1  lock cycle -> read reservation RESERVED -> gate permits
 * T2                UPDATE reservation -> RELEASED
 * T2                commit
 * T1  arm QUEUED -> SUBMITTING -> commit          <- paid, against a released hold
 * ```
 *
 * Sharing the key and the order makes that interleaving impossible rather than
 * unlikely.
 *
 * The billing-cycle key is read *before* the advisory lock, which is safe
 * because a reservation's cycle is frozen when the hold is taken and never
 * recomputed.
 */

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isMediaFailureKind,
  isResolutionNormalization,
  MediaFailureSettlementDefect,
  INITIAL_MEDIA_FAILURE_SETTLED_REASON,
  USER_REGENERATION_ROLLED_BACK_REASON,
  type ClaimMediaFailureResolutionInput,
  type DeferMediaFailureResolutionInput,
  type MediaFailureKind,
  type MediaFailureResolutionCandidate,
  type MediaFailureResolutionClaim,
  type MediaFailureResolutionClaimOutcome,
  type MediaFailureResolutionDisposition,
  type MediaFailureResolutionQuery,
  type MediaFailureResolutionRepository,
  type MediaFailureResolutionWriteOutcome,
  type ReleaseMediaFailureResolutionInput,
  type ResolveMediaFailureResolutionInput,
  type ResolveRecoveryAdmittedInput,
  type SettleExhaustedMediaFailureInput,
  type SettleExhaustedMediaFailureOutcome,
  validateMediaFailureResolutionBatchLimit,
} from "@app/domain";
import { AppError } from "@app/shared";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Prisma.TransactionClient;

interface CandidateRow {
  readonly sourceValidationId: string;
}

/** Everything the claim transaction needs to classify one failure. */
interface ClaimContextRow {
  readonly validationId: string;
  readonly validationStatus: string;
  readonly validationValidatedAt: Date | null;
  readonly receiptSha256: string;
  readonly receiptSizeBytes: bigint;
  readonly workId: string | null;
  readonly workStatus: string | null;
  readonly workVersion: number | null;
  readonly workLeaseExpiresAt: Date | null;
  readonly workNextAttemptAt: Date | null;
  readonly workResolutionKind: string | null;
  readonly organizationId: string;
  readonly sourceAttemptId: string;
  readonly attemptKind: string;
  readonly attemptOrdinal: number;
  readonly maxAttemptOrdinal: number;
  readonly orchestrationState: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  readonly systemRecoveryCount: number;
  readonly existingRecoveryAttemptId: string | null;
  readonly generationSceneRequestId: string;
  readonly requestKind: string;
  readonly requestState: string;
  readonly providerName: string;
  readonly providerModelId: string;
  readonly requestModelKey: string | null;
  readonly requestNativeGenerationResolution: string | null;
  readonly requestResolutionNormalization: string | null;
  readonly requestNativeMeetsTarget: boolean | null;
  readonly targetOutputResolution: string;
  readonly sceneDurationSeconds: number;
  readonly jobQualityTier: "NORMAL" | "HIGH_QUALITY";
  readonly pricingIdentityJson: unknown;
  readonly pricingContractFingerprint: string | null;
}

/**
 * The candidate sweep.
 *
 * Deferred work is absent until `nextAttemptAt` arrives, and that single
 * predicate is the entire fairness mechanism: an unplannable candidate stops
 * being a candidate for a retry delay, so the bounded oldest-first window moves
 * past it to work that can actually be done. No unbounded scan, no priority
 * queue, no second index to keep in step.
 */
const CANDIDATE_SQL_ORDER = 'v."validatedAt" ASC, v."id" ASC';

export function createMediaFailureResolutionRepository(
  prisma: PrismaClient,
): MediaFailureResolutionRepository {
  async function readClaimContext(
    tx: Pick<PrismaClient, "$queryRaw">,
    sourceValidationId: string,
  ): Promise<ClaimContextRow | null> {
    const rows = await tx.$queryRaw<ClaimContextRow[]>`
      SELECT v."id"                          AS "validationId",
             v."status"::text                AS "validationStatus",
             v."validatedAt"                 AS "validationValidatedAt",
             v."receiptSha256"               AS "receiptSha256",
             v."receiptSizeBytes"            AS "receiptSizeBytes",
             w."id"                          AS "workId",
             w."status"::text                AS "workStatus",
             w."version"                     AS "workVersion",
             w."leaseExpiresAt"              AS "workLeaseExpiresAt",
             w."nextAttemptAt"               AS "workNextAttemptAt",
             w."resolutionKind"::text        AS "workResolutionKind",
             p."organizationId"              AS "organizationId",
             a."id"                          AS "sourceAttemptId",
             a."attemptKind"::text           AS "attemptKind",
             a."attemptOrdinal"              AS "attemptOrdinal",
             a."orchestrationState"::text    AS "orchestrationState",
             a."outputSha256"                AS "outputSha256",
             a."outputSizeBytes"             AS "outputSizeBytes",
             a."generationSceneRequestId"    AS "generationSceneRequestId",
             a."providerName"                AS "providerName",
             a."providerModelId"             AS "providerModelId",
             a."requestModelKey"             AS "requestModelKey",
             a."requestNativeGenerationResolution" AS "requestNativeGenerationResolution",
             a."requestResolutionNormalization"    AS "requestResolutionNormalization",
             a."requestNativeMeetsTarget"          AS "requestNativeMeetsTarget",
             r."kind"::text                  AS "requestKind",
             r."state"::text                 AS "requestState",
             j."targetOutputResolution"      AS "targetOutputResolution",
             j."qualityTier"::text           AS "jobQualityTier",
             s."snapshotDurationSeconds"     AS "sceneDurationSeconds",
             ps."identityJson"               AS "pricingIdentityJson",
             ps."contractFingerprint"        AS "pricingContractFingerprint",
             (SELECT COALESCE(MAX(sib."attemptOrdinal"), 0)
                FROM "scene_generations" sib
               WHERE sib."generationSceneRequestId" = a."generationSceneRequestId")
                                             AS "maxAttemptOrdinal",
             (SELECT COUNT(*)::int
                FROM "scene_generations" sr
               WHERE sr."generationSceneRequestId" = a."generationSceneRequestId"
                 AND sr."attemptKind" = 'SYSTEM_RECOVERY'::"GenerationAttemptKind")
                                             AS "systemRecoveryCount",
             (SELECT sr2."id"
                FROM "scene_generations" sr2
               WHERE sr2."generationSceneRequestId" = a."generationSceneRequestId"
                 AND sr2."attemptKind" = 'SYSTEM_RECOVERY'::"GenerationAttemptKind"
               ORDER BY sr2."attemptOrdinal" DESC
               LIMIT 1)                      AS "existingRecoveryAttemptId"
        FROM "managed_output_media_validations" v
        JOIN "scene_generations" a ON a."id" = v."sceneGenerationId"
        JOIN "video_projects" p ON p."id" = a."videoProjectId"
        JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
        JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
        JOIN "generation_jobs" j ON j."id" = s."generationJobId"
        LEFT JOIN "generation_pricing_snapshots" ps ON ps."sceneGenerationId" = a."id"
        LEFT JOIN "managed_output_media_failure_resolutions" w
               ON w."managedOutputMediaValidationId" = v."id"
       WHERE v."id" = ${sourceValidationId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * What this failure needs, from facts read under the claim.
   *
   * Deliberately total: every shape produces a disposition or `null`, and
   * `null` means "not eligible", never "do something reasonable".
   */
  function classify(row: ClaimContextRow): MediaFailureResolutionDisposition | null {
    if (!isMediaFailureKind(row.validationStatus)) return null;
    if (row.validationValidatedAt === null) return null;
    if (row.orchestrationState !== "OUTPUT_VERIFIED") return null;

    // The verdict must be about the bytes the attempt actually verified.
    if (
      row.outputSha256 === null ||
      row.outputSizeBytes === null ||
      row.receiptSha256 !== row.outputSha256 ||
      row.receiptSizeBytes !== row.outputSizeBytes
    ) {
      throw new MediaFailureSettlementDefect("SOURCE_RECEIPT_BINDING_CONFLICT");
    }

    // A request that already reached a terminal or delivered state has been
    // answered by some other authority. Nothing here is owed to the customer.
    if (row.requestState !== "GENERATING") return { kind: "OBSOLETE" };

    // A superseded attempt's failure is history: a newer attempt is the live one.
    if (row.attemptOrdinal !== row.maxAttemptOrdinal) {
      return row.existingRecoveryAttemptId === null
        ? { kind: "OBSOLETE" }
        : { kind: "RECONCILE_RECOVERY", recoveryAttemptId: row.existingRecoveryAttemptId };
    }

    // The failed attempt *is* the automatic recovery. The customer is owed an
    // answer, and Transaction H is the only thing that may give it.
    if (row.attemptKind === "SYSTEM_RECOVERY") return { kind: "SETTLE_EXHAUSTED" };

    // A PRIMARY failure with a recovery already in existence: either another
    // worker admitted it, or a previous claim of this very work did and died
    // before resolving the row. Indistinguishable, and identical in effect.
    if (row.existingRecoveryAttemptId !== null) {
      return { kind: "RECONCILE_RECOVERY", recoveryAttemptId: row.existingRecoveryAttemptId };
    }
    if (row.systemRecoveryCount > 0) return null;

    const candidate = toRecoveryCandidate(row);
    return candidate === null ? null : { kind: "ADMIT_RECOVERY", candidate };
  }

  return {
    async findResolutionCandidates(
      query: MediaFailureResolutionQuery,
    ): Promise<readonly MediaFailureResolutionCandidate[]> {
      const limit = validateMediaFailureResolutionBatchLimit(query.limit);
      const at = new Date(query.now);
      const rows = await prisma.$queryRawUnsafe<CandidateRow[]>(
        `
        SELECT v."id" AS "sourceValidationId"
          FROM "managed_output_media_validations" v
          JOIN "scene_generations" a ON a."id" = v."sceneGenerationId"
          LEFT JOIN "managed_output_media_failure_resolutions" w
                 ON w."managedOutputMediaValidationId" = v."id"
         WHERE v."status" IN (
                 'INVALID_MEDIA'::"ManagedOutputMediaValidationStatus",
                 'INTEGRITY_MISMATCH'::"ManagedOutputMediaValidationStatus"
               )
           AND v."validatedAt" IS NOT NULL
           AND a."orchestrationState" = 'OUTPUT_VERIFIED'::"GenerationAttemptState"
           AND (
                 w."id" IS NULL
              OR (w."status" = 'PENDING'::"MediaFailureResolutionStatus"
                  AND w."nextAttemptAt" IS NOT NULL
                  AND w."nextAttemptAt" <= $1)
              OR (w."status" = 'RUNNING'::"MediaFailureResolutionStatus"
                  AND w."leaseExpiresAt" IS NOT NULL
                  AND w."leaseExpiresAt" <= $1)
           )
         ORDER BY ${CANDIDATE_SQL_ORDER}
         LIMIT $2
      `,
        at,
        limit,
      );
      return rows.map((row) => ({ sourceValidationId: row.sourceValidationId }));
    },

    async claim(
      input: ClaimMediaFailureResolutionInput,
    ): Promise<MediaFailureResolutionClaimOutcome> {
      if (typeof input.leaseToken !== "string" || input.leaseToken.length === 0) {
        throw new AppError(
          "VALIDATION_FAILED",
          "A media-failure resolution lease token must be non-empty",
        );
      }
      const expires = new Date(input.leaseExpiresAt);

      return prisma.$transaction(
        async (tx): Promise<MediaFailureResolutionClaimOutcome> => {
          const row = await readClaimContext(tx, input.sourceValidationId);
          if (row === null) return { kind: "NOT_ELIGIBLE" };

          const disposition = classify(row);
          if (disposition === null) return { kind: "NOT_ELIGIBLE" };

          // ---- No work row yet: the lazy-discovery path. ------------------
          //
          // Two workers can both read this as absent and both try to create it.
          // A unique violation would abort the PostgreSQL transaction, so
          // catching it in JavaScript is not recovery — every following
          // statement fails with `25P02`. The only safe shape is an insert that
          // never raises, leaving the loser free to read what the winner wrote.
          if (row.workId === null) {
            const id = `momfr_${randomUUID()}`;
            const inserted = await tx.$queryRaw<{ id: string; version: number }[]>`
              INSERT INTO "managed_output_media_failure_resolutions" (
                "id", "managedOutputMediaValidationId", "status",
                "leaseToken", "leaseExpiresAt", "nextAttemptAt",
                "attemptCount", "version", "createdAt", "updatedAt"
              ) VALUES (
                ${id},
                ${input.sourceValidationId},
                'RUNNING'::"MediaFailureResolutionStatus",
                ${input.leaseToken},
                ${expires},
                NULL,
                1,
                1,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
              )
              ON CONFLICT ("managedOutputMediaValidationId") DO NOTHING
              RETURNING "id", "version"
            `;
            const created = inserted[0];
            if (created !== undefined) {
              return {
                kind: "CLAIMED",
                claim: claimOf(row, created.id, created.version, input.leaseToken, disposition),
              };
            }

            // Another worker won the first-record race. The transaction was
            // never poisoned, so one bounded re-read reports what it wrote.
            const again = await readClaimContext(tx, input.sourceValidationId);
            if (again === null || again.workStatus === null) return { kind: "NOT_CLAIMED" };
            return again.workStatus === "RESOLVED"
              ? {
                  kind: "ALREADY_RESOLVED",
                  resolutionKind: resolutionKindOf(again.workResolutionKind),
                }
              : { kind: "NOT_CLAIMED" };
          }

          // ---- A work row exists. -----------------------------------------
          if (row.workStatus === "RESOLVED") {
            return {
              kind: "ALREADY_RESOLVED",
              resolutionKind: resolutionKindOf(row.workResolutionKind),
            };
          }
          if (row.workVersion === null) return { kind: "NOT_ELIGIBLE" };

          const claimable =
            row.workStatus === "PENDING"
              ? row.workNextAttemptAt !== null &&
                row.workNextAttemptAt.getTime() <= input.now
              : row.workLeaseExpiresAt !== null &&
                row.workLeaseExpiresAt.getTime() <= input.now;
          if (!claimable) return { kind: "NOT_CLAIMED" };

          // The version in the predicate is what makes two workers reclaiming
          // one expired lease resolve to a single winner.
          const nextVersion = row.workVersion + 1;
          const { count } = await tx.managedOutputMediaFailureResolution.updateMany({
            where: {
              id: row.workId,
              version: row.workVersion,
              status: row.workStatus === "PENDING" ? "PENDING" : "RUNNING",
            },
            data: {
              status: "RUNNING",
              leaseToken: input.leaseToken,
              leaseExpiresAt: expires,
              nextAttemptAt: null,
              attemptCount: { increment: 1 },
              version: nextVersion,
            },
          });
          if (count !== 1) return { kind: "NOT_CLAIMED" };

          return {
            kind: "CLAIMED",
            claim: claimOf(row, row.workId, nextVersion, input.leaseToken, disposition),
          };
        },
      );
    },

    async defer(
      input: DeferMediaFailureResolutionInput,
    ): Promise<MediaFailureResolutionWriteOutcome> {
      return guardedWrite(prisma, input.claim, {
        status: "PENDING",
        nextAttemptAt: new Date(input.nextAttemptAt),
        lastPlanRefusalCode: input.refusalCode,
        resolutionKind: null,
        recoveryAttemptId: null,
        resolvedAt: null,
      });
    },

    async release(
      input: ReleaseMediaFailureResolutionInput,
    ): Promise<MediaFailureResolutionWriteOutcome> {
      return guardedWrite(prisma, input.claim, {
        status: "PENDING",
        nextAttemptAt: new Date(input.nextAttemptAt),
        // No refusal code: a release says only "this worker is no longer holding
        // it". Recording the previous attempt's reason here would claim planning
        // refused when it may have thrown before reaching a verdict.
        lastPlanRefusalCode: null,
        resolutionKind: null,
        recoveryAttemptId: null,
        resolvedAt: null,
      });
    },

    async resolveRecoveryAdmitted(
      input: ResolveRecoveryAdmittedInput,
    ): Promise<MediaFailureResolutionWriteOutcome> {
      return guardedWrite(prisma, input.claim, {
        status: "RESOLVED",
        nextAttemptAt: null,
        lastPlanRefusalCode: null,
        resolutionKind: "RECOVERY_ADMITTED",
        recoveryAttemptId: input.recoveryAttemptId,
        resolvedAt: new Date(input.resolvedAt),
      });
    },

    async resolveObsolete(
      input: ResolveMediaFailureResolutionInput,
    ): Promise<MediaFailureResolutionWriteOutcome> {
      return guardedWrite(prisma, input.claim, {
        status: "RESOLVED",
        nextAttemptAt: null,
        lastPlanRefusalCode: null,
        resolutionKind: "OBSOLETE",
        recoveryAttemptId: null,
        resolvedAt: new Date(input.resolvedAt),
      });
    },

    async settleExhaustedMediaFailure(
      input: SettleExhaustedMediaFailureInput,
    ): Promise<SettleExhaustedMediaFailureOutcome> {
      const { claim, settledAt, context } = input;
      const at = new Date(settledAt);

      // Immutable once the hold was taken, so reading it before the advisory
      // lock cannot be stale in a way that matters.
      const cycle = await billingCycleKeyForValidation(prisma, claim.organizationId, claim.sourceValidationId);
      if (cycle === null) return { kind: "NOT_FOUND" };

      return prisma.$transaction(
        async (tx): Promise<SettleExhaustedMediaFailureOutcome> => {
          await acquireCostAdmissionLock(tx, claim.organizationId, cycle);

          const locked = await lockSettlementChain(tx, claim.organizationId, claim.sourceValidationId);
          if (locked === null) return { kind: "NOT_FOUND" };

          // Every authority is re-read under its own lock. Nothing the claim
          // decided is trusted here: the claim held no lock on any of this.
          if (locked.validationId !== claim.sourceValidationId) {
            throw new MediaFailureSettlementDefect("SOURCE_VALIDATION_MISBOUND");
          }
          if (locked.sourceAttemptId !== claim.sourceAttemptId) {
            throw new MediaFailureSettlementDefect("SOURCE_VALIDATION_MISBOUND");
          }

          const settled = alreadySettled(locked);
          if (settled !== null) return { kind: "ALREADY_SETTLED", resolutionKind: settled };

          if (locked.workStatus !== "RUNNING" || locked.workVersion !== claim.version) {
            return { kind: "NOT_EXHAUSTED" };
          }
          if (locked.workLeaseToken !== claim.leaseToken) return { kind: "NOT_EXHAUSTED" };

          if (!exhaustedRecovery(locked)) return { kind: "NOT_EXHAUSTED" };

          return locked.requestKind === "INITIAL"
            ? settleInitial(tx, claim, locked, at, context)
            : rollBackRegeneration(tx, claim, locked, at, context);
        },
      );
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Claim helpers                                                              */
/* ------------------------------------------------------------------------- */

function claimOf(
  row: ClaimContextRow,
  workId: string,
  version: number,
  leaseToken: string,
  disposition: MediaFailureResolutionDisposition,
): MediaFailureResolutionClaim {
  return {
    workId,
    sourceValidationId: row.validationId,
    sourceAttemptId: row.sourceAttemptId,
    organizationId: row.organizationId,
    version,
    leaseToken,
    disposition,
  };
}

function resolutionKindOf(
  value: string | null,
): "RECOVERY_ADMITTED" | "INITIAL_FAILURE_SETTLED" | "USER_REGENERATION_ROLLED_BACK" | "OBSOLETE" {
  if (
    value === "RECOVERY_ADMITTED" ||
    value === "INITIAL_FAILURE_SETTLED" ||
    value === "USER_REGENERATION_ROLLED_BACK" ||
    value === "OBSOLETE"
  ) {
    return value;
  }
  // A RESOLVED row with no kind cannot exist: the shape CHECK forbids it.
  throw new AppError("INTERNAL_ERROR", "A resolved media-failure work row carries no resolution kind");
}

/** The Phase 6B planning candidate, assembled from the same locked read. */
function toRecoveryCandidate(row: ClaimContextRow): {
  readonly organizationId: string;
  readonly sourceValidationId: string;
  readonly sourceAttemptId: string;
  readonly generationSceneRequestId: string;
  readonly mediaFailureKind: MediaFailureKind;
  readonly route: {
    readonly providerName: string;
    readonly providerModelId: string;
    readonly requestModelKey: string;
    readonly requestNativeGenerationResolution: string;
    readonly requestResolutionNormalization: string;
    readonly requestNativeMeetsTarget: boolean;
  };
  readonly targetOutputResolution: string;
  readonly sceneDurationSeconds: number;
  readonly jobQualityTier: "NORMAL" | "HIGH_QUALITY";
  readonly persistedPricingIdentity: unknown;
  readonly persistedPricingContractFingerprint: string;
} | null {
  if (!isMediaFailureKind(row.validationStatus)) return null;
  if (
    row.requestModelKey === null ||
    row.requestNativeGenerationResolution === null ||
    row.requestResolutionNormalization === null ||
    row.requestNativeMeetsTarget === null ||
    row.pricingContractFingerprint === null
  ) {
    return null;
  }
  if (!isResolutionNormalization(row.requestResolutionNormalization)) return null;

  return {
    organizationId: row.organizationId,
    sourceValidationId: row.validationId,
    sourceAttemptId: row.sourceAttemptId,
    generationSceneRequestId: row.generationSceneRequestId,
    mediaFailureKind: row.validationStatus,
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
    persistedPricingIdentity: row.pricingIdentityJson,
    persistedPricingContractFingerprint: row.pricingContractFingerprint,
  };
}

/** The full column set a guarded write may set. Every field is written, always. */
interface GuardedWriteData {
  readonly status: "PENDING" | "RESOLVED";
  readonly nextAttemptAt: Date | null;
  readonly lastPlanRefusalCode: string | null;
  readonly resolutionKind: string | null;
  readonly recoveryAttemptId: string | null;
  readonly resolvedAt: Date | null;
}

/**
 * Every write after a claim, guarded the same way.
 *
 * `id`, `version`, `status = RUNNING` and `leaseToken` together. A worker whose
 * lease expired and was reclaimed by somebody else matches zero rows here and
 * learns so as `LOST`, which is the mechanism working rather than an error.
 *
 * Raw SQL rather than Prisma's `updateMany`, for one specific reason:
 * `recoveryAttemptId` is a foreign key with a relation, so Prisma omits the
 * scalar from its update input and offers `connect` instead — which is not
 * expressible in the same guarded `updateMany` that carries the version and
 * lease predicates. Writing the statement out keeps the guard and the binding in
 * one place instead of splitting them across two calls.
 *
 * Every column is written on every path, including the ones being cleared. A
 * partial write here would leave, say, a RESOLVED row still holding the refusal
 * code that preceded it, and the database's shape CHECK would not catch it
 * because nothing about that combination is impossible.
 */
async function guardedWrite(
  prisma: PrismaClient,
  claim: MediaFailureResolutionClaim,
  data: GuardedWriteData,
): Promise<MediaFailureResolutionWriteOutcome> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "managed_output_media_failure_resolutions"
       SET "status" = ${data.status}::"MediaFailureResolutionStatus",
           "leaseToken" = NULL,
           "leaseExpiresAt" = NULL,
           "nextAttemptAt" = ${data.nextAttemptAt},
           "lastPlanRefusalCode" =
             ${data.lastPlanRefusalCode}::"MediaRecoveryPlanRefusalCode",
           "resolutionKind" = ${data.resolutionKind}::"MediaFailureResolutionKind",
           "recoveryAttemptId" = ${data.recoveryAttemptId},
           "resolvedAt" = ${data.resolvedAt},
           "version" = "version" + 1,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${claim.workId}
       AND "version" = ${claim.version}
       AND "status" = 'RUNNING'::"MediaFailureResolutionStatus"
       AND "leaseToken" = ${claim.leaseToken}
     RETURNING "id"
  `;
  return rows.length === 1 ? { kind: "APPLIED" } : { kind: "LOST" };
}

/* ------------------------------------------------------------------------- */
/* Transaction H                                                              */
/* ------------------------------------------------------------------------- */

interface SettlementChainRow {
  readonly validationId: string;
  readonly validationStatus: string;
  readonly validationValidatedAt: Date | null;
  readonly receiptSha256: string;
  readonly receiptSizeBytes: bigint;
  readonly workId: string;
  readonly workStatus: string;
  readonly workVersion: number;
  readonly workLeaseToken: string | null;
  readonly workResolutionKind: string | null;
  readonly sourceAttemptId: string;
  readonly attemptKind: string;
  readonly attemptOrdinal: number;
  readonly maxAttemptOrdinal: number;
  readonly orchestrationState: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
  readonly systemRecoveryCount: number;
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
  readonly reservationId: string;
  readonly reservationState: string;
}

/** The immutable cycle this job's cost is attributed to. */
async function billingCycleKeyForValidation(
  prisma: PrismaClient,
  organizationId: string,
  validationId: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey"
      FROM "managed_output_media_validations" v
      JOIN "scene_generations" a ON a."id" = v."sceneGenerationId"
      JOIN "video_projects" p ON p."id" = a."videoProjectId"
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE v."id" = ${validationId}
       AND p."organizationId" = ${organizationId}
  `;
  return rows[0]?.billingCycleKey ?? null;
}

/**
 * The whole chain, locked in the declared order and read under those locks.
 *
 * `FOR UPDATE OF res, j, s, r, a, v, w` names every alias this transaction may
 * write. The project row is joined for tenancy and deliberately not locked: it
 * is evidence, and locking it would serialize unrelated jobs of one customer.
 *
 * PostgreSQL acquires the row locks for a single statement in an
 * implementation-defined order, so the guarantee this provides is mutual
 * exclusion over the whole set rather than a staged acquisition. That is exactly
 * what is needed, and it is also why every other multi-aggregate transaction in
 * this system locks the same set in one statement: two statements would be two
 * chances to interleave.
 */
async function lockSettlementChain(
  tx: Tx,
  organizationId: string,
  validationId: string,
): Promise<SettlementChainRow | null> {
  const rows = await tx.$queryRaw<SettlementChainRow[]>`
    SELECT v."id"                        AS "validationId",
           v."status"::text              AS "validationStatus",
           v."validatedAt"               AS "validationValidatedAt",
           v."receiptSha256"             AS "receiptSha256",
           v."receiptSizeBytes"          AS "receiptSizeBytes",
           w."id"                        AS "workId",
           w."status"::text              AS "workStatus",
           w."version"                   AS "workVersion",
           w."leaseToken"                AS "workLeaseToken",
           w."resolutionKind"::text      AS "workResolutionKind",
           a."id"                        AS "sourceAttemptId",
           a."attemptKind"::text         AS "attemptKind",
           a."attemptOrdinal"            AS "attemptOrdinal",
           a."orchestrationState"::text  AS "orchestrationState",
           a."outputSha256"              AS "outputSha256",
           a."outputSizeBytes"           AS "outputSizeBytes",
           r."id"                        AS "requestId",
           r."kind"::text                AS "requestKind",
           r."state"::text               AS "requestState",
           r."deliveredAt"               AS "requestDeliveredAt",
           s."id"                        AS "sceneId",
           s."state"::text               AS "sceneState",
           s."currentDeliveredRequestId" AS "currentDeliveredRequestId",
           j."id"                        AS "jobId",
           j."state"::text               AS "jobState",
           j."currentDeliverableVersionId" AS "currentDeliverableVersionId",
           res."id"                      AS "reservationId",
           res."state"::text             AS "reservationState",
           (SELECT COALESCE(MAX(sib."attemptOrdinal"), 0)
              FROM "scene_generations" sib
             WHERE sib."generationSceneRequestId" = a."generationSceneRequestId")
                                         AS "maxAttemptOrdinal",
           (SELECT COUNT(*)::int
              FROM "scene_generations" sr
             WHERE sr."generationSceneRequestId" = a."generationSceneRequestId"
               AND sr."attemptKind" = 'SYSTEM_RECOVERY'::"GenerationAttemptKind")
                                         AS "systemRecoveryCount"
      FROM "managed_output_media_validations" v
      JOIN "managed_output_media_failure_resolutions" w
             ON w."managedOutputMediaValidationId" = v."id"
      JOIN "scene_generations" a ON a."id" = v."sceneGenerationId"
      JOIN "video_projects" p ON p."id" = a."videoProjectId"
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE v."id" = ${validationId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res, j, s, r, a, v, w
  `;
  return rows[0] ?? null;
}

/**
 * Whether the failed source really is the spent automatic recovery.
 *
 * Settlement is authorized by the recovery's *own* failure, never by the
 * original PRIMARY's. A PRIMARY failure that merely has a recovery sibling is
 * answered — the recovery is running, or already failed and is the row that will
 * settle — and terminalizing from it would fail a customer whose retry is still
 * in flight.
 */
function exhaustedRecovery(row: SettlementChainRow): boolean {
  if (!isMediaFailureKind(row.validationStatus)) return false;
  if (row.validationValidatedAt === null) return false;
  if (row.orchestrationState !== "OUTPUT_VERIFIED") return false;
  if (row.attemptKind !== "SYSTEM_RECOVERY") return false;
  if (row.attemptOrdinal !== row.maxAttemptOrdinal) return false;
  if (row.systemRecoveryCount < 1) return false;
  if (
    row.outputSha256 === null ||
    row.outputSizeBytes === null ||
    row.receiptSha256 !== row.outputSha256 ||
    row.receiptSizeBytes !== row.outputSizeBytes
  ) {
    throw new MediaFailureSettlementDefect("SOURCE_RECEIPT_BINDING_CONFLICT");
  }
  return true;
}

/**
 * Whether the exact already-settled shape is present.
 *
 * Every row of it, or none. A partial match is a defect and is raised rather
 * than repaired: half an applied settlement means an invariant this application
 * believes it cannot violate was violated, and finishing the job quietly would
 * destroy the evidence of how.
 */
function alreadySettled(
  row: SettlementChainRow,
): "INITIAL_FAILURE_SETTLED" | "USER_REGENERATION_ROLLED_BACK" | null {
  if (row.workStatus !== "RESOLVED") return null;

  if (row.workResolutionKind === "INITIAL_FAILURE_SETTLED") {
    const complete =
      row.requestState === "FAILED_TERMINAL" &&
      row.sceneState === "FAILED_TERMINAL" &&
      row.jobState === "FAILED_TERMINAL" &&
      row.reservationState === "RELEASED";
    if (!complete) throw new MediaFailureSettlementDefect("PARTIAL_SETTLEMENT");
    return "INITIAL_FAILURE_SETTLED";
  }

  if (row.workResolutionKind === "USER_REGENERATION_ROLLED_BACK") {
    const complete =
      row.requestState === "FAILED_TERMINAL" &&
      row.sceneState === "READY" &&
      row.currentDeliveredRequestId !== null &&
      row.currentDeliveredRequestId !== row.requestId &&
      row.jobState === "DELIVERABLE_READY" &&
      row.currentDeliverableVersionId !== null &&
      row.reservationState === "CONSUMED";
    if (!complete) throw new MediaFailureSettlementDefect("PARTIAL_SETTLEMENT");
    return "USER_REGENERATION_ROLLED_BACK";
  }

  // Resolved as a recovery or as obsolete. Not a settlement, and not this
  // method's business.
  return null;
}

async function settleInitial(
  tx: Tx,
  claim: MediaFailureResolutionClaim,
  row: SettlementChainRow,
  at: Date,
  context: Parameters<typeof appendGenerationEvent>[1]["context"],
): Promise<SettleExhaustedMediaFailureOutcome> {
  // An INITIAL failure means the customer received nothing at all. Anything
  // that says otherwise means this is not the shape settlement was written for.
  if (
    row.requestState !== "GENERATING" ||
    row.requestDeliveredAt !== null ||
    row.sceneState !== "GENERATING" ||
    row.currentDeliveredRequestId !== null ||
    row.jobState !== "GENERATING" ||
    row.currentDeliverableVersionId !== null
  ) {
    return { kind: "NOT_EXHAUSTED" };
  }
  if (row.reservationState !== "RESERVED" && row.reservationState !== "RECONCILIATION_HOLD") {
    return { kind: "NOT_EXHAUSTED" };
  }

  await failRequest(tx, row.requestId, "GENERATING", at);
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "SCENE_REQUEST",
    aggregateId: row.requestId,
    fromState: "GENERATING",
    toState: "FAILED_TERMINAL",
    context: withReason(context, INITIAL_MEDIA_FAILURE_SETTLED_REASON),
  });

  await lockedMove(tx, "generation_scenes", "GenerationSceneState", row.sceneId, "GENERATING", "FAILED_TERMINAL");
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "SCENE",
    aggregateId: row.sceneId,
    fromState: "GENERATING",
    toState: "FAILED_TERMINAL",
    context: withReason(context, INITIAL_MEDIA_FAILURE_SETTLED_REASON),
  });

  await lockedMove(tx, "generation_jobs", "GenerationJobState", row.jobId, "GENERATING", "FAILED_TERMINAL");
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "JOB",
    aggregateId: row.jobId,
    fromState: "GENERATING",
    toState: "FAILED_TERMINAL",
    context: withReason(context, INITIAL_MEDIA_FAILURE_SETTLED_REASON),
  });

  // The customer's Unit comes back. This is the commercial rule the whole phase
  // exists for: a provider or system failure never consumes it.
  const released = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "generation_reservations"
       SET "state" = 'RELEASED'::"GenerationReservationState",
           "stateVersion" = "stateVersion" + 1,
           "releasedAt" = ${at},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${row.reservationId}
       AND "state" = ${row.reservationState}::"GenerationReservationState"
     RETURNING "id"
  `;
  if (released.length !== 1) {
    throw new MediaFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
  }
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "RESERVATION",
    aggregateId: row.reservationId,
    fromState: row.reservationState,
    toState: "RELEASED",
    context: withReason(context, INITIAL_MEDIA_FAILURE_SETTLED_REASON),
  });

  await resolveWorkWithin(tx, claim, "INITIAL_FAILURE_SETTLED", at);
  return { kind: "SETTLED", resolutionKind: "INITIAL_FAILURE_SETTLED", settledAt: at.getTime() };
}

async function rollBackRegeneration(
  tx: Tx,
  claim: MediaFailureResolutionClaim,
  row: SettlementChainRow,
  at: Date,
  context: Parameters<typeof appendGenerationEvent>[1]["context"],
): Promise<SettleExhaustedMediaFailureOutcome> {
  if (
    row.requestState !== "GENERATING" ||
    row.requestDeliveredAt !== null ||
    row.sceneState !== "REVISING" ||
    row.currentDeliveredRequestId === null ||
    row.jobState !== "GENERATING" ||
    row.currentDeliverableVersionId === null ||
    row.reservationState !== "CONSUMED"
  ) {
    return { kind: "NOT_EXHAUSTED" };
  }

  // The pointer must name a *different*, delivered request of this same scene:
  // that request is the video the customer keeps.
  const predecessor = await tx.$queryRaw<{ id: string; state: string }[]>`
    SELECT pr."id", pr."state"::text AS "state"
      FROM "scene_generation_requests" pr
     WHERE pr."id" = ${row.currentDeliveredRequestId}
       AND pr."generationSceneId" = ${row.sceneId}
  `;
  const previous = predecessor[0];
  if (
    previous === undefined ||
    previous.state !== "DELIVERED" ||
    previous.id === row.requestId
  ) {
    throw new MediaFailureSettlementDefect("DELIVERED_PREDECESSOR_MISBOUND");
  }

  // One revision at a time is the MVP constraint, and this is where it is
  // load-bearing rather than merely stated: with two scenes revising, returning
  // the job to its previous deliverable could discard the other scene's valid
  // replacement, and nothing durable records which scene versions that
  // deliverable was composed from.
  const siblings = await tx.$queryRaw<{ revising: number; active: number }[]>`
    SELECT
      (SELECT COUNT(*)::int
         FROM "generation_scenes" sib
        WHERE sib."generationJobId" = ${row.jobId}
          AND sib."id" <> ${row.sceneId}
          AND sib."state" <> 'READY'::"GenerationSceneState") AS "revising",
      (SELECT COUNT(*)::int
         FROM "scene_generation_requests" orr
         JOIN "generation_scenes" os ON os."id" = orr."generationSceneId"
        WHERE os."generationJobId" = ${row.jobId}
          AND orr."id" <> ${row.requestId}
          AND orr."kind" = 'USER_REGENERATION'::"SceneGenerationRequestKind"
          AND orr."state" IN (
                'PENDING'::"SceneGenerationRequestState",
                'GENERATING'::"SceneGenerationRequestState"
              )) AS "active"
  `;
  const counts = siblings[0];
  if (counts === undefined || counts.revising > 0 || counts.active > 0) {
    throw new MediaFailureSettlementDefect("CONCURRENT_REVISION_AMBIGUOUS");
  }

  await failRequest(tx, row.requestId, "GENERATING", at);
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "SCENE_REQUEST",
    aggregateId: row.requestId,
    fromState: "GENERATING",
    toState: "FAILED_TERMINAL",
    context: withReason(context, USER_REGENERATION_ROLLED_BACK_REASON),
  });

  // The scene returns to READY with its delivered pointer untouched. That
  // pointer is the customer's video, and this transaction never writes it.
  await lockedMove(tx, "generation_scenes", "GenerationSceneState", row.sceneId, "REVISING", "READY");
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "SCENE",
    aggregateId: row.sceneId,
    fromState: "REVISING",
    toState: "READY",
    context: withReason(context, USER_REGENERATION_ROLLED_BACK_REASON),
  });

  await lockedMove(tx, "generation_jobs", "GenerationJobState", row.jobId, "GENERATING", "DELIVERABLE_READY");
  await appendGenerationEvent(tx, {
    organizationId: claim.organizationId,
    aggregateType: "JOB",
    aggregateId: row.jobId,
    fromState: "GENERATING",
    toState: "DELIVERABLE_READY",
    context: withReason(context, USER_REGENERATION_ROLLED_BACK_REASON),
  });

  // The reservation is deliberately untouched — not even a version bump. It was
  // CONSUMED by the video the customer still has; releasing it would refund a
  // Unit that already produced a usable deliverable.

  await resolveWorkWithin(tx, claim, "USER_REGENERATION_ROLLED_BACK", at);
  return {
    kind: "SETTLED",
    resolutionKind: "USER_REGENERATION_ROLLED_BACK",
    settledAt: at.getTime(),
  };
}

async function failRequest(tx: Tx, requestId: string, from: string, at: Date): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "scene_generation_requests"
       SET "state" = 'FAILED_TERMINAL'::"SceneGenerationRequestState",
           "stateVersion" = "stateVersion" + 1,
           "failedAt" = ${at}
     WHERE "id" = ${requestId}
       AND "state" = ${from}::"SceneGenerationRequestState"
     RETURNING "id"
  `;
  if (rows.length !== 1) throw new MediaFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
}

/**
 * A state move on a row this transaction holds locked.
 *
 * Zero rows is a defect, not a race: the row is locked, so nothing else can have
 * moved it since it was read.
 */
async function lockedMove(
  tx: Tx,
  table: "generation_jobs" | "generation_scenes",
  _enum: "GenerationJobState" | "GenerationSceneState",
  id: string,
  from: string,
  to: string,
): Promise<void> {
  const rows =
    table === "generation_jobs"
      ? await tx.$queryRaw<{ id: string }[]>`
          UPDATE "generation_jobs"
             SET "state" = ${to}::"GenerationJobState",
                 "stateVersion" = "stateVersion" + 1,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${id}
             AND "state" = ${from}::"GenerationJobState"
           RETURNING "id"
        `
      : await tx.$queryRaw<{ id: string }[]>`
          UPDATE "generation_scenes"
             SET "state" = ${to}::"GenerationSceneState",
                 "stateVersion" = "stateVersion" + 1,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${id}
             AND "state" = ${from}::"GenerationSceneState"
           RETURNING "id"
        `;
  if (rows.length !== 1) throw new MediaFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
}

/** Resolve the work row inside the settlement's own commit. Never afterwards. */
async function resolveWorkWithin(
  tx: Tx,
  claim: MediaFailureResolutionClaim,
  kind: "INITIAL_FAILURE_SETTLED" | "USER_REGENERATION_ROLLED_BACK",
  at: Date,
): Promise<void> {
  const { count } = await tx.managedOutputMediaFailureResolution.updateMany({
    where: {
      id: claim.workId,
      version: claim.version,
      status: "RUNNING",
      leaseToken: claim.leaseToken,
    },
    data: {
      status: "RESOLVED",
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      resolutionKind: kind,
      resolvedAt: at,
      version: { increment: 1 },
    },
  });
  if (count !== 1) throw new MediaFailureSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
}

/** The settlement's own reason code, without rewriting anything else the caller set. */
function withReason<T extends { readonly reasonCode: string | null }>(
  context: T,
  reasonCode: string,
): T {
  return { ...context, reasonCode };
}
