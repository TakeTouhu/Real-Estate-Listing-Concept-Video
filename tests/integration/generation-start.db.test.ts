import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGenerationStartRepository,
  createPrismaStoryboardRepositories,
  createUnitEntitlementRepository,
} from "@app/database";
import type { DisclosureMode, GenerationStartRecord, StoryboardScene } from "@app/domain";
import { ctx } from "./orchestration-fixture";

/**
 * The start commit against live PostgreSQL (GS-4b, ADR-0087).
 *
 * One commit creates the job, reserves its Units, copies the storyboard's
 * scenes with their first requests, and records the audit entry. What only a
 * database can prove is here: that every refusal writes nothing, including the
 * ones that come after the job is written; that a start key answers a replay,
 * even two arriving at once; and that a start waits for a composition already
 * saving and then judges the storyboard that composition left.
 *
 * Its own tenants and its own Standard period, sized to the approved plan:
 * 15 Units, one of them HQ.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_start_a";
const ORG_B = "org_itest_start_b";
const ORGS = [ORG_A, ORG_B];
const PROP_A = "prp_itest_start_a";
const PROP_B = "prp_itest_start_b";
const ASSET_A1 = "ast_itest_start_a1";
const ASSET_A2 = "ast_itest_start_a2";
const ASSET_B1 = "ast_itest_start_b1";
/** 1080p, so HQ: the plan's one HQ Unit is all a start of it can draw. */
const PROJECT_HQ = "vpr_itest_start_hq";
/** 720p, so Normal. */
const PROJECT_NORMAL = "vpr_itest_start_normal";
const PROJECT_B = "vpr_itest_start_b";
const USER = "usr_itest_start";
const FINGERPRINT = "sha256:start-first";

const NOVEMBER = { startsAt: new Date("2026-11-01T00:00:00.000Z"), endsAt: new Date("2026-12-01T00:00:00.000Z") };
const STARTED_AT = new Date("2026-11-10T00:00:00.000Z");
const DECEMBER = { startsAt: new Date("2026-12-01T00:00:00.000Z"), endsAt: new Date("2027-01-01T00:00:00.000Z") };
const IN_DECEMBER = new Date("2026-12-10T00:00:00.000Z");

const prisma = new PrismaClient();
/** A second connection, to hold the project while a start runs. */
const holder = new PrismaClient();
const starts = createGenerationStartRepository(prisma);
const storyboards = createPrismaStoryboardRepositories(prisma);

let seq = 0;

function storyboardScene(
  id: string,
  videoProjectId: string,
  position: number,
  assetId: string,
  overrides: Partial<Omit<StoryboardScene, "createdAt" | "updatedAt">> = {},
): Omit<StoryboardScene, "createdAt" | "updatedAt"> {
  return {
    id,
    videoProjectId,
    propertyId: PROP_A,
    assetId,
    position,
    roomType: "KITCHEN",
    durationSeconds: 5,
    cameraMotion: "SLOW_PAN",
    compiledPrompt: `a bright room, scene ${position}`,
    sourceAnalysisRevision: 2,
    ...overrides,
  };
}

async function compose(
  videoProjectId: string,
  scenes: Omit<StoryboardScene, "createdAt" | "updatedAt">[],
  compositionFingerprint = FINGERPRINT,
): Promise<void> {
  await storyboards.scenes.saveComposition(ORG_A, videoProjectId, { scenes, compositionFingerprint });
}

/** A start of `videoProjectId` naming `sceneIds`, with fresh ids for everything it would write. */
function record(
  videoProjectId: string,
  sceneIds: readonly string[],
  overrides: Partial<GenerationStartRecord> = {},
): GenerationStartRecord {
  seq += 1;
  const n = seq;
  return {
    organizationId: ORG_A,
    videoProjectId,
    idempotencyKey: `start-key-${n}`,
    jobId: `genjob_start_${n}`,
    reservationId: `genres_start_${n}`,
    requestedByUserId: USER,
    qualityTier: videoProjectId === PROJECT_NORMAL ? "NORMAL" : "HIGH_QUALITY",
    disclosureMode: "THROUGHOUT",
    startedAt: STARTED_AT,
    storyboard: {
      compositionFingerprint: FINGERPRINT,
      scenes: sceneIds.map((storyboardSceneId, index) => ({
        storyboardSceneId,
        generationSceneId: `genscene_start_${n}_${index}`,
        initialRequestId: `genreq_start_${n}_${index}`,
      })),
    },
    context: ctx({ actorType: "USER", actorUserId: USER, eventType: "GENERATION_STARTED" }),
    audit: (started) => ({
      organizationId: ORG_A,
      actorUserId: USER,
      action: "generation.started",
      resourceType: "generation_job",
      resourceId: started.job.id,
      metadata: {
        videoProjectId,
        reservationId: started.reservation.id,
        sceneCount: started.sceneCount,
        allocations: started.allocations.length,
      },
    }),
    ...overrides,
  };
}

/** Every row a start could write, counted for both tenants. */
async function written(): Promise<Record<string, number>> {
  const jobs = await prisma.generationJob.findMany({
    where: { videoProject: { organizationId: { in: ORGS } } },
    select: { id: true },
  });
  const jobIds = jobs.map((job) => job.id);
  return {
    jobs: jobIds.length,
    reservations: await prisma.generationReservation.count({ where: { generationJobId: { in: jobIds } } }),
    allocations: await prisma.generationReservationAllocation.count({ where: { organizationId: { in: ORGS } } }),
    scenes: await prisma.generationScene.count({ where: { generationJobId: { in: jobIds } } }),
    requests: await prisma.sceneGenerationRequest.count({
      where: { generationScene: { generationJobId: { in: jobIds } } },
    }),
    events: await prisma.generationTransitionEvent.count({ where: { organizationId: { in: ORGS } } }),
    audits: await prisma.auditLog.count({ where: { organizationId: { in: ORGS }, action: "generation.started" } }),
  };
}

async function cleanup(): Promise<void> {
  const jobs = await prisma.generationJob.findMany({
    where: { videoProject: { organizationId: { in: ORGS } } },
    select: { id: true },
  });
  const jobIds = jobs.map((job) => job.id);
  await prisma.generationTransitionEvent.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.sceneGenerationRequest.deleteMany({ where: { generationScene: { generationJobId: { in: jobIds } } } });
  await prisma.generationScene.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationReservationAllocation.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.generationReservation.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.unitAddOnBlock.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId: { in: ORGS } } } });
  await prisma.videoProject.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.organization.deleteMany({ where: { id: { in: ORGS } } });
}

async function seedTenant(
  organizationId: string,
  propertyId: string,
  assetIds: string[],
  projects: [string, "720p" | "1080p"][],
): Promise<void> {
  await prisma.organization.create({ data: { id: organizationId, name: organizationId, slug: organizationId } });
  await prisma.property.create({
    data: { id: propertyId, organizationId, name: "Start fixture", propertyType: "APARTMENT", createdBy: USER },
  });
  for (const assetId of assetIds) {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        organizationId,
        propertyId,
        storageKey: `org/${organizationId}/${assetId}.jpg`,
        originalFilename: "seed.jpg",
        status: "READY",
        createdBy: USER,
      },
    });
  }
  for (const [id, targetOutputResolution] of projects) {
    await prisma.videoProject.create({
      data: {
        id,
        organizationId,
        propertyId,
        name: "Walkthrough",
        durationSeconds: 30,
        aspectRatio: "16:9",
        targetOutputResolution,
        createdBy: USER,
      },
    });
  }
  const opened = await createUnitEntitlementRepository(prisma).openPeriod({
    id: `uep_itest_start_${organizationId}`,
    organizationId,
    planKey: "standard",
    billingCycleKey: "2026-11",
    startsAt: NOVEMBER.startsAt,
    endsAt: NOVEMBER.endsAt,
    commercialReference: null,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
}

/** The next period, for a start key replayed across the boundary. */
async function openDecember(): Promise<void> {
  const opened = await createUnitEntitlementRepository(prisma).openPeriod({
    id: `uep_itest_start_${ORG_A}_dec`,
    organizationId: ORG_A,
    planKey: "standard",
    billingCycleKey: "2026-12",
    startsAt: DECEMBER.startsAt,
    endsAt: DECEMBER.endsAt,
    commercialReference: null,
    actorUserId: null,
  });
  if (opened.kind !== "OPENED") throw new Error(`period: ${opened.kind}`);
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, [ASSET_A1, ASSET_A2], [
    [PROJECT_HQ, "1080p"],
    [PROJECT_NORMAL, "720p"],
  ]);
  await seedTenant(ORG_B, PROP_B, [ASSET_B1], [[PROJECT_B, "1080p"]]);
  await compose(PROJECT_HQ, [
    storyboardScene("sbs_start_hq_1", PROJECT_HQ, 1, ASSET_A1),
    storyboardScene("sbs_start_hq_2", PROJECT_HQ, 2, ASSET_A2, { roomType: "LIVING_ROOM", cameraMotion: null }),
  ]);
  await compose(PROJECT_NORMAL, [storyboardScene("sbs_start_n_1", PROJECT_NORMAL, 1, ASSET_A2)]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
  await holder.$disconnect();
});

const HQ_SCENES = ["sbs_start_hq_1", "sbs_start_hq_2"];

/** Resolves once, when `promise` settles; never rejects. */
function settled<T>(promise: Promise<T>): { done: () => boolean; value: Promise<T> } {
  let finished = false;
  const value = promise.finally(() => {
    finished = true;
  });
  void value.catch(() => undefined);
  return { done: () => finished, value };
}

/** Whether `count` other backends are waiting on a lock within the deadline: the database says so. */
async function waitForBlocked(count: number, withinMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ wait_event_type: string | null }[]>(
      `SELECT wait_event_type FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (rows.filter((row) => row.wait_event_type === "Lock").length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Organization A's cost-admission lock for `billingCycleKey`, in the formula
 * every cost workflow derives, written out on purpose: if it ever changes,
 * this barrier stops blocking and the tests relying on it fail.
 */
async function holdCostAdmissionLock(tx: Tx, billingCycleKey: string): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${`paid-submission:${ORG_A}`}),
      hashtext(${`cycle:${billingCycleKey}`})
    )::text AS locked`;
}

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

describe.skipIf(!HAS_DB)("the start commit", () => {
  it("writes the job, its reservation, its scenes, their first requests and the audit entry together", async () => {
    const start = record(PROJECT_HQ, HQ_SCENES);
    const outcome = await starts.start(start);
    if (outcome.kind !== "STARTED") throw new Error(`expected STARTED, got ${outcome.kind}`);

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: start.jobId } });
    expect(job).toMatchObject({
      videoProjectId: PROJECT_HQ,
      idempotencyKey: start.idempotencyKey,
      requestedByUserId: USER,
      qualityTier: "HIGH_QUALITY",
      targetOutputResolution: "1080p",
      targetAspectRatio: "16:9",
      // The storyboard's two five-second scenes, not the project's 30 seconds.
      requestedDurationSeconds: 10,
      disclosureMode: "THROUGHOUT",
      requiredVideoUnits: 1,
      requiredHighQualityUnits: 1,
      // Reserved, and no further: the first attempts are GS-7's launch step.
      state: "RESERVED",
    });
    expect(outcome.job).toMatchObject({ id: start.jobId, state: "RESERVED", stateVersion: job.stateVersion });

    const reservation = await prisma.generationReservation.findUniqueOrThrow({
      where: { generationJobId: start.jobId },
      include: { allocations: true },
    });
    expect(reservation).toMatchObject({
      id: start.reservationId,
      funding: "ALLOCATED",
      entitlementPeriodId: `uep_itest_start_${ORG_A}`,
      reservedTotalVideoUnits: 1,
      reservedHighQualityUnits: 1,
      state: "RESERVED",
      reservedAt: STARTED_AT,
    });
    expect(reservation.allocations.map((a) => [a.sourceType, a.quality, a.quantity])).toEqual([
      ["BASE", "HIGH_QUALITY", 1],
    ]);
    expect(outcome.allocations).toHaveLength(1);

    const scenes = await prisma.generationScene.findMany({
      where: { generationJobId: start.jobId },
      orderBy: { position: "asc" },
    });
    expect(
      scenes.map((s) => [
        s.id,
        s.position,
        s.sourceStoryboardSceneId,
        s.sourceAssetId,
        s.sourceAnalysisRevision,
        s.snapshotDurationSeconds,
        s.snapshotCameraMotion,
        s.snapshotCompiledPrompt,
        s.state,
      ]),
    ).toEqual([
      [start.storyboard.scenes[0]!.generationSceneId, 1, "sbs_start_hq_1", ASSET_A1, 2, 5, "SLOW_PAN", "a bright room, scene 1", "PENDING"],
      [start.storyboard.scenes[1]!.generationSceneId, 2, "sbs_start_hq_2", ASSET_A2, 2, 5, null, "a bright room, scene 2", "PENDING"],
    ]);
    expect(outcome.scenes.map((s) => s.id)).toEqual(scenes.map((s) => s.id));

    const requests = await prisma.sceneGenerationRequest.findMany({
      where: { generationSceneId: { in: scenes.map((s) => s.id) } },
      orderBy: { id: "asc" },
    });
    expect(requests.map((r) => [r.id, r.generationSceneId, r.kind, r.state, r.requestedByUserId])).toEqual([
      [start.storyboard.scenes[0]!.initialRequestId, scenes[0]!.id, "INITIAL", "PENDING", USER],
      [start.storyboard.scenes[1]!.initialRequestId, scenes[1]!.id, "INITIAL", "PENDING", USER],
    ]);
    expect(outcome.requests.map((r) => r.id)).toEqual(requests.map((r) => r.id));

    const jobEvents = await prisma.generationTransitionEvent.findMany({
      where: { aggregateType: "JOB", aggregateId: start.jobId },
      orderBy: { sequence: "asc" },
    });
    expect(jobEvents.map((e) => [e.fromState, e.toState, e.organizationId, e.actorUserId])).toEqual([
      [null, "CREATED", ORG_A, USER],
      ["CREATED", "RESERVING", ORG_A, USER],
      ["RESERVING", "RESERVED", ORG_A, USER],
    ]);
    for (const [aggregateType, ids] of [
      ["SCENE", scenes.map((s) => s.id)],
      ["SCENE_REQUEST", requests.map((r) => r.id)],
    ] as const) {
      const events = await prisma.generationTransitionEvent.findMany({
        where: { aggregateType, aggregateId: { in: [...ids] } },
      });
      expect(events.map((e) => [e.fromState, e.toState, e.organizationId]).sort()).toEqual(
        ids.map(() => [null, "PENDING", ORG_A]),
      );
    }

    const audits = await prisma.auditLog.findMany({ where: { organizationId: ORG_A, action: "generation.started" } });
    expect(audits.map((a) => [a.resourceType, a.resourceId, a.actorUserId, a.metadata])).toEqual([
      [
        "generation_job",
        start.jobId,
        USER,
        { videoProjectId: PROJECT_HQ, reservationId: start.reservationId, sceneCount: 2, allocations: 1 },
      ],
    ]);
  });

  it("starts a 720p project at Normal, drawing a Normal Base Unit", async () => {
    const start = record(PROJECT_NORMAL, ["sbs_start_n_1"]);
    const outcome = await starts.start(start);
    if (outcome.kind !== "STARTED") throw new Error(`expected STARTED, got ${outcome.kind}`);
    expect(outcome.job).toMatchObject({ qualityTier: "NORMAL", requiredVideoUnits: 1, requiredHighQualityUnits: 0 });
    expect(outcome.allocations.map((a) => [a.sourceType, a.quality, a.quantity])).toEqual([["BASE", "NORMAL", 1]]);
  });

  it("scopes the start key to the project: one key may start two projects", async () => {
    const first = await starts.start(record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: "shared-key" }));
    const second = await starts.start(record(PROJECT_NORMAL, ["sbs_start_n_1"], { idempotencyKey: "shared-key" }));
    expect([first.kind, second.kind]).toEqual(["STARTED", "STARTED"]);
  });
});

describe.skipIf(!HAS_DB)("a start key", () => {
  it("answers a replay with the job it started, writing nothing, even after the storyboard changed", async () => {
    const first = record(PROJECT_HQ, HQ_SCENES);
    const started = await starts.start(first);
    expect(started.kind).toBe("STARTED");
    const after = await written();

    const replay = { ...record(PROJECT_HQ, HQ_SCENES), idempotencyKey: first.idempotencyKey };
    expect(await starts.start(replay)).toMatchObject({ kind: "EXISTING", job: { id: first.jobId } });
    await compose(PROJECT_HQ, [storyboardScene("sbs_start_hq_3", PROJECT_HQ, 1, ASSET_A2)], "sha256:start-second");
    expect(await starts.start(replay)).toMatchObject({ kind: "EXISTING", job: { id: first.jobId } });
    expect(await written()).toEqual(after);
  });

  it("lets two starts with one key in one period take turns, the second answering with the first's job", async () => {
    // Both wait at their period's cost-admission lock, so whichever goes
    // second reads the first's committed job as a replay.
    const key = "start-key-concurrent";
    const lock = await holdOpen(async (tx) => {
      await holdCostAdmissionLock(tx, "2026-11");
    });
    let both: Promise<Awaited<ReturnType<typeof starts.start>>[]>;
    try {
      both = Promise.all([
        starts.start(record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key })),
        starts.start(record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key })),
      ]);
      void both.catch(() => undefined);
      expect(await waitForBlocked(2)).toBe(true);
    } finally {
      await lock.release();
    }
    const outcomes = await both;
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["EXISTING", "STARTED"]);
    const ids = outcomes.map((o) => (o.kind === "STARTED" || o.kind === "EXISTING" ? o.job.id : null));
    expect(ids[0]).toBe(ids[1]);
    expect(await written()).toMatchObject({ jobs: 1, reservations: 1, scenes: 2, requests: 2, audits: 1 });
  });

  it("lets the start key decide between two starts in different periods", async () => {
    // A start made as one period ends and its replay made as the next begins
    // take different cost-admission locks. The first is held at its audit
    // entry, after its job is written; the second's job then waits on the
    // first's entry in the key's index, and answers with the first's job.
    await openDecember();
    const key = "start-key-boundary";
    const first = record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key });
    const second = record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key, startedAt: IN_DECEMBER });
    const organization = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${ORG_A} FOR UPDATE`;
    });
    let outcomes: Promise<Awaited<ReturnType<typeof starts.start>>[]>;
    try {
      const starting = starts.start(first);
      void starting.catch(() => undefined);
      expect(await waitForBlocked(1)).toBe(true);
      const replaying = starts.start(second);
      void replaying.catch(() => undefined);
      expect(await waitForBlocked(2)).toBe(true);
      outcomes = Promise.all([starting, replaying]);
      void outcomes.catch(() => undefined);
    } finally {
      await organization.release();
    }
    const [started, replayed] = await outcomes;
    expect(started).toMatchObject({ kind: "STARTED", job: { id: first.jobId } });
    expect(replayed).toEqual({ kind: "EXISTING", job: expect.objectContaining({ id: first.jobId }) });
    expect(await written()).toMatchObject({ jobs: 1, reservations: 1, audits: 1 });
  });

  it("lets the second of two such starts proceed when the first rolls back", async () => {
    await openDecember();
    const key = "start-key-rollback";
    const first = record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key });
    const second = record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: key, startedAt: IN_DECEMBER });
    const organization = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${ORG_A} FOR UPDATE`;
    });
    let replaying: Promise<Awaited<ReturnType<typeof starts.start>>> | undefined;
    try {
      const starting = starts.start(first);
      void starting.catch(() => undefined);
      expect(await waitForBlocked(1)).toBe(true);
      replaying = starts.start(second);
      void replaying.catch(() => undefined);
      expect(await waitForBlocked(2)).toBe(true);
      // The first start dies at its audit entry, as a lost connection would end it.
      const cancelled = await prisma.$queryRaw<{ cancelled: boolean }[]>`
        SELECT pg_cancel_backend("pid") AS "cancelled" FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND "query" LIKE '%audit_logs%'`;
      expect(cancelled.map((row) => row.cancelled)).toEqual([true]);
      await expect(starting).rejects.toThrow();
    } finally {
      await organization.release();
    }
    expect(await replaying).toMatchObject({ kind: "STARTED", job: { id: second.jobId } });
    expect(await prisma.generationJob.findUnique({ where: { id: first.jobId } })).toBeNull();
    expect(await written()).toMatchObject({ jobs: 1, reservations: 1, audits: 1 });
  });

  it("finds the job a key started, for its own project and organization only (ADR-0088)", async () => {
    const first = record(PROJECT_HQ, HQ_SCENES);
    expect((await starts.start(first)).kind).toBe("STARTED");
    expect(await starts.findStarted(ORG_A, PROJECT_HQ, first.idempotencyKey)).toMatchObject({
      id: first.jobId,
      organizationId: ORG_A,
      videoProjectId: PROJECT_HQ,
    });
    expect(await starts.findStarted(ORG_B, PROJECT_HQ, first.idempotencyKey)).toBeNull();
    expect(await starts.findStarted(ORG_A, PROJECT_NORMAL, first.idempotencyKey)).toBeNull();
    expect(await starts.findStarted(ORG_A, PROJECT_HQ, "start-key-never-sent")).toBeNull();
    // A missing key would match every job of the project.
    for (const key of ["", "k".repeat(201), undefined as unknown as string]) {
      await expect(starts.findStarted(ORG_A, PROJECT_HQ, key)).rejects.toThrow("start key of 1 to 200 characters");
    }
  });

  it("does not answer another organization's replay", async () => {
    const first = record(PROJECT_HQ, HQ_SCENES);
    expect((await starts.start(first)).kind).toBe("STARTED");
    const after = await written();
    const foreign = { ...record(PROJECT_HQ, HQ_SCENES), organizationId: ORG_B, idempotencyKey: first.idempotencyKey };
    expect(await starts.start(foreign)).toEqual({ kind: "PROJECT_NOT_FOUND" });
    expect(await written()).toEqual(after);
  });
});

describe.skipIf(!HAS_DB)("a refused start", () => {
  async function refusedWritingNothing(start: GenerationStartRecord, kind: string): Promise<void> {
    const before = await written();
    expect(await starts.start(start)).toMatchObject({ kind });
    expect(await written()).toEqual(before);
    expect(await prisma.generationJob.findUnique({ where: { id: start.jobId } })).toBeNull();
  }

  it("refuses another organization's project, and one that does not exist", async () => {
    await refusedWritingNothing({ ...record(PROJECT_HQ, HQ_SCENES), organizationId: ORG_B }, "PROJECT_NOT_FOUND");
    await refusedWritingNothing(record("vpr_itest_start_missing", HQ_SCENES), "PROJECT_NOT_FOUND");
  });

  it("refuses a storyboard that is not the one the service judged current", async () => {
    const fingerprint = record(PROJECT_HQ, HQ_SCENES);
    await refusedWritingNothing(
      { ...fingerprint, storyboard: { ...fingerprint.storyboard, compositionFingerprint: "sha256:stale" } },
      "STORYBOARD_CHANGED",
    );
    // The same scenes, in another order.
    await refusedWritingNothing(record(PROJECT_HQ, [...HQ_SCENES].reverse()), "STORYBOARD_CHANGED");
    // One scene short, and one too many.
    await refusedWritingNothing(record(PROJECT_HQ, HQ_SCENES.slice(0, 1)), "STORYBOARD_CHANGED");
    await refusedWritingNothing(record(PROJECT_HQ, [...HQ_SCENES, "sbs_start_n_1"]), "STORYBOARD_CHANGED");
    // The project marked stale since: its scenes no longer describe its inputs.
    await prisma.videoProject.update({ where: { id: PROJECT_HQ }, data: { status: "STORYBOARD_STALE" } });
    await refusedWritingNothing(record(PROJECT_HQ, HQ_SCENES), "STORYBOARD_CHANGED");
  });

  it("refuses an empty storyboard, even one whose fingerprint matches", async () => {
    await prisma.storyboardScene.deleteMany({ where: { videoProjectId: PROJECT_HQ } });
    await refusedWritingNothing(record(PROJECT_HQ, []), "STORYBOARD_CHANGED");
  });

  it("refuses a quality the project's resolution no longer gives", async () => {
    await refusedWritingNothing(record(PROJECT_HQ, HQ_SCENES, { qualityTier: "NORMAL" }), "QUALITY_CHANGED");
  });

  it("refuses a storyboard longer than a generation may be", async () => {
    await compose(PROJECT_NORMAL, [storyboardScene("sbs_start_long", PROJECT_NORMAL, 1, ASSET_A1, { durationSeconds: 95 })]);
    await refusedWritingNothing(record(PROJECT_NORMAL, ["sbs_start_long"]), "DURATION_NOT_SUPPORTED");
  });

  it("refuses a disclosure mode it cannot render", async () => {
    await refusedWritingNothing(
      record(PROJECT_HQ, HQ_SCENES, { disclosureMode: "NONE" as unknown as DisclosureMode }),
      "DISCLOSURE_MODE_NOT_SUPPORTED",
    );
  });

  it("refuses a start no period covers", async () => {
    await refusedWritingNothing(
      record(PROJECT_HQ, HQ_SCENES, { startedAt: new Date("2027-01-10T00:00:00.000Z") }),
      "NO_ENTITLEMENT_PERIOD",
    );
  });

  it("rolls the job back when the plan's one HQ Unit is spent", async () => {
    expect((await starts.start(record(PROJECT_HQ, HQ_SCENES))).kind).toBe("STARTED");
    const before = await written();
    const start = record(PROJECT_HQ, HQ_SCENES);
    expect(await starts.start(start)).toEqual({ kind: "INSUFFICIENT_ENTITLEMENT", eligibleUnits: 0 });
    expect(await written()).toEqual(before);
    expect(await prisma.generationJob.findUnique({ where: { id: start.jobId } })).toBeNull();
  });

  it("refuses a start key the column cannot hold, before anything is read", async () => {
    for (const idempotencyKey of ["", "k".repeat(201), undefined as unknown as string]) {
      const before = await written();
      await expect(starts.start(record(PROJECT_HQ, HQ_SCENES, { idempotencyKey }))).rejects.toThrow(
        "start key of 1 to 200 characters",
      );
      expect(await written()).toEqual(before);
    }
    // The longest key the column holds starts a job.
    expect((await starts.start(record(PROJECT_HQ, HQ_SCENES, { idempotencyKey: "k".repeat(200) }))).kind).toBe(
      "STARTED",
    );
  });

  it("rolls everything back when the audit entry names another organization", async () => {
    const before = await written();
    const start = record(PROJECT_HQ, HQ_SCENES);
    const misfiled = { ...start, audit: (started: Parameters<typeof start.audit>[0]) => ({ ...start.audit(started), organizationId: ORG_B }) };
    await expect(starts.start(misfiled)).rejects.toThrow("names another organization");
    expect(await written()).toEqual(before);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_B, action: "generation.started" } })).toBe(0);
  });

  it("rolls everything back when the audit entry cannot be built", async () => {
    const before = await written();
    const start = record(PROJECT_HQ, HQ_SCENES, {
      audit: () => {
        throw new Error("audit builder failed");
      },
    });
    await expect(starts.start(start)).rejects.toThrow("audit builder failed");
    expect(await written()).toEqual(before);
    // The Unit it would have held is still there for the next start.
    expect((await starts.start(record(PROJECT_HQ, HQ_SCENES))).kind).toBe("STARTED");
  });
});

describe.skipIf(!HAS_DB)("a start and a composition", () => {
  it("waits for a composition already saving, then judges the storyboard it left", async () => {
    // The holder is a composition half-way through: the project locked as
    // `saveComposition` locks it, and a new fingerprint written.
    const composition = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_HQ} FOR NO KEY UPDATE`;
      await tx.videoProject.update({ where: { id: PROJECT_HQ }, data: { compositionFingerprint: "sha256:start-held" } });
    });
    let starting: ReturnType<typeof settled<Awaited<ReturnType<typeof starts.start>>>>;
    const start = record(PROJECT_HQ, HQ_SCENES);
    try {
      starting = settled(starts.start(start));
      expect(await waitForBlocked(1)).toBe(true);
      expect(starting.done()).toBe(false);
    } finally {
      await composition.release();
    }
    expect(await starting.value).toEqual({ kind: "STORYBOARD_CHANGED" });
    expect(await prisma.generationJob.findUnique({ where: { id: start.jobId } })).toBeNull();
  });

  it("starts once a composition that changed nothing has committed", async () => {
    const composition = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_HQ} FOR NO KEY UPDATE`;
    });
    let starting: ReturnType<typeof settled<Awaited<ReturnType<typeof starts.start>>>>;
    try {
      starting = settled(starts.start(record(PROJECT_HQ, HQ_SCENES)));
      expect(await waitForBlocked(1)).toBe(true);
      expect(starting.done()).toBe(false);
    } finally {
      await composition.release();
    }
    expect((await starting.value).kind).toBe("STARTED");
  });

  it("waits for the cost-admission lock before it holds the project row", async () => {
    // The cost-admission lock is the outermost lock: a start waiting for it
    // holds no row, so a composition saves meanwhile, and the start then
    // judges the storyboard that composition left.
    const lock = await holdOpen(async (tx) => {
      await holdCostAdmissionLock(tx, "2026-11");
    });
    let starting: ReturnType<typeof settled<Awaited<ReturnType<typeof starts.start>>>>;
    try {
      starting = settled(starts.start(record(PROJECT_HQ, HQ_SCENES)));
      expect(await waitForBlocked(1)).toBe(true);
      await compose(PROJECT_HQ, [storyboardScene("sbs_start_hq_4", PROJECT_HQ, 1, ASSET_A2)], "sha256:start-meanwhile");
      expect(starting.done()).toBe(false);
    } finally {
      await lock.release();
    }
    expect(await starting.value).toEqual({ kind: "STORYBOARD_CHANGED" });
  });

  it("starts a ninety-scene storyboard within the default transaction limit", async () => {
    // The most scenes a 90-second storyboard can hold, at one second each.
    const scenes = Array.from({ length: 90 }, (_, index) =>
      storyboardScene(`sbs_start_many_${index + 1}`, PROJECT_NORMAL, index + 1, index % 2 === 0 ? ASSET_A1 : ASSET_A2, {
        durationSeconds: 1,
      }),
    );
    await compose(PROJECT_NORMAL, scenes);
    const outcome = await starts.start(record(PROJECT_NORMAL, scenes.map((scene) => scene.id)));
    expect(outcome).toMatchObject({ kind: "STARTED", job: { requestedDurationSeconds: 90, requiredVideoUnits: 3 } });
    expect(await written()).toMatchObject({ jobs: 1, scenes: 90, requests: 90 });
  });

  it("does not wait for another reader of the project, as another start or a job creation is", async () => {
    // Both hold the row FOR SHARE. A start that locked it any stronger would
    // queue behind every other start of the project; this one finishes while
    // the reader is still open.
    const reader = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "video_projects" WHERE "id" = ${PROJECT_HQ} FOR SHARE`;
    });
    try {
      expect((await starts.start(record(PROJECT_HQ, HQ_SCENES))).kind).toBe("STARTED");
    } finally {
      await reader.release();
    }
  });
});
