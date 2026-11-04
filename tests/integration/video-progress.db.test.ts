import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthService,
  GENERATION_JOB_STATES,
  GENERATION_RESERVATION_STATES,
  VideoProgressService,
  type GenerationJobState,
  type GenerationReservationState,
  type GenerationSceneState,
} from "@app/domain";
import {
  createPrismaIdentityRepositories,
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createVideoProgressRepository,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";
import {
  ASSET_A,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  PROP_A,
  seedPriorDeliverable,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * A project's newest video against PostgreSQL (GS-11a, ADR-0113): the newest
 * job is the one read, with its reservation and its scenes, every state reads
 * back in its own vocabulary, and no organization reads another's video.
 *
 * The rows are written directly: what is read is any job, in any state, and
 * the writers that move a job between states are proved in their own suites.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const progress = HAS_DB
  ? createVideoProgressRepository(prisma)
  : (null as unknown as ReturnType<typeof createVideoProgressRepository>);

const DOMAIN = "video-progress.itest";
const EARLIER = new Date("2026-09-15T00:00:00.000Z");
const BETWEEN = new Date("2026-09-15T12:00:00.000Z");
const LATER = new Date("2026-09-16T00:00:00.000Z");
let sequence = 0;

interface SeededJob {
  readonly organizationId?: string;
  readonly videoProjectId?: string;
  readonly state: GenerationJobState;
  readonly createdAt?: Date;
  readonly reservation?: GenerationReservationState | null;
  readonly scenes?: readonly GenerationSceneState[];
  readonly normal?: boolean;
}

async function seedJob(id: string, job: SeededJob): Promise<void> {
  const normal = job.normal ?? false;
  await prisma.generationJob.create({
    data: {
      id,
      videoProjectId: job.videoProjectId ?? PROJECT_A,
      requestedByUserId: "usr_itest",
      qualityTier: normal ? "NORMAL" : "HIGH_QUALITY",
      targetOutputResolution: normal ? "720p" : "1080p",
      targetAspectRatio: "16:9",
      requestedDurationSeconds: 45,
      disclosureMode: "THROUGHOUT",
      requiredVideoUnits: 2,
      requiredHighQualityUnits: normal ? 0 : 2,
      state: job.state,
      createdAt: job.createdAt ?? EARLIER,
    },
  });
  const reservation = job.reservation === undefined ? "RESERVED" : job.reservation;
  if (reservation !== null) {
    await prisma.generationReservation.create({
      data: {
        id: `gres_${id}`,
        generationJobId: id,
        billingCycleKey: "2026-09",
        billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
        // Outside the ledger, as no Unit arithmetic is read here.
        funding: "UNALLOCATED_LEGACY",
        reservedTotalVideoUnits: 2,
        reservedHighQualityUnits: normal ? 0 : 2,
        state: reservation,
      },
    });
  }
  for (const [position, state] of (job.scenes ?? []).entries()) {
    await prisma.generationScene.create({
      data: {
        id: `gscn_${id}_${position}`,
        generationJobId: id,
        position,
        sourceStoryboardSceneId: `sbs_${id}_${position}`,
        sourceAssetId: ASSET_A,
        sourceAnalysisRevision: 1,
        snapshotDurationSeconds: 15,
        state,
      },
    });
  }
}

/** Points the job at a delivered version of its own, as delivering it does; that version. */
async function deliver(id: string): Promise<string> {
  const versionId = await seedPriorDeliverable(prisma, id, id.replace(/^gjob_/, ""));
  await prisma.generationJob.update({ where: { id }, data: { currentDeliverableVersionId: versionId } });
  return versionId;
}

describe.skipIf(!HAS_DB)("a project's newest video", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
    // Their memberships and sessions go with them.
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("is none for a project whose video was never started", async () => {
    expect(await progress.findLatest(ORG_A, PROJECT_A)).toBeNull();
  });

  it("is the newest job, with its reservation and how many of its scenes are made", async () => {
    // Neither the first row written, the last, nor the greatest id is the
    // newest, so only the start time orders them.
    await seedJob("gjob_vp_old", { state: "FAILED_TERMINAL", reservation: "RELEASED", scenes: ["FAILED_TERMINAL"] });
    await seedJob("gjob_vp_new", {
      state: "GENERATING",
      createdAt: LATER,
      scenes: ["READY", "REVISING", "GENERATING", "READY", "PENDING"],
    });
    await seedJob("gjob_vp_mid", { state: "CANCELLED", reservation: "RELEASED", createdAt: BETWEEN });

    expect(await progress.findLatest(ORG_A, PROJECT_A)).toEqual({
      jobId: "gjob_vp_new",
      jobState: "GENERATING",
      deliveredVersionId: null,
      qualityTier: "HIGH_QUALITY",
      durationSeconds: 45,
      requiredUnits: 2,
      reservationState: "RESERVED",
      sceneCount: 5,
      scenesReady: 2,
    });
  });

  it("breaks a tie in start time by id, as the start orders a project's jobs", async () => {
    // The greatest id is neither the first row written nor the last.
    await seedJob("gjob_vp_a", { state: "FAILED_TERMINAL", reservation: "RELEASED" });
    await seedJob("gjob_vp_c", { state: "RESERVED" });
    await seedJob("gjob_vp_b", { state: "CANCELLED", reservation: "RELEASED" });
    expect((await progress.findLatest(ORG_A, PROJECT_A))?.jobId).toBe("gjob_vp_c");
  });

  it("reads a video being made again as delivered, with its version and the Units it used", async () => {
    // A revision's shape (ADR-0110 Decision 4): generating again, its Units
    // used, and the video it delivered still current.
    await seedJob("gjob_vp_revision", { state: "GENERATING", reservation: "CONSUMED", scenes: ["READY", "REVISING"] });
    const versionId = await deliver("gjob_vp_revision");
    expect(await progress.findLatest(ORG_A, PROJECT_A)).toMatchObject({
      jobState: "GENERATING",
      deliveredVersionId: versionId,
      reservationState: "CONSUMED",
      sceneCount: 2,
      scenesReady: 1,
    });
  });

  it("reads a job with no reservation and no scenes", async () => {
    await seedJob("gjob_vp_bare", { state: "CANCELLED", reservation: null, normal: true });
    expect(await progress.findLatest(ORG_A, PROJECT_A)).toMatchObject({
      jobState: "CANCELLED",
      qualityTier: "NORMAL",
      requiredUnits: 2,
      reservationState: null,
      sceneCount: 0,
      scenesReady: 0,
    });
  });

  it("reads back every job state and every reservation state", async () => {
    for (const [index, state] of GENERATION_JOB_STATES.entries()) {
      await seedJob(`gjob_vp_state_${index}`, { state, createdAt: new Date(EARLIER.getTime() + index * 1000) });
      expect((await progress.findLatest(ORG_A, PROJECT_A))?.jobState).toBe(state);
    }
    await wipeOrchestration(prisma);
    for (const [index, reservation] of GENERATION_RESERVATION_STATES.entries()) {
      await seedJob(`gjob_vp_units_${index}`, {
        state: "GENERATING",
        reservation,
        createdAt: new Date(EARLIER.getTime() + index * 1000),
      });
      expect((await progress.findLatest(ORG_A, PROJECT_A))?.reservationState).toBe(reservation);
    }
  });

  it("reads no organization's video for another", async () => {
    await seedJob("gjob_vp_a_only", { state: "GENERATING" });
    await seedJob("gjob_vp_b_only", { state: "COMPOSING", videoProjectId: PROJECT_B });

    // Another organization's project reads as one with no video, both ways.
    expect(await progress.findLatest(ORG_B, PROJECT_A)).toBeNull();
    expect(await progress.findLatest(ORG_A, PROJECT_B)).toBeNull();
    expect((await progress.findLatest(ORG_A, PROJECT_A))?.jobId).toBe("gjob_vp_a_only");
    expect((await progress.findLatest(ORG_B, PROJECT_B))?.jobId).toBe("gjob_vp_b_only");
  });

  it("refuses a read that names no organization or no project", async () => {
    for (const [organizationId, videoProjectId] of [
      ["", PROJECT_A],
      [ORG_A, ""],
    ] as const) {
      await expect(progress.findLatest(organizationId, videoProjectId)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
  });

  it("answers the service's members through the real repositories", async () => {
    const identity = {
      repos: createPrismaIdentityRepositories(prisma),
      clock: new TestClock(EARLIER),
      ids: { generate: (prefix: string) => `${prefix}_itest_video_progress_${(sequence += 1)}` },
      passwords: fakePasswordHasher,
      tokens: fakeTokenService(),
    };
    const auth = new AuthService(identity, { sessionTtlSeconds: 3600 });
    const member = async (name: string, role: "OWNER" | "VIEWER") => {
      const user = await auth.register({ email: `${name}@${DOMAIN}`, name, password: "password-123456" });
      await identity.repos.memberships.create({ organizationId: ORG_A, userId: user.id, role });
      return user.id;
    };
    const owner = await member("owner", "OWNER");
    const viewer = await member("viewer", "VIEWER");
    const service = new VideoProgressService({
      identity,
      properties: createPrismaPropertyRepositories(prisma).properties,
      projects: createPrismaStoryboardRepositories(prisma).projects,
      progress,
    });
    await seedJob("gjob_vp_service", { state: "DELIVERABLE_READY", reservation: "CONSUMED", scenes: ["READY"] });
    await deliver("gjob_vp_service");

    expect(await service.progress(owner, ORG_A, PROJECT_A)).toEqual({
      phase: "COMPLETED",
      qualityTier: "HIGH_QUALITY",
      durationSeconds: 45,
      units: { count: 2, state: "CONSUMED" },
      scenes: { ready: 1, total: 1 },
      supportReference: "gjob_vp_service",
    });
    // A VIEWER reaches only the Properties it is responsible for.
    await expect(service.progress(viewer, ORG_A, PROJECT_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.property.update({ where: { id: PROP_A }, data: { responsibleUserId: viewer } });
    try {
      expect((await service.progress(viewer, ORG_A, PROJECT_A))?.phase).toBe("COMPLETED");
    } finally {
      await prisma.property.update({ where: { id: PROP_A }, data: { responsibleUserId: null } });
    }
    // Another organization's project is not found from this one.
    await expect(service.progress(owner, ORG_A, PROJECT_B)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
