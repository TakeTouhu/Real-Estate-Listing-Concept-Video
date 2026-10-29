import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFailedJobSceneClosureRepository,
  createGenerationStartRepository,
  createJobLaunchRepository,
  createPrismaStoryboardRepositories,
  createSceneGenerationAttemptRepository,
  createUnitEntitlementRepository,
  createUnlaunchableJobEndingRepository,
} from "@app/database";
import {
  JobLaunchDefect,
  JobLaunchPlanner,
  JobLaunchRunner,
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  epochMillisFromDate,
  renderPrompt,
  type CompiledPrompt,
  type JobLaunchFacts,
  type JobLaunchPlan,
  type LaunchJobInput,
  type StoryboardScene,
} from "@app/domain";
import { createFakeRouteKit } from "@app/video-providers";
// Not published by the package: a test stands in for another writer admitting under a request's lock.
import { admitAttemptWithin } from "../../packages/database/src/orchestration-repositories";
import { ctx } from "./orchestration-fixture";

/**
 * The launch commit against live PostgreSQL (GS-7b, ADR-0095), and the ending
 * of a waiting job that can never launch (GS-7d-1, ADR-0099).
 *
 * Jobs are started by the real start commit, planned by the real planner on
 * the test route's kit, and launched by the runner and the commit. What only a
 * database can prove is here: that the job, its scenes and each first attempt
 * start in one commit or not at all; that the limit is read from the current
 * subscription and counted under the organization's launch lock, so two
 * launches at once never both take the last place; that the oldest waiting
 * job goes first, past a deleted Property's; and that a deletion in flight is
 * waited for and then refused. And that a job that can never launch fails and
 * its Units come back in one commit, behind the cost-admission lock, while one
 * that may yet launch, or may have reached the provider, is left as it is.
 *
 * Organization A is on Standard (one place), B on Premium (three), and C has
 * no subscription. Every video is 720p, so Normal.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_launch_a";
const ORG_B = "org_itest_launch_b";
const ORG_C = "org_itest_launch_c";
const ORGS = [ORG_A, ORG_B, ORG_C];
const USER = "usr_itest_launch";
const FINGERPRINT = "sha256:launch";

const NOVEMBER = { startsAt: new Date("2026-11-01T00:00:00.000Z"), endsAt: new Date("2026-12-01T00:00:00.000Z") };
const STARTED_AT = new Date("2026-11-10T00:00:00.000Z");
const LAUNCHED_AT = epochMillisFromDate(new Date("2026-11-10T01:00:00.000Z"));
const ENDED_AT = epochMillisFromDate(new Date("2026-11-10T02:00:00.000Z"));

type Tenant = { readonly property: string; readonly asset: string; readonly project: string };

/**
 * Each tenant's Property and photo, and four projects of it. Two jobs of one
 * project with one storyboard send identical requests, which the active-request
 * index never lets run at once, so a test starts each job of its own project
 * unless that is what it is about. A has a second Property for the deletion
 * cases.
 */
function projects(org: string): Tenant[] {
  return [1, 2, 3, 4].map((n) => ({
    property: `prp_itest_launch_${org}`,
    asset: `ast_itest_launch_${org}`,
    project: `vpr_itest_launch_${org}_${n}`,
  }));
}
const TENANT: Record<string, Tenant[]> = { [ORG_A]: projects("a"), [ORG_B]: projects("b"), [ORG_C]: projects("c") };
const SECOND: Tenant = {
  property: "prp_itest_launch_a2",
  asset: "ast_itest_launch_a2",
  project: "vpr_itest_launch_a2",
};

const prisma = new PrismaClient();
/** A second connection, to hold a lock while a launch runs. */
const holder = new PrismaClient();
const starts = createGenerationStartRepository(prisma);
const storyboards = createPrismaStoryboardRepositories(prisma);
const launches = createJobLaunchRepository(prisma);
const endings = createUnlaunchableJobEndingRepository(prisma);
const closures = createFailedJobSceneClosureRepository(prisma);
const entitlements = createUnitEntitlementRepository(prisma);
const attempts = createSceneGenerationAttemptRepository(prisma);

const kit = createFakeRouteKit({ NODE_ENV: "test", VIDEO_PROVIDER: "fake" });
const planner = new JobLaunchPlanner({
  routes: kit.routePolicy,
  models: kit.models,
  pricing: kit.pricing,
  fx: { current: async () => kit.fx },
  clock: () => LAUNCHED_AT,
});

let seq = 0;

function runner(using: Pick<JobLaunchPlanner, "plan"> = planner): JobLaunchRunner {
  return new JobLaunchRunner({
    repository: launches,
    ending: endings,
    planner: using,
    ids: { nextAttemptId: () => `sgen_launch_${++seq}`, nextPricingSnapshotId: () => `gps_launch_${++seq}` },
    context: () => ctx({ actorType: "WORKER", correlationId: `corr_launch_${++seq}` }),
    clock: () => ENDED_AT,
  });
}

function compiledPrompt(position: number): string {
  const prompt: CompiledPrompt = {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: { assetId: "ast_1", position, roomType: "LIVING_ROOM", durationSeconds: 5, cameraMotion: null },
    userCustomization: null,
    negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
  };
  return JSON.stringify(prompt);
}

async function seedTenant(organizationId: string, plan: "STANDARD" | "PREMIUM" | null): Promise<void> {
  await prisma.organization.create({ data: { id: organizationId, name: organizationId, slug: organizationId } });
  const tenants = [...TENANT[organizationId]!];
  if (organizationId === ORG_A) tenants.push(SECOND);
  for (const { property, asset, project } of tenants) {
    if ((await prisma.property.count({ where: { id: property } })) === 0) {
      await prisma.property.create({
        data: { id: property, organizationId, name: "Launch fixture", propertyType: "APARTMENT", createdBy: USER },
      });
      await prisma.mediaAsset.create({
        data: {
          id: asset,
          organizationId,
          propertyId: property,
          storageKey: `org/${organizationId}/${asset}.jpg`,
          originalFilename: "seed.jpg",
          status: "READY",
          createdBy: USER,
        },
      });
    }
    await prisma.videoProject.create({
      data: {
        id: project,
        organizationId,
        propertyId: property,
        name: "Walkthrough",
        durationSeconds: 30,
        aspectRatio: "16:9",
        targetOutputResolution: "720p",
        createdBy: USER,
      },
    });
    const scenes: Omit<StoryboardScene, "createdAt" | "updatedAt">[] = [1, 2].map((position) => ({
      id: `sbs_${project}_${position}`,
      videoProjectId: project,
      propertyId: property,
      assetId: asset,
      position,
      roomType: "LIVING_ROOM",
      durationSeconds: 5,
      cameraMotion: null,
      compiledPrompt: compiledPrompt(position),
      sourceAnalysisRevision: 2,
    }));
    await storyboards.scenes.saveComposition(organizationId, project, { scenes, compositionFingerprint: FINGERPRINT });
  }
  const opened = await entitlements.openPeriod({
    id: `uep_itest_launch_${organizationId}`,
    organizationId,
    planKey: plan === "PREMIUM" ? "premium" : "standard",
    billingCycleKey: "2026-11",
    startsAt: NOVEMBER.startsAt,
    endsAt: NOVEMBER.endsAt,
    commercialReference: null,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
  if (plan !== null) {
    await prisma.organizationSubscription.create({
      data: {
        id: `sub_itest_launch_${organizationId}`,
        organizationId,
        planKey: plan,
        channel: "SALES_ASSISTED",
        anchorAt: NOVEMBER.startsAt,
        commercialReference: `contract-${organizationId}`,
      },
    });
  }
}

/**
 * Start one job through the start commit, of the organization's project
 * `which` (a project of its own, by default its minute's), its age fixed by
 * `minute`.
 */
async function startJob(organizationId: string, minute: number, which: Tenant | number = minute): Promise<string> {
  const tenant = typeof which === "number" ? TENANT[organizationId]![(which - 1) % 4]! : which;
  seq += 1;
  const n = seq;
  const outcome = await starts.start({
    organizationId,
    videoProjectId: tenant.project,
    idempotencyKey: `launch-start-${n}`,
    jobId: `genjob_launch_${n}`,
    reservationId: `genres_launch_${n}`,
    requestedByUserId: USER,
    qualityTier: "NORMAL",
    disclosureMode: "THROUGHOUT",
    startedAt: STARTED_AT,
    storyboard: {
      compositionFingerprint: FINGERPRINT,
      scenes: [1, 2].map((position) => ({
        storyboardSceneId: `sbs_${tenant.project}_${position}`,
        generationSceneId: `genscene_launch_${n}_${position}`,
        initialRequestId: `genreq_launch_${n}_${position}`,
      })),
    },
    context: ctx({ actorType: "USER", actorUserId: USER, eventType: "GENERATION_STARTED" }),
    audit: (started) => ({
      organizationId,
      actorUserId: USER,
      action: "generation.started",
      resourceType: "generation_job",
      resourceId: started.job.id,
      metadata: { sceneCount: started.sceneCount },
    }),
  });
  if (outcome.kind !== "STARTED") throw new Error(`start: ${outcome.kind}`);
  await prisma.generationJob.update({
    where: { id: outcome.job.id },
    data: { createdAt: new Date(Date.UTC(2026, 10, 10, 0, minute)) },
  });
  return outcome.job.id;
}

/** The planner's facts for a job, read as the candidate query reads them. */
async function factsOf(generationJobId: string): Promise<JobLaunchFacts> {
  const job = await prisma.generationJob.findUniqueOrThrow({
    where: { id: generationJobId },
    include: { scenes: { orderBy: { position: "asc" }, include: { requests: true } } },
  });
  return {
    qualityTier: job.qualityTier,
    targetOutputResolution: job.targetOutputResolution,
    aspectRatio: job.targetAspectRatio,
    scenes: job.scenes.map((scene) => ({
      generationSceneId: scene.id,
      initialRequestId: scene.requests[0]!.id,
      durationSeconds: scene.snapshotDurationSeconds,
      cameraMotion: scene.snapshotCameraMotion,
      compiledPrompt: scene.snapshotCompiledPrompt,
    })),
  };
}

async function planned(facts: JobLaunchFacts): Promise<Extract<JobLaunchPlan, { kind: "PLANNED" }>> {
  const plan = await planner.plan(facts);
  if (plan.kind !== "PLANNED") throw new Error(`plan: ${plan.code}`);
  return plan;
}

/** A launch commit of one job, planned from its own facts unless told otherwise. */
async function commitInput(
  organizationId: string,
  generationJobId: string,
  overrides: Partial<LaunchJobInput> = {},
): Promise<LaunchJobInput> {
  const facts = overrides.facts ?? (await factsOf(generationJobId));
  const plan = overrides.plan ?? (await planned(facts));
  return {
    organizationId,
    generationJobId,
    facts,
    plan,
    attemptIds: plan.scenes.map(() => ({
      attemptId: `sgen_launch_${++seq}`,
      pricingSnapshotId: `gps_launch_${++seq}`,
    })),
    context: ctx({ actorType: "WORKER", correlationId: "corr_launch_commit" }),
    ...overrides,
  };
}

async function jobState(generationJobId: string): Promise<string> {
  return (await prisma.generationJob.findUniqueOrThrow({ where: { id: generationJobId } })).state;
}

/** Everything a launch could write, for every tenant. */
async function written(): Promise<Record<string, unknown>> {
  const jobs = await prisma.generationJob.findMany({
    where: { videoProject: { organizationId: { in: ORGS } } },
    orderBy: { id: "asc" },
    select: { id: true, state: true, stateVersion: true },
  });
  const jobIds = jobs.map((job) => job.id);
  return {
    jobs,
    reservations: await prisma.generationReservation.findMany({
      where: { generationJobId: { in: jobIds } },
      orderBy: { id: "asc" },
      select: { state: true, stateVersion: true },
    }),
    scenes: await prisma.generationScene.findMany({
      where: { generationJobId: { in: jobIds } },
      orderBy: { id: "asc" },
      select: { state: true, stateVersion: true },
    }),
    requests: await prisma.sceneGenerationRequest.findMany({
      where: { generationScene: { generationJobId: { in: jobIds } } },
      orderBy: { id: "asc" },
      select: { state: true, stateVersion: true },
    }),
    attempts: await prisma.sceneGeneration.count({ where: { videoProject: { organizationId: { in: ORGS } } } }),
    snapshots: await prisma.generationPricingSnapshot.count({
      where: { sceneGeneration: { videoProject: { organizationId: { in: ORGS } } } },
    }),
    events: await prisma.generationTransitionEvent.count({ where: { organizationId: { in: ORGS } } }),
  };
}

async function cleanup(): Promise<void> {
  const jobs = await prisma.generationJob.findMany({
    where: { videoProject: { organizationId: { in: ORGS } } },
    select: { id: true },
  });
  const jobIds = jobs.map((job) => job.id);
  await prisma.generationTransitionEvent.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.generationPricingSnapshot.deleteMany({
    where: { sceneGeneration: { videoProject: { organizationId: { in: ORGS } } } },
  });
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId: { in: ORGS } } } });
  await prisma.sceneGenerationRequest.deleteMany({ where: { generationScene: { generationJobId: { in: jobIds } } } });
  await prisma.generationScene.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationReservationAllocation.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.generationReservation.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId: { in: ORGS } } } });
  await prisma.videoProject.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.organization.deleteMany({ where: { id: { in: ORGS } } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, "STANDARD");
  await seedTenant(ORG_B, "PREMIUM");
  await seedTenant(ORG_C, null);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
  await holder.$disconnect();
});

/** Resolves once, when `promise` settles; never rejects. */
function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

/** Whether another backend is waiting on a lock within the deadline: the database says so. */
async function waitForBlocked(withinMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (rows.some((row) => row.wait_event_type === "Lock")) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Run `body` on the second connection and keep its transaction open until `release`. */
async function holdOpen(body: (tx: Tx) => Promise<void>): Promise<{ release: () => Promise<void> }> {
  let mayFinish!: () => void;
  const held = new Promise<void>((resolve) => {
    mayFinish = resolve;
  });
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const locked = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = holder
    .$transaction(
      async (tx) => {
        await body(tx);
        ready();
        await held;
      },
      { timeout: 20_000 },
    )
    .catch((error: unknown) => failed(error));
  await locked;
  return {
    release: async () => {
      mayFinish();
      await done;
    },
  };
}

describe.skipIf(!HAS_DB)("a launch", () => {
  it("starts the job and its scenes and admits each scene's first attempt, in one commit", async () => {
    const job = await startJob(ORG_A, 1);
    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: job } });

    const report = await runner().runOnce(10);
    expect(report.launched).toBe(1);
    expect(report.outcomes.map((entry) => [entry.organizationId, entry.generationJobId, entry.outcome.kind])).toEqual([
      [ORG_A, job, "LAUNCHED"],
    ]);

    const row = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job },
      include: {
        reservation: true,
        scenes: {
          orderBy: { position: "asc" },
          include: { requests: { include: { attempts: { include: { pricingSnapshot: true } } } } },
        },
      },
    });
    expect([row.state, row.stateVersion]).toEqual(["GENERATING", 3]);
    // The launch reads the reservation and never writes it.
    expect(row.reservation).toEqual(reservation);
    for (const scene of row.scenes) {
      expect([scene.state, scene.stateVersion]).toEqual(["GENERATING", 1]);
      const [request] = scene.requests;
      expect([scene.requests.length, request!.state, request!.stateVersion]).toEqual([1, "GENERATING", 1]);
      const [attempt] = request!.attempts;
      expect(request!.attempts).toHaveLength(1);
      expect(attempt).toMatchObject({
        orchestrationState: "QUEUED",
        attemptKind: "PRIMARY",
        attemptOrdinal: 1,
        providerName: "fake",
        requestModelKey: "fake-zoom-pan",
        requestNativeGenerationResolution: "720p",
        requestCompiledPrompt: scene.snapshotCompiledPrompt,
        requestRenderedPrompt: renderPrompt(scene.snapshotCompiledPrompt!),
        requestDurationSeconds: 5,
      });
      expect(attempt!.pricingSnapshot).toMatchObject({ provider: "fake", requestedSeconds: 5 });
    }

    const events = await prisma.generationTransitionEvent.findMany({
      where: { organizationId: ORG_A, eventType: { not: "GENERATION_STARTED" } },
      orderBy: [{ aggregateType: "asc" }, { aggregateId: "asc" }, { sequence: "asc" }],
      select: { aggregateType: true, fromState: true, toState: true, eventType: true, reasonCode: true },
    });
    const launched = (aggregateType: string, fromState: string | null, toState: string, eventType: string) => ({
      aggregateType,
      fromState,
      toState,
      eventType,
      reasonCode: "JOB_LAUNCH",
    });
    // In the aggregate type's declared order.
    expect(events).toEqual([
      launched("JOB", "RESERVED", "GENERATING", "job.launched"),
      launched("SCENE", "PENDING", "GENERATING", "scene.launched"),
      launched("SCENE", "PENDING", "GENERATING", "scene.launched"),
      launched("SCENE_REQUEST", "PENDING", "GENERATING", "attempt.admitted_at_launch"),
      launched("SCENE_REQUEST", "PENDING", "GENERATING", "attempt.admitted_at_launch"),
      launched("ATTEMPT", null, "QUEUED", "attempt.admitted_at_launch"),
      launched("ATTEMPT", null, "QUEUED", "attempt.admitted_at_launch"),
    ]);
  });

  it("admits attempts the provider boundary accepts as priced", async () => {
    const job = await startJob(ORG_A, 1);
    await runner().runOnce(10);
    const queued = await prisma.sceneGeneration.findMany({
      where: { generationSceneRequest: { generationScene: { generationJobId: job } } },
    });
    expect(queued).toHaveLength(2);
    for (const attempt of queued) {
      const armed = await attempts.armProviderBoundary({
        organizationId: ORG_A,
        id: attempt.id,
        expectedVersion: attempt.stateVersion,
        context: ctx(),
      });
      expect(armed.kind).toBe("ARMED");
    }
  });

  it("leaves nothing to launch once the job runs", async () => {
    await startJob(ORG_A, 1);
    await runner().runOnce(10);
    const before = await written();
    expect(await runner().runOnce(10)).toEqual({ launched: 0, ended: 0, failed: 0, outcomes: [] });
    expect(await written()).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("the concurrent-job limit", () => {
  it("runs one Standard job at a time; the next waits with its Units held", async () => {
    const first = await startJob(ORG_A, 1);
    const second = await startJob(ORG_A, 2);
    expect((await runner().runOnce(10)).launched).toBe(1);
    expect([await jobState(first), await jobState(second)]).toEqual(["GENERATING", "RESERVED"]);

    // The candidate query no longer offers it, and the commit refuses it.
    expect((await runner().runOnce(10)).outcomes).toEqual([]);
    const before = await written();
    expect(await launches.launchJob(await commitInput(ORG_A, second))).toEqual({ kind: "AT_LIMIT" });
    expect(await written()).toEqual(before);
    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: second } });
    expect(reservation.state).toBe("RESERVED");
  });

  it("runs three Premium jobs at once, oldest first, and holds the fourth", async () => {
    const jobs: string[] = [];
    for (const minute of [4, 2, 3, 1]) jobs.push(await startJob(ORG_B, minute));
    const order: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      for (const entry of (await runner().runOnce(10)).outcomes) {
        if (entry.outcome.kind === "LAUNCHED") order.push(entry.generationJobId);
      }
    }
    expect(order).toEqual([jobs[3], jobs[1], jobs[2]]);
    expect(await jobState(jobs[0]!)).toBe("RESERVED");
  });

  it("frees a place when a running job ends", async () => {
    const first = await startJob(ORG_A, 1);
    const second = await startJob(ORG_A, 2);
    await runner().runOnce(10);
    await prisma.generationJob.update({ where: { id: first }, data: { state: "FAILED_TERMINAL" } });
    expect((await runner().runOnce(10)).outcomes.map((entry) => entry.generationJobId)).toEqual([second]);
    expect(await jobState(second)).toBe("GENERATING");
  });

  it("is the current subscription's, so a plan raised since the start raises it at once", async () => {
    await startJob(ORG_A, 1);
    const second = await startJob(ORG_A, 2);
    await runner().runOnce(10);
    expect(await launches.launchJob(await commitInput(ORG_A, second))).toEqual({ kind: "AT_LIMIT" });
    await prisma.organizationSubscription.update({ where: { organizationId: ORG_A }, data: { planKey: "PREMIUM" } });
    expect((await runner().runOnce(10)).launched).toBe(1);
    expect(await jobState(second)).toBe("GENERATING");
  });

  it("counts only the organization's own jobs", async () => {
    await startJob(ORG_B, 1);
    expect((await runner().runOnce(10)).launched).toBe(1);
    const job = await startJob(ORG_A, 2);
    expect((await runner().runOnce(10)).outcomes).toEqual([
      { organizationId: ORG_A, generationJobId: job, outcome: expect.objectContaining({ kind: "LAUNCHED" }) },
    ]);
  });

  it("launches nothing for an organization with no subscription", async () => {
    const job = await startJob(ORG_C, 1);
    expect((await runner().runOnce(10)).outcomes).toEqual([]);
    const before = await written();
    expect(await launches.launchJob(await commitInput(ORG_C, job))).toEqual({ kind: "NO_SUBSCRIPTION" });
    expect(await written()).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("the same video started twice", () => {
  it("waits, whole, until the first one's identical requests end", async () => {
    const first = await startJob(ORG_B, 1, 1);
    const second = await startJob(ORG_B, 2, 1);
    await runner().runOnce(10);
    expect(await jobState(first)).toBe("GENERATING");

    const before = await written();
    expect((await runner().runOnce(10)).outcomes).toEqual([
      { organizationId: ORG_B, generationJobId: second, outcome: { kind: "SAME_REQUEST_RUNNING" } },
    ]);
    expect(await written()).toEqual(before);

    await prisma.sceneGeneration.updateMany({
      where: { generationSceneRequest: { generationScene: { generationJobId: first } } },
      data: { orchestrationState: "CANCELLED_PRE_SUBMISSION" },
    });
    expect((await runner().runOnce(10)).launched).toBe(1);
    expect(await jobState(second)).toBe("GENERATING");
  });
});

describe.skipIf(!HAS_DB)("oldest first", () => {
  it("refuses a newer job while an older one waits, and launches the older", async () => {
    const older = await startJob(ORG_A, 1);
    const newer = await startJob(ORG_A, 2);
    const before = await written();
    expect(await launches.launchJob(await commitInput(ORG_A, newer))).toEqual({ kind: "NOT_NEXT" });
    expect(await written()).toEqual(before);
    expect((await runner().runOnce(10)).outcomes.map((entry) => entry.generationJobId)).toEqual([older]);
  });

  it("offers organizations by their oldest waiting job, as many as the pass's limit", async () => {
    const older = await startJob(ORG_B, 1);
    await startJob(ORG_A, 2);
    expect((await runner().runOnce(1)).outcomes.map((entry) => entry.generationJobId)).toEqual([older]);
  });

  it("passes over a deleted Property's job to the next one, and ends it", async () => {
    const deleted = await startJob(ORG_A, 1, SECOND);
    const next = await startJob(ORG_A, 2);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    expect((await runner().runOnce(10)).outcomes.map((entry) => [entry.generationJobId, entry.outcome.kind])).toEqual([
      [deleted, "ENDED"],
      [next, "LAUNCHED"],
    ]);
    expect(await jobState(deleted)).toBe("FAILED_TERMINAL");
  });

  it("never launches a deleted Property's job", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    expect(await launches.findJobLaunchCandidates({ limit: 10 })).toEqual([]);
    const before = await written();
    expect(await launches.launchJob(await commitInput(ORG_A, job))).toEqual({
      kind: "NOT_LAUNCHABLE",
      reason: "PROPERTY_DELETED",
    });
    expect(await written()).toEqual(before);
  });

  it("waits for a deletion already saving, then refuses the job", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    const deletion = await holdOpen(async (tx) => {
      await tx.property.update({ where: { id: TENANT[ORG_A]![0]!.property }, data: { status: "DELETED" } });
    });
    const launch = settled(launches.launchJob(input));
    expect(await waitForBlocked()).toBe(true);
    expect(launch.done()).toBe(false);
    await deletion.release();
    expect(await launch.value).toEqual({ kind: "NOT_LAUNCHABLE", reason: "PROPERTY_DELETED" });
    expect(await jobState(job)).toBe("RESERVED");
  });
});

describe.skipIf(!HAS_DB)("a refused launch", () => {
  it("writes nothing when the rows hold other facts than the plan's", async () => {
    const job = await startJob(ORG_A, 1);
    const actual = await factsOf(job);
    const other: JobLaunchFacts = {
      ...actual,
      scenes: actual.scenes.map((scene, i) => (i === 1 ? { ...scene, compiledPrompt: compiledPrompt(9) } : scene)),
    };
    const before = await written();
    const input = await commitInput(ORG_A, job, { facts: other, plan: await planned(other) });
    expect(await launches.launchJob(input)).toEqual({
      kind: "NOT_LAUNCHABLE",
      reason: "FACTS_CHANGED",
    });
    expect(await written()).toEqual(before);
  });

  it("writes nothing for a job another writer moved", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    await prisma.generationScene.update({
      where: { id: input.facts.scenes[1]!.generationSceneId },
      data: { state: "GENERATING" },
    });
    const before = await written();
    expect(await launches.launchJob(input)).toEqual({ kind: "NOT_LAUNCHABLE", reason: "SHAPE_CONFLICT" });
    expect(await written()).toEqual(before);
  });

  it("writes nothing for a job whose Units are no longer held", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    await prisma.generationReservation.update({ where: { generationJobId: job }, data: { state: "RELEASED" } });
    const before = await written();
    expect(await launches.launchJob(input)).toEqual({ kind: "NOT_LAUNCHABLE", reason: "SHAPE_CONFLICT" });
    expect(await written()).toEqual(before);
  });

  it("writes nothing for a job whose first request already has an attempt", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    await runner().runOnce(10);
    // Every row put back as the start left it but the attempts, which ended.
    await prisma.sceneGeneration.updateMany({
      where: { generationSceneRequest: { generationScene: { generationJobId: job } } },
      data: { orchestrationState: "CANCELLED_PRE_SUBMISSION" },
    });
    await prisma.sceneGenerationRequest.updateMany({
      where: { generationScene: { generationJobId: job } },
      data: { state: "PENDING" },
    });
    await prisma.generationScene.updateMany({ where: { generationJobId: job }, data: { state: "PENDING" } });
    await prisma.generationJob.update({ where: { id: job }, data: { state: "RESERVED" } });
    const before = await written();
    expect(await launches.launchJob(input)).toEqual({ kind: "NOT_LAUNCHABLE", reason: "SHAPE_CONFLICT" });
    expect(await written()).toEqual(before);
  });

  it("is not even planned when a scene has a second request", async () => {
    const job = await startJob(ORG_A, 1);
    const facts = await factsOf(job);
    await prisma.sceneGenerationRequest.create({
      data: {
        id: "genreq_launch_extra",
        generationSceneId: facts.scenes[0]!.generationSceneId,
        kind: "USER_REGENERATION",
        userRegenerationOrdinal: 1,
        state: "PENDING",
      },
    });
    expect(await launches.findJobLaunchCandidates({ limit: 10 })).toEqual([
      { organizationId: ORG_A, generationJobId: job, facts: null },
    ]);
    const report = await runner().runOnce(10);
    expect(report.outcomes.map((entry) => entry.outcome)).toEqual([{ kind: "ENDED", cause: "SHAPE_CONFLICT" }]);
    expect(await jobState(job)).toBe("FAILED_TERMINAL");
  });

  it("answers another tenant's job as one it cannot see, and writes nothing", async () => {
    const job = await startJob(ORG_A, 1);
    const before = await written();
    expect(await launches.launchJob(await commitInput(ORG_B, job))).toEqual({
      kind: "NOT_LAUNCHABLE",
      reason: "NOT_WAITING",
    });
    expect(await written()).toEqual(before);
  });

  it("rolls back the job and every scene when one admission refuses", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    // The second scene priced for another length: admission's own binding refuses it.
    const plan = {
      ...input.plan,
      scenes: input.plan.scenes.map((scene, i) =>
        i === 1 ? { ...scene, pricingSnapshot: { ...scene.pricingSnapshot, requestedSeconds: 6 } } : scene,
      ),
    };
    const before = await written();
    const error = await launches.launchJob({ ...input, plan }).catch((thrown: unknown) => thrown);
    expect(error instanceof JobLaunchDefect ? error.code : error).toBe("ADMISSION_REFUSED");
    expect(await written()).toEqual(before);
  });

  it("refuses ids for another plan before opening a transaction", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    const error = await launches
      .launchJob({ ...input, attemptIds: input.attemptIds.slice(1) })
      .catch((thrown: unknown) => thrown);
    expect(error instanceof JobLaunchDefect ? error.code : error).toBe("ATTEMPT_IDS_NOT_FOR_PLAN");
    expect(await jobState(job)).toBe("RESERVED");
  });
});

describe.skipIf(!HAS_DB)("a job that can never launch", () => {
  const PERIOD = `uep_itest_launch_${ORG_A}`;
  const endInput = (organizationId: string, generationJobId: string) => ({
    organizationId,
    generationJobId,
    endedAt: ENDED_AT,
    context: ctx({ actorType: "WORKER", correlationId: "corr_launch_end" }),
  });

  it("fails and returns its Units in one commit when its Property is deleted; L then cancels its scenes", async () => {
    const unspent = await entitlements.balance(ORG_A, PERIOD);
    const job = await startJob(ORG_A, 1, SECOND);
    expect((await entitlements.balance(ORG_A, PERIOD))!.baseRemainingUnits).toBeLessThan(
      unspent!.baseRemainingUnits,
    );
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([
      { organizationId: ORG_A, generationJobId: job },
    ]);

    const report = await runner().runOnce(10);
    expect(report.outcomes).toEqual([
      { organizationId: ORG_A, generationJobId: job, outcome: { kind: "ENDED", cause: "PROPERTY_DELETED" } },
    ]);
    expect([report.ended, report.launched, report.failed]).toEqual([1, 0, 0]);

    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: job } });
    expect([await jobState(job), reservation.state, reservation.releasedAt?.getTime()]).toEqual([
      "FAILED_TERMINAL",
      "RELEASED",
      ENDED_AT,
    ]);
    expect(await entitlements.balance(ORG_A, PERIOD)).toEqual(unspent);
    const events = await prisma.generationTransitionEvent.findMany({
      where: { aggregateId: { in: [job, reservation.id] }, fromState: "RESERVED" },
      orderBy: { aggregateType: "asc" },
    });
    expect(
      events.map((e) => [e.organizationId, e.aggregateType, e.toState, e.eventType, e.reasonCode, e.actorType]),
    ).toEqual([
      [ORG_A, "JOB", "FAILED_TERMINAL", "job.ended_unlaunchable", "PROPERTY_DELETED", "WORKER"],
      [ORG_A, "RESERVATION", "RELEASED", "reservation.released", "PROPERTY_DELETED", "WORKER"],
    ]);
    expect(events.map((e) => e.correlationId)).toEqual([events[0]!.correlationId, events[0]!.correlationId]);
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([]);

    // The scenes and requests are left to Transaction L, which cancels them:
    // none of them ever started.
    const scenes = await prisma.generationScene.findMany({
      where: { generationJobId: job },
      include: { requests: true },
    });
    expect(scenes.flatMap((scene) => [scene.state, ...scene.requests.map((r) => r.state)])).toEqual(
      Array(4).fill("PENDING"),
    );
    const candidates = await closures.findFailedJobSceneCandidates({ limit: 10 });
    expect(candidates.map((c) => c.generationSceneId).sort()).toEqual(scenes.map((scene) => scene.id).sort());
    for (const candidate of candidates) {
      await closures.closeFailedJobScene({ ...candidate, closedAt: ENDED_AT, context: ctx({ actorType: "WORKER" }) });
    }
    const closed = await prisma.generationScene.findMany({
      where: { generationJobId: job },
      include: { requests: true },
    });
    expect(closed.flatMap((scene) => [scene.state, ...scene.requests.map((r) => r.state)])).toEqual(
      Array(4).fill("CANCELLED"),
    );
  });

  it.each([
    [null, "SCENE_PROMPT_MISSING"],
    ['{"shape":"old"}', "SCENE_PROMPT_UNRENDERABLE"],
  ])("ends the head of the queue when a scene's prompt is %s, and the next job launches", async (prompt, cause) => {
    const broken = await startJob(ORG_A, 1);
    const next = await startJob(ORG_A, 2);
    await prisma.generationScene.updateMany({
      where: { generationJobId: broken, position: 2 },
      data: { snapshotCompiledPrompt: prompt },
    });
    expect((await runner().runOnce(10)).outcomes).toEqual([
      { organizationId: ORG_A, generationJobId: broken, outcome: { kind: "ENDED", cause } },
    ]);
    expect((await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: broken } })).state).toBe(
      "RELEASED",
    );
    expect((await runner().runOnce(10)).outcomes.map((entry) => [entry.generationJobId, entry.outcome.kind])).toEqual([
      [next, "LAUNCHED"],
    ]);
  });

  it("leaves a job waiting for a rate as it is, its Units held", async () => {
    const job = await startJob(ORG_A, 1);
    const rateless = new JobLaunchPlanner({
      routes: kit.routePolicy,
      models: kit.models,
      pricing: kit.pricing,
      fx: { current: async () => null },
      clock: () => LAUNCHED_AT,
    });
    const before = await written();
    expect((await runner(rateless).runOnce(10)).outcomes.map((entry) => entry.outcome)).toEqual([
      { kind: "NOT_PLANNED", code: "NO_FX_RATE" },
    ]);
    expect(await written()).toEqual(before);
    expect(await jobState(job)).toBe("RESERVED");
  });

  it("writes nothing for a job that may launch, another tenant's, or one already launched", async () => {
    const job = await startJob(ORG_A, 1);
    const before = await written();
    expect(await endings.endUnlaunchableJob(endInput(ORG_A, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "LAUNCHABLE",
    });
    await prisma.property.update({ where: { id: TENANT[ORG_A]![0]!.property }, data: { status: "DELETED" } });
    expect(await endings.endUnlaunchableJob(endInput(ORG_B, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "NOT_WAITING",
    });
    await prisma.property.update({ where: { id: TENANT[ORG_A]![0]!.property }, data: { status: "ACTIVE" } });
    expect(await written()).toEqual(before);

    await runner().runOnce(10);
    const launched = await written();
    expect(await endings.endUnlaunchableJob(endInput(ORG_A, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "NOT_WAITING",
    });
    expect(await written()).toEqual(launched);
  });

  it("neither offers nor ends a deleted Property's job whose hold is not RESERVED", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    await prisma.generationReservation.update({
      where: { generationJobId: job },
      data: { state: "RECONCILIATION_HOLD" },
    });
    const before = await written();
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([]);
    expect(await endings.endUnlaunchableJob(endInput(ORG_A, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "RESERVATION_NOT_HELD",
    });
    expect(await written()).toEqual(before);
  });

  it("neither offers nor ends a deleted Property's job one of whose requests has an attempt", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    await runner().runOnce(10);
    // Every row put back as the start left it but the attempts, which ended.
    await prisma.sceneGeneration.updateMany({
      where: { generationSceneRequest: { generationScene: { generationJobId: job } } },
      data: { orchestrationState: "CANCELLED_PRE_SUBMISSION" },
    });
    await prisma.sceneGenerationRequest.updateMany({
      where: { generationScene: { generationJobId: job } },
      data: { state: "PENDING" },
    });
    await prisma.generationScene.updateMany({ where: { generationJobId: job }, data: { state: "PENDING" } });
    await prisma.generationJob.update({ where: { id: job }, data: { state: "RESERVED" } });
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    const before = await written();
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([]);
    expect(await endings.endUnlaunchableJob(endInput(ORG_A, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "ATTEMPT_ADMITTED",
    });
    expect(await written()).toEqual(before);
  });

  it("offers deleted Properties' jobs oldest first, as many as the limit", async () => {
    const newer = await startJob(ORG_A, 3, SECOND);
    const older = await startJob(ORG_B, 1);
    await startJob(ORG_A, 2);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    await prisma.property.update({ where: { id: TENANT[ORG_B]![0]!.property }, data: { status: "DELETED" } });
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([
      { organizationId: ORG_B, generationJobId: older },
      { organizationId: ORG_A, generationJobId: newer },
    ]);
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 1 })).toEqual([
      { organizationId: ORG_B, generationJobId: older },
    ]);
    await expect(endings.findPropertyDeletedWaitingJobs({ limit: 0 })).rejects.toThrow(/batch limit/);
  });

  it("waits for a deletion already saving, then ends the job", async () => {
    const job = await startJob(ORG_A, 1);
    const deletion = await holdOpen(async (tx) => {
      await tx.property.update({ where: { id: TENANT[ORG_A]![0]!.property }, data: { status: "DELETED" } });
    });
    const ending = settled(endings.endUnlaunchableJob(endInput(ORG_A, job)));
    expect(await waitForBlocked()).toBe(true);
    expect(ending.done()).toBe(false);
    await deletion.release();
    expect(await ending.value).toEqual({ kind: "ENDED", cause: "PROPERTY_DELETED" });
    expect(await jobState(job)).toBe("FAILED_TERMINAL");
  });

  it("waits for the cost-admission lock, taken before any row", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    // The lock's formula written out on purpose: if it changes, this stops blocking.
    const lock = await holdOpen(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`paid-submission:${ORG_A}`}),
          hashtext('cycle:2026-11')
        )::text AS locked`;
    });
    const ending = settled(endings.endUnlaunchableJob(endInput(ORG_A, job)));
    expect(await waitForBlocked()).toBe(true);
    expect(ending.done()).toBe(false);
    // No row of the job is locked while it waits.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "generation_reservations" WHERE "generationJobId" = ${job} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "generation_jobs" WHERE "id" = ${job} FOR UPDATE NOWAIT`;
    });
    await lock.release();
    expect(await ending.value).toEqual({ kind: "ENDED", cause: "PROPERTY_DELETED" });
  });

  it("neither offers nor ends a deleted Property's job that is no longer waiting", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    // Moved by another writer, its hold still held and nothing admitted.
    await prisma.generationJob.update({ where: { id: job }, data: { state: "GENERATING" } });
    const before = await written();
    expect(await endings.findPropertyDeletedWaitingJobs({ limit: 10 })).toEqual([]);
    expect(await endings.endUnlaunchableJob(endInput(ORG_A, job))).toEqual({
      kind: "NOT_ENDED",
      reason: "NOT_WAITING",
    });
    expect(await written()).toEqual(before);
  });

  it("counts an attempt admitted while it waited for a request's lock, and ends nothing", async () => {
    const job = await startJob(ORG_A, 1, SECOND);
    const { plan, attemptIds } = await commitInput(ORG_A, job);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    const admission = plan.scenes[0]!;
    // Another writer admitting under the request's lock, as the attempt repository's `admit` does.
    const admitting = await holdOpen(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "scene_generation_requests" WHERE "id" = ${admission.generationSceneRequestId} FOR UPDATE`;
      const admitted = await admitAttemptWithin(
        tx,
        ORG_A,
        {
          id: attemptIds[0]!.attemptId,
          generationSceneRequestId: admission.generationSceneRequestId,
          providerName: plan.route.providerName,
          providerModelId: plan.route.providerModelId,
          requestModelKey: plan.route.requestModelKey,
          requestRenderedPrompt: admission.requestRenderedPrompt,
          requestNativeGenerationResolution: plan.route.requestNativeGenerationResolution,
          requestResolutionNormalization: plan.route.requestResolutionNormalization,
          requestNativeMeetsTarget: plan.route.requestNativeMeetsTarget,
          pricingSnapshotId: attemptIds[0]!.pricingSnapshotId,
          pricingSnapshot: admission.pricingSnapshot,
          fxSnapshot: admission.fxSnapshot,
        },
        ctx({ actorType: "WORKER" }),
      );
      expect(admitted.kind).toBe("ADMITTED");
    });
    const ending = settled(endings.endUnlaunchableJob(endInput(ORG_A, job)));
    expect(await waitForBlocked()).toBe(true);
    expect(ending.done()).toBe(false);
    await admitting.release();
    expect(await ending.value).toEqual({ kind: "NOT_ENDED", reason: "ATTEMPT_ADMITTED" });
    expect(await jobState(job)).toBe("RESERVED");
    expect((await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: job } })).state).toBe(
      "RESERVED",
    );
  });

  it("and a launch of the same job, at once, each answer and leave the job one way", async () => {
    // Planned before its Property was deleted: only the ending writes.
    const deleted = await startJob(ORG_A, 1, SECOND);
    const stale = await commitInput(ORG_A, deleted);
    await prisma.property.update({ where: { id: SECOND.property }, data: { status: "DELETED" } });
    const [refused, ended] = await Promise.all([
      launches.launchJob(stale),
      endings.endUnlaunchableJob(endInput(ORG_A, deleted)),
    ]);
    expect(refused.kind).toBe("NOT_LAUNCHABLE");
    expect(ended).toEqual({ kind: "ENDED", cause: "PROPERTY_DELETED" });
    expect(await jobState(deleted)).toBe("FAILED_TERMINAL");

    // Launchable: only the launch writes.
    const job = await startJob(ORG_A, 2);
    const [launched, kept] = await Promise.all([
      launches.launchJob(await commitInput(ORG_A, job)),
      endings.endUnlaunchableJob(endInput(ORG_A, job)),
    ]);
    expect(launched.kind).toBe("LAUNCHED");
    expect(["LAUNCHABLE", "NOT_WAITING"]).toContain(kept.kind === "NOT_ENDED" ? kept.reason : kept.kind);
    expect(await jobState(job)).toBe("GENERATING");
    expect((await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: job } })).state).toBe(
      "RESERVED",
    );
  });
});

describe.skipIf(!HAS_DB)("two launches at once", () => {
  it("never both take the last place", async () => {
    await startJob(ORG_A, 1);
    await startJob(ORG_A, 2);
    const reports = await Promise.all([runner().runOnce(10), runner().runOnce(10)]);
    const kinds = reports.flatMap((report) => report.outcomes.map((entry) => entry.outcome.kind)).sort();
    expect(kinds).toEqual(["AT_LIMIT", "LAUNCHED"]);
    expect(
      await prisma.generationJob.count({ where: { state: "GENERATING", videoProject: { organizationId: ORG_A } } }),
    ).toBe(1);
  });

  it("wait for the organization's launch lock, taken before any row", async () => {
    const job = await startJob(ORG_A, 1);
    const input = await commitInput(ORG_A, job);
    // The lock's formula written out on purpose: if it changes, this stops blocking.
    const lock = await holdOpen(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`job-launch:${ORG_A}`}), hashtext('launch'))::text AS locked`;
    });
    const launch = settled(launches.launchJob(input));
    expect(await waitForBlocked()).toBe(true);
    expect(launch.done()).toBe(false);
    await lock.release();
    expect((await launch.value).kind).toBe("LAUNCHED");
  });
});
