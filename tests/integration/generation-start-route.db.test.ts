import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscriptionRepository, getPrismaClient } from "@app/database";

/**
 * The start route through the web app's own composition, against PostgreSQL
 * (GS-10c, ADR-0111): the storyboard the web app composes is the one its start
 * offers and starts, at the quality the test provider's route serves, from the
 * Units the organization's plan gives, once.
 *
 * Only the session and the environment are stubbed; every service and
 * repository is the one the web app builds.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_start_route";
const OWNER = "usr_itest_start_route_owner";
/** A member who may view videos but not start one: no `video.generate`, no `unit.consume`. */
const VIEWER = "usr_itest_start_route_viewer";
/** Another organization, and its owner, who is no member of the first. */
const OTHER_ORG = "org_itest_start_route_other";
const OTHER_OWNER = "usr_itest_start_route_other";
const USERS = [OWNER, VIEWER, OTHER_OWNER];
const PROPERTY = "prp_itest_start_route";
const ASSETS = ["ast_itest_start_route_1", "ast_itest_start_route_2", "ast_itest_start_route_3"];
const ROOMS = ["LIVING_ROOM", "KITCHEN", "BEDROOM"] as const;
const SITE = "https://app.vtavision.test";
const DAY = 24 * 60 * 60 * 1000;

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ NODE_ENV: "test", VIDEO_PROVIDER: "fake", USER_SESSION_TTL_SECONDS: 3600 }),
}));
const signedIn = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: signedIn.id } }) }));

const { POST } = await import("@/app/api/video-projects/[projectId]/generations/route");
const { getGenerationStartService } = await import("@/lib/generation-start");
const { getStoryboardService } = await import("@/lib/storyboard");

const prisma = new PrismaClient();

async function cleanup(): Promise<void> {
  const jobs = await prisma.generationJob.findMany({
    where: { videoProject: { organizationId: ORG } },
    select: { id: true },
  });
  const jobIds = jobs.map((job) => job.id);
  await prisma.generationTransitionEvent.deleteMany({ where: { organizationId: ORG } });
  await prisma.sceneGenerationRequest.deleteMany({ where: { generationScene: { generationJobId: { in: jobIds } } } });
  await prisma.generationScene.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationReservationAllocation.deleteMany({ where: { organizationId: ORG } });
  await prisma.generationReservation.deleteMany({ where: { generationJobId: { in: jobIds } } });
  await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.unitEntitlementPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: ORG } });
  await prisma.storyboardScene.deleteMany({ where: { videoProject: { organizationId: ORG } } });
  await prisma.videoProject.deleteMany({ where: { organizationId: ORG } });
  await prisma.assetAnalysis.deleteMany({ where: { organizationId: ORG } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

let projectId: string;

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  signedIn.id = OWNER;
  for (const id of USERS) await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
  for (const id of [ORG, OTHER_ORG]) {
    await prisma.organization.create({ data: { id, name: id, slug: id.replaceAll("_", "-") } });
  }
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "OWNER" },
      { organizationId: ORG, userId: VIEWER, role: "VIEWER" },
      { organizationId: OTHER_ORG, userId: OTHER_OWNER, role: "OWNER" },
    ],
  });
  // A Standard plan that started before now, whatever the clock says now.
  const provisioned = await createSubscriptionRepository(prisma).provision({
    id: `sub_${ORG}`,
    organizationId: ORG,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: new Date(Date.now() - 40 * DAY),
    commercialReference: `VT-${ORG}`,
    actorUserId: null,
  });
  expect(provisioned.kind).toBe("PROVISIONED");
  await prisma.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "Start route", propertyType: "APARTMENT", createdBy: OWNER },
  });
  for (const [index, assetId] of ASSETS.entries()) {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        organizationId: ORG,
        propertyId: PROPERTY,
        storageKey: `org/${ORG}/${assetId}.jpg`,
        originalFilename: `${assetId}.jpg`,
        mimeType: "image/jpeg",
        width: 1600,
        height: 1200,
        status: "READY",
        createdBy: OWNER,
      },
    });
    await prisma.assetAnalysis.create({
      data: {
        id: `ana_${assetId}`,
        organizationId: ORG,
        assetId,
        provider: "fixed",
        status: "SUCCEEDED",
        roomType: ROOMS[index],
        confidence: 0.9,
        suggestedOrder: index + 1,
        reviewStatus: "APPROVED",
        reviewedBy: OWNER,
        reviewedAt: new Date(),
      },
    });
  }
  // 1080p, so HQ: the production route table offers Normal only; the test provider's offers both.
  const storyboards = getStoryboardService();
  const project = await storyboards.createProject(OWNER, ORG, PROPERTY, {
    name: "Tour",
    durationSeconds: 15,
    aspectRatio: "16:9",
    targetOutputResolution: "1080p",
  });
  projectId = project.id;
  await storyboards.compose(OWNER, ORG, projectId, { minSeconds: 5, maxSeconds: 5 });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
  await getPrismaClient().$disconnect();
});

/** What the start page will send: the offer it read, and a key made for it. */
async function confirmation(key: string): Promise<URLSearchParams> {
  const service = getGenerationStartService();
  if (service === null) throw new Error("the start is not built");
  const offer = await service.offer(OWNER, ORG, projectId);
  if (offer.kind !== "READY") throw new Error(`offer: ${offer.kind}`);
  const form = new URLSearchParams({
    organizationId: ORG,
    propertyId: PROPERTY,
    qualityTier: offer.qualityTier,
    idempotencyKey: key,
  });
  for (const scene of offer.scenes) form.append("sceneId", scene.id);
  return form;
}

async function post(form: URLSearchParams): Promise<{ path: string; error: string | null; started: string | null }> {
  const request = new Request(`${SITE}/api/video-projects/${projectId}/generations`, {
    method: "POST",
    headers: { host: "app.vtavision.test", origin: SITE, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const response = await POST(request, { params: Promise.resolve({ projectId }) });
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location") ?? "");
  return { path: url.pathname, error: url.searchParams.get("error"), started: url.searchParams.get("started") };
}

async function jobs() {
  return prisma.generationJob.findMany({
    where: { videoProjectId: projectId },
    select: { qualityTier: true, requestedByUserId: true, reservation: { select: { state: true } } },
  });
}

describe.skipIf(!HAS_DB)("the start route through the web app's composition, in PostgreSQL", () => {
  it("starts the composed storyboard once, at HQ, and answers a second start with the video", async () => {
    const projectPage = `/properties/${PROPERTY}/video-projects/${projectId}`;
    const form = await confirmation("route-key-1");
    expect(form.getAll("sceneId")).toHaveLength(3);

    expect(await post(form)).toEqual({ path: projectPage, error: null, started: "1" });
    expect(await jobs()).toEqual([
      { qualityTier: "HIGH_QUALITY", requestedByUserId: OWNER, reservation: { state: "RESERVED" } },
    ]);
    const audited = await prisma.auditLog.findMany({ where: { organizationId: ORG, action: "generation.started" } });
    expect(audited.map((entry) => entry.actorUserId)).toEqual([OWNER]);

    // The same confirmation again is the same start.
    expect(await post(form)).toEqual({ path: projectPage, error: null, started: "1" });
    // A new confirmation finds the project's video (ADR-0110).
    form.set("idempotencyKey", "route-key-2");
    expect(await post(form)).toEqual({
      path: `${projectPage}/start`,
      error: "This project already has a video, in progress or delivered. Nothing new was started.",
      started: null,
    });
    expect(await jobs()).toHaveLength(1);
  });

  const REFUSED = "You cannot start videos for this project. Nothing new was started.";
  const NOT_FOUND = "The video project was not found. Nothing new was started.";

  it.each([
    ["a member who may not start videos", VIEWER, ORG, REFUSED],
    ["a member of another organization, naming it", OTHER_OWNER, OTHER_ORG, NOT_FOUND],
    ["a member of another organization, naming this one", OTHER_OWNER, ORG, REFUSED],
  ])("starts nothing for %s", async (_who, actor, organizationId, message) => {
    const form = await confirmation("route-key-4");
    form.set("organizationId", organizationId);
    signedIn.id = actor;

    expect(await post(form)).toEqual({
      path: `/properties/${PROPERTY}/video-projects/${projectId}/start`,
      error: message,
      started: null,
    });
    expect(await jobs()).toEqual([]);
    const started = { action: "generation.started", organizationId: { in: [ORG, OTHER_ORG] } };
    expect(await prisma.auditLog.count({ where: started })).toBe(0);
  });

  it("starts nothing, and reserves nothing, for scenes the test provider's route cannot make (ADR-0123)", async () => {
    // Nine seconds between the three photos: 3-second scenes, where the route makes 5 to 15.
    const storyboards = getStoryboardService();
    const short = await storyboards.createProject(OWNER, ORG, PROPERTY, {
      name: "Short",
      durationSeconds: 9,
      aspectRatio: "16:9",
      targetOutputResolution: "720p",
    });
    await storyboards.compose(OWNER, ORG, short.id, { minSeconds: 3, maxSeconds: 3 });
    const view = await storyboards.getStoryboard(OWNER, ORG, short.id);
    const offer = await getGenerationStartService()?.offer(OWNER, ORG, short.id);
    expect(offer).toEqual({
      kind: "SCENE_LENGTHS_NOT_SUPPORTED",
      durations: { kind: "RANGE", minSeconds: 5, maxSeconds: 15 },
      durationSeconds: 9,
      sceneCount: 3,
      scenes: view.scenes.map((scene) => ({ id: scene.id, position: scene.position, durationSeconds: 3 })),
    });
    expect(view.scenes.map((scene) => scene.position)).toEqual([1, 2, 3]);

    projectId = short.id;
    const form = new URLSearchParams({
      organizationId: ORG,
      propertyId: PROPERTY,
      qualityTier: "NORMAL",
      idempotencyKey: "route-key-short",
    });
    for (const scene of view.scenes) form.append("sceneId", scene.id);
    expect(await post(form)).toEqual({
      path: `/properties/${PROPERTY}/video-projects/${short.id}/start`,
      error: "Some scenes are a length this video cannot be made at. Nothing was started.",
      started: null,
    });
    expect(await prisma.generationJob.count({ where: { videoProject: { organizationId: ORG } } })).toBe(0);
    expect(await prisma.generationReservationAllocation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.unitEntitlementPeriod.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: "generation.started" } })).toBe(0);
  });

  it("starts nothing from a confirmation of another storyboard", async () => {
    const form = await confirmation("route-key-3");
    const scenes = form.getAll("sceneId");
    form.delete("sceneId");
    for (const scene of scenes.reverse()) form.append("sceneId", scene);

    expect(await post(form)).toEqual({
      path: `/properties/${PROPERTY}/video-projects/${projectId}/start`,
      error: "The storyboard changed after you reviewed it. Nothing was started. Review it again.",
      started: null,
    });
    expect(await jobs()).toEqual([]);
  });
});
