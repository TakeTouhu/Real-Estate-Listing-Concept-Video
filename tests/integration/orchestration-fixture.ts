import { PrismaClient } from "@prisma/client";
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
  sanitizeTransitionMetadata,
  type AdmitGenerationAttemptInput,
  type PricingSnapshot,
  type ProviderPricingIdentity,
  type TransitionContext,
} from "@app/domain";

/**
 * Shared fixture for the orchestration integration suites.
 *
 * Two tenants, not one. Every isolation assertion needs a *real* second
 * organization with its own project and its own generation chain — a single-org
 * fixture can only ever show that a made-up id is rejected, which is not the
 * question. So the seed builds both, and the suites reach across.
 */

export const HAS_DB = Boolean(process.env.DATABASE_URL);

export const ORG_A = "org_itest_orch_a";
export const ORG_B = "org_itest_orch_b";
export const PROP_A = "prp_itest_orch_a";
export const PROP_B = "prp_itest_orch_b";
export const PROJECT_A = "vpr_itest_orch_a";
export const PROJECT_B = "vpr_itest_orch_b";
export const ASSET_A = "ast_itest_orch_a";
export const ASSET_B = "ast_itest_orch_b";
/** Deliberately points at a storyboard scene that does not exist. */
export const STORYBOARD_SCENE = "sbs_itest_orch_gone";

export function repositories(prisma: PrismaClient) {
  return {
    jobs: createGenerationJobRepository(prisma),
    reservations: createGenerationReservationRepository(prisma),
    scenes: createGenerationSceneRepository(prisma),
    requests: createSceneGenerationRequestRepository(prisma),
    attempts: createSceneGenerationAttemptRepository(prisma),
    pricing: createGenerationPricingSnapshotRepository(prisma),
    events: createGenerationTransitionEventRepository(prisma),
  };
}

export function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actorType: "SYSTEM",
    actorUserId: null,
    correlationId: "corr_itest",
    causationId: null,
    reasonCode: null,
    eventType: "TEST",
    metadata: sanitizeTransitionMetadata({}),
    ...overrides,
  };
}

export const H3_MAX_IDENTITY: ProviderPricingIdentity = {
  provider: "fal",
  pricingModelKey: "minimax-h3-max",
  generationMode: "image-to-video",
  nativeTier: "768P",
  audioMode: "none",
  durationBillingRuleId: "per-second",
  pricingVersion: "2026-09-02.1",
};

export const OPEN_VIDEO_IDENTITY: ProviderPricingIdentity = {
  ...H3_MAX_IDENTITY,
  provider: "wavespeed",
  pricingModelKey: "wavespeed-open-video",
  nativeTier: "1080p",
};

/** The domain's immutable pricing decision, computed exactly as production would. */
export function domainSnapshot(
  identity: ProviderPricingIdentity = OPEN_VIDEO_IDENTITY,
  riskProfileKey: "NORMAL_AI" | "HIGH_QUALITY_AI" = "NORMAL_AI",
): PricingSnapshot {
  const contract = createProviderPricingCatalog().findByIdentity(identity);
  if (contract === undefined) throw new Error("expected a pricing contract");
  const taken = createPricingSnapshot({
    contract,
    riskProfileKey,
    requestedSeconds: 5,
    pricingEffectiveAt: epochMillisFromDate(new Date("2026-09-04T00:00:00.000Z")),
  });
  if (!taken.ok) throw new Error("expected a pricing snapshot");
  return taken.value;
}

/**
 * An attempt admission whose pricing binding is correct by construction.
 *
 * WaveSpeed OpenVideo throughout: the provider the attempt names, the provider
 * the snapshot prices, and the model key on both sides all agree. The earlier
 * fixture paired a WaveSpeed attempt with a fal/H3 Max snapshot, which was
 * exactly the mis-binding the boundary now refuses — a fixture that could not
 * be admitted at all today.
 */
export function attemptInput(
  overrides: Partial<AdmitGenerationAttemptInput> & {
    readonly id: string;
    readonly generationSceneRequestId: string;
  },
): AdmitGenerationAttemptInput {
  return {
    attemptKind: "PRIMARY",
    requestHash: `sha256:v2:${"a".repeat(63)}1`,
    providerName: "wavespeed",
    providerModelId: "wavespeed-ai/open-video/image-to-video",
    requestModelKey: "wavespeed-open-video",
    requestCompiledPrompt: "a sunlit living room, cinematic",
    requestRenderedPrompt: "a sunlit living room, cinematic, slow pan",
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN",
    requestAspectRatio: "16:9",
    requestTargetOutputResolution: "1080p",
    requestNativeGenerationResolution: "1080p",
    requestResolutionNormalization: "NONE",
    requestNativeMeetsTarget: true,
    sourceStoryboardSceneId: STORYBOARD_SCENE,
    sourceAssetId: ASSET_A,
    sourceAnalysisRevision: 1,
    pricingSnapshotId: `price_${overrides.id}`,
    pricingSnapshot: domainSnapshot(),
    ...overrides,
  };
}

export async function wipeOrchestration(prisma: PrismaClient): Promise<void> {
  await prisma.generationScene.updateMany({ data: { currentDeliveredRequestId: null } });
  await prisma.generationTransitionEvent.deleteMany({});
  await prisma.generationPricingSnapshot.deleteMany({});
  await prisma.sceneGeneration.deleteMany({
    where: { videoProjectId: { in: [PROJECT_A, PROJECT_B] } },
  });
  await prisma.sceneGenerationRequest.deleteMany({});
  await prisma.generationScene.deleteMany({});
  await prisma.generationReservation.deleteMany({});
  await prisma.generationJob.deleteMany({});
  await prisma.fxRateSnapshot.deleteMany({});
}

export async function seedTenants(prisma: PrismaClient): Promise<void> {
  for (const [org, prop, project, asset] of [
    [ORG_A, PROP_A, PROJECT_A, ASSET_A],
    [ORG_B, PROP_B, PROJECT_B, ASSET_B],
  ] as const) {
    await prisma.property.upsert({
      where: { id: prop },
      update: {},
      create: {
        id: prop,
        organizationId: org,
        name: "Orchestration fixture",
        propertyType: "APARTMENT",
        createdBy: "usr_itest",
      },
    });
    await prisma.mediaAsset.upsert({
      where: { id: asset },
      update: {},
      create: {
        id: asset,
        organizationId: org,
        propertyId: prop,
        storageKey: `org/${org}/a/${asset}/normalized.jpg`,
        originalFilename: "a.jpg",
        status: "READY",
        createdBy: "usr_itest",
      },
    });
    await prisma.videoProject.upsert({
      where: { id: project },
      update: {},
      create: {
        id: project,
        organizationId: org,
        propertyId: prop,
        name: "Orchestration project",
        durationSeconds: 60,
        aspectRatio: "16:9",
        targetOutputResolution: "1080p",
        createdBy: "usr_itest",
      },
    });
  }
}

export async function dropTenants(prisma: PrismaClient): Promise<void> {
  await prisma.videoProject.deleteMany({ where: { id: { in: [PROJECT_A, PROJECT_B] } } });
  await prisma.mediaAsset.deleteMany({ where: { id: { in: [ASSET_A, ASSET_B] } } });
  await prisma.property.deleteMany({ where: { id: { in: [PROP_A, PROP_B] } } });
}

/** A full job → scene → initial request chain in one organization. */
export async function seedChain(
  prisma: PrismaClient,
  suffix: string,
  organizationId: string = ORG_A,
  videoProjectId: string = PROJECT_A,
) {
  const repos = repositories(prisma);
  const created = await repos.jobs.create(
    organizationId,
    {
      id: `genjob_${suffix}`,
      videoProjectId,
      requestedByUserId: "usr_itest",
      qualityTier: "HIGH_QUALITY",
      targetOutputResolution: "1080p",
      requestedDurationSeconds: 60,
    },
    ctx(),
  );
  if (created.kind !== "CREATED") throw new Error(`job not created: ${created.kind}`);

  const scene = await repos.scenes.create(
    organizationId,
    {
      id: `genscene_${suffix}`,
      generationJobId: created.job.id,
      position: 0,
      sourceStoryboardSceneId: STORYBOARD_SCENE,
      sourceAssetId: organizationId === ORG_A ? ASSET_A : ASSET_B,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 5,
      snapshotCameraMotion: "SLOW_PAN",
      snapshotCompiledPrompt: "a sunlit living room, cinematic",
    },
    ctx(),
  );
  if (scene === null) throw new Error("scene not created");

  const request = await repos.requests.createInitial(
    organizationId,
    {
      id: `genreq_${suffix}`,
      generationSceneId: scene.id,
      requestedByUserId: "usr_itest",
    },
    ctx(),
  );
  if (request === null) throw new Error("request not created");

  return { job: created.job, scene, request };
}
