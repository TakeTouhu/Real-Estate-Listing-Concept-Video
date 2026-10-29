import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  armProviderBoundaryWithin,
  createAttemptFailureSettlementRepository,
  createAttemptSubmissionRepository,
  createFailedJobSceneClosureRepository,
  createGenerationStartRepository,
  createJobLaunchRepository,
  createPaidSubmissionAuthorizationRepository,
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createSceneGenerationAttemptRepository,
  createSubmissionOutcomeRepository,
  createUnitEntitlementRepository,
  createUnlaunchableJobEndingRepository,
} from "@app/database";
import {
  AttemptFailureSettlementRunner,
  AttemptSubmissionRunner,
  FailedJobSceneClosureRunner,
  JobLaunchPlanner,
  JobLaunchRunner,
  PRESERVATION_RULES,
  PreflightRefusalError,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  createFixedAuthorizationClock,
  createPaidSubmissionAuthorizationService,
  createSubmissionOutcomeService,
  createSystemSubmissionClock,
  epochMillisFromDate,
  preparationRefusalEnding,
  prepareQueuedGeneration,
  validateReconciliationPolicy,
  yen,
  type AttemptSubmissionCursor,
  type CompiledPrompt,
  type ExecutionPreflightDeps,
  type PreflightRefusalReason,
  type SafeTransitionMetadata,
  type StoryboardScene,
  type Yen,
} from "@app/domain";
import {
  FakeVideoProvider,
  createFakeRouteKit,
  createPreparedGenerationSender,
  type FakeSubmissionOutcomeKind,
  type VideoGenerationSubmissionProvider,
} from "@app/video-providers";
import { ctx } from "./orchestration-fixture";

/**
 * The attempt submission's discovery, the ending of a refused preparation and
 * the sender, against live PostgreSQL (GS-7c-2a, ADR-0097; GS-7c-2b, ADR-0098),
 * and the ending of a deleted Property's attempts (GS-7d-2, ADR-0100).
 *
 * Jobs are started by the real start commit and launched by the real launch,
 * so every attempt here is one the product admits. What only a database can
 * prove is here: which attempts discovery offers, and in what order; that the
 * ending moves one `QUEUED` attempt of its own organization and nothing else;
 * that the attempt failure settlement then gives the Unit back; and that the
 * ending waits for the cost-admission lock and for a gate arm in flight, and
 * never ends an attempt the gate armed.
 *
 * Both organizations are on Premium (three jobs at once). Every video is 720p.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_submit_a";
const ORG_B = "org_itest_submit_b";
const ORGS = [ORG_A, ORG_B];
const USER = "usr_itest_submit";
const FINGERPRINT = "sha256:submit";
const CYCLE = "2026-11";

const NOVEMBER = { startsAt: new Date("2026-11-01T00:00:00.000Z"), endsAt: new Date("2026-12-01T00:00:00.000Z") };
const STARTED_AT = new Date("2026-11-10T00:00:00.000Z");
const LAUNCHED_AT = epochMillisFromDate(new Date("2026-11-10T01:00:00.000Z"));
const SETTLED_AT = epochMillisFromDate(new Date("2026-11-10T02:00:00.000Z"));

type Tenant = { readonly property: string; readonly asset: string; readonly project: string };

/** Projects 1 to 3 on the tenant's first Property, 4 on its second. */
function projects(org: string): Tenant[] {
  return [1, 2, 3, 4].map((n) => ({
    property: `prp_itest_submit_${org}_${n === 4 ? 2 : 1}`,
    asset: `ast_itest_submit_${org}_${n === 4 ? 2 : 1}`,
    project: `vpr_itest_submit_${org}_${n}`,
  }));
}
const TENANT: Record<string, Tenant[]> = { [ORG_A]: projects("a"), [ORG_B]: projects("b") };

const prisma = new PrismaClient();
/** A second connection, to hold a lock while an ending runs. */
const holder = new PrismaClient();
const starts = createGenerationStartRepository(prisma);
const storyboards = createPrismaStoryboardRepositories(prisma);
const attempts = createSceneGenerationAttemptRepository(prisma);
const submission = createAttemptSubmissionRepository(prisma);
const { assets } = createPrismaPropertyRepositories(prisma);

const kit = createFakeRouteKit({ NODE_ENV: "test", VIDEO_PROVIDER: "fake" });

let seq = 0;

function launcher(): JobLaunchRunner {
  return new JobLaunchRunner({
    repository: createJobLaunchRepository(prisma),
    ending: createUnlaunchableJobEndingRepository(prisma),
    planner: new JobLaunchPlanner({
      routes: kit.routePolicy,
      models: kit.models,
      pricing: kit.pricing,
      fx: { current: async () => kit.fx },
      clock: () => LAUNCHED_AT,
    }),
    ids: { nextAttemptId: () => `sgen_submit_${++seq}`, nextPricingSnapshotId: () => `gps_submit_${++seq}` },
    context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_launch_${++seq}` }),
    clock: () => LAUNCHED_AT,
  });
}

/** Storage that holds every object and signs each one, recording what it signed. */
const signed: string[] = [];
const storage: ExecutionPreflightDeps["storage"] = {
  async exists() {
    return true;
  },
  async createSignedDownloadUrl(key) {
    signed.push(key);
    return { url: "https://storage.itest.example/source?sig=itest", expiresAt: new Date(Date.now() + 600_000) };
  },
};
const preflight: ExecutionPreflightDeps = { assets, storage, models: kit.models };

function sourceOf(organizationId: string, asset: string) {
  return {
    storageKey: `org/${organizationId}/a/${asset}/normalized.jpg`,
    mimeType: "image/jpeg",
    sha256: (organizationId === ORG_A ? "a1" : "b2").repeat(32),
  };
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

async function seedTenant(organizationId: string): Promise<void> {
  await prisma.organization.create({ data: { id: organizationId, name: organizationId, slug: organizationId } });
  for (const { property, asset, project } of TENANT[organizationId]!) {
    if ((await prisma.property.count({ where: { id: property } })) === 0) {
      await prisma.property.create({
        data: { id: property, organizationId, name: "Submission fixture", propertyType: "APARTMENT", createdBy: USER },
      });
      await prisma.mediaAsset.create({
        data: {
          id: asset,
          organizationId,
          propertyId: property,
          ...sourceOf(organizationId, asset),
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
  const opened = await createUnitEntitlementRepository(prisma).openPeriod({
    id: `uep_itest_submit_${organizationId}`,
    organizationId,
    planKey: "premium",
    billingCycleKey: CYCLE,
    startsAt: NOVEMBER.startsAt,
    endsAt: NOVEMBER.endsAt,
    commercialReference: null,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
  await prisma.organizationSubscription.create({
    data: {
      id: `sub_itest_submit_${organizationId}`,
      organizationId,
      planKey: "PREMIUM",
      channel: "SALES_ASSISTED",
      anchorAt: NOVEMBER.startsAt,
      commercialReference: `contract-${organizationId}`,
    },
  });
}

/** Start and launch one job of the tenant's project `which`; its two attempts, in scene order. */
async function launchJob(organizationId: string, which: number): Promise<{ job: string; attempts: string[] }> {
  const tenant = TENANT[organizationId]![which - 1]!;
  seq += 1;
  const n = seq;
  const outcome = await starts.start({
    organizationId,
    videoProjectId: tenant.project,
    idempotencyKey: `submit-start-${n}`,
    jobId: `genjob_submit_${n}`,
    reservationId: `genres_submit_${n}`,
    requestedByUserId: USER,
    qualityTier: "NORMAL",
    disclosureMode: "THROUGHOUT",
    startedAt: STARTED_AT,
    storyboard: {
      compositionFingerprint: FINGERPRINT,
      scenes: [1, 2].map((position) => ({
        storyboardSceneId: `sbs_${tenant.project}_${position}`,
        generationSceneId: `genscene_submit_${n}_${position}`,
        initialRequestId: `genreq_submit_${n}_${position}`,
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
  const report = await launcher().runOnce(10);
  if (report.launched !== 1) throw new Error(`launch: ${JSON.stringify(report.outcomes)}`);
  const launched = await prisma.sceneGeneration.findMany({
    where: { generationSceneRequest: { generationScene: { generationJobId: outcome.job.id } } },
    orderBy: { generationSceneRequest: { generationScene: { position: "asc" } } },
    select: { id: true },
  });
  return { job: outcome.job.id, attempts: launched.map((row) => row.id) };
}

/** Fix an attempt's age, which is what discovery orders by. */
async function age(attemptId: string, minute: number): Promise<void> {
  await prisma.sceneGeneration.update({
    where: { id: attemptId },
    data: { createdAt: new Date(Date.UTC(2026, 10, 10, 1, minute)) },
  });
}

async function offered(limit = 100): Promise<string[]> {
  const candidates = await submission.findSubmissionCandidates({ limit, after: null });
  return candidates.map((candidate) => candidate.generation.id);
}

function refusedContext() {
  return ctx({ actorType: "WORKER", correlationId: `corr_submit_end_${++seq}` });
}

function end(organizationId: string, attemptId: string, reason: PreflightRefusalReason = "ASSET_UNRECOVERABLE") {
  return submission.endPreparationRefusal({ organizationId, attemptId, reason, context: refusedContext() });
}

/** Everything an ending could write, for both tenants. */
async function written(): Promise<Record<string, unknown>> {
  const scope = { videoProject: { organizationId: { in: ORGS } } };
  return {
    jobs: await prisma.generationJob.findMany({
      where: scope,
      orderBy: { id: "asc" },
      select: { id: true, state: true, stateVersion: true },
    }),
    reservations: await prisma.generationReservation.findMany({
      where: { generationJob: scope },
      orderBy: { id: "asc" },
      select: { id: true, state: true, stateVersion: true },
    }),
    scenes: await prisma.generationScene.findMany({
      where: { generationJob: scope },
      orderBy: { id: "asc" },
      select: { id: true, state: true, stateVersion: true },
    }),
    requests: await prisma.sceneGenerationRequest.findMany({
      where: { generationScene: { generationJob: scope } },
      orderBy: { id: "asc" },
      select: { id: true, state: true, stateVersion: true },
    }),
    attempts: await prisma.sceneGeneration.findMany({
      where: scope,
      orderBy: { id: "asc" },
      select: {
        id: true,
        state: true,
        orchestrationState: true,
        stateVersion: true,
        submissionCertainty: true,
        submissionBoundaryEnteredAt: true,
        normalizedErrorCode: true,
        normalizedErrorMessage: true,
      },
    }),
    events: await prisma.generationTransitionEvent.count({ where: { organizationId: { in: ORGS } } }),
    audits: await prisma.auditLog.count({ where: { organizationId: { in: ORGS } } }),
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
  signed.length = 0;
  await cleanup();
  await seedTenant(ORG_A);
  await seedTenant(ORG_B);
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

/**
 * Whether the ending is waiting on a lock of this kind within the deadline: the
 * database says so, for a backend running the ending's own statement.
 */
async function waitForBlocked(
  waitEvent: "advisory" | "transactionid",
  withinMs = 10_000,
  statement = waitEvent === "advisory" ? "%pg_advisory_xact_lock%" : '%UPDATE "scene_generations" a%',
): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND wait_event = ${waitEvent} AND query LIKE ${statement}
      ) AS waiting
    `;
    if (rows[0]?.waiting === true) return true;
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

describe.skipIf(!HAS_DB)("discovery", () => {
  it("offers each launched attempt once, oldest first, with the organization its project names", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    // B's attempts older than A's, and A's two the same age, so the order is
    // the attempts' age and then their id, never the organization or the launch.
    await age(b.attempts[1]!, 1);
    await age(b.attempts[0]!, 2);
    await age(a.attempts[0]!, 3);
    await age(a.attempts[1]!, 3);

    const candidates = await submission.findSubmissionCandidates({ limit: 10, after: null });
    expect(candidates.map((candidate) => [candidate.organizationId, candidate.generation.id])).toEqual([
      [ORG_B, b.attempts[1]],
      [ORG_B, b.attempts[0]],
      ...[...a.attempts].sort().map((id) => [ORG_A, id]),
    ]);
    // The legacy state an orchestrated attempt keeps for life, which is what
    // preparation is defined on.
    expect(candidates.map((candidate) => candidate.generation.state)).toEqual(["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
  });

  it("names each attempt's job, and starts a window after the cursor in the same order", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    await age(b.attempts[1]!, 1);
    await age(b.attempts[0]!, 2);
    await age(a.attempts[0]!, 3);
    await age(a.attempts[1]!, 3);
    const all = await submission.findSubmissionCandidates({ limit: 10, after: null });
    expect(all.map((candidate) => candidate.generationJobId)).toEqual([b.job, b.job, a.job, a.job]);

    const after = async (cursor: AttemptSubmissionCursor) =>
      (await submission.findSubmissionCandidates({ limit: 10, after: cursor })).map((c) => c.generation.id);
    // After each attempt in turn, exactly the ones after it: ties by id.
    for (const [i, candidate] of all.entries()) {
      const cursor = { createdAt: candidate.generation.createdAt, id: candidate.generation.id };
      expect(await after(cursor)).toEqual(all.slice(i + 1).map((c) => c.generation.id));
    }
    // A cursor need not name an attempt: its instant and id place it.
    expect(await after({ createdAt: new Date(Date.UTC(2026, 10, 10, 1, 3)), id: "sgen_" })).toEqual(
      [...a.attempts].sort(),
    );
    for (const cursor of [
      { createdAt: new Date(Number.NaN), id: "sgen_1" },
      { createdAt: new Date(), id: "" },
    ]) {
      await expect(submission.findSubmissionCandidates({ limit: 10, after: cursor })).rejects.toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });

  it("hands preparation a candidate it can prepare, and writes nothing", async () => {
    const a = await launchJob(ORG_A, 1);
    const before = await written();

    const [candidate] = await submission.findSubmissionCandidates({ limit: 1, after: null });
    const prepared = await prepareQueuedGeneration(preflight, candidate!);
    expect(prepared).toMatchObject({
      generationId: candidate!.generation.id,
      organizationId: ORG_A,
      providerName: "fake",
      sourceIdentity: sourceOf(ORG_A, TENANT[ORG_A]![0]!.asset),
    });
    expect(a.attempts).toContain(prepared.generationId);
    expect(signed).toEqual([sourceOf(ORG_A, TENANT[ORG_A]![0]!.asset).storageKey]);
    expect(await written()).toEqual(before);
  });

  it("is bounded, and refuses a bound out of range rather than clamping it", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    for (const [i, id] of [...a.attempts, ...b.attempts].entries()) await age(id, i);
    expect(await offered(3)).toEqual([...a.attempts, b.attempts[0]]);
    for (const limit of [0, 101, 1.5]) {
      await expect(submission.findSubmissionCandidates({ limit, after: null })).rejects.toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });

  it("passes over an attempt the gate armed", async () => {
    const a = await launchJob(ORG_A, 1);
    const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a.attempts[0]! } });
    const armed = await attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: row.id,
      expectedVersion: row.stateVersion,
      context: ctx(),
    });
    expect(armed.kind).toBe("ARMED");
    expect(await offered()).toEqual([a.attempts[1]]);
  });

  it("passes over a QUEUED attempt whose submission is no longer before the boundary", async () => {
    const a = await launchJob(ORG_A, 1);
    // No writer leaves a QUEUED attempt in another certainty today; the
    // predicate mirrors the gate's, which would refuse it.
    await prisma.$executeRaw`
      UPDATE "scene_generations" SET "submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty"
       WHERE "id" = ${a.attempts[0]!}
    `;
    expect(await offered()).toEqual([a.attempts[1]]);
  });

  it("passes over an attempt whose request is no longer generating", async () => {
    const a = await launchJob(ORG_A, 1);
    const request = await prisma.sceneGeneration.findUniqueOrThrow({
      where: { id: a.attempts[0]! },
      select: { generationSceneRequestId: true },
    });
    await prisma.sceneGenerationRequest.update({
      where: { id: request.generationSceneRequestId! },
      data: { state: "CANCELLED" },
    });
    expect(await offered()).toEqual([a.attempts[1]]);
  });

  it("passes over a deleted Property's attempts, which the gate refuses for good", async () => {
    const first = await launchJob(ORG_A, 1);
    const second = await launchJob(ORG_A, 4);
    await prisma.property.update({ where: { id: TENANT[ORG_A]![3]!.property }, data: { status: "DELETED" } });
    expect(new Set(await offered())).toEqual(new Set(first.attempts));
    expect(second.attempts).toHaveLength(2);
  });
});

describe.skipIf(!HAS_DB)("the ending of a refused preparation", () => {
  it("ends the attempt before submission, with the reason as its code, and writes its event", async () => {
    const a = await launchJob(ORG_A, 1);
    const target = a.attempts[0]!;
    // A message from nowhere, to prove the ending clears one rather than
    // leaving it beside a code it does not describe.
    await prisma.sceneGeneration.update({ where: { id: target }, data: { normalizedErrorMessage: "stale" } });
    const before = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: target } });
    const eventsBefore = await prisma.generationTransitionEvent.count({ where: { aggregateId: target } });
    const others = await written();

    const context = refusedContext();
    const outcome = await submission.endPreparationRefusal({
      organizationId: ORG_A,
      attemptId: target,
      reason: "ASSET_UNRECOVERABLE",
      context,
    });
    expect(outcome).toEqual({ kind: "ENDED", attemptId: target, stateVersion: before.stateVersion + 1 });

    const after = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: target } });
    expect(after).toMatchObject({
      state: "QUEUED",
      orchestrationState: "CANCELLED_PRE_SUBMISSION",
      stateVersion: before.stateVersion + 1,
      submissionCertainty: "PRE_SUBMISSION",
      submissionBoundaryEnteredAt: null,
      providerPredictionId: null,
      normalizedErrorCode: "ASSET_UNRECOVERABLE",
      normalizedErrorMessage: null,
    });
    const events = await prisma.generationTransitionEvent.findMany({
      where: { aggregateId: target },
      orderBy: { sequence: "asc" },
    });
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)).toMatchObject({
      organizationId: ORG_A,
      aggregateType: "ATTEMPT",
      sequence: eventsBefore + 1,
      fromState: "QUEUED",
      toState: "CANCELLED_PRE_SUBMISSION",
      eventType: "attempt.preparation_refused",
      reasonCode: "ASSET_UNRECOVERABLE",
      actorType: "WORKER",
      correlationId: context.correlationId,
    });

    // Nothing else moved: not the request, the scene, the job or the Unit,
    // which are the attempt failure settlement's to move.
    const now = await written();
    const unchanged = (state: Record<string, unknown>) => ({
      ...state,
      attempts: (state.attempts as { id: string }[]).filter((row) => row.id !== target),
      events: undefined,
    });
    expect(unchanged(now)).toEqual(unchanged(others));
    expect(await offered()).toEqual([a.attempts[1]]);
  });

  it("is what gives the Unit back, through the attempt failure settlement, when the photo was withdrawn", async () => {
    const a = await launchJob(ORG_A, 1);
    await prisma.mediaAsset.update({
      where: { id: TENANT[ORG_A]![0]!.asset },
      data: { deletionRequestedAt: new Date("2026-11-10T01:30:00.000Z") },
    });

    // The sender's first step, written out: prepare, and end what is refused
    // for good.
    const [candidate] = await submission.findSubmissionCandidates({ limit: 1, after: null });
    const refusal = await prepareQueuedGeneration(preflight, candidate!).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PreflightRefusalError);
    const { reason } = refusal as PreflightRefusalError;
    expect([reason, preparationRefusalEnding(reason)]).toEqual(["ASSET_UNRECOVERABLE", "CANCELLED_PRE_SUBMISSION"]);
    // Refused before anything was signed.
    expect(signed).toEqual([]);
    expect((await end(ORG_A, candidate!.generation.id, reason)).kind).toBe("ENDED");

    let n = 0;
    const settlement = new AttemptFailureSettlementRunner({
      repository: createAttemptFailureSettlementRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_k_${++n}` }),
    });
    const settledReport = await settlement.runOnce(10);
    expect([settledReport.settled, settledReport.unitsReleased, settledReport.failed]).toEqual([1, 1, 0]);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: a.job }, include: { reservation: true } });
    expect([job.state, job.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);

    // The other scene's attempt waits on a failed job, so it is no longer
    // offered, and the failed job's scene closure cancels it.
    expect(await offered()).toEqual([]);
    const closure = new FailedJobSceneClosureRunner({
      repository: createFailedJobSceneClosureRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_l_${++n}` }),
    });
    const closed = await closure.runOnce(10);
    expect([closed.closed, closed.attemptsCancelled, closed.failed]).toEqual([1, 1, 0]);
    const sibling = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a.attempts[1]! } });
    expect(sibling.orchestrationState).toBe("CANCELLED_PRE_SUBMISSION");
  });

  it("refuses a reason that may still pass, before reading anything, and writes nothing", async () => {
    const a = await launchJob(ORG_A, 1);
    const before = await written();
    for (const reason of ["STORAGE_UNAVAILABLE", "ASSET_NOT_READY", "MODEL_UNAVAILABLE"] as const) {
      await expect(end(ORG_A, a.attempts[0]!, reason)).rejects.toThrow(
        expect.objectContaining({ code: "INTERNAL_ERROR" }),
      );
    }
    expect(await written()).toEqual(before);
  });

  it("writes nothing when its event cannot be written", async () => {
    const a = await launchJob(ORG_A, 1);
    const before = await written();
    // A forbidden key, refused at the event's boundary after the compare-and-set
    // has run: the move must roll back with it.
    const metadata = { prompt: "never stored" } as unknown as SafeTransitionMetadata;
    const context = { ...refusedContext(), metadata };
    await expect(
      submission.endPreparationRefusal({
        organizationId: ORG_A,
        attemptId: a.attempts[0]!,
        reason: "ASSET_UNRECOVERABLE",
        context,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(await written()).toEqual(before);
    expect(new Set(await offered())).toEqual(new Set(a.attempts));
  });

  it("ends nothing in another organization", async () => {
    const a = await launchJob(ORG_A, 1);
    await launchJob(ORG_B, 1);
    const before = await written();
    expect(await end(ORG_B, a.attempts[0]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await written()).toEqual(before);
  });

  it("answers a replay as not queued, writing nothing", async () => {
    const a = await launchJob(ORG_A, 1);
    expect((await end(ORG_A, a.attempts[0]!)).kind).toBe("ENDED");
    const before = await written();
    expect(await end(ORG_A, a.attempts[0]!, "ASSET_NOT_FOUND")).toEqual({ kind: "NOT_QUEUED" });
    expect(await written()).toEqual(before);
  });

  it("never ends an attempt the gate armed", async () => {
    const a = await launchJob(ORG_A, 1);
    const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a.attempts[0]! } });
    await attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: row.id,
      expectedVersion: row.stateVersion,
      context: ctx(),
    });
    const before = await written();
    expect(await end(ORG_A, row.id)).toEqual({ kind: "NOT_QUEUED" });
    expect(await written()).toEqual(before);
  });

  it("never ends a QUEUED attempt whose submission is no longer before the boundary", async () => {
    const a = await launchJob(ORG_A, 1);
    await prisma.$executeRaw`
      UPDATE "scene_generations" SET "submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty"
       WHERE "id" = ${a.attempts[0]!}
    `;
    const before = await written();
    expect(await end(ORG_A, a.attempts[0]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await written()).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("concurrency and lock order", () => {
  it("waits for the cost-admission lock of its organization and cycle, then ends", async () => {
    const a = await launchJob(ORG_A, 1);
    const held = await holdOpen(async (tx) => {
      // The formula every cost workflow derives, written out on purpose: if it
      // ever changes, this barrier stops blocking and the test fails.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`paid-submission:${ORG_A}`}), hashtext(${`cycle:${CYCLE}`}))::text
      `;
    });
    const ending = settled(end(ORG_A, a.attempts[0]!));
    try {
      expect(await waitForBlocked("advisory")).toBe(true);
      expect(ending.done()).toBe(false);
      const waiting = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a.attempts[0]! } });
      expect(waiting.orchestrationState).toBe("QUEUED");
    } finally {
      await held.release();
    }
    expect((await ending.value).kind).toBe("ENDED");
  });

  it("reads no other organization's reservation, not even for its lock key", async () => {
    const a = await launchJob(ORG_A, 1);
    // B's own cycle is A's too. Asked as B, the ending must not find A's
    // reservation's cycle and wait on B's lock for it: it knows no reservation
    // of B's, so it takes B's `unreserved` key, and answers at once.
    const held = await holdOpen(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`paid-submission:${ORG_B}`}), hashtext(${`cycle:${CYCLE}`}))::text
      `;
    });
    const ending = settled(end(ORG_B, a.attempts[0]!));
    try {
      expect(await waitForBlocked("advisory", 2_000)).toBe(false);
    } finally {
      await held.release();
    }
    expect(await ending.value).toEqual({ kind: "NOT_QUEUED" });
  });

  // The gate and the ending serialize on the cost-admission lock, proved above.
  // The attempt repository's own arm takes none, so this proves the row's
  // compare-and-set keeps the two apart without it.
  it("waits for an arm in flight that takes no cost-admission lock, and then ends nothing", async () => {
    const a = await launchJob(ORG_A, 1);
    const row = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a.attempts[0]! } });
    const held = await holdOpen(async (tx) => {
      const armed = await armProviderBoundaryWithin(tx, {
        organizationId: ORG_A,
        id: row.id,
        expectedVersion: row.stateVersion,
        context: ctx(),
      });
      if (armed.kind !== "ARMED") throw new Error(`arm: ${armed.kind}`);
    });
    const ending = settled(end(ORG_A, row.id));
    try {
      expect(await waitForBlocked("transactionid")).toBe(true);
      expect(ending.done()).toBe(false);
    } finally {
      await held.release();
    }
    expect(await ending.value).toEqual({ kind: "NOT_QUEUED" });
    const after = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.orchestrationState, after.normalizedErrorCode]).toEqual(["SUBMITTING", null]);
  });
});

/** The test provider, counting each request it is sent. */
function counting(outcome: FakeSubmissionOutcomeKind = "ACCEPTED") {
  const fake = new FakeVideoProvider({ submissionOutcome: outcome });
  const requests: string[] = [];
  const provider: VideoGenerationSubmissionProvider = {
    name: "fake",
    async createGeneration(input) {
      requests.push(input.requestHash);
      return fake.createGeneration(input);
    },
    normalizeError: (error) => fake.normalizeError(error),
  };
  return { provider, requests };
}

const RECONCILIATION = (() => {
  const result = validateReconciliationPolicy({
    reconciliationWindowMs: 24 * 60 * 60 * 1000,
    staleSubmittingAfterMs: 15 * 60 * 1000,
  });
  if (!result.ok) throw new Error(`policy: ${result.reason}`);
  return result.policy;
})();

/** The sender over the real gate and outcome service, on the test provider's route. */
interface SenderOptions {
  readonly revenue?: Yen | null;
  readonly source?: ExecutionPreflightDeps["storage"];
}

function sender(
  provider: VideoGenerationSubmissionProvider,
  { revenue = yen(49_800), source = storage }: SenderOptions = {},
): AttemptSubmissionRunner {
  return new AttemptSubmissionRunner({
    repository: submission,
    preflight: { assets, storage: source, models: kit.models },
    gate: createPaidSubmissionAuthorizationService({
      authorization: createPaidSubmissionAuthorizationRepository(prisma, {
        pricing: kit.pricing,
        revenue: { revenueYen: async () => revenue },
      }),
      clock: createFixedAuthorizationClock(LAUNCHED_AT),
      routePolicy: kit.routePolicy,
    }),
    sender: createPreparedGenerationSender(provider),
    outcomes: createSubmissionOutcomeService({
      outcomes: createSubmissionOutcomeRepository(prisma),
      clock: createSystemSubmissionClock(),
      policy: RECONCILIATION,
    }),
    clock: createSystemSubmissionClock(),
    context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_send_${++seq}` }),
  });
}

async function attemptRow(id: string) {
  return prisma.sceneGeneration.findUniqueOrThrow({
    where: { id },
    select: {
      orchestrationState: true,
      submissionCertainty: true,
      normalizedErrorCode: true,
      providerPredictionId: true,
    },
  });
}

/** The paid call's audit entries for one attempt, written by the gate's arm. */
function armAudits(attemptId: string): Promise<number> {
  return prisma.auditLog.count({ where: { resourceId: attemptId, action: "generation.submission_started" } });
}

describe.skipIf(!HAS_DB)("the sender (GS-7c-2b)", () => {
  it("sends each launched attempt once through the gate, audited, and records the acceptance", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    const { provider, requests } = counting();

    const report = await sender(provider).runOnce(10);
    expect(report).toMatchObject({ sent: 4, ended: 0, failed: 0, next: null });
    expect(report.outcomes.map((o) => o.outcome)).toEqual(
      Array(4).fill({ kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false }),
    );
    expect(new Set(requests).size).toBe(4);
    for (const id of [...a.attempts, ...b.attempts]) {
      expect(await attemptRow(id)).toMatchObject({ orchestrationState: "PROCESSING", submissionCertainty: "ACCEPTED" });
      expect((await attemptRow(id)).providerPredictionId).not.toBeNull();
      // The arm's audit entry and its two events, under the pass's one correlation.
      expect(await armAudits(id)).toBe(1);
      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateId: id, toState: { in: ["SUBMITTING", "PROCESSING"] } },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => [e.eventType, e.toState])).toEqual([
        ["PAID_SUBMISSION_AUTHORIZED", "SUBMITTING"],
        ["SUBMISSION_OUTCOME_RECORDED", "PROCESSING"],
      ]);
      expect(new Set(events.map((e) => e.correlationId)).size).toBe(1);
    }

    // Nothing is offered or sent again.
    expect((await sender(provider).runOnce(10)).outcomes).toEqual([]);
    expect(requests).toHaveLength(4);
  });

  it("ends an attempt whose photo is asked to be deleted, sends no more of its job, and frees its Unit", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    for (const [minute, id] of [...a.attempts, ...b.attempts].entries()) await age(id, minute);
    await prisma.mediaAsset.update({
      where: { id: TENANT[ORG_A]![0]!.asset },
      data: { deletionRequestedAt: new Date("2026-11-10T01:30:00.000Z") },
    });
    const { provider, requests } = counting();

    const report = await sender(provider).runOnce(10);
    expect(report.outcomes.map((o) => [o.attemptId, o.outcome.kind])).toEqual([
      [a.attempts[0], "ENDED"],
      [a.attempts[1], "NOT_SENT"],
      [b.attempts[0], "SENT"],
      [b.attempts[1], "SENT"],
    ]);
    expect(report.outcomes[1]!.outcome).toEqual({ kind: "NOT_SENT", reason: "JOB_ENDING" });
    expect(requests).toHaveLength(2);
    expect(await attemptRow(a.attempts[0]!)).toMatchObject({
      orchestrationState: "CANCELLED_PRE_SUBMISSION",
      normalizedErrorCode: "ASSET_UNRECOVERABLE",
    });
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("QUEUED");

    let n = 0;
    const settledReport = await new AttemptFailureSettlementRunner({
      repository: createAttemptFailureSettlementRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_k_${++n}` }),
    }).runOnce(10);
    expect([settledReport.settled, settledReport.unitsReleased]).toEqual([1, 1]);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: a.job }, include: { reservation: true } });
    expect([job.state, job.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);
    const closed = await new FailedJobSceneClosureRunner({
      repository: createFailedJobSceneClosureRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_l_${++n}` }),
    }).runOnce(10);
    expect(closed.attemptsCancelled).toBe(1);
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("CANCELLED_PRE_SUBMISSION");
  });

  it("writes and sends nothing when the gate refuses, and offers the attempts again", async () => {
    const a = await launchJob(ORG_A, 1);
    const before = await written();
    const { provider, requests } = counting();

    const report = await sender(provider, { revenue: null }).runOnce(10);
    expect(report.outcomes.map((o) => o.outcome)).toEqual(
      Array(2).fill({
        kind: "NOT_AUTHORIZED",
        refusal: "SAFETY_GUARD_HARD_PAUSE",
        reason: "BILLING_CYCLE_REVENUE_UNAVAILABLE",
      }),
    );
    expect(requests).toEqual([]);
    expect(await written()).toEqual(before);
    expect((await offered()).sort()).toEqual([...a.attempts].sort());
  });

  it("records a provider's refusal, and sends nothing more of its job", async () => {
    const a = await launchJob(ORG_A, 1);
    await age(a.attempts[0]!, 1);
    await age(a.attempts[1]!, 2);
    const { provider, requests } = counting("DEFINITIVELY_REJECTED");

    const report = await sender(provider).runOnce(10);
    expect(report.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "SENT", observed: "DEFINITIVELY_REJECTED", recorded: "APPLIED", safetyGuardWarning: false },
      { kind: "NOT_SENT", reason: "JOB_ENDING" },
    ]);
    expect(requests).toHaveLength(1);
    expect(await attemptRow(a.attempts[0]!)).toMatchObject({
      orchestrationState: "FAILED_TERMINAL",
      submissionCertainty: "DEFINITIVELY_REJECTED",
    });
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("QUEUED");
  });

  it("records a timed-out answer as uncertain, whose hold on the Unit keeps the job's next attempt", async () => {
    const a = await launchJob(ORG_A, 1);
    await age(a.attempts[0]!, 1);
    await age(a.attempts[1]!, 2);
    const { provider, requests } = counting("SUBMISSION_UNKNOWN");

    const report = await sender(provider).runOnce(10);
    expect(report.outcomes.map((o) => o.outcome)).toEqual([
      { kind: "SENT", observed: "SUBMISSION_UNKNOWN", recorded: "APPLIED", safetyGuardWarning: false },
      // The gate refuses a reservation on hold, and writes nothing.
      { kind: "NOT_AUTHORIZED", refusal: "RESERVATION_INVALID", reason: "RESERVATION_ON_RECONCILIATION_HOLD" },
    ]);
    expect(requests).toHaveLength(1);
    expect(await attemptRow(a.attempts[0]!)).toMatchObject({
      orchestrationState: "RECONCILIATION_PENDING",
      submissionCertainty: "SUBMISSION_UNKNOWN",
      normalizedErrorCode: "TIMEOUT",
    });
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("QUEUED");
    const reservation = await prisma.generationReservation.findUniqueOrThrow({ where: { generationJobId: a.job } });
    expect(reservation.state).toBe("RECONCILIATION_HOLD");
  });

  it("sends each attempt once when two passes run at once", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    const { provider, requests } = counting();

    const reports = await Promise.all([sender(provider).runOnce(10), sender(provider).runOnce(10)]);
    expect(reports[0]!.sent + reports[1]!.sent).toBe(4);
    expect(requests.sort()).toEqual([...new Set(requests)].sort());
    expect(requests).toHaveLength(4);
    for (const id of [...a.attempts, ...b.attempts]) {
      expect((await attemptRow(id)).orchestrationState).toBe("PROCESSING");
      expect(await armAudits(id)).toBe(1);
    }
  });

  it("moves its window past attempts left waiting, so newer ones are reached", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    for (const [minute, id] of [...b.attempts, ...a.attempts].entries()) await age(id, minute);
    // B's photo store does not answer, a refusal that may pass: B's attempts wait.
    const flaky: ExecutionPreflightDeps["storage"] = {
      async exists(key) {
        if (key.startsWith(`org/${ORG_B}/`)) throw new Error("storage gone");
        return true;
      },
      createSignedDownloadUrl: (key, ttl) => storage.createSignedDownloadUrl(key, ttl),
    };
    const { provider, requests } = counting();
    const runner = sender(provider, { source: flaky });

    const first = await runner.runOnce(2);
    expect(first.outcomes.map((o) => [o.attemptId, o.outcome])).toEqual(
      b.attempts.map((id) => [id, { kind: "NOT_PREPARED", reason: "STORAGE_UNAVAILABLE" }]),
    );
    expect(first.next?.id).toBe(b.attempts[1]);

    // From the oldest again, the same window would be read; after it, A's.
    const second = await runner.runOnce(2, first.next);
    expect(second.outcomes.map((o) => [o.attemptId, o.outcome.kind])).toEqual(a.attempts.map((id) => [id, "SENT"]));
    expect(requests).toHaveLength(2);
    expect(second.next?.id).toBe(a.attempts[1]);

    const third = await runner.runOnce(2, second.next);
    expect([third.outcomes, third.next]).toEqual([[], null]);
    expect((await runner.runOnce(2, third.next)).outcomes.map((o) => o.attemptId)).toEqual(b.attempts);
  });
});

async function deletedOffered(limit = 100): Promise<string[][]> {
  const found = await submission.findPropertyDeletedAttempts({ limit });
  return found.map((attempt) => [attempt.organizationId, attempt.generationJobId, attempt.attemptId]);
}

function endDeleted(organizationId: string, attemptId: string) {
  return submission.endPropertyDeletedAttempt({ organizationId, attemptId, context: refusedContext() });
}

/** Delete the Property of the tenant's project `which`, as the Property service does. */
async function deleteProperty(organizationId: string, which: number): Promise<void> {
  const { property } = TENANT[organizationId]![which - 1]!;
  await prisma.property.update({ where: { id: property }, data: { status: "DELETED" } });
}

describe.skipIf(!HAS_DB)("a deleted Property's attempts (GS-7d-2)", () => {
  it("offers the oldest attempt of each generating job of a deleted Property, oldest first", async () => {
    const a1 = await launchJob(ORG_A, 1);
    const a2 = await launchJob(ORG_A, 2);
    const a4 = await launchJob(ORG_A, 4);
    const b1 = await launchJob(ORG_B, 1);
    for (const [minute, id] of [a2.attempts[1]!, a2.attempts[0]!, a1.attempts[0]!, a1.attempts[1]!].entries()) {
      await age(id, minute);
    }
    await age(b1.attempts[1]!, 10);
    await age(b1.attempts[0]!, 11);
    await age(a4.attempts[0]!, 0);
    expect(await deletedOffered()).toEqual([]);

    // A's first Property holds projects 1 to 3; its second, project 4, stands.
    await deleteProperty(ORG_A, 1);
    await deleteProperty(ORG_B, 1);
    expect(await deletedOffered()).toEqual([
      [ORG_A, a2.job, a2.attempts[1]],
      [ORG_A, a1.job, a1.attempts[0]],
      [ORG_B, b1.job, b1.attempts[1]],
    ]);
    expect(await deletedOffered(2)).toEqual([
      [ORG_A, a2.job, a2.attempts[1]],
      [ORG_A, a1.job, a1.attempts[0]],
    ]);
    for (const limit of [0, 101, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(submission.findPropertyDeletedAttempts({ limit })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
  });

  it("passes over an attempt not waiting before submission, and a request or job not generating", async () => {
    const a1 = await launchJob(ORG_A, 1);
    const a2 = await launchJob(ORG_A, 2);
    for (const [minute, id] of [...a1.attempts, ...a2.attempts].entries()) await age(id, minute);
    await deleteProperty(ORG_A, 1);
    const jobOf = async (job: string) => (await deletedOffered()).filter((row) => row[1] === job).map((row) => row[2]);

    // Armed: the job's next attempt is offered instead; then its request ends.
    const armed = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a1.attempts[0]! } });
    await attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: armed.id,
      expectedVersion: armed.stateVersion,
      context: ctx(),
    });
    expect(await jobOf(a1.job)).toEqual([a1.attempts[1]]);
    const request = await prisma.sceneGeneration.findUniqueOrThrow({
      where: { id: a1.attempts[1]! },
      select: { generationSceneRequestId: true },
    });
    await prisma.sceneGenerationRequest.update({
      where: { id: request.generationSceneRequestId! },
      data: { state: "CANCELLED" },
    });
    expect(await jobOf(a1.job)).toEqual([]);

    // No longer before the boundary: the next; then the job fails.
    await prisma.$executeRaw`
      UPDATE "scene_generations" SET "submissionCertainty" = 'SUBMISSION_UNKNOWN'::"SubmissionCertainty"
       WHERE "id" = ${a2.attempts[0]!}
    `;
    expect(await jobOf(a2.job)).toEqual([a2.attempts[1]]);
    await prisma.generationJob.update({ where: { id: a2.job }, data: { state: "FAILED_TERMINAL" } });
    expect(await deletedOffered()).toEqual([]);
  });

  it("ends the attempt before submission, with its code and event, and writes nothing else", async () => {
    const a = await launchJob(ORG_A, 1);
    await launchJob(ORG_B, 1);
    await deleteProperty(ORG_A, 1);
    const target = a.attempts[0]!;
    await prisma.sceneGeneration.update({ where: { id: target }, data: { normalizedErrorMessage: "stale" } });
    const before = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: target } });
    const eventsBefore = await prisma.generationTransitionEvent.count({ where: { aggregateId: target } });
    const others = await written();

    const context = refusedContext();
    const outcome = await submission.endPropertyDeletedAttempt({ organizationId: ORG_A, attemptId: target, context });
    expect(outcome).toEqual({ kind: "ENDED", attemptId: target, stateVersion: before.stateVersion + 1 });
    expect(await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: target } })).toMatchObject({
      state: "QUEUED",
      orchestrationState: "CANCELLED_PRE_SUBMISSION",
      stateVersion: before.stateVersion + 1,
      submissionCertainty: "PRE_SUBMISSION",
      submissionBoundaryEnteredAt: null,
      providerPredictionId: null,
      normalizedErrorCode: "PROPERTY_DELETED",
      normalizedErrorMessage: null,
    });
    const events = await prisma.generationTransitionEvent.findMany({
      where: { aggregateId: target },
      orderBy: { sequence: "asc" },
    });
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)).toMatchObject({
      organizationId: ORG_A,
      aggregateType: "ATTEMPT",
      fromState: "QUEUED",
      toState: "CANCELLED_PRE_SUBMISSION",
      eventType: "attempt.ended_property_deleted",
      reasonCode: "PROPERTY_DELETED",
      actorType: "WORKER",
      correlationId: context.correlationId,
    });

    const unchanged = (state: Record<string, unknown>) => ({
      ...state,
      attempts: (state.attempts as { id: string }[]).filter((row) => row.id !== target),
      events: undefined,
    });
    expect(unchanged(await written())).toEqual(unchanged(others));
    // The job's other attempt is offered next, and is ended the same way.
    expect(await deletedOffered()).toEqual([[ORG_A, a.job, a.attempts[1]]]);
  });

  it("writes nothing for a standing Property, another organization, a replay or an armed attempt", async () => {
    const a1 = await launchJob(ORG_A, 1);
    const a4 = await launchJob(ORG_A, 4);
    await launchJob(ORG_B, 1);
    expect(await endDeleted(ORG_A, a4.attempts[0]!)).toEqual({ kind: "PROPERTY_NOT_DELETED" });

    await deleteProperty(ORG_A, 1);
    const armed = await prisma.sceneGeneration.findUniqueOrThrow({ where: { id: a1.attempts[1]! } });
    await attempts.armProviderBoundary({
      organizationId: ORG_A,
      id: armed.id,
      expectedVersion: armed.stateVersion,
      context: ctx(),
    });
    expect((await endDeleted(ORG_A, a1.attempts[0]!)).kind).toBe("ENDED");

    const before = await written();
    expect(await endDeleted(ORG_B, a1.attempts[0]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await endDeleted(ORG_B, a4.attempts[0]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await endDeleted(ORG_A, a1.attempts[0]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await endDeleted(ORG_A, a1.attempts[1]!)).toEqual({ kind: "NOT_QUEUED" });
    expect(await endDeleted(ORG_A, "sgen_submit_none")).toEqual({ kind: "NOT_QUEUED" });
    expect(await written()).toEqual(before);
    expect((await attemptRow(a1.attempts[1]!)).orchestrationState).toBe("SUBMITTING");
  });

  it("waits for the cost-admission lock of its organization and cycle, then ends", async () => {
    const a = await launchJob(ORG_A, 1);
    await deleteProperty(ORG_A, 1);
    const held = await holdOpen(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`paid-submission:${ORG_A}`}), hashtext(${`cycle:${CYCLE}`}))::text
      `;
    });
    const ending = settled(endDeleted(ORG_A, a.attempts[0]!));
    try {
      expect(await waitForBlocked("advisory")).toBe(true);
      expect(ending.done()).toBe(false);
    } finally {
      await held.release();
    }
    expect((await ending.value).kind).toBe("ENDED");
  });

  it("waits for a deletion saving, and then sees it", async () => {
    const a = await launchJob(ORG_A, 1);
    const held = await holdOpen(async (tx) => {
      await tx.property.update({ where: { id: TENANT[ORG_A]![0]!.property }, data: { status: "DELETED" } });
    });
    const ending = settled(endDeleted(ORG_A, a.attempts[0]!));
    try {
      expect(await waitForBlocked("transactionid", 10_000, "%FOR SHARE OF pr%")).toBe(true);
      expect(ending.done()).toBe(false);
    } finally {
      await held.release();
    }
    expect((await ending.value).kind).toBe("ENDED");
    expect((await attemptRow(a.attempts[0]!)).normalizedErrorCode).toBe("PROPERTY_DELETED");
  });

  it("is ended by the sender first, sends nothing of its job, and frees the Unit through K and L", async () => {
    const a = await launchJob(ORG_A, 1);
    const b = await launchJob(ORG_B, 1);
    for (const [minute, id] of [...a.attempts, ...b.attempts].entries()) await age(id, minute);
    await deleteProperty(ORG_A, 1);
    const { provider, requests } = counting();

    const report = await sender(provider).runOnce(10);
    expect(report.outcomes.map((o) => [o.attemptId, o.outcome])).toEqual([
      [a.attempts[0], { kind: "ENDED", reason: "PROPERTY_DELETED" }],
      ...b.attempts.map((id) => [
        id,
        { kind: "SENT", observed: "ACCEPTED", recorded: "APPLIED", safetyGuardWarning: false },
      ]),
    ]);
    expect(report).toMatchObject({ sent: 2, ended: 1, failed: 0 });
    expect(requests).toHaveLength(2);
    // Nothing of A's was signed or armed.
    expect(signed.filter((key) => key.startsWith(`org/${ORG_A}/`))).toEqual([]);
    for (const id of a.attempts) expect(await armAudits(id)).toBe(0);
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("QUEUED");

    let n = 0;
    const settledReport = await new AttemptFailureSettlementRunner({
      repository: createAttemptFailureSettlementRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_k_${++n}` }),
    }).runOnce(10);
    expect([settledReport.settled, settledReport.unitsReleased]).toEqual([1, 1]);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: a.job }, include: { reservation: true } });
    expect([job.state, job.reservation?.state]).toEqual(["FAILED_TERMINAL", "RELEASED"]);
    const closed = await new FailedJobSceneClosureRunner({
      repository: createFailedJobSceneClosureRepository(prisma),
      clock: () => SETTLED_AT,
      context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_l_${++n}` }),
    }).runOnce(10);
    expect(closed.attemptsCancelled).toBe(1);
    expect((await attemptRow(a.attempts[1]!)).orchestrationState).toBe("CANCELLED_PRE_SUBMISSION");

    // Nothing is left to end or send.
    expect(await deletedOffered()).toEqual([]);
    expect((await sender(provider).runOnce(10)).outcomes).toEqual([]);
  });

  it("ends an attempt the gate refuses because its Property was deleted since discovery", async () => {
    const a = await launchJob(ORG_A, 1);
    for (const [minute, id] of a.attempts.entries()) await age(id, minute);
    // The deletion saves while the first attempt is prepared: after discovery,
    // before the gate.
    const deleting: ExecutionPreflightDeps["storage"] = {
      exists: (key) => storage.exists(key),
      async createSignedDownloadUrl(key, ttl) {
        await deleteProperty(ORG_A, 1);
        return storage.createSignedDownloadUrl(key, ttl);
      },
    };
    const { provider, requests } = counting();

    const report = await sender(provider, { source: deleting }).runOnce(10);
    expect(report.outcomes.map((o) => [o.attemptId, o.outcome])).toEqual([
      [a.attempts[0], { kind: "ENDED", reason: "PROPERTY_DELETED" }],
      [a.attempts[1], { kind: "NOT_SENT", reason: "JOB_ENDING" }],
    ]);
    expect(requests).toEqual([]);
    expect(await attemptRow(a.attempts[0]!)).toMatchObject({
      orchestrationState: "CANCELLED_PRE_SUBMISSION",
      submissionCertainty: "PRE_SUBMISSION",
      normalizedErrorCode: "PROPERTY_DELETED",
    });
    expect(await armAudits(a.attempts[0]!)).toBe(0);
  });
});
