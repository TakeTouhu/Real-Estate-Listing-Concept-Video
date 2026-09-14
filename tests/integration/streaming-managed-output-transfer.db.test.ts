import { createHash } from "node:crypto";
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
  TransientProviderOutputLocator,
  validateReconciliationPolicy,
  OUTPUT_INGESTION_STARTED_EVENT_TYPE,
  OUTPUT_VERIFIED_EVENT_TYPE,
  PROVIDER_COMPLETION_FAILED_EVENT_TYPE,
  PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE,
  type PricingSnapshot,
  type ProviderCompletionStatusSource,
  type ReconciliationPolicy,
} from "@app/domain";
import {
  createCompletionRepository,
  createProviderPollingContextReader,
  createSubmissionOutcomeRepository,
} from "@app/database";
import { StreamingManagedOutputTransfer } from "@app/storage";
import {
  createTransferBarrier,
  FakeManagedOutputStagingSink,
  FakeProviderOutputByteSource,
  type FakeByteSourceScript,
  type FakeStagingSinkOptions,
} from "@app/storage/testing";
import {
  ASSET_A,
  ctx,
  dropTenants,
  HAS_DB,
  OPEN_VIDEO_IDENTITY,
  ORG_A,
  PROJECT_A,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The real streaming core, through the real Phase 2H-2 runner and the real
 * Phase 2H-1 persistence, against live PostgreSQL — with a scripted byte source
 * and an in-memory first-publish-wins sink.
 *
 * The unit suite proves the core's own properties. What only a database can
 * prove is that they still mean what they should once a row is involved: that
 * the persisted digest is the digest of the bytes that were actually staged,
 * that the persisted key is the one the application derived and nobody chose,
 * that a transfer failure of every kind leaves the attempt ingesting with its
 * certainty and its reservation untouched, that a crash after publish but
 * before finalization is recoverable, and — the one that is invisible without
 * a real connection — that no lock is held while bytes are moving.
 *
 * **No real network and no real object store.** Nothing here can reach either.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second connection, so a competing writer can contend while a fake is blocked. */
const rival = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const BOUNDARY = epochMillisFromDate(new Date("2026-09-14T00:00:00.000Z"));
const CYCLE = "2026-09";
const RAW_URL = "https://fal.media/files/panda/itest.mp4?X-Fal-Signature=SECRETSIGNATURE";

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

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function digestOf(...chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

/** `JSON.stringify` with BigInt support — the row carries a verified byte count. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function completion(client: PrismaClient = prisma) {
  return createProviderCompletionService({
    completion: createCompletionRepository(client),
    clock: createFixedSubmissionClock(BOUNDARY),
  });
}

function succeededSource(): ProviderCompletionStatusSource {
  return { poll: async () => ({ kind: "SUCCEEDED", outputLocator: locator() }) };
}

/** The real runner, wired to the real streaming core over fakes. */
function streamingRunner(options: {
  readonly script: FakeByteSourceScript;
  readonly sink?: FakeManagedOutputStagingSink;
  readonly sinkOptions?: FakeStagingSinkOptions;
  readonly maxBytes?: number;
  readonly client?: PrismaClient;
}) {
  const client = options.client ?? prisma;
  const completionRepository = createCompletionRepository(client);
  const source = new FakeProviderOutputByteSource(options.script);
  const sink = options.sink ?? new FakeManagedOutputStagingSink(options.sinkOptions ?? {});
  const transfer = new StreamingManagedOutputTransfer(
    { maxBytes: options.maxBytes ?? 1_048_576 },
    { source, staging: sink },
  );
  const runner = createProviderOutputRunner({
    polling: createProviderPollingContextReader(client, completionRepository),
    statusSource: succeededSource(),
    transfer,
    completion: completion(client),
  });
  return { runner, source, sink, transfer };
}

function snapshotFor(seconds: number): PricingSnapshot {
  const contract = createProviderPricingCatalog().findByIdentity(OPEN_VIDEO_IDENTITY);
  if (contract === undefined) throw new Error("expected a pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey: "NORMAL_AI",
    requestedSeconds: seconds,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

/** A chain whose attempt is `PROCESSING + ACCEPTED`, built by the real phases. */
async function seedAcceptedProcessingAttempt(suffix: string) {
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
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
      requestNativeGenerationResolution: "1080p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
      pricingSnapshotId: `price_sgen_${suffix}`,
      pricingSnapshot: snapshotFor(5),
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
    observation: { kind: "ACCEPTED", providerPredictionId: `pred_${suffix}` },
    context: ctx(),
  });
  if (accepted.kind !== "APPLIED") throw new Error(`acceptance: ${accepted.kind}`);

  return {
    jobId: created.job.id,
    sceneId: scene.id,
    requestId: request.id,
    attemptId: admitted.attempt.id,
  };
}

/** Drive an attempt to `OUTPUT_INGESTING + ACCEPTED`. */
async function seedIngesting(suffix: string) {
  const seeded = await seedAcceptedProcessingAttempt(suffix);
  const svc = completion();
  const base = { organizationId: ORG_A, attemptId: seeded.attemptId, context: ctx() };
  const done = await svc.recordProviderCompletion({ ...base, observation: { kind: "SUCCEEDED" } });
  if (done.kind !== "APPLIED") throw new Error(`seed completion: ${done.kind}`);
  const begun = await svc.beginOutputIngestion(base);
  if (begun.kind !== "APPLIED") throw new Error(`seed ingestion: ${begun.kind}`);
  return seeded;
}

async function attemptRow(attemptId: string) {
  return prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attemptId } });
}

async function eventTypes(attemptId: string): Promise<string[]> {
  const events = await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", attemptId);
  return events.map((e) => e.eventType);
}

/** Everything a customer's entitlement rests on, serialized for equality. */
async function lifecycleSnapshot(seeded: {
  readonly jobId: string;
  readonly sceneId: string;
  readonly requestId: string;
}): Promise<string> {
  const [reservation, job, scene, request] = await Promise.all([
    prisma.generationReservation.findFirstOrThrow({ where: { generationJobId: seeded.jobId } }),
    prisma.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
    prisma.generationScene.findUniqueOrThrow({ where: { id: seeded.sceneId } }),
    prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: seeded.requestId } }),
  ]);
  return serialize({ reservation, job, scene, request });
}

function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

const BASE = { organizationId: ORG_A, context: ctx() };

describe.skipIf(!HAS_DB)("the streaming transfer core through the Phase 2H-2 runner", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
    await rival.$disconnect();
  });

  describe("the happy path, end to end", () => {
    it("takes PROCESSING through provider success, ingestion, chunked transfer and publish to OUTPUT_VERIFIED", async () => {
      const seeded = await seedAcceptedProcessingAttempt("happy");
      const chunks = [utf8("frame-0000 "), utf8("frame-0001 "), utf8("frame-0002")];
      const before = await lifecycleSnapshot(seeded);
      const { runner, source, sink } = streamingRunner({ script: { chunks, declaredSizeBytes: 32 } });

      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });
      expect(result.kind).toBe("OUTPUT_VERIFIED");

      const row = await attemptRow(seeded.attemptId);
      const expectedKey = managedGenerationOutputKey({
        organizationId: ORG_A,
        attemptId: seeded.attemptId,
      });
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.outputStorageKey).toBe(expectedKey);
      expect(row.outputSha256).toBe(digestOf(...chunks));
      expect(Number(row.outputSizeBytes)).toBe(32);
      expect(row.outputVerifiedAt).not.toBeNull();

      // The published object is exactly the staged bytes, at exactly the
      // application-derived key, with the receipt the row now carries.
      const canonical = sink.canonical.get(expectedKey);
      expect(canonical).toBeDefined();
      expect(digestOf(canonical!.bytes)).toBe(row.outputSha256);
      expect(canonical!.bytes.byteLength).toBe(32);
      expect(sink.canonical.size).toBe(1);
      expect(sink.lastSession.destinationKey).toBe(expectedKey);

      // One pass, one close, no abort.
      expect(source.lastStream.emitted).toBe(chunks.length);
      expect(source.lastStream.closeCalls).toBe(1);
      expect(sink.lastSession.abortCalls).toBe(0);

      const types = await eventTypes(seeded.attemptId);
      expect(types).toContain(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE);
      expect(types).toContain(OUTPUT_INGESTION_STARTED_EVENT_TYPE);
      expect(types).toContain(OUTPUT_VERIFIED_EVENT_TYPE);
      expect(types.indexOf(PROVIDER_COMPLETION_SUCCEEDED_EVENT_TYPE)).toBeLessThan(
        types.indexOf(OUTPUT_INGESTION_STARTED_EVENT_TYPE),
      );
      expect(types.indexOf(OUTPUT_INGESTION_STARTED_EVENT_TYPE)).toBeLessThan(
        types.indexOf(OUTPUT_VERIFIED_EVENT_TYPE),
      );

      // Verifying the attempt's output touched nothing a customer's entitlement
      // rests on: not the reservation, the job, the scene or the request.
      expect(await lifecycleSnapshot(seeded)).toBe(before);
      expect(
        await prisma.sceneGeneration.count({ where: { generationSceneRequestId: seeded.requestId } }),
      ).toBe(1);
    });

    it("derives the key from the organization and attempt — never from the source, the sink or the caller", async () => {
      const seeded = await seedAcceptedProcessingAttempt("keyed");
      const { runner, sink } = streamingRunner({ script: { chunks: [utf8("x")] } });
      await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });

      const key = sink.lastSession.destinationKey;
      expect(key).toBe(`org/${ORG_A}/generations/${seeded.attemptId}/output`);
      expect(key.endsWith(".mp4")).toBe(false);
      expect(key).not.toContain("fal.media");
      expect(key).not.toContain("panda");
      expect((await attemptRow(seeded.attemptId)).outputStorageKey).toBe(key);
    });

    it("puts no part of the locator into PostgreSQL or the sink", async () => {
      const seeded = await seedAcceptedProcessingAttempt("secret");
      const { runner, sink } = streamingRunner({ script: { chunks: [utf8("x")] } });
      await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });

      const row = serialize(await attemptRow(seeded.attemptId));
      const events = serialize(
        await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", seeded.attemptId),
      );
      const store = serialize([...sink.canonical.entries()]) + serialize(sink.sessions);
      for (const haystack of [row, events, store]) {
        for (const fragment of ["SECRETSIGNATURE", "fal.media", "X-Fal-Signature", "panda"]) {
          expect(haystack).not.toContain(fragment);
        }
      }
    });
  });

  describe("expected transfer failures leave the attempt ingesting", () => {
    it.each([
      ["source RETRYABLE_FAILURE", { script: { chunks: [utf8("x")], open: "RETRYABLE" as const } }],
      ["actual oversize", { script: { chunks: [utf8("0123456789")] }, maxBytes: 4 }],
      ["declared oversize", { script: { chunks: [utf8("x")], declaredSizeBytes: 99 }, maxBytes: 4 }],
      ["zero bytes", { script: { chunks: [] } }],
      ["sink commit RETRYABLE_FAILURE", { script: { chunks: [utf8("x")] }, sinkOptions: { commit: "RETRYABLE" as const } }],
    ])("%s → TRANSFER_RETRYABLE_FAILURE, OUTPUT_INGESTING + ACCEPTED, no entitlement change", async (label, options) => {
      const seeded = await seedIngesting(`rf${label.replace(/[^a-z]/gi, "").slice(0, 10)}`);
      const before = await lifecycleSnapshot(seeded);
      const version = (await attemptRow(seeded.attemptId)).stateVersion;
      const { runner, sink } = streamingRunner(options);

      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });
      expect(result.kind).toBe("TRANSFER_RETRYABLE_FAILURE");

      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.stateVersion).toBe(version);
      expect(row.outputStorageKey).toBeNull();
      expect(row.outputSha256).toBeNull();
      expect(sink.canonical.size).toBe(0);
      expect(await eventTypes(seeded.attemptId)).not.toContain(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
      expect(await eventTypes(seeded.attemptId)).not.toContain(OUTPUT_VERIFIED_EVENT_TYPE);
      expect(await lifecycleSnapshot(seeded)).toBe(before);
    });
  });

  describe("thrown transfer failures leave the attempt ingesting", () => {
    it.each([
      ["source open throws", { script: { chunks: [utf8("x")], open: "THROW" as const } }],
      ["iterator throws", { script: { chunks: [utf8("a"), utf8("b")], throwAfterChunks: 1 } }],
      ["sink write throws", { script: { chunks: [utf8("x")] }, sinkOptions: { writeThrowsAt: 0 } }],
      ["sink commit throws", { script: { chunks: [utf8("x")] }, sinkOptions: { commit: "THROW" as const } }],
      ["malformed commit result", { script: { chunks: [utf8("x")] }, sinkOptions: { commit: () => ({ kind: "PUBLISHED", url: "s3://x" }) } }],
    ])("%s → TRANSFER_SOURCE_FAILED, OUTPUT_INGESTING + ACCEPTED", async (label, options) => {
      const seeded = await seedIngesting(`tf${label.replace(/[^a-z]/gi, "").slice(0, 10)}`);
      const before = await lifecycleSnapshot(seeded);
      const { runner, sink } = streamingRunner(options);

      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });
      expect(result.kind).toBe("TRANSFER_SOURCE_FAILED");

      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(sink.canonical.size).toBe(0);
      expect(await eventTypes(seeded.attemptId)).not.toContain(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
      expect(await lifecycleSnapshot(seeded)).toBe(before);
      // The thrown message reached neither the row nor the audit trail.
      const persisted =
        serialize(row) +
        serialize(await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", seeded.attemptId));
      expect(persisted).not.toContain("exploded");
    });
  });

  describe("a hostile EXISTING receipt from the sink", () => {
    const SECRET = "GETTER-SECRET s3://bucket/key?sig=SECRETSIGNATURE";

    it.each([
      ["sha256 getter throws", "sha256", () => ({ get sha256(): never { throw new Error(SECRET); }, sizeBytes: 123 })],
      ["sizeBytes getter throws", "sizeBytes", () => ({ sha256: "a".repeat(64), get sizeBytes(): never { throw new Error(SECRET); } })],
      [
        "receipt is a revoked Proxy",
        "rp",
        // Hostile before any property is read: `typeof` says object and the
        // shared record check's `Array.isArray` throws. A receipt is a
        // *property* of the commit result, so — unlike a whole result — it
        // crosses the adapter's `await` intact and arrives at Phase 2H-1.
        () => {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          return proxy;
        },
      ],
    ])("whose %s → TRANSFER_OUTCOME_MALFORMED, OUTPUT_INGESTING + ACCEPTED, nothing written, nothing escapes", async (_title, label, hostile) => {
      const seeded = await seedIngesting(`hostile${label}`);
      const before = await lifecycleSnapshot(seeded);
      const version = (await attemptRow(seeded.attemptId)).stateVersion;
      // The sink reports EXISTING and hands back a receipt it controls. The
      // core carries it as unknown; Phase 2H-1 is the only authority on it.
      const { runner, sink } = streamingRunner({
        script: { chunks: [utf8("x")] },
        sinkOptions: { commit: () => ({ kind: "EXISTING", receipt: hostile() }) },
      });

      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });
      expect(result.kind).toBe("TRANSFER_OUTCOME_MALFORMED");
      expect(JSON.stringify(result)).not.toContain("GETTER-SECRET");

      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_INGESTING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.stateVersion).toBe(version);
      expect(row.outputSha256).toBeNull();
      expect(row.outputVerifiedAt).toBeNull();
      expect(sink.canonical.size).toBe(0);
      const types = await eventTypes(seeded.attemptId);
      expect(types).not.toContain(OUTPUT_VERIFIED_EVENT_TYPE);
      expect(types).not.toContain(PROVIDER_COMPLETION_FAILED_EVENT_TYPE);
      expect(await lifecycleSnapshot(seeded)).toBe(before);
      const persisted =
        serialize(row) +
        serialize(await repositories(prisma).events.listForAggregate(ORG_A, "ATTEMPT", seeded.attemptId));
      for (const fragment of ["GETTER-SECRET", "SECRETSIGNATURE", "s3://", "revoked", "IsArray"]) {
        expect(persisted).not.toContain(fragment);
      }
    });

    it("whose sha256 getter answers once and then throws → OUTPUT_VERIFIED from the single read, never a second", async () => {
      const seeded = await seedIngesting("stateful");
      let reads = 0;
      const stateful = {
        get sha256(): string {
          reads += 1;
          if (reads > 1) throw new Error("GETTER-SECRET-SECOND-READ");
          return "d".repeat(64);
        },
        sizeBytes: 2_048,
      };
      const { runner } = streamingRunner({
        script: { chunks: [utf8("x")] },
        sinkOptions: { commit: () => ({ kind: "EXISTING", receipt: stateful }) },
      });

      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });
      expect(result.kind).toBe("OUTPUT_VERIFIED");
      // One read, end to end: core → runner → service → decision → parser.
      expect(reads).toBe(1);
      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.outputSha256).toBe("d".repeat(64));
      expect(Number(row.outputSizeBytes)).toBe(2_048);
    });
  });

  describe("crash recovery after canonical publish", () => {
    it("finalizes a resumed attempt against the object a prior run published", async () => {
      const seeded = await seedIngesting("crash");
      const key = managedGenerationOutputKey({ organizationId: ORG_A, attemptId: seeded.attemptId });
      const sink = new FakeManagedOutputStagingSink();

      // Run 1: the core publishes. Then "the process crashes" — the runner's
      // finalization never happens. Simulated by calling the core directly.
      const published = utf8("published-by-a-runner-that-then-died");
      const first = new StreamingManagedOutputTransfer(
        { maxBytes: 1024 },
        { source: new FakeProviderOutputByteSource({ chunks: [published] }), staging: sink },
      );
      const firstOutcome = await first.transferAndVerify({ source: locator(), destinationKey: key });
      expect(firstOutcome.kind).toBe("VERIFIED");
      expect((await attemptRow(seeded.attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
      expect((await attemptRow(seeded.attemptId)).outputSha256).toBeNull();

      // Run 2: a fresh runner resumes the ingesting attempt, re-downloads
      // (different bytes this time), stages, and commits.
      const again = utf8("re-downloaded-later-and-not-the-same");
      const { runner } = streamingRunner({ script: { chunks: [again] }, sink });
      const result = await runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId });

      expect(result.kind).toBe("OUTPUT_VERIFIED");
      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      // Finalized against what is actually at the key: run 1's object.
      expect(row.outputSha256).toBe(digestOf(published));
      expect(Number(row.outputSizeBytes)).toBe(published.byteLength);
      expect(row.outputSha256).not.toBe(digestOf(again));
      expect(sink.sessions).toHaveLength(2);
      expect(sink.sessions[1]!.committed?.kind).toBe("EXISTING");
      expect(sink.canonical.get(key)!.bytes).toEqual(published);
      expect(sink.canonical.size).toBe(1);
      // No provider submission of any kind happened.
      expect(
        await prisma.sceneGeneration.count({ where: { generationSceneRequestId: seeded.requestId } }),
      ).toBe(1);
    });
  });

  describe("concurrent ingesting transfers", () => {
    it("lets two runners transfer, publishes once, and finalizes both against the winner", async () => {
      const seeded = await seedIngesting("race");
      // Both runners are held at their first write until both have arrived
      // there. That pins the interleaving: each has loaded an ingesting
      // context, each has opened its source, and neither can publish — let
      // alone finalize — before the other is mid-transfer. Without the latch
      // the faster connection can finish before the slower one has even read
      // the row, and the slower one answers ALREADY_VERIFIED without ever
      // transferring, which is correct but proves nothing about publication.
      const both = createTransferBarrier();
      let arrived = 0;
      const sink = new FakeManagedOutputStagingSink({
        beforeWrite: async (_session, index) => {
          if (index !== 0) return;
          arrived += 1;
          if (arrived === 2) both.release();
          await both.waitForRelease();
        },
      });
      const bytesA = utf8("AAAA-runner-a");
      const bytesB = utf8("BBBB-runner-b-different");
      const key = managedGenerationOutputKey({ organizationId: ORG_A, attemptId: seeded.attemptId });

      const a = streamingRunner({ script: { chunks: [bytesA] }, sink, client: prisma });
      const b = streamingRunner({ script: { chunks: [bytesB] }, sink, client: rival });
      const results = await Promise.all([
        a.runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId }),
        b.runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId }),
      ]);

      // One object, at the derived key, from whichever committed first.
      expect(sink.canonical.size).toBe(1);
      const canonical = sink.canonical.get(key)!;
      const winnerBytes = [bytesA, bytesB].find((c) => digestOf(c) === digestOf(canonical.bytes));
      expect(winnerBytes).toBeDefined();

      // Both runners reported the *same* receipt — the canonical one — so the
      // row was finalized once and the second finalization was a replay.
      const row = await attemptRow(seeded.attemptId);
      expect(row.orchestrationState).toBe("OUTPUT_VERIFIED");
      expect(row.outputSha256).toBe(digestOf(canonical.bytes));
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["OUTPUT_VERIFICATION_REPLAYED", "OUTPUT_VERIFIED"]);
      const committed = sink.sessions.map((s) => s.committed?.kind).sort();
      expect(committed).toEqual(["EXISTING", "PUBLISHED"]);
    });
  });

  describe("no lock is held while bytes move", () => {
    it("lets an independent writer take the completion locks while the sink is blocked mid-stream", async () => {
      const seeded = await seedIngesting("nolock");
      const g = createTransferBarrier();
      const { runner } = streamingRunner({
        script: { chunks: [utf8("one"), utf8("two"), utf8("three")] },
        sinkOptions: {
          beforeWrite: async (_session, index) => {
            if (index !== 1) return;
            g.signalEntered();
            await g.waitForRelease();
          },
        },
      });

      const blockedRun = settled(
        runner.runProviderOutputAttemptOnce({ ...BASE, attemptId: seeded.attemptId }),
      );
      // Resolves only once the core is inside the second write — one chunk
      // staged, the stream open, the transfer mid-flight.
      await g.entered;
      expect(blockedRun.done()).toBe(false);

      // A competing operation on another connection, taking the same
      // organization-scoped advisory lock and the same row lock Phase 2H-1
      // uses. If the runner held either across the transfer, this would hang
      // until vitest's timeout.
      const rivalWrite = await completion(rival).beginOutputIngestion({
        ...BASE,
        attemptId: seeded.attemptId,
      });
      expect(rivalWrite.kind).toBe("ALREADY_INGESTING");
      expect(blockedRun.done()).toBe(false);

      g.release();
      expect((await blockedRun.value).kind).toBe("OUTPUT_VERIFIED");
      expect((await attemptRow(seeded.attemptId)).orchestrationState).toBe("OUTPUT_VERIFIED");
    });
  });

  describe("tenant isolation", () => {
    it("refuses to transfer another organization's attempt", async () => {
      const seeded = await seedIngesting("tenant");
      const { runner, source, sink } = streamingRunner({ script: { chunks: [utf8("x")] } });
      const result = await runner.runProviderOutputAttemptOnce({
        organizationId: "org_itest_orch_b",
        attemptId: seeded.attemptId,
        context: ctx(),
      });
      expect(result.kind).toBe("ATTEMPT_NOT_FOUND");
      expect(source.openCalls).toHaveLength(0);
      expect(sink.sessions).toHaveLength(0);
      expect((await attemptRow(seeded.attemptId)).orchestrationState).toBe("OUTPUT_INGESTING");
    });
  });
});
