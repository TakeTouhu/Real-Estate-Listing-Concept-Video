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
