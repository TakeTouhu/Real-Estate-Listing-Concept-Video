import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFixedSubmissionClock,
  createPricingSnapshot,
  createProviderPricingCatalog,
  createReconciliationMaintenance,
  createReconciliationService,
  createSubmissionOutcomeService,
  epochMillis,
  epochMillisFromDate,
  MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE,
  parseSubmissionDiagnosticCode,
  validateReconciliationPolicy,
  RECONCILIATION_EXHAUSTED_EVENT_TYPE,
  RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
  RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
  RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
  RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE,
  type EpochMillis,
  type FxSnapshot,
  type PricingSnapshot,
  type ReconciliationPolicy,
  type ReconciliationPolicyConfig,
  type ReconciliationResolutionObservation,
  type SubmissionClock,
  type SubmissionDiagnosticCode,
} from "@app/domain";
import {
  createPaidSubmissionAuthorizationRepository,
  createReconciliationRepository,
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
  PROJECT_B,
  repositories,
  seedTenants,
  STORYBOARD_SCENE,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Ending an attempt's uncertainty, against live PostgreSQL.
 *
 * Every row this suite acts on was made uncertain by Phase 4C-3B-2G-1's own
 * service rather than by hand, so what is exercised here is the record that
 * phase actually produces.
 *
 * **No provider is constructed and nothing is asked of one.** The evidence is
 * an argument. What the database is needed for is the part a fake repository
 * cannot prove: that one transaction moves the attempt, the customer's hold and
 * both audit records together, that a conclusion and a deadline cannot both
 * claim the same row, and that a resolver which waits behind a lock judges the
 * deadline on the clock it reads *after* it gets in.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, so a lock held on one connection genuinely blocks the other. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third, used only to hold a lock while the other two contend for it. */
const blocker = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

function validatedPolicy(config: ReconciliationPolicyConfig): ReconciliationPolicy {
  const result = validateReconciliationPolicy(config);
  if (!result.ok) throw new Error(`invalid test policy: ${result.reason}`);
  return result.policy;
}

const BOUNDARY = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));
const POLICY: ReconciliationPolicy = validatedPolicy({
  reconciliationWindowMs: 24 * 60 * 60 * 1000,
  staleSubmittingAfterMs: 15 * 60 * 1000,
});
const DEADLINE = epochMillis(BOUNDARY + POLICY.reconciliationWindowMs);
const INSIDE = epochMillis(DEADLINE - 60_000);
const AFTER = epochMillis(DEADLINE + 60_000);

const CYCLE = "2026-09";

function code(value: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(value);
  if (!parsed.ok || parsed.code === null) throw new Error(`not a safe code: ${value}`);
  return parsed.code;
}

const FX: FxSnapshot = {
  id: "fx_reconcile",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

const ACCEPTED: ReconciliationResolutionObservation = {
  kind: "ACCEPTED",
  providerPredictionId: "pred_reconciled",
};
const REJECTED_RETRYABLE: ReconciliationResolutionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: true,
  diagnosticCode: code("CONNECTION_RESET"),
};
const REJECTED_TERMINAL: ReconciliationResolutionObservation = {
  kind: "DEFINITIVELY_REJECTED",
  retryable: false,
  diagnosticCode: null,
};

function reconciliation(
  client: PrismaClient = prisma,
  clock: SubmissionClock = createFixedSubmissionClock(INSIDE),
) {
  return createReconciliationService({
    reconciliation: createReconciliationRepository(client),
    clock,
  });
}

function outcomes(client: PrismaClient = prisma, at: EpochMillis = BOUNDARY) {
  return createSubmissionOutcomeService({
    outcomes: createSubmissionOutcomeRepository(client),
    clock: createFixedSubmissionClock(at),
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
 * A chain whose attempt is already sitting in durable uncertainty.
 *
 * Driven through Phase 2G-1's service rather than written directly, so the
 * three timestamps, the suspended hold and the `normalizedErrorCode` are
 * exactly what that phase writes — including the ones this phase must not touch.
 */
async function seedReconcilingAttempt(
  suffix: string,
  options: {
    readonly organizationId?: string;
    readonly videoProjectId?: string;
    readonly requestKind?: "INITIAL" | "USER_REGENERATION";
    /** Skip the uncertainty entry, leaving the attempt at `SUBMITTING`. */
    readonly stopAtBoundary?: boolean;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const videoProjectId = options.videoProjectId ?? PROJECT_A;
  const repos = repositories(prisma);

  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_${suffix}`,
      videoProjectId,
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

  if (options.requestKind === "USER_REGENERATION") {
    // Reached by rewriting the seeded row rather than driving the regeneration
    // admission path, which needs a delivered video this suite has no interest
    // in producing. The unit is spent, as it is after a real delivery.
    await prisma.sceneGenerationRequest.update({
      where: { id: request.id },
      data: { kind: "USER_REGENERATION", userRegenerationOrdinal: 1 },
    });
    await prisma.generationReservation.updateMany({
      where: { generationJobId: created.job.id },
      data: { state: "CONSUMED", stateVersion: { increment: 1 } },
    });
  }

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
    const entered = await outcomes().recordObservation({
      organizationId,
      attemptId: admitted.attempt.id,
      observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: code("TIMEOUT") },
      context: ctx(),
    });
    if (entered.kind !== "APPLIED") throw new Error(`uncertainty: ${entered.kind}`);
  }

  return { job: created.job, scene, request, attemptId: admitted.attempt.id, organizationId };
}

/**
 * Add a second scene, request and uncertain attempt to an existing Job.
 *
 * The whole point of the multi-scene fixture: both attempts hang off the *same*
 * `GenerationJob`, so they share one `GenerationReservation` and one suspended
 * hold. This is the shape in which restoring on the first conclusion would lift
 * a Job-level suspension the Job has not earned.
 */
async function seedSiblingUncertainAttempt(
  suffix: string,
  job: { readonly id: string },
  organizationId: string = ORG_A,
) {
  const repos = repositories(prisma);
  const scene = await repos.scenes.create(
    organizationId,
    {
      id: `genscene_${suffix}`,
      generationJobId: job.id,
      position: 1,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: ASSET_A,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: `a second room, cinematic (${suffix})`,
    },
    ctx(),
  );
  if (scene === null) throw new Error("sibling scene not created");

  const request = await repos.requests.createInitial(
    organizationId,
    { id: `genreq_${suffix}`, generationSceneId: scene.id, requestedByUserId: "usr_itest" },
    ctx(),
  );
  if (request === null) throw new Error("sibling request not created");

  const admitted = await repos.attempts.admit(
    organizationId,
    {
      id: `sgen_${suffix}`,
      generationSceneRequestId: request.id,
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestRenderedPrompt: `a second room, cinematic, slow pan (${suffix})`,
      requestNativeGenerationResolution: "1080p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
      pricingSnapshotId: `price_sgen_${suffix}`,
      pricingSnapshot: snapshotFor(5),
      fxSnapshot: FX,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`sibling attempt: ${admitted.kind}`);

  const armed = await repos.attempts.armProviderBoundary({
    organizationId,
    id: admitted.attempt.id,
    expectedVersion: admitted.attempt.stateVersion,
    context: ctx(),
  });
  if (armed.kind !== "ARMED") throw new Error(`sibling arm: ${armed.kind}`);
  await prisma.sceneGeneration.update({
    where: { id: admitted.attempt.id },
    data: { submissionBoundaryEnteredAt: new Date(BOUNDARY) },
  });

  const entered = await outcomes().recordObservation({
    organizationId,
    attemptId: admitted.attempt.id,
    observation: { kind: "SUBMISSION_UNKNOWN", normalizedErrorCode: code("TIMEOUT") },
    context: ctx(),
  });
  if (entered.kind !== "APPLIED") throw new Error(`sibling uncertainty: ${entered.kind}`);

  return { scene, request, attemptId: admitted.attempt.id };
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

async function reservationEvents(reservationId: string, organizationId = ORG_A) {
  return repositories(prisma).events.listForAggregate(
    organizationId,
    "RESERVATION",
    reservationId,
  );
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

const RESOLVE = { organizationId: ORG_A, context: ctx() };

describe.skipIf(!HAS_DB)("reconciliation resolution and deadline exhaustion", () => {
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
    await blocker.$disconnect();
  });

  describe("the three durable conclusions", () => {
    it("records a recovered acceptance and restores the suspended hold", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("acc");
      const before = await attemptRow(attemptId);
      expect(before.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");

      const result = await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      expect(result).toMatchObject({ kind: "APPLIED", attemptId, entitlementAnomaly: "NONE" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("PROCESSING");
      expect(row.submissionCertainty).toBe("ACCEPTED");
      expect(row.providerPredictionId).toBe("pred_reconciled");
      expect(row.providerAcceptedAt?.getTime()).toBe(INSIDE);
      expect(row.reconciliationResolvedAt?.getTime()).toBe(INSIDE);
      // The unit is live again, because the work turned out to be running.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("records a retryable rejection and restores the unit for a later attempt", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("rejr");
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: REJECTED_RETRYABLE,
        }),
      ).toMatchObject({ kind: "APPLIED" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("FAILED_RETRYABLE");
      expect(row.submissionCertainty).toBe("DEFINITIVELY_REJECTED");
      expect(row.providerPredictionId).toBeNull();
      expect(row.providerAcceptedAt).toBeNull();
      expect(row.reconciliationResolvedAt?.getTime()).toBe(INSIDE);
      // Releasing here would leave a future recovery attempt with nothing to
      // stand on — the customer's request would be quietly unfinishable.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("records a terminal rejection and releases the unit", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("rejt");
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: REJECTED_TERMINAL,
        }),
      ).toMatchObject({ kind: "APPLIED" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("FAILED_TERMINAL");
      expect(row.submissionCertainty).toBe("DEFINITIVELY_REJECTED");
      const reservation = await reservationOf(job.id);
      expect(reservation.state).toBe("RELEASED");
      expect(reservation.releasedAt).not.toBeNull();
    });

    it("exhausts a closed window and leaves the question unanswered", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("exh");
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_A,
          attemptId,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "EXHAUSTED", attemptId, entitlementAnomaly: "NONE" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
      // The certainty is the whole point: nobody ever found out.
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      expect(row.providerPredictionId).toBeNull();
      expect(row.providerAcceptedAt).toBeNull();
      // Stamping a resolution instant would put a fabricated success in the one
      // field an auditor reads to find out when certainty was regained.
      expect(row.reconciliationResolvedAt).toBeNull();
      // The customer is made whole even though the provider cost stays unknown.
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
    });
  });

  describe("what a conclusion must not rewrite", () => {
    it.each([
      ["an acceptance", ACCEPTED],
      ["a retryable rejection", REJECTED_RETRYABLE],
      ["a terminal rejection", REJECTED_TERMINAL],
    ] as const)("preserves the uncertainty history through %s", async (label, observation) => {
      const suffix = `hist${label.replace(/\W/g, "")}`;
      const { attemptId } = await seedReconcilingAttempt(suffix);
      const before = await attemptRow(attemptId);

      await reconciliation().resolveReconciliation({ ...RESOLVE, attemptId, observation });

      const after = await attemptRow(attemptId);
      expect(after.submissionBoundaryEnteredAt?.getTime()).toBe(
        before.submissionBoundaryEnteredAt?.getTime(),
      );
      expect(after.reconciliationStartedAt?.getTime()).toBe(
        before.reconciliationStartedAt?.getTime(),
      );
      expect(after.reconciliationDeadlineAt?.getTime()).toBe(
        before.reconciliationDeadlineAt?.getTime(),
      );
      // The code that says *why* the attempt became uncertain. Overwriting it
      // with a later finding would erase the reason the row exists.
      expect(after.normalizedErrorCode).toBe("TIMEOUT");
      expect(before.normalizedErrorCode).toBe("TIMEOUT");
    });

    it("preserves the history through an exhaustion too", async () => {
      const { attemptId } = await seedReconcilingAttempt("histexh");
      const before = await attemptRow(attemptId);
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });
      const after = await attemptRow(attemptId);
      expect(after.reconciliationDeadlineAt?.getTime()).toBe(
        before.reconciliationDeadlineAt?.getTime(),
      );
      expect(after.reconciliationStartedAt?.getTime()).toBe(
        before.reconciliationStartedAt?.getTime(),
      );
      expect(after.normalizedErrorCode).toBe("TIMEOUT");
    });

    it("never re-POSTs and never admits a recovery attempt of its own", async () => {
      // A conclusion is a record, not a trigger. Admitting a replacement here
      // would spend a second unit of provider capacity on a decision nobody
      // made — and would do it inside the same transaction that just told the
      // customer their money was coming back.
      const { attemptId, request } = await seedReconcilingAttempt("norepost");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_RETRYABLE,
      });
      const attempts = await prisma.sceneGeneration.findMany({
        where: { generationSceneRequestId: request.id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.id).toBe(attemptId);
    });

    it("leaves the parent request, scene and job untouched", async () => {
      const { attemptId, request, scene, job } = await seedReconcilingAttempt("parents");
      const beforeJob = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      const beforeScene = await prisma.generationScene.findUniqueOrThrow({
        where: { id: scene.id },
      });
      const beforeRequest = await prisma.sceneGenerationRequest.findUniqueOrThrow({
        where: { id: request.id },
      });

      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });

      expect(
        await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({ state: beforeJob.state, stateVersion: beforeJob.stateVersion });
      expect(
        await prisma.generationScene.findUniqueOrThrow({ where: { id: scene.id } }),
      ).toMatchObject({ stateVersion: beforeScene.stateVersion });
      expect(
        await prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ stateVersion: beforeRequest.stateVersion });
    });
  });

  describe("the audit record", () => {
    it("appends one attempt event and one reservation event, in one commit", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("audit");
      const reservationId = (await reservationOf(job.id)).id;
      const attemptBefore = (await eventsFor(attemptId)).length;
      const reservationBefore = (await reservationEvents(reservationId)).length;

      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });

      const attemptEvents = await eventsFor(attemptId);
      const resEvents = await reservationEvents(reservationId);
      expect(attemptEvents).toHaveLength(attemptBefore + 1);
      expect(resEvents).toHaveLength(reservationBefore + 1);
      expect(attemptEvents.at(-1)).toMatchObject({
        eventType: RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
        fromState: "RECONCILIATION_PENDING",
        toState: "PROCESSING",
      });
      expect(resEvents.at(-1)).toMatchObject({
        eventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
        fromState: "RECONCILIATION_HOLD",
        toState: "RESERVED",
      });
    });

    it("labels a rejection and its release distinctly", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("auditrej");
      const reservationId = (await reservationOf(job.id)).id;
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_TERMINAL,
      });
      expect((await eventsFor(attemptId)).at(-1)).toMatchObject({
        eventType: RECONCILIATION_RESOLVED_REJECTED_EVENT_TYPE,
        toState: "FAILED_TERMINAL",
      });
      expect((await reservationEvents(reservationId)).at(-1)).toMatchObject({
        eventType: RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
        toState: "RELEASED",
      });
    });

    it("labels an exhaustion and its release", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("auditexh");
      const reservationId = (await reservationOf(job.id)).id;
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });
      expect((await eventsFor(attemptId)).at(-1)).toMatchObject({
        eventType: RECONCILIATION_EXHAUSTED_EVENT_TYPE,
        fromState: "RECONCILIATION_PENDING",
        toState: "RECONCILIATION_EXHAUSTED",
      });
      expect((await reservationEvents(reservationId)).at(-1)).toMatchObject({
        eventType: RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
      });
    });

    it("stores enough safe metadata to reconstruct the decision", async () => {
      const { attemptId } = await seedReconcilingAttempt("auditmeta");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_RETRYABLE,
      });
      const event = (await eventsFor(attemptId)).at(-1);
      expect(event?.safeMetadata).toMatchObject({
        attemptId,
        submissionCertainty: "DEFINITIVELY_REJECTED",
        requestKind: "INITIAL",
        entitlementAnomaly: "NONE",
        reconciliationDeadlineAt: DEADLINE,
        reconciliationResolvedAt: INSIDE,
        retryable: true,
        diagnosticCode: "CONNECTION_RESET",
      });
    });

    it("stores no provider payload, prompt, URL or credential", async () => {
      const { attemptId } = await seedReconcilingAttempt("auditsafe");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      const event = (await eventsFor(attemptId)).at(-1);
      const serialized = JSON.stringify(event?.safeMetadata);
      for (const forbidden of [
        "pred_reconciled",
        "sunlit living room",
        "https://",
        "Bearer",
        "apiKey",
      ]) {
        expect(`${forbidden}: ${serialized.includes(forbidden)}`).toBe(`${forbidden}: false`);
      }
    });

    it("appends no reservation event when nothing moves", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("auditnores", {
        requestKind: "USER_REGENERATION",
      });
      const reservationId = (await reservationOf(job.id)).id;
      const before = (await reservationEvents(reservationId)).length;
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      expect(await reservationEvents(reservationId)).toHaveLength(before);
    });
  });

  describe("a post-delivery regeneration never touches a unit", () => {
    it.each([
      ["an acceptance", ACCEPTED],
      ["a retryable rejection", REJECTED_RETRYABLE],
      ["a terminal rejection", REJECTED_TERMINAL],
    ] as const)("leaves the spent unit CONSUMED through %s", async (label, observation) => {
      const { attemptId, job } = await seedReconcilingAttempt(
        `regen${label.replace(/\W/g, "")}`,
        { requestKind: "USER_REGENERATION" },
      );
      const before = await reservationOf(job.id);
      expect(before.state).toBe("CONSUMED");

      const result = await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation,
      });
      // The anomaly classification says "normal": the regeneration right is
      // sold with the original video and exercised after the unit is spent.
      expect(result).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "NONE" });

      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.releasedAt).toBeNull();
    });

    it("leaves it CONSUMED through an exhaustion", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("regenexh", {
        requestKind: "USER_REGENERATION",
      });
      const before = await reservationOf(job.id);
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_A,
          attemptId,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "EXHAUSTED", entitlementAnomaly: "NONE" });
      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
    });

    it("never consumes a unit anywhere in the phase", async () => {
      // No conclusion here charges anyone. Charging happens when a video is
      // delivered, and nothing in this phase delivers one.
      const a = await seedReconcilingAttempt("noconsumea");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: a.attemptId,
        observation: ACCEPTED,
      });
      const b = await seedReconcilingAttempt("noconsumeb");
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId: b.attemptId,
        context: ctx(),
      });
      expect((await reservationOf(a.job.id)).state).toBe("RESERVED");
      expect((await reservationOf(b.job.id)).state).toBe("RELEASED");
      const consumed = await prisma.generationReservation.findMany({
        where: { state: "CONSUMED" },
      });
      expect(consumed).toHaveLength(0);
    });
  });

  describe("an entitlement anomaly is recorded, never a refusal", () => {
    it("resolves an attempt whose hold was released behind its back", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("anomrel");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "RELEASED", releasedAt: new Date(), stateVersion: { increment: 1 } },
      });

      const result = await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      // Provider reality after the paid boundary is persisted whether or not
      // the bookkeeping adds up.
      expect(result).toMatchObject({
        kind: "APPLIED",
        entitlementAnomaly: "RESERVATION_RELEASED",
      });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
      // And the terminal reservation is not resurrected.
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
      expect((await eventsFor(attemptId)).at(-1)?.safeMetadata).toMatchObject({
        entitlementAnomaly: "RESERVATION_RELEASED",
      });
    });

    it("resolves an attempt whose reservation vanished entirely", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("anommissing");
      await prisma.generationReservation.deleteMany({ where: { generationJobId: job.id } });
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
      ).toMatchObject({ kind: "APPLIED", entitlementAnomaly: "RESERVATION_MISSING" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
    });

    it("exhausts an attempt with anomalous bookkeeping rather than stalling", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("anomexh");
      await prisma.generationReservation.updateMany({
        where: { generationJobId: job.id },
        data: { state: "RESERVED", stateVersion: { increment: 1 } },
      });
      const result = await reconciliation(
        prisma,
        createFixedSubmissionClock(AFTER),
      ).exhaustReconciliation({ organizationId: ORG_A, attemptId, context: ctx() });
      expect(result).toMatchObject({
        kind: "EXHAUSTED",
        entitlementAnomaly: "RESERVATION_STATE_INCONSISTENT",
      });
      // Recorded, not guessed at. Releasing a hold that something else already
      // restored would turn one inconsistency into two.
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });
  });

  describe("a Job-scoped hold waits for its last unknown attempt", () => {
    it("keeps the hold when the first of two siblings is accepted, and restores on the last", async () => {
      const first = await seedReconcilingAttempt("sibA");
      const second = await seedSiblingUncertainAttempt("sibB", first.job);
      const reservation = await reservationOf(first.job.id);
      expect(reservation.state).toBe("RECONCILIATION_HOLD");
      const restoredBefore = (await reservationEvents(reservation.id)).filter(
        (e) => e.eventType === RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
      ).length;

      // First conclusion: the Job is still uncertain because of the sibling.
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId: first.attemptId,
          observation: ACCEPTED,
        }),
      ).toMatchObject({ kind: "APPLIED" });

      expect((await attemptRow(first.attemptId)).submissionCertainty).toBe("ACCEPTED");
      const afterFirst = await reservationOf(first.job.id);
      expect(afterFirst.state).toBe("RECONCILIATION_HOLD");
      expect(afterFirst.stateVersion).toBe(reservation.stateVersion);
      expect(
        (await reservationEvents(reservation.id)).filter(
          (e) => e.eventType === RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
        ),
      ).toHaveLength(restoredBefore);
      expect((await eventsFor(first.attemptId)).at(-1)?.safeMetadata).toMatchObject({
        remainingPendingUnknownAttempts: 1,
      });

      // Second conclusion: nothing is unknown any more, so the unit comes back.
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId: second.attemptId,
          observation: { kind: "ACCEPTED", providerPredictionId: "pred_sibling" },
        }),
      ).toMatchObject({ kind: "APPLIED" });

      const afterSecond = await reservationOf(first.job.id);
      expect(afterSecond.state).toBe("RESERVED");
      expect(afterSecond.stateVersion).toBe(reservation.stateVersion + 1);
      expect(
        (await reservationEvents(reservation.id)).filter(
          (e) => e.eventType === RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
        ),
      ).toHaveLength(restoredBefore + 1);
      expect((await eventsFor(second.attemptId)).at(-1)?.safeMetadata).toMatchObject({
        remainingPendingUnknownAttempts: 0,
      });
    });

    it("does the same when the first conclusion is a retryable rejection", async () => {
      const first = await seedReconcilingAttempt("sibRetryA");
      const second = await seedSiblingUncertainAttempt("sibRetryB", first.job);
      const reservation = await reservationOf(first.job.id);

      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId: first.attemptId,
          observation: REJECTED_RETRYABLE,
        }),
      ).toMatchObject({ kind: "APPLIED" });
      expect((await attemptRow(first.attemptId)).orchestrationState).toBe("FAILED_RETRYABLE");
      // A retryable rejection would normally restore the unit for a recovery
      // attempt. It still must not, while a sibling is unaccounted for.
      expect((await reservationOf(first.job.id)).state).toBe("RECONCILIATION_HOLD");

      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId: second.attemptId,
          observation: REJECTED_RETRYABLE,
        }),
      ).toMatchObject({ kind: "APPLIED" });
      const after = await reservationOf(first.job.id);
      expect(after.state).toBe("RESERVED");
      expect(after.stateVersion).toBe(reservation.stateVersion + 1);
    });

    it("releases on a terminal rejection even while a sibling is unknown", async () => {
      // Deliberately asymmetric: releasing is how the customer stops paying for
      // a question nobody answered, and RELEASED is terminal, so the sibling's
      // later conclusion can never resurrect it.
      const first = await seedReconcilingAttempt("sibTermA");
      const second = await seedSiblingUncertainAttempt("sibTermB", first.job);

      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: first.attemptId,
        observation: REJECTED_TERMINAL,
      });
      const released = await reservationOf(first.job.id);
      expect(released.state).toBe("RELEASED");

      // The sibling resolves as accepted, which would restore — and cannot.
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: second.attemptId,
        observation: { kind: "ACCEPTED", providerPredictionId: "pred_sibling" },
      });
      const after = await reservationOf(first.job.id);
      expect(after.state).toBe("RELEASED");
      expect(after.stateVersion).toBe(released.stateVersion);
    });

    it("releases on exhaustion even while a sibling is unknown", async () => {
      const first = await seedReconcilingAttempt("sibExhA");
      await seedSiblingUncertainAttempt("sibExhB", first.job);
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_A,
          attemptId: first.attemptId,
          context: ctx(),
        }),
      ).toMatchObject({ kind: "EXHAUSTED" });
      expect((await reservationOf(first.job.id)).state).toBe("RELEASED");
    });

    it("counts only siblings in the same Job", async () => {
      // A different Job's uncertain attempt is not a reason to hold this Job's
      // unit. The count is derived through Attempt → Request → Scene → Job.
      const mine = await seedReconcilingAttempt("sibScopeA");
      const elsewhere = await seedReconcilingAttempt("sibScopeB");
      expect(elsewhere.job.id).not.toBe(mine.job.id);

      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: mine.attemptId,
        observation: ACCEPTED,
      });
      expect((await reservationOf(mine.job.id)).state).toBe("RESERVED");
      expect((await eventsFor(mine.attemptId)).at(-1)?.safeMetadata).toMatchObject({
        remainingPendingUnknownAttempts: 0,
      });
      // The other Job's hold is untouched.
      expect((await reservationOf(elsewhere.job.id)).state).toBe("RECONCILIATION_HOLD");
    });

    it("counts only siblings that are still durably unknown", async () => {
      // A sibling that already concluded is not a reason to keep waiting.
      const first = await seedReconcilingAttempt("sibDoneA");
      const second = await seedSiblingUncertainAttempt("sibDoneB", first.job);
      await prisma.sceneGeneration.update({
        where: { id: second.attemptId },
        data: {
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          stateVersion: { increment: 1 },
        },
      });
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: first.attemptId,
        observation: ACCEPTED,
      });
      expect((await reservationOf(first.job.id)).state).toBe("RESERVED");
    });

    it("never restores a post-delivery regeneration's spent unit, siblings or not", async () => {
      const first = await seedReconcilingAttempt("sibRegen", {
        requestKind: "USER_REGENERATION",
      });
      const before = await reservationOf(first.job.id);
      expect(before.state).toBe("CONSUMED");
      await seedSiblingUncertainAttempt("sibRegenB", first.job);

      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: first.attemptId,
        observation: ACCEPTED,
      });
      const after = await reservationOf(first.job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.releasedAt).toBeNull();
    });
  });

  describe("replay and closure", () => {
    it("replays identical evidence with zero further mutation", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("replay");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      const afterFirst = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      const second = await reconciliation(
        prisma,
        createFixedSubmissionClock(epochMillis(INSIDE + 5_000)),
      ).resolveReconciliation({ ...RESOLVE, attemptId, observation: ACCEPTED });
      expect(second).toEqual({ kind: "REPLAYED", attemptId });

      const afterSecond = await attemptRow(attemptId);
      expect(afterSecond.stateVersion).toBe(afterFirst.stateVersion);
      expect(afterSecond.reconciliationResolvedAt?.getTime()).toBe(INSIDE);
      expect(await eventsFor(attemptId)).toHaveLength(events);
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("replays after the attempt has moved on downstream", async () => {
      // Identity is provider reality, not where the attempt has since
      // travelled. An attempt whose output is already verified has not
      // contradicted its own acceptance.
      const { attemptId } = await seedReconcilingAttempt("replaydown");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { orchestrationState: "PROVIDER_SUCCEEDED", stateVersion: { increment: 1 } },
      });
      const before = await attemptRow(attemptId);
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
      ).toEqual({ kind: "REPLAYED", attemptId });
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
    });

    it("replays a duplicate delivery long after the window closed", async () => {
      const { attemptId } = await seedReconcilingAttempt("replaylate");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_RETRYABLE,
      });
      expect(
        await reconciliation(
          prisma,
          createFixedSubmissionClock(epochMillis(DEADLINE + 86_400_000)),
        ).resolveReconciliation({ ...RESOLVE, attemptId, observation: REJECTED_RETRYABLE }),
      ).toEqual({ kind: "REPLAYED", attemptId });
    });

    it("refuses a contradicting reference with zero mutation", async () => {
      const { attemptId } = await seedReconcilingAttempt("conflictref");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      const before = await attemptRow(attemptId);
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: { kind: "ACCEPTED", providerPredictionId: "pred_other" },
        }),
      ).toEqual({ kind: "CONFLICTING_RESOLUTION", reason: "PROVIDER_REFERENCE_MISMATCH" });
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.providerPredictionId).toBe("pred_reconciled");
    });

    it("refuses observers who disagree about retryability", async () => {
      // They have disagreed about the customer's remaining entitlement: one
      // says the unit is restored for a recovery attempt, the other says gone.
      const { attemptId, job } = await seedReconcilingAttempt("conflictretry");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_RETRYABLE,
      });
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: REJECTED_TERMINAL,
        }),
      ).toEqual({ kind: "CONFLICTING_RESOLUTION", reason: "TERMINAL_STATE_MISMATCH" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("FAILED_RETRYABLE");
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("reports a second exhaustion as already exhausted, with zero mutation", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("exhtwice");
      const service = reconciliation(prisma, createFixedSubmissionClock(AFTER));
      await service.exhaustReconciliation({ organizationId: ORG_A, attemptId, context: ctx() });
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;
      const reservationBefore = await reservationOf(job.id);

      expect(
        await service.exhaustReconciliation({ organizationId: ORG_A, attemptId, context: ctx() }),
      ).toEqual({ kind: "ALREADY_EXHAUSTED", attemptId });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(await eventsFor(attemptId)).toHaveLength(events);
      expect((await reservationOf(job.id)).stateVersion).toBe(reservationBefore.stateVersion);
    });

    it("refuses to reopen an exhausted attempt with late evidence", async () => {
      // Terminal because the platform already told the customer it had stopped
      // waiting. What late evidence establishes about internal provider cost
      // belongs to accounting, not to resurrecting the attempt.
      const { attemptId, job } = await seedReconcilingAttempt("late");
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      expect(
        await reconciliation(
          prisma,
          createFixedSubmissionClock(epochMillis(AFTER + 1_000)),
        ).resolveReconciliation({ ...RESOLVE, attemptId, observation: ACCEPTED }),
      ).toEqual({ kind: "RECONCILIATION_CLOSED" });

      const after = await attemptRow(attemptId);
      expect(after.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.providerPredictionId).toBeNull();
      expect(await eventsFor(attemptId)).toHaveLength(events);
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
    });

    it("refuses to exhaust an attempt that regained certainty first", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("certfirst");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_A,
          attemptId,
          context: ctx(),
        }),
      ).toEqual({ kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });
  });

  describe("tenant scope", () => {
    it("cannot resolve another organization's attempt", async () => {
      const { attemptId } = await seedReconcilingAttempt("tenant");
      const before = await attemptRow(attemptId);
      expect(
        await reconciliation().resolveReconciliation({
          organizationId: ORG_B,
          attemptId,
          observation: ACCEPTED,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("RECONCILIATION_PENDING");
    });

    it("cannot exhaust another organization's attempt", async () => {
      const { attemptId } = await seedReconcilingAttempt("tenantexh");
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_B,
          attemptId,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("RECONCILIATION_PENDING");
    });

    it("answers a wholly unknown id the same way", async () => {
      // Indistinguishable from cross-tenant on purpose: a different answer
      // would confirm another tenant's row exists.
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId: "sgen_nonexistent",
          observation: ACCEPTED,
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two identical resolutions apply", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("raceequal");
      const results = await Promise.all([
        reconciliation(prisma).resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
        reconciliation(other).resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["APPLIED", "REPLAYED"]);

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("PROCESSING");
      expect(row.providerPredictionId).toBe("pred_reconciled");
      // One conclusion, one entitlement move, one of each event.
      expect(
        (await eventsFor(attemptId)).filter(
          (e) => e.eventType === RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
      const reservation = await reservationOf(job.id);
      expect(reservation.state).toBe("RESERVED");
      expect(
        (await reservationEvents(reservation.id)).filter(
          (e) => e.eventType === RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    });

    it("never lets a resolution and an exhaustion both land", async () => {
      // The dangerous race in this phase. One of them owns the row; the other
      // must see the result rather than write over it, and no interleaving may
      // leave a resolved attempt with a released hold or the reverse.
      const { attemptId, job } = await seedReconcilingAttempt("raceclose");
      const results = await Promise.all([
        reconciliation(prisma, createFixedSubmissionClock(INSIDE)).resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
        reconciliation(other, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_A,
          attemptId,
          context: ctx(),
        }),
      ]);

      const row = await attemptRow(attemptId);
      const reservation = await reservationOf(job.id);
      const resolutionWon = row.orchestrationState === "PROCESSING";

      if (resolutionWon) {
        expect(row.submissionCertainty).toBe("ACCEPTED");
        expect(row.providerPredictionId).toBe("pred_reconciled");
        expect(row.reconciliationResolvedAt).not.toBeNull();
        expect(reservation.state).toBe("RESERVED");
      } else {
        expect(row.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
        expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
        expect(row.providerPredictionId).toBeNull();
        expect(row.reconciliationResolvedAt).toBeNull();
        expect(reservation.state).toBe("RELEASED");
      }
      // Whichever won, the other did not also succeed.
      expect(results.filter((r) => r.kind === "APPLIED" || r.kind === "EXHAUSTED")).toHaveLength(
        1,
      );
      // And exactly one terminal-ish attempt event was appended.
      const written = (await eventsFor(attemptId)).filter((e) =>
        [
          RECONCILIATION_RESOLVED_ACCEPTED_EVENT_TYPE,
          RECONCILIATION_EXHAUSTED_EVENT_TYPE,
        ].includes(e.eventType),
      );
      expect(written).toHaveLength(1);
    });

    it("judges the deadline on the clock read after the lock, not before", async () => {
      // The correction this discipline exists for. A resolver arrives while the
      // window is open, queues behind a lock, and gets in after the window
      // closed. Reading the clock before waiting would authorize a resolution
      // for a window that is already over — and would race the exhauster that
      // now legitimately owns the row.
      const { attemptId, job } = await seedReconcilingAttempt("racepostlock");

      let deadlinePassed = false;
      let clockReads = 0;
      const waitingClock: SubmissionClock = {
        now(): EpochMillis {
          clockReads += 1;
          return deadlinePassed ? AFTER : INSIDE;
        },
      };

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A Phase 2F-1 cost admission holds the very locks this phase takes.
      const holder = createPaidSubmissionAuthorizationRepository(blocker).withCostAdmission(
        { organizationId: ORG_A, attemptId },
        async (session) => {
          await session.loadFacts();
          await held;
          return null;
        },
      );

      let stillBlocked: boolean;
      try {
        await breathe(4);
        // Starts while the window is open: a pre-lock read would say INSIDE.
        expect(waitingClock.now()).toBe(INSIDE);
        const blocked = settled(
          reconciliation(prisma, waitingClock).resolveReconciliation({
            ...RESOLVE,
            attemptId,
            observation: ACCEPTED,
          }),
        );
        await breathe();
        stillBlocked = !blocked.done();
        // The window closes while the resolver is still queued.
        deadlinePassed = true;
        release();
        await holder;
        expect(stillBlocked).toBe(true);
        expect(await blocked.value).toEqual({ kind: "DEADLINE_EXPIRED" });
      } finally {
        release();
      }

      // Nothing was written, and the row is still the exhauster's to close.
      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.providerPredictionId).toBeNull();
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
      // One read for the pre-lock assertion above, one inside the service.
      expect(clockReads).toBe(2);
    });

    it("restores a Job-scoped hold exactly once when two siblings resolve at once", async () => {
      // Both conclusions would normally RESTORE. The sibling count is only
      // authoritative because it is read inside the same organization+cycle
      // serialization the two transactions contend on: whichever commits
      // first, the other counts it as no longer unknown and finishes the job.
      //
      // No second lock namespace is introduced for this. The existing one
      // already orders them.
      const first = await seedReconcilingAttempt("raceSibA");
      const second = await seedSiblingUncertainAttempt("raceSibB", first.job);
      const reservation = await reservationOf(first.job.id);
      expect(reservation.state).toBe("RECONCILIATION_HOLD");

      const results = await Promise.all([
        reconciliation(prisma).resolveReconciliation({
          ...RESOLVE,
          attemptId: first.attemptId,
          observation: ACCEPTED,
        }),
        reconciliation(other).resolveReconciliation({
          ...RESOLVE,
          attemptId: second.attemptId,
          observation: { kind: "ACCEPTED", providerPredictionId: "pred_sibling" },
        }),
      ]);
      // Both are legitimate conclusions about different attempts; neither is a
      // loser, and neither rejects.
      expect(results.map((r) => r.kind)).toEqual(["APPLIED", "APPLIED"]);

      expect((await attemptRow(first.attemptId)).submissionCertainty).toBe("ACCEPTED");
      expect((await attemptRow(second.attemptId)).submissionCertainty).toBe("ACCEPTED");

      const after = await reservationOf(first.job.id);
      expect(after.state).toBe("RESERVED");
      // Exactly one restore. Two would mean the hold was lifted, re-suspended
      // and lifted again; a version bump of more than one would mean the
      // second conclusion moved a reservation that was already restored.
      expect(after.stateVersion).toBe(reservation.stateVersion + 1);
      expect(
        (await reservationEvents(reservation.id)).filter(
          (e) => e.eventType === RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
        ),
      ).toHaveLength(1);

      // And the two attempt events between them tell the whole story: one saw a
      // sibling outstanding, the other saw none.
      const counts = [
        (await eventsFor(first.attemptId)).at(-1)?.safeMetadata,
        (await eventsFor(second.attemptId)).at(-1)?.safeMetadata,
      ].map((m) => (m as { remainingPendingUnknownAttempts?: number } | undefined)
        ?.remainingPendingUnknownAttempts);
      expect([...counts].sort()).toEqual([0, 1]);
    });

    it("serializes against a Phase 2F-1 cost admission on the same locks", async () => {
      // A conclusion moves an organization's cycle exposure in both directions,
      // so an authorization reading exposure while one lands would decide on a
      // total that is mid-flight. They serialize because this phase takes the
      // same organization+cycle advisory lock and the same reservation row, in
      // the same order.
      const { attemptId, job } = await seedReconcilingAttempt("crossphase");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorization = createPaidSubmissionAuthorizationRepository(
        blocker,
      ).withCostAdmission({ organizationId: ORG_A, attemptId }, async (session) => {
        await session.loadFacts();
        await held;
        return null;
      });

      let stillBlocked: boolean;
      try {
        await breathe(4);
        const blocked = settled(
          reconciliation(prisma).resolveReconciliation({
            ...RESOLVE,
            attemptId,
            observation: ACCEPTED,
          }),
        );
        await breathe();
        stillBlocked = !blocked.done();
        release();
        await authorization;
        expect(stillBlocked).toBe(true);
        expect((await blocked.value).kind).toBe("APPLIED");
      } finally {
        release();
      }
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("blocks while a reservation writer holds the row, then records anyway", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("racereswriter");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = other.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "generation_reservations"
               SET "state" = 'RELEASED'::"GenerationReservationState",
                   "stateVersion" = "stateVersion" + 1,
                   "releasedAt" = NOW()
             WHERE "generationJobId" = ${job.id}
          `;
          await held;
        },
        { timeout: 8_000 },
      );

      let stillBlocked: boolean;
      try {
        await breathe(4);
        const blocked = settled(
          reconciliation(prisma).resolveReconciliation({
            ...RESOLVE,
            attemptId,
            observation: ACCEPTED,
          }),
        );
        await breathe();
        stillBlocked = !blocked.done();
        release();
        await writer;
        expect(stillBlocked).toBe(true);
        // Provider reality is recorded; the terminal hold is not revived.
        expect(await blocked.value).toMatchObject({
          kind: "APPLIED",
          entitlementAnomaly: "RESERVATION_RELEASED",
        });
      } finally {
        release();
      }
      expect((await reservationOf(job.id)).state).toBe("RELEASED");
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
    });
  });

  describe("the release instant is the decision's own", () => {
    it("stamps a terminal rejection's release with the injected clock", async () => {
      // One clock read, after the locks, driving every timestamp the decision
      // produces. A second wall-clock read in the repository would stamp the
      // customer's release with an instant no lock was held for, and would drift
      // from the resolution the same decision wrote.
      const { attemptId, job } = await seedReconcilingAttempt("relterm");
      await reconciliation(prisma, createFixedSubmissionClock(INSIDE)).resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_TERMINAL,
      });
      const reservation = await reservationOf(job.id);
      expect(reservation.state).toBe("RELEASED");
      expect(reservation.releasedAt?.getTime()).toBe(INSIDE);
      expect((await attemptRow(attemptId)).reconciliationResolvedAt?.getTime()).toBe(INSIDE);
    });

    it("stamps an exhaustion's release with the injected clock, resolving nothing", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("relexh");
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId,
        context: ctx(),
      });
      const reservation = await reservationOf(job.id);
      expect(reservation.state).toBe("RELEASED");
      expect(reservation.releasedAt?.getTime()).toBe(AFTER);
      // Still no resolution instant. The release needed a time; nothing was
      // resolved, and the two facts stay separate.
      expect((await attemptRow(attemptId)).reconciliationResolvedAt).toBeNull();
    });

    it("ignores the process wall clock entirely", async () => {
      // The injected instant is a fixture date, deliberately nowhere near the
      // moment this test runs. A `new Date()` in the repository would land
      // inside [wallBefore, wallAfter]; the decision's instant does not.
      const { attemptId, job } = await seedReconcilingAttempt("relwall");
      const wallBefore = Date.now();
      await reconciliation(prisma, createFixedSubmissionClock(INSIDE)).resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: REJECTED_TERMINAL,
      });
      const wallAfter = Date.now();
      const releasedAt = (await reservationOf(job.id)).releasedAt?.getTime() ?? 0;
      expect(releasedAt).toBe(INSIDE);
      const wouldBeWallClock = releasedAt >= wallBefore && releasedAt <= wallAfter;
      expect(wouldBeWallClock).toBe(false);
    });

    it("names no unparameterized wall-clock read in the repository source", () => {
      // A static guard, because the behavioural tests above only catch a wall
      // clock used for a *persisted business* timestamp. This catches the
      // reintroduction itself.
      const source = readFileSync(
        join(__dirname, "../../packages/database/src/reconciliation-repository.ts"),
        "utf8",
      );
      expect(source.includes("new Date()")).toBe(false);
      expect(source.includes("Date.now(")).toBe(false);
      expect(source.includes("new Date(Date.now())")).toBe(false);
      // Converting an explicit validated instant is the only permitted form.
      expect(source.includes("new Date(write.decisionAt)")).toBe(true);
    });
  });

  describe("a direct Phase 2G-1 outcome is not a reconciliation replay", () => {
    it("refuses an attempt that reached ACCEPTED without ever becoming uncertain", async () => {
      // Phase 2G-1 observed the provider response directly at the boundary. Same
      // certainty, same reference, no reconciliation history — and no
      // reconciliation to replay. Calling it REPLAYED would report success for
      // an operation that never ran and hide a mis-routed caller.
      const { attemptId, job } = await seedReconcilingAttempt("directacc", {
        stopAtBoundary: true,
      });
      const applied = await outcomes().recordObservation({
        organizationId: ORG_A,
        attemptId,
        observation: { kind: "ACCEPTED", providerPredictionId: "pred_direct" },
        context: ctx(),
      });
      expect(applied.kind).toBe("APPLIED");

      const before = await attemptRow(attemptId);
      expect(before.submissionCertainty).toBe("ACCEPTED");
      expect(before.reconciliationStartedAt).toBeNull();
      expect(before.reconciliationDeadlineAt).toBeNull();
      expect(before.reconciliationResolvedAt).toBeNull();

      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: { kind: "ACCEPTED", providerPredictionId: "pred_direct" },
        }),
      ).toEqual({ kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect((await reservationOf(job.id)).state).toBe("RESERVED");
    });

    it("refuses an attempt that reached a definitive rejection directly", async () => {
      const { attemptId } = await seedReconcilingAttempt("directrej", {
        stopAtBoundary: true,
      });
      await outcomes().recordObservation({
        organizationId: ORG_A,
        attemptId,
        observation: {
          kind: "DEFINITIVELY_REJECTED",
          retryable: false,
          normalizedErrorCode: code("LOCAL_CONFIGURATION"),
        },
        context: ctx(),
      });
      const before = await attemptRow(attemptId);
      expect(before.submissionCertainty).toBe("DEFINITIVELY_REJECTED");
      expect(before.reconciliationStartedAt).toBeNull();

      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: REJECTED_TERMINAL,
        }),
      ).toEqual({ kind: "NOT_RECONCILING", reason: "ATTEMPT_NEVER_BECAME_UNCERTAIN" });
      expect((await attemptRow(attemptId)).stateVersion).toBe(before.stateVersion);
    });

    it("fails closed on a half-written reconciliation history", async () => {
      const { attemptId } = await seedReconcilingAttempt("partialhist");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      // Something erased the resolution instant while leaving the rest. The
      // record cannot be believed in either direction.
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: { reconciliationResolvedAt: null },
      });
      const before = await attemptRow(attemptId);
      const events = (await eventsFor(attemptId)).length;

      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
      ).toEqual({ kind: "NOT_RECONCILING", reason: "RECONCILIATION_HISTORY_INCOHERENT" });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      // Not repaired. A fabricated resolution instant is exactly what this
      // phase refuses to invent everywhere else.
      expect(after.reconciliationResolvedAt).toBeNull();
      expect(await eventsFor(attemptId)).toHaveLength(events);
    });

    it("still replays a true reconciliation after downstream progress", async () => {
      const { attemptId } = await seedReconcilingAttempt("truereplay");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId,
        observation: ACCEPTED,
      });
      await prisma.sceneGeneration.update({
        where: { id: attemptId },
        data: {
          orchestrationState: "OUTPUT_VERIFIED",
          stateVersion: { increment: 1 },
          // Phase 2H-1's CHECK requires a verified output to carry its
          // integrity facts; this fixture advances the lifecycle rather than
          // testing output metadata, so it supplies a coherent set.
          outputStorageKey: `org/${ORG_A}/generations/${attemptId}/output.mp4`,
          outputSha256: "a".repeat(64),
          outputSizeBytes: BigInt(1024),
          outputVerifiedAt: new Date(),
        },
      });
      const before = await attemptRow(attemptId);
      expect(
        await reconciliation().resolveReconciliation({
          ...RESOLVE,
          attemptId,
          observation: ACCEPTED,
        }),
      ).toEqual({ kind: "REPLAYED", attemptId });
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("OUTPUT_VERIFIED");
    });
  });

  describe("candidate discovery", () => {
    it("returns identifiers only, and nothing to decide with", async () => {
      const { attemptId } = await seedReconcilingAttempt("disc1");
      const found = await createReconciliationRepository(prisma).findDueReconciliationCandidates(
        { cutoff: AFTER, limit: 10 },
      );
      expect(found).toEqual([{ organizationId: ORG_A, attemptId }]);
      expect(Object.keys(found[0] ?? {}).sort()).toEqual(["attemptId", "organizationId"]);
    });

    it("excludes a window that has not closed yet", async () => {
      await seedReconcilingAttempt("disc2");
      expect(
        await createReconciliationRepository(prisma).findDueReconciliationCandidates({
          cutoff: INSIDE,
          limit: 10,
        }),
      ).toEqual([]);
    });

    it("includes a window closing exactly at the cutoff", async () => {
      const { attemptId } = await seedReconcilingAttempt("disc3");
      expect(
        await createReconciliationRepository(prisma).findDueReconciliationCandidates({
          cutoff: DEADLINE,
          limit: 10,
        }),
      ).toEqual([{ organizationId: ORG_A, attemptId }]);
    });

    it("excludes attempts that already concluded", async () => {
      const resolved = await seedReconcilingAttempt("disc4a");
      const exhausted = await seedReconcilingAttempt("disc4b");
      const open = await seedReconcilingAttempt("disc4c");
      await reconciliation().resolveReconciliation({
        ...RESOLVE,
        attemptId: resolved.attemptId,
        observation: ACCEPTED,
      });
      await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
        organizationId: ORG_A,
        attemptId: exhausted.attemptId,
        context: ctx(),
      });
      expect(
        await createReconciliationRepository(prisma).findDueReconciliationCandidates({
          cutoff: AFTER,
          limit: 10,
        }),
      ).toEqual([{ organizationId: ORG_A, attemptId: open.attemptId }]);
    });

    it("orders deterministically and honours the bound", async () => {
      // Two workers running the same query must agree on which rows they take,
      // or a bounded batch becomes a lottery that starves the oldest attempt.
      const seeded = [];
      for (const suffix of ["disc5c", "disc5a", "disc5b"]) {
        seeded.push(await seedReconcilingAttempt(suffix));
      }
      // Same deadline for all three, so the tiebreak is what is under test.
      const repo = createReconciliationRepository(prisma);
      const all = await repo.findDueReconciliationCandidates({ cutoff: AFTER, limit: 10 });
      const ids = all.map((c) => c.attemptId);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toHaveLength(3);

      const bounded = await repo.findDueReconciliationCandidates({ cutoff: AFTER, limit: 2 });
      expect(bounded.map((c) => c.attemptId)).toEqual(ids.slice(0, 2));
      void seeded;
    });

    it("orders by deadline before id", async () => {
      const early = await seedReconcilingAttempt("disc6z");
      const late = await seedReconcilingAttempt("disc6a");
      await prisma.sceneGeneration.update({
        where: { id: early.attemptId },
        data: { reconciliationDeadlineAt: new Date(DEADLINE - 10_000) },
      });
      expect(
        (
          await createReconciliationRepository(prisma).findDueReconciliationCandidates({
            cutoff: AFTER,
            limit: 10,
          })
        ).map((c) => c.attemptId),
      ).toEqual([early.attemptId, late.attemptId]);
    });

    it("finds attempts abandoned at the submission boundary", async () => {
      const stuck = await seedReconcilingAttempt("disc7", { stopAtBoundary: true });
      const moved = await seedReconcilingAttempt("disc8");
      const repo = createReconciliationRepository(prisma);
      expect(
        await repo.findStaleSubmittingCandidates({
          cutoff: epochMillis(BOUNDARY + 60_000),
          limit: 10,
        }),
      ).toEqual([{ organizationId: ORG_A, attemptId: stuck.attemptId }]);
      // The one that already entered uncertainty is not a stale candidate.
      expect(
        (
          await repo.findStaleSubmittingCandidates({
            cutoff: epochMillis(BOUNDARY + 60_000),
            limit: 10,
          })
        ).map((c) => c.attemptId),
      ).not.toContain(moved.attemptId);
    });

    it("takes no lock, so discovery never blocks behind a conclusion", async () => {
      // Candidates are advisory. If discovery took the row locks it needed to
      // be authoritative, a maintenance sweep would queue behind every
      // in-flight conclusion and a slow worker would stall the whole batch.
      const { attemptId } = await seedReconcilingAttempt("disclock");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = createPaidSubmissionAuthorizationRepository(blocker).withCostAdmission(
        { organizationId: ORG_A, attemptId },
        async (session) => {
          await session.loadFacts();
          await held;
          return null;
        },
      );
      try {
        await breathe(4);
        const found = await createReconciliationRepository(
          prisma,
        ).findDueReconciliationCandidates({ cutoff: AFTER, limit: 10 });
        expect(found).toEqual([{ organizationId: ORG_A, attemptId }]);
      } finally {
        release();
        await holder;
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
    ])("refuses a %s limit at the repository boundary", async (_label, limit) => {
      // These methods are public. A caller reaching them without the batch
      // runner must not be able to put `Infinity` or 5000 into a SQL LIMIT, so
      // the same canonical validator guards both boundaries.
      const repo = createReconciliationRepository(prisma);
      await expect(
        repo.findDueReconciliationCandidates({ cutoff: AFTER, limit }),
      ).rejects.toThrow(/between 1 and 100/);
      await expect(
        repo.findStaleSubmittingCandidates({ cutoff: AFTER, limit }),
      ).rejects.toThrow(/between 1 and 100/);
    });

    it.each([1, MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE])(
      "accepts the boundary limit %i",
      async (limit) => {
        const repo = createReconciliationRepository(prisma);
        await expect(
          repo.findDueReconciliationCandidates({ cutoff: AFTER, limit }),
        ).resolves.toBeInstanceOf(Array);
      },
    );

    it("does not leak another organization's rows into the identifier list", async () => {
      // The organization id travels with each candidate precisely so the
      // caller must scope its next call; discovery is global by design and
      // authority is not.
      const { attemptId } = await seedReconcilingAttempt("disctenant");
      const found = await createReconciliationRepository(prisma).findDueReconciliationCandidates(
        { cutoff: AFTER, limit: 10 },
      );
      expect(found.every((c) => c.organizationId === ORG_A)).toBe(true);
      // And that id is the one the service must be given to act.
      expect(
        await reconciliation(prisma, createFixedSubmissionClock(AFTER)).exhaustReconciliation({
          organizationId: ORG_B,
          attemptId,
          context: ctx(),
        }),
      ).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
    });
  });

  describe("one maintenance batch, end to end", () => {
    /** A runner wired to the real repositories and the real services. */
    function maintenance(at: EpochMillis) {
      return createReconciliationMaintenance({
        reconciliation: createReconciliationRepository(prisma),
        clock: createFixedSubmissionClock(at),
        reconciliationService: reconciliation(prisma, createFixedSubmissionClock(at)),
        submissionOutcomes: outcomes(prisma, at),
        policy: POLICY,
      });
    }

    it("makes an abandoned attempt uncertain and exhausts it in the same pass", async () => {
      // The corrected assumption. Phase 2G-1 freezes the deadline at
      // `submissionBoundaryEnteredAt + reconciliationWindow`, so an attempt
      // discovered long after it was abandoned enters SUBMISSION_UNKNOWN with a
      // deadline that has *already* elapsed. The due query in this same pass
      // then finds it, and the exhaustion service — re-checking under its own
      // lock and clock — closes it.
      //
      // That is correct, not a race to design around: the platform's bound on
      // that uncertainty ran out before anyone noticed the attempt, and making
      // the customer wait for another batch would extend a window that is over.
      const { attemptId, job } = await seedReconcilingAttempt("samebatch", {
        stopAtBoundary: true,
      });
      const boundaryRow = await attemptRow(attemptId);
      expect(boundaryRow.orchestrationState).toBe("SUBMITTING");
      expect(boundaryRow.submissionCertainty).toBe("PRE_SUBMISSION");

      // Well past both the stale threshold and the frozen reconciliation window.
      const at = epochMillis(BOUNDARY + POLICY.reconciliationWindowMs + 60_000);

      const report = await maintenance(at).runOnce({ limit: 25, context: ctx() });
      expect(report).toMatchObject({
        discoveryNow: at,
        staleCandidates: 1,
        staleUncertaintyEntered: 1,
        dueCandidates: 1,
        exhausted: 1,
        unchanged: 0,
      });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      expect(row.reconciliationResolvedAt).toBeNull();
      expect(row.providerPredictionId).toBeNull();
      // The customer is made whole, and the release carries the decision's own
      // instant rather than a wall-clock read.
      const reservation = await reservationOf(job.id);
      expect(reservation.state).toBe("RELEASED");
      expect(reservation.releasedAt?.getTime()).toBe(at);
    });

    it("does not exhaust a freshly stale attempt whose window is still open", async () => {
      // The same batch, a different clock. Here the deadline has not elapsed,
      // so the due query does not match it and nothing artificially delays or
      // artificially closes anything.
      const { attemptId } = await seedReconcilingAttempt("samebatchopen", {
        stopAtBoundary: true,
      });
      const at = epochMillis(BOUNDARY + POLICY.staleSubmittingAfterMs + 60_000);

      const report = await maintenance(at).runOnce({ limit: 25, context: ctx() });
      expect(report).toMatchObject({
        staleCandidates: 1,
        staleUncertaintyEntered: 1,
        dueCandidates: 0,
        exhausted: 0,
      });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("RECONCILIATION_PENDING");
    });

    it("leaves an attempt that has not sat at the boundary long enough", async () => {
      const { attemptId } = await seedReconcilingAttempt("samebatchfresh", {
        stopAtBoundary: true,
      });
      const at = epochMillis(BOUNDARY + POLICY.staleSubmittingAfterMs - 1);
      expect(await maintenance(at).runOnce({ limit: 25, context: ctx() })).toMatchObject({
        staleCandidates: 0,
        dueCandidates: 0,
      });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("SUBMITTING");
    });

    it("refuses an invalid batch bound before touching the database", async () => {
      const { attemptId } = await seedReconcilingAttempt("samebatchlimit", {
        stopAtBoundary: true,
      });
      const at = epochMillis(BOUNDARY + POLICY.reconciliationWindowMs + 60_000);
      await expect(
        maintenance(at).runOnce({ limit: 0, context: ctx() }),
      ).rejects.toThrow(/between 1 and 100/);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("SUBMITTING");
    });
  });

  describe("the persistence does not trust the write it is handed", () => {
    /**
     * `apply` takes a `ReconciliationWrite` from its caller. Today the only
     * caller is the service, which builds it from the same facts the repository
     * read under the same lock — so the guards below cannot fire through that
     * path, and a mutation test driving the service alone reports them as dead
     * code. They are not: they are the contract for the *next* caller, and the
     * cheapest place to catch a hand-built write is before it reaches a
     * database CHECK or a customer's entitlement.
     *
     * These tests call that boundary directly, which is the only honest way to
     * show the guards do something.
     */

    const ACCEPTED_WRITE = {
      orchestrationState: "PROCESSING",
      submissionCertainty: "ACCEPTED",
      providerPredictionId: "pred_handbuilt",
      providerAcceptedAt: INSIDE,
      reconciliationResolvedAt: INSIDE,
      decisionAt: INSIDE,
      reservationAction: "RESTORE",
    } as const;

    it("refuses a write whose state and certainty cannot both be true", async () => {
      // Caught here rather than as a constraint violation surfacing from the
      // driver: the database CHECK enforces the same pairing, and discovering
      // it that way means an opaque error in production instead of a defect.
      const { attemptId } = await seedReconcilingAttempt("guardcoherent");
      await expect(
        createReconciliationRepository(prisma).withReconcilingAttempt(
          { organizationId: ORG_A, attemptId },
          async (session) => {
            const facts = await session.loadFacts();
            if (facts === null) throw new Error("expected facts");
            return session.apply({
              expectedVersion: facts.attempt.stateVersion,
              // An acceptance that never established what the provider took.
              write: { ...ACCEPTED_WRITE, providerPredictionId: null },
              reservationEventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
              context: ctx(),
            });
          },
        ),
      ).rejects.toThrow(/incoherent/i);

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.providerPredictionId).toBeNull();
    });

    it("refuses a reference on a write that is not an acceptance", async () => {
      const { attemptId } = await seedReconcilingAttempt("guardref");
      await expect(
        createReconciliationRepository(prisma).withReconcilingAttempt(
          { organizationId: ORG_A, attemptId },
          async (session) => {
            const facts = await session.loadFacts();
            if (facts === null) throw new Error("expected facts");
            return session.apply({
              expectedVersion: facts.attempt.stateVersion,
              write: {
                orchestrationState: "FAILED_TERMINAL",
                submissionCertainty: "DEFINITIVELY_REJECTED",
                // A fabricated id on a rejection: nothing was ever taken.
                providerPredictionId: "pred_fabricated",
                providerAcceptedAt: null,
                reconciliationResolvedAt: INSIDE,
                decisionAt: INSIDE,
                reservationAction: "RELEASE",
              },
              reservationEventType: RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
              context: ctx(),
            });
          },
        ),
      ).rejects.toThrow(/incoherent/i);
      expect((await attemptRow(attemptId)).orchestrationState).toBe("RECONCILIATION_PENDING");
    });

    it("will not move a reservation that is not a suspended hold", async () => {
      // A hand-built write asking to restore a spent unit. The persistence
      // gates on the state it locked, not on what it was told, so a caller that
      // forgot the rule cannot hand a customer back a unit they already used.
      const { attemptId, job } = await seedReconcilingAttempt("guardres", {
        requestKind: "USER_REGENERATION",
      });
      const before = await reservationOf(job.id);
      expect(before.state).toBe("CONSUMED");
      const eventsBefore = (await reservationEvents(before.id)).length;

      const applied = await createReconciliationRepository(prisma).withReconcilingAttempt(
        { organizationId: ORG_A, attemptId },
        async (session) => {
          const facts = await session.loadFacts();
          if (facts === null) throw new Error("expected facts");
          return session.apply({
            expectedVersion: facts.attempt.stateVersion,
            write: ACCEPTED_WRITE,
            reservationEventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
            context: ctx(),
          });
        },
      );
      expect(applied.kind).toBe("APPLIED");

      // The attempt moved; the spent unit did not.
      expect((await attemptRow(attemptId)).orchestrationState).toBe("PROCESSING");
      const after = await reservationOf(job.id);
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      // No move, so no reservation event claiming one happened.
      expect(await reservationEvents(before.id)).toHaveLength(eventsBefore);
    });

    it("refuses a cross-tenant apply made without ever reading the facts", async () => {
      // The mutation boundary must enforce tenancy by itself. `apply` is
      // reachable without `loadFacts`, and the tenant-scoped read was the only
      // other place the organization was checked — so a caller holding a
      // session for its own organization could name another tenant's attempt
      // id, mutate that row, and append an event labelled with its own org.
      //
      // Nothing here calls `loadFacts`. The version is read out of band, which
      // is precisely what an attacker who knows an id would do.
      const { attemptId, job } = await seedReconcilingAttempt("crosstenantapply");
      const before = await attemptRow(attemptId);
      const reservationBefore = await reservationOf(job.id);
      const eventsBefore = (await eventsFor(attemptId)).length;
      const reservationEventsBefore = (await reservationEvents(reservationBefore.id)).length;

      const applied = await createReconciliationRepository(prisma).withReconcilingAttempt(
        // Org B, attempt A.
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.apply({
            expectedVersion: before.stateVersion,
            write: ACCEPTED_WRITE,
            reservationEventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });

      // The attempt is untouched.
      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(after.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
      expect(after.providerPredictionId).toBeNull();
      expect(after.providerAcceptedAt).toBeNull();
      expect(after.reconciliationResolvedAt).toBeNull();

      // The entitlement is untouched.
      const reservationAfter = await reservationOf(job.id);
      expect(reservationAfter.state).toBe("RECONCILIATION_HOLD");
      expect(reservationAfter.stateVersion).toBe(reservationBefore.stateVersion);

      // No event was appended under either organization.
      expect(await eventsFor(attemptId)).toHaveLength(eventsBefore);
      expect(await reservationEvents(reservationBefore.id)).toHaveLength(
        reservationEventsBefore,
      );
      expect(await eventsFor(attemptId, ORG_B)).toHaveLength(0);
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("refuses a cross-tenant exhaustion apply the same way", async () => {
      const { attemptId, job } = await seedReconcilingAttempt("crosstenantexh");
      const before = await attemptRow(attemptId);

      const applied = await createReconciliationRepository(prisma).withReconcilingAttempt(
        { organizationId: ORG_B, attemptId },
        async (session) =>
          session.apply({
            expectedVersion: before.stateVersion,
            write: {
              orchestrationState: "RECONCILIATION_EXHAUSTED",
              submissionCertainty: "SUBMISSION_UNKNOWN",
              providerPredictionId: null,
              providerAcceptedAt: null,
              reconciliationResolvedAt: null,
              decisionAt: AFTER,
              reservationAction: "RELEASE",
            },
            reservationEventType: RECONCILIATION_HOLD_RELEASED_EVENT_TYPE,
            context: ctx(),
          }),
      );
      expect(applied).toEqual({ kind: "LOST" });
      expect((await attemptRow(attemptId)).orchestrationState).toBe("RECONCILIATION_PENDING");
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("refuses a write when the denormalized project disagrees with the chain", async () => {
      // The attempt carries a denormalized `videoProjectId` *and* hangs off a
      // Request → Scene → Job → VideoProject chain. Every read in this phase
      // traverses the chain; the standard attempt repository scopes on the
      // column. If the two ever disagree — a bad backfill, a partial restore, a
      // manual edit — trusting either alone lets one organization write a row
      // the other owns. The CAS requires both, so a row like this is frozen
      // rather than writable by whichever tenant the corruption favours.
      const { attemptId, job } = await seedReconcilingAttempt("splitowner");
      const before = await attemptRow(attemptId);
      await prisma.$executeRaw`
        UPDATE "scene_generations"
           SET "videoProjectId" = ${PROJECT_B}
         WHERE "id" = ${attemptId}
      `;

      const repo = createReconciliationRepository(prisma);
      const attempt = (organizationId: string) =>
        repo.withReconcilingAttempt({ organizationId, attemptId }, async (session) =>
          session.apply({
            expectedVersion: before.stateVersion,
            write: ACCEPTED_WRITE,
            reservationEventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
            context: ctx(),
          }),
        );

      // The chain still says org A; the column now says org B. Neither may
      // write, because neither can prove sole ownership.
      expect(await attempt(ORG_A)).toEqual({ kind: "LOST" });
      expect(await attempt(ORG_B)).toEqual({ kind: "LOST" });

      const after = await attemptRow(attemptId);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
      expect(
        await prisma.generationTransitionEvent.findMany({ where: { organizationId: ORG_B } }),
      ).toHaveLength(0);
    });

    it("refuses a write onto a row someone moved out of band", async () => {
      // The version predicate alone is not enough. Every writer in the codebase
      // bumps `stateVersion`, but an operator running a manual UPDATE does not
      // — and the state predicate is what stops a conclusion landing on top of
      // a row that is no longer reconciling at all.
      const { attemptId, job } = await seedReconcilingAttempt("guardstate");

      const applied = await createReconciliationRepository(prisma).withReconcilingAttempt(
        { organizationId: ORG_A, attemptId },
        async (session) => {
          const facts = await session.loadFacts();
          if (facts === null) throw new Error("expected facts");
          // A manual edit that leaves the version untouched, committed on
          // another connection before the compare-and-set runs.
          await other.$executeRaw`
            UPDATE "scene_generations"
               SET "orchestrationState" = 'RECONCILIATION_EXHAUSTED'::"GenerationAttemptState"
             WHERE "id" = ${attemptId}
          `;
          return session.apply({
            expectedVersion: facts.attempt.stateVersion,
            write: ACCEPTED_WRITE,
            reservationEventType: RECONCILIATION_HOLD_RESTORED_EVENT_TYPE,
            context: ctx(),
          });
        },
      );
      expect(applied).toEqual({ kind: "LOST" });

      const row = await attemptRow(attemptId);
      expect(row.orchestrationState).toBe("RECONCILIATION_EXHAUSTED");
      expect(row.providerPredictionId).toBeNull();
      // And the entitlement was not moved on the strength of the refused write.
      expect((await reservationOf(job.id)).state).toBe("RECONCILIATION_HOLD");
    });
  });
});
