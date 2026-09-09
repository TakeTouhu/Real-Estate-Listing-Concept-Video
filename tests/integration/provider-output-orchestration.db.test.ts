import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedSubmissionClock,
  createPricingSnapshot,
  createProviderCompletionService,
  createProviderOutputRunner,
  createProviderPricingCatalog,
  createSubmissionOutcomeService,
  epochMillisFromDate,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  TransientProviderOutputLocator,
  validateReconciliationPolicy,
  OUTPUT_INGESTION_STARTED_EVENT_TYPE,
  OUTPUT_VERIFIED_EVENT_TYPE,
  PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
  type FxSnapshot,
  type PricingSnapshot,
  type ProviderCompletionStatusSource,
  type ProviderStatusLookupRef,
  type ManagedOutputTransferPort,
  type ReconciliationPolicy,
} from "@app/domain";
import {
  createCompletionRepository,
  createProviderPollingContextReader,
  createSubmissionOutcomeRepository,
} from "@app/database";
import {
  ASSET_A,
  ctx,
  dropTenants,
  HAS_DB,
  OPEN_VIDEO_IDENTITY,
  ORG_A,
  ORG_B,
  PROJECT_A,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The dormant orchestration, against live PostgreSQL.
 *
 * Every external dependency here is a fake — that is the phase, not a
 * limitation. What the database is needed for is the part a fake repository
 * cannot prove: that provider truth lands before output acquisition is even
 * attempted, that an interrupted copy really is resumable from the row, that two
 * runners racing produce one coherent history, and — the one that would be
 * invisible without a real connection — that no transaction is held open across
 * an external call.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second connection, for genuine concurrency rather than simulated. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third, so a competing writer can contend while a fake is blocked. */
const rival = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const CYCLE = "2026-09";
const RAW_URL = "https://provider.example/outputs/x.mp4?X-Amz-Signature=SECRETSIGNATURE";

const FX: FxSnapshot = {
  id: "fx_provider_output",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

const SHA_A = "a".repeat(64);
// Built through Phase 2H-1's constructors: these travel to `finalizeOutputVerification`
// directly in the seeds, where the branded types are the contract.
const RECEIPT_A = {
  sha256: sha256Digest(SHA_A),
  sizeBytes: safePositiveByteCount(4_194_304),
};
const RECEIPT_B = {
  sha256: sha256Digest("b".repeat(64)),
  sizeBytes: safePositiveByteCount(8_388_608),
};

function validatedPolicy(): ReconciliationPolicy {
  const policy = validateReconciliationPolicy({
    reconciliationWindowMs: 60 * 60 * 1000,
    staleSubmittingAfterMs: 15 * 60 * 1000,
  });
  if (!policy.ok) throw new Error(`invalid test policy: ${policy.reason}`);
  return policy.policy;
}
const POLICY = validatedPolicy();

function locator(raw = RAW_URL): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

function completion(client: PrismaClient = prisma) {
  return createProviderCompletionService({
    completion: createCompletionRepository(client),
    clock: createFixedSubmissionClock(BOUNDARY),
  });
}

function outcomes(client: PrismaClient = prisma) {
  return createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(client),
    clock: createFixedSubmissionClock(BOUNDARY),
    policy: POLICY,
  });
}

/** A status source that answers from a script and records what it was asked. */
function fakeSource(
  answer: (ref: ProviderStatusLookupRef) => Promise<unknown>,
): ProviderCompletionStatusSource & { readonly asked: ProviderStatusLookupRef[] } {
  const asked: ProviderStatusLookupRef[] = [];
  return {
    asked,
    async poll(ref) {
      asked.push(ref);
      return answer(ref);
    },
  };
}

/** A transfer port that answers from a script and records its inputs. */
function fakeTransfer(
  answer: () => Promise<unknown>,
): ManagedOutputTransferPort & {
  readonly calls: { source: TransientProviderOutputLocator; destinationKey: string }[];
} {
  const calls: { source: TransientProviderOutputLocator; destinationKey: string }[] = [];
  return {
    calls,
    async transferAndVerify(input) {
      calls.push(input);
      return answer();
    },
  };
}

function runner(options: {
  readonly client?: PrismaClient;
  readonly source: ProviderCompletionStatusSource;
  readonly transfer: ManagedOutputTransferPort;
}) {
  const client = options.client ?? prisma;
  const completionRepository = createCompletionRepository(client);
  return createProviderOutputRunner({
    polling: createProviderPollingContextReader(client, completionRepository),
    statusSource: options.source,
    transfer: options.transfer,
    completion: completion(client),
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

/** A chain whose attempt is `PROCESSING + ACCEPTED`, built by the real phases. */
async function seedAcceptedProcessingAttempt(
  suffix: string,
  options: { readonly organizationId?: string; readonly stopAtBoundary?: boolean } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const repos = repositories(prisma);

  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_${suffix}`,
      videoProjectId: PROJECT_A,
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
    const accepted = await outcomes().recordObservation({
      organizationId,
      attemptId: admitted.attempt.id,
      observation: { kind: "ACCEPTED", providerPredictionId: `pred_${suffix}` },
      context: ctx(),
    });
    if (accepted.kind !== "APPLIED") throw new Error(`acceptance: ${accepted.kind}`);
  }

  return { job: created.job, attemptId: admitted.attempt.id };
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

/** Drive an attempt to `PROVIDER_SUCCEEDED`, then optionally to ingesting. */
async function seedSucceeded(suffix: string, ingesting = false) {
  const seeded = await seedAcceptedProcessingAttempt(suffix);
  const svc = completion();
  const base = { organizationId: ORG_A, attemptId: seeded.attemptId, context: ctx() };
  const done = await svc.recordProviderCompletion({ ...base, observation: { kind: "SUCCEEDED" } });
  if (done.kind !== "APPLIED") throw new Error(`seed completion: ${done.kind}`);
  if (ingesting) {
    const begun = await svc.beginOutputIngestion(base);
    if (begun.kind !== "APPLIED") throw new Error(`seed ingestion: ${begun.kind}`);
  }
  return seeded;
}

function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

async function breathe(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A gate a fake can await, so a test controls exactly when external I/O ends. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open: () => open() };
}

const BASE = { organizationId: ORG_A, context: ctx() };

const SUCCEEDED_WITH = async () => ({ kind: "SUCCEEDED", outputLocator: locator() });
const VERIFIED_A = async () => ({ kind: "VERIFIED", receipt: RECEIPT_A });

describe.skipIf(!HAS_DB)("dormant provider output orchestration", () => {
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
    await rival.$disconnect();
  });

  describe("the polling context comes from the row, and only from the row", () => {
    it("presents the persisted provider, model and prediction", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("ctx");
      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
        ...BASE,
        attemptId,
      });

      const row = await attemptRow(attemptId);
      expect(source.asked).toEqual([
        {
          providerName: row.providerName,
          providerModelId: row.providerModelId,
          providerPredictionId: row.providerPredictionId,
        },
      ]);
      expect(row.providerPredictionId).toBe("pred_ctx");
    });

    it("keeps using an identity that is not the current default", async () => {
      // Written directly onto the row, then read back: whatever the environment
      // or the catalog says today, an attempt is polled as it was admitted.
      const { attemptId } = await seedAcceptedProcessingAttempt("ctxold");
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { providerName: "retired-vendor", providerModelId: "retired/model-v0" },
      });
      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
        ...BASE,
        attemptId,
      });
      expect(source.asked[0]?.providerName).toBe("retired-vendor");
      expect(source.asked[0]?.providerModelId).toBe("retired/model-v0");
    });

    it("answers not-found for another tenant, without polling", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("ctxtenant");
      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      expect(
        await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
          organizationId: ORG_B,
          attemptId,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      // Indistinguishable from a missing attempt, and no outbound call at all.
      expect(
        await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
          ...BASE,
          attemptId: "sgen_nonexistent",
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(source.asked).toHaveLength(0);
    });

    it.each([
      ["a legacy row with no orchestration linkage", "legacy"],
      ["an attempt whose acceptance is unknown", "unknown"],
    ])("excludes %s", async (_label, mode) => {
      const { attemptId } = await seedAcceptedProcessingAttempt(`excl${mode}`);
      if (mode === "legacy") {
        await prisma.$executeRaw`
          UPDATE "scene_generations"
             SET "orchestrationState" = NULL, "submissionCertainty" = NULL,
                 "generationSceneRequestId" = NULL, "attemptOrdinal" = NULL,
                 "attemptKind" = NULL, "pricingContractKey" = NULL,
                 "providerPredictionId" = NULL,
                 "state" = 'SUCCEEDED'::"SceneGenerationState"
           WHERE "id" = ${attemptId}
        `;
      } else {
        await prisma.$executeRaw`
          UPDATE "scene_generations"
             SET "submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty",
                 "providerPredictionId" = NULL
           WHERE "id" = ${attemptId}
        `;
      }
      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      expect(
        await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
          ...BASE,
          attemptId,
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      // No provider is called about a row this phase has no lifecycle for.
      expect(source.asked).toHaveLength(0);
    });

    it("refuses a blank persisted identity without polling", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("ctxblank");
      await prisma.$executeRaw`
        UPDATE "scene_generations" SET "providerName" = '  ' WHERE "id" = ${attemptId}
      `;
      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      expect(
        await runner({ source, transfer: fakeTransfer(VERIFIED_A) }).runProviderOutputAttemptOnce({
          ...BASE,
          attemptId,
        }),
      ).toEqual({ kind: "ATTEMPT_CONTEXT_INVALID", reason: "PROVIDER_NAME_BLANK" });
      expect(source.asked).toHaveLength(0);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
    });
  });

  describe("provider truth is durable before output acquisition matters", () => {
    it("records success and reports the missing locator", async () => {
      // The ordering this whole phase turns on. The provider finished and will
      // bill for the render; that fact must not wait on the platform's ability
      // to reach the artifact, or a transient acquisition problem would leave a
      // paid attempt reading as in-flight forever.
      const { attemptId, job } = await seedAcceptedProcessingAttempt("order");
      const result = await runner({
        source: fakeSource(async () => ({ kind: "SUCCEEDED", outputLocator: null })),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "OUTPUT_LOCATOR_UNAVAILABLE" });
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("PROVIDER_SUCCEEDED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.outputStorageKey).toBeNull();
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        ),
      ).toHaveLength(0);
    });

    it("keeps the certainty ACCEPTED on a provider execution failure", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("fail");
      const result = await runner({
        source: fakeSource(async () => ({
          kind: "FAILED",
          retryable: true,
          diagnosticCode: null,
        })),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "PROVIDER_COMPLETION_APPLIED" });
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("FAILED_RETRYABLE");
      // The provider ran a paid job. Rewriting this to DEFINITIVELY_REJECTED is
      // the one mistake that would make the Safety Guard forget the charge.
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).toBe("pred_fail");
      expect(row.providerAcceptedAt).not.toBeNull();
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("writes nothing at all while the provider is still working", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("prog");
      const before = await attemptRow(attemptId);
      const eventsBefore = (await eventsFor(attemptId)).length;

      for (let i = 0; i < 3; i += 1) {
        expect(
          await runner({
            source: fakeSource(async () => ({ kind: "IN_PROGRESS" })),
            transfer: fakeTransfer(VERIFIED_A),
          }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
        ).toEqual({ kind: "STILL_PROCESSING" });
      }

      // Three polls, no version bump and no events. Polling is observational;
      // an append-only heartbeat would bury the transitions that matter.
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(await eventsFor(attemptId)).toHaveLength(eventsBefore);
    });

    it("neither polls nor writes for an already verified attempt", async () => {
      const { attemptId } = await seedSucceeded("verified", true);
      const svc = completion();
      await svc.finalizeOutputVerification({ ...BASE, attemptId, receipt: RECEIPT_A });
      const before = await attemptRow(attemptId);

      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      const transfer = fakeTransfer(VERIFIED_A);
      expect(
        await runner({ source, transfer }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      ).toEqual({ kind: "ALREADY_VERIFIED" });
      expect(source.asked).toHaveLength(0);
      expect(transfer.calls).toHaveLength(0);
      expect(await attemptRow(attemptId)).toEqual(before);
    });
  });

  describe("the full path from PROCESSING to a verified output", () => {
    it("records completion, starts ingestion, transfers and verifies", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("full");
      const transfer = fakeTransfer(VERIFIED_A);
      const result = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer,
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "OUTPUT_VERIFIED" });
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.outputSha256).toBe(SHA_A);
      expect(row.outputStorageKey).toBe(
        managedGenerationOutputKey({ organizationId: ORG_A, attemptId }),
      );
      // The destination was derived, never chosen by the provider or the caller.
      expect(transfer.calls[0]?.destinationKey).toBe(row.outputStorageKey);
      expect((await reservationOf(job.id)).state).toBe("RESERVED");

      const events = await eventsFor(attemptId);
      for (const type of [
        PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
        OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        OUTPUT_VERIFIED_EVENT_TYPE,
      ]) {
        expect(events.filter((e) => e.eventType === type)).toHaveLength(1);
      }
    });

    it("starts ingestion from an attempt whose success is already on file", async () => {
      const { attemptId } = await seedSucceeded("fromsucc");
      const result = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "OUTPUT_VERIFIED" });
      // Exactly one provider-completion event: the seed's. This run added none.
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    });
  });

  describe("an interrupted copy is resumable", () => {
    it("resumes an OUTPUT_INGESTING attempt without a second ingestion event", async () => {
      // The crash-recovery case: a previous process entered OUTPUT_INGESTING and
      // stopped before or during the transfer. The state is deliberately left
      // alone so a later run can pick it up against the same deterministic key.
      const { attemptId } = await seedSucceeded("resume", true);
      const before = await attemptRow(attemptId);
      expect(before.orchestrationState).toBe("OUTPUT_INGESTING");

      const transfer = fakeTransfer(VERIFIED_A);
      const result = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer,
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "OUTPUT_VERIFIED" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(transfer.calls).toHaveLength(1);
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    });

    it("leaves the attempt ingesting when the transfer reports a transient problem", async () => {
      const { attemptId, job } = await seedSucceeded("transfail");
      const result = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(async () => ({ kind: "RETRYABLE_FAILURE" })),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({ kind: "TRANSFER_RETRYABLE_FAILURE" });
      const row = await attemptRow(attemptId);
      // Not PROVIDER_SUCCEEDED, and emphatically not FAILED_*: the provider
      // rendered the video, the platform's storage had a bad minute.
      expect(row.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.outputSha256).toBeNull();
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it.each([
      ["throws", () => Promise.reject(new Error(`upload failed for ${RAW_URL}`)), "TRANSFER_SOURCE_FAILED"],
      ["returns nonsense", async () => ({ kind: "NOPE" }), "TRANSFER_OUTCOME_MALFORMED"],
      ["returns a URL-bearing failure", async () => ({ kind: "RETRYABLE_FAILURE", url: RAW_URL }), "TRANSFER_OUTCOME_MALFORMED"],
    ])("leaves it ingesting when the transfer %s", async (_l, answer, kind) => {
      const { attemptId } = await seedSucceeded(`tf${kind}`);
      const result = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(answer),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result.kind).toBe(kind);
      // Already-entered ingestion is a true fact; a misbehaving port is no
      // reason to discard it.
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
      expect(JSON.stringify(result)).not.toContain("SECRETSIGNATURE");
    });

    it("recovers on a later run after a transfer failure", async () => {
      const { attemptId } = await seedSucceeded("recover");
      const first = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(async () => ({ kind: "RETRYABLE_FAILURE" })),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });
      expect(first).toEqual({ kind: "TRANSFER_RETRYABLE_FAILURE" });

      const second = await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });
      expect(second).toEqual({ kind: "OUTPUT_VERIFIED" });
      expect((await attemptRow(attemptId)).outputSha256).toBe(SHA_A);
    });
  });

  describe("recorded provider reality is never overwritten by a later poll", () => {
    it.each([
      ["PROVIDER_SUCCEEDED", false],
      ["OUTPUT_INGESTING", true],
    ] as const)("refuses a late FAILED poll against a %s attempt", async (state, ingesting) => {
      const { attemptId } = await seedSucceeded(`late${state}`, ingesting);
      const before = await attemptRow(attemptId);

      const result = await runner({
        source: fakeSource(async () => ({
          kind: "FAILED",
          retryable: false,
          diagnosticCode: null,
        })),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({
        kind: "PROVIDER_REALITY_CONFLICT",
        reason: "FAILED_AGAINST_RECORDED_SUCCESS",
      });
      expect(await attemptRow(attemptId)).toEqual(before);
    });

    it("refuses to move an ingesting attempt backwards on IN_PROGRESS", async () => {
      const { attemptId } = await seedSucceeded("backwards", true);
      const before = await attemptRow(attemptId);
      const result = await runner({
        source: fakeSource(async () => ({ kind: "IN_PROGRESS" })),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect(result).toEqual({
        kind: "PROVIDER_REALITY_CONFLICT",
        reason: "IN_PROGRESS_AGAINST_RECORDED_SUCCESS",
      });
      expect(await attemptRow(attemptId)).toEqual(before);
    });
  });

  describe("no database transaction is held across external I/O", () => {
    it("lets an independent writer commit while the status source is blocked", async () => {
      // The failure this detects is invisible without a real connection: a
      // runner that opened a transaction before polling would hold the
      // organization+cycle advisory lock across a vendor's response time, and a
      // competing completion would queue behind it.
      const { attemptId } = await seedAcceptedProcessingAttempt("nolockpoll");
      const g = gate();

      const blockedRun = settled(
        runner({
          source: fakeSource(async () => {
            await g.held;
            return { kind: "IN_PROGRESS" };
          }),
          transfer: fakeTransfer(VERIFIED_A),
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      );

      await breathe(4);
      expect(blockedRun.done()).toBe(false);

      // A real authoritative mutation on the same attempt, on another
      // connection, taking the same locks Phase 2H-1 takes.
      const rivalWrite = await completion(rival).recordProviderCompletion({
        ...BASE,
        attemptId,
        observation: { kind: "SUCCEEDED" },
      });
      expect(rivalWrite.kind).toBe("APPLIED");
      // It committed while the poll was still outstanding — proof no lock was
      // held across the await.
      expect(blockedRun.done()).toBe(false);

      g.open();
      await blockedRun.value;
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROVIDER_SUCCEEDED");
    });

    it("lets an independent writer commit while the transfer is blocked", async () => {
      const { attemptId } = await seedSucceeded("nolocktransfer");
      const g = gate();

      const blockedRun = settled(
        runner({
          source: fakeSource(SUCCEEDED_WITH),
          transfer: fakeTransfer(async () => {
            await g.held;
            return { kind: "RETRYABLE_FAILURE" };
          }),
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      );

      await breathe(4);
      expect(blockedRun.done()).toBe(false);
      // The attempt is already ingesting: the begin transaction committed before
      // the transfer was awaited, which is itself part of the required ordering.
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");

      // A competing finalization on another connection, taking the same locks.
      const rivalWrite = await completion(rival).finalizeOutputVerification({
        ...BASE,
        attemptId,
        receipt: RECEIPT_A,
      });
      expect(rivalWrite.kind).toBe("APPLIED");
      expect(blockedRun.done()).toBe(false);

      g.open();
      expect((await blockedRun.value).kind).toBe("TRANSFER_RETRYABLE_FAILURE");
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
    });
  });

  describe("concurrency", () => {
    it("gives two PROCESSING runners one history and at most one transfer", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("racestart");
      const t1 = fakeTransfer(VERIFIED_A);
      const t2 = fakeTransfer(VERIFIED_A);

      const results = await Promise.all([
        runner({ client: prisma, source: fakeSource(SUCCEEDED_WITH), transfer: t1 })
          .runProviderOutputAttemptOnce({ ...BASE, attemptId }),
        runner({ client: other, source: fakeSource(SUCCEEDED_WITH), transfer: t2 })
          .runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      ]);

      // Neither rejected: an expected race is an ordinary result, not an error.
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toContain("OUTPUT_VERIFIED");
      // The other runner reached one of the two ways of losing: it lost the
      // ingestion claim, or it arrived after the winner had already verified.
      expect(["INGESTION_ALREADY_CLAIMED", "ALREADY_VERIFIED"]).toContain(
        kinds.find((k) => k !== "OUTPUT_VERIFIED"),
      );
      const events = await eventsFor(attemptId);
      expect(
        events.filter((e) => e.eventType === PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.eventType === OUTPUT_INGESTION_STARTED_EVENT_TYPE),
      ).toHaveLength(1);
      // Exactly one copy, not merely "not too many": only the runner whose own
      // begin applied may transfer, and the compare-and-set lets exactly one
      // begin apply.
      expect(t1.calls.length + t2.calls.length).toBe(1);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
    });

    it("does not transfer after losing the ingestion claim", async () => {
      // Deterministic rather than raced: the run reads a PROVIDER_SUCCEEDED
      // context, and while its poll is blocked a rival claims the ingestion
      // transition. When the poll returns, this run's own begin is answered
      // ALREADY_INGESTING — and it must stop instead of starting a second copy
      // of the same object.
      const { attemptId } = await seedSucceeded("claimlost");
      const transfer = fakeTransfer(VERIFIED_A);
      const g = gate();

      const blocked = settled(
        runner({
          source: fakeSource(async () => {
            await g.held;
            return { kind: "SUCCEEDED", outputLocator: locator() };
          }),
          transfer,
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      );

      await breathe(4);
      // The rival wins the transition while this run is still outside the
      // database, waiting on its status source.
      const claimed = await completion(rival).beginOutputIngestion({ ...BASE, attemptId });
      expect(claimed.kind).toBe("APPLIED");

      g.open();
      expect(await blocked.value).toEqual({ kind: "INGESTION_ALREADY_CLAIMED" });
      expect(transfer.calls).toHaveLength(0);
      // One ingestion event, from the rival. Nothing was duplicated.
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === OUTPUT_INGESTION_STARTED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
    });

    it("lets two OUTPUT_INGESTING runners both transfer, then verifies once", async () => {
      // The explicitly accepted at-least-once case. Both may copy — the key is
      // deterministic and the object write is replacement-safe — and exactly one
      // finalization applies.
      const { attemptId } = await seedSucceeded("raceingest", true);
      const t1 = fakeTransfer(VERIFIED_A);
      const t2 = fakeTransfer(VERIFIED_A);

      const results = await Promise.all([
        runner({ client: prisma, source: fakeSource(SUCCEEDED_WITH), transfer: t1 })
          .runProviderOutputAttemptOnce({ ...BASE, attemptId }),
        runner({ client: other, source: fakeSource(SUCCEEDED_WITH), transfer: t2 })
          .runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      ]);

      expect(t1.calls).toHaveLength(1);
      expect(t2.calls).toHaveLength(1);
      expect(results.map((r) => r.kind).sort()).toEqual([
        "OUTPUT_VERIFICATION_REPLAYED",
        "OUTPUT_VERIFIED",
      ]);
      expect(
        (await eventsFor(attemptId)).filter((e) => e.eventType === OUTPUT_VERIFIED_EVENT_TYPE),
      ).toHaveLength(1);
      expect((await attemptRow(attemptId)).outputSha256).toBe(SHA_A);
    });

    it("keeps the first verified bytes when two transfers disagree", async () => {
      const { attemptId } = await seedSucceeded("raceconflict", true);
      const results = await Promise.all([
        runner({
          client: prisma,
          source: fakeSource(SUCCEEDED_WITH),
          transfer: fakeTransfer(VERIFIED_A),
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
        runner({
          client: other,
          source: fakeSource(SUCCEEDED_WITH),
          transfer: fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT_B })),
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId }),
      ]);

      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["OUTPUT_VERIFIED", "PROVIDER_REALITY_CONFLICT"]);
      const row = await attemptRow(attemptId);
      // Verified metadata is immutable: whichever won, it was not overwritten.
      expect([SHA_A, RECEIPT_B.sha256]).toContain(row.outputSha256);
      expect(
        (await eventsFor(attemptId)).filter((e) => e.eventType === OUTPUT_VERIFIED_EVENT_TYPE),
      ).toHaveLength(1);
    });
  });

  describe("one bounded batch", () => {
    it("sweeps the three orchestrated stages and skips the verified", async () => {
      const processing = await seedAcceptedProcessingAttempt("batchproc");
      const succeeded = await seedSucceeded("batchsucc");
      const ingesting = await seedSucceeded("batching", true);
      const verified = await seedSucceeded("batchver", true);
      await completion().finalizeOutputVerification({
        ...BASE,
        attemptId: verified.attemptId,
        receipt: RECEIPT_A,
      });
      const verifiedBefore = await attemptRow(verified.attemptId);

      const source = fakeSource(async () => ({ kind: "IN_PROGRESS" }));
      const report = await runner({
        source,
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputBatchOnce({ limit: 50, context: ctx() });

      expect(report.candidates).toBe(3);
      // The verified attempt was never a candidate and never polled.
      expect(source.asked).toHaveLength(3);
      expect(await attemptRow(verified.attemptId)).toEqual(verifiedBefore);
      for (const id of [processing.attemptId, succeeded.attemptId, ingesting.attemptId]) {
        expect(id).toBeTruthy();
      }
    });

    it("reports only closed kinds, carrying no external text", async () => {
      await seedAcceptedProcessingAttempt("batchsafe");
      const report = await runner({
        source: fakeSource(() => Promise.reject(new Error(`unreachable ${RAW_URL}`))),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputBatchOnce({ limit: 10, context: ctx() });

      expect(report.results).toEqual(["STATUS_SOURCE_FAILED"]);
      expect(JSON.stringify(report)).not.toContain("SECRETSIGNATURE");
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101])(
      "refuses the limit %s before any query",
      async (limit) => {
        await expect(
          runner({
            source: fakeSource(async () => ({ kind: "IN_PROGRESS" })),
            transfer: fakeTransfer(VERIFIED_A),
          }).runProviderOutputBatchOnce({ limit, context: ctx() }),
        ).rejects.toThrow(/between 1 and 100/);
      },
    );
  });

  describe("nothing here touches customer entitlement or delivery", () => {
    it("leaves the reservation, request, scene and job untouched by a full run", async () => {
      const { attemptId, job } = await seedAcceptedProcessingAttempt("entitle");
      const reservationBefore = await reservationOf(job.id);
      const requestBefore = await prisma.sceneGenerationRequest.findFirstOrThrow({
        where: { id: "genreq_entitle" },
      });
      const jobBefore = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      const sceneBefore = await prisma.generationScene.findUniqueOrThrow({
        where: { id: "genscene_entitle" },
      });

      await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
      // A verified managed output is provider-attempt integrity, not delivery.
      expect(await reservationOf(job.id)).toEqual(reservationBefore);
      expect(
        await prisma.sceneGenerationRequest.findFirstOrThrow({ where: { id: "genreq_entitle" } }),
      ).toEqual(requestBefore);
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(
        jobBefore,
      );
      expect(
        await prisma.generationScene.findUniqueOrThrow({ where: { id: "genscene_entitle" } }),
      ).toEqual(sceneBefore);
    });

    it("creates no additional attempt on any path", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("noextra");
      const before = await prisma.sceneGeneration.count();
      for (const answer of [
        async () => ({ kind: "FAILED", retryable: true, diagnosticCode: null }),
        async () => ({ kind: "IN_PROGRESS" }),
      ]) {
        await runner({
          source: fakeSource(answer),
          transfer: fakeTransfer(VERIFIED_A),
        }).runProviderOutputAttemptOnce({ ...BASE, attemptId });
      }
      // A retryable provider failure records that a retry is permissible. It
      // does not spend a second unit of provider capacity.
      expect(await prisma.sceneGeneration.count()).toBe(before);
    });
  });

  describe("no transient locator reaches persistence", () => {
    it("leaves no trace of it in the row, the events or the audit log", async () => {
      const { attemptId } = await seedAcceptedProcessingAttempt("secret");
      await runner({
        source: fakeSource(SUCCEEDED_WITH),
        transfer: fakeTransfer(VERIFIED_A),
      }).runProviderOutputAttemptOnce({ ...BASE, attemptId });

      const row = await attemptRow(attemptId);
      const events = await eventsFor(attemptId);
      const audit = await prisma.auditLog.findMany({ where: { organizationId: ORG_A } });
      const everything = JSON.stringify({ row, events, audit }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : (v as unknown),
      );

      for (const fragment of [
        "SECRETSIGNATURE",
        "provider.example",
        "X-Amz-Signature",
        "https://",
      ]) {
        expect(`${fragment}: ${everything.includes(fragment)}`).toBe(`${fragment}: false`);
      }
      // And the row gained no column to hold one.
      expect(Object.keys(row)).not.toContain("providerOutputUrl");
      expect(Object.keys(row)).not.toContain("temporaryOutputUrl");
    });

    it("has no column anywhere in the table whose name suggests a URL", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'scene_generations'
      `;
      for (const { column_name } of columns) {
        expect(column_name.toLowerCase()).not.toContain("url");
      }
    });
  });
});
