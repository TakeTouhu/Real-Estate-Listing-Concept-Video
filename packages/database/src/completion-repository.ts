import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isCoherentAttemptRecord,
  validateReconciliationMaintenanceLimit,
  type CompletingAttemptFacts,
  type CompletionCandidate,
  type CompletionFacts,
  type CompletionRepository,
  type CompletionSession,
  type EpochMillis,
  type GenerationAttemptState,
  type SafePositiveByteCount,
  type Sha256Digest,
  type SubmissionCertainty,
} from "@app/domain";
import { AppError } from "@app/shared";
import { appendGenerationEvent } from "./orchestration-repositories";

/**
 * Persistence for provider completion and managed output verification.
 *
 * One transaction moves the attempt's execution state and appends the event that
 * says so. **No reservation is read, locked or written on any path** — nothing in
 * this phase touches customer entitlement, and the absence is structural rather
 * than a convention: there is no reservation handle in this file to misuse.
 *
 * There is no provider client here, no HTTP and no object storage. This module
 * writes down conclusions reached elsewhere.
 */

type Tx = Prisma.TransactionClient;

const MS = (value: Date | null): EpochMillis | null =>
  value === null ? null : (value.getTime() as EpochMillis);

/**
 * The tenant predicate, carried into every mutation.
 *
 * Identical in shape to the discipline frozen in Phases 2G-1 and 2G-2, and for
 * the same reason: `applyCompletion` and its siblings are reachable without
 * `loadFacts`, so a tenant-scoped read is an optional boundary rather than a
 * real one. Both clauses must hold — the denormalized `videoProjectId` the
 * standard attempt repository scopes on, and the ownership chain every read here
 * traverses — so a row whose two disagree is frozen rather than writable by
 * whichever tenant a corruption favours.
 */
const attemptScope = (organizationId: string) => ({
  videoProject: { organizationId },
  generationSceneRequest: {
    generationScene: { generationJob: { videoProject: { organizationId } } },
  },
});

/**
 * The cost-admission lock, with the key Phase 4C-3B-2F-1 chose.
 *
 * Taken even though no entitlement moves here, because provider completion does
 * move an organization's cycle exposure: `PROCESSING` and `PROVIDER_SUCCEEDED`
 * are in-flight, `FAILED_* + ACCEPTED` is settled estimate. An authorization
 * reading exposure while a completion lands would decide on a total that is
 * mid-flight.
 *
 * Same key and same acquisition point as the three phases before it, so the four
 * share one lock order and cannot deadlock against each other.
 */
async function acquireCostAdmissionLock(
  tx: Tx,
  organizationId: string,
  billingCycleKey: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`paid-submission:${organizationId}`}),
      hashtext(${`cycle:${billingCycleKey}`})
    )::text AS locked
  `;
}

/** The cycle this attempt's cost is attributed to, from its own reservation. */
async function billingCycleKeyForAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
  `;
  return rows[0]?.billingCycleKey ?? null;
}

interface AttemptRow {
  attemptId: string;
  orchestrationState: GenerationAttemptState | null;
  submissionCertainty: string | null;
  stateVersion: number;
  providerPredictionId: string | null;
  providerAcceptedAt: Date | null;
  outputStorageKey: string | null;
  outputSha256: string | null;
  outputSizeBytes: bigint | null;
  outputVerifiedAt: Date | null;
}

/** The attempt, tenant-scoped through its own chain. */
async function loadAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT a."id"                       AS "attemptId",
           a."orchestrationState"::text AS "orchestrationState",
           a."submissionCertainty"::text AS "submissionCertainty",
           a."stateVersion"             AS "stateVersion",
           a."providerPredictionId"     AS "providerPredictionId",
           a."providerAcceptedAt"       AS "providerAcceptedAt",
           a."outputStorageKey"         AS "outputStorageKey",
           a."outputSha256"             AS "outputSha256",
           a."outputSizeBytes"          AS "outputSizeBytes",
           a."outputVerifiedAt"         AS "outputVerifiedAt"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
  `;
  return rows[0] ?? null;
}

/** The candidate query's state pair, chosen by the caller's stage. */
const STAGE_STATE: Record<string, GenerationAttemptState> = {
  AWAITING_PROVIDER_COMPLETION: "PROCESSING",
  AWAITING_OUTPUT_INGESTION: "PROVIDER_SUCCEEDED",
  RESUMABLE_OUTPUT_INGESTION: "OUTPUT_INGESTING",
};

export function createCompletionRepository(prisma: PrismaClient): CompletionRepository {
  return {
    async withCompletingAttempt(input, run) {
      return prisma.$transaction(async (tx) => {
        // The cycle decides only *which* advisory lock to take, and a
        // reservation's cycle is immutable once written, so reading it before
        // the lock is safe. The reservation itself is never locked or written.
        const cycleKey = await billingCycleKeyForAttempt(
          tx,
          input.organizationId,
          input.attemptId,
        );
        await acquireCostAdmissionLock(tx, input.organizationId, cycleKey ?? "unreserved");

        /** Every mutation shares this predicate. Tenancy, state and version. */
        const casWhere = (
          expectedState: GenerationAttemptState,
          expectedVersion: number,
        ): Prisma.SceneGenerationWhereInput => ({
          id: input.attemptId,
          ...attemptScope(input.organizationId),
          orchestrationState: expectedState,
          submissionCertainty: "ACCEPTED",
          stateVersion: expectedVersion,
        });

        /** The committed version, read back tenant-scoped like everything else. */
        const committedVersion = async (): Promise<number> => {
          const row = await tx.sceneGeneration.findFirst({
            where: { id: input.attemptId, ...attemptScope(input.organizationId) },
            select: { stateVersion: true },
          });
          if (row === null) {
            throw new AppError(
              "INTERNAL_ERROR",
              "Attempt vanished inside its own completion transaction",
            );
          }
          return row.stateVersion;
        };

        const session: CompletionSession = {
          async loadFacts(): Promise<CompletionFacts | null> {
            const row = await loadAttempt(tx, input.organizationId, input.attemptId);
            // Missing, cross-tenant, or a legacy row predating orchestration.
            // A legacy row is deliberately not reinterpreted: its `state` may
            // say SUCCEEDED under the older vocabulary, and treating that as
            // PROVIDER_SUCCEEDED would invent an orchestration history.
            if (row === null || row.orchestrationState === null) return null;

            const attempt: CompletingAttemptFacts = {
              attemptId: row.attemptId,
              orchestrationState: row.orchestrationState,
              submissionCertainty: (row.submissionCertainty ??
                "PRE_SUBMISSION") as SubmissionCertainty,
              stateVersion: row.stateVersion,
              providerPredictionId: row.providerPredictionId,
              providerAcceptedAt: MS(row.providerAcceptedAt),
              outputStorageKey: row.outputStorageKey,
              outputSha256: row.outputSha256 as Sha256Digest | null,
              // Safe: only positive safe integers are ever written, and the
              // column's CHECK forbids anything else.
              outputSizeBytes:
                row.outputSizeBytes === null
                  ? null
                  : (Number(row.outputSizeBytes) as SafePositiveByteCount),
              outputVerifiedAt: MS(row.outputVerifiedAt),
            };
            return { attempt };
          },

          async applyCompletion({ expectedVersion, write, context }) {
            // Defence in depth over the domain: the pairing is a database CHECK
            // as well, and a write that would violate it is a defect worth
            // failing loudly on rather than reading back as a constraint error.
            if (
              !isCoherentAttemptRecord({
                certainty: "ACCEPTED",
                state: write.orchestrationState,
                // Unchanged by this phase, and required non-null by the
                // precondition that got us here.
                providerPredictionId: "unchanged",
              })
            ) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Refusing to persist an incoherent provider completion",
              );
            }

            const { count } = await tx.sceneGeneration.updateMany({
              where: casWhere("PROCESSING", expectedVersion),
              data: {
                orchestrationState: write.orchestrationState,
                stateVersion: { increment: 1 },
                // `submissionCertainty`, `providerPredictionId` and
                // `providerAcceptedAt` are deliberately absent. The provider
                // accepted this work; an execution failure afterwards does not
                // revise that, and the Safety Guard reads it to know the money
                // was spent.
              },
            });
            if (count === 0) return { kind: "LOST" };

            await appendGenerationEvent(tx, {
              organizationId: input.organizationId,
              aggregateType: "ATTEMPT",
              aggregateId: input.attemptId,
              fromState: "PROCESSING",
              toState: write.orchestrationState,
              context,
            });
            return { kind: "APPLIED", stateVersion: await committedVersion() };
          },

          async applyBeginIngestion({ expectedVersion, context }) {
            const { count } = await tx.sceneGeneration.updateMany({
              where: casWhere("PROVIDER_SUCCEEDED", expectedVersion),
              data: {
                orchestrationState: "OUTPUT_INGESTING",
                stateVersion: { increment: 1 },
              },
            });
            if (count === 0) return { kind: "LOST" };

            await appendGenerationEvent(tx, {
              organizationId: input.organizationId,
              aggregateType: "ATTEMPT",
              aggregateId: input.attemptId,
              fromState: "PROVIDER_SUCCEEDED",
              toState: "OUTPUT_INGESTING",
              context,
            });
            return { kind: "APPLIED", stateVersion: await committedVersion() };
          },

          async applyOutputVerification({ expectedVersion, write, context }) {
            const { count } = await tx.sceneGeneration.updateMany({
              where: casWhere("OUTPUT_INGESTING", expectedVersion),
              data: {
                orchestrationState: "OUTPUT_VERIFIED",
                stateVersion: { increment: 1 },
                outputStorageKey: write.outputStorageKey,
                outputSha256: write.outputSha256,
                outputSizeBytes: BigInt(write.outputSizeBytes),
                // The decision's own instant, not a fresh wall-clock read. A
                // second read here would stamp the verification with a time no
                // lock was held for.
                outputVerifiedAt: new Date(write.outputVerifiedAt),
              },
            });
            if (count === 0) return { kind: "LOST" };

            await appendGenerationEvent(tx, {
              organizationId: input.organizationId,
              aggregateType: "ATTEMPT",
              aggregateId: input.attemptId,
              fromState: "OUTPUT_INGESTING",
              toState: "OUTPUT_VERIFIED",
              context,
            });
            return { kind: "APPLIED", stateVersion: await committedVersion() };
          },
        };

        return run(session);
      });
    },

    async findCompletionCandidates({ stage, limit: requested }) {
      // Validated here as well as in any future runner, because this method is
      // public: a caller reaching it directly must not be able to put
      // `Infinity`, a fraction or 5000 into a SQL LIMIT. The canonical validator
      // is Phase 2G-2's, reused rather than restated — two bound rules is how a
      // limit one boundary rejects reaches the database through the other.
      const limit = validateReconciliationMaintenanceLimit(requested);
      const state = STAGE_STATE[stage];
      if (state === undefined) {
        throw new AppError("VALIDATION_FAILED", `Unknown completion candidate stage: ${stage}`);
      }
      // No lock, no transaction, identifiers only. Everything needed to *decide*
      // is deliberately absent — no provider reference, no prompt, no output
      // location — so a caller cannot mistake this for authority and act on a
      // row without the single-attempt service re-checking it.
      return prisma.$queryRaw<CompletionCandidate[]>`
        SELECT p."organizationId" AS "organizationId",
               a."id"             AS "attemptId"
          FROM "scene_generations" a
          JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j ON j."id" = s."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE a."orchestrationState" = ${state}::"GenerationAttemptState"
           AND a."submissionCertainty" = 'ACCEPTED'::"SubmissionCertainty"
         ORDER BY a."id" ASC
         LIMIT ${limit}
      `;
    },
  };
}
