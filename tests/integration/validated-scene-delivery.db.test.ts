import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  JOB_SCENES_READY_EVENT_TYPE,
  SCENE_READY_EVENT_TYPE,
  SCENE_REQUEST_DELIVERED_EVENT_TYPE,
  VALIDATED_DELIVERY_REASON_CODE,
  ValidatedSceneDeliveryDefect,
  ValidatedSceneDeliveryRunner,
  managedGenerationOutputKey,
} from "@app/domain";
import { AppError } from "@app/shared";
import { createValidatedSceneDeliveryRepository } from "@app/database";
import {
  ASSET_A,
  ASSET_B,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Transaction F against live PostgreSQL.
 *
 * The unit suite proves the runner's ordering against an in-memory boundary.
 * What only a database can prove is that the SQL agrees: that the `VALID`-only
 * gate, the byte-identity recheck and the latest-attempt ordinal are actually
 * in the predicates; that the request, the Scene, the pointer and the Job move
 * as one row set or not at all; that a rolled-back transaction leaves *nothing*
 * behind, not even an event; and that two workers finishing the last two Scenes
 * of one Job at the same instant produce exactly one `SCENES_READY`.
 *
 * Nothing here calls a provider, reads an object store or runs `ffprobe`. The
 * durable media verdict is seeded as a row, because that is exactly what it is.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createValidatedSceneDeliveryRepository(prisma);

const DIGEST = "c".repeat(64);
const OTHER_DIGEST = "d".repeat(64);
const SIZE = 9_876_543;

interface Chain {
  readonly jobId: string;
  readonly sceneId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly validationId: string;
}

let seq = 0;

/** A `GENERATING` job with no scenes yet. */
async function seedJob(
  options: { readonly state?: string; readonly organizationId?: string } = {},
): Promise<string> {
  seq += 1;
  const id = `genjob_vsd_${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  await prisma.generationJob.create({
    data: {
      id,
      videoProjectId: organizationId === ORG_A ? PROJECT_A : PROJECT_B,
      requestedByUserId: "usr_itest",
      qualityTier: "NORMAL",
      targetOutputResolution: "1080p",
      targetAspectRatio: "16:9",
      requestedDurationSeconds: 60,
      requiredVideoUnits: 2,
      requiredHighQualityUnits: 0,
      state: (options.state ?? "GENERATING") as never,
    },
  });
  return id;
}

/**
 * One Scene of a Job, with its request, its attempt and its media verdict.
 *
 * The intermediate states are written directly rather than driven through the
 * earlier transactions. Those edges have their own suites; reaching them here
 * would drag a reservation, a submission and a provider poll into a test about
 * delivery, and the extra events would drown the ones under assertion.
 */
async function seedScene(
  jobId: string,
  position: number,
  options: {
    readonly organizationId?: string;
    readonly sceneState?: string;
    readonly requestKind?: "INITIAL" | "USER_REGENERATION";
    readonly requestState?: string;
    readonly ordinal?: number;
    readonly attemptKind?: "PRIMARY" | "SYSTEM_RECOVERY";
    readonly orchestrationState?: string;
    readonly sha256?: string;
    readonly sizeBytes?: number;
    readonly validation?: "VALID" | "PENDING" | "RUNNING" | "INVALID_MEDIA" | "INTEGRITY_MISMATCH" | "NONE";
    readonly receiptSha256?: string;
    readonly receiptSizeBytes?: number;
    readonly validatedAt?: Date;
    readonly attemptCreatedAt?: Date;
  } = {},
): Promise<Chain> {
  seq += 1;
  const tag = `vsd_${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  const sceneId = `genscene_${tag}`;
  const requestId = `genreq_${tag}`;
  const attemptId = `sgen_${tag}`;
  const validationId = `momv_${tag}`;
  const kind = options.requestKind ?? "INITIAL";
  const size = options.sizeBytes ?? SIZE;

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
      state: (options.sceneState ?? "GENERATING") as never,
    },
  });

  await prisma.sceneGenerationRequest.create({
    data: {
      id: requestId,
      generationSceneId: sceneId,
      kind: kind as never,
      userRegenerationOrdinal: kind === "USER_REGENERATION" ? 1 : null,
      state: (options.requestState ?? "GENERATING") as never,
      requestedByUserId: "usr_itest",
    },
  });

  await seedAttempt(attemptId, requestId, organizationId, {
    ordinal: options.ordinal ?? 1,
    attemptKind: options.attemptKind ?? "PRIMARY",
    orchestrationState: options.orchestrationState ?? "OUTPUT_VERIFIED",
    sha256: options.sha256 ?? DIGEST,
    sizeBytes: size,
    createdAt: options.attemptCreatedAt,
  });

  if (options.validation !== "NONE") {
    await seedValidation(validationId, attemptId, {
      status: options.validation ?? "VALID",
      receiptSha256: options.receiptSha256 ?? options.sha256 ?? DIGEST,
      receiptSizeBytes: options.receiptSizeBytes ?? size,
      validatedAt: options.validatedAt,
    });
  }

  return { jobId, sceneId, requestId, attemptId, validationId };
}

async function seedAttempt(
  id: string,
  requestId: string,
  organizationId: string,
  options: {
    readonly ordinal: number;
    readonly attemptKind: "PRIMARY" | "SYSTEM_RECOVERY";
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
      attemptKind: options.attemptKind,
      pricingContractKey: "wavespeed-open-video@v1",
      submissionCertainty: "ACCEPTED",
      providerPredictionId: `pred_${id}`,
      providerAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      submissionBoundaryEnteredAt: new Date("2026-01-01T00:00:00.000Z"),
      orchestrationState: options.orchestrationState as never,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(verified
        ? {
            outputStorageKey: managedGenerationOutputKey({ organizationId, attemptId: id }),
            outputSha256: options.sha256,
            outputSizeBytes: BigInt(options.sizeBytes),
            outputVerifiedAt: new Date("2026-01-02T00:00:00.000Z"),
          }
        : {}),
    },
  });
}

async function seedValidation(
  id: string,
  attemptId: string,
  options: {
    readonly status: "VALID" | "PENDING" | "RUNNING" | "INVALID_MEDIA" | "INTEGRITY_MISMATCH";
    readonly receiptSha256: string;
    readonly receiptSizeBytes: number;
    readonly validatedAt?: Date;
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
      validatedAt: terminal ? (options.validatedAt ?? new Date("2026-01-03T00:00:00.000Z")) : null,
    },
  });
}

/** Everything a fail-closed proof must show unchanged, beyond the chain itself. */
async function worldSnapshot() {
  const [attempts, validations, reservations, events] = await Promise.all([
    prisma.sceneGeneration.findMany({ orderBy: { id: "asc" } }),
    prisma.managedOutputMediaValidation.findMany({ orderBy: { id: "asc" } }),
    prisma.generationReservation.findMany({ orderBy: { id: "asc" } }),
    prisma.generationTransitionEvent.count(),
  ]);
  return { attempts, validations, reservations, events };
}

async function deliver(attemptId: string, organizationId = ORG_A) {
  return repository.deliverValidatedScene({
    organizationId,
    sceneGenerationId: attemptId,
    context: ctx({ correlationId: `corr_${attemptId}` }),
  });
}

/** Everything Transaction F may touch, as one comparable snapshot. */
async function snapshot(chain: Chain) {
  const [job, scene, request, events] = await Promise.all([
    prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } }),
    prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } }),
    prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: chain.requestId } }),
    prisma.generationTransitionEvent.count(),
  ]);
  return {
    jobState: job.state,
    jobVersion: job.stateVersion,
    sceneState: scene.state,
    sceneVersion: scene.stateVersion,
    pointer: scene.currentDeliveredRequestId,
    requestState: request.state,
    requestVersion: request.stateVersion,
    deliveredAt: request.deliveredAt,
    events,
  };
}

RUN("Transaction F — atomic validated scene delivery", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
    seq = 0;
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------

  describe("the delivered business fact", () => {
    it("moves request, scene, pointer and job as one", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);

      const outcome = await deliver(chain.attemptId);
      expect(outcome).toEqual({ kind: "DELIVERED", jobAdvanced: true });

      const after = await snapshot(chain);
      expect(after.requestState).toBe("DELIVERED");
      expect(after.requestVersion).toBe(1);
      expect(after.deliveredAt).toBeInstanceOf(Date);
      expect(after.sceneState).toBe("READY");
      expect(after.sceneVersion).toBe(1);
      expect(after.pointer).toBe(chain.requestId);
      expect(after.jobState).toBe("SCENES_READY");
      expect(after.jobVersion).toBe(1);
    });

    it("appends exactly one event per aggregate, with this transaction's reason code", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await deliver(chain.attemptId);

      const events = await prisma.generationTransitionEvent.findMany({
        orderBy: [{ aggregateType: "asc" }, { sequence: "asc" }],
      });
      expect(events).toHaveLength(3);
      expect(
        events.map((e) => ({
          aggregateType: e.aggregateType,
          aggregateId: e.aggregateId,
          fromState: e.fromState,
          toState: e.toState,
          eventType: e.eventType,
          reasonCode: e.reasonCode,
          organizationId: e.organizationId,
          sequence: e.sequence,
        })),
      ).toEqual([
        {
          aggregateType: "JOB",
          aggregateId: chain.jobId,
          fromState: "GENERATING",
          toState: "SCENES_READY",
          eventType: JOB_SCENES_READY_EVENT_TYPE,
          reasonCode: VALIDATED_DELIVERY_REASON_CODE,
          organizationId: ORG_A,
          sequence: 1,
        },
        {
          aggregateType: "SCENE",
          aggregateId: chain.sceneId,
          fromState: "GENERATING",
          toState: "READY",
          eventType: SCENE_READY_EVENT_TYPE,
          reasonCode: VALIDATED_DELIVERY_REASON_CODE,
          organizationId: ORG_A,
          sequence: 1,
        },
        {
          aggregateType: "SCENE_REQUEST",
          aggregateId: chain.requestId,
          fromState: "GENERATING",
          toState: "DELIVERED",
          eventType: SCENE_REQUEST_DELIVERED_EVENT_TYPE,
          reasonCode: VALIDATED_DELIVERY_REASON_CODE,
          organizationId: ORG_A,
          sequence: 1,
        },
      ]);
      // No media fact, key, digest or provider identifier reached history.
      for (const event of events) {
        expect(JSON.stringify(event.safeMetadata ?? {})).not.toMatch(/c{10}|org\/|pred_/);
      }
    });

    it("advances the Job only once every Scene is READY", async () => {
      const jobId = await seedJob();
      const first = await seedScene(jobId, 0);
      const second = await seedScene(jobId, 1);

      const one = await deliver(first.attemptId);
      expect(one).toEqual({ kind: "DELIVERED", jobAdvanced: false });
      expect((await snapshot(first)).jobState).toBe("GENERATING");

      const two = await deliver(second.attemptId);
      expect(two).toEqual({ kind: "DELIVERED", jobAdvanced: true });
      expect((await snapshot(second)).jobState).toBe("SCENES_READY");
      expect((await snapshot(second)).jobVersion).toBe(1);
    });

    it("stops at SCENES_READY and never moves the Job further", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await deliver(chain.attemptId);
      expect(await deliver(chain.attemptId)).toEqual({ kind: "ALREADY_APPLIED" });

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.state).toBe("SCENES_READY");
      expect(job.stateVersion).toBe(1);
      expect(job.currentDeliverableVersionId).toBeNull();
    });

    it("does not advance a Job whose other Scene never started", async () => {
      // `not READY` rather than `is GENERATING`: a PENDING, REVISING, failed or
      // cancelled Scene is not a ready Scene, and a Job is not scenes-ready
      // while one of them is outstanding.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await seedScene(jobId, 1, { sceneState: "PENDING", validation: "NONE" });

      expect(await deliver(chain.attemptId)).toEqual({ kind: "DELIVERED", jobAdvanced: false });
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.state).toBe("GENERATING");
      expect(job.stateVersion).toBe(0);
    });

    it("advances only the Job it delivered into", async () => {
      const mineJob = await seedJob();
      const mine = await seedScene(mineJob, 0);
      const otherJob = await seedJob();
      await seedScene(otherJob, 0);

      expect(await deliver(mine.attemptId)).toEqual({ kind: "DELIVERED", jobAdvanced: true });

      expect(
        (await prisma.generationJob.findUniqueOrThrow({ where: { id: mineJob } })).state,
      ).toBe("SCENES_READY");
      // The other Job's Scene is still generating; readiness is counted per Job.
      const other = await prisma.generationJob.findUniqueOrThrow({ where: { id: otherJob } });
      expect(other.state).toBe("GENERATING");
      expect(other.stateVersion).toBe(0);
    });

    // A new delivery requires a Job that is still generating. The earlier
    // version of this suite asserted the opposite — that a `REVISING` Job could
    // still take a delivery, leaving the Job behind. That strands the Job: once
    // the request is DELIVERED it stops being a candidate, so no later
    // Transaction F call exists to perform `GENERATING -> SCENES_READY`. The
    // Job state machine agrees: `REVISING -> GENERATING` is the edge, so a
    // regeneration that is actually generating has a `GENERATING` Job.
    for (const state of ["REVISING", "SCENES_READY", "FAILED_TERMINAL", "CANCELLED"] as const) {
      it(`refuses a new delivery while the Job is ${state}`, async () => {
        const jobId = await seedJob({ state });
        const chain = await seedScene(jobId, 0);
        const before = await snapshot(chain);

        expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });

        // Zero mutation, zero event.
        expect(await snapshot(chain)).toEqual(before);
        expect(await prisma.generationTransitionEvent.count()).toBe(0);
        // And it is not offered by the sweep either.
        expect(await repository.findValidatedDeliveryCandidates({ limit: 100 })).toEqual([]);
      });
    }
  });

  // -------------------------------------------------------------------------

  describe("regeneration delivery", () => {
    it("moves REVISING -> READY and switches the pointer without rewriting history", async () => {
      // The Job stays GENERATING: `REVISING -> GENERATING` is the Job edge, so
      // by the time a regeneration's attempt has output to deliver, the Job is
      // generating again.
      const jobId = await seedJob();
      // The original delivery, already applied.
      const original = await seedScene(jobId, 0);
      await deliver(original.attemptId);
      const originalRequest = await prisma.sceneGenerationRequest.findUniqueOrThrow({
        where: { id: original.requestId },
      });

      // The first delivery advanced the single-Scene Job to SCENES_READY. The
      // regeneration path then runs it back through `REVISING -> GENERATING`
      // (Job) and `READY -> REVISING` (Scene). Both edges belong to other
      // transactions, so the states are set here directly — Transaction F is
      // entered with exactly the shape it will see in production:
      //
      //   Job GENERATING · Scene REVISING · pointer = prior DELIVERED request
      //   USER_REGENERATION request GENERATING · latest attempt OUTPUT_VERIFIED
      //   validation VALID
      await prisma.generationScene.update({
        where: { id: original.sceneId },
        data: { state: "REVISING", stateVersion: { increment: 1 } },
      });
      await prisma.generationJob.update({
        where: { id: jobId },
        data: { state: "GENERATING", stateVersion: { increment: 1 } },
      });
      // The predecessor the regeneration replaces is in place and DELIVERED.
      expect(
        (await prisma.generationScene.findUniqueOrThrow({ where: { id: original.sceneId } }))
          .currentDeliveredRequestId,
      ).toBe(original.requestId);
      seq += 1;
      const regenId = `genreq_regen_${seq}`;
      const regenAttempt = `sgen_regen_${seq}`;
      await prisma.sceneGenerationRequest.create({
        data: {
          id: regenId,
          generationSceneId: original.sceneId,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 1,
          state: "GENERATING",
          requestedByUserId: "usr_itest",
        },
      });
      await seedAttempt(regenAttempt, regenId, ORG_A, {
        ordinal: 1,
        attemptKind: "PRIMARY",
        orchestrationState: "OUTPUT_VERIFIED",
        sha256: OTHER_DIGEST,
        sizeBytes: SIZE + 11,
      });
      await seedValidation(`momv_regen_${seq}`, regenAttempt, {
        status: "VALID",
        receiptSha256: OTHER_DIGEST,
        receiptSizeBytes: SIZE + 11,
      });

      const outcome = await deliver(regenAttempt);
      // Every Scene of the Job is READY again, so the Job advances again.
      expect(outcome).toEqual({ kind: "DELIVERED", jobAdvanced: true });
      expect(
        (await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).state,
      ).toBe("SCENES_READY");

      const scene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: original.sceneId },
      });
      expect(scene.state).toBe("READY");
      expect(scene.currentDeliveredRequestId).toBe(regenId);

      // The superseded request is history, not garbage: untouched, still
      // DELIVERED, still carrying its own delivery instant.
      const previous = await prisma.sceneGenerationRequest.findUniqueOrThrow({
        where: { id: original.requestId },
      });
      expect(previous.state).toBe("DELIVERED");
      expect(previous.deliveredAt).toEqual(originalRequest.deliveredAt);
      expect(previous.stateVersion).toBe(originalRequest.stateVersion);

      // The regeneration right is consumed by `deliveredAt` on a DELIVERED
      // USER_REGENERATION request — a derived count, not a stored counter.
      const used = await prisma.sceneGenerationRequest.count({
        where: { generationSceneId: original.sceneId, kind: "USER_REGENERATION", state: "DELIVERED" },
      });
      expect(used).toBe(1);

      const scene_events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateType: "SCENE", aggregateId: original.sceneId },
        orderBy: { sequence: "asc" },
      });
      expect(scene_events.map((e) => `${e.fromState}->${e.toState}`)).toEqual([
        "GENERATING->READY",
        "REVISING->READY",
      ]);
    });

    it("refuses a USER_REGENERATION that has no delivered predecessor", async () => {
      // A regeneration *replaces* something. With no delivered request on the
      // Scene there is nothing to regenerate: the customer spent an entitlement
      // against a predecessor that does not exist, and delivering would invent
      // the Scene's first delivery under the wrong request kind. Previously the
      // predecessor check ran only when the pointer was non-null, so this shape
      // walked straight through.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, {
        requestKind: "USER_REGENERATION",
        sceneState: "REVISING",
      });
      expect((await snapshot(chain)).pointer).toBeNull();
      const before = await snapshot(chain);
      const worldBefore = await worldSnapshot();

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "REGENERATION_PREDECESSOR_MISSING",
      });

      // Nothing repaired, nothing invented, nothing consumed.
      expect(await snapshot(chain)).toEqual(before);
      expect(await worldSnapshot()).toEqual(worldBefore);
      // No entitlement was spent: the derivation still sees zero.
      expect(
        await prisma.sceneGenerationRequest.count({
          where: { generationSceneId: chain.sceneId, kind: "USER_REGENERATION", state: "DELIVERED" },
        }),
      ).toBe(0);
    });

    it("refuses a USER_REGENERATION whose Scene never entered REVISING", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, {
        requestKind: "USER_REGENERATION",
        sceneState: "GENERATING",
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toBeInstanceOf(ValidatedSceneDeliveryDefect);
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses an INITIAL delivery whose Scene is REVISING", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { sceneState: "REVISING" });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toBeInstanceOf(ValidatedSceneDeliveryDefect);
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------

  describe("only a durable VALID verdict delivers", () => {
    for (const status of ["PENDING", "RUNNING", "INVALID_MEDIA", "INTEGRITY_MISMATCH"] as const) {
      it(`refuses ${status} and writes nothing`, async () => {
        const jobId = await seedJob();
        const chain = await seedScene(jobId, 0, { validation: status });
        const before = await snapshot(chain);

        expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
        expect(await snapshot(chain)).toEqual(before);
        // And the sweep never offers it either.
        expect(await repository.findValidatedDeliveryCandidates({ limit: 100 })).toEqual([]);
      });
    }

    it("refuses an attempt with no verdict at all", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { validation: "NONE" });
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses an attempt that is not OUTPUT_VERIFIED", async () => {
      const jobId = await seedJob();
      // A verdict against an attempt that never reached OUTPUT_VERIFIED is not
      // a fact about managed bytes.
      const chain = await seedScene(jobId, 0, {
        orchestrationState: "PROVIDER_SUCCEEDED",
        validation: "NONE",
      });
      await seedValidation(chain.validationId, chain.attemptId, {
        status: "VALID",
        receiptSha256: DIGEST,
        receiptSizeBytes: SIZE,
      });
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await snapshot(chain)).toEqual(before);
      expect(await repository.findValidatedDeliveryCandidates({ limit: 100 })).toEqual([]);
    });

    it("refuses a request that is no longer GENERATING", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { requestState: "CANCELLED" });
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await snapshot(chain)).toEqual(before);
      expect(await repository.findValidatedDeliveryCandidates({ limit: 100 })).toEqual([]);
    });

    it("refuses a VALID row that carries no verdict instant", async () => {
      // `momv_status_shape_check` makes this row unwritable, which is the
      // point: the constraint is lifted for the length of this test — and put
      // back verbatim, read from the catalog rather than retyped — so the
      // repository's own guard can be shown to be independent of it. A VALID
      // verdict with no `validatedAt` is not a verdict.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      const [definition] = await prisma.$queryRawUnsafe<{ def: string }[]>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'momv_status_shape_check'`,
      );
      if (definition === undefined) throw new Error("expected the status-shape constraint");
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "managed_output_media_validations" DROP CONSTRAINT "momv_status_shape_check"`,
      );
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE "managed_output_media_validations" SET "validatedAt" = NULL WHERE "id" = $1`,
          chain.validationId,
        );
        const before = await snapshot(chain);

        expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
        expect(await snapshot(chain)).toEqual(before);
        expect(await repository.findValidatedDeliveryCandidates({ limit: 100 })).toEqual([]);
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE "managed_output_media_validations" SET "validatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = $1`,
          chain.validationId,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "managed_output_media_validations"
             ADD CONSTRAINT "momv_status_shape_check" ${definition.def}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------

  describe("the verdict must be about these exact bytes", () => {
    it("refuses a verdict bound to a different digest", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { receiptSha256: OTHER_DIGEST });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "RECEIPT_BINDING_CONFLICT",
      });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses a verdict bound to a different size", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { receiptSizeBytes: SIZE + 1 });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "RECEIPT_BINDING_CONFLICT",
      });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("compares sizes past 2^31 without truncating them", async () => {
      const big = 3_221_225_472; // 3 GiB — int4 would have overflowed.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { sizeBytes: big, receiptSizeBytes: big });

      expect(await deliver(chain.attemptId)).toEqual({ kind: "DELIVERED", jobAdvanced: true });
    });
  });

  // -------------------------------------------------------------------------

  describe("latest-attempt authority", () => {
    it("refuses an older attempt's verdict once a newer attempt exists", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await seedAttempt(`${chain.attemptId}_next`, chain.requestId, ORG_A, {
        ordinal: 2,
        // A recovery attempt: one PRIMARY per request is a unique index.
        attemptKind: "SYSTEM_RECOVERY",
        orchestrationState: "PROCESSING",
        sha256: OTHER_DIGEST,
        sizeBytes: SIZE,
      });
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("decides by ordinal, not by creation time", async () => {
      const jobId = await seedJob();
      // The *newer* attempt by ordinal was inserted with an earlier timestamp.
      // A `createdAt` comparison would call the stale attempt the latest and
      // deliver it.
      const chain = await seedScene(jobId, 0, {
        ordinal: 2,
        attemptKind: "SYSTEM_RECOVERY",
        attemptCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
      });
      await seedAttempt(`${chain.attemptId}_older`, chain.requestId, ORG_A, {
        ordinal: 1,
        attemptKind: "PRIMARY",
        orchestrationState: "FAILED_TERMINAL",
        sha256: OTHER_DIGEST,
        sizeBytes: SIZE,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      expect(await deliver(chain.attemptId)).toEqual({ kind: "DELIVERED", jobAdvanced: true });
    });
  });

  // -------------------------------------------------------------------------

  describe("the delivered pointer", () => {
    it("is rejected by the database when it names another Scene's request", async () => {
      const jobId = await seedJob();
      const mine = await seedScene(jobId, 0);
      const other = await seedScene(jobId, 1);

      // The composite foreign key (currentDeliveredRequestId, id) ->
      // (id, generationSceneId) makes a cross-Scene pointer unstorable, so
      // Transaction F never has to defend against one.
      await expect(
        prisma.generationScene.update({
          where: { id: mine.sceneId },
          data: { currentDeliveredRequestId: other.requestId },
        }),
      ).rejects.toBeTruthy();
    });

    it("refuses to deliver over a pointer naming an undelivered request", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { sceneState: "REVISING", requestKind: "USER_REGENERATION" });
      // A second request of the same Scene that never delivered, wired in as
      // the pointer: a state the application believes it cannot produce. It is
      // the Scene's failed INITIAL, because a partial unique index already
      // forbids two in-flight regenerations on one Scene.
      seq += 1;
      const strayId = `genreq_stray_${seq}`;
      await prisma.sceneGenerationRequest.create({
        data: {
          id: strayId,
          generationSceneId: chain.sceneId,
          kind: "INITIAL",
          state: "FAILED_TERMINAL",
          requestedByUserId: "usr_itest",
        },
      });
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: strayId },
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "PARTIAL_DELIVERY_STATE",
      });
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------

  describe("idempotency and partial states", () => {
    it("reports a replay as ALREADY_APPLIED and writes nothing a second time", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await deliver(chain.attemptId);
      const after = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "ALREADY_APPLIED" });
      expect(await deliver(chain.attemptId)).toEqual({ kind: "ALREADY_APPLIED" });
      // Same versions, same instant, same event count.
      expect(await snapshot(chain)).toEqual(after);
    });

    it("fails closed on a delivered request whose Scene never became ready", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { requestState: "DELIVERED" });
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.requestId },
        data: { deliveredAt: new Date("2026-04-01T00:00:00.000Z") },
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "PARTIAL_DELIVERY_STATE",
      });
      // Not repaired: the evidence of whatever produced it survives.
      expect(await snapshot(chain)).toEqual(before);
    });

    it("fails closed on a READY Scene pointing at a request still generating", async () => {
      // Distinct from the case below: here the Scene already looks delivered.
      // Classifying it by the Scene's state instead of the pointer would call
      // it a plain state conflict and hide that a pointer was written without
      // a delivery.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { state: "READY", currentDeliveredRequestId: chain.requestId },
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "PARTIAL_DELIVERY_STATE",
      });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("fails closed on a delivered request whose Scene is still generating", async () => {
      // Request DELIVERED, pointer already switched, Scene never moved: the
      // exact half-applied shape a non-atomic delivery would leave behind.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0, { requestState: "DELIVERED" });
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.requestId },
        data: { deliveredAt: new Date("2026-04-02T00:00:00.000Z") },
      });
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: chain.requestId },
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "PARTIAL_DELIVERY_STATE",
      });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("fails closed on a Scene pointing at a request that never delivered", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: chain.requestId },
      });
      const before = await snapshot(chain);

      await expect(deliver(chain.attemptId)).rejects.toMatchObject({
        code: "PARTIAL_DELIVERY_STATE",
      });
      expect(await snapshot(chain)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy", () => {
    it("reports another organization's attempt as not found and writes nothing", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId, ORG_B)).toEqual({ kind: "NOT_FOUND" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("reports an unknown attempt as not found", async () => {
      expect(await deliver("sgen_does_not_exist")).toEqual({ kind: "NOT_FOUND" });
      expect(await prisma.generationTransitionEvent.count()).toBe(0);
    });

    it("lists each organization's own candidates only", async () => {
      const mine = await seedScene(await seedJob(), 0);
      const theirs = await seedScene(await seedJob({ organizationId: ORG_B }), 0, {
        organizationId: ORG_B,
      });

      const listed = await repository.findValidatedDeliveryCandidates({ limit: 100 });
      const byOrg = new Map(listed.map((one) => [one.sceneGenerationId, one.organizationId]));
      expect(byOrg.get(mine.attemptId)).toBe(ORG_A);
      expect(byOrg.get(theirs.attemptId)).toBe(ORG_B);
    });
  });

  // -------------------------------------------------------------------------

  describe("the candidate sweep", () => {
    it("orders by verdict time then id, and honours the bound", async () => {
      const jobId = await seedJob();
      const third = await seedScene(jobId, 0, { validatedAt: new Date("2026-05-03T00:00:00.000Z") });
      const first = await seedScene(jobId, 1, { validatedAt: new Date("2026-05-01T00:00:00.000Z") });
      const second = await seedScene(jobId, 2, { validatedAt: new Date("2026-05-02T00:00:00.000Z") });

      const all = await repository.findValidatedDeliveryCandidates({ limit: 100 });
      expect(all.map((one) => one.sceneGenerationId)).toEqual([
        first.attemptId,
        second.attemptId,
        third.attemptId,
      ]);
      expect(all.map((one) => one.validationId)).toEqual([
        first.validationId,
        second.validationId,
        third.validationId,
      ]);

      const bounded = await repository.findValidatedDeliveryCandidates({ limit: 2 });
      expect(bounded.map((one) => one.sceneGenerationId)).toEqual([
        first.attemptId,
        second.attemptId,
      ]);
    });

    it("does not let a superseded attempt occupy the bound", async () => {
      // The starvation shape. Request A's ordinal-1 attempt is VALID,
      // OUTPUT_VERIFIED and has the *oldest* verdict, so `ORDER BY validatedAt
      // ASC LIMIT n` puts it first — but a newer sibling exists, so every
      // delivery call for it returns NOT_ELIGIBLE forever. Listing it anyway
      // means enough such rows permanently occupy the batch and genuinely
      // deliverable work behind them is never reached.
      const jobA = await seedJob();
      const stale = await seedScene(jobA, 0, {
        validatedAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      await seedAttempt(`${stale.attemptId}_next`, stale.requestId, ORG_A, {
        ordinal: 2,
        attemptKind: "SYSTEM_RECOVERY",
        orchestrationState: "PROCESSING",
        sha256: OTHER_DIGEST,
        sizeBytes: SIZE,
      });

      const jobB = await seedJob();
      const deliverable = await seedScene(jobB, 0, {
        validatedAt: new Date("2026-07-02T00:00:00.000Z"),
      });

      // With a bound of one, the single slot goes to the row that can actually
      // be delivered, not to the older permanently-ineligible one.
      const bounded = await repository.findValidatedDeliveryCandidates({ limit: 1 });
      expect(bounded.map((one) => one.sceneGenerationId)).toEqual([deliverable.attemptId]);

      // And the stale row is absent from an unbounded sweep too, so it is
      // filtered rather than merely out-ranked.
      const all = await repository.findValidatedDeliveryCandidates({ limit: 100 });
      expect(all.map((one) => one.sceneGenerationId)).toEqual([deliverable.attemptId]);

      // The runner therefore makes progress on B in a single pass of size one.
      const runner = new ValidatedSceneDeliveryRunner({
        repository,
        context: () => ctx({ correlationId: "corr_starve" }),
      });
      expect(await runner.runOnce(1)).toMatchObject({ delivered: 1 });
      expect((await snapshot(deliverable)).requestState).toBe("DELIVERED");
      // A's stale attempt was never touched.
      expect((await snapshot(stale)).requestState).toBe("GENERATING");
    });

    it("still refuses the superseded attempt when it is named directly", async () => {
      // Candidate discovery is a hint, so filtering it out of the listing does
      // not retire the transactional check.
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await seedAttempt(`${chain.attemptId}_next`, chain.requestId, ORG_A, {
        ordinal: 2,
        attemptKind: "SYSTEM_RECOVERY",
        orchestrationState: "PROCESSING",
        sha256: OTHER_DIGEST,
        sizeBytes: SIZE,
      });
      const before = await snapshot(chain);

      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await snapshot(chain)).toEqual(before);
    });

    it("refuses an unusable bound rather than clamping it", async () => {
      await expect(
        repository.findValidatedDeliveryCandidates({ limit: 0 }),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        repository.findValidatedDeliveryCandidates({ limit: 101 }),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        repository.findValidatedDeliveryCandidates({ limit: Number.POSITIVE_INFINITY }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it("drops a candidate whose request moved on between listing and delivery", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      const listed = await repository.findValidatedDeliveryCandidates({ limit: 100 });
      expect(listed.map((one) => one.sceneGenerationId)).toEqual([chain.attemptId]);

      await prisma.sceneGenerationRequest.update({
        where: { id: chain.requestId },
        data: { state: "CANCELLED", stateVersion: { increment: 1 } },
      });

      // The listing is a hint; the delivery call re-checks under its own locks.
      expect(await deliver(chain.attemptId)).toEqual({ kind: "NOT_ELIGIBLE" });
    });
  });

  // -------------------------------------------------------------------------

  describe("what delivery never touches", () => {
    it("creates no attempt and modifies no attempt or verdict row", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      const attemptsBefore = await prisma.sceneGeneration.findMany({ orderBy: { id: "asc" } });
      const verdictsBefore = await prisma.managedOutputMediaValidation.findMany({
        orderBy: { id: "asc" },
      });

      await deliver(chain.attemptId);

      expect(await prisma.sceneGeneration.findMany({ orderBy: { id: "asc" } })).toEqual(
        attemptsBefore,
      );
      expect(
        await prisma.managedOutputMediaValidation.findMany({ orderBy: { id: "asc" } }),
      ).toEqual(verdictsBefore);
    });

    it("leaves the reservation and its units exactly as they were", async () => {
      const jobId = await seedJob();
      const chain = await seedScene(jobId, 0);
      await prisma.generationReservation.create({
        data: {
          id: `genres_${jobId}`,
          generationJobId: jobId,
          state: "RESERVED",
          billingCycleKey: "2026-01",
          reservedTotalVideoUnits: 2,
          reservedHighQualityUnits: 0,
          billingCycleStartedAt: new Date("2026-01-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      });
      const before = await prisma.generationReservation.findUniqueOrThrow({
        where: { id: `genres_${jobId}` },
      });

      await deliver(chain.attemptId);

      expect(
        await prisma.generationReservation.findUniqueOrThrow({ where: { id: `genres_${jobId}` } }),
      ).toEqual(before);
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateType: "RESERVATION" } }),
      ).toBe(0);
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateType: "DELIVERABLE" } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("the runner against a live database", () => {
    it("delivers a whole job in one bounded pass", async () => {
      const jobId = await seedJob();
      const first = await seedScene(jobId, 0, { validatedAt: new Date("2026-06-01T00:00:00.000Z") });
      const second = await seedScene(jobId, 1, { validatedAt: new Date("2026-06-02T00:00:00.000Z") });

      const runner = new ValidatedSceneDeliveryRunner({
        repository,
        context: () => ctx({ correlationId: "corr_runner" }),
      });
      const report = await runner.runOnce(50);

      expect(report.delivered).toBe(2);
      expect(report.jobsAdvanced).toBe(1);
      expect((await snapshot(first)).requestState).toBe("DELIVERED");
      expect((await snapshot(second)).jobState).toBe("SCENES_READY");

      // A second pass finds nothing left to do.
      expect(await runner.runOnce(50)).toMatchObject({ delivered: 0, jobsAdvanced: 0 });
    });
  });

  // -------------------------------------------------------------------------

  describe("two workers finishing the last two Scenes at once", () => {
    it("produces exactly one SCENES_READY, ordered by the Job lock", async () => {
      // The synchronisation is a PostgreSQL row lock, not a timer. A third
      // session takes `FOR UPDATE` on the Job row and holds its transaction
      // open; both workers then block on that same row inside their own
      // `lockChainForTenant`. Only once both are provably blocked is the holder
      // released, so the two deliveries race for real with PostgreSQL — not a
      // sleep — deciding the order.
      //
      // Without the Job lock both workers would count "one Scene still
      // generating" from the same snapshot and neither would advance the Job.
      const jobId = await seedJob();
      const first = await seedScene(jobId, 0);
      const second = await seedScene(jobId, 1);

      const options = { transactionOptions: { timeout: 25_000, maxWait: 25_000 } };
      const holder = new PrismaClient(options);
      const workerA = new PrismaClient(options);
      const workerB = new PrismaClient(options);

      let releaseHolder!: () => void;
      const holderMayRollBack = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      // The holder must own the Job row *before* either worker starts. Starting
      // them together is a race of its own: if a worker wins the row the holder
      // blocks instead, that worker finishes immediately, and only one backend
      // is ever waiting.
      let holderHasLock!: () => void;
      const holderReady = new Promise<void>((resolve) => {
        holderHasLock = resolve;
      });

      /** How many backends are currently waiting on a lock in this database. */
      async function blockedBackends(): Promise<number> {
        const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
          `SELECT wait_event_type FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        return rows.filter((r) => r.wait_event_type === "Lock").length;
      }

      const holderDone = holder
        .$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "generation_jobs" WHERE "id" = $1 FOR UPDATE`,
            jobId,
          );
          holderHasLock();
          await holderMayRollBack;
          throw new Error("rollback-holder");
        })
        .catch(() => undefined);

      type Settled =
        | { readonly ok: true; readonly value: Awaited<ReturnType<typeof deliver>> }
        | { readonly ok: false; readonly error: unknown };

      const settled = [false, false];
      const run = (client: PrismaClient, attemptId: string, index: number): Promise<Settled> =>
        createValidatedSceneDeliveryRepository(client)
          .deliverValidatedScene({
            organizationId: ORG_A,
            sceneGenerationId: attemptId,
            context: ctx({ correlationId: `corr_race_${index}` }),
          })
          .then(
            (value): Settled => {
              settled[index] = true;
              return { ok: true, value };
            },
            (error: unknown): Settled => {
              settled[index] = true;
              return { ok: false, error };
            },
          );

      await holderReady;
      const runA = run(workerA, first.attemptId, 0);
      const runB = run(workerB, second.attemptId, 1);

      let blockedSeen = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await blockedBackends()) >= 2) {
          blockedSeen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(blockedSeen).toBe(true);
      expect(settled).toEqual([false, false]);
      // Nothing committed while the holder owns the Job row.
      expect(await prisma.generationTransitionEvent.count()).toBe(0);

      releaseHolder();
      await holderDone;

      const results = await Promise.all([runA, runB]);
      for (const result of results) {
        if (!result.ok) {
          throw new Error(
            `delivery rejected instead of resolving: ${String(
              (result.error as { code?: unknown; message?: unknown }).code ??
                (result.error as { message?: unknown }).message ??
                result.error,
            )}`,
          );
        }
      }

      const outcomes = results.map((r) => (r.ok ? r.value : null)).filter((v) => v !== null);
      expect(outcomes.every((o) => o.kind === "DELIVERED")).toBe(true);
      const advanced = outcomes.filter((o) => o.kind === "DELIVERED" && o.jobAdvanced);
      expect(advanced).toHaveLength(1);

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.state).toBe("SCENES_READY");
      // Advanced once, not twice.
      expect(job.stateVersion).toBe(1);
      expect(
        await prisma.generationTransitionEvent.count({
          where: { aggregateType: "JOB", aggregateId: jobId },
        }),
      ).toBe(1);

      await Promise.all([holder.$disconnect(), workerA.$disconnect(), workerB.$disconnect()]);
    });
  });
});
