import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isCoherentAttemptRecord,
  type ApplyOutcomeResult,
  type AttemptSubmissionFacts,
  type EpochMillis,
  type GenerationAttemptState,
  type ReservationOutcomeFacts,
  type SubmissionOutcomeFacts,
  type SubmissionOutcomeRepository,
  type SubmissionOutcomeSession,
  type SubmissionCertainty,
} from "@app/domain";
import { AppError } from "@app/shared";
import { appendGenerationEvent } from "./orchestration-repositories";

/**
 * Persistence for submission outcomes.
 *
 * One transaction records what a provider did, moves the reservation if
 * uncertainty demands it, and appends the event that says so. Apart or out of
 * order, a crash between them leaves the platform believing a provider call
 * never happened when it may already have been billed.
 *
 * There is no provider client here and no HTTP. This module writes down news
 * that has already been observed; it never goes and asks.
 */

type Tx = Prisma.TransactionClient;

const MS = (value: Date | null): EpochMillis | null =>
  value === null ? null : (value.getTime() as EpochMillis);

/**
 * The cost-admission lock, taken first and for the same reason Phase
 * 4C-3B-2F-1 takes it.
 *
 * Recording uncertainty changes an organization's cycle exposure — an attempt
 * entering `RECONCILIATION_PENDING` starts counting against the Safety Guard —
 * so an authorization reading exposure while an outcome lands would decide on a
 * total that is mid-flight. Taking the same advisory lock makes the two
 * operations serialize on the cycle they share.
 *
 * It is also what keeps the two free of deadlock. Phase 2F-1 takes
 * `advisory → reservation → attempt CAS`; this takes the same three in the same
 * order, differing only in acquiring the reservation `FOR UPDATE` because it may
 * modify it. Same order, stronger mode, no cycle.
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
 * `FOR UPDATE`, not `FOR SHARE`: uncertainty entry may move `RESERVED` to
 * `RECONCILIATION_HOLD`, so this is a writer, and it takes the mode it will
 * need at the single ordered point where it takes it.
 *
 * The write itself would be serialized either way — the later `UPDATE` acquires
 * an exclusive row lock and waits for any shared holder, so a `FOR SHARE` here
 * does not lose the reservation transition, and the mutation ledger records
 * exactly that. What `FOR UPDATE` avoids is the *upgrade*: acquiring shared and
 * later escalating to exclusive is the classic shape in which two transactions
 * holding the same shared lock deadlock, each waiting for the other to release
 * it. Taking the stronger mode first removes that shape entirely rather than
 * relying on nothing else ever holding the row shared.
 *
 * Returns `null` when the job has no reservation. That is an anomaly, and it is
 * explicitly **not** a reason to refuse: provider reality after the paid
 * boundary must be recorded whether or not the entitlement bookkeeping is
 * intact. Losing the fact that a provider took work, because a reservation row
 * is missing, would be the more expensive mistake by far.
 */
async function lockReservationForAttempt(
  tx: Tx,
  organizationId: string,
  attemptId: string,
): Promise<ReservationOutcomeFacts | null> {
  const rows = await tx.$queryRaw<
    { id: string; state: string; stateVersion: number }[]
  >`
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
    state: row.state as ReservationOutcomeFacts["state"],
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
           a."reconciliationDeadlineAt"    AS "reconciliationDeadlineAt"
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

export function createSubmissionOutcomeRepository(
  prisma: PrismaClient,
): SubmissionOutcomeRepository {
  return {
    async withAttemptOutcome(input, run) {
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

        const session: SubmissionOutcomeSession = {
          async loadFacts(): Promise<SubmissionOutcomeFacts | null> {
            const row = await loadAttempt(tx, input.organizationId, input.attemptId);
            // Missing, cross-tenant, or a legacy row that predates the
            // orchestration axis entirely.
            if (row === null || row.orchestrationState === null) return null;

            const attempt: AttemptSubmissionFacts = {
              attemptId: row.attemptId,
              orchestrationState: row.orchestrationState,
              submissionCertainty: (row.submissionCertainty ??
                "PRE_SUBMISSION") as SubmissionCertainty,
              stateVersion: row.stateVersion,
              submissionBoundaryEnteredAt: MS(row.submissionBoundaryEnteredAt),
              providerPredictionId: row.providerPredictionId,
              reconciliationStartedAt: MS(row.reconciliationStartedAt),
              reconciliationDeadlineAt: MS(row.reconciliationDeadlineAt),
            };
            return { attempt, reservation };
          },

          async apply({ expectedVersion, write, context }): Promise<ApplyOutcomeResult> {
            // Defence in depth over the domain: the pairing of certainty,
            // state and provider reference is a database CHECK as well, and a
            // write that would violate it is a defect worth failing loudly on
            // rather than letting the constraint report it as an opaque error.
            if (
              !isCoherentAttemptRecord({
                certainty: write.submissionCertainty,
                state: write.orchestrationState,
                providerPredictionId: write.providerPredictionId,
              })
            ) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Refusing to persist an incoherent submission outcome",
              );
            }

            const { count } = await tx.sceneGeneration.updateMany({
              where: {
                id: input.attemptId,
                // The boundary state and the version together. Anything else
                // means another writer resolved this attempt first.
                orchestrationState: "SUBMITTING",
                submissionCertainty: "PRE_SUBMISSION",
                stateVersion: expectedVersion,
              },
              data: {
                orchestrationState: write.orchestrationState,
                submissionCertainty: write.submissionCertainty,
                stateVersion: { increment: 1 },
                providerPredictionId: write.providerPredictionId,
                normalizedErrorCode: write.normalizedErrorCode,
                providerAcceptedAt:
                  write.providerAcceptedAt === null
                    ? null
                    : new Date(write.providerAcceptedAt),
                reconciliationStartedAt:
                  write.reconciliationStartedAt === null
                    ? null
                    : new Date(write.reconciliationStartedAt),
                reconciliationDeadlineAt:
                  write.reconciliationDeadlineAt === null
                    ? null
                    : new Date(write.reconciliationDeadlineAt),
              },
            });
            if (count === 0) return { kind: "LOST" };

            // The entitlement hold, in the same commit. Only `RESERVED` moves:
            // `CONSUMED` is a delivered video's spent unit and stays spent —
            // suspending it would re-open an entitlement the customer already
            // used — and `RELEASED` is gone. `RECONCILIATION_HOLD` is already
            // where this would put it.
            if (
              write.holdReservation &&
              reservation !== null &&
              reservation.state === "RESERVED"
            ) {
              const moved = await tx.generationReservation.updateMany({
                where: {
                  id: reservation.id,
                  state: "RESERVED",
                  stateVersion: reservation.stateVersion,
                },
                data: {
                  state: "RECONCILIATION_HOLD",
                  stateVersion: { increment: 1 },
                },
              });
              if (moved.count === 0) {
                // The row was locked `FOR UPDATE` for this whole transaction,
                // so nothing else can have moved it. A zero here means the
                // facts read under the lock disagree with the row, which is a
                // defect rather than a race.
                throw new AppError(
                  "INTERNAL_ERROR",
                  "Reservation moved while held under FOR UPDATE",
                );
              }
              await appendGenerationEvent(tx, {
                organizationId: input.organizationId,
                aggregateType: "RESERVATION",
                aggregateId: reservation.id,
                fromState: "RESERVED",
                toState: "RECONCILIATION_HOLD",
                context,
              });
            }

            await appendGenerationEvent(tx, {
              organizationId: input.organizationId,
              aggregateType: "ATTEMPT",
              aggregateId: input.attemptId,
              fromState: "SUBMITTING",
              toState: write.orchestrationState,
              context,
            });

            const row = await tx.sceneGeneration.findFirst({
              where: { id: input.attemptId },
              select: { stateVersion: true },
            });
            if (row === null) {
              throw new AppError(
                "INTERNAL_ERROR",
                "Attempt vanished inside its own outcome transaction",
              );
            }
            return { kind: "APPLIED", stateVersion: row.stateVersion };
          },
        };

        return run(session);
      });
    },
  };
}
