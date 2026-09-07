import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  computeGenerationRequestHash,
  createPricingSnapshot,
  createProviderPricingCatalog,
  epochMillisFromDate,
  generationRequestFactsFrom,
  type ProviderPricingIdentity,
} from "@app/domain";
import { createPrismaSceneGenerationRepository } from "@app/database";
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
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * Transaction C, as the single authority over what an attempt records.
 *
 * The theme of every test here is that a caller cannot tell this transaction
 * anything a persisted row already knows. Before these corrections it could
 * supply its own request hash, its own asset, its own duration and its own
 * attempt kind — so one logical scene could claim one prompt while its provider
 * attempt recorded another, and a caller could walk past the active-request
 * identity protection simply by offering a different digest for identical work.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);
const generations = HAS_DB
  ? createPrismaSceneGenerationRepository(prisma)
  : (null as unknown as ReturnType<typeof createPrismaSceneGenerationRepository>);

function snapshotFor(
  identity: ProviderPricingIdentity,
  riskProfileKey: "NORMAL_AI" | "HIGH_QUALITY_AI",
  requestedSeconds: number,
) {
  const contract = createProviderPricingCatalog().findByIdentity(identity);
  if (contract === undefined) throw new Error("expected a pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey,
    requestedSeconds,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

describe.skipIf(!HAS_DB)("attempt admission derives what it persists", () => {
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

  describe("every persisted request fact comes from the scene or the job", () => {
    it("copies the scene's and job's facts, and derives the hash from them", async () => {
      const { job, scene, request } = await seedChain(prisma, "facts");
      const admitted = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_facts", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (admitted.kind !== "ADMITTED") throw new Error(`expected ADMITTED: ${admitted.kind}`);

      const row = await prisma.sceneGeneration.findUniqueOrThrow({
        where: { id: "sgen_facts" },
      });

      // Scene facts.
      expect(row.assetId).toBe(scene.sourceAssetId);
      expect(row.sourceStoryboardSceneId).toBe(scene.sourceStoryboardSceneId);
      expect(row.sourceAnalysisRevision).toBe(scene.sourceAnalysisRevision);
      expect(row.requestCompiledPrompt).toBe(scene.snapshotCompiledPrompt);
      expect(row.requestDurationSeconds).toBe(scene.snapshotDurationSeconds);
      expect(row.requestCameraMotion).toBe(scene.snapshotCameraMotion);

      // Job facts — from the snapshot frozen at job creation, not the project.
      expect(row.requestTargetOutputResolution).toBe(job.targetOutputResolution);
      expect(row.requestAspectRatio).toBe(job.targetAspectRatio);
    });

    /**
     * The reconstruction proof.
     *
     * Reload through the *existing* generation persistence contract, rebuild
     * the canonical facts with the existing `generationRequestFactsFrom`, and
     * recompute with the existing `computeGenerationRequestHash`. Nothing here
     * reimplements the tuple: if the stored row and the canonical hash ever
     * disagree, this fails.
     */
    it("stores a hash that re-derives exactly from the persisted row", async () => {
      const { request } = await seedChain(prisma, "rehash");
      await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_rehash", generationSceneRequestId: request.id }),
        ctx(),
      );

      const reloaded = await generations.findById(ORG_A, "sgen_rehash");
      if (reloaded === null) throw new Error("expected the persisted attempt");
      const facts = generationRequestFactsFrom(reloaded);
      expect(computeGenerationRequestHash(facts)).toBe(reloaded.requestHash);
      expect(reloaded.requestHash.startsWith("sha256:v2:")).toBe(true);
    });

    it("gives two scenes with different prompts different identities", async () => {
      // The hash follows the facts. Two scenes that differ only in prompt are
      // different work and must not collide on the active-request index.
      const a = await seedChain(prisma, "hashA");
      const b = await seedChain(prisma, "hashB");
      await prisma.generationScene.update({
        where: { id: b.scene.id },
        data: { snapshotCompiledPrompt: "a different room entirely" },
      });

      const first = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_hashA", generationSceneRequestId: a.request.id }),
        ctx(),
      );
      const second = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_hashB", generationSceneRequestId: b.request.id }),
        ctx(),
      );
      if (first.kind !== "ADMITTED" || second.kind !== "ADMITTED") {
        throw new Error("expected both admitted");
      }
      expect(first.attempt.requestHash).not.toBe(second.attempt.requestHash);
    });

    it("refuses a scene with no compiled prompt rather than storing a hashless row", async () => {
      const { scene, request } = await seedChain(prisma, "noprompt");
      await prisma.generationScene.update({
        where: { id: scene.id },
        data: { snapshotCompiledPrompt: null },
      });
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_noprompt", generationSceneRequestId: request.id }),
        ctx(),
      );
      expect(outcome.kind).toBe("SCENE_FACTS_INCOMPLETE");
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_noprompt" } }))
        .toBeNull();
    });
  });

  describe("attempt kind and request state are decided together", () => {
    it("makes the first attempt PRIMARY and starts the request in the same commit", async () => {
      const { request } = await seedChain(prisma, "firstattempt");
      expect(request.state).toBe("PENDING");

      const admitted = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_first", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (admitted.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      expect(admitted.attempt.attemptKind).toBe("PRIMARY");
      expect(admitted.attempt.attemptOrdinal).toBe(1);

      // The request is generating *because* an attempt exists. Split apart, the
      // database would claim the customer's request had not begun while a
      // provider attempt for it already existed.
      const reloaded = await repos.requests.findById(ORG_A, request.id);
      expect(reloaded?.state).toBe("GENERATING");

      const history = await repos.events.listForAggregate(ORG_A, "SCENE_REQUEST", request.id);
      expect(history.map((e) => [e.fromState, e.toState])).toEqual([
        [null, "PENDING"],
        ["PENDING", "GENERATING"],
      ]);
    });

    it("makes a later attempt SYSTEM_RECOVERY without re-entering GENERATING", async () => {
      const { request } = await seedChain(prisma, "recovery");
      const first = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_rec_a", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      await prisma.sceneGeneration.update({
        where: { id: first.attempt.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionBoundaryEnteredAt: new Date() },
      });

      const versionBefore = (await repos.requests.findById(ORG_A, request.id))!.stateVersion;
      const second = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_rec_b",
          generationSceneRequestId: request.id,
          pricingSnapshotId: "price_sgen_rec_b",
        }),
        ctx(),
      );
      if (second.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      expect(second.attempt.attemptKind).toBe("SYSTEM_RECOVERY");
      expect(second.attempt.attemptOrdinal).toBe(2);

      // The request does not move again: a recovery is not a new customer
      // request, and re-entering GENERATING would say it was.
      const after = await repos.requests.findById(ORG_A, request.id);
      expect(after?.state).toBe("GENERATING");
      expect(after?.stateVersion).toBe(versionBefore);
    });

    it.each([["DELIVERED"], ["FAILED_TERMINAL"], ["CANCELLED"]] as const)(
      "refuses admission onto a %s request",
      async (state) => {
        // Spending money on work a finished request no longer wants.
        const { request } = await seedChain(prisma, `fin${state}`);
        await prisma.sceneGenerationRequest.update({
          where: { id: request.id },
          data: { state },
        });
        const outcome = await repos.attempts.admit(
          ORG_A,
          attemptInput({ id: `sgen_fin${state}`, generationSceneRequestId: request.id }),
          ctx(),
        );
        expect(outcome.kind).toBe("REQUEST_NOT_ADMITTING");
        expect(await prisma.sceneGeneration.findUnique({ where: { id: `sgen_fin${state}` } }))
          .toBeNull();
      },
    );
  });

  /**
   * The two structural rules underneath the derivation.
   *
   * Attempt kind and concurrency are decided in application code, and this
   * table outlives that code. Both tests therefore write raw rows: they go
   * around the repository on purpose, because what they are testing is what
   * survives a caller that never met the repository — a console session, a
   * migration script, a future service.
   */
  describe("the database refuses what derivation would never produce", () => {
    /**
     * Insert a complete attempt row through raw SQL.
     *
     * Raw rather than through Prisma because the row is deliberately one no
     * repository would ever write. Neither driver surfaces the index name, so
     * each scenario is built so that exactly one index can possibly refuse it:
     * the PRIMARY case uses two terminal rows with different ordinals, which
     * the live-attempt and ordinal indexes both ignore, and the live case uses
     * two different kinds, which the PRIMARY index ignores.
     */
    async function insertRawAttempt(patch: {
      readonly id: string;
      readonly requestId: string;
      readonly ordinal: number;
      readonly kind: "PRIMARY" | "SYSTEM_RECOVERY";
      readonly orchestrationState: "QUEUED" | "FAILED_TERMINAL";
    }): Promise<void> {
      // Distinct per row: this must not collide on the *identity* index, which
      // is a different rule tested elsewhere.
      const hash = `sha256:v2:${patch.id.padEnd(64, "0").slice(0, 64)}`;
      const boundary = patch.orchestrationState === "QUEUED" ? "NULL" : "now()";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "scene_generations" (
           "id", "videoProjectId", "sourceStoryboardSceneId", "assetId",
           "sourceAnalysisRevision", "requestHash", "providerName", "providerModelId",
           "requestModelKey", "requestTargetOutputResolution",
           "requestNativeGenerationResolution", "requestResolutionNormalization",
           "requestNativeMeetsTarget", "generationSceneRequestId", "attemptOrdinal",
           "attemptKind", "submissionCertainty", "orchestrationState",
           "pricingContractKey", "submissionBoundaryEnteredAt", "createdAt", "updatedAt"
         ) VALUES (
           $1, $2, 'sbs_raw_gone', $3, 1, $4, 'wavespeed',
           'wavespeed-ai/open-video/image-to-video', 'wavespeed-open-video',
           '1080p', '1080p', 'NONE', true, $5, $6,
           $7::"GenerationAttemptKind", 'PRE_SUBMISSION'::"SubmissionCertainty",
           $8::"GenerationAttemptState", 'wavespeed:wavespeed-open-video:2026-09-02.1',
           ${boundary}, now(), now()
         )`,
        patch.id,
        PROJECT_A,
        ASSET_A,
        hash,
        patch.requestId,
        patch.ordinal,
        patch.kind,
        patch.orchestrationState,
      );
    }

    it("refuses a second PRIMARY attempt under one request", async () => {
      // Two "first" attempts. After the fact the ordinal cannot say which was
      // really first, so the row is refused rather than stored and puzzled over.
      const { request } = await seedChain(prisma, "twoprimary");
      const first = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_prim_a", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      // Finished, so the *live*-attempt index cannot be what refuses the next.
      await prisma.sceneGeneration.update({
        where: { id: first.attempt.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionBoundaryEnteredAt: new Date() },
      });

      await expect(
        insertRawAttempt({
          id: "sgen_prim_b",
          requestId: request.id,
          ordinal: 2,
          kind: "PRIMARY",
          orchestrationState: "FAILED_TERMINAL",
        }),
      ).rejects.toThrow(/23505/);
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_prim_b" } })).toBeNull();
    });

    it("refuses a second live attempt under one request", async () => {
      // System recovery is sequential recovery from a finished attempt, not
      // permission to run two paid attempts at once. The first attempt here is
      // left QUEUED, and the second carries a different kind and ordinal — so
      // only the live-attempt index can refuse it.
      const { request } = await seedChain(prisma, "twolive");
      const first = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_live_a", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      expect(first.attempt.orchestrationState).toBe("QUEUED");

      await expect(
        insertRawAttempt({
          id: "sgen_live_b",
          requestId: request.id,
          ordinal: 2,
          kind: "SYSTEM_RECOVERY",
          orchestrationState: "QUEUED",
        }),
      ).rejects.toThrow(/23505/);
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_live_b" } })).toBeNull();
    });

    it("admits a recovery once the previous attempt has finished", async () => {
      // The other half of the same index: a terminal attempt releases the slot,
      // so a predicate that never released it would break real recovery rather
      // than only permitting real duplication.
      const { request } = await seedChain(prisma, "liveafter");
      const first = await repos.attempts.admit(
        ORG_A,
        attemptInput({ id: "sgen_after_a", generationSceneRequestId: request.id }),
        ctx(),
      );
      if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
      await prisma.sceneGeneration.update({
        where: { id: first.attempt.id },
        data: { orchestrationState: "FAILED_TERMINAL", submissionBoundaryEnteredAt: new Date() },
      });

      await insertRawAttempt({
        id: "sgen_after_b",
        requestId: request.id,
        ordinal: 2,
        kind: "SYSTEM_RECOVERY",
        orchestrationState: "QUEUED",
      });
      const second = await prisma.sceneGeneration.findUnique({ where: { id: "sgen_after_b" } });
      expect(second?.attemptKind).toBe("SYSTEM_RECOVERY");
    });
  });

  /**
   * The full binding matrix.
   *
   * Provider and model key alone were not enough: a snapshot priced for five
   * seconds attached to a fifteen-second scene understates the cost by two
   * thirds with every other field agreeing.
   */
  describe("a pricing decision must match the work it prices", () => {
    async function admitWith(
      suffix: string,
      overrides: Parameters<typeof attemptInput>[0],
    ) {
      const { request } = await seedChain(prisma, suffix);
      return repos.attempts.admit(
        ORG_A,
        attemptInput({ ...overrides, generationSceneRequestId: request.id }),
        ctx(),
      );
    }

    it("refuses the wrong provider", async () => {
      const outcome = await admitWith("bprov", {
        id: "sgen_bprov",
        generationSceneRequestId: "",
        providerName: "fal",
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("PROVIDER_MISMATCH");
    });

    it("refuses the wrong pricing model key", async () => {
      const outcome = await admitWith("bmodel", {
        id: "sgen_bmodel",
        generationSceneRequestId: "",
        requestModelKey: "some-other-model",
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("MODEL_KEY_MISMATCH");
    });

    it("refuses a duration the scene does not have", async () => {
      // The scene is five seconds; this snapshot prices fifteen.
      const outcome = await admitWith("bdur", {
        id: "sgen_bdur",
        generationSceneRequestId: "",
        pricingSnapshot: snapshotFor(OPEN_VIDEO_IDENTITY, "HIGH_QUALITY_AI", 15),
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("DURATION_MISMATCH");
    });

    it("refuses a native tier the attempt does not generate at", async () => {
      const outcome = await admitWith("btier", {
        id: "sgen_btier",
        generationSceneRequestId: "",
        requestNativeGenerationResolution: "720p",
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("NATIVE_TIER_MISMATCH");
    });

    it("refuses an unsupported generation mode", async () => {
      const outcome = await admitWith("bmode", {
        id: "sgen_bmode",
        generationSceneRequestId: "",
        pricingSnapshot: {
          ...snapshotFor(OPEN_VIDEO_IDENTITY, "HIGH_QUALITY_AI", 5),
          identity: {
            ...OPEN_VIDEO_IDENTITY,
            generationMode: "text-to-video",
          },
        },
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("GENERATION_MODE_UNSUPPORTED");
    });

    it("refuses an audio-enabled pricing identity", async () => {
      // The product has no audio-enabled generation contract, so an identity
      // pricing one describes work no attempt here can represent.
      const outcome = await admitWith("baudio", {
        id: "sgen_baudio",
        generationSceneRequestId: "",
        pricingSnapshot: {
          ...snapshotFor(OPEN_VIDEO_IDENTITY, "HIGH_QUALITY_AI", 5),
          identity: { ...OPEN_VIDEO_IDENTITY, audioMode: "on" },
        },
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("AUDIO_MODE_UNSUPPORTED");
    });

    it("refuses a risk profile the job's quality tier does not plan against", async () => {
      // The fixture job is HIGH_QUALITY; NORMAL_AI under-plans it by twenty
      // points, and both halves look internally consistent.
      const outcome = await admitWith("brisk", {
        id: "sgen_brisk",
        generationSceneRequestId: "",
        pricingSnapshot: snapshotFor(OPEN_VIDEO_IDENTITY, "NORMAL_AI", 5),
      });
      if (outcome.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("RISK_PROFILE_MISMATCH");
    });

    it("accepts a NORMAL job planned at the normal buffer", async () => {
      const created = await repos.jobs.create(
        ORG_A,
        {
          id: "genjob_normal",
          videoProjectId: "vpr_itest_orch_a",
          requestedByUserId: "usr",
          qualityTier: "NORMAL",
          requestedDurationSeconds: 30,
        },
        ctx(),
      );
      if (created.kind !== "CREATED") throw new Error("expected CREATED");
      const scene = await repos.scenes.create(
        ORG_A,
        {
          id: "genscene_normal",
          generationJobId: created.job.id,
          position: 0,
          sourceStoryboardSceneId: "sbs_gone",
          sourceAssetId: "ast_itest_orch_a",
          sourceAnalysisRevision: 1,
          snapshotDurationSeconds: 5,
          snapshotCameraMotion: null,
          snapshotCompiledPrompt: "a normal room",
        },
        ctx(),
      );
      const req = await repos.requests.createInitial(
        ORG_A,
        { id: "genreq_normal", generationSceneId: scene!.id, requestedByUserId: "usr" },
        ctx(),
      );
      const ok = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_normal",
          generationSceneRequestId: req!.id,
          pricingSnapshot: snapshotFor(OPEN_VIDEO_IDENTITY, "NORMAL_AI", 5),
        }),
        ctx(),
      );
      expect(ok.kind).toBe("ADMITTED");

      // And the high-quality profile is refused on that same NORMAL job.
      const wrong = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_normal_bad",
          generationSceneRequestId: req!.id,
          pricingSnapshot: snapshotFor(OPEN_VIDEO_IDENTITY, "HIGH_QUALITY_AI", 5),
        }),
        ctx(),
      );
      if (wrong.kind !== "PRICING_BINDING_INVALID") throw new Error("expected refusal");
      expect(wrong.reason).toBe("RISK_PROFILE_MISMATCH");
    });

    it("writes nothing at all when a binding fails", async () => {
      const { request } = await seedChain(prisma, "bnothing");
      await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_bnothing",
          generationSceneRequestId: request.id,
          providerName: "fal",
        }),
        ctx(),
      );
      expect(await prisma.sceneGeneration.findUnique({ where: { id: "sgen_bnothing" } }))
        .toBeNull();
      expect(
        await prisma.generationPricingSnapshot.findUnique({
          where: { id: "price_sgen_bnothing" },
        }),
      ).toBeNull();
      // And the request never started.
      expect((await repos.requests.findById(ORG_A, request.id))?.state).toBe("PENDING");
    });
  });

  describe("an exchange rate named by a snapshot is persisted with it", () => {
    const FX = {
      id: "fx_admit_2026_09",
      baseCurrency: "USD",
      quoteCurrency: "JPY",
      rateNumerator: 150,
      rateDenominator: 1,
      effectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
      sourceReference: "fixture",
    };

    function pricedWithFx(fxSnapshotId: string | null) {
      return { ...snapshotFor(OPEN_VIDEO_IDENTITY, "HIGH_QUALITY_AI", 5), fxSnapshotId };
    }

    it("stores the exact rate inside the same commit", async () => {
      const { request } = await seedChain(prisma, "fxok");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxok",
          generationSceneRequestId: request.id,
          pricingSnapshot: pricedWithFx(FX.id),
          fxSnapshot: FX,
        }),
        ctx(),
      );
      expect(outcome.kind).toBe("ADMITTED");
      const stored = await prisma.fxRateSnapshot.findUniqueOrThrow({ where: { id: FX.id } });
      expect(stored.rateNumerator).toBe(150n);
      expect(stored.rateDenominator).toBe(1n);
      expect(stored.sourceReference).toBe("fixture");
    });

    it("refuses a snapshot that names a rate nobody supplied", async () => {
      // A record naming a rate that cannot be produced is an audit record that
      // cannot be re-derived.
      const { request } = await seedChain(prisma, "fxmissing");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxmissing",
          generationSceneRequestId: request.id,
          pricingSnapshot: pricedWithFx(FX.id),
          fxSnapshot: null,
        }),
        ctx(),
      );
      if (outcome.kind !== "FX_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("FX_SNAPSHOT_REQUIRED");
    });

    it("refuses a rate the snapshot did not name", async () => {
      const { request } = await seedChain(prisma, "fxextra");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxextra",
          generationSceneRequestId: request.id,
          fxSnapshot: FX,
        }),
        ctx(),
      );
      if (outcome.kind !== "FX_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("FX_SNAPSHOT_UNEXPECTED");
    });

    it("refuses a mismatched id", async () => {
      const { request } = await seedChain(prisma, "fxid");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxid",
          generationSceneRequestId: request.id,
          pricingSnapshot: pricedWithFx("fx_something_else"),
          fxSnapshot: FX,
        }),
        ctx(),
      );
      if (outcome.kind !== "FX_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("FX_SNAPSHOT_ID_MISMATCH");
    });

    it("refuses an unusable rate through the pricing domain's own validator", async () => {
      const { request } = await seedChain(prisma, "fxbad");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxbad",
          generationSceneRequestId: request.id,
          pricingSnapshot: pricedWithFx(FX.id),
          fxSnapshot: { ...FX, rateNumerator: 0 },
        }),
        ctx(),
      );
      if (outcome.kind !== "FX_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("FX_SNAPSHOT_INVALID");
    });

    it("refuses a same-id rate whose content differs", async () => {
      // Two different rates under one id is a conflict, not a cache hit.
      // Reusing the stored one would price an attempt against a rate its
      // snapshot never saw.
      const a = await seedChain(prisma, "fxconflict_a");
      await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxc_a",
          generationSceneRequestId: a.request.id,
          pricingSnapshot: pricedWithFx(FX.id),
          fxSnapshot: FX,
        }),
        ctx(),
      );

      const b = await seedChain(prisma, "fxconflict_b");
      const outcome = await repos.attempts.admit(
        ORG_A,
        attemptInput({
          id: "sgen_fxc_b",
          generationSceneRequestId: b.request.id,
          pricingSnapshot: pricedWithFx(FX.id),
          fxSnapshot: { ...FX, rateNumerator: 151 },
        }),
        ctx(),
      );
      if (outcome.kind !== "FX_BINDING_INVALID") throw new Error("expected refusal");
      expect(outcome.reason).toBe("FX_SNAPSHOT_CONFLICT");
      // The stored rate is untouched.
      const stored = await prisma.fxRateSnapshot.findUniqueOrThrow({ where: { id: FX.id } });
      expect(stored.rateNumerator).toBe(150n);
    });
  });
});
