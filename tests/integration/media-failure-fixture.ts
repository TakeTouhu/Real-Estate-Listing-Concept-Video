import type { PrismaClient } from "@prisma/client";
import {
  AutomaticMediaRecoveryPricingPlanner,
  createProviderPricingCatalog,
  epochMillisFromDate,
  type FxRateSource,
  type FxSnapshot,
} from "@app/domain";
import { createVideoModelCatalog } from "@app/video-providers";
import {
  attemptInput,
  ctx,
  ORG_A,
  PROJECT_B,
  repositories,
  seedChain,
  seedPriorDeliverable,
} from "./orchestration-fixture";

/**
 * A failed provider attempt with a durable terminal media verdict, built through
 * the real admission path.
 *
 * Shared by the resolution-work and settlement suites so the two cannot drift
 * into testing different worlds. The source attempt is admitted through the
 * generic primitive, so its pricing snapshot, request hash and route are
 * canonical rather than hand-written.
 *
 * Nothing here calls a provider, reads an object store or runs `ffprobe`.
 */

export const DIGEST = "e".repeat(64);
export const SIZE = 5_120_000;
export const PLANNING_AT = new Date("2026-09-10T00:00:00.000Z");

export const RATE: FxSnapshot = {
  id: "fx_resolution_test",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(PLANNING_AT),
  sourceReference: null,
};

/** Deterministic, offline. No network FX integration exists. */
export function fakeFx(rate: FxSnapshot | null = RATE): FxRateSource {
  return { current: async () => rate };
}

export function planner(fx: FxRateSource = fakeFx()) {
  return new AutomaticMediaRecoveryPricingPlanner({
    models: createVideoModelCatalog(),
    pricing: createProviderPricingCatalog(),
    clock: () => epochMillisFromDate(PLANNING_AT),
    fx,
  });
}

export interface FailureChain {
  readonly tag: string;
  readonly jobId: string;
  readonly sceneId: string;
  readonly requestId: string;
  readonly predecessorRequestId: string | null;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly validationId: string;
}

export interface SeedFailureOptions {
  /** `SYSTEM_RECOVERY` builds the exhausted shape: a PRIMARY plus its recovery. */
  readonly attemptKind?: "PRIMARY" | "SYSTEM_RECOVERY";
  readonly requestKind?: "INITIAL" | "USER_REGENERATION";
  readonly failure?: "INVALID_MEDIA" | "INTEGRITY_MISMATCH" | "VALID" | "PENDING";
  readonly organizationId?: string;
  readonly reservationState?: "RESERVED" | "RECONCILIATION_HOLD" | "CONSUMED";
  readonly validatedAt?: Date;
  readonly receiptSha256?: string;
}

let seq = 0;

export async function seedFailure(
  prisma: PrismaClient,
  options: SeedFailureOptions = {},
): Promise<FailureChain> {
  seq += 1;
  const tag = `mfr${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  const repos = repositories(prisma);
  const requestKind = options.requestKind ?? "INITIAL";
  const attemptKind = options.attemptKind ?? "SYSTEM_RECOVERY";

  const { job, scene, request } = await seedChain(
    prisma,
    tag,
    organizationId,
    organizationId === ORG_A ? undefined : PROJECT_B,
  );

  // Distinct scene facts per chain, so each derives a distinct request hash.
  // Without this, two chains in one project collide on the partial unique index
  // enforcing "at most one active attempt per (project, request identity)".
  await prisma.generationScene.update({
    where: { id: scene.id },
    data: { snapshotCompiledPrompt: `a sunlit living room, cinematic, ${tag}` },
  });

  let requestId = request.id;
  let predecessorRequestId: string | null = null;
  if (requestKind === "USER_REGENERATION") {
    predecessorRequestId = request.id;
    await prisma.sceneGenerationRequest.update({
      where: { id: request.id },
      data: {
        state: "DELIVERED",
        deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
        stateVersion: 2,
      },
    });
    await prisma.generationScene.update({
      where: { id: scene.id },
      data: { state: "REVISING", currentDeliveredRequestId: request.id, stateVersion: 2 },
    });
    requestId = `genreq_regen_${tag}`;
    await prisma.sceneGenerationRequest.create({
      data: {
        id: requestId,
        generationSceneId: scene.id,
        kind: "USER_REGENERATION",
        userRegenerationOrdinal: 1,
        state: "PENDING",
        requestedByUserId: "usr_itest",
      },
    });
    // A real version row, not a synthetic id: Phase 5A gave the pointer a
    // composite foreign key, so only a version belonging to this job is
    // insertable.
    const priorDeliverableId = await seedPriorDeliverable(prisma, job.id, tag);
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { currentDeliverableVersionId: priorDeliverableId },
    });
  } else {
    await prisma.generationScene.update({
      where: { id: scene.id },
      data: { state: "GENERATING" },
    });
  }

  // The PRIMARY attempt, through the real admission primitive.
  const primaryId = `sgen_${tag}_p`;
  const primary = await repos.attempts.admit(
    organizationId,
    attemptInput({ id: primaryId, generationSceneRequestId: requestId }),
    ctx(),
  );
  if (primary.kind !== "ADMITTED") throw new Error(`primary not admitted: ${primary.kind}`);

  let attemptId = primaryId;
  if (attemptKind === "SYSTEM_RECOVERY") {
    // The PRIMARY must be terminal before its recovery can be admitted: the
    // partial unique index permits one active attempt per request identity.
    await finishAttempt(prisma, primaryId, "FAILED_TERMINAL");
    attemptId = `sgen_${tag}_r`;
    // `attemptKind` is derived by admission, never nominated: the second attempt
    // under one request is a SYSTEM_RECOVERY because one PRIMARY per request is
    // a unique index.
    const recovery = await repos.attempts.admit(
      organizationId,
      attemptInput({ id: attemptId, generationSceneRequestId: requestId }),
      ctx(),
    );
    if (recovery.kind !== "ADMITTED") throw new Error(`recovery not admitted: ${recovery.kind}`);
  }

  // Drive the failed attempt to a verified managed output. The intervening
  // submission and polling edges have their own suites.
  await prisma.sceneGeneration.update({
    where: { id: attemptId },
    data: {
      submissionCertainty: "ACCEPTED",
      providerPredictionId: `pred_${tag}`,
      providerAcceptedAt: new Date("2026-09-01T00:00:00.000Z"),
      submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
      orchestrationState: "OUTPUT_VERIFIED",
      outputStorageKey: `org/${organizationId}/generated/${attemptId}/output`,
      outputSha256: DIGEST,
      outputSizeBytes: BigInt(SIZE),
      outputVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
    },
  });

  await prisma.generationJob.update({ where: { id: job.id }, data: { state: "GENERATING" } });

  const reservationId = `genres_${tag}`;
  const reservationState =
    options.reservationState ?? (requestKind === "USER_REGENERATION" ? "CONSUMED" : "RESERVED");
  await prisma.generationReservation.create({
    data: {
      id: reservationId,
      generationJobId: job.id,
      billingCycleKey: "2026-09",
      billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      reservedTotalVideoUnits: 2,
      reservedHighQualityUnits: 2,
      state: reservationState,
      ...(reservationState === "CONSUMED" ? { consumedAt: new Date() } : {}),
    },
  });

  const failure = options.failure ?? "INVALID_MEDIA";
  const terminal = failure !== "PENDING";
  const validationId = `momv_${tag}`;
  await prisma.managedOutputMediaValidation.create({
    data: {
      id: validationId,
      sceneGenerationId: attemptId,
      status: failure as never,
      receiptSha256: options.receiptSha256 ?? DIGEST,
      receiptSizeBytes: BigInt(SIZE),
      ...(failure === "INVALID_MEDIA" ? { invalidReason: "PROBE_REJECTED" as never } : {}),
      ...(failure === "VALID"
        ? {
            container: "ISO_BMFF" as const,
            durationMs: BigInt(8500),
            videoWidth: BigInt(1920),
            videoHeight: BigInt(1080),
            videoStreamCount: BigInt(1),
            audioStreamCount: BigInt(0),
          }
        : {}),
      validatedAt: terminal ? (options.validatedAt ?? new Date("2026-09-03T00:00:00.000Z")) : null,
    },
  });

  return {
    tag,
    jobId: job.id,
    sceneId: scene.id,
    requestId,
    predecessorRequestId,
    reservationId,
    attemptId,
    validationId,
  };
}

/**
 * Drive an attempt to a terminal state.
 *
 * Deliberately no `providerPredictionId` or `providerAcceptedAt`: a definitively
 * rejected submission never received one, and a CHECK constraint enforces that
 * a prediction id only exists alongside an accepted submission.
 */
export async function finishAttempt(
  prisma: PrismaClient,
  attemptId: string,
  state: "FAILED_TERMINAL" | "OUTPUT_VERIFIED",
): Promise<void> {
  await prisma.sceneGeneration.update({
    where: { id: attemptId },
    data: {
      orchestrationState: state,
      submissionCertainty: "DEFINITIVELY_REJECTED",
      submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  });
}

export async function workRow(prisma: PrismaClient, validationId: string) {
  return prisma.managedOutputMediaFailureResolution.findUnique({
    where: { managedOutputMediaValidationId: validationId },
  });
}

export async function eventsFor(prisma: PrismaClient, aggregateId: string) {
  return prisma.generationTransitionEvent.findMany({
    where: { aggregateId },
    orderBy: { createdAt: "asc" },
  });
}
