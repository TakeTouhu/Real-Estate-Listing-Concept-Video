import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  createFixedAuthorizationClock,
  createPaidSubmissionAuthorizationService,
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE,
  ROUTING_POLICY_VERSION,
  yen,
  type AuthorizationClock,
  type BillingCycleRevenueReader,
  type FxSnapshot,
  type PricingSnapshot,
  type Yen,
} from "@app/domain";
import { createPaidSubmissionAuthorizationRepository } from "@app/database";
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
 * The paid submission gate against live PostgreSQL.
 *
 * Everything here ends at `SUBMITTING`. No provider is constructed, no HTTP
 * client exists in the service's dependencies, and nothing consumes the
 * authorization it returns — which is the whole shape of this dormant phase.
 */

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A second pool, so a lock held on one connection genuinely blocks the other. */
const other = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
/** A third pool, used only to hold a lock while the other two contend for it. */
const blocker = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

const AT = epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z"));

/**
 * Planning cost in yen for the fixture's two scene lengths.
 *
 * OpenVideo bills $0.06/second; NORMAL_AI adds a 30% risk buffer; the fixture
 * FX rate is ¥150/USD. 5s → $0.39 → ¥58.5, rounded half away from zero to ¥59;
 * 20s → $1.56 → ¥234 exactly. Written out because several tests need revenue
 * tight enough to discriminate, and a generous round number would make them
 * pass against an implementation that counted the wrong things.
 */
const FIVE_SECOND_YEN = 59;
const TWENTY_SECOND_YEN = 234;
const CYCLE = "2026-09";
const FX_ID = "fx_paidgate";

/** ¥150 per USD, as an exact integer fraction. */
const FX: FxSnapshot = {
  id: FX_ID,
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-01T00:00:00.000Z")),
  sourceReference: "itest",
};

/** The billing-cycle revenue reader standing in for a layer that does not exist. */
function revenueReader(cycleYen: Yen | null): BillingCycleRevenueReader {
  return {
    async revenueYen() {
      return cycleYen;
    },
  };
}

function service(
  client: PrismaClient,
  cycleYen: Yen | null = yen(49_800),
  clock: AuthorizationClock = createFixedAuthorizationClock(AT),
) {
  return createPaidSubmissionAuthorizationService({
    authorization: createPaidSubmissionAuthorizationRepository(client),
    billingCycleRevenue: revenueReader(cycleYen),
    clock,
  });
}

/** The OpenVideo snapshot, priced in USD and convertible through `FX`. */
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
 * A complete NORMAL-tier chain whose route is authorized.
 *
 * The shared orchestration fixture builds HIGH_QUALITY jobs, which have no
 * authorized route by design — so this seeds its own, on the WaveSpeed
 * OpenVideo route that does.
 */
async function seedAuthorizableChain(
  client: PrismaClient,
  suffix: string,
  options: {
    readonly organizationId?: string;
    readonly videoProjectId?: string;
    readonly seconds?: number;
    readonly reserve?: boolean;
  } = {},
) {
  const organizationId = options.organizationId ?? ORG_A;
  const videoProjectId = options.videoProjectId ?? PROJECT_A;
  const seconds = options.seconds ?? 5;
  const repos = repositories(client);

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
  if (created.kind !== "CREATED") throw new Error(`job not created: ${created.kind}`);

  if (options.reserve !== false) {
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
    if (reserved.kind !== "RESERVED") throw new Error(`expected RESERVED: ${reserved.kind}`);
  }

  const scene = await repos.scenes.create(
    organizationId,
    {
      id: `genscene_${suffix}`,
      generationJobId: created.job.id,
      position: 0,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: ASSET_A,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: seconds,
      snapshotCameraMotion: "SLOW_PAN",
      // Distinct per chain: the request hash is derived from the scene's facts,
      // and two identical chains would collide on the active-request identity
      // index rather than exercising the gate.
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
      pricingSnapshot: snapshotFor(seconds),
      fxSnapshot: FX,
    },
    ctx(),
  );
  if (admitted.kind !== "ADMITTED") throw new Error(`attempt not admitted: ${admitted.kind}`);

  return { job: created.job, scene, request, attempt: admitted.attempt };
}

async function authorize(
  client: PrismaClient,
  attemptId: string,
  organizationId = ORG_A,
  cycleYen: Yen | null = yen(49_800),
  clock: AuthorizationClock = createFixedAuthorizationClock(AT),
) {
  return service(client, cycleYen, clock).authorize({
    organizationId,
    attemptId,
    // Deliberately a label the service must overwrite: the event type on a paid
    // authorization is not the caller's to choose.
    context: ctx({ eventType: "CALLER_CHOSEN" }),
  });
}

/** Resolves when `promise` settles; never rejects. Used to prove blocking. */
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

describe.skipIf(!HAS_DB)("the paid submission authorization gate", () => {
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

  describe("the authorized path", () => {
    it("arms the boundary and reports the committed version", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "ok");
      const outcome = await authorize(prisma, attempt.id);
      if (outcome.kind !== "AUTHORIZED") {
        throw new Error(`expected AUTHORIZED, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.attemptId).toBe(attempt.id);
      // The version reported is the one the database committed, not one the
      // gate predicted.
      expect(outcome.armedStateVersion).toBe(attempt.stateVersion + 1);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
      expect(row.submissionBoundaryEnteredAt).not.toBeNull();
      // And nothing past the boundary: this phase ends here.
      expect(row.providerPredictionId).toBeNull();
      expect(row.submissionCertainty).toBe("PRE_SUBMISSION");
    });

    it("writes the QUEUED → SUBMITTING transition event as the boundary record", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "evt");
      await authorize(prisma, attempt.id);
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      expect(history.map((e) => [e.fromState, e.toState])).toEqual([
        [null, "QUEUED"],
        ["QUEUED", "SUBMITTING"],
      ]);
      // The existing mechanism, not a second audit table — and the label is the
      // service's, not the caller's: `authorize` deliberately passes
      // `CALLER_CHOSEN` and it does not survive.
      expect(history[1]?.eventType).toBe(PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE);
      expect(history[1]?.eventType).not.toBe("CALLER_CHOSEN");
    });

    it("does not consume the customer's reservation", async () => {
      // Consumption happens at DELIVERABLE_READY, in a much later phase. A gate
      // that spent units on authorization would charge for work that has not
      // even been submitted.
      const { attempt, job } = await seedAuthorizableChain(prisma, "noconsume");
      const before = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: job.id },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome.kind).toBe("AUTHORIZED");

      const after = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: job.id },
      });
      expect(after.state).toBe("RESERVED");
      expect(after.consumedAt).toBeNull();
      expect(after.releasedAt).toBeNull();
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.reservedTotalVideoUnits).toBe(before.reservedTotalVideoUnits);
      expect(after.reservedHighQualityUnits).toBe(before.reservedHighQualityUnits);
    });
  });

  describe("post-delivery user regeneration", () => {
    /**
     * The correction this block exists for.
     *
     * A customer's regeneration right is sold with the original video. By the
     * time they use it, the original has been delivered and the reservation is
     * `CONSUMED` — that is the *expected* state, not a corruption — and the
     * regeneration consumes no further customer unit because its provider cost
     * is internal. Refusing every `CONSUMED` reservation denies work that has
     * already been paid for.
     *
     * `RESERVED → CONSUMED` is a reserved edge (Transaction G, unimplemented),
     * so the delivered world is constructed directly here rather than through a
     * transition that does not exist yet.
     */
    async function consumeReservation(jobId: string): Promise<void> {
      await prisma.generationReservation.updateMany({
        where: { generationJobId: jobId },
        data: { state: "CONSUMED", consumedAt: new Date() },
      });
    }

    async function regenerationAttempt(
      suffix: string,
      chain: Awaited<ReturnType<typeof seedAuthorizableChain>>,
    ) {
      const repos = repositories(prisma);
      // The delivered world this regeneration exists in. The original request
      // is DELIVERED and its attempt SUCCEEDED — which also releases the
      // active-request identity, exactly as it would in production: the
      // partial unique index holds `(videoProjectId, requestHash)` only while
      // an attempt is still live, so a regeneration after delivery is admitted
      // and a duplicate submission during one is not.
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.request.id },
        data: { state: "DELIVERED", deliveredAt: new Date() },
      });
      await prisma.sceneGeneration.update({
        where: { id: chain.attempt.id },
        data: {
          state: "SUCCEEDED",
          orchestrationState: "OUTPUT_VERIFIED",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: `pred_${suffix}_original`,
          providerAcceptedAt: new Date(),
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      const regen = await repos.requests.admitUserRegeneration(
        ORG_A,
        {
          id: `genreq_${suffix}`,
          generationSceneId: chain.scene.id,
          requestedByUserId: "usr_itest",
        },
        ctx(),
      );
      if (regen.kind !== "ADMITTED") throw new Error(`regeneration: ${regen.kind}`);

      const admitted = await repos.attempts.admit(
        ORG_A,
        {
          id: `sgen_${suffix}`,
          generationSceneRequestId: regen.request.id,
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
      return { request: regen.request, attempt: admitted.attempt };
    }

    /**
     * A second attempt on a request, which the repository derives as
     * `SYSTEM_RECOVERY`.
     *
     * The kind is not a caller input — it is computed from the attempts that
     * already exist — so a recovery attempt is produced by failing the first one
     * and admitting another, exactly as a real retry would.
     */
    async function systemRecoveryAttempt(suffix: string, requestId: string, firstId: string) {
      await prisma.sceneGeneration.update({
        where: { id: firstId },
        data: {
          state: "FAILED_TERMINAL",
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          // A certainty other than PRE_SUBMISSION means the boundary was
          // crossed, and a database CHECK enforces that pairing.
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      const admitted = await repositories(prisma).attempts.admit(
        ORG_A,
        {
          id: `sgen_${suffix}`,
          generationSceneRequestId: requestId,
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
      if (admitted.kind !== "ADMITTED") throw new Error(`recovery attempt: ${admitted.kind}`);
      return admitted.attempt;
    }

    it("authorizes a regeneration against a CONSUMED reservation", async () => {
      const chain = await seedAuthorizableChain(prisma, "regenok");
      const regen = await regenerationAttempt("regenok2", chain);
      await consumeReservation(chain.job.id);

      const outcome = await authorize(prisma, regen.attempt.id);
      if (outcome.kind !== "AUTHORIZED") {
        throw new Error(`expected AUTHORIZED, got ${JSON.stringify(outcome)}`);
      }
      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: regen.attempt.id },
      });
      expect(row.orchestrationState).toBe("SUBMITTING");
    });

    it("consumes no further customer unit and creates no second reservation", async () => {
      // The provider cost of a regeneration is internal. If authorizing one
      // moved a customer's units — or minted a new hold to move — the customer
      // would be charged twice for a right they bought once.
      const chain = await seedAuthorizableChain(prisma, "regennc");
      const regen = await regenerationAttempt("regennc2", chain);
      await consumeReservation(chain.job.id);

      const before = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: chain.job.id },
      });
      const countBefore = await prisma.generationReservation.count({
        where: { generationJobId: chain.job.id },
      });

      expect((await authorize(prisma, regen.attempt.id)).kind).toBe("AUTHORIZED");

      const after = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: chain.job.id },
      });
      expect(after.state).toBe("CONSUMED");
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.reservedTotalVideoUnits).toBe(before.reservedTotalVideoUnits);
      expect(after.reservedHighQualityUnits).toBe(before.reservedHighQualityUnits);
      expect(
        await prisma.generationReservation.count({ where: { generationJobId: chain.job.id } }),
      ).toBe(countBefore);
    });

    it("refuses an INITIAL request against a CONSUMED reservation", async () => {
      // The other half of the rule. Units already spent on a delivered video
      // cannot fund a fresh rendition nobody paid for.
      const chain = await seedAuthorizableChain(prisma, "initcons");
      await consumeReservation(chain.job.id);
      const outcome = await authorize(prisma, chain.attempt.id);
      expect(outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_CONSUMED",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: chain.attempt.id },
      });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("authorizes a SYSTEM_RECOVERY attempt under a regeneration request", async () => {
      // A platform retry inherits the parent request's reservation semantics.
      // It is not a second customer regeneration and must not be judged as one.
      const chain = await seedAuthorizableChain(prisma, "sysrec");
      const regen = await regenerationAttempt("sysrec2", chain);
      const recovery = await systemRecoveryAttempt(
        "sysrec3",
        regen.request.id,
        regen.attempt.id,
      );
      expect(recovery.attemptKind).toBe("SYSTEM_RECOVERY");
      await consumeReservation(chain.job.id);

      const outcome = await authorize(prisma, recovery.id);
      expect(outcome.kind).toBe("AUTHORIZED");
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: recovery.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
    });

    it("still refuses a regeneration whose reservation was released", async () => {
      // The exemption is narrow: `CONSUMED` and nothing else. A released hold
      // means the entitlement itself is gone, and a regeneration right cannot
      // outlive the entitlement it was sold with.
      const chain = await seedAuthorizableChain(prisma, "regenrel");
      const regen = await regenerationAttempt("regenrel2", chain);
      await prisma.generationReservation.updateMany({
        where: { generationJobId: chain.job.id },
        data: { state: "RELEASED", releasedAt: new Date() },
      });
      expect(await authorize(prisma, regen.attempt.id)).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_RELEASED",
      });
    });
  });

  describe("refusals leave the attempt exactly as it was", () => {
    it("does not move an attempt the guard hard-pauses", async () => {
      // ¥49,800 revenue against a projected profit below the ¥15,000 floor.
      const { attempt } = await seedAuthorizableChain(prisma, "hp");
      const outcome = await authorize(prisma, attempt.id, ORG_A, yen(1_000));
      expect(outcome.kind).toBe("SAFETY_GUARD_HARD_PAUSE");

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
      expect(row.submissionBoundaryEnteredAt).toBeNull();
      expect(row.stateVersion).toBe(attempt.stateVersion);
    });

    it("writes no transition history for a state change that did not happen", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "nohist");
      await authorize(prisma, attempt.id, ORG_A, yen(1_000));
      const history = await repositories(prisma).events.listForAggregate(
        ORG_A,
        "ATTEMPT",
        attempt.id,
      );
      // Only the admission event. A refusal discovered nothing about the
      // provider, so claiming an execution-state transition would be fiction.
      expect(history.map((e) => e.toState)).toEqual(["QUEUED"]);
    });

    it("refuses without an authoritative billing-cycle revenue", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "norev");
      const outcome = await authorize(prisma, attempt.id, ORG_A, null);
      expect(outcome).toMatchObject({
        kind: "SAFETY_GUARD_HARD_PAUSE",
        reason: "BILLING_CYCLE_REVENUE_UNAVAILABLE",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses an attempt whose job has no reservation", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "nores", { reserve: false });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_MISSING",
      });
    });

    it.each([["RELEASED"], ["CONSUMED"], ["RECONCILIATION_HOLD"]] as const)(
      "refuses against a %s reservation",
      async (state) => {
        const { attempt, job } = await seedAuthorizableChain(prisma, `res${state}`);
        await prisma.generationReservation.updateMany({
          where: { generationJobId: job.id },
          data: { state },
        });
        const outcome = await authorize(prisma, attempt.id);
        expect(outcome.kind).toBe("RESERVATION_INVALID");
        const row = await prisma.sceneGeneration.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        expect(row.orchestrationState).toBe("QUEUED");
      },
    );

    it("refuses an attempt whose submission is unknown, and never re-arms it", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "unknown");
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: {
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          submissionBoundaryEnteredAt: new Date(),
          reconciliationStartedAt: new Date(),
          reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_SUBMISSION_UNCERTAIN",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      // Not reset to QUEUED, not re-armed, not touched.
      expect(row.orchestrationState).toBe("RECONCILIATION_PENDING");
      expect(row.submissionCertainty).toBe("SUBMISSION_UNKNOWN");
    });

    it("refuses a stale SUBMITTING rather than retrying it", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "stale");
      await prisma.sceneGeneration.update({
        where: { id: attempt.id },
        data: {
          orchestrationState: "SUBMITTING",
          submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "ATTEMPT_NOT_ARMABLE",
        reason: "ATTEMPT_ALREADY_SUBMITTED",
      });
    });
  });

  describe("persisted pricing corruption", () => {
    it("refuses when the snapshot's risk profile no longer matches the job's tier", async () => {
      // Admission bound these together and the provider boundary re-checks them;
      // this is the row being corrupted in between. A HIGH_QUALITY_AI buffer on
      // a NORMAL job over-plans by twenty points, and the reverse under-plans —
      // either way the cost decision no longer describes this attempt.
      const { attempt } = await seedAuthorizableChain(prisma, "riskprof");
      await prisma.generationPricingSnapshot.updateMany({
        where: { sceneGenerationId: attempt.id },
        data: { riskProfileKey: "HIGH_QUALITY_AI" },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_BINDING_INVALID",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses when the snapshot names a different provider", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "provmis");
      await prisma.generationPricingSnapshot.updateMany({
        where: { sceneGenerationId: attempt.id },
        data: { provider: "fal" },
      });
      const outcome = await authorize(prisma, attempt.id);
      expect(outcome).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_BINDING_INVALID",
      });
    });
  });

  describe("tenant isolation", () => {
    it("answers a cross-tenant attempt exactly as it answers a missing one", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tenant");
      const crossTenant = await authorize(prisma, attempt.id, ORG_B);
      const missing = await authorize(prisma, "sgen_does_not_exist", ORG_B);
      expect(crossTenant).toEqual({ kind: "ATTEMPT_NOT_FOUND" });
      expect(crossTenant).toEqual(missing);

      // And it did not move.
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("never counts another tenant's exposure", async () => {
      // Organization B carries in-flight exposure that would hard-pause
      // organization A *if it were counted*. The revenue is deliberately tight:
      // with a generous cycle this test would pass against an implementation
      // that aggregated every tenant into one number, and prove nothing.
      const b = await seedAuthorizableChain(prisma, "expB", {
        organizationId: ORG_B,
        videoProjectId: PROJECT_B,
        seconds: 20,
      });
      await prisma.sceneGeneration.update({
        where: { id: b.attempt.id },
        data: { orchestrationState: "PROCESSING", submissionBoundaryEnteredAt: new Date() },
      });

      const a = await seedAuthorizableChain(prisma, "expA");
      // A's own 5s attempt is ¥58; B's 20s attempt is ¥234. Revenue leaves
      // ¥117 of headroom above the ¥15,000 floor after A's own cost — enough
      // for A alone, and not enough if B's exposure were included.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      const outcome = await authorize(prisma, a.attempt.id, ORG_A, revenue);
      expect(outcome.kind).toBe("AUTHORIZED");
    });
  });

  describe("exposure aggregation", () => {
    it("counts an uncertain sibling's planning cost against the guard", async () => {
      // A ¥1,000,000 cycle would comfortably absorb one attempt. A sibling in
      // RECONCILIATION_PENDING at a 20-second planning cost must still count:
      // it may already have been billed.
      const sibling = await seedAuthorizableChain(prisma, "uncsib", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "RECONCILIATION_PENDING",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          submissionBoundaryEnteredAt: new Date(),
          reconciliationStartedAt: new Date(),
          reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      });

      const candidate = await seedAuthorizableChain(prisma, "unccand");
      // Revenue chosen so the candidate alone passes and the pair does not.
      const siblingCost = 20 * 60_000 * 1.3; // micro-USD, +30% NORMAL_AI buffer
      const siblingYen = Math.floor((siblingCost / 1_000_000) * 150);
      const revenue = yen(15_000 + siblingYen - 100);

      const withSibling = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      expect(withSibling.kind).toBe("SAFETY_GUARD_HARD_PAUSE");

      // Resolve the sibling; the same candidate now fits.
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionCertainty: "DEFINITIVELY_REJECTED" },
      });
      const without = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      expect(without.kind).toBe("AUTHORIZED");
    });

    it("does not count a sibling from another billing cycle", async () => {
      const sibling = await seedAuthorizableChain(prisma, "cyclesib", { seconds: 20 });
      await prisma.generationReservation.updateMany({
        where: { generationJobId: sibling.job.id },
        data: { billingCycleKey: "2026-08" },
      });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: { orchestrationState: "PROCESSING", submissionBoundaryEnteredAt: new Date() },
      });

      const candidate = await seedAuthorizableChain(prisma, "cyclecand");
      // Tight for the same reason as the cross-tenant case: with a generous
      // cycle the sibling's ¥234 would disappear into the headroom and the test
      // would pass whether or not the cycle scope existed.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      const outcome = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      // Last month's exposure must not block this month's work.
      expect(outcome.kind).toBe("AUTHORIZED");
    });
  });

  describe("exposure by state and submission certainty", () => {
    /**
     * Whether a sibling's provider cost survives in the guard.
     *
     * Each case seeds a 20-second sibling in one (state, certainty) pair and
     * asks the same question with revenue tight enough that ¥234 decides it.
     * `counted: true` means the pair must hard-pause the candidate; `false`
     * means it must not. A generous cycle would pass either way, which is how
     * the earlier version of this suite missed the states below entirely.
     */
    async function exposesCost(
      suffix: string,
      state: string,
      certainty: string,
    ): Promise<boolean> {
      const sibling = await seedAuthorizableChain(prisma, `${suffix}s`, { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: state as never,
          submissionCertainty: certainty as never,
          submissionBoundaryEnteredAt: new Date(),
          // A database CHECK requires a provider reference whenever the
          // provider accepted the work, and reconciliation timestamps whenever
          // an attempt is reconciling. Satisfying them here keeps the fixture a
          // state the system could actually reach.
          ...(certainty === "ACCEPTED"
            ? { providerPredictionId: `pred_${suffix}`, providerAcceptedAt: new Date() }
            : {}),
          ...(state === "RECONCILIATION_PENDING"
            ? {
                reconciliationStartedAt: new Date(),
                reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
              }
            : {}),
        },
      });
      const candidate = await seedAuthorizableChain(prisma, `${suffix}c`);
      // Just enough headroom for the candidate alone. The sibling's ¥234 is the
      // difference between authorizing and hard-pausing.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      const outcome = await authorize(prisma, candidate.attempt.id, ORG_A, revenue);
      return outcome.kind === "SAFETY_GUARD_HARD_PAUSE";
    }

    it("counts an unresolved reconciliation", async () => {
      expect(await exposesCost("uncr", "RECONCILIATION_PENDING", "SUBMISSION_UNKNOWN")).toBe(
        true,
      );
    });

    it("still counts a reconciliation that ran out of ways to find out", async () => {
      // The window closing resolves the customer's entitlement and nothing
      // about what the provider charged. Zeroing it here would let giving up
      // look like a refund, and would understate every cycle with an incident.
      expect(await exposesCost("exha", "RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN")).toBe(
        true,
      );
    });

    it("counts an accepted attempt whose output was verified", async () => {
      // Its execution lifecycle finished; the money did not come back.
      expect(await exposesCost("outv", "OUTPUT_VERIFIED", "ACCEPTED")).toBe(true);
    });

    it("counts an accepted attempt that failed terminally", async () => {
      expect(await exposesCost("ftac", "FAILED_TERMINAL", "ACCEPTED")).toBe(true);
    });

    it("counts an accepted attempt that failed retryably", async () => {
      expect(await exposesCost("frac", "FAILED_RETRYABLE", "ACCEPTED")).toBe(true);
    });

    it("counts nothing for a definitively rejected attempt", async () => {
      // The provider refused the submission. There is nothing to bill, and this
      // is the one certainty strong enough to say so.
      expect(await exposesCost("rejd", "FAILED_TERMINAL", "DEFINITIVELY_REJECTED")).toBe(false);
    });

    it("counts nothing for an attempt cancelled before the boundary", async () => {
      expect(await exposesCost("canc", "CANCELLED_PRE_SUBMISSION", "PRE_SUBMISSION")).toBe(
        false,
      );
    });

    it("counts nothing for a sibling still queued", async () => {
      expect(await exposesCost("qued", "QUEUED", "PRE_SUBMISSION")).toBe(false);
    });
  });

  describe("persisted pricing integrity", () => {
    it("refuses a tampered planning cost while every binding field agrees", async () => {
      // Provider, model key, contract key and risk profile are untouched, so
      // nothing that checks bindings notices. The number that decides how much
      // Safety Guard headroom this attempt consumes has been rewritten to
      // almost nothing, and only re-deriving the snapshot catches it.
      const { attempt } = await seedAuthorizableChain(prisma, "tamper");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { estimatedPlanningCostMicroUsd: 1n },
      });
      expect(await authorize(prisma, attempt.id)).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses a tampered stable cost", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tampst");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { estimatedStableCostMicroUsd: 7n },
      });
      expect(await authorize(prisma, attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
    });

    it("refuses tampered billable seconds", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tampbs");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { billableSeconds: 99 },
      });
      expect(await authorize(prisma, attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
    });

    it("refuses a tampered risk buffer", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tamprb");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { riskBufferBps: 1 },
      });
      expect(await authorize(prisma, attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
    });

    it("refuses a moved pricing instant", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tampat");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { pricingEffectiveAtEpochMs: 0n },
      });
      expect(await authorize(prisma, attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
    });

    it("refuses a tampered stable price reference", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "tampsp");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: {
          stablePriceReferenceJson: { kind: "PER_SECOND", unitPriceMicroUsdPerSecond: 1 },
        },
      });
      expect(await authorize(prisma, attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_SNAPSHOT_NOT_REPRODUCIBLE",
      });
    });

    it("refuses a same-identity contract with a different fingerprint", async () => {
      // The identity resolves perfectly and the commercial content underneath
      // it has changed. Resolving by identity and calling it the same contract
      // is a guess; the fingerprint is what makes it a check.
      const { attempt } = await seedAuthorizableChain(prisma, "fprint");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { contractFingerprint: "some-other-contract" },
      });
      expect(await authorize(prisma, attempt.id)).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_CONTRACT_FINGERPRINT_MISMATCH",
      });
    });

    it("fails closed on a persisted amount too large to represent exactly", async () => {
      // `Number(bigint)` would narrow this into a plausible-looking figure, and
      // `microUsd()` would throw `PricingArithmeticError` out of an ordinary
      // authorization — a 500 rather than a refusal, skipping every audit path.
      const { attempt } = await seedAuthorizableChain(prisma, "bigint");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: attempt.id },
        data: { estimatedPlanningCostMicroUsd: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      });
      expect(await authorize(prisma, attempt.id)).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_AMOUNT_UNREPRESENTABLE",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("fails closed on an unrepresentable amount in another attempt's exposure", async () => {
      // The candidate's own snapshot is fine; a sibling's is not. Skipping the
      // sibling would authorize against a cycle total known to be short.
      const sibling = await seedAuthorizableChain(prisma, "bigsib", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "PROCESSING",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_bigsib",
          providerAcceptedAt: new Date(),
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { estimatedPlanningCostMicroUsd: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      });
      const candidate = await seedAuthorizableChain(prisma, "bigcand");
      expect(await authorize(prisma, candidate.attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
      });
    });
  });

  describe("the durable authorization record", () => {
    /** Read back through a connection that shares nothing with the writer. */
    async function reloadBoundaryEvent(attemptId: string) {
      const events = await other.generationTransitionEvent.findMany({
        where: { aggregateType: "ATTEMPT", aggregateId: attemptId, toState: "SUBMITTING" },
      });
      expect(events).toHaveLength(1);
      return events[0]!;
    }

    it("reconstructs a SAFE authorization from persistence alone", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "auditsafe");
      expect((await authorize(prisma, attempt.id)).kind).toBe("AUTHORIZED");

      const event = await reloadBoundaryEvent(attempt.id);
      expect(event.eventType).toBe(PAID_SUBMISSION_AUTHORIZED_EVENT_TYPE);
      expect(event.fromState).toBe("QUEUED");
      expect(event.safeMetadata).toMatchObject({
        authorizationPolicyVersion: AUTHORIZATION_POLICY_VERSION,
        routingPolicyVersion: ROUTING_POLICY_VERSION,
        safetyGuardState: "SAFE",
        billingCycleKey: CYCLE,
        billingCycleRevenueYen: 49_800,
        knownActualCostYen: 0,
        settledEstimatedCostYen: 0,
        uncertainCostYen: 0,
        inFlightCostYen: 0,
        nextProjectedCostYen: FIVE_SECOND_YEN,
        projectedContributionProfitYen: 49_800 - FIVE_SECOND_YEN,
        warningFloorYen: 20_000,
        hardPauseFloorYen: 15_000,
      });
      expect((event.safeMetadata as Record<string, unknown>).pricingSnapshotId).toBe(
        `price_sgen_auditsafe`,
      );
    });

    it("reconstructs a WARNING authorization from persistence alone", async () => {
      // The correction this test exists for: a warning that lives only in the
      // returned object is gone the moment the process handling the call dies,
      // and the boundary was still crossed. Nothing here reads a return value.
      const sibling = await seedAuthorizableChain(prisma, "warnsib", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "RECONCILIATION_EXHAUSTED",
          submissionCertainty: "SUBMISSION_UNKNOWN",
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      const candidate = await seedAuthorizableChain(prisma, "warncand");
      // Profit lands between the ¥15,000 hard floor and the ¥20,000 warning
      // floor once both the sibling and the candidate are counted.
      const revenue = yen(19_900 + TWENTY_SECOND_YEN + FIVE_SECOND_YEN);
      expect((await authorize(prisma, candidate.attempt.id, ORG_A, revenue)).kind).toBe(
        "AUTHORIZED",
      );

      const event = await reloadBoundaryEvent(candidate.attempt.id);
      const metadata = event.safeMetadata as Record<string, unknown>;
      expect(metadata).toMatchObject({
        safetyGuardState: "WARNING",
        billingCycleRevenueYen: revenue,
        // The exhausted reconciliation is in the record as uncertain exposure,
        // which is also what made the guard warn.
        uncertainCostYen: TWENTY_SECOND_YEN,
        settledEstimatedCostYen: 0,
        nextProjectedCostYen: FIVE_SECOND_YEN,
        projectedContributionProfitYen: 19_900,
        hardPauseFloorYen: 15_000,
        warningFloorYen: 20_000,
      });
    });

    it("writes no prompt, provider payload or credential into the record", async () => {
      // Transition history is the most widely pasted table in an incident. The
      // allowlist is what keeps a customer's prompt out of it, and this is the
      // check that the authorization record did not smuggle one past.
      const { attempt } = await seedAuthorizableChain(prisma, "auditsafe2");
      await authorize(prisma, attempt.id);
      const event = await reloadBoundaryEvent(attempt.id);
      const keys = Object.keys(event.safeMetadata as Record<string, unknown>);
      for (const forbidden of [
        "compiledPrompt",
        "renderedPrompt",
        "prompt",
        "providerRequest",
        "providerResponse",
        "apiKey",
        "signedUrl",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  describe("the reservation row lock", () => {
    /**
     * The race the cost-admission lock alone does not close.
     *
     * That lock orders two *authorizations* against one billing cycle. It says
     * nothing about a third party changing the reservation those
     * authorizations depend on, so without a row lock this is legal:
     *
     * ```text
     * T1  lock cycle → read reservation RESERVED → gate permits
     * T2                UPDATE reservation → RELEASED, commit
     * T1  arm QUEUED → SUBMITTING, commit
     * ```
     *
     * The paid boundary is crossed after the hold that authorized it stopped
     * authorizing it, and nothing later can undo that: the provider may already
     * have been paid.
     *
     * Each test below holds the reservation UPDATE open in a second connection,
     * starts an authorization, and asserts it is *still blocked* — that is what
     * makes it a proof rather than a hopeful race. Removing the row lock makes
     * both fail.
     */
    async function raceReservationInto(
      suffix: string,
      nextState: "RELEASED" | "RECONCILIATION_HOLD",
    ) {
      const chain = await seedAuthorizableChain(prisma, suffix);

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = other.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "generation_reservations"
               SET "state" = ${nextState}::"GenerationReservationState",
                   "stateVersion" = "stateVersion" + 1,
                   "releasedAt" = CASE WHEN ${nextState} = 'RELEASED'
                                       THEN NOW() ELSE "releasedAt" END
             WHERE "generationJobId" = ${chain.job.id}
          `;
          await held;
        },
        { timeout: 20_000 },
      );

      // `finally` rather than a bare call: a failed assertion must still let
      // the writer commit. A test that leaves a transaction holding this row
      // blocks every later test's cleanup on the same table, which turns one
      // failure into a suite that appears to hang.
      let stillBlocked: boolean;
      try {
        await breathe(4);
        const blocked = settled(authorize(prisma, chain.attempt.id));
        await breathe();
        stillBlocked = !blocked.done();
        release();
        await writer;
        // Asserted after the release so the diagnosis is a plain failure.
        expect(stillBlocked).toBe(true);
        return { chain, outcome: await blocked.value };
      } finally {
        release();
      }
    }

    it("refuses when a concurrent release commits first", async () => {
      const { chain, outcome } = await raceReservationInto("racerel", "RELEASED");
      expect(outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_RELEASED",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: chain.attempt.id },
      });
      expect(row.orchestrationState).toBe("QUEUED");
      expect(row.submissionBoundaryEnteredAt).toBeNull();
    });

    it("refuses when a concurrent reconciliation hold commits first", async () => {
      const { chain, outcome } = await raceReservationInto("racehold", "RECONCILIATION_HOLD");
      expect(outcome).toEqual({
        kind: "RESERVATION_INVALID",
        reason: "RESERVATION_ON_RECONCILIATION_HOLD",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: chain.attempt.id },
      });
      expect(row.orchestrationState).toBe("QUEUED");
      expect(row.submissionBoundaryEnteredAt).toBeNull();
    });

    it("blocks a concurrent reservation transition while the authorization holds the row", async () => {
      // The inverse ordering, and the half the two races above cannot prove.
      // They show the authorization waits for a reservation writer; this shows
      // a reservation writer waits for the authorization — which is what makes
      // the window closed in both directions rather than merely narrowed.
      //
      // Driven through the real `withCostAdmission`, whose callback runs inside
      // the transaction *after* both locks are taken. Re-issuing the lock SQL
      // here would test a copy of the query rather than the one production uses.
      const chain = await seedAuthorizableChain(prisma, "raceinv");

      let finishAuthorization!: () => void;
      const authorizationHeld = new Promise<void>((resolve) => {
        finishAuthorization = resolve;
      });
      const holder = createPaidSubmissionAuthorizationRepository(prisma).withCostAdmission(
        { organizationId: ORG_A, attemptId: chain.attempt.id },
        async () => {
          await authorizationHeld;
          return null;
        },
      );

      let stillBlocked: boolean;
      let writer!: ReturnType<typeof settled<number>>;
      try {
        await breathe(4);
        writer = settled(
          other.$executeRaw`
            UPDATE "generation_reservations"
               SET "state" = 'RECONCILIATION_HOLD'::"GenerationReservationState"
             WHERE "generationJobId" = ${chain.job.id}
          `,
        );
        await breathe();
        // Blocked on the shared row lock the authorization is still holding.
        stillBlocked = !writer.done();
      } finally {
        finishAuthorization();
      }
      await holder;
      expect(stillBlocked).toBe(true);
      // Released at commit, so the transition proceeds — the lock lasts exactly
      // as long as the transaction and no longer.
      await writer.value;
      const after = await prisma.generationReservation.findFirstOrThrow({
        where: { generationJobId: chain.job.id },
      });
      expect(after.state).toBe("RECONCILIATION_HOLD");
    });

    it("does not block a post-delivery regeneration on a CONSUMED reservation", async () => {
      // The row lock must not regress the accepted regeneration path. A
      // CONSUMED reservation is terminal and nothing is contending for it.
      const chain = await seedAuthorizableChain(prisma, "lockregen");
      await prisma.sceneGenerationRequest.update({
        where: { id: chain.request.id },
        data: { state: "DELIVERED", deliveredAt: new Date() },
      });
      await prisma.sceneGeneration.update({
        where: { id: chain.attempt.id },
        data: {
          state: "SUCCEEDED",
          orchestrationState: "OUTPUT_VERIFIED",
          submissionCertainty: "ACCEPTED",
          providerPredictionId: "pred_lockregen",
          providerAcceptedAt: new Date(),
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      const regen = await repositories(prisma).requests.admitUserRegeneration(
        ORG_A,
        {
          id: "genreq_lockregen2",
          generationSceneId: chain.scene.id,
          requestedByUserId: "usr_itest",
        },
        ctx(),
      );
      if (regen.kind !== "ADMITTED") throw new Error(`regeneration: ${regen.kind}`);
      const admitted = await repositories(prisma).attempts.admit(
        ORG_A,
        {
          id: "sgen_lockregen2",
          generationSceneRequestId: regen.request.id,
          providerName: "wavespeed",
          providerModelId: "wavespeed-ai/open-video/image-to-video",
          requestModelKey: "wavespeed-open-video",
          requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
          requestNativeGenerationResolution: "1080p",
          requestResolutionNormalization: "NONE",
          requestNativeMeetsTarget: true,
          pricingSnapshotId: "price_sgen_lockregen2",
          pricingSnapshot: snapshotFor(5),
          fxSnapshot: FX,
        },
        ctx(),
      );
      if (admitted.kind !== "ADMITTED") throw new Error(`attempt: ${admitted.kind}`);
      await prisma.generationReservation.updateMany({
        where: { generationJobId: chain.job.id },
        data: { state: "CONSUMED", consumedAt: new Date() },
      });

      expect((await authorize(prisma, admitted.attempt.id)).kind).toBe("AUTHORIZED");
    });
  });

  describe("historical exposure snapshot integrity", () => {
    /**
     * A sibling's stored price feeds the same Safety Guard equation the
     * candidate's does.
     *
     * Verifying the candidate and trusting every previous term leaves the sum
     * exactly as forgeable as it was before: edit one `PROCESSING` sibling's
     * planning cost from ¥5,000 to ¥10 and roughly ¥4,990 of real exposure
     * silently leaves the cycle, against a candidate whose own snapshot is
     * flawless.
     */
    async function siblingIn(
      suffix: string,
      state: string,
      certainty: string,
    ): Promise<Awaited<ReturnType<typeof seedAuthorizableChain>>> {
      const sibling = await seedAuthorizableChain(prisma, suffix, { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: state as never,
          submissionCertainty: certainty as never,
          submissionBoundaryEnteredAt: new Date(),
          ...(certainty === "ACCEPTED"
            ? { providerPredictionId: `pred_${suffix}`, providerAcceptedAt: new Date() }
            : {}),
          ...(state === "RECONCILIATION_PENDING"
            ? {
                reconciliationStartedAt: new Date(),
                reconciliationDeadlineAt: new Date("2026-09-11T00:00:00.000Z"),
              }
            : {}),
        },
      });
      return sibling;
    }

    it("refuses when a tampered in-flight sibling understates the cycle", async () => {
      const sibling = await siblingIn("expproc", "PROCESSING", "ACCEPTED");
      // Only the amount, to another perfectly representable safe integer.
      // Provider, model, contract key and fingerprint are all untouched.
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { estimatedPlanningCostMicroUsd: 10n },
      });
      const candidate = await seedAuthorizableChain(prisma, "expproccand");
      expect(await authorize(prisma, candidate.attempt.id)).toEqual({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: candidate.attempt.id },
      });
      expect(row.orchestrationState).toBe("QUEUED");
    });

    it("refuses when a tampered settled sibling understates the cycle", async () => {
      const sibling = await siblingIn("expsett", "OUTPUT_VERIFIED", "ACCEPTED");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { estimatedPlanningCostMicroUsd: 10n },
      });
      const candidate = await seedAuthorizableChain(prisma, "expsettcand");
      expect(await authorize(prisma, candidate.attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
    });

    it("refuses when an uncertain sibling's fingerprint no longer matches", async () => {
      const sibling = await siblingIn("expunc", "RECONCILIATION_PENDING", "SUBMISSION_UNKNOWN");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { contractFingerprint: "some-other-contract" },
      });
      const candidate = await seedAuthorizableChain(prisma, "expunccand");
      expect(await authorize(prisma, candidate.attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
    });

    it("refuses when a sibling's referenced FX snapshot is gone", async () => {
      const sibling = await siblingIn("expfx", "PROCESSING", "ACCEPTED");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { fxSnapshotId: null },
      });
      const candidate = await seedAuthorizableChain(prisma, "expfxcand");
      const outcome = await authorize(prisma, candidate.attempt.id);
      expect(outcome).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
      // And not blamed on the candidate's own perfectly valid rate.
      if (outcome.kind !== "PRICING_INELIGIBLE") throw new Error("expected pricing");
      expect(outcome.reason).not.toBe("PRICING_FX_SNAPSHOT_MISSING");
      expect(outcome.reason).not.toBe("PRICING_FX_SNAPSHOT_INVALID");
    });

    it("refuses when a sibling's persisted amount is unrepresentable", async () => {
      const sibling = await siblingIn("expbig", "PROCESSING", "ACCEPTED");
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { estimatedPlanningCostMicroUsd: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      });
      const candidate = await seedAuthorizableChain(prisma, "expbigcand");
      expect(await authorize(prisma, candidate.attempt.id)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
    });

    it("counts a verified RECONCILIATION_EXHAUSTED sibling and refuses a tampered one", async () => {
      // Both halves of the accepted correction, in one place: an exhausted
      // reconciliation still contributes its verified cost as uncertain
      // exposure, and a tampered one fails the authorization closed rather than
      // quietly leaving the cycle.
      const sibling = await siblingIn("expexh", "RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN");
      const candidate = await seedAuthorizableChain(prisma, "expexhcand");
      // Tight: the sibling's ¥234 is the difference between the two answers.
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      expect((await authorize(prisma, candidate.attempt.id, ORG_A, revenue)).kind).toBe(
        "SAFETY_GUARD_HARD_PAUSE",
      );

      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { billableSeconds: 99 },
      });
      expect(await authorize(prisma, candidate.attempt.id, ORG_A, revenue)).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
    });

    /**
     * A cost-bearing sibling whose pricing row is *gone*.
     *
     * Distinct from a tampered one, and it used to be invisible: an inner join
     * against `generation_pricing_snapshots` let snapshot existence decide
     * whether the attempt appeared at all, so a `PROCESSING`/`ACCEPTED` sibling
     * with no snapshot was never classified, contributed zero, and left
     * `exposureVerified` true. Fail-open, in the one calculation that decides
     * whether to spend money.
     *
     * Phase 4C-3B-2E requires exactly one snapshot from `SUBMITTING` onward and
     * enforces it inside the admission transaction, but it is a cross-table
     * invariant no database CHECK can express — so the paid boundary is where
     * its absence has to be caught.
     */
    async function siblingWithoutSnapshot(
      suffix: string,
      state: string,
      certainty: string,
    ): Promise<Awaited<ReturnType<typeof seedAuthorizableChain>>> {
      const sibling = await siblingIn(suffix, state, certainty);
      // Raw delete: no production path removes a snapshot, which is exactly why
      // its absence has to be treated as corruption rather than as a state the
      // system can reach on purpose.
      await prisma.$executeRaw`
        DELETE FROM "generation_pricing_snapshots"
         WHERE "sceneGenerationId" = ${sibling.attempt.id}
      `;
      return sibling;
    }

    it.each([
      ["an in-flight", "PROCESSING", "ACCEPTED", "misproc"],
      ["an uncertain", "RECONCILIATION_PENDING", "SUBMISSION_UNKNOWN", "misunc"],
      ["an exhausted-reconciliation", "RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN", "misexh"],
      ["a settled-estimated", "OUTPUT_VERIFIED", "ACCEPTED", "missett"],
    ] as const)(
      "refuses when %s sibling has no pricing snapshot at all",
      async (_label, state, certainty, suffix) => {
        await siblingWithoutSnapshot(suffix, state, certainty);
        const candidate = await seedAuthorizableChain(prisma, `${suffix}cand`);
        expect(await authorize(prisma, candidate.attempt.id)).toEqual({
          kind: "PRICING_INELIGIBLE",
          reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
        });
        const row = await prisma.sceneGeneration.findUniqueOrThrow({
          where: { id: candidate.attempt.id },
        });
        expect(row.orchestrationState).toBe("QUEUED");
        expect(row.submissionBoundaryEnteredAt).toBeNull();
      },
    );

    it("refuses on a missing snapshot even when the cycle looks affordable", async () => {
      // The tempting shortcut is to let it through when the visible total is
      // comfortable. The visible total is precisely what is missing a term.
      await siblingWithoutSnapshot("misrich", "PROCESSING", "ACCEPTED");
      const candidate = await seedAuthorizableChain(prisma, "misrichcand");
      expect(await authorize(prisma, candidate.attempt.id, ORG_A, yen(1_000_000))).toMatchObject({
        kind: "PRICING_INELIGIBLE",
        reason: "PRICING_EXPOSURE_SNAPSHOT_INVALID",
      });
    });

    it("evaluates a candidate normally past a definitively rejected sibling with no snapshot", async () => {
      // The classifier stays authoritative. A submission the provider *refused*
      // contributes zero exposure, so missing historical pricing for it is not
      // a reason to refuse — turning it into cost would invent money nobody
      // ever owed.
      const sibling = await seedAuthorizableChain(prisma, "misrej", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      await prisma.$executeRaw`
        DELETE FROM "generation_pricing_snapshots"
         WHERE "sceneGenerationId" = ${sibling.attempt.id}
      `;
      const candidate = await seedAuthorizableChain(prisma, "misrejcand");
      expect((await authorize(prisma, candidate.attempt.id)).kind).toBe("AUTHORIZED");
    });

    it("requires no snapshot reproduction from a definitively rejected sibling", async () => {
      // It contributes zero provider exposure, so its historical price is not
      // part of the equation. Demanding reproduction would turn an attempt the
      // provider refused into cost purely because its rate card is no longer
      // reconstructible.
      const sibling = await seedAuthorizableChain(prisma, "exprej", { seconds: 20 });
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: {
          orchestrationState: "FAILED_TERMINAL",
          submissionCertainty: "DEFINITIVELY_REJECTED",
          submissionBoundaryEnteredAt: new Date(),
        },
      });
      await prisma.generationPricingSnapshot.update({
        where: { sceneGenerationId: sibling.attempt.id },
        data: { estimatedPlanningCostMicroUsd: 10n, contractFingerprint: "nonsense" },
      });
      const candidate = await seedAuthorizableChain(prisma, "exprejcand");
      expect((await authorize(prisma, candidate.attempt.id)).kind).toBe("AUTHORIZED");
    });

    it("contributes a valid sibling's re-derived cost, not its stored column", async () => {
      // The positive case: verification must not change the arithmetic for an
      // untampered row. The sibling's ¥234 is what makes this hard-pause.
      const sibling = await siblingIn("expok", "PROCESSING", "ACCEPTED");
      const candidate = await seedAuthorizableChain(prisma, "expokcand");
      const revenue = yen(15_000 + FIVE_SECOND_YEN + Math.floor(TWENTY_SECOND_YEN / 2));
      expect((await authorize(prisma, candidate.attempt.id, ORG_A, revenue)).kind).toBe(
        "SAFETY_GUARD_HARD_PAUSE",
      );

      // Resolve the sibling to nothing, and the same candidate fits.
      await prisma.sceneGeneration.update({
        where: { id: sibling.attempt.id },
        data: { submissionCertainty: "DEFINITIVELY_REJECTED", providerPredictionId: null },
      });
      expect((await authorize(prisma, candidate.attempt.id, ORG_A, revenue)).kind).toBe(
        "AUTHORIZED",
      );
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two workers arm the same attempt", async () => {
      const { attempt } = await seedAuthorizableChain(prisma, "casrace");
      const results = await Promise.allSettled([
        authorize(prisma, attempt.id),
        authorize(other, attempt.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const kinds = results.map((r) => (r.status === "fulfilled" ? r.value.kind : "REJECTED"));
      expect(kinds.filter((k) => k === "AUTHORIZED")).toHaveLength(1);
      // The loser is refused; it is never handed permission to POST.
      expect(kinds.filter((k) => k === "AUTHORIZED").length).toBe(1);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.orchestrationState).toBe("SUBMITTING");
      expect(row.stateVersion).toBe(attempt.stateVersion + 1);
    });

    it("blocks a second authorization while the first holds the cost lock", async () => {
      // The discriminator for the serialization point. Without the
      // organization+cycle lock, both authorizations would read the same
      // exposure and both would decide it was affordable.
      const first = await seedAuthorizableChain(prisma, "lockA");
      const second = await seedAuthorizableChain(prisma, "lockB");

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = other.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${`cycle:${CYCLE}`})
            )::text AS locked
          `;
          await held;
        },
        { timeout: 20_000 },
      );

      await breathe(4);
      const blocked = settled(authorize(prisma, first.attempt.id));
      await breathe();
      expect(blocked.done()).toBe(false);

      release();
      await holder;
      expect((await blocked.value).kind).toBe("AUTHORIZED");

      // And the lock is released at commit, so the next one proceeds.
      expect((await authorize(prisma, second.attempt.id)).kind).toBe("AUTHORIZED");
    });

    it("cannot authorize two attempts that jointly cross the hard pause", async () => {
      // Each candidate alone leaves the cycle above the ¥15,000 floor; together
      // they do not. Two authorizations that both read the pre-commit exposure
      // would both say yes, which is exactly what the serialized cost-admission
      // decision exists to prevent.
      //
      // The overlap is *constructed* rather than hoped for. Measured directly,
      // two in-process authorizations complete one after another even on
      // separate pools — so a plain race passes against an implementation with
      // no lock at all and proves nothing. Instead a third connection takes the
      // same cost lock and holds it, both authorizations are started and
      // provably block on it, and only then is it released: they are then
      // genuinely contending, and the lock is what orders them.
      const a = await seedAuthorizableChain(prisma, "jointA", { seconds: 20 });
      const b = await seedAuthorizableChain(other, "jointB", { seconds: 20 });

      const oneCostYen = TWENTY_SECOND_YEN;
      // Room for one candidate and not for two.
      const revenue = yen(15_000 + oneCostYen + Math.floor(oneCostYen / 2));

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = blocker.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`paid-submission:${ORG_A}`}),
              hashtext(${`cycle:${CYCLE}`})
            )::text AS locked
          `;
          await held;
        },
        { timeout: 30_000 },
      );

      await breathe(4);
      const first = settled(authorize(prisma, a.attempt.id, ORG_A, revenue));
      const second = settled(authorize(other, b.attempt.id, ORG_A, revenue));

      // Both are waiting on the same cost lock, so neither has decided yet.
      await breathe();
      expect(first.done()).toBe(false);
      expect(second.done()).toBe(false);

      release();
      await holder;

      const results = await Promise.all([first.value, second.value]);
      const kinds = results.map((r) => r.kind);

      // Exactly one, not "at most one": the second must see the first's
      // committed exposure and refuse on the guard rather than by accident.
      expect(kinds.filter((k) => k === "AUTHORIZED")).toHaveLength(1);
      expect(kinds.filter((k) => k === "SAFETY_GUARD_HARD_PAUSE")).toHaveLength(1);

      const armed = await prisma.sceneGeneration.count({
        where: {
          id: { in: [a.attempt.id, b.attempt.id] },
          orchestrationState: "SUBMITTING",
        },
      });
      expect(armed).toBe(1);
    });
  });
});
