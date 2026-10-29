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
 * ## Discovery is a hint
 *
 * Phase 5A shipped no discovery, because nothing after the plan ran yet. GS-8
 * (ADR-0104) adds `findCompositionPlanCandidates` for the dormant runner:
 * identifiers only, read without a lock, mirroring every refusal of the
 * admission so a job it would refuse never holds the head of the batch. A job
 * whose admission throws is still offered, and holds its place on every pass
 * until someone looks. The admission still re-reads and re-decides everything
 * under its own locks.
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

/** Identifiers only. Nothing here is a decision. */
export interface CompositionPlanCandidate {
  readonly organizationId: string;
  readonly generationJobId: string;
}

export interface CompositionPlanCandidateQuery {
  readonly limit: number;
}

export interface DeliverableCompositionPlanRepository {
  /**
   * Bounded, deterministic, one row per job, oldest first. A hint only: no
   * lock and no transaction.
   */
  findCompositionPlanCandidates(
    query: CompositionPlanCandidateQuery,
  ): Promise<readonly CompositionPlanCandidate[]>;

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
