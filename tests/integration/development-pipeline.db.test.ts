import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGenerationStartRepository,
  createPrismaStoryboardRepositories,
  createUnitEntitlementRepository,
} from "@app/database";
import {
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  buildAssetStorageKey,
  managedGenerationOutputKey,
  type CompiledPrompt,
  type StoryboardScene,
} from "@app/domain";
import { createSharedFolderStorage } from "@app/storage";
import type { FakeClipRenderer } from "@app/video-providers";
import {
  assembleDevelopmentPipeline,
  developmentPipelineContext,
  type DevelopmentPipeline,
} from "../../apps/worker/src/development-pipeline/assembly";
import { ctx } from "./orchestration-fixture";

/**
 * The development pipeline's assembly against live PostgreSQL (GS-9b,
 * ADR-0106): a job started by the real start commit is launched, its scenes'
 * photos are signed and sent to the test provider, and each clip is copied
 * into the shared folder, on the system clock and the billing cycle's own
 * revenue, as the pipeline command will run them.
 *
 * The clip maker is a stand-in that keeps the photo it was given and writes a
 * few bytes: this suite's CI job has no FFmpeg. The clip itself is GS-6's
 * (`tests/media/fake-clip.media.test.ts`).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_devpipe";
const USER = "usr_itest_devpipe";
const PROPERTY = "prp_itest_devpipe";
const ASSET = "ast_itest_devpipe";
const PROJECT = "vpr_itest_devpipe";
const FINGERPRINT = "sha256:devpipe";
const SECRET = "development-pipeline-signing-secret-0123";
const PHOTO = Buffer.from("the scene's photo, as the web app stored it");
const CLIP = Buffer.from("a clip the stand-in made");

const prisma = new PrismaClient();
const storyboards = createPrismaStoryboardRepositories(prisma);

/**
 * The billing cycle the system clock is in, which the gate reads revenue from.
 * The job starts at this instant too, so a run across a month's end stays in it.
 */
const NOW = new Date();
const CYCLE_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const CYCLE_END = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));
const CYCLE = CYCLE_START.toISOString().slice(0, 7);

let dir: string;
let made: Buffer[];
let render: "MAKE" | "FAIL";

const renderer: FakeClipRenderer = {
  async render({ photoPath, outputPath }) {
    made.push(await readFile(photoPath));
    if (render === "FAIL") return { kind: "FAILED" };
    await writeFile(outputPath, CLIP);
    return { kind: "RENDERED" };
  },
};

function pipeline(): DevelopmentPipeline {
  return assembleDevelopmentPipeline(
    {
      NODE_ENV: "test",
      VIDEO_PROVIDER: "fake",
      SHARED_STORAGE_DIR: join(dir, "shared"),
      STORAGE_SIGNING_SECRET: SECRET,
    },
    { providerFolder: join(dir, "provider") },
    { prisma, renderer },
  );
}

/** The shared folder as the web app opens it. */
function shared() {
  return createSharedFolderStorage({ root: join(dir, "shared"), secret: SECRET }).objectStorage;
}

function compiledPrompt(position: number): string {
  const prompt: CompiledPrompt = {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: { assetId: ASSET, position, roomType: "LIVING_ROOM", durationSeconds: 5, cameraMotion: null },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  };
  return JSON.stringify(prompt);
}

async function seed(): Promise<void> {
  const photoKey = buildAssetStorageKey({
    organizationId: ORG,
    propertyId: PROPERTY,
    assetId: ASSET,
    variant: "normalized",
    extension: "jpg",
  });
  // Stored where the web app stores an upload's normalized photo.
  await shared().putObject(photoKey, PHOTO);
  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await prisma.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "Pipeline fixture", propertyType: "APARTMENT", createdBy: USER },
  });
  await prisma.mediaAsset.create({
    data: {
      id: ASSET,
      organizationId: ORG,
      propertyId: PROPERTY,
      storageKey: photoKey,
      mimeType: "image/jpeg",
      sha256: createHash("sha256").update(PHOTO).digest("hex"),
      originalFilename: "seed.jpg",
      status: "READY",
      createdBy: USER,
    },
  });
  await prisma.videoProject.create({
    data: {
      id: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      name: "Walkthrough",
      durationSeconds: 30,
      aspectRatio: "16:9",
      targetOutputResolution: "720p",
      createdBy: USER,
    },
  });
  const scenes: Omit<StoryboardScene, "createdAt" | "updatedAt">[] = [1, 2].map((position) => ({
    id: `sbs_itest_devpipe_${position}`,
    videoProjectId: PROJECT,
    propertyId: PROPERTY,
    assetId: ASSET,
    position,
    roomType: "LIVING_ROOM",
    durationSeconds: 5,
    cameraMotion: null,
    compiledPrompt: compiledPrompt(position),
    sourceAnalysisRevision: 2,
  }));
  await storyboards.scenes.saveComposition(ORG, PROJECT, { scenes, compositionFingerprint: FINGERPRINT });
  const opened = await createUnitEntitlementRepository(prisma).openPeriod({
    id: "uep_itest_devpipe",
    organizationId: ORG,
    planKey: "premium",
    billingCycleKey: CYCLE,
    startsAt: CYCLE_START,
    endsAt: CYCLE_END,
    commercialReference: null,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
  await prisma.organizationSubscription.create({
    data: {
      id: "sub_itest_devpipe",
      organizationId: ORG,
      planKey: "PREMIUM",
      channel: "SALES_ASSISTED",
      anchorAt: CYCLE_START,
      commercialReference: `contract-${ORG}`,
    },
  });
}

/** Start one job of the project, as the start route does; its id. */
async function start(): Promise<string> {
  const outcome = await createGenerationStartRepository(prisma).start({
    organizationId: ORG,
    videoProjectId: PROJECT,
    idempotencyKey: "devpipe-start",
    jobId: "gjob_itest_devpipe",
    reservationId: "gres_itest_devpipe",
    requestedByUserId: USER,
    qualityTier: "NORMAL",
    disclosureMode: "THROUGHOUT",
    startedAt: NOW,
    storyboard: {
      compositionFingerprint: FINGERPRINT,
      scenes: [1, 2].map((position) => ({
        storyboardSceneId: `sbs_itest_devpipe_${position}`,
        generationSceneId: `gscn_itest_devpipe_${position}`,
        initialRequestId: `greq_itest_devpipe_${position}`,
      })),
    },
    context: ctx({ actorType: "USER", actorUserId: USER, eventType: "GENERATION_STARTED" }),
    audit: (started) => ({
      organizationId: ORG,
      actorUserId: USER,
      action: "generation.started",
      resourceType: "generation_job",
      resourceId: started.job.id,
      metadata: { sceneCount: started.sceneCount },
    }),
  });
  if (outcome.kind !== "STARTED") throw new Error(`start: ${outcome.kind}`);
  return outcome.job.id;
}

/** The job's attempts, in scene order. */
async function attempts(job: string) {
  return prisma.sceneGeneration.findMany({
    where: { generationSceneRequest: { generationScene: { generationJobId: job } } },
    orderBy: { generationSceneRequest: { generationScene: { position: "asc" } } },
    select: { id: true, orchestrationState: true, outputStorageKey: true },
  });
}

async function cleanup(): Promise<void> {
  const scope = { videoProject: { organizationId: ORG } };
  const jobs = (await prisma.generationJob.findMany({ where: scope, select: { id: true } })).map((job) => job.id);
  await prisma.generationTransitionEvent.deleteMany({ where: { organizationId: ORG } });
  await prisma.generationPricingSnapshot.deleteMany({ where: { sceneGeneration: scope } });
  await prisma.sceneGeneration.deleteMany({ where: scope });
  await prisma.sceneGenerationRequest.deleteMany({ where: { generationScene: { generationJobId: { in: jobs } } } });
  await prisma.generationScene.deleteMany({ where: { generationJobId: { in: jobs } } });
  await prisma.generationReservationAllocation.deleteMany({ where: { organizationId: ORG } });
  await prisma.generationReservation.deleteMany({ where: { generationJobId: { in: jobs } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobs } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: ORG } });
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId: ORG } } });
  await prisma.videoProject.deleteMany({ where: { organizationId: ORG } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "devpipe-"));
});

beforeEach(async () => {
  if (!HAS_DB) return;
  made = [];
  render = "MAKE";
  await rm(join(dir, "shared"), { recursive: true, force: true });
  await rm(join(dir, "provider"), { recursive: true, force: true });
  await cleanup();
  await seed();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("the development pipeline's steps, on the test provider", () => {
  it("launches a started job, sends its scenes' photos, and copies each clip into the shared folder", async () => {
    const job = await start();
    const steps = pipeline();

    const launched = await steps.launch.runOnce(10);
    expect([launched.launched, launched.next]).toEqual([1, null]);

    const sent = await steps.submission.runOnce(10);
    expect(sent.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false },
      { kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false },
    ]);
    // The provider read each scene's photo through the URL preparation signed.
    expect(made).toEqual([PHOTO, PHOTO]);

    await steps.providerOutput.runProviderOutputBatchOnce({
      limit: 10,
      context: developmentPipelineContext("provider_output"),
    });
    const copied = await attempts(job);
    expect(copied).toHaveLength(2);
    for (const attempt of copied) {
      const key = managedGenerationOutputKey({ organizationId: ORG, attemptId: attempt.id });
      expect(attempt).toMatchObject({ orchestrationState: "OUTPUT_VERIFIED", outputStorageKey: key });
      expect(Buffer.from((await shared().getObject(key)) ?? [])).toEqual(CLIP);
    }

    // Nothing was left at the provider boundary for maintenance to find. Its
    // stale and exhaustion paths are `reconciliation.db.test.ts`'s.
    const maintained = await steps.reconciliation.runOnce({
      limit: 10,
      context: developmentPipelineContext("reconciliation"),
    });
    expect([maintained.staleCandidates, maintained.dueCandidates]).toEqual([0, 0]);
  });

  it("gives the Unit back when the test provider cannot make a clip", async () => {
    render = "FAIL";
    const job = await start();
    const steps = pipeline();
    expect((await steps.launch.runOnce(10)).launched).toBe(1);

    // The first scene's clip is not made, so the provider refuses it; the job
    // is then ending, and its second scene is not sent.
    const sent = await steps.submission.runOnce(10);
    expect(sent.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "SENT", observed: "DEFINITIVELY_REJECTED", recorded: "APPLIED", safetyGuardWarning: false },
      { kind: "NOT_SENT", reason: "JOB_ENDING" },
    ]);
    expect(made).toEqual([PHOTO]);

    const before = Date.now();
    const settled = await steps.attemptFailureSettlement.runOnce(10);
    expect([settled.settled, settled.unitsReleased, settled.failed]).toEqual([1, 1, 0]);
    const closed = await steps.failedJobSceneClosure.runOnce(10);
    expect([closed.closed, closed.attemptsCancelled, closed.failed]).toEqual([1, 1, 0]);

    const ended = await prisma.generationJob.findUniqueOrThrow({ where: { id: job }, include: { reservation: true } });
    expect([ended.state, ended.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);
    // Both on the system clock: the Unit is released, and the second scene's
    // request fails, at the instant they ran.
    const closedRequest = await prisma.sceneGenerationRequest.findUniqueOrThrow({
      where: { id: "greq_itest_devpipe_2" },
    });
    for (const at of [ended.reservation?.releasedAt, closedRequest.failedAt]) {
      expect(at?.getTime()).toBeGreaterThanOrEqual(before);
      expect(at?.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect((await attempts(job)).map((attempt) => attempt.orchestrationState)).toEqual([
      "FAILED_TERMINAL",
      "CANCELLED_PRE_SUBMISSION",
    ]);
  });
});
