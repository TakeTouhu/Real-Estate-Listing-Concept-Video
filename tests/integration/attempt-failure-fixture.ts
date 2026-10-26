import type { PrismaClient } from "@prisma/client";
import type { GenerationReservationState } from "@app/domain";
import {
  attemptInput,
  ctx,
  ORG_A,
  PROJECT_A,
  PROJECT_B,
  repositories,
  seedChain,
  seedPriorDeliverable,
  STORYBOARD_SCENE,
  ASSET_A,
  ASSET_B,
} from "./orchestration-fixture";

/**
 * A scene request whose attempts ended the ways an attempt can end, for the
 * attempt failure settlement suite (ADR-0083).
 *
 * Every attempt is admitted through the real admission primitive, so its request
 * hash, ordinal and kind are the system's. Only the attempt's end is written by
 * hand, with the submission facts each end carries in production: a refused
 * submission never reached the provider, a provider failure holds a prediction
 * id, an unresolved submission carries its reconciliation window.
 *
 * Nothing here calls a provider or reads an object store.
 */

/** How one attempt ended, or where it still is. */
export type AttemptEnd =
  /** The provider refused the submission: `FAILED_TERMINAL`, never accepted. */
  | "REJECTED"
  /** The same refusal, classified retryable: `FAILED_RETRYABLE`. */
  | "REJECTED_RETRYABLE"
  /** Accepted, then failed by the provider: `FAILED_TERMINAL` with a prediction. */
  | "PROVIDER_FAILED"
  /** Nobody learned whether it was sent before the deadline. */
  | "EXHAUSTED"
  /** Cancelled before it was sent. */
  | "CANCELLED"
  /** Accepted and still generating. */
  | "PROCESSING"
  /** A verified managed output. */
  | "OUTPUT_VERIFIED"
  /** As admitted, not yet sent. */
  | "QUEUED";

export const OUTPUTLESS_ENDS = [
  "REJECTED",
  "REJECTED_RETRYABLE",
  "PROVIDER_FAILED",
  "EXHAUSTED",
  "CANCELLED",
] as const satisfies readonly AttemptEnd[];

const BOUNDARY = new Date("2026-09-01T00:00:00.000Z");

export interface AttemptFailureChain {
  readonly tag: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly sceneId: string;
  readonly requestId: string;
  readonly predecessorRequestId: string | null;
  readonly reservationId: string | null;
  readonly attemptIds: readonly string[];
}

export interface SeedAttemptFailureOptions {
  readonly requestKind?: "INITIAL" | "USER_REGENERATION";
  /** Oldest first. The default is one refused submission. */
  readonly attempts?: readonly AttemptEnd[];
  readonly organizationId?: string;
  /** `null` seeds no reservation at all. */
  readonly reservationState?: GenerationReservationState | null;
}

let seq = 0;

export async function seedAttemptFailure(
  prisma: PrismaClient,
  options: SeedAttemptFailureOptions = {},
): Promise<AttemptFailureChain> {
  seq += 1;
  const tag = `afs${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  const requestKind = options.requestKind ?? "INITIAL";

  const { job, scene, request } = await seedChain(
    prisma,
    tag,
    organizationId,
    organizationId === ORG_A ? PROJECT_A : PROJECT_B,
  );
  // Distinct scene facts per chain, so each derives a distinct request hash and
  // two chains in one project do not collide on the one-active-attempt index.
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
      data: { state: "DELIVERED", deliveredAt: new Date("2026-08-01T00:00:00.000Z"), stateVersion: 2 },
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
    const priorDeliverableId = await seedPriorDeliverable(prisma, job.id, tag);
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { currentDeliverableVersionId: priorDeliverableId },
    });
  } else {
    await prisma.generationScene.update({ where: { id: scene.id }, data: { state: "GENERATING" } });
  }

  const attemptIds = await addAttempts(
    prisma,
    organizationId,
    requestId,
    `${tag}_a`,
    options.attempts ?? ["REJECTED"],
  );

  await prisma.generationJob.update({ where: { id: job.id }, data: { state: "GENERATING" } });

  const reservationState =
    options.reservationState === undefined
      ? requestKind === "USER_REGENERATION"
        ? "CONSUMED"
        : "RESERVED"
      : options.reservationState;
  let reservationId: string | null = null;
  if (reservationState !== null) {
    reservationId = `genres_${tag}`;
    await prisma.generationReservation.create({
      data: {
        id: reservationId,
        generationJobId: job.id,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        // Seeded directly, outside the ledger: the pre-Phase-6A shape, with no
        // recorded funding source. Not what `reserve()` produces.
        funding: "UNALLOCATED_LEGACY",
        reservedTotalVideoUnits: 2,
        reservedHighQualityUnits: 2,
        state: reservationState,
        ...(reservationState === "CONSUMED" ? { consumedAt: new Date("2026-08-01T00:00:00.000Z") } : {}),
        ...(reservationState === "RELEASED" ? { releasedAt: new Date("2026-09-02T00:00:00.000Z") } : {}),
      },
    });
  }

  return {
    tag,
    organizationId,
    jobId: job.id,
    sceneId: scene.id,
    requestId,
    predecessorRequestId,
    reservationId,
    attemptIds,
  };
}

/**
 * Another scene of the chain's job, in `state`, with a pending initial request.
 * A `READY` scene's request is marked delivered and named by its pointer.
 */
export async function addSiblingScene(
  prisma: PrismaClient,
  chain: AttemptFailureChain,
  position: number,
  state: "PENDING" | "GENERATING" | "READY",
): Promise<{ readonly sceneId: string; readonly requestId: string }> {
  const repos = repositories(prisma);
  const sceneId = `genscene_${chain.tag}_${position}`;
  const created = await repos.scenes.create(
    chain.organizationId,
    {
      id: sceneId,
      generationJobId: chain.jobId,
      position,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: chain.organizationId === ORG_A ? ASSET_A : ASSET_B,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: `a sunlit kitchen, cinematic, ${chain.tag}_${position}`,
    },
    ctx(),
  );
  if (created === null) throw new Error("sibling scene not created");
  const request = await repos.requests.createInitial(
    chain.organizationId,
    { id: `genreq_${chain.tag}_${position}`, generationSceneId: sceneId, requestedByUserId: "usr_itest" },
    ctx(),
  );
  if (request === null) throw new Error("sibling request not created");
  if (state === "READY") {
    await prisma.sceneGenerationRequest.update({
      where: { id: request.id },
      data: { state: "DELIVERED", deliveredAt: new Date("2026-08-01T00:00:00.000Z"), stateVersion: 1 },
    });
    await prisma.generationScene.update({
      where: { id: sceneId },
      data: { state: "READY", currentDeliveredRequestId: request.id, stateVersion: 1 },
    });
  } else if (state === "GENERATING") {
    await prisma.generationScene.update({ where: { id: sceneId }, data: { state: "GENERATING" } });
  }
  return { sceneId, requestId: request.id };
}

/**
 * Admit one attempt per entry under `requestId`, oldest first, and end each as
 * named. Admission takes a `PENDING` request to `GENERATING`; an earlier attempt
 * must have ended before the next is admitted, as the one-active-attempt index
 * requires.
 */
export async function addAttempts(
  prisma: PrismaClient,
  organizationId: string,
  requestId: string,
  prefix: string,
  ends: readonly AttemptEnd[],
): Promise<string[]> {
  const repos = repositories(prisma);
  const ids: string[] = [];
  for (const [index, end] of ends.entries()) {
    const id = `sgen_${prefix}${index + 1}`;
    const admitted = await repos.attempts.admit(
      organizationId,
      attemptInput({ id, generationSceneRequestId: requestId }),
      ctx(),
    );
    if (admitted.kind !== "ADMITTED") throw new Error(`attempt not admitted: ${admitted.kind}`);
    await endAttempt(prisma, organizationId, id, end);
    ids.push(id);
  }
  return ids;
}

/** Write the submission facts and state an attempt carries when it ends as `end`. */
export async function endAttempt(
  prisma: PrismaClient,
  organizationId: string,
  attemptId: string,
  end: AttemptEnd,
): Promise<void> {
  const accepted = {
    submissionCertainty: "ACCEPTED" as const,
    providerPredictionId: `pred_${attemptId}`,
    providerAcceptedAt: BOUNDARY,
    submissionBoundaryEnteredAt: BOUNDARY,
  };
  const refused = {
    submissionCertainty: "DEFINITIVELY_REJECTED" as const,
    submissionBoundaryEnteredAt: BOUNDARY,
  };
  const data = (() => {
    switch (end) {
      case "QUEUED":
        return null;
      case "REJECTED":
        return { ...refused, orchestrationState: "FAILED_TERMINAL" as const };
      case "REJECTED_RETRYABLE":
        return { ...refused, orchestrationState: "FAILED_RETRYABLE" as const };
      case "PROVIDER_FAILED":
        return { ...accepted, orchestrationState: "FAILED_TERMINAL" as const };
      case "EXHAUSTED":
        return {
          submissionCertainty: "SUBMISSION_UNKNOWN" as const,
          submissionBoundaryEnteredAt: BOUNDARY,
          reconciliationStartedAt: BOUNDARY,
          reconciliationDeadlineAt: new Date("2026-09-01T01:00:00.000Z"),
          orchestrationState: "RECONCILIATION_EXHAUSTED" as const,
        };
      case "CANCELLED":
        return {
          submissionCertainty: "PRE_SUBMISSION" as const,
          orchestrationState: "CANCELLED_PRE_SUBMISSION" as const,
        };
      case "PROCESSING":
        return { ...accepted, orchestrationState: "PROCESSING" as const };
      case "OUTPUT_VERIFIED":
        return {
          ...accepted,
          orchestrationState: "OUTPUT_VERIFIED" as const,
          outputStorageKey: `org/${organizationId}/generated/${attemptId}/output`,
          outputSha256: "e".repeat(64),
          outputSizeBytes: BigInt(5_120_000),
          outputVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
        };
    }
  })();
  if (data !== null) await prisma.sceneGeneration.update({ where: { id: attemptId }, data });
}

/** One aggregate's events, in the order they were appended. */
export async function eventsOf(prisma: PrismaClient, aggregateId: string) {
  return prisma.generationTransitionEvent.findMany({
    where: { aggregateId },
    orderBy: { sequence: "asc" },
  });
}
