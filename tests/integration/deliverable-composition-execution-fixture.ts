import type { PrismaClient } from "@prisma/client";
import { createDeliverableCompositionPlanRepository } from "@app/database";
import { ctx, ORG_A } from "./orchestration-fixture";
import { seedPlanChain, type ChainOptions } from "./deliverable-composition-fixture";

/**
 * A job that has been *planned* by Transaction I and is waiting to be composed.
 *
 * The plan is produced by the real Phase 5A transaction rather than written by
 * hand. Hand-writing it would let an execution test pass against a plan shape
 * the admission transaction cannot actually produce, which is precisely the
 * disagreement these suites exist to catch.
 */

let versionSeq = 0;

export interface PlannedDeliverable {
  readonly jobId: string;
  readonly reservationId: string;
  readonly deliverableVersionId: string;
  readonly organizationId: string;
}

/**
 * Two scenes of five seconds each, and a job admitted for ten.
 *
 * The duration invariant holds by construction, so a suite that wants a
 * mismatch asks for one explicitly rather than getting it by accident from a
 * default that happened not to line up.
 */
export const COMPOSABLE_CHAIN: ChainOptions = {
  sceneCount: 2,
  requestedDurationSeconds: 10,
};

export async function seedPlannedDeliverable(
  prisma: PrismaClient,
  options: ChainOptions = {},
): Promise<PlannedDeliverable> {
  const organizationId = options.organizationId ?? ORG_A;
  const chain = await seedPlanChain(prisma, { ...COMPOSABLE_CHAIN, ...options });

  versionSeq += 1;
  const deliverableVersionId = `gdv_exec_${versionSeq}`;
  const outcome = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
    organizationId,
    generationJobId: chain.jobId,
    deliverableVersionId,
    context: ctx(),
  });
  if (outcome.kind !== "PLANNED") {
    throw new Error(`fixture: plan admission returned ${outcome.kind}`);
  }

  return {
    jobId: chain.jobId,
    reservationId: chain.reservationId,
    deliverableVersionId: outcome.deliverableVersionId,
    organizationId,
  };
}

/** The composition work row, or null. Read directly, never through the port. */
export async function compositionOf(prisma: PrismaClient, deliverableVersionId: string) {
  return prisma.generationDeliverableComposition.findUnique({
    where: { deliverableVersionId },
  });
}

export async function jobOf(prisma: PrismaClient, jobId: string) {
  return prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
}

export async function eventsFor(prisma: PrismaClient, aggregateId: string) {
  return prisma.generationTransitionEvent.findMany({
    where: { aggregateId },
    orderBy: { sequence: "asc" },
  });
}

export async function eventCount(prisma: PrismaClient): Promise<number> {
  return prisma.generationTransitionEvent.count();
}
