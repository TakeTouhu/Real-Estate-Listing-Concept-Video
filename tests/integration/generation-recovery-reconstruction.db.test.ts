import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProviderPricingCatalog,
  providerPricingContractFingerprint,
  reconciliationDeadlineFrom,
  systemRecoveryAttemptCount,
  usedUserRegenerationCount,
} from "@app/domain";
import {
  ASSET_A,
  attemptInput,
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
 * Crash recovery, from the database and nothing else.
 *
 * The scenario is the worst one this schema exists for: a worker submitted an
 * attempt, lost the response, and then the process died. Everything a recovery
 * worker needs must be reconstructable from stored rows — because after a
 * crash, that is all there is.
 *
 * Two disciplines make this meaningful rather than decorative. The fixture is
 * written through a **first** Prisma client and read through a **second**, with
 * the first disconnected in between, so nothing in-process can be satisfying an
 * assertion. And every expectation is a literal, so a reconstruction that
 * silently recomputed a value from today's catalog would fail rather than agree
 * with itself.
 *
 * Both attempts deliberately share **one request hash**. The provider request
 * facts really are identical — the recovery is another try at the same work —
 * and giving them different hashes would have quietly sidestepped the
 * active-request index rather than exercising it.
 */
const JOB = "genjob_rec";
const RESERVATION = "genres_rec";
const SCENE = "genscene_rec";
const REQUEST_INITIAL = "genreq_rec_initial";
const REQUEST_REGEN = "genreq_rec_regen1";
const ATTEMPT_FAILED = "sgen_rec_primary";
const ATTEMPT_UNKNOWN = "sgen_rec_recovery";

/** One identity, shared by the primary attempt and its recovery. */
const SHARED_REQUEST_HASH = `sha256:v2:${"f".repeat(63)}9`;

const SUBMITTED_AT = new Date("2026-09-30T23:40:00.000Z");
const RECONCILIATION_STARTED = new Date("2026-09-30T23:41:00.000Z");
const RECONCILIATION_DEADLINE = reconciliationDeadlineFrom(RECONCILIATION_STARTED);

describe.skipIf(!HAS_DB)("an uncertain in-flight generation survives a crash", () => {
  /** The client that writes the fixture. Disconnected before anything is read. */
  const writer = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
  /** A cold client, standing in for the process that comes up after the crash. */
  const reader = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

  beforeEach(async () => {
    await wipeOrchestration(writer);
    await seedTenants(writer);

    const repos = repositories(writer);

    // A high-quality 60-second job, reserved in September and still generating.
    const created = await repos.jobs.create(
      ORG_A,
      {
        id: JOB,
        videoProjectId: PROJECT_A,
        requestedByUserId: "usr_customer",
        qualityTier: "HIGH_QUALITY",
        targetOutputResolution: "1080p",
        requestedDurationSeconds: 60,
      },
      ctx({ actorType: "USER", actorUserId: "usr_customer", correlationId: "corr_rec_request" }),
    );
    if (created.kind !== "CREATED") throw new Error("fixture job not created");

    const reserving = await repos.jobs.transition({
      organizationId: ORG_A,
      id: JOB,
      expectedState: "CREATED",
      expectedVersion: created.job.stateVersion,
      nextState: "RESERVING",
      context: ctx({ correlationId: "corr_rec_request" }),
    });
    if (reserving.kind !== "APPLIED") throw new Error("fixture transition lost");

    // Reserved on 30 September. The deliverable will land in October, and the
    // entitlement stays September's.
    const reserved = await repos.reservations.reserve(
      ORG_A,
      {
        reservationId: RESERVATION,
        generationJobId: JOB,
        expectedJobVersion: reserving.value.stateVersion,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      ctx({ correlationId: "corr_rec_request" }),
    );
    if (reserved.kind !== "RESERVED") throw new Error("fixture reservation failed");

    await repos.jobs.transition({
      organizationId: ORG_A,
      id: JOB,
      expectedState: "RESERVED",
      expectedVersion: reserved.job.stateVersion,
      nextState: "GENERATING",
      context: ctx({ correlationId: "corr_rec_request" }),
    });

    const scene = await repos.scenes.create(
      ORG_A,
      {
        id: SCENE,
        generationJobId: JOB,
        position: 0,
        // Provenance pointing at a storyboard scene that no longer exists,
        // exactly as recomposition would leave it.
        sourceStoryboardSceneId: STORYBOARD_SCENE,
        sourceAssetId: ASSET_A,
        sourceAnalysisRevision: 3,
        snapshotDurationSeconds: 5,
        snapshotCameraMotion: "SLOW_PAN",
        snapshotCompiledPrompt: "a sunlit living room, cinematic",
      },
      ctx({ correlationId: "corr_rec_request" }),
    );
    if (scene === null) throw new Error("fixture scene not created");
    await repos.scenes.transition({
      organizationId: ORG_A,
      id: SCENE,
      expectedState: "PENDING",
      expectedVersion: scene.stateVersion,
      nextState: "GENERATING",
      context: ctx({ correlationId: "corr_rec_request" }),
    });

    // The initial request was delivered; the customer then asked for a
    // regeneration, which is what is in flight.
    const initial = await repos.requests.createInitial(
      ORG_A,
      { id: REQUEST_INITIAL, generationSceneId: SCENE, requestedByUserId: "usr_customer" },
      ctx({ correlationId: "corr_rec_request" }),
    );
    if (initial === null) throw new Error("fixture initial request not created");
    const initialGenerating = await repos.requests.transition({
      organizationId: ORG_A,
      id: REQUEST_INITIAL,
      expectedState: "PENDING",
      expectedVersion: initial.stateVersion,
      nextState: "GENERATING",
      context: ctx({ correlationId: "corr_rec_request" }),
    });
    if (initialGenerating.kind !== "APPLIED") throw new Error("fixture transition lost");
    await repos.requests.transition({
      organizationId: ORG_A,
      id: REQUEST_INITIAL,
      expectedState: "GENERATING",
      expectedVersion: initialGenerating.value.stateVersion,
      nextState: "DELIVERED",
      context: ctx({ correlationId: "corr_rec_request" }),
    });

    const regen = await repos.requests.admitUserRegeneration(
      ORG_A,
      { id: REQUEST_REGEN, generationSceneId: SCENE, requestedByUserId: "usr_customer" },
      ctx({ actorType: "USER", actorUserId: "usr_customer", correlationId: "corr_rec_request" }),
    );
    if (regen.kind !== "ADMITTED") throw new Error(`fixture regeneration failed: ${regen.kind}`);
    await repos.requests.transition({
      organizationId: ORG_A,
      id: REQUEST_REGEN,
      expectedState: "PENDING",
      expectedVersion: regen.request.stateVersion,
      nextState: "GENERATING",
      context: ctx({ correlationId: "corr_rec_request" }),
    });

    // Attempt 1: PRIMARY, admitted through the real primitive, then definitively
    // rejected. Its terminal state releases the request identity, which is what
    // lets the recovery below reuse the same hash.
    const primary = await repos.attempts.admit(
      ORG_A,
      attemptInput({
        id: ATTEMPT_FAILED,
        generationSceneRequestId: REQUEST_REGEN,
        requestHash: SHARED_REQUEST_HASH,
        sourceAnalysisRevision: 3,
        pricingSnapshotId: "price_rec_primary",
      }),
      ctx({ correlationId: "corr_rec_request" }),
    );
    if (primary.kind !== "ADMITTED") throw new Error(`fixture attempt failed: ${primary.kind}`);
    const armedPrimary = await repos.attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: ATTEMPT_FAILED,
      expectedVersion: primary.attempt.stateVersion,
      context: ctx({ correlationId: "corr_rec_request" }),
    });
    if (armedPrimary.kind !== "ARMED") throw new Error("fixture arm failed");
    await repos.attempts.recordSubmissionOutcome({
      organizationId: ORG_A,
      id: ATTEMPT_FAILED,
      expectedVersion: armedPrimary.attempt.stateVersion,
      outcome: {
        certainty: "DEFINITIVELY_REJECTED",
        state: "FAILED_TERMINAL",
        providerPredictionId: null,
      },
      normalizedErrorCode: "PROVIDER_UNAVAILABLE",
      context: ctx({ correlationId: "corr_rec_request" }),
    });

    // Attempt 2: SYSTEM_RECOVERY, same request hash, submitted, response lost,
    // process died.
    const recovery = await repos.attempts.admit(
      ORG_A,
      attemptInput({
        id: ATTEMPT_UNKNOWN,
        generationSceneRequestId: REQUEST_REGEN,
        attemptKind: "SYSTEM_RECOVERY",
        requestHash: SHARED_REQUEST_HASH,
        sourceAnalysisRevision: 3,
        pricingSnapshotId: "price_rec_recovery",
      }),
      ctx({ correlationId: "corr_rec_request" }),
    );
    if (recovery.kind !== "ADMITTED") throw new Error(`fixture recovery failed: ${recovery.kind}`);
    const armedRecovery = await repos.attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: ATTEMPT_UNKNOWN,
      expectedVersion: recovery.attempt.stateVersion,
      context: ctx({ correlationId: "corr_rec_request" }),
    });
    if (armedRecovery.kind !== "ARMED") throw new Error("fixture recovery arm failed");
    await repos.attempts.recordSubmissionOutcome({
      organizationId: ORG_A,
      id: ATTEMPT_UNKNOWN,
      expectedVersion: armedRecovery.attempt.stateVersion,
      outcome: {
        certainty: "SUBMISSION_UNKNOWN",
        state: "RECONCILIATION_PENDING",
        providerPredictionId: null,
        reconciliationStartedAt: RECONCILIATION_STARTED,
        reconciliationDeadlineAt: RECONCILIATION_DEADLINE,
      },
      normalizedErrorCode: "PROVIDER_SUBMISSION_TIMEOUT",
      context: ctx({ correlationId: "corr_rec_request" }),
    });
    // Backdate the boundary crossing so the reconstructed instants are literals
    // rather than whatever the test clock happened to say.
    await writer.sceneGeneration.updateMany({
      where: { id: { in: [ATTEMPT_FAILED, ATTEMPT_UNKNOWN] } },
      data: { submissionBoundaryEnteredAt: SUBMITTED_AT },
    });

    // The crash. Nothing in this process may serve a later read.
    await writer.$disconnect();
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await reader.$connect();
    await wipeOrchestration(reader);
    await dropTenants(reader);
    await reader.$disconnect();
  });

  it("answers every recovery question from stored rows alone", async () => {
    const repos = repositories(reader);

    // Which job?
    const job = await repos.jobs.findById(ORG_A, JOB);
    expect(job?.state).toBe("GENERATING");
    expect(job?.qualityTier).toBe("HIGH_QUALITY");
    expect(job?.requestedDurationSeconds).toBe(60);
    expect(job?.requiredVideoUnits).toBe(2);

    // Which customer billing cycle, and how many units are held?
    const reservation = await repos.reservations.findByJobId(ORG_A, JOB);
    expect(reservation?.billingCycleKey).toBe("2026-09");
    expect(reservation?.state).toBe("RESERVED");
    expect(reservation?.reservedTotalVideoUnits).toBe(2);
    expect(reservation?.reservedHighQualityUnits).toBe(2);

    // Which logical scene? Its provenance survives the storyboard scene it
    // names having been deleted by recomposition.
    const scene = await repos.scenes.findById(ORG_A, SCENE);
    expect(scene?.state).toBe("GENERATING");
    expect(scene?.sourceStoryboardSceneId).toBe(STORYBOARD_SCENE);
    expect(
      await reader.storyboardScene.findUnique({ where: { id: STORYBOARD_SCENE } }),
    ).toBeNull();

    // Which logical request, and what has the customer actually spent?
    const sceneRequests = await repos.requests.listBySceneId(ORG_A, SCENE);
    expect(sceneRequests.map((r) => [r.kind, r.state, r.userRegenerationOrdinal])).toEqual([
      ["INITIAL", "DELIVERED", null],
      ["USER_REGENERATION", "GENERATING", 1],
    ]);
    // The initial never counts, and the in-flight regeneration is not delivered.
    expect(usedUserRegenerationCount(sceneRequests)).toBe(0);

    // Which provider attempts, and which were the platform's own retries?
    const attempts = await repos.attempts.listByRequestId(ORG_A, REQUEST_REGEN);
    expect(attempts.map((a) => [a.attemptOrdinal, a.attemptKind])).toEqual([
      [1, "PRIMARY"],
      [2, "SYSTEM_RECOVERY"],
    ]);
    expect(systemRecoveryAttemptCount(attempts)).toBe(1);
    // Both attempts share one request identity: same work, second try.
    expect(attempts.map((a) => a.requestHash)).toEqual([
      SHARED_REQUEST_HASH,
      SHARED_REQUEST_HASH,
    ]);

    const uncertain = attempts[1]!;

    // Which provider and model?
    expect(uncertain.providerName).toBe("wavespeed");
    expect(uncertain.providerModelId).toBe("wavespeed-ai/open-video/image-to-video");

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
    expect(uncertain.reconciliationDeadlineAt?.toISOString()).toBe("2026-10-01T23:41:00.000Z");
    expect(uncertain.reconciliationResolvedAt).toBeNull();

    // Which pricing contract, and what did we expect it to cost?
    const price = await repos.pricing.findByAttemptId(ORG_A, ATTEMPT_UNKNOWN);
    const contract = createProviderPricingCatalog().findByIdentity(OPEN_VIDEO_IDENTITY);
    expect(price?.contractFingerprint).toBe(providerPricingContractFingerprint(contract!));
    // The attempt's own binding agrees with the price filed against it.
    expect(uncertain.pricingContractKey).toBe(price?.contractKey);
    // 5 billable seconds at 60,000 micro-USD, plus the 30% normal buffer.
    expect(price?.estimatedStableCostMicroUsd).toBe(300_000n);
    expect(price?.estimatedPlanningCostMicroUsd).toBe(390_000n);

    // What transition happened last?
    const history = await repos.events.listForAggregate(ORG_A, "SCENE_REQUEST", REQUEST_REGEN);
    const last = history[history.length - 1]!;
    expect(last.sequence).toBe(history.length);
    expect(last.toState).toBe("GENERATING");
    expect(history.map((e) => e.sequence)).toEqual(
      Array.from({ length: history.length }, (_, i) => i + 1),
    );
    expect(history.every((e) => e.organizationId === ORG_A)).toBe(true);
  });

  it("exposes no prompt anywhere in the reconstructed transition history", async () => {
    const repos = repositories(reader);
    const everything = await repos.events.listForCorrelation(ORG_A, "corr_rec_request");
    expect(everything.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(everything);
    expect(dumped).not.toContain("sunlit");
    expect(dumped).not.toContain("cinematic");
  });

  it("cannot be resumed by re-POSTing the uncertain attempt", async () => {
    // The single most dangerous recovery action, refused by the state machine
    // rather than by a worker remembering not to do it.
    const repos = repositories(reader);
    const attempt = await repos.attempts.findById(ORG_A, ATTEMPT_UNKNOWN);
    const armed = await repos.attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: ATTEMPT_UNKNOWN,
      expectedVersion: attempt!.stateVersion,
      context: ctx({ actorType: "RECONCILIATION_WORKER" }),
    });
    expect(armed.kind).toBe("LOST");

    const row = await reader.sceneGeneration.findUnique({ where: { id: ATTEMPT_UNKNOWN } });
    expect(row?.orchestrationState).toBe("RECONCILIATION_PENDING");
  });

  it("permits a further recovery attempt on the same request identity", async () => {
    // The uncertain attempt holds the identity, so a third attempt must wait
    // for it to resolve. Once it does, the identity is released and the same
    // hash may be admitted again.
    const repos = repositories(reader);
    await reader.sceneGeneration.update({
      where: { id: ATTEMPT_UNKNOWN },
      data: { orchestrationState: "RECONCILIATION_EXHAUSTED", reconciliationResolvedAt: new Date() },
    });
    const third = await repos.attempts.admit(
      ORG_A,
      attemptInput({
        id: "sgen_rec_third",
        generationSceneRequestId: REQUEST_REGEN,
        attemptKind: "SYSTEM_RECOVERY",
        requestHash: SHARED_REQUEST_HASH,
        sourceAnalysisRevision: 3,
        pricingSnapshotId: "price_rec_third",
      }),
      ctx(),
    );
    if (third.kind !== "ADMITTED") throw new Error(`expected ADMITTED, got ${third.kind}`);
    expect(third.attempt.attemptOrdinal).toBe(3);
  });
});
