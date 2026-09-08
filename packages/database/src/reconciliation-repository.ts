import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isCoherentAttemptRecord,
  type ApplyReconciliationResult,
  type EpochMillis,
  type GenerationAttemptState,
  type ReconciliationCandidate,
  type ReconciliationFacts,
  type ReconciliationRepository,
  type ReconciliationReservationFacts,
  type ReconciliationSession,
  type ReconcilingAttemptFacts,
  type SceneGenerationRequestKind,
  validateReconciliationMaintenanceLimit,
  type SubmissionCertainty,
} from "@app/domain";
import { AppError } from "@app/shared";
import { appendGenerationEvent } from "./orchestration-repositories";

/**
 * Persistence for ending an attempt's uncertainty.
 *
 * One transaction moves the attempt, moves the customer's suspended hold if the
 * conclusion calls for it, and appends the events that say so. Apart or out of
 * order, a crash between them could leave a released reservation with an attempt
 * still claiming to be reconciling, or an accepted attempt whose customer never
 * got their unit back.
 *
 * There is no provider client here and no HTTP. This module writes down
 * conclusions that were reached elsewhere.
 */

type Tx = Prisma.TransactionClient;

const MS = (value: Date | null): EpochMillis | null =>
  value === null ? null : (value.getTime() as EpochMillis);

/**
 * The tenant predicate for an attempt, carried into every mutation.
 *
 * Two clauses that must agree, because this phase relies on both. The first is
 * the direct denormalized `videoProjectId` the standard orchestration attempt
 * repository scopes on; the second is the ownership chain
 * `Attempt → Request → Scene → Job → VideoProject` that every read in this file
 * traverses — the reservation lock, the billing-cycle lookup and the
 * authoritative attempt read all join through it.
 *
 * Requiring both means a row whose denormalized project disagrees with its
 * chain refuses the write instead of being mutated under a tenancy that only
 * half of it supports. It also excludes an attempt with no parent request at
 * all: a legacy row that predates the orchestration chain is not reconcilable,
 * and silently treating it as this tenant's would be a guess.
 */
const attemptScope = (organizationId: string) => ({
  videoProject: { organizationId },
  generationSceneRequest: {
    generationScene: { generationJob: { videoProject: { organizationId } } },
  },
});

/** The same ownership chain, from the reservation side. */
const reservationScope = (organizationId: string) => ({
  generationJob: { videoProject: { organizationId } },
});

/**
 * The cost-admission lock, taken first, with the key Phase 4C-3B-2F-1 chose.
 *
 * Reconciliation moves an organization's cycle exposure in both directions — a
 * resolved acceptance turns uncertain cost into in-flight cost, a definitive
 * rejection removes it entirely — so an authorization reading exposure while a
 * conclusion lands would decide on a total that is mid-flight. Sharing the key
 * makes the two serialize on the cycle they both account for.
 *
 * It is also what keeps all three phases free of deadlock. 2F-1 takes
 * `advisory → reservation → attempt CAS`; 2G-1 takes the same three; this takes
 * the same three. One order, no cycle.
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

/**
 * Lock this attempt's reservation for the whole transaction.
 *
 * `FOR UPDATE`, because a conclusion may restore or release the hold. Same
 * acquisition point and same order as the two phases before it, differing only
 * in mode where they read and this may write.
 *
 * `null` when the job has no reservation. An anomaly, and explicitly not a
 * refusal: after the provider boundary, provider reality must be recorded
 * whether or not the entitlement bookkeeping is intact.
 */
async function lockReservationForAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<ReconciliationReservationFacts | null> {
  const rows = await tx.$queryRaw<{ id: string; state: string; stateVersion: number }[]>`
    SELECT res."id", res."state"::text AS "state", res."stateVersion"
      FROM "scene_generations" a
      JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
      JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
      JOIN "generation_jobs" j ON j."id" = s."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
      JOIN "generation_reservations" res ON res."generationJobId" = j."id"
     WHERE a."id" = ${attemptId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    state: row.state as ReconciliationReservationFacts["state"],
    stateVersion: row.stateVersion,
  };
}

interface AttemptRow {
  attemptId: string;
  orchestrationState: GenerationAttemptState | null;
  submissionCertainty: string | null;
  stateVersion: number;
  submissionBoundaryEnteredAt: Date | null;
  providerPredictionId: string | null;
  reconciliationStartedAt: Date | null;
  reconciliationDeadlineAt: Date | null;
  reconciliationResolvedAt: Date | null;
  requestKind: SceneGenerationRequestKind | null;
}

/**
 * How many *other* attempts in this attempt's Job are still durably unknown.
 *
 * The reservation is Job-scoped; an attempt is scene-scoped. Several scenes in
 * one Job can be at the provider boundary at once, so several attempts can be
 * `RECONCILIATION_PENDING + SUBMISSION_UNKNOWN` behind a single suspended hold.
 * Restoring that hold when the first of them resolves would lift a Job-level
 * suspension while the Job is still uncertain.
 *
 * Counted here, inside the transaction and after the organization+cycle advisory
 * lock, so it is authoritative for this decision: any concurrent conclusion on a
 * sibling is serialized behind the same lock and therefore either already
 * committed and visible, or still waiting and counted.
 *
 * Tenant-scoped like every other read, and derived through the persisted chain
 * rather than the denormalized project column, so a sibling is only a sibling if
 * it genuinely shares this attempt's Job.
 */
async function countOtherPendingUnknownAttemptsInJob(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS "count"
      FROM "scene_generations" sibling
      JOIN "scene_generation_requests" sr ON sr."id" = sibling."generationSceneRequestId"
      JOIN "generation_scenes" ss ON ss."id" = sr."generationSceneId"
     WHERE ss."generationJobId" = (
             SELECT s."generationJobId"
               FROM "scene_generations" a
               JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
               JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
               JOIN "generation_jobs" j ON j."id" = s."generationJobId"
               JOIN "video_projects" p ON p."id" = j."videoProjectId"
              WHERE a."id" = ${attemptId}
                AND p."organizationId" = ${organizationId}
           )
       AND sibling."id" <> ${attemptId}
       AND sibling."orchestrationState" = 'RECONCILIATION_PENDING'::"GenerationAttemptState"
       AND sibling."submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty"
  `;
  return Number(rows[0]?.count ?? 0n);
}

/** The attempt, tenant-scoped through its own chain. */
async function loadAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT a."id"                          AS "attemptId",
           a."orchestrationState"::text    AS "orchestrationState",
           a."submissionCertainty"::text   AS "submissionCertainty",
           a."stateVersion"                AS "stateVersion",
           a."submissionBoundaryEnteredAt" AS "submissionBoundaryEnteredAt",
           a."providerPredictionId"        AS "providerPredictionId",
           a."reconciliationStartedAt"     AS "reconciliationStartedAt",
           a."reconciliationDeadlineAt"    AS "reconciliationDeadlineAt",
           a."reconciliationResolvedAt"    AS "reconciliationResolvedAt",
           r."kind"::text                  AS "requestKind"
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

export function createReconciliationRepository(
  prisma: PrismaClient,
): ReconciliationRepository {
  return {
    async withReconcilingAttempt(input, run) {
      return prisma.$transaction(async (tx) => {
        // The cycle decides only *which* advisory lock to take, and a
        // reservation's cycle is immutable once written, so reading it before
        // the lock is safe.
        const cycleKey = await billingCycleKeyForAttempt(
          tx,
          input.organizationId,
          input.attemptId,
        );
        await acquireCostAdmissionLock(tx, input.organizationId, cycleKey ?? "unreserved");
        const reservation = await lockReservationForAttempt(
          tx,
          input.organizationId,
          input.attemptId,
        );

        const session: ReconciliationSession = {
          async loadFacts(): Promise<ReconciliationFacts | null> {
            const row = await loadAttempt(tx, input.organizationId, input.attemptId);
            // Missing, cross-tenant, or a legacy row predating the axis.
            if (row === null || row.orchestrationState === null) return null;
            if (row.requestKind === null) return null;

            const attempt: ReconcilingAttemptFacts = {
              attemptId: row.attemptId,
              orchestrationState: row.orchestrationState,
              submissionCertainty: (row.submissionCertainty ??
                "PRE_SUBMISSION") as SubmissionCertainty,
              stateVersion: row.stateVersion,
              submissionBoundaryEnteredAt: MS(row.submissionBoundaryEnteredAt),
              providerPredictionId: row.providerPredictionId,
              reconciliationStartedAt: MS(row.reconciliationStartedAt),
              reconciliationDeadlineAt: MS(row.reconciliationDeadlineAt),
              reconciliationResolvedAt: MS(row.reconciliationResolvedAt),
            };
            return {
              attempt,
              reservation,
              requestKind: row.requestKind,
              otherPendingUnknownAttemptsInJob: await countOtherPendingUnknownAttemptsInJob(
                tx,
                input.organizationId,
                input.attemptId,
              ),
            };
          },

          async apply({
            expectedVersion,
            write,
            context,
            reservationEventType,
          }): Promise<ApplyReconciliationResult> {
            // Defence in depth over the domain: the pairing is a database CHECK
            // as well, and a write that would violate it is a defect worth
            // failing loudly on rather than reading back as a constraint error.
            if (
              !isCoherentAttemptRecord({
                certainty: write.submissionCertainty,
                state: write.orchestrationState,
                providerPredictionId: write.providerPredictionId,
              })
            ) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Refusing to persist an incoherent reconciliation outcome",
              );
            }

            const { count } = await tx.sceneGeneration.updateMany({
              where: {
                id: input.attemptId,
                // Tenancy, in the same statement as the compare-and-set.
                //
                // Not merely defence in depth: `apply` is reachable without
                // `loadFacts`, and the tenant-scoped read is the *only* other
                // place the organization was checked. A caller holding a
                // session for its own organization could otherwise name another
                // tenant's attempt id and mutate that row, appending an event
                // labelled with its own organization. Proving it here rather
                // than earlier also closes the check-then-act window between
                // the read and the write.
                ...attemptScope(input.organizationId),
                // The uncertain state and the version together. Anything else
                // means another writer ended this uncertainty first.
                orchestrationState: "RECONCILIATION_PENDING",
                submissionCertainty: "SUBMISSION_UNKNOWN",
                stateVersion: expectedVersion,
              },
              data: {
                orchestrationState: write.orchestrationState,
                submissionCertainty: write.submissionCertainty,
                stateVersion: { increment: 1 },
                providerPredictionId: write.providerPredictionId,
                providerAcceptedAt:
                  write.providerAcceptedAt === null
                    ? null
                    : new Date(write.providerAcceptedAt),
                reconciliationResolvedAt:
                  write.reconciliationResolvedAt === null
                    ? null
                    : new Date(write.reconciliationResolvedAt),
                // `submissionBoundaryEnteredAt`, `reconciliationStartedAt`,
                // `reconciliationDeadlineAt` and `normalizedErrorCode` are
                // deliberately absent. They are the history of how this attempt
                // became uncertain, and a conclusion is a later fact rather than
                // a licence to rewrite it.
              },
            });
            if (count === 0) return { kind: "LOST" };

            // The entitlement move, in the same commit. Only a suspended hold
            // moves: a CONSUMED unit stays spent, a RELEASED one stays gone, and
            // a RESERVED one is already where a restore would put it. The
            // decision made that call from the state read under this lock.
            //
            // `KEEP_HOLD` is deliberately excluded alongside `NONE`. It means
            // the hold is correct where it is and stays there because a sibling
            // attempt in the same Job is still unknown — nothing transitions, so
            // nothing is written and no event is appended. The reason is on the
            // attempt's own event instead, as `remainingPendingUnknownAttempts`.
            if (
              (write.reservationAction === "RESTORE" ||
                write.reservationAction === "RELEASE") &&
              reservation !== null &&
              reservation.state === "RECONCILIATION_HOLD"
            ) {
              const nextState =
                write.reservationAction === "RESTORE" ? "RESERVED" : "RELEASED";
              const moved = await tx.generationReservation.updateMany({
                where: {
                  id: reservation.id,
                  // Tenancy again at the mutation, for the same reason. This
                  // row was read tenant-scoped under the lock, so the clause is
                  // redundant today — and it is the clause that stays correct
                  // if a later caller ever supplies the reservation itself.
                  ...reservationScope(input.organizationId),
                  state: "RECONCILIATION_HOLD",
                  stateVersion: reservation.stateVersion,
                },
                data: {
                  state: nextState,
                  stateVersion: { increment: 1 },
                  // The decision's own instant, not a fresh wall-clock read.
                  // A second read here would stamp the customer's release with
                  // a time no lock was held for, and would drift from the
                  // `reconciliationResolvedAt` written by the same decision.
                  ...(nextState === "RELEASED"
                    ? { releasedAt: new Date(write.decisionAt) }
                    : {}),
                },
              });
              if (moved.count === 0) {
                // Held `FOR UPDATE` for this whole transaction, so nothing else
                // can have moved it. A zero means the facts read under the lock
                // disagree with the row — a defect, not a race.
                throw new AppError(
                  "INTERNAL_ERROR",
                  "Reservation moved while held under FOR UPDATE",
                );
              }
              if (reservationEventType === null) {
                // A move without a label is a defect, not a state to tolerate:
                // an unlabelled entitlement transition is invisible to every
                // audit query that selects on event type.
                throw new AppError(
                  "INTERNAL_ERROR",
                  "Refusing to move a reservation without a transition label",
                );
              }
              await appendGenerationEvent(tx, {
                organizationId: input.organizationId,
                aggregateType: "RESERVATION",
                aggregateId: reservation.id,
                fromState: "RECONCILIATION_HOLD",
                toState: nextState,
                context: { ...context, eventType: reservationEventType },
              });
            }

            await appendGenerationEvent(tx, {
              organizationId: input.organizationId,
              aggregateType: "ATTEMPT",
              aggregateId: input.attemptId,
              fromState: "RECONCILIATION_PENDING",
              toState: write.orchestrationState,
              context,
            });

            const row = await tx.sceneGeneration.findFirst({
              // Scoped like every other access to this row. An unscoped read
              // here would be a cross-tenant disclosure of a version number,
              // small but free to avoid.
              where: { id: input.attemptId, ...attemptScope(input.organizationId) },
              select: { stateVersion: true },
            });
            if (row === null) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Attempt vanished inside its own reconciliation transaction",
              );
            }
            return { kind: "APPLIED", stateVersion: row.stateVersion };
          },
        };

        return run(session);
      });
    },

    async findDueReconciliationCandidates({ cutoff, limit: requested }) {
      // Validated here as well as in the batch runner, because this method is
      // public: a caller reaching it directly must not be able to put
      // `Infinity`, a fraction or 5000 into a SQL LIMIT. One canonical
      // validator, so the two boundaries cannot disagree about the bound.
      const limit = validateReconciliationMaintenanceLimit(requested);
      // No lock, no transaction, identifiers only. Everything needed to *decide*
      // is deliberately absent, so a caller cannot mistake this for authority
      // and act on a row without the single-attempt service re-checking it.
      return prisma.$queryRaw<ReconciliationCandidate[]>`
        SELECT p."organizationId" AS "organizationId",
               a."id"             AS "attemptId"
          FROM "scene_generations" a
          JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j ON j."id" = s."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE a."orchestrationState" = 'RECONCILIATION_PENDING'::"GenerationAttemptState"
           AND a."submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty"
           AND a."reconciliationDeadlineAt" IS NOT NULL
           AND a."reconciliationDeadlineAt" <= ${new Date(cutoff)}
         ORDER BY a."reconciliationDeadlineAt" ASC, a."id" ASC
         LIMIT ${limit}
      `;
    },

    async findStaleSubmittingCandidates({ cutoff, limit: requested }) {
      const limit = validateReconciliationMaintenanceLimit(requested);
      // The cutoff already encodes the caller's validated stale threshold, so
      // no threshold is recomputed — or invented — here. Phase 2G-1's service
      // still judges each row against its own post-lock clock and policy.
      return prisma.$queryRaw<ReconciliationCandidate[]>`
        SELECT p."organizationId" AS "organizationId",
               a."id"             AS "attemptId"
          FROM "scene_generations" a
          JOIN "scene_generation_requests" r ON r."id" = a."generationSceneRequestId"
          JOIN "generation_scenes" s ON s."id" = r."generationSceneId"
          JOIN "generation_jobs" j ON j."id" = s."generationJobId"
          JOIN "video_projects" p ON p."id" = j."videoProjectId"
         WHERE a."orchestrationState" = 'SUBMITTING'::"GenerationAttemptState"
           AND a."submissionCertainty" = 'PRE_SUBMISSION'::"SubmissionCertainty"
           AND a."submissionBoundaryEnteredAt" IS NOT NULL
           AND a."submissionBoundaryEnteredAt" <= ${new Date(cutoff)}
         ORDER BY a."submissionBoundaryEnteredAt" ASC, a."id" ASC
         LIMIT ${limit}
      `;
    },
  };
}
