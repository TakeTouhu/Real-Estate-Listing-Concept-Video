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
  validateReconciliationPolicy,
  OUTPUT_INGESTION_STARTED_EVENT_TYPE,
  OUTPUT_VERIFIED_EVENT_TYPE,
  PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
  PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
  type ManagedOutputTransferPort,
  type PricingSnapshot,
  type ReconciliationPolicy,
  type TransientProviderOutputLocator,
} from "@app/domain";
import {
  createCompletionRepository,
  createProviderPollingContextReader,
  createSubmissionOutcomeRepository,
} from "@app/database";
import {
  FalQueueCompletionStatusSource,
  MINIMAX_H3_MAX_MODEL_ID,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "@app/video-providers";
import {
  ASSET_A,
  ctx,
  dropTenants,
  H3_MAX_IDENTITY,
  HAS_DB,
  ORG_A,
  PROJECT_A,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The real fal adapter, the real Phase 2H-2 runner, the real Phase 2H-1
 * persistence, live PostgreSQL — and a scripted transport.
 *
 * The unit suites prove the adapter maps fal's vocabulary correctly. What they
 * cannot prove is that the mapping still means what it should once it travels
 * through the runner and lands in a row: that a status transport failure really
 * does leave the attempt untouched, that a `SUCCEEDED` with a null locator
 * really does persist provider success *before* concluding it cannot fetch
 * anything, and that a recognized fal failure really does record a provider
 * failure without disturbing the submission certainty a customer's charge
 * depends on.
 *
 * **No real network.** The only transport in this file answers from an array.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const CYCLE = "2026-09";
const CREDENTIAL = "fal-key-itest-0000";
const OUTPUT_URL = "https://fal.media/files/panda/itest.mp4?X-Fal-Signature=SECRETSIGNATURE";

const RECEIPT = {
  sha256: sha256Digest("c".repeat(64)),
  sizeBytes: safePositiveByteCount(4_194_304),
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

/** A transport that answers from a script and records every request. */
function transport(...answers: readonly (HttpResponse | (() => never))[]): HttpClient & {
  readonly sent: HttpRequest[];
} {
  const sent: HttpRequest[] = [];
  let index = 0;
  return {
    sent,
    async request(req) {
      sent.push(req);
      const answer = answers[index++];
      if (answer === undefined) throw new Error(`unscripted request: ${req.method} ${req.url}`);
      if (typeof answer === "function") return answer();
      return answer;
    },
  };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(body) };
}

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

/** The real runner, wired to the real fal adapter over a scripted transport. */
function falRunner(http: HttpClient, transfer: ManagedOutputTransferPort) {
  const completionRepository = createCompletionRepository(prisma);
  return createProviderOutputRunner({
    polling: createProviderPollingContextReader(prisma, completionRepository),
    statusSource: new FalQueueCompletionStatusSource({ credential: CREDENTIAL }, { http }),
    transfer,
    completion: createProviderCompletionService({
      completion: completionRepository,
      clock: createFixedSubmissionClock(BOUNDARY),
    }),
  });
}

function h3MaxSnapshot(): PricingSnapshot {
  const contract = createProviderPricingCatalog().findByIdentity(H3_MAX_IDENTITY);
  if (contract === undefined) throw new Error("expected an H3 Max pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: 5,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

/**
 * A chain whose attempt is `PROCESSING + ACCEPTED` against **fal / H3 Max**.
 *
 * The provider identity is the whole point of the fixture. Phase 2H-2 takes the
 * lookup ref from these persisted columns, so an attempt seeded as WaveSpeed
 * would exercise the adapter's refusal path rather than its mapping.
 */
async function seedFalProcessingAttempt(suffix: string, predictionId: string) {
  const repos = repositories(prisma);

  const created = await repos.jobs.create(
    ORG_A,
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
    organizationId: ORG_A,
    id: created.job.id,
    expectedState: "CREATED",
    expectedVersion: 0,
    nextState: "RESERVING",
    context: ctx(),
  });
  if (moved.kind !== "APPLIED") throw new Error("expected APPLIED");

  const reserved = await repos.reservations.reserve(
    ORG_A,
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
    ORG_A,
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
    ORG_A,
    { id: `genreq_${suffix}`, generationSceneId: scene.id, requestedByUserId: "usr_itest" },
    ctx(),
  );
  if (request === null) throw new Error("request not created");

  const admitted = await repos.attempts.admit(
    ORG_A,
    {
      id: `sgen_${suffix}`,
      generationSceneRequestId: request.id,
      providerName: "fal",
      providerModelId: MINIMAX_H3_MAX_MODEL_ID,
      requestModelKey: "minimax-h3-max",
      requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
      // H3 Max renders 768P natively; the 1080p product target is reached by
      // composition, not by asking the model for something it cannot produce.
      requestNativeGenerationResolution: "768P",
      requestResolutionNormalization: "UPSCALE",
      requestNativeMeetsTarget: false,
      pricingSnapshotId: `price_sgen_${suffix}`,
      pricingSnapshot: h3MaxSnapshot(),
      fxSnapshot: null,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`attempt: ${admitted.kind}`);

  const armed = await repos.attempts.armProviderBoundary({
    organizationId: ORG_A,
    id: admitted.attempt.id,
    expectedVersion: admitted.attempt.stateVersion,
    context: ctx(),
  });
  if (armed.kind !== "ARMED") throw new Error(`arm: ${armed.kind}`);
  await prisma.sceneGeneration.update({
    where: { id: admitted.attempt.id },
    data: { submissionBoundaryEnteredAt: new Date(BOUNDARY) },
  });

  const outcomes = createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(prisma),
    clock: createFixedSubmissionClock(BOUNDARY),
    policy: POLICY,
  });
  const accepted = await outcomes.recordObservation({
    organizationId: ORG_A,
    attemptId: admitted.attempt.id,
    observation: { kind: "ACCEPTED", providerPredictionId: predictionId },
    context: ctx(),
  });
  if (accepted.kind !== "APPLIED") throw new Error(`acceptance: ${accepted.kind}`);

  return { jobId: created.job.id, attemptId: admitted.attempt.id };
}

async function attemptRow(attemptId: string) {
  return prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attemptId } });
}

/** `JSON.stringify` with BigInt support — the row carries a verified byte count. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

async function eventsFor(attemptId: string) {
  return repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attemptId);
}

async function eventTypes(attemptId: string): Promise<string[]> {
  return (await eventsFor(attemptId)).map((e) => e.eventType);
}

const describeDb = HAS_DB ? describe : describe.skip;

describeDb("the fal status adapter through the Phase 2H-2 runner", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("asks fal about the persisted prediction, using the persisted identity", async () => {
    const { attemptId } = await seedFalProcessingAttempt("falid", "req-abc-123");
    const http = transport(ok({ status: "IN_QUEUE" }));

    await falRunner(http, fakeTransfer(async () => ({ kind: "RETRYABLE_FAILURE" }))).runProviderOutputAttemptOnce(
      { organizationId: ORG_A, attemptId, context: ctx() },
    );

    // The row said fal, H3 Max and `req-abc-123`; that is what was asked. No
    // environment variable, default model or catalog selection participated.
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]!.url).toBe(
      `https://queue.fal.run/${MINIMAX_H3_MAX_MODEL_ID}/requests/req-abc-123/status`,
    );
  });

  describe("fal is still working", () => {
    it("reports STILL_PROCESSING and writes nothing at all", async () => {
      const { attemptId } = await seedFalProcessingAttempt("prog", "req-prog");
      const before = await attemptRow(attemptId);
      const http = transport(ok({ status: "IN_PROGRESS", queue_position: 2, logs: ["x"] }));

      const result = await falRunner(
        http,
        fakeTransfer(async () => ({ kind: "RETRYABLE_FAILURE" })),
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(result.kind).toBe("STILL_PROCESSING");
      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("PROCESSING");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.submissionCertainty).toBe("ACCEPTED");
      // No lifecycle event: recording "nothing happened" is a write that
      // changes nothing and an audit row that means nothing.
      expect(await eventTypes(attemptId)).not.toContain(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
      expect(await eventTypes(attemptId)).not.toContain(OUTPUT_INGESTION_STARTED_EVENT_TYPE);
    });

    it("does not ask for the result while the render is unfinished", async () => {
      const { attemptId } = await seedFalProcessingAttempt("nores", "req-nores");
      const http = transport(ok({ status: "IN_QUEUE" }));

      await falRunner(http, fakeTransfer(async () => ({ kind: "RETRYABLE_FAILURE" }))).runProviderOutputAttemptOnce(
        { organizationId: ORG_A, attemptId, context: ctx() },
      );

      // Exactly one request, and it is the status resource. The result resource
      // is the request itself, so "did it ask for the result" cannot be tested
      // by a `/response` suffix — it is tested by the request count and the
      // `/status` suffix being present on the only call made.
      expect(http.sent).toHaveLength(1);
      expect(http.sent[0]!.url.endsWith("/status")).toBe(true);
    });
  });

  describe("fal finished and the output can be fetched", () => {
    it("records provider success, begins ingestion and verifies the managed output", async () => {
      const { attemptId } = await seedFalProcessingAttempt("done", "req-done");
      const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
      const transfer = fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }));

      const result = await falRunner(http, transfer).runProviderOutputAttemptOnce({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });

      expect(result.kind).toBe("OUTPUT_VERIFIED");
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.outputStorageKey).toBe(
        managedGenerationOutputKey({ organizationId: ORG_A, attemptId }),
      );

      const types = await eventTypes(attemptId);
      expect(types).toContain(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
      expect(types).toContain(OUTPUT_INGESTION_STARTED_EVENT_TYPE);
      expect(types).toContain(OUTPUT_VERIFIED_EVENT_TYPE);
      // Provider truth is recorded before the copy is attempted, not after.
      expect(types.indexOf(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE)).toBeLessThan(
        types.indexOf(OUTPUT_INGESTION_STARTED_EVENT_TYPE),
      );
    });

    it("hands the transfer port the locator the adapter built, and the derived key", async () => {
      const { attemptId } = await seedFalProcessingAttempt("hand", "req-hand");
      const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));
      const transfer = fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }));

      await falRunner(http, transfer).runProviderOutputAttemptOnce({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });

      expect(transfer.calls).toHaveLength(1);
      expect(transfer.calls[0]!.destinationKey).toBe(
        managedGenerationOutputKey({ organizationId: ORG_A, attemptId }),
      );
    });

    it("puts no part of the fal output URL into PostgreSQL", async () => {
      const { attemptId } = await seedFalProcessingAttempt("secret", "req-secret");
      const http = transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } }));

      await falRunner(http, fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }))).runProviderOutputAttemptOnce(
        { organizationId: ORG_A, attemptId, context: ctx() },
      );

      // Every column and every event payload, serialized and searched. A signed
      // media URL is a bearer credential with an expiry; a column holding one is
      // wrong within hours and dangerous immediately.
      const row = serialize(await attemptRow(attemptId));
      const events = serialize(await eventsFor(attemptId));
      for (const haystack of [row, events]) {
        for (const fragment of ["SECRETSIGNATURE", "fal.media", "X-Fal-Signature", CREDENTIAL]) {
          expect(haystack).not.toContain(fragment);
        }
      }
    });
  });

  describe("fal finished but the output cannot be fetched", () => {
    it("persists provider success first, then reports the locator unavailable", async () => {
      const { attemptId } = await seedFalProcessingAttempt("nolink", "req-nolink");
      const http = transport(ok({ status: "COMPLETED" }), { status: 404, body: "" });
      const transfer = fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }));

      const result = await falRunner(http, transfer).runProviderOutputAttemptOnce({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });

      expect(result.kind).toBe("OUTPUT_LOCATOR_UNAVAILABLE");
      const row = await attemptRow(attemptId);
      // The money-relevant half is durable. fal ran and will bill for it, and a
      // 404 on the artifact endpoint says nothing about that.
      expect(row.orchestrationState).toBe("PROVIDER_SUCCEEDED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(await eventTypes(attemptId)).toContain(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
      // Nothing was copied, so nothing may claim to have been.
      expect(transfer.calls).toHaveLength(0);
      expect(await eventTypes(attemptId)).not.toContain(OUTPUT_VERIFIED_EVENT_TYPE);
    });

    it("never records a provider failure when only the artifact was unreachable", async () => {
      const { attemptId } = await seedFalProcessingAttempt("nofail", "req-nofail");
      const http = transport(ok({ status: "COMPLETED" }), { status: 500, body: "" });

      await falRunner(http, fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }))).runProviderOutputAttemptOnce(
        { organizationId: ORG_A, attemptId, context: ctx() },
      );

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).not.toBe("FAILED_RETRYABLE");
      expect(row.orchestrationState).not.toBe("FAILED_TERMINAL");
      expect(await eventTypes(attemptId)).not.toContain(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
    });

    it("lets a later poll reacquire the locator and finish the copy", async () => {
      const { attemptId } = await seedFalProcessingAttempt("again", "req-again");
      const transfer = fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }));

      const first = await falRunner(
        transport(ok({ status: "COMPLETED" }), { status: 404, body: "" }),
        transfer,
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });
      expect(first.kind).toBe("OUTPUT_LOCATOR_UNAVAILABLE");

      // A second pass, with fal now serving the artifact. The attempt was left
      // in a state a later run can act on — that is what makes the ordering
      // above safe rather than merely defensible.
      const second = await falRunner(
        transport(ok({ status: "COMPLETED" }), ok({ video: { url: OUTPUT_URL } })),
        transfer,
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(second.kind).toBe("OUTPUT_VERIFIED");
      expect((await attemptRow(attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
    });
  });

  describe("the status call itself fails", () => {
    it.each([
      ["a transport throw", () => transport(() => { throw new Error("ECONNREFUSED 1.2.3.4:443"); })],
      ["a 502", () => transport({ status: 502, body: "<html>bad gateway</html>" })],
      ["an unreadable body", () => transport({ status: 200, body: "<html>" })],
      ["an unknown lifecycle state", () => transport(ok({ status: "PAUSED" }))],
      ["an unclassifiable failure", () => transport(ok({ status: "COMPLETED", error_type: "runner_evaporated" }))],
    ])("maps %s to STATUS_SOURCE_FAILED and leaves the attempt untouched", async (label, build) => {
      const suffix = `sf${label.replace(/[^a-z]/gi, "").slice(0, 8)}`;
      const { attemptId } = await seedFalProcessingAttempt(suffix, `req-${suffix}`);
      const before = await attemptRow(attemptId);

      const result = await falRunner(
        build(),
        fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT })),
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(result.kind).toBe("STATUS_SOURCE_FAILED");
      const after = await attemptRow(attemptId);
      // "I could not find out" is not evidence about a paid render. Zero
      // mutation, including the optimistic-concurrency version.
      expect(after.orchestrationState).toBe("PROCESSING");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.submissionCertainty).toBe("ACCEPTED");
      expect(after.outputStorageKey).toBeNull();
      const types = await eventTypes(attemptId);
      expect(types).not.toContain(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
      expect(types).not.toContain(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
    });
  });

  describe("fal reports a recognized execution failure", () => {
    it.each([
      ["runner_disconnected", "FAILED_RETRYABLE", "CONNECTION_RESET"],
      ["request_timeout", "FAILED_RETRYABLE", "TIMEOUT"],
      ["internal_error", "FAILED_RETRYABLE", null],
      ["bad_request", "FAILED_TERMINAL", "LOCAL_CONFIGURATION"],
      ["client_cancelled", "FAILED_TERMINAL", null],
    ] as const)("records %s as %s with diagnostic %s", async (errorType, state, code) => {
      const suffix = `fail${errorType.replace(/_/g, "").slice(0, 10)}`;
      const { attemptId } = await seedFalProcessingAttempt(suffix, `req-${suffix}`);
      const http = transport(
        ok({
          status: "COMPLETED",
          error: "CUDA OOM at /opt/weights/secret.safetensors",
          error_type: errorType,
        }),
      );

      const result = await falRunner(
        http,
        fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT })),
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(result.kind).toBe("PROVIDER_COMPLETION_APPLIED");
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe(state);
      // The customer's charge rests on the submission being accepted. A failed
      // *execution* does not revise that: fal ran the render and billed for it.
      expect(row.submissionCertainty).toBe("ACCEPTED");
      // The execution diagnostic lands in safe transition metadata, never on
      // the attempt row — `normalizedErrorCode` records why the attempt reached
      // the provider, and an execution failure is a later, separate fact that
      // must not overwrite it (ADR-0038).
      expect(row.normalizedErrorCode).toBeNull();
      const failure = (await eventsFor(attemptId)).find(
        (e) => e.eventType === PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
      );
      expect(failure).toBeDefined();
      expect(failure?.safeMetadata).toMatchObject({
        retryable: state === "FAILED_RETRYABLE",
        diagnosticCode: code,
        submissionCertainty: "ACCEPTED",
      });
      // No result request: nothing is known to have been produced.
      expect(http.sent).toHaveLength(1);
    });

    it("persists neither the fal error type nor the human-readable error", async () => {
      const { attemptId } = await seedFalProcessingAttempt("prose", "req-prose");
      const http = transport(
        ok({
          status: "COMPLETED",
          error: "CUDA OOM at /opt/weights/secret.safetensors while rendering 'a sunlit living room'",
          error_type: "runner_server_error",
        }),
      );

      await falRunner(http, fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT }))).runProviderOutputAttemptOnce(
        { organizationId: ORG_A, attemptId, context: ctx() },
      );

      const row = serialize(await attemptRow(attemptId));
      const events = serialize(await eventsFor(attemptId));
      for (const haystack of [row, events]) {
        for (const fragment of ["runner_server_error", "CUDA", "safetensors", "/opt/weights"]) {
          expect(haystack).not.toContain(fragment);
        }
      }
    });
  });

  describe("an attempt this adapter cannot answer for", () => {
    it("refuses a WaveSpeed attempt without contacting fal", async () => {
      // Seeded through the shared fixture, which admits WaveSpeed identity.
      const { attemptId } = await seedFalProcessingAttempt("wrong", "req-wrong");
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { providerName: "wavespeed" },
      });
      const before = await attemptRow(attemptId);
      const http = transport();

      const result = await falRunner(
        http,
        fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT })),
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(result.kind).toBe("STATUS_SOURCE_FAILED");
      expect(http.sent).toEqual([]);
      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("PROCESSING");
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("refuses a persisted model id it does not serve, before building any URL", async () => {
      const { attemptId } = await seedFalProcessingAttempt("model", "req-model");
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { providerModelId: "https://attacker.example/v1/models" },
      });
      const http = transport();

      const result = await falRunner(
        http,
        fakeTransfer(async () => ({ kind: "VERIFIED", receipt: RECEIPT })),
      ).runProviderOutputAttemptOnce({ organizationId: ORG_A, attemptId, context: ctx() });

      expect(result.kind).toBe("STATUS_SOURCE_FAILED");
      // A persisted model id never becomes outbound network authority — the
      // comparison happens before a URL exists.
      expect(http.sent).toEqual([]);
    });
  });
});
