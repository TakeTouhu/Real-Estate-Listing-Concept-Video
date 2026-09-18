import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AutomaticMediaFailureRecoveryRunner,
  AutomaticMediaRecoveryPricingPlanner,
  MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST,
  MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON,
  MEDIA_INVALID_SYSTEM_RECOVERY_REASON,
  MEDIA_RECOVERY_ADMITTED_EVENT_TYPE,
  computeGenerationRequestHash,
  createProviderPricingCatalog,
  epochMillisFromDate,
  usedUserRegenerationCount,
  type AutomaticMediaRecoveryCandidate,
  type AutomaticMediaRecoveryPlan,
  type FxRateSource,
  type FxSnapshot,
} from "@app/domain";
import { AppError } from "@app/shared";
import { createVideoModelCatalog } from "@app/video-providers";
import { createAutomaticMediaRecoveryRepository } from "@app/database";
import {
  attemptInput,
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_B,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Bounded automatic media-failure recovery against live PostgreSQL.
 *
 * The source attempt is admitted through the **real** generic admission path,
 * so its pricing snapshot, request hash and route are canonical rather than
 * hand-written — a recovery that reproduces a hand-built row would prove
 * nothing about reproducing a real one. It is then driven to `OUTPUT_VERIFIED`
 * and given a durable terminal media verdict.
 *
 * Nothing here calls a provider, reads an object store or runs `ffprobe`. The
 * exchange rate comes from a deterministic fake source; no rate provider is
 * production-wired.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = createAutomaticMediaRecoveryRepository(prisma);
const repos = repositories(prisma);

const DIGEST = "e".repeat(64);
const SIZE = 5_120_000;
/** The planning instant every test plans at. Inside the catalog's window. */
const PLANNING_AT = new Date("2026-09-10T00:00:00.000Z");

const RATE: FxSnapshot = {
  id: "fx_recovery_test",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(PLANNING_AT),
  sourceReference: null,
};

/** Deterministic, offline. No network FX integration exists. */
function fakeFx(rate: FxSnapshot | null = RATE): FxRateSource {
  return { current: async () => rate };
}

function planner(fx: FxRateSource = fakeFx()) {
  return new AutomaticMediaRecoveryPricingPlanner({
    models: createVideoModelCatalog(),
    pricing: createProviderPricingCatalog(),
    clock: () => epochMillisFromDate(PLANNING_AT),
    fx,
  });
}

interface Chain {
  readonly jobId: string;
  readonly sceneId: string;
  readonly requestId: string;
  readonly sourceAttemptId: string;
  readonly validationId: string;
}

let seq = 0;

/**
 * A request whose latest attempt is `OUTPUT_VERIFIED` and carries a terminal
 * media verdict.
 *
 * `kind` chooses which failure. `regeneration` builds the `USER_REGENERATION`
 * shape instead, complete with a delivered predecessor.
 */
async function seedFailedAttempt(
  options: {
    readonly failure?: "INVALID_MEDIA" | "INTEGRITY_MISMATCH" | "VALID" | "PENDING" | "RUNNING";
    readonly invalidReason?: string;
    readonly organizationId?: string;
    readonly orchestrationState?: string;
    readonly receiptSha256?: string;
    readonly receiptSizeBytes?: number;
    readonly validatedAt?: Date;
    readonly regeneration?: boolean;
  } = {},
): Promise<Chain> {
  seq += 1;
  const tag = `amr${seq}`;
  const organizationId = options.organizationId ?? ORG_A;
  const { job, scene, request } = await seedChain(
    prisma,
    tag,
    organizationId,
    organizationId === ORG_A ? undefined : PROJECT_B,
  );

  let requestId = request.id;
  if (options.regeneration === true) {
    // The predecessor the regeneration replaces: delivered, on this Scene.
    await prisma.sceneGenerationRequest.update({
      where: { id: request.id },
      data: { state: "DELIVERED", deliveredAt: new Date("2026-08-01T00:00:00.000Z") },
    });
    await prisma.generationScene.update({
      where: { id: scene.id },
      data: { state: "REVISING", currentDeliveredRequestId: request.id },
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
  }

  // Each chain gets distinct scene facts, so each derives a distinct request
  // hash. Without this, two chains in one project share a hash and their two
  // QUEUED recovery attempts collide on the partial unique index that enforces
  // "at most one active attempt per (project, request identity)" — a real
  // product invariant that the fixture, not the code under test, would be
  // violating.
  await prisma.generationScene.update({
    where: { id: scene.id },
    data: { snapshotCompiledPrompt: `a sunlit living room, cinematic, ${tag}` },
  });

  // The real admission path: canonical pricing snapshot, request hash and route.
  const attemptId = `sgen_${tag}`;
  const admitted = await repos.attempts.admit(
    organizationId,
    attemptInput({ id: attemptId, generationSceneRequestId: requestId }),
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`source not admitted: ${admitted.kind}`);

  // Drive it to a verified managed output. The intervening submission and
  // polling edges have their own suites; reaching them here would add nothing.
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
  // The Job and Scene are generating while an attempt is in flight. Those
  // edges belong to other transactions; reaching them here would add nothing to
  // a test about recovery admission.
  await prisma.generationJob.update({ where: { id: job.id }, data: { state: "GENERATING" } });
  if (options.regeneration !== true) {
    await prisma.generationScene.update({
      where: { id: scene.id },
      data: { state: "GENERATING" },
    });
  }

  const validationId = `momv_${tag}`;
  const failure = options.failure ?? "INVALID_MEDIA";
  const terminal = failure !== "PENDING" && failure !== "RUNNING";
  await prisma.managedOutputMediaValidation.create({
    data: {
      id: validationId,
      sceneGenerationId: attemptId,
      status: failure as never,
      receiptSha256: options.receiptSha256 ?? DIGEST,
      receiptSizeBytes: BigInt(options.receiptSizeBytes ?? SIZE),
      ...(failure === "RUNNING"
        ? { leaseToken: `lease_${tag}`, leaseExpiresAt: new Date(Date.now() + 60_000) }
        : {}),
      ...(failure === "INVALID_MEDIA"
        ? { invalidReason: (options.invalidReason ?? "PROBE_REJECTED") as never }
        : {}),
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

  if (options.orchestrationState !== undefined) {
    await prisma.sceneGeneration.update({
      where: { id: attemptId },
      data: { orchestrationState: options.orchestrationState as never },
    });
  }

  return {
    jobId: job.id,
    sceneId: scene.id,
    requestId,
    sourceAttemptId: attemptId,
    validationId,
  };
}

/** Plan and admit exactly as the runner would, but callable per test. */
async function recover(
  chain: Chain,
  options: { readonly organizationId?: string; readonly fx?: FxRateSource } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const candidates = await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 });
  const candidate = candidates.find((one) => one.sourceAttemptId === chain.sourceAttemptId);
  const plan = await planner(options.fx ?? fakeFx()).plan(
    candidate ?? (await syntheticCandidate(chain, organizationId)),
  );
  if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);
  seq += 1;
  return repository.admitAutomaticMediaRecovery({
    organizationId,
    sourceAttemptId: chain.sourceAttemptId,
    sourceValidationId: chain.validationId,
    attemptId: `sgen_rec_${seq}`,
    pricingSnapshotId: `price_rec_${seq}`,
    pricingSnapshot: plan.pricingSnapshot,
    fxSnapshot: RATE,
    context: ctx({ correlationId: `corr_rec_${seq}` }),
  });
}

/**
 * A candidate built directly from the row, for cases the sweep deliberately
 * excludes but the transaction must still refuse on its own authority.
 */
async function syntheticCandidate(
  chain: Chain,
  organizationId: string,
): Promise<AutomaticMediaRecoveryCandidate> {
  const attempt = await prisma.sceneGeneration.findUniqueOrThrow({
    where: { id: chain.sourceAttemptId },
  });
  const pricing = await prisma.generationPricingSnapshot.findUniqueOrThrow({
    where: { sceneGenerationId: chain.sourceAttemptId },
  });
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } });
  const scene = await prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } });
  return {
    organizationId,
    sourceValidationId: chain.validationId,
    sourceAttemptId: chain.sourceAttemptId,
    generationSceneRequestId: chain.requestId,
    mediaFailureKind: "INVALID_MEDIA",
    route: {
      providerName: attempt.providerName,
      providerModelId: attempt.providerModelId,
      requestModelKey: attempt.requestModelKey ?? "",
      requestNativeGenerationResolution: attempt.requestNativeGenerationResolution ?? "",
      requestResolutionNormalization: attempt.requestResolutionNormalization ?? "",
      requestNativeMeetsTarget: attempt.requestNativeMeetsTarget ?? false,
    },
    targetOutputResolution: job.targetOutputResolution,
    sceneDurationSeconds: scene.snapshotDurationSeconds,
    jobQualityTier: job.qualityTier,
    persistedPricingIdentity: pricing.identityJson,
    persistedPricingContractFingerprint: pricing.contractFingerprint,
  };
}

/** Everything a freeze proof must show unchanged. */
async function frozen(chain: Chain) {
  const [request, scene, job, reservations, sourceAttempt, validation] = await Promise.all([
    prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: chain.requestId } }),
    prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } }),
    prisma.generationJob.findUniqueOrThrow({ where: { id: chain.jobId } }),
    prisma.generationReservation.findMany({ orderBy: { id: "asc" } }),
    prisma.sceneGeneration.findUniqueOrThrow({ where: { id: chain.sourceAttemptId } }),
    prisma.managedOutputMediaValidation.findUniqueOrThrow({ where: { id: chain.validationId } }),
  ]);
  return {
    requestState: request.state,
    requestDeliveredAt: request.deliveredAt,
    requestOrdinal: request.userRegenerationOrdinal,
    sceneState: scene.state,
    scenePointer: scene.currentDeliveredRequestId,
    jobState: job.state,
    reservations,
    sourceAttempt,
    validation,
  };
}

async function attemptsOf(requestId: string) {
  return prisma.sceneGeneration.findMany({
    where: { generationSceneRequestId: requestId },
    orderBy: { attemptOrdinal: "asc" },
  });
}

RUN("bounded automatic media-failure SYSTEM_RECOVERY admission", () => {
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

  describe("the admitted recovery attempt", () => {
    for (const failure of ["INVALID_MEDIA", "INTEGRITY_MISMATCH"] as const) {
      it(`admits exactly one SYSTEM_RECOVERY for ${failure}`, async () => {
        const chain = await seedFailedAttempt({ failure });
        const source = await prisma.sceneGeneration.findUniqueOrThrow({
          where: { id: chain.sourceAttemptId },
        });

        const outcome = await recover(chain);
        expect(outcome.kind).toBe("ADMITTED");

        const attempts = await attemptsOf(chain.requestId);
        expect(attempts).toHaveLength(2);
        const recovery = attempts[1];
        if (recovery === undefined) throw new Error("expected a recovery attempt");

        // Same request — no new customer request was created.
        expect(recovery.generationSceneRequestId).toBe(chain.requestId);
        expect(recovery.attemptKind).toBe("SYSTEM_RECOVERY");
        expect(recovery.attemptOrdinal).toBe((source.attemptOrdinal ?? 0) + 1);
        expect(recovery.orchestrationState).toBe("QUEUED");
        expect(recovery.submissionCertainty).toBe("PRE_SUBMISSION");
        expect(recovery.providerPredictionId).toBeNull();
        expect(recovery.submissionBoundaryEnteredAt).toBeNull();

        // The same execution route, copied exactly.
        expect(recovery.providerName).toBe(source.providerName);
        expect(recovery.providerModelId).toBe(source.providerModelId);
        expect(recovery.requestModelKey).toBe(source.requestModelKey);
        expect(recovery.requestNativeGenerationResolution).toBe(
          source.requestNativeGenerationResolution,
        );
        expect(recovery.requestResolutionNormalization).toBe(
          source.requestResolutionNormalization,
        );
        expect(recovery.requestNativeMeetsTarget).toBe(source.requestNativeMeetsTarget);
        // The customer's exact rendered prompt is retried, not re-rendered.
        expect(recovery.requestRenderedPrompt).toBe(source.requestRenderedPrompt);

        // The request identity is re-derived canonically and, for an unchanged
        // route, must equal the source's — never copied from it.
        expect(recovery.requestHash).toBe(source.requestHash);
        expect(recovery.requestHash).toBe(
          computeGenerationRequestHash({
            assetId: source.assetId,
            compiledPrompt: source.requestCompiledPrompt ?? "",
            durationSeconds: source.requestDurationSeconds ?? 0,
            cameraMotion: source.requestCameraMotion,
            aspectRatio: source.requestAspectRatio ?? "",
            targetOutputResolution: source.requestTargetOutputResolution ?? "",
            nativeGenerationResolution: source.requestNativeGenerationResolution ?? "",
            resolutionNormalization: source.requestResolutionNormalization ?? "",
            nativeMeetsTarget: source.requestNativeMeetsTarget ?? false,
            modelKey: source.requestModelKey ?? "",
            providerName: source.providerName,
            providerModelId: source.providerModelId,
          } as never),
        );
      });
    }

    it("records why the recovery exists, in application-owned vocabulary", async () => {
      const invalid = await seedFailedAttempt({ failure: "INVALID_MEDIA" });
      const mismatch = await seedFailedAttempt({ failure: "INTEGRITY_MISMATCH" });
      const first = await recover(invalid);
      const second = await recover(mismatch);
      if (first.kind !== "ADMITTED" || second.kind !== "ADMITTED") {
        throw new Error("expected both recoveries");
      }

      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateType: "ATTEMPT", aggregateId: { in: [first.attemptId, second.attemptId] } },
      });
      expect(events).toHaveLength(2);
      const byId = new Map(events.map((e) => [e.aggregateId, e]));
      expect(byId.get(first.attemptId)?.reasonCode).toBe(MEDIA_INVALID_SYSTEM_RECOVERY_REASON);
      expect(byId.get(second.attemptId)?.reasonCode).toBe(
        MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON,
      );
      for (const event of events) {
        expect(event.eventType).toBe(MEDIA_RECOVERY_ADMITTED_EVENT_TYPE);
        expect(event.toState).toBe("QUEUED");
        expect(event.fromState).toBeNull();
        // No probe output, no invalid reason object, no prompt, no key, no URL.
        expect(JSON.stringify(event.safeMetadata ?? {})).not.toMatch(
          /PROBE_REJECTED|sunlit|org\/|https?:|e{10}/,
        );
      }
    });

    it("prices the retry freshly instead of copying historical cost", async () => {
      const chain = await seedFailedAttempt();
      const sourcePricing = await prisma.generationPricingSnapshot.findUniqueOrThrow({
        where: { sceneGenerationId: chain.sourceAttemptId },
      });

      const outcome = await recover(chain);
      if (outcome.kind !== "ADMITTED") throw new Error("expected admission");

      const recoveryPricing = await prisma.generationPricingSnapshot.findUniqueOrThrow({
        where: { sceneGenerationId: outcome.attemptId },
      });
      expect(recoveryPricing.id).not.toBe(sourcePricing.id);
      expect(recoveryPricing.sceneGenerationId).toBe(outcome.attemptId);
      // The planning instant, not the source's.
      expect(recoveryPricing.pricingEffectiveAtEpochMs).toBe(
        BigInt(epochMillisFromDate(PLANNING_AT)),
      );
      expect(recoveryPricing.pricingEffectiveAtEpochMs).not.toBe(
        sourcePricing.pricingEffectiveAtEpochMs,
      );
      // Derived from the Job's tier and the Scene's duration.
      expect(recoveryPricing.riskProfileKey).toBe("HIGH_QUALITY_AI");
      expect(recoveryPricing.requestedSeconds).toBe(5);
      // The fresh decision carries the rate, so the attempt can be armed later.
      expect(recoveryPricing.fxSnapshotId).toBe(RATE.id);
      expect(sourcePricing.fxSnapshotId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe("the cost circuit breaker", () => {
    it("is one automatic recovery per request", () => {
      expect(MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST).toBe(1);
    });

    it("refuses a second automatic recovery when the recovery itself fails", async () => {
      const chain = await seedFailedAttempt();
      const first = await recover(chain);
      if (first.kind !== "ADMITTED") throw new Error("expected admission");

      // The recovery attempt itself reaches a terminal media failure.
      await prisma.sceneGeneration.update({
        where: { id: first.attemptId },
        data: {
          submissionCertainty: "ACCEPTED",
          providerPredictionId: `pred_rec_${first.attemptId}`,
          providerAcceptedAt: new Date("2026-09-11T00:00:00.000Z"),
          submissionBoundaryEnteredAt: new Date("2026-09-11T00:00:00.000Z"),
          orchestrationState: "OUTPUT_VERIFIED",
          outputStorageKey: `org/${ORG_A}/generated/${first.attemptId}/output`,
          outputSha256: DIGEST,
          outputSizeBytes: BigInt(SIZE),
          outputVerifiedAt: new Date("2026-09-12T00:00:00.000Z"),
        },
      });
      await prisma.managedOutputMediaValidation.create({
        data: {
          id: `momv_rec_${first.attemptId}`,
          sceneGenerationId: first.attemptId,
          status: "INVALID_MEDIA",
          invalidReason: "PROBE_REJECTED",
          receiptSha256: DIGEST,
          receiptSizeBytes: BigInt(SIZE),
          validatedAt: new Date("2026-09-13T00:00:00.000Z"),
        },
      });

      const before = await frozen(chain);
      const second = await repository.admitAutomaticMediaRecovery({
        organizationId: ORG_A,
        sourceAttemptId: first.attemptId,
        sourceValidationId: `momv_rec_${first.attemptId}`,
        attemptId: "sgen_rec_second",
        pricingSnapshotId: "price_rec_second",
        pricingSnapshot: (await planFor(chain)).pricingSnapshot,
        fxSnapshot: RATE,
        context: ctx({ correlationId: "corr_rec_second" }),
      });

      expect(second).toEqual({ kind: "RECOVERY_LIMIT_REACHED" });
      expect(await attemptsOf(chain.requestId)).toHaveLength(2);
      // An operational outcome only: nothing is terminalized.
      expect(await frozen(chain)).toEqual(before);
      // And the spent-cap row never occupies the sweep.
      const listed = await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 });
      expect(listed).toEqual([]);
    });

    it("recognizes a superseded source rather than treating it as eligible", async () => {
      // Structural note worth stating: in this module "the source is superseded"
      // and "the cap is spent" are the same condition. Every newer attempt on a
      // request is necessarily a SYSTEM_RECOVERY, because one PRIMARY per
      // request is a unique index — so a source that is no longer latest always
      // has a recovery sibling, and the answer is idempotent recognition rather
      // than an eligibility failure.
      const chain = await seedFailedAttempt();
      const first = await recover(chain);
      if (first.kind !== "ADMITTED") throw new Error("expected admission");

      const source = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: chain.sourceAttemptId },
      });
      const recovery = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: first.attemptId },
      });
      // The source really is no longer the latest attempt.
      expect(recovery.attemptOrdinal).toBeGreaterThan(source.attemptOrdinal ?? 0);
      expect(recovery.attemptKind).toBe("SYSTEM_RECOVERY");

      const before = await frozen(chain);
      expect(await recoverRaw(chain)).toEqual({ kind: "ALREADY_RECOVERED" });
      expect(await attemptsOf(chain.requestId)).toHaveLength(2);
      expect(await frozen(chain)).toEqual(before);
      // And it is gone from the sweep, so it cannot occupy the bound.
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
    });

    it("reports a replay against the original source as already recovered", async () => {
      const chain = await seedFailedAttempt();
      const first = await recover(chain);
      if (first.kind !== "ADMITTED") throw new Error("expected admission");
      const before = await frozen(chain);
      const pricingRows = await prisma.generationPricingSnapshot.count();
      const events = await prisma.generationTransitionEvent.count();

      const replay = await recover(chain);

      expect(replay).toEqual({ kind: "ALREADY_RECOVERED" });
      expect(await attemptsOf(chain.requestId)).toHaveLength(2);
      expect(await prisma.generationPricingSnapshot.count()).toBe(pricingRows);
      expect(await prisma.generationTransitionEvent.count()).toBe(events);
      expect(await frozen(chain)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------

  describe("only a terminal media failure recovers", () => {
    for (const failure of ["VALID", "PENDING", "RUNNING"] as const) {
      it(`refuses ${failure} and writes nothing`, async () => {
        const chain = await seedFailedAttempt({ failure });
        const before = await frozen(chain);

        expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
        const outcome = await repository.admitAutomaticMediaRecovery({
          organizationId: ORG_A,
          sourceAttemptId: chain.sourceAttemptId,
          sourceValidationId: chain.validationId,
          attemptId: "sgen_never",
          pricingSnapshotId: "price_never",
          pricingSnapshot: (await planFor(chain)).pricingSnapshot,
          fxSnapshot: RATE,
          context: ctx(),
        });

        expect(outcome).toEqual({ kind: "NOT_ELIGIBLE" });
        expect(await attemptsOf(chain.requestId)).toHaveLength(1);
        expect(await frozen(chain)).toEqual(before);
      });
    }

    for (const reason of [
      "CONTAINER_UNSUPPORTED",
      "VIDEO_STREAM_MISSING",
      "VIDEO_DIMENSIONS_INVALID",
      "DURATION_INVALID",
      "PROBE_REJECTED",
    ] as const) {
      it(`treats INVALID_MEDIA/${reason} under the one same-route policy`, async () => {
        const chain = await seedFailedAttempt({ failure: "INVALID_MEDIA", invalidReason: reason });
        const outcome = await recover(chain);
        expect(outcome.kind).toBe("ADMITTED");
        const attempts = await attemptsOf(chain.requestId);
        expect(attempts[1]?.attemptKind).toBe("SYSTEM_RECOVERY");
        // One policy, not five: the same route every time.
        expect(attempts[1]?.providerModelId).toBe(attempts[0]?.providerModelId);
      });
    }

    it("refuses a source that is not OUTPUT_VERIFIED", async () => {
      const chain = await seedFailedAttempt({ orchestrationState: "PROCESSING" });
      const before = await frozen(chain);

      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await frozen(chain)).toEqual(before);
    });

    it("fails closed when the verdict is bound to different bytes", async () => {
      const chain = await seedFailedAttempt({ receiptSha256: "f".repeat(64) });
      const before = await frozen(chain);

      await expect(recoverRaw(chain)).rejects.toMatchObject({
        code: "SOURCE_RECEIPT_BINDING_CONFLICT",
      });
      expect(await attemptsOf(chain.requestId)).toHaveLength(1);
      expect(await frozen(chain)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------

  describe("the customer-facing chain must be exactly where it was", () => {
    it("refuses a request that is no longer GENERATING", async () => {
      const chain = await seedFailedAttempt();
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.requestId },
        data: { state: "CANCELLED" },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await attemptsOf(chain.requestId)).toHaveLength(1);
    });

    it("refuses a Job that is no longer GENERATING", async () => {
      const chain = await seedFailedAttempt();
      await prisma.generationJob.update({
        where: { id: chain.jobId },
        data: { state: "CANCELLED" },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
      expect(await attemptsOf(chain.requestId)).toHaveLength(1);
    });

    it("refuses an INITIAL whose Scene is not GENERATING", async () => {
      const chain = await seedFailedAttempt();
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { state: "REVISING" },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
    });

    it("recovers a USER_REGENERATION with a delivered predecessor", async () => {
      const chain = await seedFailedAttempt({ regeneration: true });
      const before = await frozen(chain);

      const outcome = await recover(chain);
      expect(outcome.kind).toBe("ADMITTED");

      const after = await frozen(chain);
      // The regeneration request itself is untouched beyond gaining an attempt.
      expect(after.requestState).toBe("GENERATING");
      expect(after.sceneState).toBe("REVISING");
      expect(after.scenePointer).toBe(before.scenePointer);
      expect(after.jobState).toBe("GENERATING");
      expect(after.requestOrdinal).toBe(before.requestOrdinal);
    });

    it("refuses a USER_REGENERATION whose Scene is not REVISING", async () => {
      const chain = await seedFailedAttempt({ regeneration: true });
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { state: "GENERATING" },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
    });

    it("refuses a USER_REGENERATION with no delivered predecessor", async () => {
      const chain = await seedFailedAttempt({ regeneration: true });
      await prisma.generationScene.update({
        where: { id: chain.sceneId },
        data: { currentDeliveredRequestId: null },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
    });

    it("refuses a USER_REGENERATION whose predecessor never delivered", async () => {
      const chain = await seedFailedAttempt({ regeneration: true });
      const scene = await prisma.generationScene.findUniqueOrThrow({ where: { id: chain.sceneId } });
      const predecessor = scene.currentDeliveredRequestId;
      if (predecessor === null) throw new Error("expected a predecessor");
      await prisma.sceneGenerationRequest.update({
        where: { id: predecessor },
        data: { state: "FAILED_TERMINAL", deliveredAt: null },
      });
      expect(await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 })).toEqual([]);
      expect(await recoverRaw(chain)).toEqual({ kind: "NOT_ELIGIBLE" });
    });
  });

  // -------------------------------------------------------------------------

  describe("what recovery never touches", () => {
    it("leaves request, Scene, Job, reservation and entitlement exactly as they were", async () => {
      const chain = await seedFailedAttempt();
      await prisma.generationReservation.create({
        data: {
          id: `genres_${chain.jobId}`,
          generationJobId: chain.jobId,
          state: "RESERVED",
          billingCycleKey: "2026-09",
          reservedTotalVideoUnits: 2,
          reservedHighQualityUnits: 2,
          billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
          billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      const before = await frozen(chain);
      const entitlementBefore = usedUserRegenerationCount(
        (await prisma.sceneGenerationRequest.findMany({
          where: { generationSceneId: chain.sceneId },
        })) as never,
      );
      const requestsBefore = await prisma.sceneGenerationRequest.count();

      const outcome = await recover(chain);
      expect(outcome.kind).toBe("ADMITTED");

      const after = await frozen(chain);
      expect(after.requestState).toBe("GENERATING");
      expect(after.requestDeliveredAt).toBeNull();
      expect(after.sceneState).toBe(before.sceneState);
      expect(after.scenePointer).toBe(before.scenePointer);
      expect(after.jobState).toBe("GENERATING");
      expect(after.reservations).toEqual(before.reservations);
      // The source attempt and its verdict are historical evidence.
      expect(after.sourceAttempt).toEqual(before.sourceAttempt);
      expect(after.validation).toEqual(before.validation);
      // No new customer request, and no entitlement was spent.
      expect(await prisma.sceneGenerationRequest.count()).toBe(requestsBefore);
      expect(
        usedUserRegenerationCount(
          (await prisma.sceneGenerationRequest.findMany({
            where: { generationSceneId: chain.sceneId },
          })) as never,
        ),
      ).toBe(entitlementBefore);
      // No quota and no deliverable history.
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateType: "RESERVATION" } }),
      ).toBe(0);
      expect(
        await prisma.generationTransitionEvent.count({ where: { aggregateType: "DELIVERABLE" } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy and the bounded sweep", () => {
    it("reports another organization's source as not found", async () => {
      const chain = await seedFailedAttempt();
      const before = await frozen(chain);
      const outcome = await repository.admitAutomaticMediaRecovery({
        organizationId: ORG_B,
        sourceAttemptId: chain.sourceAttemptId,
        sourceValidationId: chain.validationId,
        attemptId: "sgen_cross",
        pricingSnapshotId: "price_cross",
        pricingSnapshot: (await planFor(chain)).pricingSnapshot,
        fxSnapshot: RATE,
        context: ctx(),
      });
      expect(outcome).toEqual({ kind: "NOT_FOUND" });
      expect(await frozen(chain)).toEqual(before);
    });

    it("orders by verdict time then id, and honours the bound", async () => {
      const third = await seedFailedAttempt({ validatedAt: new Date("2026-09-05T00:00:00.000Z") });
      const first = await seedFailedAttempt({ validatedAt: new Date("2026-09-03T00:00:00.000Z") });
      const second = await seedFailedAttempt({ validatedAt: new Date("2026-09-04T00:00:00.000Z") });

      const all = await repository.findAutomaticMediaRecoveryCandidates({ limit: 100 });
      expect(all.map((one) => one.sourceAttemptId)).toEqual([
        first.sourceAttemptId,
        second.sourceAttemptId,
        third.sourceAttemptId,
      ]);

      const bounded = await repository.findAutomaticMediaRecoveryCandidates({ limit: 2 });
      expect(bounded.map((one) => one.sourceAttemptId)).toEqual([
        first.sourceAttemptId,
        second.sourceAttemptId,
      ]);
    });

    it("refuses an unusable bound rather than clamping it", async () => {
      await expect(
        repository.findAutomaticMediaRecoveryCandidates({ limit: 0 }),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        repository.findAutomaticMediaRecoveryCandidates({ limit: 101 }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it("never lets a spent-cap row starve the bound", async () => {
      // A request whose recovery is already spent, with the oldest verdict.
      const spent = await seedFailedAttempt({ validatedAt: new Date("2026-09-01T00:00:00.000Z") });
      const admitted = await recover(spent);
      if (admitted.kind !== "ADMITTED") throw new Error("expected admission");
      // A genuinely recoverable request behind it.
      const fresh = await seedFailedAttempt({ validatedAt: new Date("2026-09-06T00:00:00.000Z") });

      const bounded = await repository.findAutomaticMediaRecoveryCandidates({ limit: 1 });
      expect(bounded.map((one) => one.sourceAttemptId)).toEqual([fresh.sourceAttemptId]);
    });

    it("carries no customer prompt in a planning candidate", async () => {
      await seedFailedAttempt();
      const [candidate] = await repository.findAutomaticMediaRecoveryCandidates({ limit: 1 });
      if (candidate === undefined) throw new Error("expected a candidate");
      expect(JSON.stringify(candidate)).not.toMatch(/sunlit|cinematic|org\/|https?:/);
    });
  });

  // -------------------------------------------------------------------------

  describe("the dormant runner against a live database", () => {
    it("plans outside the transaction and admits one recovery per candidate", async () => {
      const chain = await seedFailedAttempt();
      let planned = 0;
      const runner = new AutomaticMediaFailureRecoveryRunner({
        repository,
        planner: {
          async plan(candidate) {
            planned += 1;
            // Proof the planner runs with no transaction open: an independent
            // client can read and write freely while planning is in flight.
            await prisma.$queryRaw`SELECT 1`;
            return planner().plan(candidate);
          },
        },
        ids: {
          nextAttemptId: () => "sgen_runner_recovery",
          nextPricingSnapshotId: () => "price_runner_recovery",
        },
        context: () => ctx({ correlationId: "corr_runner_recovery" }),
      });

      const report = await runner.runOnce(50);
      expect(report.admitted).toBe(1);
      expect(report.noPlan).toBe(0);
      expect(planned).toBe(1);
      expect(await attemptsOf(chain.requestId)).toHaveLength(2);

      // A second pass finds nothing: the cap is spent.
      expect(await runner.runOnce(50)).toMatchObject({ admitted: 0, noPlan: 0 });
    });

    it("reports a candidate it cannot safely plan instead of admitting it", async () => {
      const chain = await seedFailedAttempt();
      const runner = new AutomaticMediaFailureRecoveryRunner({
        repository,
        // No usable rate: a recovery that could never be armed is not planned.
        planner: planner(fakeFx(null)),
        ids: {
          nextAttemptId: () => "sgen_never_planned",
          nextPricingSnapshotId: () => "price_never_planned",
        },
        context: () => ctx(),
      });

      const report = await runner.runOnce(50);
      expect(report.admitted).toBe(0);
      expect(report.noPlan).toBe(1);
      expect(report.outcomes[0]?.result).toEqual({
        kind: "NO_PLAN",
        code: "NO_SAFE_CURRENT_PRICING",
      });
      expect(await attemptsOf(chain.requestId)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------

  describe("two workers on the same terminal failure", () => {
    it("admits exactly one recovery, ordered by the request lock", async () => {
      // The synchronisation is a PostgreSQL row lock, not a timer. A holder
      // takes `FOR UPDATE` on the parent request and keeps its transaction
      // open; both workers then block inside their own chain lock. Only once
      // both are provably blocked is the holder released.
      const chain = await seedFailedAttempt();
      const plan = await planFor(chain);

      const options = { transactionOptions: { timeout: 25_000, maxWait: 25_000 } };
      const holder = new PrismaClient(options);
      const workerA = new PrismaClient(options);
      const workerB = new PrismaClient(options);

      let releaseHolder!: () => void;
      const holderMayRollBack = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderHasLock!: () => void;
      const holderReady = new Promise<void>((resolve) => {
        holderHasLock = resolve;
      });

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
            `SELECT "id" FROM "scene_generation_requests" WHERE "id" = $1 FOR UPDATE`,
            chain.requestId,
          );
          holderHasLock();
          await holderMayRollBack;
          throw new Error("rollback-holder");
        })
        .catch(() => undefined);

      type Settled =
        | { readonly ok: true; readonly value: Awaited<ReturnType<typeof recoverRaw>> }
        | { readonly ok: false; readonly error: unknown };

      const settled = [false, false];
      const run = (client: PrismaClient, index: number): Promise<Settled> =>
        createAutomaticMediaRecoveryRepository(client)
          .admitAutomaticMediaRecovery({
            organizationId: ORG_A,
            sourceAttemptId: chain.sourceAttemptId,
            sourceValidationId: chain.validationId,
            attemptId: `sgen_race_${index}`,
            pricingSnapshotId: `price_race_${index}`,
            pricingSnapshot: plan.pricingSnapshot,
            fxSnapshot: RATE,
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
      const runA = run(workerA, 0);
      const runB = run(workerB, 1);

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
      expect(await attemptsOf(chain.requestId)).toHaveLength(1);

      releaseHolder();
      await holderDone;

      const results = await Promise.all([runA, runB]);
      for (const result of results) {
        if (!result.ok) {
          throw new Error(
            `admission rejected instead of resolving: ${String(
              (result.error as { code?: unknown; message?: unknown }).code ??
                (result.error as { message?: unknown }).message ??
                result.error,
            )}`,
          );
        }
      }
      const kinds = results.map((r) => (r.ok ? r.value.kind : "")).sort();
      expect(kinds).toEqual(["ADMITTED", "ALREADY_RECOVERED"]);

      // Exactly one recovery attempt, one pricing snapshot, one ordinal step.
      const attempts = await attemptsOf(chain.requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.attemptOrdinal).toBe(2);
      expect(
        await prisma.generationPricingSnapshot.count({
          where: { sceneGenerationId: attempts[1]?.id },
        }),
      ).toBe(1);
      expect(
        await prisma.generationTransitionEvent.count({
          where: { aggregateType: "ATTEMPT", aggregateId: attempts[1]?.id },
        }),
      ).toBe(1);

      await Promise.all([holder.$disconnect(), workerA.$disconnect(), workerB.$disconnect()]);
    });
  });
});

/** Plan for a chain without going through the sweep. */
async function planFor(chain: Chain): Promise<Extract<AutomaticMediaRecoveryPlan, { kind: "PLANNED" }>> {
  const plan = await planner().plan(await syntheticCandidate(chain, ORG_A));
  if (plan.kind !== "PLANNED") throw new Error(`expected a plan, got ${plan.code}`);
  return plan;
}

/** Admit directly, bypassing the sweep, to prove the transaction's own authority. */
async function recoverRaw(chain: Chain) {
  seq += 1;
  return repository.admitAutomaticMediaRecovery({
    organizationId: ORG_A,
    sourceAttemptId: chain.sourceAttemptId,
    sourceValidationId: chain.validationId,
    attemptId: `sgen_raw_${seq}`,
    pricingSnapshotId: `price_raw_${seq}`,
    pricingSnapshot: (await planFor(chain)).pricingSnapshot,
    fxSnapshot: RATE,
    context: ctx({ correlationId: `corr_raw_${seq}` }),
  });
}
