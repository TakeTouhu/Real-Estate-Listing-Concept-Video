/**
 * Settling a failed deliverable cycle inside the commit that records the failure
 * (ADR-0082).
 *
 * Two writers record that a deliverable cycle produced no usable video: the
 * composition block (`deliverable-composition-execution-repository.ts`) and the
 * terminal non-`VALID` verdicts (`deliverable-validation-repository.ts`). Both
 * call this module from inside their own transaction, after writing their
 * terminal row, so the failure and its settlement commit together or not at all.
 * There is no later sweep to forget, and no window in which a failed job still
 * holds the customer's Unit. Transaction G calls it too, in place of a
 * publication, when the job's Property was deleted before its first video was
 * published (ADR-0103): the same writes, with that cause on the events.
 *
 * The decision itself is the domain's (`settleFailedDeliverable`); this module
 * only reads the locked rows into it and writes what it answers.
 *
 * ## Lock order
 *
 * ```text
 * cost-admission advisory lock -> GenerationReservation -> GenerationJob -> version -> work rows
 * ```
 *
 * The order every entitlement release takes (`cost-admission-lock.ts`), as the
 * media failure settlement (Transaction H) does, and whose **Reservation before
 * Job** part Transaction I takes too. A caller takes both with
 * {@link lockReservationForDeliverable} *first*, then locks its own chain, and
 * only then calls {@link settleDeliverableFailure}. Transaction G takes them
 * through its own reservation read, which it needs whole, in the same order.
 */

import {
  DeliverableSettlementDefect,
  GENERATION_JOB_STATES,
  GENERATION_RESERVATION_STATES,
  RESERVATION_RELEASED_EVENT_TYPE,
  deliverableSettlementRecord,
  isDeliverableFailureSettled,
  settleFailedDeliverable,
  type DeliverableFailureCause,
  type FailedDeliverableCycleState,
  type GenerationJobState,
  type GenerationReservationState,
  type TransitionContext,
} from "@app/domain";
import type { PrismaClient } from "@prisma/client";
import { acquireCostAdmissionLock } from "./cost-admission-lock";
import { appendGenerationEvent } from "./orchestration-repositories";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** The job's reservation, read under its own lock. */
export interface SettlementReservationRow {
  readonly reservationId: string;
  readonly reservationState: string;
}

/** The failed cycle's job, as the caller read it under the job lock. */
export interface FailedDeliverableCycle {
  readonly organizationId: string;
  readonly jobId: string;
  readonly jobState: string;
  readonly currentDeliverableVersionId: string | null;
  /** The job state this cycle fails in: `COMPOSING` or `DELIVERABLE_VALIDATING`. */
  readonly failedIn: FailedDeliverableCycleState;
  /** Whether the failed version is the job's newest. */
  readonly failedVersionIsNewest: boolean;
}

/**
 * Take the cost-admission lock and then the reservation of the job a deliverable
 * version belongs to.
 *
 * The settlement may release that reservation, and every entitlement release
 * takes the organization and billing-cycle lock before the reservation row
 * (`cost-admission-lock.ts`), so a cost decision for the same cycle never runs
 * beside it. The cycle key is read first, without a lock: it is frozen on the
 * reservation when the hold is taken.
 *
 * Reached through the version, whose job never changes, so the reservation this
 * locks belongs to the job the caller's chain lock will find. Only the
 * reservation row is locked here: the job is the caller's to lock, after this,
 * in the declared order.
 *
 * Tenant-scoped: a cross-tenant or unknown version locks no row and reads
 * `null`, exactly as a job with no reservation does, taking the lock other
 * workflows take for a job with no reservation.
 */
export async function lockReservationForDeliverable(
  tx: Tx,
  organizationId: string,
  deliverableVersionId: string,
): Promise<SettlementReservationRow | null> {
  const cycles = await tx.$queryRaw<{ billingCycleKey: string }[]>`
    SELECT res."billingCycleKey" AS "billingCycleKey"
      FROM "generation_reservations" res
      JOIN "generation_deliverable_versions" v ON v."generationJobId" = res."generationJobId"
      JOIN "generation_jobs" j ON j."id" = v."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE v."id" = ${deliverableVersionId}
       AND p."organizationId" = ${organizationId}
  `;
  await acquireCostAdmissionLock(tx, organizationId, cycles[0]?.billingCycleKey ?? "unreserved");

  const rows = await tx.$queryRaw<SettlementReservationRow[]>`
    SELECT res."id"          AS "reservationId",
           res."state"::text AS "reservationState"
      FROM "generation_reservations" res
      JOIN "generation_deliverable_versions" v ON v."generationJobId" = res."generationJobId"
      JOIN "generation_jobs" j ON j."id" = v."generationJobId"
      JOIN "video_projects" p ON p."id" = j."videoProjectId"
     WHERE v."id" = ${deliverableVersionId}
       AND p."organizationId" = ${organizationId}
       FOR UPDATE OF res
  `;
  return rows[0] ?? null;
}

/**
 * Settle a failed cycle: fail the job and release its Unit, or roll a
 * replacement back to the video the customer holds.
 *
 * Called after the caller wrote its terminal row, in the same transaction, with
 * the reservation and the job both locked. Every write names the state it read,
 * and a write that matches no row is a defect rather than a race: under these
 * locks nothing else can have moved them. The cause names the events and
 * nothing else (ADR-0103).
 *
 * @throws DeliverableSettlementDefect `RESERVATION_NOT_SETTLEABLE` before any
 *   settlement write when the reservation contradicts the job; the caller's
 *   transaction then rolls back its terminal row with it.
 */
export async function settleDeliverableFailure(
  tx: Tx,
  cycle: FailedDeliverableCycle,
  reservation: SettlementReservationRow | null,
  at: Date,
  context: TransitionContext,
  cause: DeliverableFailureCause = "NO_USABLE_VIDEO",
): Promise<void> {
  const settlement = settleFailedDeliverable({
    currentDeliverableVersionId: cycle.currentDeliverableVersionId,
    reservationState: reservationStateOf(reservation),
  });
  const record = deliverableSettlementRecord(settlement.kind, cause);
  const event = (eventType: string): TransitionContext => ({
    ...context,
    eventType,
    reasonCode: record.reasonCode,
  });

  await moveJob(tx, cycle.jobId, cycle.failedIn, settlement.jobState);
  await appendGenerationEvent(tx, {
    organizationId: cycle.organizationId,
    aggregateType: "JOB",
    aggregateId: cycle.jobId,
    fromState: cycle.failedIn,
    toState: settlement.jobState,
    context: event(record.jobEventType),
  });

  // A replacement's reservation is deliberately untouched, not even a version
  // bump: it was consumed by the video the customer still holds.
  if (settlement.kind === "ROLL_BACK") return;

  // The customer's Unit comes back (ADR-0052 Decision 19). `reservation` is
  // non-null here: the domain refused a missing one above.
  const released = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "generation_reservations"
       SET "state" = 'RELEASED'::"GenerationReservationState",
           "stateVersion" = "stateVersion" + 1,
           "releasedAt" = ${at},
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${reservation!.reservationId}
       AND "state" = ${settlement.releaseFrom}::"GenerationReservationState"
     RETURNING "id"
  `;
  if (released.length !== 1) {
    throw new DeliverableSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
  }
  await appendGenerationEvent(tx, {
    organizationId: cycle.organizationId,
    aggregateType: "RESERVATION",
    aggregateId: reservation!.reservationId,
    fromState: settlement.releaseFrom,
    toState: "RELEASED",
    context: event(RESERVATION_RELEASED_EVENT_TYPE),
  });
}

/**
 * A replay of a terminal row must find its settlement durable too.
 *
 * @throws DeliverableSettlementDefect `SETTLEMENT_INCOMPLETE` when it does not:
 *   the row predates ADR-0082 or was altered by hand. It is never settled late
 *   here, so the only settlement a terminal row gets is the one its own commit
 *   made.
 */
export function assertDeliverableFailureSettled(
  cycle: FailedDeliverableCycle,
  reservation: SettlementReservationRow | null,
): void {
  const settled = isDeliverableFailureSettled({
    failedIn: cycle.failedIn,
    jobState: jobStateOf(cycle.jobState),
    currentDeliverableVersionId: cycle.currentDeliverableVersionId,
    reservationState: reservationStateOf(reservation),
    failedVersionIsNewest: cycle.failedVersionIsNewest,
  });
  if (!settled) throw new DeliverableSettlementDefect("SETTLEMENT_INCOMPLETE");
}

async function moveJob(tx: Tx, jobId: string, from: string, to: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "generation_jobs"
       SET "state" = ${to}::"GenerationJobState",
           "stateVersion" = "stateVersion" + 1,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${jobId}
       AND "state" = ${from}::"GenerationJobState"
     RETURNING "id"
  `;
  if (rows.length !== 1) throw new DeliverableSettlementDefect("SETTLEMENT_LOST_UNDER_LOCK");
}

// The columns are PostgreSQL enums, so a value outside the vocabulary cannot be
// read; these narrow the `::text` cast back to the domain's type without one.
function reservationStateOf(
  reservation: SettlementReservationRow | null,
): GenerationReservationState | null {
  if (reservation === null) return null;
  const state = GENERATION_RESERVATION_STATES.find((s) => s === reservation.reservationState);
  if (state === undefined) throw new DeliverableSettlementDefect("RESERVATION_NOT_SETTLEABLE");
  return state;
}

function jobStateOf(value: string): GenerationJobState {
  const state = GENERATION_JOB_STATES.find((s) => s === value);
  if (state === undefined) throw new DeliverableSettlementDefect("SETTLEMENT_INCOMPLETE");
  return state;
}
