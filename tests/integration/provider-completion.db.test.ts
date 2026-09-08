import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedSubmissionClock,
  createPricingSnapshot,
  createProviderCompletionService,
  createProviderPricingCatalog,
  createSubmissionOutcomeService,
  epochMillis,
  epochMillisFromDate,
  managedGenerationOutputKey,
  parseSubmissionDiagnosticCode,
  safePositiveByteCount,
  sha256Digest,
  validateReconciliationPolicy,
  MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE,
  OUTPUT_INGESTION_STARTED_EVENT_TYPE,
  OUTPUT_VERIFIED_EVENT_TYPE,
  PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
  PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
  type FxSnapshot,
  type ManagedOutputVerificationReceipt,
  type PricingSnapshot,
  type ProviderCompletionObservation,
  type ReconciliationPolicy,
  type SubmissionClock,
  type SubmissionDiagnosticCode,
} from "@app/domain";
import { createCompletionRepository, createSubmissionOutcomeRepository } from "@app/database";
import {
  ASSET_A,
  ctx,
  dropTenants,
  HAS_DB,
  OPEN_VIDEO_IDENTITY,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Provider completion and managed output verification, against live PostgreSQL.
 *
 * Every row here reached `PROCESSING + ACCEPTED` through Phase 2G-1's own
 * service, so what is exercised is the record that phase actually produces.
 *
 * **No provider is contacted and no object storage is written.** The completion
 * evidence and the integrity receipt are arguments. What the database is needed
 * for is the part a fake repository cannot prove: that the execution state moves
 * without the certainty axis moving with it, that verified output metadata is
 * immutable, that the reservation is never touched, and that two workers racing
 * on any of the three operations produce exactly one transition.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, so a lock held on one connection genuinely blocks the other. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const VERIFIED_AT = epochMillis(BOUNDARY + 3_600_000);
const CYCLE = "2026-09";

function validatedPolicy(): ReconciliationPolicy {
  const result = validateReconciliationPolicy({
    reconciliationWindowMs: 24 * 60 * 60 * 1000,
    staleSubmittingAfterMs: 15 * 60 * 1000,
  });
  if (!result.ok) throw new Error(`invalid test policy: ${result.reason}`);
  return result.policy;
}
const POLICY = validatedPolicy();

function code(value: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(value);
  if (!parsed.ok || parsed.code === null) throw new Error(`not a safe code: ${value}`);
  return parsed.code;
}

const FX: FxSnapshot = {
  id: "fx_completion",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

const SUCCEEDED: ProviderCompletionObservation = { kind: "SUCCEEDED" };
const FAILED_RETRYABLE: ProviderCompletionObservation = {
  kind: "FAILED",
  retryable: true,
  diagnosticCode: code("TIMEOUT"),
};
const FAILED_TERMINAL: ProviderCompletionObservation = {
  kind: "FAILED",
  retryable: false,
  diagnosticCode: null,
};

const SHA_A = sha256Digest("a".repeat(64));
const SHA_B = sha256Digest("b".repeat(64));
const SIZE_A = safePositiveByteCount(4_194_304);
const SIZE_B = safePositiveByteCount(8_388_608);
const RECEIPT: ManagedOutputVerificationReceipt = { sha256: SHA_A, sizeBytes: SIZE_A };

function completion(
  client: PrismaClient = prisma,
  clock: SubmissionClock = createFixedSubmissionClock(VERIFIED_AT),
) {
  return createProviderCompletionService({
    completion: createCompletionRepository(client),
    clock,
  });
}

function outcomes(client: PrismaClient = prisma) {
  return createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(client),
    clock: createFixedSubmissionClock(BOUNDARY),
    policy: POLICY,
  });
}

function snapshotFor(seconds: number): PricingSnapshot {
  const contract = createProviderPricingCatalog().findByIdentity(OPEN_VIDEO_IDENTITY);
  if (contract === undefined) throw new Error("expected a pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: seconds,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
    fx: FX,
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

/**
 * A chain whose attempt is `PROCESSING + ACCEPTED`.
 *
 * Driven through Phase 2G-1's service rather than written directly, so the
 * provider reference and acceptance instant are exactly what that phase writes —
 * including the ones this phase must not touch.
 */
async function seedAcceptedProcessingAttempt(
  suffix: string,
  options: {
    readonly organizationId?: string;
    readonly videoProjectId?: string;
    readonly stopAtBoundary?: boolean;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const repos = repositories(prisma);

  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_${suffix}`,
      videoProjectId: options.videoProjectId ?? PROJECT_A,
      requestedByUserId: "usr_itest",
      qualityTier: "NORMAL",
      requestedDurationSeconds: 30,
    },
    ctx(),
  );
  if (created.kind !== "CREATED") throw new Error(`job: ${created.kind}`);

  const moved = await repos.jobs.transition({
    organizationId,
    id: created.job.id,
    expectedState: "CREATED",
    expectedVersion: 0,
    nextState: "RESERVING",
    context: ctx(),
  });
  if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");
  const reserved = await repos.reservations.reserve(
    organizationId,
    {
      reservationId: `genres_${suffix}`,
      generationJobId: created.job.id,
      expectedJobVersion: moved.value.stateVersion,
      billingCycleKey: CYCLE,
      billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    ctx(),
  );
  if (reserved.kind !== "RESERVED") throw new Error(`reservation: ${reserved.kind}`);

  const scene = await repos.scenes.create(
    organizationId,
    {
      id: `genscene_${suffix}`,
      generationJobId: created.job.id,
      position: 0,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: ASSET_A,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: `a sunlit living room, cinematic (${suffix})`,
    },
    ctx(),
  );
  if (scene === null) throw new Error("scene not created");

  const request = await repos.requests.createInitial(
    organizationId,
    { id: `genreq_${suffix}`, generationSceneId: scene.id, requestedByUserId: "usr_itest" },
    ctx(),
  );
  if (request === null) throw new Error("request not created");

  const admitted = await repos.attempts.admit(
    organizationId,
    {
      id: `sgen_${suffix}`,
      generationSceneRequestId: request.id,
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
      requestNativeGenerationResolution: "1080p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
      pricingSnapshotId: `price_sgen_${suffix}`,
      pricingSnapshot: snapshotFor(5),
      fxSnapshot: FX,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`attempt: ${admitted.kind}`);

  const armed = await repos.attempts.armProviderBoundary({
    organizationId,
    id: admitted.attempt.id,
    expectedVersion: admitted.attempt.stateVersion,
    context: ctx(),
  });
  if (armed.kind !== "ARMED") throw new Error(`arm: ${armed.kind}`);
  await prisma.sceneGeneration.update({
    where: { id: admitted.attempt.id },
    data: { submissionBoundaryEnteredAt: new Date(BOUNDARY) },
  });

  if (options.stopAtBoundary !== true) {
    // Phase 2G-1's own acceptance: PROCESSING + ACCEPTED, with a provider
    // reference and an acceptance instant.
    const accepted = await outcomes().recordObservation({
      organizationId,
      attemptId: admitted.attempt.id,
      observation: { kind: "ACCEPTED", providerPredictionId: `pred_${suffix}` },
      context: ctx(),
    });
    if (accepted.kind !== "APPLIED") throw new Error(`acceptance: ${accepted.kind}`);
  }

  return { job: created.job, scene, request, attemptId: admitted.attempt.id };
}

async function attemptRow(attemptId: string) {
  return prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attemptId } });
}

async function reservationOf(jobId: string) {
  return prisma.generationReservation.findFirstOrThrow({ where: { generationJobId: jobId } });
}

async function eventsFor(attemptId: string, organizationId = ORG_A) {
  return repositories(prisma).events.listForAggregate(organizationId, "ATTEMPT", attemptId);
}

/** Drive an attempt all the way to a verified managed output. */
async function seedVerifiedAttempt(suffix: string) {
  const seeded = await seedAcceptedProcessingAttempt(suffix);
  const svc = completion();
  const base = { organizationId: ORG_A, attemptId: seeded.attemptId, context: ctx() };
  if ((await svc.recordProviderCompletion({ ...base, observation: SUCCEEDED })).kind !== "APPLIED") {
    throw new Error("completion did not apply");
  }
  if ((await svc.beginOutputIngestion(base)).kind !== "APPLIED") {
    throw new Error("ingestion did not start");
  }
  if ((await svc.finalizeOutputVerification({ ...base, receipt: RECEIPT })).kind !== "APPLIED") {
    throw new Error("verification did not apply");
  }
  return seeded;
}

const BASE = { organizationId: ORG_A, context: ctx() };

describe.skipIf(!HAS_DB)("provider completion and managed output verification", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
    await other.$disconnect();
  });

  describe("recording what the provider did", () => {
    it("moves an accepted job to PROVIDER_SUCCEEDED without touching anything else", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("ok");
      const before = await attemptRow(attemptId);
      expect(before.orchestrationState).toBe("PROCESSING");
      expect(before.submissionCertainty).toBe("ACCEPTED");

      expect(
        await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
      ).toMatchObject({ kind: "APPLIED", attemptId });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("PROVIDER_SUCCEEDED");
      // The three facts the submission boundary established, untouched.
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).toBe(before.providerPredictionId);
      expect(row.providerAcceptedAt?.getTime()).toBe(before.providerAcceptedAt?.getTime());
      // No output location is invented by a completion.
      expect(row.outputStorageKey).toBeNull();
      expect(row.outputSha256).toBeNull();
      // And the customer's entitlement is exactly where it was.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it.each([
      ["retryable", FAILED_RETRYABLE, "FAILED_RETRYABLE"],
      ["terminal", FAILED_TERMINAL, "FAILED_TERMINAL"],
    ] as const)("records a %s execution failure with certainty intact", async (l, obs, state) => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt(`fail${l}`);
      const before = await attemptRow(attemptId);

      expect(
        await completion().recordProviderCompletion({ ...BASE, attemptId, observation: obs }),
      ).toMatchObject({ kind: "APPLIED" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe(state);
      // The distinction the phase turns on: the provider accepted this work and
      // ran a paid job. DEFINITIVELY_REJECTED would tell the guard it did not.
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).toBe(before.providerPredictionId);
      expect(row.providerAcceptedAt).not.toBeNull();
      // The submission diagnostic is a different fact and is not overwritten.
      expect(row.normalizedErrorCode).toBe(before.normalizedErrorCode);
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("refuses an attempt whose acceptance was never established", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("neveracc", {
        stopAtBoundary: true,
      });
      const before = await attemptRow(attemptId);
      expect(before.submissionCertainty).toBe("PRE_SUBMISSION");

      expect(
        await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
      ).toEqual({ kind: "ATTEMPT_NOT_PROCESSING", reason: "PROVIDER_NEVER_ACCEPTED" });
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
    });

    it.each([
      ["an unknown discriminant", { kind: "UNKNOWN" }],
      ["a stringly-typed retryable flag", { kind: "FAILED", retryable: "false", diagnosticCode: null }],
      ["null", null],
      ["an array", []],
    ])("refuses %s with zero mutation and zero events", async (_l, hostile) => {
      const { attemptId } = await seedAcceptedProcessingAttempt(
        `mal${String(_l).replace(/\W/g, "")}`,
      );
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      expect(
        await completion().recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: hostile as unknown as ProviderCompletionObservation,
        }),
      ).toEqual({ kind: "OBSERVATION_MALFORMED" });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("PROCESSING");
      expect(await eventsFor(attemptId)).toHaveLength(events);
    });

    it("appends exactly one labelled event", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("evt");
      const before = (await eventsFor(attemptId)).length;
      await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      const events = await eventsFor(attemptId);
      expect(events).toHaveLength(before + 1);
      expect(events.at(-1)).toMatchObject({
        eventType: PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
        fromState: "PROCESSING",
        toState: "PROVIDER_SUCCEEDED",
      });
    });

    it("labels a failure distinctly and records the execution diagnostic safely", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("evtfail");
      await completion().recordProviderCompletion({
        ...BASE,
        attemptId,
        observation: FAILED_RETRYABLE,
      });
      const event = (await eventsFor(attemptId)).at(-1);
      expect(event).toMatchObject({
        eventType: PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
        toState: "FAILED_RETRYABLE",
      });
      expect(event?.safeMetadata).toMatchObject({
        attemptId,
        submissionCertainty: "ACCEPTED",
        retryable: true,
        diagnosticCode: "TIMEOUT",
      });
    });
  });

  describe("completion replay and conflict", () => {
    it.each(["PROVIDER_SUCCEEDED", "OUTPUT_INGESTING", "OUTPUT_VERIFIED"] as const)(
      "replays a success at %s with zero mutation",
      async (target) => {
        const seeded =
          target === "OUTPUT_VERIFIED"
            ? await seedVerifiedAttempt(`rep${target}`)
            : await seedAcceptedProcessingAttempt(`rep${target}`);
        const svc = completion();
        const base = { ...BASE, attemptId: seeded.attemptId };
        if (target !== "OUTPUT_VERIFIED") {
          await svc.recordProviderCompletion({ ...base, observation: SUCCEEDED });
          if (target === "OUTPUT_INGESTING") await svc.beginOutputIngestion(base);
        }
        const before = await attemptRow(seeded.attemptId);
        expect(before.orchestrationState).toBe(target);
        const events = (await eventsFor(seeded.attemptId)).length;

        expect(
          await svc.recordProviderCompletion({ ...base, observation: SUCCEEDED }),
        ).toEqual({ kind: "REPLAYED", attemptId: seeded.attemptId });

        const after = await attemptRow(seeded.attemptId);
        // Never backwards, never a second event, never a version bump.
        expect(after.orchestrationState).toBe(target);
        expect(after.stateVersion).toBe(before.stateVersion);
        expect(await eventsFor(seeded.attemptId)).toHaveLength(events);
      },
    );

    it("replays a failure already on file", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("repfail");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_TERMINAL });
      const before = await attemptRow(attemptId);
      expect(
        await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_TERMINAL }),
      ).toEqual({ kind: "REPLAYED", attemptId });
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
    });

    it("refuses a failure against a recorded success", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("confsf");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      const before = await attemptRow(attemptId);
      expect(
        await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_TERMINAL }),
      ).toEqual({ kind: "CONFLICTING_COMPLETION", reason: "COMPLETION_OUTCOME_MISMATCH" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROVIDER_SUCCEEDED");
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
    });

    it("refuses a retryability disagreement", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("confretry");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_RETRYABLE });
      expect(
        await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_TERMINAL }),
      ).toEqual({ kind: "CONFLICTING_COMPLETION", reason: "RETRYABLE_MISMATCH" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("FAILED_RETRYABLE");
    });
  });

  describe("managed output ingestion", () => {
    it("moves PROVIDER_SUCCEEDED to OUTPUT_INGESTING and appends one event", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("ing");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      const events = (await eventsFor(attemptId)).length;

      expect(await svc.beginOutputIngestion({ ...BASE, attemptId })).toMatchObject({
        kind: "APPLIED",
        attemptId,
      });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).not.toBeNull();
      // Still no output metadata: nothing has been copied or proved yet.
      expect(row.outputStorageKey).toBeNull();
      const after = await eventsFor(attemptId);
      expect(after).toHaveLength(events + 1);
      expect(after.at(-1)).toMatchObject({
        eventType: OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        fromState: "PROVIDER_SUCCEEDED",
        toState: "OUTPUT_INGESTING",
      });
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("reports an ingestion already under way, with zero mutation", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("ingtwice");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      expect(await svc.beginOutputIngestion({ ...BASE, attemptId })).toEqual({
        kind: "ALREADY_INGESTING",
        attemptId,
      });
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
      expect(await eventsFor(attemptId)).toHaveLength(events);
    });

    it("reports an output already verified rather than moving backwards", async () => {
      const { attemptId } = await seedVerifiedAttempt("ingverified");
      const before = await attemptRow(attemptId);
      expect(await completion().beginOutputIngestion({ ...BASE, attemptId })).toEqual({
        kind: "ALREADY_VERIFIED",
        attemptId,
      });
      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("refuses to ingest a provider-failed attempt", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("ingfailed");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_TERMINAL });
      expect(await svc.beginOutputIngestion({ ...BASE, attemptId })).toEqual({
        kind: "NOT_INGESTIBLE",
        reason: "PROVIDER_NOT_SUCCEEDED",
      });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("FAILED_TERMINAL");
    });

    it("leaves an interrupted ingestion resumable rather than failed", async () => {
      // The semantics §29 freezes: a platform-side copy problem is not a
      // provider failure. The attempt stays in OUTPUT_INGESTING, which is
      // exactly how a later worker finds it again.
      const { attemptId } = await seedAcceptedProcessingAttempt("resumable");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });

      // Nothing in this phase can move it out of OUTPUT_INGESTING except a
      // verification; there is no "ingestion failed" operation at all.
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
      expect(
        await svc.recordProviderCompletion({ ...BASE, attemptId, observation: FAILED_RETRYABLE }),
      ).toEqual({ kind: "CONFLICTING_COMPLETION", reason: "COMPLETION_OUTCOME_MISMATCH" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
    });
  });

  describe("managed output verification", () => {
    it("persists exactly the four integrity facts", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("ver");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });

      const result = await svc.finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT });
      const expectedKey = managedGenerationOutputKey({ organizationId: ORG_A, attemptId });
      expect(result).toMatchObject({
        kind: "APPLIED",
        attemptId,
        outputStorageKey: expectedKey,
        outputVerifiedAt: VERIFIED_AT,
      });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.outputStorageKey).toBe(expectedKey);
      expect(row.outputSha256).toBe(SHA_A);
      expect(row.outputSizeBytes).toBe(BigInt(SIZE_A));
      // The single post-lock instant, not a wall-clock read.
      expect(row.outputVerifiedAt?.getTime()).toBe(VERIFIED_AT);
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("derives the key from the tenant and attempt, never from a caller", async () => {
      const { attemptId } = await seedVerifiedAttempt("verkey");
      const row = await attemptRow(attemptId);
      expect(row.outputStorageKey).toBe(`org/${ORG_A}/generations/${attemptId}/output.mp4`);
    });

    it("appends one OUTPUT_VERIFIED event carrying integrity but no location", async () => {
      const { attemptId } = await seedVerifiedAttempt("verevt");
      const event = (await eventsFor(attemptId)).at(-1);
      expect(event).toMatchObject({
        eventType: OUTPUT_VERIFIED_EVENT_TYPE,
        fromState: "OUTPUT_INGESTING",
        toState: "OUTPUT_VERIFIED",
      });
      expect(event?.safeMetadata).toMatchObject({
        attemptId,
        outputSha256: SHA_A,
        outputSizeBytes: SIZE_A,
        outputVerifiedAt: VERIFIED_AT,
      });
      const serialized = JSON.stringify(event?.safeMetadata);
      for (const forbidden of ["outputStorageKey", "org/", "https://", "sunlit living room"]) {
        expect(`${forbidden}: ${serialized.includes(forbidden)}`).toBe(`${forbidden}: false`);
      }
    });

    it("replays the exact same receipt with zero mutation", async () => {
      const { attemptId } = await seedVerifiedAttempt("verrep");
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      expect(
        await completion(
          prisma,
          createFixedSubmissionClock(epochMillis(VERIFIED_AT + 86_400_000)),
        ).finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT }),
      ).toEqual({ kind: "REPLAYED", attemptId });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      // Immutable: not even the timestamp is rewritten by a later replay.
      expect(after.outputVerifiedAt?.getTime()).toBe(VERIFIED_AT);
      expect(after.outputSha256).toBe(SHA_A);
      expect(after.outputSizeBytes).toBe(BigInt(SIZE_A));
      expect(await eventsFor(attemptId)).toHaveLength(events);
    });

    it.each([
      ["a different digest", { sha256: SHA_B, sizeBytes: SIZE_A }, "SHA256_MISMATCH"],
      ["a different size", { sha256: SHA_A, sizeBytes: SIZE_B }, "SIZE_MISMATCH"],
    ] as const)("refuses %s and never overwrites", async (_l, receipt, reason) => {
      const { attemptId } = await seedVerifiedAttempt(`verconf${reason}`);
      const before = await attemptRow(attemptId);

      expect(
        await completion().finalizeOutputVerification({ ...BASE, attemptId, receipt }),
      ).toEqual({ kind: "CONFLICTING_OUTPUT", reason });

      const after = await attemptRow(attemptId);
      expect(after.outputSha256).toBe(before.outputSha256);
      expect(after.outputSizeBytes).toBe(before.outputSizeBytes);
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("refuses to finalize an attempt that never started ingesting", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("vernoing");
      await completion().recordProviderCompletion({
        ...BASE,
        attemptId,
        observation: SUCCEEDED,
      });
      expect(
        await completion().finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT }),
      ).toEqual({ kind: "NOT_INGESTING", reason: "ATTEMPT_NOT_INGESTING" });
      expect((await attemptRow(attemptId)).outputSha256).toBeNull();
    });

    it("refuses a malformed receipt with zero mutation", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("vermal");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });
      const before = await attemptRow(attemptId);

      expect(
        await svc.finalizeOutputVerification({
          ...BASE,
          attemptId,
          receipt: {
            sha256: "A".repeat(64),
            sizeBytes: 0,
          } as unknown as ManagedOutputVerificationReceipt,
        }),
      ).toEqual({ kind: "RECEIPT_MALFORMED" });
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.outputSha256).toBeNull();
    });
  });

  describe("the database refuses a verified output missing its integrity facts", () => {
    it.each([
      ["outputStorageKey"],
      ["outputSha256"],
      ["outputSizeBytes"],
      ["outputVerifiedAt"],
    ] as const)("rejects a raw write clearing %s while OUTPUT_VERIFIED", async (field) => {
      // The CHECK is what makes OUTPUT_VERIFIED mean something even if an
      // application bug writes around the service.
      const { attemptId } = await seedVerifiedAttempt(`chk${field}`);
      await expect(
        prisma.sceneGeneration.update({
          where: { id: attemptId },
          data: { [field]: null },
        }),
      ).rejects.toThrow();
      expect((await attemptRow(attemptId)).outputSha256).toBe(SHA_A);
    });

    it("rejects a non-canonical digest", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("chksha");
      await expect(
        prisma.$executeRaw`
          UPDATE "scene_generations" SET "outputSha256" = ${"A".repeat(64)} WHERE "id" = ${attemptId}
        `,
      ).rejects.toThrow();
    });

    it("rejects a zero or negative size", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("chksize");
      for (const bad of [0n, -1n]) {
        await expect(
          prisma.sceneGeneration.update({
            where: { id: attemptId },
            data: { outputSizeBytes: bad },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe("legacy rows are historical facts, not orchestration", () => {
    it("does not reinterpret a legacy SUCCEEDED row as PROVIDER_SUCCEEDED", async () => {
      // A legacy success was recorded under the older `state` vocabulary with no
      // orchestration linkage. Treating it as an orchestrated completion would
      // invent a history nobody recorded.
      const { attemptId } = await seedAcceptedProcessingAttempt("legacy");
      await prisma.$executeRaw`
        UPDATE "scene_generations"
           SET "orchestrationState" = NULL,
               "submissionCertainty" = NULL,
               "generationSceneRequestId" = NULL,
               "attemptOrdinal" = NULL,
               "attemptKind" = NULL,
               "pricingContractKey" = NULL,
               "state" = 'SUCCEEDED'::"SceneGenerationState"
         WHERE "id" = ${attemptId}
      `;
      // Indistinguishable from missing: the service will not act on it at all.
      expect(
        await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(await completion().beginOutputIngestion({ ...BASE, attemptId })).toEqual({
        kind: "ATTEMPT_NOT_FOUND",
      });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBeNull();
      expect(row.state).toBe("SUCCEEDED");
      // And nothing was backfilled.
      expect(row.outputSha256).toBeNull();
      expect(row.outputSizeBytes).toBeNull();
      expect(row.outputVerifiedAt).toBeNull();
    });

    it("leaves a legacy row valid under the new CHECK constraints", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("legacychk");
      // The constraint keys on `orchestrationState`, which is NULL here, so
      // `IS DISTINCT FROM` makes it pass unconditionally.
      await expect(
        prisma.$executeRaw`
          UPDATE "scene_generations"
             SET "orchestrationState" = NULL,
                 "submissionCertainty" = NULL,
                 "generationSceneRequestId" = NULL,
                 "attemptOrdinal" = NULL,
                 "attemptKind" = NULL,
                 "pricingContractKey" = NULL
           WHERE "id" = ${attemptId}
        `,
      ).resolves.toBeGreaterThan(0);
    });
  });

  describe("tenant isolation at the mutation boundary", () => {
    it("refuses a cross-tenant completion made without reading the facts", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("xtc");
      const before = await attemptRow(attemptId);

      const applied = await createCompletionRepository(prisma).withCompletingAttempt(
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.applyCompletion({
            expectedVersion: before.stateVersion,
            write: { orchestrationState: "PROVIDER_SUCCEEDED" },
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("PROCESSING");
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("refuses a cross-tenant ingestion start", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("xti");
      await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      const before = await attemptRow(attemptId);

      const applied = await createCompletionRepository(prisma).withCompletingAttempt(
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.applyBeginIngestion({
            expectedVersion: before.stateVersion,
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROVIDER_SUCCEEDED");
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("refuses a cross-tenant output finalization", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("xtv");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });
      const before = await attemptRow(attemptId);

      const applied = await createCompletionRepository(prisma).withCompletingAttempt(
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.applyOutputVerification({
            expectedVersion: before.stateVersion,
            write: {
              orchestrationState: "OUTPUT_VERIFIED",
              outputStorageKey: managedGenerationOutputKey({
                organizationId: ORG_B,
                attemptId,
              }),
              outputSha256: SHA_B,
              outputSizeBytes: SIZE_B,
              outputVerifiedAt: VERIFIED_AT,
            },
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });

      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(after.outputSha256).toBeNull();
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("freezes an attempt whose two ownership paths disagree", async () => {
      // The CAS carries *both* tenant clauses — the denormalized
      // `videoProjectId` the standard attempt repository scopes on, and the
      // ownership chain every read here traverses. Either one alone is a
      // complete tenant check right up until the two disagree, and then the
      // surviving one decides which tenant gets to write the row. That is a
      // decision made by whichever corruption happened, not by the platform.
      //
      // This builds the disagreement directly: the chain belongs to org B, the
      // denormalized column names org A's project. Org A is the tenant the
      // weaker predicate would admit, and it is refused.
      const { attemptId } = await seedAcceptedProcessingAttempt("split", {
        organizationId: ORG_B,
        videoProjectId: PROJECT_B,
      });
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { videoProjectId: PROJECT_A },
      });
      const before = await attemptRow(attemptId);
      expect(before.orchestrationState).toBe("PROCESSING");

      const applied = await createCompletionRepository(prisma).withCompletingAttempt(
        { organizationId: ORG_A, attemptId },
        async (session) =>
          session.applyCompletion({
            expectedVersion: before.stateVersion,
            write: { orchestrationState: "PROVIDER_SUCCEEDED" },
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });

      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("PROCESSING");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_A } }),
      ).toHaveLength(0);
    });

    it("refuses the other tenant of a disagreeing row as well", async () => {
      // And the row is frozen rather than reassigned: org B, whose chain does
      // own it, is refused too. A row nobody can move is a problem to
      // investigate; a row two tenants can move is a breach.
      const { attemptId } = await seedAcceptedProcessingAttempt("split2", {
        organizationId: ORG_B,
        videoProjectId: PROJECT_B,
      });
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { videoProjectId: PROJECT_A },
      });
      const before = await attemptRow(attemptId);

      const applied = await createCompletionRepository(prisma).withCompletingAttempt(
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.applyCompletion({
            expectedVersion: before.stateVersion,
            write: { orchestrationState: "PROVIDER_SUCCEEDED" },
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
    });

    it("answers a cross-tenant service call exactly as it answers a missing one", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("xtsvc");
      expect(
        await completion().recordProviderCompletion({
          organizationId: ORG_B,
          attemptId,
          observation: SUCCEEDED,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(
        await completion().recordProviderCompletion({
          ...BASE,
          attemptId: "sgen_nonexistent",
          observation: SUCCEEDED,
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two identical successes apply", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("racesucc");
      const results = await Promise.all([
        completion(prisma).recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
        completion(other).recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROVIDER_SUCCEEDED");
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    });

    it("gives success versus failure one coherent winner", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("racemixed");
      const results = await Promise.all([
        completion(prisma).recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED }),
        completion(other).recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: FAILED_TERMINAL,
        }),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["APPLIED", "CONFLICTING_COMPLETION"]);

      const row = await attemptRow(attemptId);
      expect(["PROVIDER_SUCCEEDED", "FAILED_TERMINAL"]).toContain(row.orchestrationState);
      // Whichever won, the certainty never moved and exactly one event landed.
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(
        (await eventsFor(attemptId)).filter((e) =>
          [
            PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
            PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
          ].includes(e.eventType),
        ),
      ).toHaveLength(1);
    });

    it("lets exactly one of two identical failures apply", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("racefail");
      const results = await Promise.all([
        completion(prisma).recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: FAILED_RETRYABLE,
        }),
        completion(other).recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: FAILED_RETRYABLE,
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("FAILED_RETRYABLE");
    });

    it("gives retryable versus terminal one winner", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("raceretry");
      const results = await Promise.all([
        completion(prisma).recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: FAILED_RETRYABLE,
        }),
        completion(other).recordProviderCompletion({
          ...BASE,
          attemptId,
          observation: FAILED_TERMINAL,
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "CONFLICTING_COMPLETION"]);
      expect(["FAILED_RETRYABLE", "FAILED_TERMINAL"]).toContain(
        (await attemptRow(attemptId)).orchestrationState,
      );
    });

    it("lets exactly one of two concurrent ingestion starts transition", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("raceing");
      await completion().recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      const before = await attemptRow(attemptId);

      const results = await Promise.all([
        completion(prisma).beginOutputIngestion({ ...BASE, attemptId }),
        completion(other).beginOutputIngestion({ ...BASE, attemptId }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["ALREADY_INGESTING", "APPLIED"]);

      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(after.stateVersion).toBe(before.stateVersion + 1);
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    });

    it("lets exactly one of two identical finalizations apply", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("racever");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });
      const before = await attemptRow(attemptId);

      const results = await Promise.all([
        completion(prisma).finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT }),
        completion(other).finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);

      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(after.stateVersion).toBe(before.stateVersion + 1);
      expect(after.outputSha256).toBe(SHA_A);
      expect(
        (await eventsFor(attemptId)).filter((e) => e.eventType === OUTPUT_VERIFIED_EVENT_TYPE),
      ).toHaveLength(1);
    });

    it("never overwrites verified metadata when two receipts disagree", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("raceverconf");
      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });

      const results = await Promise.all([
        completion(prisma).finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT }),
        completion(other).finalizeOutputVerification({
          ...BASE,
          attemptId,
          receipt: { sha256: SHA_B, sizeBytes: SIZE_B },
        }),
      ]);
      // Exactly one receipt wins; the other is refused, never applied.
      expect(results.filter((r) => r.kind === "APPLIED")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "CONFLICTING_OUTPUT")).toHaveLength(1);

      const row = await attemptRow(attemptId);
      const winner = results.find((r) => r.kind === "APPLIED");
      if (winner === undefined || winner.kind !== "APPLIED") throw new Error("expected a winner");
      // The stored digest is one of the two, whole — never a blend, never the
      // loser's, and never rewritten afterwards.
      expect([SHA_A, SHA_B]).toContain(row.outputSha256);
      expect(
        (await eventsFor(attemptId)).filter((e) => e.eventType === OUTPUT_VERIFIED_EVENT_TYPE),
      ).toHaveLength(1);
    });
  });

  describe("candidate discovery", () => {
    it.each([
      ["AWAITING_PROVIDER_COMPLETION", 0],
      ["AWAITING_OUTPUT_INGESTION", 1],
      ["RESUMABLE_OUTPUT_INGESTION", 2],
    ] as const)("finds attempts at stage %s", async (stage, steps) => {
      const { attemptId } = await seedAcceptedProcessingAttempt(`disc${stage}`);
      const svc = completion();
      if (steps >= 1) {
        await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      }
      if (steps >= 2) await svc.beginOutputIngestion({ ...BASE, attemptId });

      const found = await createCompletionRepository(prisma).findCompletionCandidates({
        stage,
        limit: 10,
      });
      expect(found).toEqual([{ organizationId: ORG_A, attemptId }]);
      expect(Object.keys(found[0] ?? {}).sort()).toEqual(["attemptId", "organizationId"]);
    });

    it("returns identifiers only — no provider reference, prompt or output location", async () => {
      await seedVerifiedAttempt("discsafe");
      const { attemptId } = await seedAcceptedProcessingAttempt("discsafe2");
      const found = await createCompletionRepository(prisma).findCompletionCandidates({
        stage: "AWAITING_PROVIDER_COMPLETION",
        limit: 10,
      });
      expect(found).toEqual([{ organizationId: ORG_A, attemptId }]);
      const serialized = JSON.stringify(found);
      for (const forbidden of ["pred_", "sunlit", "outputStorageKey", "sha"]) {
        expect(`${forbidden}: ${serialized.includes(forbidden)}`).toBe(`${forbidden}: false`);
      }
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["one over the maximum", MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE + 1],
      ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ])("refuses a %s limit before querying", async (_label, limit) => {
      await expect(
        createCompletionRepository(prisma).findCompletionCandidates({
          stage: "AWAITING_PROVIDER_COMPLETION",
          limit,
        }),
      ).rejects.toThrow(/between 1 and 100/);
    });

    it.each([
      ["AWAITING_PROVIDER_COMPLETION", "PROCESSING"],
      ["AWAITING_OUTPUT_INGESTION", "PROVIDER_SUCCEEDED"],
    ] as const)("offers no %s candidate whose acceptance is unknown", async (stage, state) => {
      // Discovery is advisory, and the single-attempt service re-checks
      // everything — so an unaccepted row surfacing here is not itself a state
      // error. It is worse than that in a slower way: every candidate is a row
      // a worker will pick up, and a worker picking up an attempt whose
      // submission is still unresolved is a worker about to ask a provider
      // about a job that may never have been sent. The certainty filter is
      // what keeps the reconciliation path and the completion path from
      // reaching for the same row.
      const accepted = await seedAcceptedProcessingAttempt(`disc_ok_${stage}`);
      if (state === "PROVIDER_SUCCEEDED") {
        await completion().recordProviderCompletion({
          ...BASE,
          attemptId: accepted.attemptId,
          observation: SUCCEEDED,
        });
      }
      const unknown = await seedAcceptedProcessingAttempt(`disc_unk_${stage}`, {
        stopAtBoundary: true,
      });
      // Written directly: no service will produce this pairing, which is the
      // point — the filter has to hold for rows the happy path cannot make.
      await prisma.sceneGeneration.update({
        where: { id: unknown.attemptId },
        data: {
          orchestrationState: state,
          submissionCertainty: "SUBMISSION_UNKNOWN",
          providerPredictionId: null,
        },
      });

      const found = await createCompletionRepository(prisma).findCompletionCandidates({
        stage,
        limit: 10,
      });
      expect(found).toEqual([{ organizationId: ORG_A, attemptId: accepted.attemptId }]);
    });

    it.each([1, MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE])("accepts the bound %i", async (limit) => {
      await expect(
        createCompletionRepository(prisma).findCompletionCandidates({
          stage: "AWAITING_PROVIDER_COMPLETION",
          limit,
        }),
      ).resolves.toBeInstanceOf(Array);
    });
  });

  describe("customer entitlement is untouched everywhere", () => {
    it("leaves the reservation RESERVED through the whole lifecycle", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("entitlement");
      const before = await reservationOf(job.id);
      const reservationEvents = async () =>
        repositories(prisma).events.listForAggregate(ORG_A, "RESERVATION", before.id);
      const eventsBefore = (await reservationEvents()).length;

      const svc = completion();
      await svc.recordProviderCompletion({ ...BASE, attemptId, observation: SUCCEEDED });
      await svc.beginOutputIngestion({ ...BASE, attemptId });
      await svc.finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT });

      const after = await reservationOf(job.id);
      expect(after.state).toBe("RESERVED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.releasedAt).toBeNull();
      expect(await reservationEvents()).toHaveLength(eventsBefore);
    });

    it("does not release a unit when an accepted execution later fails", async () => {
      // Whether the customer's request can still be satisfied is a question
      // about the *request*, decided by a later phase with the whole Job in
      // view — not something a single attempt's failure answers.
      const { attemptId, job } = await seedAcceptedProcessingAttempt("entfail");
      const before = await reservationOf(job.id);
      await completion().recordProviderCompletion({
        ...BASE,
        attemptId,
        observation: FAILED_TERMINAL,
      });
      const after = await reservationOf(job.id);
      expect(after.state).toBe("RESERVED");
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("consumes nothing anywhere in the phase", async () => {
      await seedVerifiedAttempt("entconsume");
      expect(
        await prisma.generationReservation.findMany({ where: { state: "CONSUMED" } }),
      ).toHaveLength(0);
    });

    it("creates no recovery attempt after a retryable failure", async () => {
      const { attemptId, request } = await seedAcceptedProcessingAttempt("entrecovery");
      await completion().recordProviderCompletion({
        ...BASE,
        attemptId,
        observation: FAILED_RETRYABLE,
      });
      const attempts = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId: request.id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.id).toBe(attemptId);
    });
  });

  describe("logical delivery is still deferred", () => {
    it("leaves the request, scene and job untouched by a verified output", async () => {
      // A verified provider output is not a delivered scene. Aggregating them
      // into customer-visible readiness is the next phase.
      const seeded = await seedAcceptedProcessingAttempt("delivery");
      const beforeRequest = await prisma.sceneGenerationRequest.findUniqueOrThrow({
        where: { id: seeded.request.id },
      });
      const beforeScene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: seeded.scene.id },
      });
      const beforeJob = await prisma.generationJob.findUniqueOrThrow({
        where: { id: seeded.job.id },
      });

      const svc = completion();
      const base = { ...BASE, attemptId: seeded.attemptId };
      await svc.recordProviderCompletion({ ...base, observation: SUCCEEDED });
      await svc.beginOutputIngestion(base);
      await svc.finalizeOutputVerification({ ...base, receipt: RECEIPT });

      expect(
        await prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: seeded.request.id } }),
      ).toMatchObject({ state: beforeRequest.state, stateVersion: beforeRequest.stateVersion });
      expect(
        await prisma.generationScene.findUniqueOrThrow({ where: { id: seeded.scene.id } }),
      ).toMatchObject({ stateVersion: beforeScene.stateVersion });
      expect(
        await prisma.generationJob.findUniqueOrThrow({ where: { id: seeded.job.id } }),
      ).toMatchObject({ state: beforeJob.state, stateVersion: beforeJob.stateVersion });
    });
  });

  describe("the repository holds no wall clock and no transport", () => {
    it("names no unparameterized clock read or network call", () => {
      const source = readFileSync(
        join(__dirname, "../../packages/database/src/completion-repository.ts"),
        "utf8",
      );
      expect(source.includes("new Date()")).toBe(false);
      expect(source.includes("Date.now(")).toBe(false);
      // Converting an explicit validated instant is the only permitted form.
      expect(source.includes("new Date(write.outputVerifiedAt)")).toBe(true);
      for (const banned of ["fetch(", "getObject(", "putObject(", "generationReservation"]) {
        expect(`${banned}: ${source.includes(banned)}`).toBe(`${banned}: false`);
      }
    });
  });
});
