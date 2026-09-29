import {
  createDeliverableCompositionExecutionRepository,
  createDeliverableCompositionPlanRepository,
} from "@app/database";
import { safePositiveByteCount, sha256Digest } from "@app/domain";
import type { PrismaClient } from "@prisma/client";
import { seedPlannedDeliverable } from "./deliverable-composition-execution-fixture";
import type { ChainOptions } from "./deliverable-composition-fixture";
import { ctx, ORG_A } from "./orchestration-fixture";

/**
 * A job whose deliverable has actually been composed, and which is therefore
 * waiting to be validated.
 *
 * Driven through the **real** Phase 5A and Phase 5B transactions rather than
 * written by hand. Hand-writing an `OUTPUT_VERIFIED` composition would let a
 * Phase 5C test pass against a row shape the composition transaction cannot
 * produce — a receipt whose key is not canonical, a job left in the wrong state —
 * which is exactly the disagreement these suites exist to catch.
 *
 * No `ffmpeg`, no `ffprobe`, no object store. The composition receipt is a fixed
 * digest and byte count, because Phase 5C never reads the object: the validator
 * is a port, and every suite here supplies a fake for it.
 */

let composedSeq = 0;

export interface ComposedDeliverable {
  readonly jobId: string;
  readonly reservationId: string;
  readonly deliverableVersionId: string;
  readonly organizationId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** The digest every composed fixture deliverable carries unless told otherwise. */
export const COMPOSED_SHA = sha256Digest("c".repeat(64));
export const COMPOSED_BYTES = safePositiveByteCount(8_192);

const COMPOSE_LEASE_MS = 30 * 60_000;
const COMPOSE_NOW = Date.UTC(2026, 8, 25, 10, 0, 0);

/**
 * Plan a deliverable and compose it, leaving the job `DELIVERABLE_VALIDATING`.
 *
 * The receipt is parameterized so a suite can seed two deliverables that differ
 * only in their bytes, which is what a receipt-conflict test needs.
 */
export async function seedComposedDeliverable(
  prisma: PrismaClient,
  options: ChainOptions & { readonly sha256?: string; readonly sizeBytes?: number } = {},
): Promise<ComposedDeliverable> {
  const planned = await seedPlannedDeliverable(prisma, options);
  const sha256 = sha256Digest(options.sha256 ?? COMPOSED_SHA);
  const sizeBytes = safePositiveByteCount(options.sizeBytes ?? COMPOSED_BYTES);
  await composeVersion(prisma, planned.organizationId, planned.deliverableVersionId, {
    sha256,
    sizeBytes,
  });
  return {
    jobId: planned.jobId,
    reservationId: planned.reservationId,
    deliverableVersionId: planned.deliverableVersionId,
    organizationId: planned.organizationId,
    sha256,
    sizeBytes,
  };
}

/**
 * Plan and compose a *second* deliverable for a job that already published one.
 *
 * The job is walked back to `SCENES_READY` with raw Prisma before Transaction I
 * is asked to plan again, and that is deliberate: `DELIVERABLE_READY -> REVISING`
 * and `REVISING -> GENERATING` are reserved for revision start, and driving a
 * whole regeneration here would test Phase 4's machinery rather than Phase 5C's.
 * What Phase 5C actually needs is the *shape* a recomposition cycle presents —
 * a pointer that already names an earlier version, a `CONSUMED` hold, and a newer
 * version whose composition is verified — and every part of that shape below is
 * produced by the real transactions.
 */
export async function seedRecomposedDeliverable(
  prisma: PrismaClient,
  published: ComposedDeliverable,
  overrides: { readonly sha256?: string; readonly sizeBytes?: number } = {},
): Promise<ComposedDeliverable> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: published.jobId } });
  await prisma.generationJob.update({
    where: { id: published.jobId },
    data: { state: "SCENES_READY", stateVersion: job.stateVersion + 1 },
  });

  composedSeq += 1;
  const deliverableVersionId = `gdv_recompose_${composedSeq}`;
  const plan = await createDeliverableCompositionPlanRepository(prisma).admitCompositionPlan({
    organizationId: published.organizationId,
    generationJobId: published.jobId,
    deliverableVersionId,
    context: ctx(),
  });
  if (plan.kind !== "PLANNED") throw new Error(`fixture: replan returned ${plan.kind}`);

  const sha256 = sha256Digest(overrides.sha256 ?? "e".repeat(64));
  const sizeBytes = safePositiveByteCount(overrides.sizeBytes ?? 9_001);
  await composeVersion(prisma, published.organizationId, plan.deliverableVersionId, {
    sha256,
    sizeBytes,
  });
  return {
    jobId: published.jobId,
    reservationId: published.reservationId,
    deliverableVersionId: plan.deliverableVersionId,
    organizationId: published.organizationId,
    sha256,
    sizeBytes,
  };
}

/** Claim and finalize one composition through the real Phase 5B transactions. */
async function composeVersion(
  prisma: PrismaClient,
  organizationId: string,
  deliverableVersionId: string,
  receipt: { readonly sha256: string; readonly sizeBytes: number },
): Promise<void> {
  const repository = createDeliverableCompositionExecutionRepository(prisma);
  composedSeq += 1;
  const claimed = await repository.claimCompositionWork({
    organizationId,
    deliverableVersionId,
    now: COMPOSE_NOW,
    leaseToken: `clease_5c_${composedSeq}`,
    leaseExpiresAt: COMPOSE_NOW + COMPOSE_LEASE_MS,
    context: ctx(),
  });
  if (claimed.kind !== "CLAIMED") {
    throw new Error(`fixture: composition claim returned ${claimed.kind}`);
  }
  const finalized = await repository.finalizeComposition({
    claim: claimed.claim,
    outputSha256: sha256Digest(receipt.sha256),
    outputSizeBytes: safePositiveByteCount(receipt.sizeBytes),
    verifiedAt: COMPOSE_NOW + 60_000,
    context: ctx(),
  });
  if (finalized.kind !== "FINALIZED") {
    throw new Error(`fixture: composition finalize returned ${finalized.kind}`);
  }
}

/** The validation work row, or null. Read directly, never through the port. */
export async function validationOf(prisma: PrismaClient, deliverableVersionId: string) {
  return prisma.generationDeliverableValidation.findUnique({
    where: { deliverableVersionId },
  });
}

export async function reservationOf(prisma: PrismaClient, reservationId: string) {
  return prisma.generationReservation.findUniqueOrThrow({ where: { id: reservationId } });
}

export const DEFAULT_ORG = ORG_A;
