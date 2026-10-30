import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuthService, GenerationStartService, type StartGenerationInput, type StoryboardView } from "@app/domain";
import {
  createGenerationStartRepository,
  createPrismaIdentityRepositories,
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";

/**
 * The start service against PostgreSQL (GS-4c, ADR-0088): the record it builds
 * is one the real start commit accepts, the Unit period it opens is the one the
 * commit reserves from, and a refusal the commit makes after that period is
 * opened leaves the period, with its own audit entry, and nothing else.
 *
 * Freshness is the storyboard service's and is proved with it, so the
 * storyboard here is read from the real repositories and taken as current.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const DOMAIN = "start-service.itest";
const ORG = "org_itest_start_service";
const PROPERTY = "prp_itest_start_service";
const PROJECT = "vpr_itest_start_service";
const ASSETS = ["ast_itest_start_service_1", "ast_itest_start_service_2"];
const SCENES = ["sbs_itest_start_service_1", "sbs_itest_start_service_2"];
const FINGERPRINT = "sha256:start-service";
/** Renewal period 1 of a Standard plan anchored on 15 March: 15 April to 15 May. */
const NOW = new Date("2026-04-20T09:00:00.000Z");
const PERIOD = `uep_sub_${ORG}_1`;

const prisma = new PrismaClient();
const clock = new TestClock(NOW);
let sequence = 0;
const identity = {
  repos: createPrismaIdentityRepositories(prisma),
  clock,
  ids: { generate: (prefix: string) => `${prefix}_itest_start_service_${(sequence += 1)}` },
  passwords: fakePasswordHasher,
  tokens: fakeTokenService(),
};
const storyboards = createPrismaStoryboardRepositories(prisma);
/** The project's own fingerprint unless a test says otherwise. */
let fingerprint: string | null = null;

const service = new GenerationStartService({
  identity,
  properties: createPrismaPropertyRepositories(prisma).properties,
  storyboard: {
    async getStoryboard(_actorUserId, organizationId, videoProjectId): Promise<StoryboardView> {
      const project = await storyboards.projects.findById(organizationId, videoProjectId);
      if (project === null) throw new Error("no such project");
      const scenes = await storyboards.scenes.listByProject(organizationId, videoProjectId);
      return { project: { ...project, compositionFingerprint: fingerprint ?? project.compositionFingerprint }, scenes, fresh: true };
    },
  },
  qualities: { offers: () => true },
  subscriptions: createSubscriptionRepository(prisma),
  ledger: createUnitEntitlementRepository(prisma),
  starts: createGenerationStartRepository(prisma),
});

let owner: string;

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const jobs = await prisma.generationJob.findMany({ where: { videoProject: { organizationId: ORG } }, select: { id: true } });
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
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
}

/** What a start could write: the job rows, the period, and both kinds of audit entry. */
async function written(): Promise<Record<string, number>> {
  return {
    jobs: await prisma.generationJob.count({ where: { videoProject: { organizationId: ORG } } }),
    reservations: await prisma.generationReservation.count({ where: { generationJob: { videoProject: { organizationId: ORG } } } }),
    scenes: await prisma.generationScene.count({ where: { generationJob: { videoProject: { organizationId: ORG } } } }),
    periods: await prisma.unitEntitlementPeriod.count({ where: { organizationId: ORG } }),
    started: await prisma.auditLog.count({ where: { organizationId: ORG, action: "generation.started" } }),
    periodOpened: await prisma.auditLog.count({ where: { organizationId: ORG, action: "entitlement.period_opened" } }),
  };
}

function input(overrides: Partial<StartGenerationInput> = {}): StartGenerationInput {
  return {
    organizationId: ORG,
    videoProjectId: PROJECT,
    idempotencyKey: "start-service-key-1",
    confirmed: { qualityTier: "HIGH_QUALITY", storyboardSceneIds: SCENES },
    ...overrides,
  };
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  clock.set(NOW);
  fingerprint = null;
  owner = (await new AuthService(identity, { sessionTtlSeconds: 3600 }).register({
    email: `owner@${DOMAIN}`,
    name: "owner",
    password: "password-123456",
  })).id;
  await identity.repos.organizations.create({ id: ORG, name: ORG, slug: ORG.replaceAll("_", "-"), status: "ACTIVE" });
  await identity.repos.memberships.create({ organizationId: ORG, userId: owner, role: "OWNER" });
  const provisioned = await createSubscriptionRepository(prisma).provision({
    id: `sub_${ORG}`,
    organizationId: ORG,
    planKey: "standard",
    channel: "SALES_ASSISTED",
    anchorAt: new Date("2026-03-15T00:00:00.000Z"),
    commercialReference: `VT-${ORG}`,
    actorUserId: null,
  });
  expect(provisioned.kind).toBe("PROVISIONED");
  await prisma.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "Start service", propertyType: "APARTMENT", createdBy: owner },
  });
  for (const assetId of ASSETS) {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        organizationId: ORG,
        propertyId: PROPERTY,
        storageKey: `org/${ORG}/${assetId}.jpg`,
        originalFilename: "seed.jpg",
        status: "READY",
        createdBy: owner,
      },
    });
  }
  // 1080p, so HQ: the Standard plan's one HQ Unit is all a start of it can draw.
  await prisma.videoProject.create({
    data: {
      id: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      name: "Walkthrough",
      durationSeconds: 10,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      createdBy: owner,
    },
  });
  await storyboards.scenes.saveComposition(ORG, PROJECT, {
    scenes: SCENES.map((id, index) => ({
      id,
      videoProjectId: PROJECT,
      propertyId: PROPERTY,
      assetId: ASSETS[index]!,
      position: index + 1,
      roomType: "KITCHEN",
      durationSeconds: 5,
      cameraMotion: null,
      compiledPrompt: `a bright room, scene ${index + 1}`,
      sourceAnalysisRevision: 1,
    })),
    compositionFingerprint: FINGERPRINT,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("the start service against the start commit", () => {
  it("starts the storyboard, reserving from the period it opened at the same instant", async () => {
    const outcome = await service.start(owner, input());
    if (outcome.kind !== "STARTED") throw new Error(`expected STARTED, got ${outcome.kind}`);

    expect(outcome.job).toMatchObject({ videoProjectId: PROJECT, qualityTier: "HIGH_QUALITY", state: "RESERVED" });
    expect(outcome.reservation).toMatchObject({ entitlementPeriodId: PERIOD, reservedAt: NOW, state: "RESERVED" });
    expect(outcome.allocations.map((a) => [a.sourceType, a.quality, a.quantity])).toEqual([["BASE", "HIGH_QUALITY", 1]]);
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: outcome.job.id } });
    expect(row).toMatchObject({ idempotencyKey: "start-service-key-1", requestedByUserId: owner, disclosureMode: "THROUGHOUT" });
    const scenes = await prisma.generationScene.findMany({ where: { generationJobId: row.id }, orderBy: { position: "asc" } });
    expect(scenes.map((scene) => scene.sourceStoryboardSceneId)).toEqual(SCENES);
    const [entry] = await prisma.auditLog.findMany({ where: { organizationId: ORG, action: "generation.started" } });
    expect(entry).toMatchObject({ actorUserId: owner, resourceType: "generation_job", resourceId: row.id });
    expect(await written()).toEqual({ jobs: 1, reservations: 1, scenes: 2, periods: 1, started: 1, periodOpened: 1 });
  });

  it("answers a replay with the job it started, writing nothing more", async () => {
    const first = await service.start(owner, input());
    if (first.kind !== "STARTED") throw new Error(`expected STARTED, got ${first.kind}`);
    const after = await written();
    expect(await service.start(owner, input())).toEqual({ kind: "ALREADY_STARTED", job: first.job });
    expect(await written()).toEqual(after);
  });

  it("answers short Units with the real eligible count, once the plan's one HQ Unit is spent", async () => {
    expect((await service.start(owner, input())).kind).toBe("STARTED");
    const after = await written();
    expect(await service.start(owner, input({ idempotencyKey: "start-service-key-2" }))).toEqual({
      kind: "INSUFFICIENT_UNITS",
      eligibleUnits: 0,
    });
    expect(await written()).toEqual(after);
  });

  it("offers the funding the start then reserves, opening no period", async () => {
    expect(await service.offer(owner, ORG, PROJECT)).toEqual({
      kind: "READY",
      qualityTier: "HIGH_QUALITY",
      scenes: SCENES.map((id) => ({ id, durationSeconds: 5 })),
      durationSeconds: 10,
      requiredUnits: 1,
      funding: { baseUnits: 1, addOnUnits: 0 },
    });
    expect(await written()).toEqual({ jobs: 0, reservations: 0, scenes: 0, periods: 0, started: 0, periodOpened: 0 });
    const outcome = await service.start(owner, input());
    if (outcome.kind !== "STARTED") throw new Error(`expected STARTED, got ${outcome.kind}`);
    expect(outcome.allocations.map((a) => [a.sourceType, a.quality, a.quantity])).toEqual([["BASE", "HIGH_QUALITY", 1]]);
  });

  it("offers short Units, as the start answers them, once the plan's one HQ Unit is spent", async () => {
    expect((await service.start(owner, input())).kind).toBe("STARTED");
    const after = await written();
    expect(await service.offer(owner, ORG, PROJECT)).toEqual({
      kind: "INSUFFICIENT_UNITS",
      qualityTier: "HIGH_QUALITY",
      requiredUnits: 1,
      eligibleUnits: 0,
    });
    expect(await written()).toEqual(after);
  });

  it("leaves the period it opened, with that period's own audit entry, when the commit then refuses", async () => {
    // The storyboard the service judges current is not the one the project
    // holds, so the commit refuses after the period is opened.
    fingerprint = "sha256:not-the-projects";
    expect(await service.start(owner, input())).toEqual({ kind: "STORYBOARD_CHANGED" });
    expect(await written()).toEqual({ jobs: 0, reservations: 0, scenes: 0, periods: 1, started: 0, periodOpened: 1 });
  });
});
