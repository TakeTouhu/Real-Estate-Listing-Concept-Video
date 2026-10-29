/**
 * The organization + billing-cycle cost-admission lock, as one primitive.
 *
 * ## Why this file exists
 *
 * The same two-key `pg_advisory_xact_lock` formula was written out in four
 * repositories — paid-submission authorization, submission outcome,
 * reconciliation and completion — and each copy carried its own comment about
 * why the keys are what they are. Four copies of a lock *key* is not four
 * copies of a helper: two workflows that disagree by one character in a
 * `hashtext` input take different locks and stop serializing, and nothing fails,
 * nothing logs, and nothing is visibly wrong until two paid calls cross the
 * provider boundary against one exhausted entitlement.
 *
 * Phase 4C-3B-2H-3B-6C adds a fifth caller — settlement releases a reservation,
 * which is exactly the mutation the authorization path is protecting itself
 * against — so the formula became one function rather than five.
 *
 * ## The lock
 *
 * A PostgreSQL transaction-scoped advisory lock, which needs no table and no
 * migration: the correctness property is "two cost decisions for one
 * organization and cycle are ordered", and an advisory lock states exactly that
 * without inventing a row to lock. It releases automatically at commit or
 * rollback, so a crashed worker cannot strand an organization.
 *
 * Two 32-bit keys rather than one: `hashtext` over the organization id and over
 * the cycle key. A collision between two organizations would serialize them
 * unnecessarily — a throughput cost, never a correctness one — while the pair
 * makes that vanishingly unlikely anyway.
 *
 * ## Lock ordering
 *
 * This is the outermost lock in the system. Every workflow that takes it takes
 * it **first**, then the reservation row, then whatever aggregate it mutates:
 *
 * ```text
 * cost-admission advisory lock -> reservation row lock -> everything else
 * ```
 *
 * The Phase 4C-3B-2E row locks — `scene_generation_requests`,
 * `generation_scenes`, `video_projects` — are taken inside their own
 * transactions and are never held while this one is acquired, so there is no
 * cycle: nothing acquires a 2E lock and then waits for this one.
 *
 * Many transactions hold this lock and then lock a row of that kind: the
 * settlements and Transactions K and L lock jobs, scenes and requests. These
 * also lock a project, an asset or a Property:
 *
 * - the start commit (ADR-0087) locks a `video_projects` row and its Property
 *   (`FOR SHARE`, to the commit);
 * - the paid-submission gate (ADR-0096) locks the attempt's `media_assets` row
 *   (`FOR NO KEY UPDATE`) and its project's Property (`FOR SHARE`), after the
 *   reservation and before the attempt's compare-and-set;
 * - the ending of a waiting job that can never launch (ADR-0099) locks the
 *   reservation `FOR UPDATE`, then the Property `FOR SHARE`, the job
 *   `FOR UPDATE`, its scenes `FOR SHARE` and its requests `FOR UPDATE`;
 * - the ending of a generating job's attempt whose Property was deleted
 *   (ADR-0100) locks the attempt's Property (`FOR SHARE`) before the attempt's
 *   compare-and-set;
 * - the ending of a deleted Property's launched job (ADR-0102) locks the
 *   reservation `FOR UPDATE`, then the Property `FOR SHARE` and the job
 *   `FOR UPDATE`.
 *
 * Each takes this lock first, before the row, as the order requires. A
 * transaction that locked a project, an asset or a Property and then waited
 * for this lock would deadlock with them: a preparation refusal parked under
 * this lock must take it before it touches the asset, never after the legacy
 * claim's asset lock.
 *
 * ## Not exported from the package
 *
 * `packages/database/src/index.ts` does not re-export this. A caller outside the
 * package holding this lock would be holding it without the transaction that
 * makes it mean anything, and the whole value of one key formula is lost the
 * moment someone can take it from somewhere this file cannot see.
 */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * The two key strings, derived in exactly one place.
 *
 * Exported so a test can assert that every caller takes the *same* lock, which
 * is a property no individual call site can demonstrate about itself.
 */
export function costAdmissionLockKeys(
  organizationId: string,
  billingCycleKey: string,
): { readonly organizationKey: string; readonly cycleKey: string } {
  return {
    organizationKey: `paid-submission:${organizationId}`,
    cycleKey: `cycle:${billingCycleKey}`,
  };
}

/** Take the cost-admission lock for this organization and cycle, for this transaction. */
export async function acquireCostAdmissionLock(
  tx: Tx,
  organizationId: string,
  billingCycleKey: string,
): Promise<void> {
  const keys = costAdmissionLockKeys(organizationId, billingCycleKey);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${keys.organizationKey}),
      hashtext(${keys.cycleKey})
    )::text AS locked
  `;
}

/**
 * The entitlement-period opening lock (Phase 6A), kept in this module so every
 * advisory-lock formula in the system lives in one file.
 *
 * Scoped to one organization and taken only by `openPeriod`, to make its
 * overlap check and its insert one decision. Nothing that takes it takes any
 * other lock afterwards except its own inserts, and nothing holding another lock
 * waits for it, so it sits outside the cost-admission order rather than inside
 * it and cannot form a cycle with anything.
 */
export async function acquireEntitlementPeriodOpeningLock(
  tx: Tx,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`entitlement-periods:${organizationId}`}),
      hashtext('open')
    )::text AS locked
  `;
}

/**
 * The reservation-admission lock (Phase 6A): one reservation attempt per job at
 * a time.
 *
 * Taken by `reserve()` **first**, before the cost-admission lock. Two attempts
 * for one job may carry instants in different periods — or one in none — and
 * would otherwise take different cost-admission locks, or none, and never see
 * each other. It is the only lock ever taken before the cost-admission lock, and
 * it cannot form a cycle with it: only Transaction B (`reserve()`) and the start
 * commit (ADR-0087) take it, each as its first statement, so no transaction
 * holding the cost-admission lock or any row lock ever waits for it. The start
 * commit takes it for the job it is about to create, then runs Transaction B,
 * which takes it again and is granted it at once.
 */
export async function acquireReservationAdmissionLock(
  tx: Tx,
  organizationId: string,
  generationJobId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`reservation-admission:${organizationId}`}),
      hashtext(${generationJobId})
    )::text AS locked
  `;
}

/**
 * The job-launch lock (GS-7b, ADR-0095): one launch decision per organization
 * at a time.
 *
 * Taken by the launch commit **first**, before any row. Its count of the jobs
 * holding a place, its choice of the oldest waiting job and the job's start
 * become one decision, so two launches of one organization can never both see
 * the last free place. Only the launch commit takes it, as its first
 * statement, and it takes no cost-admission lock, so it sits outside the
 * cost-admission order: nothing holding another lock ever waits for it.
 */
export async function acquireJobLaunchLock(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`job-launch:${organizationId}`}),
      hashtext('launch')
    )::text AS locked
  `;
}
