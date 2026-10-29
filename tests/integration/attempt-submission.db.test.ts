import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  armProviderBoundaryWithin,
  createAttemptFailureSettlementRepository,
  createAttemptSubmissionRepository,
  createFailedJobSceneClosureRepository,
  createGenerationStartRepository,
  createJobLaunchRepository,
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createSceneGenerationAttemptRepository,
  createUnitEntitlementRepository,
} from "@app/database";
import {
  AttemptFailureSettlementRunner,
  FailedJobSceneClosureRunner,
  JobLaunchPlanner,
  JobLaunchRunner,
  PRESERVATION_RULES,
  PreflightRefusalError,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  epochMillisFromDate,
  preparationRefusalEnding,
  prepareQueuedGeneration,
  type CompiledPrompt,
  type ExecutionPreflightDeps,
  type PreflightRefusalReason,
  type SafeTransitionMetadata,
  type StoryboardScene,
} from "@app/domain";
import { createFakeRouteKit } from "@app/video-providers";
import { ctx } from "./orchestration-fixture";

/**
 * The attempt submission's discovery and the ending of a refused preparation,
 * against live PostgreSQL (GS-7c-2a, ADR-0097).
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
    planner: new JobLaunchPlanner({
      routes: kit.routePolicy,
      models: kit.models,
      pricing: kit.pricing,
      fx: { current: async () => kit.fx },
      clock: () => LAUNCHED_AT,
    }),
    ids: { nextAttemptId: () => `sgen_submit_${++seq}`, nextPricingSnapshotId: () => `gps_submit_${++seq}` },
    context: () => ctx({ actorType: "WORKER", correlationId: `corr_submit_launch_${++seq}` }),
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
  return (await submission.findSubmissionCandidates({ limit })).map((candidate) => candidate.generation.id);
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

/** Whether another backend is waiting on a lock of this kind within the deadline: the database says so. */
async function waitForBlocked(waitEvent: "advisory" | "transactionid", withinMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null; wait_event: string | null }[]>(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (rows.some((row) => row.wait_event_type === "Lock" && row.wait_event === waitEvent)) return true;
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

    const candidates = await submission.findSubmissionCandidates({ limit: 10 });
    expect(candidates.map((candidate) => [candidate.organizationId, candidate.generation.id])).toEqual([
      [ORG_B, b.attempts[1]],
      [ORG_B, b.attempts[0]],
      ...[...a.attempts].sort().map((id) => [ORG_A, id]),
    ]);
    // The legacy state an orchestrated attempt keeps for life, which is what
    // preparation is defined on.
    expect(candidates.map((candidate) => candidate.generation.state)).toEqual(["QUEUED", "QUEUED", "QUEUED", "QUEUED"]);
  });

  it("hands preparation a candidate it can prepare, and writes nothing", async () => {
    const a = await launchJob(ORG_A, 1);
    const before = await written();

    const [candidate] = await submission.findSubmissionCandidates({ limit: 1 });
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
      await expect(submission.findSubmissionCandidates({ limit })).rejects.toThrow(
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
    const [candidate] = await submission.findSubmissionCandidates({ limit: 1 });
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

  it("waits for a gate arm in flight, and then ends nothing", async () => {
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
