import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGenerationStartRepository,
  createPrismaStoryboardRepositories,
  createUnitEntitlementRepository,
} from "@app/database";
import {
  MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS,
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  buildAssetStorageKey,
  managedCleanMasterKey,
  managedDeliverableOutputKey,
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
import {
  pipelineExitCode,
  refuseForeignAttempts,
  runDevelopmentPipeline,
} from "../../apps/worker/src/development-pipeline/command";
import { ctx } from "./orchestration-fixture";

/**
 * The development pipeline's assembly against live PostgreSQL (GS-9b,
 * ADR-0106, ADR-0107): a job started by the real start commit is launched, its
 * scenes' photos are signed and sent to the test provider, each clip is copied
 * into the shared folder and validated, and the video is planned, composed with
 * its disclosure, validated and published, on the system clock and the billing
 * cycle's own revenue, as the pipeline command will run them.
 *
 * The steps run the machine's FFmpeg and ffprobe, which this suite's CI job
 * installs (ADR-0107). Where a test needs a clip it can control, a stand-in
 * clip maker keeps the photo it was given and writes a few bytes that are not
 * a video.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_devpipe";
const USER = "usr_itest_devpipe";
const PROPERTY = "prp_itest_devpipe";
const ASSET = "ast_itest_devpipe";
const PROJECT = "vpr_itest_devpipe";
const FINGERPRINT = "sha256:devpipe";
const SECRET = "development-pipeline-signing-secret-0123";
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
/** The scene's photo, as the web app stored it: a real JPEG, made once by FFmpeg. */
let PHOTO: Buffer;
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

/** The steps, with the stand-in clip maker or FFmpeg's. */
function pipeline(clips: "STAND_IN" | "FFMPEG" = "STAND_IN"): DevelopmentPipeline {
  return assembleDevelopmentPipeline(
    {
      NODE_ENV: "test",
      VIDEO_PROVIDER: "fake",
      SHARED_STORAGE_DIR: join(dir, "shared"),
      STORAGE_SIGNING_SECRET: SECRET,
    },
    { providerFolder: join(dir, "provider") },
    clips === "STAND_IN" ? { prisma, renderer } : { prisma },
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
  const versions = { deliverableVersion: { generationJobId: { in: jobs } } };
  // Every pointer and history row is RESTRICT, so each goes before what it names.
  await prisma.generationScene.updateMany({
    where: { generationJobId: { in: jobs } },
    data: { currentDeliveredRequestId: null },
  });
  await prisma.generationJob.updateMany({ where: { id: { in: jobs } }, data: { currentDeliverableVersionId: null } });
  await prisma.generationTransitionEvent.deleteMany({ where: { organizationId: ORG } });
  await prisma.generationPricingSnapshot.deleteMany({ where: { sceneGeneration: scope } });
  await prisma.generationDeliverableInput.deleteMany({ where: versions });
  await prisma.generationDeliverableComposition.deleteMany({ where: versions });
  await prisma.generationDeliverableValidation.deleteMany({ where: versions });
  await prisma.generationDeliverableCleanMaster.deleteMany({ where: versions });
  await prisma.generationDeliverableVersion.deleteMany({ where: { generationJobId: { in: jobs } } });
  await prisma.managedOutputMediaFailureResolution.deleteMany({ where: { validation: { sceneGeneration: scope } } });
  await prisma.managedOutputMediaValidation.deleteMany({ where: { sceneGeneration: scope } });
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
  if (!HAS_DB) return;
  const photo = join(dir, "photo.jpg");
  await promisify(execFile)("ffmpeg", [
    ...["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720"],
    ...["-frames:v", "1", photo],
  ]);
  PHOTO = await readFile(photo);
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

  it("makes the video: validates each clip, delivers the scenes, composes, validates and publishes", async () => {
    const job = await start();
    const before = Date.now();
    const steps = pipeline("FFMPEG");
    expect((await steps.launch.runOnce(10)).launched).toBe(1);
    expect((await steps.submission.runOnce(10)).sent).toBe(2);
    await steps.providerOutput.runProviderOutputBatchOnce({
      limit: 10,
      context: developmentPipelineContext("provider_output"),
    });

    // Each clip FFmpeg made from the photo is read back from the folder and found usable.
    const validated = await steps.mediaValidation.runOnce(10);
    expect(validated.outcomes.map(({ outcome }) => outcome)).toEqual([{ kind: "VALID" }, { kind: "VALID" }]);
    const delivered = await steps.sceneDelivery.runOnce(10);
    expect([delivered.delivered, delivered.jobsAdvanced]).toEqual([2, 1]);
    const planned = await steps.compositionPlan.runOnce(10);
    expect([planned.planned, planned.failed]).toEqual([1, 0]);
    const plan = planned.outcomes[0]?.outcome;
    if (plan?.kind !== "PLANNED") throw new Error(`plan: ${plan?.kind}`);
    const version = plan.deliverableVersionId;
    expect(version).toMatch(/^gdv_[\w-]{16}$/);
    const composed = await steps.composition.runOnce(10);
    expect(composed).toMatchObject({ claimed: 1, finalized: 1, deferred: 0, blocked: 0, failed: 0 });
    const published = await steps.deliverableValidation.runOnce(
      10,
      developmentPipelineContext("deliverable_validation"),
    );
    expect(published.outcomes).toEqual([
      { deliverableVersionId: version, outcome: { kind: "PUBLISHED_AND_CONSUMED" } },
    ]);

    const ended = await prisma.generationJob.findUniqueOrThrow({ where: { id: job }, include: { reservation: true } });
    expect([ended.state, ended.reservation?.state, ended.currentDeliverableVersionId]).toEqual([
      "DELIVERABLE_READY",
      "CONSUMED",
      version,
    ]);
    // Every verdict and the Unit's use, on the system clock.
    const verdicts = await prisma.managedOutputMediaValidation.findMany({
      where: { sceneGeneration: { videoProject: { organizationId: ORG } } },
    });
    const where = { deliverableVersionId: version };
    const composition = await prisma.generationDeliverableComposition.findUniqueOrThrow({ where });
    const receipt = await prisma.generationDeliverableCleanMaster.findUniqueOrThrow({ where });
    const checked = await prisma.generationDeliverableValidation.findUniqueOrThrow({ where });
    for (const at of [
      ...verdicts.map((v) => v.validatedAt),
      composition.outputVerifiedAt,
      receipt.verifiedAt,
      checked.validatedAt,
      ended.reservation?.consumedAt,
    ]) {
      expect(at?.getTime()).toBeGreaterThanOrEqual(before);
      expect(at?.getTime()).toBeLessThanOrEqual(Date.now());
    }

    // The video, with its disclosure, and its Clean Master are both in the folder.
    const keys = { organizationId: ORG, deliverableVersionId: version };
    const video = await shared().getObject(managedDeliverableOutputKey(keys));
    const master = await shared().getObject(managedCleanMasterKey(keys));
    expect([video === null, master === null]).toEqual([false, false]);
    expect(Buffer.from(video!).equals(Buffer.from(master!))).toBe(false);
    // Each receipt describes the bytes stored, and the Clean Master is signed for
    // no one. The disclosure's pixels are the media suite's to prove
    // (`composition-runner.media.test.ts`).
    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect([composition.outputSha256, receipt.sha256]).toEqual([sha(video!), sha(master!)]);
    await expect(shared().createSignedDownloadUrl(managedCleanMasterKey(keys), 60)).rejects.toThrow();
    const path = join(dir, "video.mp4");
    await writeFile(path, video!);
    const { stdout } = await promisify(execFile)("ffprobe", [
      ...["-v", "error", "-select_streams", "v:0", "-of", "json"],
      ...["-show_entries", "stream=width,height:format=duration", path],
    ]);
    const probed = JSON.parse(stdout) as { streams: { width: number; height: number }[]; format: { duration: string } };
    expect(probed.streams).toEqual([{ width: 1280, height: 720 }]);
    expect(Number(probed.format.duration)).toBeCloseTo(10, 0);
  }, 180_000);

  it("recovers an unusable clip once, then gives the Unit back", async () => {
    const job = await start();
    const steps = pipeline();
    expect((await steps.launch.runOnce(10)).launched).toBe(1);
    const round = async () => {
      expect((await steps.submission.runOnce(10)).sent).toBe(2);
      await steps.providerOutput.runProviderOutputBatchOnce({
        limit: 10,
        context: developmentPipelineContext("provider_output"),
      });
      // The stand-in's bytes are not a video, and ffprobe says so.
      const validated = await steps.mediaValidation.runOnce(10);
      expect(validated.outcomes.map(({ outcome }) => outcome)).toEqual([
        { kind: "INVALID_MEDIA" },
        { kind: "INVALID_MEDIA" },
      ]);
      return steps.mediaFailureResolution.runOnce(10);
    };

    // Each scene's first failure is retried once, priced on the test route.
    const first = await round();
    expect([first.claimed, first.recovered, first.settled, first.deferred]).toEqual([2, 2, 0, 0]);
    const recoveries = await prisma.sceneGeneration.findMany({
      where: { videoProject: { organizationId: ORG }, attemptKind: "SYSTEM_RECOVERY" },
      include: { pricingSnapshot: true },
    });
    expect(recoveries.map((r) => [r.attemptOrdinal, r.pricingSnapshot === null])).toEqual([
      [2, false],
      [2, false],
    ]);

    // The retry fails too, so the job fails and the Unit comes back.
    const before = Date.now();
    const second = await round();
    expect([second.claimed, second.recovered, second.settled, second.deferred]).toEqual([2, 0, 1, 0]);
    // One scene's failure settles the job. The other's is owed nothing yet, so
    // it is handed back for five minutes, and no third attempt is made.
    const kinds = second.outcomes.map(({ result }) =>
      result.kind === "SETTLEMENT" ? result.outcome.kind : result.kind,
    );
    expect(kinds.sort()).toEqual(["NOT_EXHAUSTED", "SETTLED"]);
    const recovering = { videoProject: { organizationId: ORG }, attemptKind: "SYSTEM_RECOVERY" as const };
    expect(await prisma.sceneGeneration.count({ where: recovering })).toBe(2);
    // The retry is the same request, so the test provider answers it with the clip it made first.
    expect(made).toEqual([PHOTO, PHOTO]);
    const ended = await prisma.generationJob.findUniqueOrThrow({ where: { id: job }, include: { reservation: true } });
    expect([ended.state, ended.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);
    expect(ended.reservation?.releasedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(ended.reservation?.releasedAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const open = {
      status: "PENDING" as const,
      validation: { sceneGeneration: { videoProject: { organizationId: ORG } } },
    };
    const handedBack = await prisma.managedOutputMediaFailureResolution.findMany({ where: open });
    expect(handedBack).toHaveLength(1);
    const due = handedBack[0]!.nextAttemptAt!.getTime() - MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS;
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());

    // L closes the other scene, so its failure is owed nothing: when it is next
    // due, it is resolved without a retry.
    const closed = await steps.failedJobSceneClosure.runOnce(10);
    expect([closed.closed, closed.failed]).toEqual([1, 0]);
    await prisma.managedOutputMediaFailureResolution.updateMany({
      where: open,
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const third = await steps.mediaFailureResolution.runOnce(10);
    expect(third.outcomes.map(({ result }) => result)).toEqual([{ kind: "RESOLVED", resolutionKind: "OBSOLETE" }]);
    expect(await prisma.sceneGeneration.count({ where: recovering })).toBe(2);
  }, 60_000);

  it("the command runs every step until the video is published, then stops", async () => {
    const job = await start();
    const steps = pipeline("FFMPEG");
    const lines: number[] = [];
    const report = await runDevelopmentPipeline(steps, { limit: 10, maxCycles: 20 }, (cycle) => lines.push(cycle));

    expect([report.stop, pipelineExitCode(report)]).toEqual([{ kind: "QUIET" }, 0]);
    expect(lines).toEqual(Array.from({ length: report.cycles }, (_, index) => index + 1));
    const changed = Object.fromEntries(Object.entries(report.totals).map(([step, pass]) => [step, pass.changed]));
    expect(changed).toEqual({
      launch: 1,
      submission: 2,
      provider_output: 2,
      reconciliation: 0,
      attempt_failure_settlement: 0,
      failed_job_scene_closure: 0,
      media_validation: 2,
      media_failure_resolution: 0,
      scene_delivery: 2,
      composition_plan: 1,
      composition: 1,
      deliverable_validation: 1,
    });
    const ended = await prisma.generationJob.findUniqueOrThrow({ where: { id: job }, include: { reservation: true } });
    expect([ended.state, ended.reservation?.state]).toEqual(["DELIVERABLE_READY", "CONSUMED"]);

    // A second run finds nothing to do.
    const again = await runDevelopmentPipeline(steps, { limit: 10, maxCycles: 20 });
    expect([again.cycles, again.stop, pipelineExitCode(again)]).toEqual([1, { kind: "QUIET" }, 0]);
  }, 180_000);

  it("the command retries an unusable clip once, gives the Unit back, and stops", async () => {
    const job = await start();
    const report = await runDevelopmentPipeline(pipeline(), { limit: 10, maxCycles: 20 });

    expect([report.stop, pipelineExitCode(report)]).toEqual([{ kind: "QUIET" }, 0]);
    expect([report.totals.submission.changed, report.totals.media_validation.changed]).toEqual([4, 4]);
    const ended = await prisma.generationJob.findUniqueOrThrow({ where: { id: job }, include: { reservation: true } });
    expect([ended.state, ended.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);
    // The other scene's resolution is handed back for five minutes and waits
    // for a later run, which resolves it OBSOLETE; nothing it owes is money.
    const waiting = await prisma.managedOutputMediaFailureResolution.count({
      where: { status: "PENDING", validation: { sceneGeneration: { videoProject: { organizationId: ORG } } } },
    });
    expect(waiting).toBe(1);
  }, 60_000);

  it("refuses a database that holds another provider's attempts", async () => {
    await start();
    const steps = pipeline();
    await steps.launch.runOnce(10);
    await expect(refuseForeignAttempts(prisma)).resolves.toBeUndefined();
    await prisma.sceneGeneration.updateMany({
      where: { videoProject: { organizationId: ORG } },
      data: { providerName: "wavespeed" },
    });
    await expect(refuseForeignAttempts(prisma)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: "The development pipeline is refused: this database holds attempts of another provider",
    });
  });
});
