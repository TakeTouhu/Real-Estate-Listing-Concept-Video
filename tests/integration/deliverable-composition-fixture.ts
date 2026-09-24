import type { PrismaClient } from "@prisma/client";
import { managedGenerationOutputKey } from "@app/domain";
import { ASSET_A, ASSET_B, ORG_A, PROJECT_A, PROJECT_B, STORYBOARD_SCENE } from "./orchestration-fixture";

/**
 * A job whose scenes are all composable, built as durable rows.
 *
 * The intermediate states are written directly rather than driven through the
 * earlier transactions. Those edges have their own suites; reaching them here
 * would drag a reservation hold, a submission, a provider poll and a delivery
 * into a test about *planning*, and the extra events would drown the two under
 * assertion.
 *
 * Nothing here calls a provider, reads an object store or runs `ffprobe`. The
 * durable `VALID` verdict is seeded as a row, because that is exactly what it
 * is.
 */

export const DIGEST = "c".repeat(64);
/** The bytes of a newer attempt, so "which attempt was selected" is observable. */
export const NEWER_DIGEST = "1".repeat(64);
export const SIZE = 9_876_543;

export interface PlannedScene {
  readonly sceneId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly validationId: string;
  readonly position: number;
}

export interface PlanChain {
  readonly jobId: string;
  readonly reservationId: string;
  readonly scenes: readonly PlannedScene[];
}

export interface SceneOptions {
  readonly sceneState?: string;
  readonly requestState?: string;
  readonly requestKind?: "INITIAL" | "USER_REGENERATION";
  readonly orchestrationState?: string;
  readonly validation?:
    | "VALID"
    | "PENDING"
    | "RUNNING"
    | "INVALID_MEDIA"
    | "INTEGRITY_MISMATCH"
    | "NONE";
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly receiptSha256?: string;
  readonly receiptSizeBytes?: number;
  /** Omit the scene's delivered pointer entirely. */
  readonly noDeliveredPointer?: boolean;
  /** Add a newer attempt under the same request, so the seeded one is stale. */
  readonly supersede?: boolean;
  /**
   * Add a newer attempt that is itself fully composable, and give it an
   * **earlier** `createdAt` than the attempt it supersedes.
   *
   * The ordinal and the timestamp then disagree, which is the only way to tell
   * which one the selection actually used.
   */
  readonly supersededByValid?: boolean;
}

export interface ChainOptions {
  readonly organizationId?: string;
  readonly jobState?: string;
  readonly reservationState?: string;
  readonly sceneCount?: number;
  readonly targetOutputResolution?: string;
  readonly targetAspectRatio?: string;
  readonly requestedDurationSeconds?: number;
  /** Per-position overrides, applied to the scene at that position. */
  readonly scenes?: Readonly<Record<number, SceneOptions>>;
}

let seq = 0;

export async function seedPlanChain(
  prisma: PrismaClient,
  options: ChainOptions = {},
): Promise<PlanChain> {
  seq += 1;
  const tag = `dcp${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  const videoProjectId = organizationId === ORG_A ? PROJECT_A : PROJECT_B;
  const jobId = `genjob_${tag}`;
  const reservationId = `genres_${tag}`;
  const count = options.sceneCount ?? 2;
  const requestedDurationSeconds = options.requestedDurationSeconds ?? 60;
  // Units are a function of the project's duration, not of the scene count, and
  // `generation_jobs_units_check` enforces exactly that arithmetic.
  const requiredVideoUnits =
    requestedDurationSeconds <= 30 ? 1 : requestedDurationSeconds <= 60 ? 2 : 3;

  await prisma.generationJob.create({
    data: {
      id: jobId,
      videoProjectId,
      requestedByUserId: "usr_itest",
      qualityTier: "NORMAL",
      targetOutputResolution: options.targetOutputResolution ?? "1080p",
      targetAspectRatio: options.targetAspectRatio ?? "16:9",
      requestedDurationSeconds,
      requiredVideoUnits,
      requiredHighQualityUnits: 0,
      state: (options.jobState ?? "SCENES_READY") as never,
    },
  });

  await prisma.generationReservation.create({
    data: {
      id: reservationId,
      generationJobId: jobId,
      billingCycleKey: "2026-09",
      billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      reservedTotalVideoUnits: requiredVideoUnits,
      reservedHighQualityUnits: 0,
      state: (options.reservationState ?? "RESERVED") as never,
      ...(options.reservationState === "CONSUMED" ? { consumedAt: new Date() } : {}),
      ...(options.reservationState === "RELEASED" ? { releasedAt: new Date() } : {}),
    },
  });

  const scenes: PlannedScene[] = [];
  for (let position = 0; position < count; position += 1) {
    scenes.push(
      await seedPlannedScene(
        prisma,
        jobId,
        position,
        organizationId,
        `${tag}_${position}`,
        options.scenes?.[position] ?? {},
      ),
    );
  }

  return { jobId, reservationId, scenes };
}

export async function seedPlannedScene(
  prisma: PrismaClient,
  jobId: string,
  position: number,
  organizationId: string,
  tag: string,
  options: SceneOptions = {},
): Promise<PlannedScene> {
  const sceneId = `genscene_${tag}`;
  const requestId = `genreq_${tag}`;
  const attemptId = `sgen_${tag}`;
  const validationId = `momv_${tag}`;
  const sha256 = options.sha256 ?? DIGEST;
  const sizeBytes = options.sizeBytes ?? SIZE;

  await prisma.generationScene.create({
    data: {
      id: sceneId,
      generationJobId: jobId,
      position,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: organizationId === ORG_A ? ASSET_A : ASSET_B,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: "a sunlit living room, cinematic",
      state: (options.sceneState ?? "READY") as never,
    },
  });

  await prisma.sceneGenerationRequest.create({
    data: {
      id: requestId,
      generationSceneId: sceneId,
      kind: (options.requestKind ?? "INITIAL") as never,
      userRegenerationOrdinal: options.requestKind === "USER_REGENERATION" ? 1 : null,
      state: (options.requestState ?? "DELIVERED") as never,
      requestedByUserId: "usr_itest",
      ...(options.requestState === undefined || options.requestState === "DELIVERED"
        ? { deliveredAt: new Date("2026-09-04T00:00:00.000Z") }
        : {}),
    },
  });

  await seedAttempt(prisma, attemptId, requestId, organizationId, {
    ordinal: 1,
    orchestrationState: options.orchestrationState ?? "OUTPUT_VERIFIED",
    sha256,
    sizeBytes,
  });

  if (options.supersededByValid === true) {
    // Ordinal 2, fully composable, with an *earlier* `createdAt` than ordinal 1.
    // The two authorities disagree on purpose: whichever one the selection uses
    // is then observable in the plan, rather than both happening to agree.
    await seedAttempt(prisma, `${attemptId}_v`, requestId, organizationId, {
      ordinal: 2,
      orchestrationState: "OUTPUT_VERIFIED",
      sha256: NEWER_DIGEST,
      sizeBytes: sizeBytes + 7,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    await seedValidation(prisma, `${validationId}_v`, `${attemptId}_v`, {
      status: "VALID",
      receiptSha256: NEWER_DIGEST,
      receiptSizeBytes: sizeBytes + 7,
    });
  }

  if (options.supersede === true) {
    // A newer attempt under the same request. The seeded one is then no longer
    // the latest by ordinal, which is the only latest that counts.
    await seedAttempt(prisma, `${attemptId}_n`, requestId, organizationId, {
      ordinal: 2,
      orchestrationState: "OUTPUT_VERIFIED",
      sha256: "f".repeat(64),
      sizeBytes: sizeBytes + 1,
    });
  }

  if (options.validation !== "NONE") {
    await seedValidation(prisma, validationId, attemptId, {
      status: options.validation ?? "VALID",
      receiptSha256: options.receiptSha256 ?? sha256,
      receiptSizeBytes: options.receiptSizeBytes ?? sizeBytes,
    });
  }

  if (options.noDeliveredPointer !== true) {
    await prisma.generationScene.update({
      where: { id: sceneId },
      data: { currentDeliveredRequestId: requestId },
    });
  }

  return { sceneId, requestId, attemptId, validationId, position };
}

export async function seedAttempt(
  prisma: PrismaClient,
  id: string,
  requestId: string,
  organizationId: string,
  options: {
    readonly ordinal: number;
    readonly orchestrationState: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly createdAt?: Date;
  },
): Promise<void> {
  const verified = options.orchestrationState === "OUTPUT_VERIFIED";
  await prisma.sceneGeneration.create({
    data: {
      id,
      videoProjectId: organizationId === ORG_A ? PROJECT_A : PROJECT_B,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      assetId: organizationId === ORG_A ? ASSET_A : ASSET_B,
      sourceAnalysisRevision: 1,
      requestHash: `hash_${id}`,
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      generationSceneRequestId: requestId,
      attemptOrdinal: options.ordinal,
      attemptKind: options.ordinal === 1 ? "PRIMARY" : "SYSTEM_RECOVERY",
      pricingContractKey: "wavespeed-open-video@v1",
      submissionCertainty: "ACCEPTED",
      providerPredictionId: `pred_${id}`,
      providerAcceptedAt: new Date("2026-09-01T00:00:00.000Z"),
      submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
      orchestrationState: options.orchestrationState as never,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(verified
        ? {
            outputStorageKey: managedGenerationOutputKey({ organizationId, attemptId: id }),
            outputSha256: options.sha256,
            outputSizeBytes: BigInt(options.sizeBytes),
            outputVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
          }
        : {}),
    },
  });
}

export async function seedValidation(
  prisma: PrismaClient,
  id: string,
  attemptId: string,
  options: {
    readonly status: "VALID" | "PENDING" | "RUNNING" | "INVALID_MEDIA" | "INTEGRITY_MISMATCH";
    readonly receiptSha256: string;
    readonly receiptSizeBytes: number;
  },
): Promise<void> {
  const facts =
    options.status === "VALID"
      ? {
          container: "ISO_BMFF" as const,
          durationMs: BigInt(8500),
          videoWidth: BigInt(1920),
          videoHeight: BigInt(1080),
          videoStreamCount: BigInt(1),
          audioStreamCount: BigInt(0),
        }
      : {};
  const terminal =
    options.status === "VALID" ||
    options.status === "INVALID_MEDIA" ||
    options.status === "INTEGRITY_MISMATCH";
  await prisma.managedOutputMediaValidation.create({
    data: {
      id,
      sceneGenerationId: attemptId,
      status: options.status as never,
      receiptSha256: options.receiptSha256,
      receiptSizeBytes: BigInt(options.receiptSizeBytes),
      ...(options.status === "RUNNING"
        ? { leaseToken: `lease_${id}`, leaseExpiresAt: new Date(Date.now() + 60_000) }
        : {}),
      ...(options.status === "INVALID_MEDIA" ? { invalidReason: "PROBE_REJECTED" as const } : {}),
      ...facts,
      validatedAt: terminal ? new Date("2026-09-03T00:00:00.000Z") : null,
    },
  });
}

/**
 * A prior deliverable for this job, made current.
 *
 * What a recomposition cycle starts from. The version is real — the composite
 * foreign key admits nothing else — and deliberately carries no input rows: it
 * stands in for a deliverable published before Transaction I existed.
 */
export async function makeCurrentDeliverable(
  prisma: PrismaClient,
  jobId: string,
  fingerprint: string,
  ordinal = 1,
): Promise<string> {
  const id = `gdv_prior_${jobId}_${ordinal}`;
  await prisma.generationDeliverableVersion.create({
    data: { id, generationJobId: jobId, ordinal, inputFingerprint: fingerprint },
  });
  await prisma.generationJob.update({
    where: { id: jobId },
    data: { currentDeliverableVersionId: id },
  });
  return id;
}

/** Everything a fail-closed proof must show unchanged, beyond the job itself. */
export async function worldSnapshot(prisma: PrismaClient) {
  const [requests, attempts, validations, reservations, scenes, versions, inputs, events] =
    await Promise.all([
      prisma.sceneGenerationRequest.findMany({ orderBy: { id: "asc" } }),
      prisma.sceneGeneration.findMany({ orderBy: { id: "asc" } }),
      prisma.managedOutputMediaValidation.findMany({ orderBy: { id: "asc" } }),
      prisma.generationReservation.findMany({ orderBy: { id: "asc" } }),
      prisma.generationScene.findMany({ orderBy: { id: "asc" } }),
      prisma.generationDeliverableVersion.findMany({ orderBy: { id: "asc" } }),
      prisma.generationDeliverableInput.findMany({ orderBy: { id: "asc" } }),
      prisma.generationTransitionEvent.count(),
    ]);
  return { requests, attempts, validations, reservations, scenes, versions, inputs, events };
}
