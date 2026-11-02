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
const PROPERTY = "prp_itest_start_route";
const ASSETS = ["ast_itest_start_route_1", "ast_itest_start_route_2", "ast_itest_start_route_3"];
const ROOMS = ["LIVING_ROOM", "KITCHEN", "BEDROOM"] as const;
const SITE = "https://app.vtavision.test";
const DAY = 24 * 60 * 60 * 1000;

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ NODE_ENV: "test", VIDEO_PROVIDER: "fake", USER_SESSION_TTL_SECONDS: 3600 }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: OWNER } }) }));

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
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: OWNER } });
}

let projectId: string;

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.user.create({ data: { id: OWNER, email: `${OWNER}@example.com`, name: "Owner" } });
  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: ORG.replaceAll("_", "-") } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: OWNER, role: "OWNER" } });
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
