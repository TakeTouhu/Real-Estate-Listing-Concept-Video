/**
 * The deliverable-composition-plan port.
 *
 * ## One operation, not four
 *
 * There is deliberately no `createDeliverableVersion`, `addDeliverableInput`,
 * `freezeDeliverablePlan` or `markJobCompositionPending`. Four calls are four
 * crash boundaries, and the states they would leave behind — a version with no
 * inputs, an input set with no job move, a job awaiting composition with nothing
 * to compose — are exactly what Transaction I exists to make impossible. The
 * single method owns the locks, the authority re-reads, every write and every
 * event.
 *
 * ## The caller supplies scope, never authority
 *
 * `organizationId` says which tenant the caller believes owns the job; the
 * transaction proves it through the Job → VideoProject → organization chain in
 * the same locked statement. A cross-tenant id locks nothing, reads nothing and
 * is reported exactly as a missing one.
 *
 * `deliverableVersionId` is the id to create *if* a plan is admitted. The
 * **ordinal is never accepted from a caller**: it is derived as `MAX + 1` under
 * the Job lock, because an ordinal chosen outside the transaction is a claim
 * about rows the caller did not lock.
 *
 * ## No discovery method
 *
 * There is no `findCompositionCandidates` here, and that is not an oversight.
 * Phase 5A ships dormant: no scheduler, no runner and no actor for
 * `COMPOSITION_PENDING -> COMPOSING`. A candidate query would be a queue with
 * nothing draining it, and shipping one would suggest work is happening that
 * is not.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { AdmitCompositionPlanOutcome } from "./plan";

export interface AdmitCompositionPlanInput {
  /** The tenant the caller believes owns this job. Never trusted on its own. */
  readonly organizationId: string;
  /** The job whose scenes are being frozen into a deliverable version. */
  readonly generationJobId: string;
  /** The id for the version this call would create. Not an ordinal. */
  readonly deliverableVersionId: string;
  readonly context: TransitionContext;
}

export interface DeliverableCompositionPlanRepository {
  /**
   * Transaction I, in one short database transaction.
   *
   * Database-only: no object-store read, no `ffprobe`, no `ffmpeg`, no HTTP and
   * no temporary file is reachable from inside it. The durable `VALID` media
   * verdict and the Scene's delivered pointer are the authorities, and both
   * already exist before this is called.
   */
  admitCompositionPlan(
    input: AdmitCompositionPlanInput,
  ): Promise<AdmitCompositionPlanOutcome>;
}
