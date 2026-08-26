import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaSceneGenerationExecutionRepository,
  createPrismaPropertyRepositories,
} from "@app/database";
import {
  computeGenerationRequestHash,
  prepareQueuedGeneration,
  type ExecutionPreflightDeps,
  type VideoModelCapability,
} from "@app/domain";

/**
 * The one PostgreSQL proof this milestone needs: **preparation writes nothing.**
 *
 * Everything else about preflight is decided in the domain and covered by unit
 * tests. This asks the only question a fake cannot answer honestly — whether a
 * real `SceneGeneration` row is byte-for-byte identical after a successful
 * preparation, including `updatedAt`, which no assertion in this process
 * controls.
 *
 * The happy path is used deliberately, because it is the one that runs the most
 * code: both scoped asset reads, the storage existence check, and the signing.
 * A refusal would exercise less and prove less. Refusals are not duplicated
 * here — they are domain decisions, not database ones.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_pf";
const PROP = "prp_itest_pf";
const PROJECT = "vpr_itest_pf";
const ASSET = "ast_itest_pf";
const GENERATION = "gen_itest_pf";
const KEY = `${ORG}/assets/${ASSET}/normalized.jpg`;
const SIGNED = {
  url: `https://storage.itest.example/${KEY}?sig=itest-token`,
  expiresAt: new Date(Date.UTC(2030, 0, 1)),
};

const prisma = new PrismaClient();
const execution = createPrismaSceneGenerationExecutionRepository(prisma);
const { assets } = createPrismaPropertyRepositories(prisma);

const CAPABILITY: VideoModelCapability = {
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  durationSeconds: { kind: "RANGE", minSeconds: 1, maxSeconds: 10 },
  resolutions: ["1080p"],
  aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9"] },
  negativePrompt: { kind: "UNSUPPORTED" },
  cameraMotion: { kind: "PROMPT_RENDERED" },
};

/** Only the two narrowed capabilities preflight declares. */
const storage: ExecutionPreflightDeps["storage"] = {
  exists: (key) => Promise.resolve(key === KEY),
  createSignedDownloadUrl: () => Promise.resolve(SIGNED),
};

const COMPILED_PROMPT = '{"preservation":["keep the window"],"sceneFacts":{},"userCustomization":null}';

async function cleanup(): Promise<void> {
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId: ORG } } });
  await prisma.videoProject.deleteMany({ where: { organizationId: ORG } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();

  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await prisma.property.create({
    data: {
      id: PROP,
      organizationId: ORG,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_pf",
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: ASSET,
      organizationId: ORG,
      propertyId: PROP,
      storageKey: KEY,
      originalFilename: "kitchen.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      width: 1920,
      height: 1080,
      status: "READY",
      createdBy: "usr_itest_pf",
    },
  });
  await prisma.videoProject.create({
    data: {
      id: PROJECT,
      organizationId: ORG,
      propertyId: PROP,
      name: "Walkthrough",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      createdBy: "usr_itest_pf",
    },
  });
  await prisma.sceneGeneration.create({
    data: {
      id: GENERATION,
      videoProjectId: PROJECT,
      sourceStoryboardSceneId: "scn_itest_pf",
      assetId: ASSET,
      sourceAnalysisRevision: 1,
      // Computed from the very facts stored beside it, so preflight's
      // verification passes for the honest reason rather than a hard-coded one.
      requestHash: computeGenerationRequestHash({
        assetId: ASSET,
        compiledPrompt: COMPILED_PROMPT,
        durationSeconds: 5,
        cameraMotion: "SLOW_PAN_LEFT",
        aspectRatio: "16:9",
        resolution: "1080p",
        providerName: "fake",
        providerModelId: "fake/image-to-video",
      }),
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      requestCompiledPrompt: COMPILED_PROMPT,
      requestDurationSeconds: 5,
      requestCameraMotion: "SLOW_PAN_LEFT",
      requestAspectRatio: "16:9",
      requestResolution: "1080p",
      requestRenderedPrompt: "Preservation rules:\n- keep the window",
      state: "QUEUED",
    },
  });
});

afterAll(async () => {
  if (HAS_DB) await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("prepareQueuedGeneration against PostgreSQL", () => {
  it("prepares a real candidate and leaves every persisted column untouched", async () => {
    // The candidate comes from the real execution port, so `organizationId` is
    // the authoritative one resolved through `VideoProject` rather than a value
    // this test chose.
    const candidate = await execution.findNextQueuedForPreparation();
    expect(candidate!.organizationId).toBe(ORG);
    expect(candidate!.generation.id).toBe(GENERATION);

    const before = await prisma.sceneGeneration.findUnique({ where: { id: GENERATION } });

    const prepared = await prepareQueuedGeneration(
      { assets, storage, capabilities: { current: () => CAPABILITY } },
      candidate!,
    );

    expect(prepared.organizationId).toBe(ORG);
    expect(prepared.sourceImageUrl).toBe(SIGNED.url);
    expect(prepared.sourceUrlExpiresAt).toEqual(SIGNED.expiresAt);

    // The whole row, `updatedAt` included — nothing in this process controls
    // that column, so it is the one that would catch a stray write.
    const after = await prisma.sceneGeneration.findUnique({ where: { id: GENERATION } });
    expect(after).toEqual(before);
    expect(after!.state).toBe("QUEUED");
  });
});
