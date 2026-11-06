import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { managedDeliverableOutputKey } from "@app/domain";
import { getPrismaClient } from "@app/database";
import {
  ASSET_A,
  dropTenants,
  HAS_DB,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROP_A,
  seedPriorDeliverable,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The download route through the web app's own composition, against
 * PostgreSQL (GS-12c-3, ADR-0120): a member holding `video.download` is sent to
 * a link the signed route serves as an attachment named after the project, and
 * each press is audited; a member out of reach, one of another organization and
 * a project with no delivered video come back to the page, with nothing
 * audited.
 *
 * Only the session and the environment are stubbed; every service, repository
 * and store is the one the web app builds (the in-memory store, as no shared
 * folder is set).
 */
const SITE = "https://app.vtavision.test";
const OWNER = "usr_itest_download_route_owner";
/** A VIEWER holds `video.download`, but reaches only the Properties assigned to it, and PROP_A is not. */
const VIEWER = "usr_itest_download_route_viewer";
/** The owner of another organization, and no member of ORG_A. */
const OTHER_OWNER = "usr_itest_download_route_other";
const USERS = [OWNER, VIEWER, OTHER_OWNER];
const JOB = "gjob_itest_download_route";
const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    NODE_ENV: "test",
    USER_SESSION_TTL_SECONDS: 3600,
    STORAGE_SIGNING_SECRET: "itest-download-route-signing-secret-0123456789",
  }),
}));
const signedIn = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve({ user: { id: signedIn.id } }) }));

const { POST } = await import("@/app/api/video-projects/[projectId]/download/route");
const { GET } = await import("@/app/api/storage/download/route");
const { getPropertyServices } = await import("@/lib/property");

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

/** A job of PROJECT_A in `state`, its Units in `reservation`, as the progress read's suite writes them. */
async function seedJob(state: "DELIVERABLE_READY" | "GENERATING", reservation: "CONSUMED" | "RESERVED") {
  await prisma.generationJob.create({
    data: {
      id: JOB,
      videoProjectId: PROJECT_A,
      requestedByUserId: OWNER,
      qualityTier: "HIGH_QUALITY",
      targetOutputResolution: "1080p",
      targetAspectRatio: "16:9",
      requestedDurationSeconds: 45,
      disclosureMode: "THROUGHOUT",
      requiredVideoUnits: 2,
      requiredHighQualityUnits: 2,
      state,
    },
  });
  await prisma.generationReservation.create({
    data: {
      id: `gres_${JOB}`,
      generationJobId: JOB,
      billingCycleKey: "2026-09",
      billingCycleStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      billingCycleEndsAt: new Date("2026-10-01T00:00:00.000Z"),
      funding: "UNALLOCATED_LEGACY",
      reservedTotalVideoUnits: 2,
      reservedHighQualityUnits: 2,
      state: reservation,
    },
  });
  await prisma.generationScene.create({
    data: {
      id: `gscn_${JOB}`,
      generationJobId: JOB,
      position: 0,
      sourceStoryboardSceneId: `sbs_${JOB}`,
      sourceAssetId: ASSET_A,
      sourceAnalysisRevision: 1,
      snapshotDurationSeconds: 15,
      state: state === "DELIVERABLE_READY" ? "READY" : "GENERATING",
    },
  });
}

/** Delivers the job's version, and stores its file where the link names it; the version. */
async function deliver(): Promise<string> {
  const versionId = await seedPriorDeliverable(prisma, JOB, "itest_download_route");
  await prisma.generationJob.update({ where: { id: JOB }, data: { currentDeliverableVersionId: versionId } });
  const key = managedDeliverableOutputKey({ organizationId: ORG_A, deliverableVersionId: versionId });
  await getPropertyServices().storage.putObject(key, VIDEO);
  return versionId;
}

async function post(organizationId: string): Promise<Response> {
  const request = new Request(`${SITE}/api/video-projects/${PROJECT_A}/download`, {
    method: "POST",
    headers: { host: "app.vtavision.test", origin: SITE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ organizationId, propertyId: PROP_A }).toString(),
  });
  return POST(request, { params: Promise.resolve({ projectId: PROJECT_A }) });
}

async function downloadsAudited() {
  return prisma.auditLog.findMany({
    where: { action: "video.download_link_issued", organizationId: { in: [ORG_A, ORG_B] } },
    select: { organizationId: true, actorUserId: true, resourceType: true, resourceId: true, metadata: true },
  });
}

describe.skipIf(!HAS_DB)("the download route through the web app's composition, in PostgreSQL", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    for (const id of USERS) await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id } });
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: OWNER, role: "OWNER" },
        { organizationId: ORG_A, userId: VIEWER, role: "VIEWER" },
        { organizationId: ORG_B, userId: OTHER_OWNER, role: "OWNER" },
      ],
    });
    signedIn.id = OWNER;
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    // Their memberships go with them.
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    await dropTenants(prisma);
    await prisma.$disconnect();
    await getPrismaClient().$disconnect();
  });

  it("sends the owner to a link that saves the video under the project's name, audited each press", async () => {
    await seedJob("DELIVERABLE_READY", "CONSUMED");
    const versionId = await deliver();

    const response = await post(ORG_A);
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const link = response.headers.get("location") ?? "";
    expect(link).toMatch(/^\/api\/storage\/download\?token=/);
    expect(await downloadsAudited()).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: OWNER,
        resourceType: "generation_deliverable_version",
        resourceId: versionId,
        metadata: { jobId: JOB },
      },
    ]);

    // The browser follows it, resolved against the address it posted to.
    const served = await GET(new Request(new URL(link, `${SITE}/api/video-projects/${PROJECT_A}/download`)));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("video/mp4");
    expect(served.headers.get("content-disposition")).toContain("attachment;");
    expect(served.headers.get("content-disposition")).toContain("filename*=UTF-8''Orchestration%20project.mp4");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(VIDEO);

    // Each press is its own download.
    await post(ORG_A);
    expect(await downloadsAudited()).toHaveLength(2);
  });

  it.each([
    ["a VIEWER the Property is not assigned to", VIEWER, ORG_A],
    ["the owner of another organization, naming this one", OTHER_OWNER, ORG_A],
    ["the owner of another organization, naming theirs", OTHER_OWNER, ORG_B],
  ])("sends %s back to the page as one who may not download it, auditing nothing", async (_who, actor, org) => {
    await seedJob("DELIVERABLE_READY", "CONSUMED");
    await deliver();
    signedIn.id = actor;

    const response = await post(org);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${SITE}/properties/${PROP_A}/video-projects/${PROJECT_A}?download=forbidden`,
    );
    expect(await downloadsAudited()).toEqual([]);
  });

  it("sends the owner back to the page when the project's video is not delivered, auditing nothing", async () => {
    await seedJob("GENERATING", "RESERVED");

    const response = await post(ORG_A);
    expect(response.headers.get("location")).toBe(
      `${SITE}/properties/${PROP_A}/video-projects/${PROJECT_A}?download=none`,
    );
    expect(await downloadsAudited()).toEqual([]);
  });
});
