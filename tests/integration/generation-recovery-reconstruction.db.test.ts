import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGenerationJobRepository,
  createGenerationPricingSnapshotRepository,
  createGenerationReservationRepository,
  createGenerationSceneRepository,
  createGenerationTransitionEventRepository,
  createSceneGenerationAttemptRepository,
  createSceneGenerationRequestRepository,
} from "@app/database";
import {
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  providerPricingContractFingerprint,
  reconciliationDeadlineFrom,
  sanitizeTransitionMetadata,
  systemRecoveryAttemptCount,
  usedUserRegenerationCount,
  type ProviderPricingIdentity,
  type TransitionContext,
} from "@app/domain";

/**
 * Crash recovery, from the database and nothing else.
 *
 * The scenario is the worst one this schema exists for: a worker submitted an
 * attempt, lost the response, and then the process died. Everything a recovery
 * worker needs to decide what to do next must be reconstructable from stored
 * rows — because after a crash, that is all there is.
 *
 * Two disciplines make this test meaningful rather than decorative. The fixture
 * is written through a **first** Prisma client and read through a **second**,
 * with the first disconnected in between, so nothing in-process can be
 * satisfying an assertion. And every expectation is a literal, so a
 * reconstruction that silently recomputed a value from today's catalog would
 * fail rather than agree with itself.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_rec";
const PROP = "prp_itest_rec";
const PROJECT = "vpr_itest_rec";
const ASSET = "ast_itest_rec";
const STORYBOARD_SCENE = "sbs_itest_rec_deleted";

const JOB = "genjob_rec";
const RESERVATION = "genres_rec";
const SCENE = "genscene_rec";
const REQUEST_INITIAL = "genreq_rec_initial";
const REQUEST_REGEN = "genreq_rec_regen1";
const ATTEMPT_FAILED = "sgen_rec_primary";
const ATTEMPT_UNKNOWN = "sgen_rec_recovery";
const PRICE_FAILED = "price_rec_primary";
const PRICE_UNKNOWN = "price_rec_recovery";

const H3_MAX_IDENTITY: ProviderPricingIdentity = {
  provider: "fal",
  pricingModelKey: "minimax-h3-max",
  generationMode: "image-to-video",
  nativeTier: "768P",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
};

const SUBMITTED_AT = new Date("2026-09-30T23:40:00.000Z");
const RECONCILIATION_STARTED = new Date("2026-09-30T23:41:00.000Z");
const RECONCILIATION_DEADLINE = reconciliationDeadlineFrom(RECONCILIATION_STARTED);

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actorType: "WORKER",
    actorUserId: null,
    correlationId: "corr_rec_request",
    causationId: null,
    reasonCode: null,
    eventType: "FIXTURE",
    metadata: sanitizeTransitionMetadata({}),
    ...overrides,
  };
}

describe.skipIf(!HAS_DB)("an uncertain in-flight generation survives a crash", () => {
  /** The client that writes the fixture. Disconnected before anything is read. */
  const writer = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
  /** A cold client, standing in for the process that comes up after the crash. */
  const reader = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

  async function wipe(client: PrismaClient): Promise<void> {
    await client.generationTransitionEvent.deleteMany({});
    await client.generationPricingSnapshot.deleteMany({});
    await client.sceneGeneration.deleteMany({ where: { videoProjectId: PROJECT } });
    await client.sceneGenerationRequest.deleteMany({});
    await client.generationScene.deleteMany({});
    await client.generationReservation.deleteMany({});
    await client.generationJob.deleteMany({});
  }

  beforeEach(async () => {
    await wipe(writer);

    await writer.property.upsert({
      where: { id: PROP },
      update: {},
      create: {
        id: PROP,
        organizationId: ORG,
        name: "Recovery fixture",
        propertyType: "HOUSE",
        createdBy: "usr_itest",
      },
    });
    await writer.mediaAsset.upsert({
      where: { id: ASSET },
      update: {},
      create: {
        id: ASSET,
        organizationId: ORG,
        propertyId: PROP,
        storageKey: `org/${ORG}/a/${ASSET}/normalized.jpg`,
        originalFilename: "a.jpg",
        status: "READY",
        createdBy: "usr_itest",
      },
    });
    await writer.videoProject.upsert({
      where: { id: PROJECT },
      update: {},
      create: {
        id: PROJECT,
        organizationId: ORG,
        propertyId: PROP,
        name: "Recovery project",
        durationSeconds: 60,
        aspectRatio: "16:9",
        targetOutputResolution: "1080p",
        createdBy: "usr_itest",
      },
    });

    const jobs = createGenerationJobRepository(writer);
    const reservations = createGenerationReservationRepository(writer);
    const scenes = createGenerationSceneRepository(writer);
    const requests = createSceneGenerationRequestRepository(writer);
    const pricing = createGenerationPricingSnapshotRepository(writer);

    // A high-quality 60-second job, reserved in September and still generating.
    const job = await jobs.create(
      {
        id: JOB,
        videoProjectId: PROJECT,
        requestedByUserId: "usr_customer",
        qualityTier: "HIGH_QUALITY",
        targetOutputResolution: "1080p",
        requestedDurationSeconds: 60,
        requiredVideoUnits: 2,
        requiredHighQualityUnits: 2,
      },
      ctx({ actorType: "USER", actorUserId: "usr_customer" }),
    );
    let jobVersion = job.stateVersion;
    for (const [from, to] of [
      ["CREATED", "RESERVING"],
      ["RESERVING", "RESERVED"],
      ["RESERVED", "GENERATING"],
    ] as const) {
      const moved = await jobs.transition({
        id: JOB,
        expectedState: from,
        expectedVersion: jobVersion,
        nextState: to,
        context: ctx(),
      });
      if (moved.kind !== "APPLIED") throw new Error("fixture transition lost");
      jobVersion = moved.value.stateVersion;
    }

    const reservation = await reservations.create(
      {
        id: RESERVATION,
        generationJobId: JOB,
        // Reserved on 30 September. The deliverable will land in October, and
        // the entitlement stays September's.
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        reservedTotalVideoUnits: 2,
        reservedHighQualityUnits: 2,
      },
      ctx(),
    );
    await reservations.transition({
      id: RESERVATION,
      expectedState: "RESERVING",
      expectedVersion: reservation.stateVersion,
      nextState: "RESERVED",
      context: ctx(),
    });

    const scene = await scenes.create(
      {
        id: SCENE,
        generationJobId: JOB,
        position: 0,
        // Provenance pointing at a storyboard scene that no longer exists,
        // exactly as recomposition would leave it.
        sourceStoryboardSceneId: STORYBOARD_SCENE,
        sourceAssetId: ASSET,
        sourceAnalysisRevision: 3,
        snapshotDurationSeconds: 5,
        snapshotCameraMotion: "SLOW_PAN",
        snapshotCompiledPrompt: "a sunlit living room, cinematic",
      },
      ctx(),
    );
    await scenes.transition({
      id: SCENE,
      expectedState: "PENDING",
      expectedVersion: scene.stateVersion,
      nextState: "GENERATING",
      context: ctx(),
    });

    // The initial request was delivered; the customer then asked for a
    // regeneration, which is what is in flight.
    const initial = await requests.create(
      {
        id: REQUEST_INITIAL,
        generationSceneId: SCENE,
        kind: "INITIAL",
        userRegenerationOrdinal: null,
        requestedByUserId: "usr_customer",
      },
      ctx(),
    );
    const initialGenerating = await requests.transition({
      id: REQUEST_INITIAL,
      expectedState: "PENDING",
      expectedVersion: initial.stateVersion,
      nextState: "GENERATING",
      context: ctx(),
    });
    if (initialGenerating.kind !== "APPLIED") throw new Error("fixture transition lost");
    await requests.transition({
      id: REQUEST_INITIAL,
      expectedState: "GENERATING",
      expectedVersion: initialGenerating.value.stateVersion,
      nextState: "DELIVERED",
      context: ctx(),
    });

    const regen = await requests.create(
      {
        id: REQUEST_REGEN,
        generationSceneId: SCENE,
        kind: "USER_REGENERATION",
        userRegenerationOrdinal: 1,
        requestedByUserId: "usr_customer",
      },
      ctx({ actorType: "USER", actorUserId: "usr_customer" }),
    );
    await requests.transition({
      id: REQUEST_REGEN,
      expectedState: "PENDING",
      expectedVersion: regen.stateVersion,
      nextState: "GENERATING",
      context: ctx(),
    });

    const snapshot = () => {
      const contract = createProviderPricingCatalog().findByIdentity(H3_MAX_IDENTITY);
      if (contract === undefined) throw new Error("expected the H3 Max contract");
      const taken = createPricingSnapshot({
        contract,
        riskProfileKey: "HIGH_QUALITY_AI",
        requestedSeconds: 5,
        pricingEffectiveAt: epochMillisFromDate(SUBMITTED_AT),
      });
      if (!taken.ok) throw new Error("expected a pricing snapshot");
      return taken.value;
    };

    // Attempt 1: PRIMARY, failed retryably.
    await writer.sceneGeneration.create({
      data: {
        id: ATTEMPT_FAILED,
        videoProjectId: PROJECT,
        sourceStoryboardSceneId: STORYBOARD_SCENE,
        assetId: ASSET,
        sourceAnalysisRevision: 3,
        requestHash: `${"c".repeat(63)}1`,
        providerName: "wavespeed",
        providerModelId: "wavespeed-ai/open-video/image-to-video",
        generationSceneRequestId: REQUEST_REGEN,
        attemptOrdinal: 1,
        attemptKind: "PRIMARY",
        submissionCertainty: "PRE_SUBMISSION",
        orchestrationState: "FAILED_RETRYABLE",
        stateVersion: 2,
        submissionBoundaryEnteredAt: SUBMITTED_AT,
        normalizedErrorCode: "PROVIDER_UNAVAILABLE",
      },
    });
    await pricing.create({
      id: PRICE_FAILED,
      sceneGenerationId: ATTEMPT_FAILED,
      snapshot: snapshot(),
    });

    // Attempt 2: SYSTEM_RECOVERY, submitted, response lost, process died.
    await writer.sceneGeneration.create({
      data: {
        id: ATTEMPT_UNKNOWN,
        videoProjectId: PROJECT,
        sourceStoryboardSceneId: STORYBOARD_SCENE,
        assetId: ASSET,
        sourceAnalysisRevision: 3,
        requestHash: `${"c".repeat(63)}2`,
        providerName: "wavespeed",
        providerModelId: "wavespeed-ai/open-video/image-to-video",
        generationSceneRequestId: REQUEST_REGEN,
        attemptOrdinal: 2,
        attemptKind: "SYSTEM_RECOVERY",
        submissionCertainty: "SUBMISSION_UNKNOWN",
        orchestrationState: "RECONCILIATION_PENDING",
        stateVersion: 2,
        submissionBoundaryEnteredAt: SUBMITTED_AT,
        reconciliationStartedAt: RECONCILIATION_STARTED,
        reconciliationDeadlineAt: RECONCILIATION_DEADLINE,
        normalizedErrorCode: "PROVIDER_SUBMISSION_TIMEOUT",
      },
    });
    await pricing.create({
      id: PRICE_UNKNOWN,
      sceneGenerationId: ATTEMPT_UNKNOWN,
      snapshot: snapshot(),
    });

    // The crash. Nothing in this process may serve a later read.
    await writer.$disconnect();
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await reader.$connect();
    await wipe(reader);
    await reader.videoProject.deleteMany({ where: { id: PROJECT } });
    await reader.mediaAsset.deleteMany({ where: { id: ASSET } });
    await reader.property.deleteMany({ where: { id: PROP } });
    await reader.$disconnect();
  });

  it("answers every recovery question from stored rows alone", async () => {
    const jobs = createGenerationJobRepository(reader);
    const reservations = createGenerationReservationRepository(reader);
    const scenes = createGenerationSceneRepository(reader);
    const requests = createSceneGenerationRequestRepository(reader);
    const attempts = createSceneGenerationAttemptRepository(reader);
    const pricing = createGenerationPricingSnapshotRepository(reader);
    const events = createGenerationTransitionEventRepository(reader);

    // Which job?
    const job = await jobs.findById(JOB);
    expect(job).not.toBeNull();
    expect(job?.state).toBe("GENERATING");
    expect(job?.qualityTier).toBe("HIGH_QUALITY");
    expect(job?.requestedDurationSeconds).toBe(60);

    // Which customer billing cycle, and how many units are held?
    const reservation = await reservations.findByJobId(JOB);
    expect(reservation?.billingCycleKey).toBe("2026-09");
    expect(reservation?.state).toBe("RESERVED");
    expect(reservation?.reservedTotalVideoUnits).toBe(2);
    expect(reservation?.reservedHighQualityUnits).toBe(2);

    // Which logical scene? Its provenance survives the storyboard scene it
    // names having been deleted by recomposition.
    const scene = await scenes.findById(SCENE);
    expect(scene?.state).toBe("GENERATING");
    expect(scene?.sourceStoryboardSceneId).toBe(STORYBOARD_SCENE);
    expect(
      await reader.storyboardScene.findUnique({ where: { id: STORYBOARD_SCENE } }),
    ).toBeNull();

    // Which logical request, and what has the customer actually spent?
    const sceneRequests = await requests.listBySceneId(SCENE);
    expect(sceneRequests.map((r) => [r.kind, r.state, r.userRegenerationOrdinal])).toEqual([
      ["INITIAL", "DELIVERED", null],
      ["USER_REGENERATION", "GENERATING", 1],
    ]);
    // One right spent, on the delivered initial? No — the initial never counts,
    // and the in-flight regeneration has not been delivered.
    expect(usedUserRegenerationCount(sceneRequests)).toBe(0);

    // Which provider attempts, and which were the platform's own retries?
    const requestAttempts = await attempts.listByRequestId(REQUEST_REGEN);
    expect(requestAttempts.map((a) => [a.attemptOrdinal, a.attemptKind])).toEqual([
      [1, "PRIMARY"],
      [2, "SYSTEM_RECOVERY"],
    ]);
    expect(systemRecoveryAttemptCount(requestAttempts)).toBe(1);

    const uncertain = requestAttempts[1]!;

    // Which provider and model?
    expect(uncertain.providerName).toBe("wavespeed");
    expect(uncertain.providerModelId).toBe("wavespeed-ai/open-video/image-to-video");

    // Which immutable request?
    expect(uncertain.requestHash).toBe(`${"c".repeat(63)}2`);

    // Was the submission boundary crossed?
    expect(uncertain.submissionBoundaryEnteredAt?.toISOString()).toBe(
      SUBMITTED_AT.toISOString(),
    );

    // What is submission certainty, and do we know a provider reference?
    expect(uncertain.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
    expect(uncertain.providerPredictionId).toBeNull();

    // Is reconciliation required, and by when?
    expect(uncertain.orchestrationState).toBe("RECONCILIATION_PENDING");
    expect(uncertain.reconciliationStartedAt?.toISOString()).toBe(
      RECONCILIATION_STARTED.toISOString(),
    );
    expect(uncertain.reconciliationDeadlineAt?.toISOString()).toBe(
      "2026-10-01T23:41:00.000Z",
    );
    expect(uncertain.reconciliationResolvedAt).toBeNull();

    // Which pricing contract, and what did we expect it to cost?
    const price = await pricing.findByAttemptId(ATTEMPT_UNKNOWN);
    const contract = createProviderPricingCatalog().findByIdentity(H3_MAX_IDENTITY);
    expect(price?.contractFingerprint).toBe(
      providerPricingContractFingerprint(contract!),
    );
    // 5 billable seconds at 80,000 micro-USD, plus the 50% high-quality buffer.
    expect(price?.estimatedStableCostMicroUsd).toBe(400_000n);
    expect(price?.estimatedPlanningCostMicroUsd).toBe(600_000n);
    expect(price?.riskProfileKey).toBe("HIGH_QUALITY_AI");

    // What transition happened last?
    const history = await events.listForAggregate("SCENE_REQUEST", REQUEST_REGEN);
    const last = history[history.length - 1]!;
    expect(last.sequence).toBe(history.length);
    expect(last.toState).toBe("GENERATING");
    expect(history.map((e) => e.sequence)).toEqual(
      Array.from({ length: history.length }, (_, i) => i + 1),
    );
  });

  it("exposes no prompt anywhere in the reconstructed transition history", async () => {
    const events = createGenerationTransitionEventRepository(reader);
    const everything = await events.listForCorrelation("corr_rec_request");
    expect(everything.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(everything);
    expect(dumped).not.toContain("sunlit");
    expect(dumped).not.toContain("cinematic");
  });

  it("cannot be resumed by re-POSTing the uncertain attempt", async () => {
    // The single most dangerous recovery action, refused by the state machine
    // rather than by a worker remembering not to do it.
    const attempts = createSceneGenerationAttemptRepository(reader);
    const armed = await attempts.armProviderBoundary({
      id: ATTEMPT_UNKNOWN,
      expectedVersion: 2,
      context: ctx({ actorType: "RECONCILIATION_WORKER" }),
    });
    expect(armed.kind).toBe("LOST");

    const row = await reader.sceneGeneration.findUnique({ where: { id: ATTEMPT_UNKNOWN } });
    expect(row?.orchestrationState).toBe("RECONCILIATION_PENDING");
    expect(row?.stateVersion).toBe(2);
  });
});
