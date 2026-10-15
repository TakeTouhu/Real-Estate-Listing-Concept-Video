import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisService,
  AuthService,
  OrganizationService,
  PropertyService,
  StoryboardService,
  createOfflinePromptModerator,
  type ImageAnalysisProvider,
  type ObjectStorage,
  type StoryboardRepositories,
  type StoryboardScene,
  type VideoProject,
} from "@app/domain";
import {
  createTestDeps,
  InMemoryAssetAnalysisRepository,
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
  InMemoryReviewTransaction,
} from "@app/domain/testing";

/**
 * Reach through the analysis, video-project and storyboard routes (Phase 6I-2,
 * ADR-0064). Only session resolution is stubbed; the routes run against the
 * real AnalysisService and StoryboardService over in-memory repositories. A
 * CREATOR asking about a Property it is not responsible for, or a project
 * under it, gets exactly the response it would get for an id that does not
 * exist.
 */
const PASSWORD = "password-123456";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const analysisService = vi.hoisted(() => ({ value: null as unknown }));
const storyboardService = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve(currentUser.value) }));
vi.mock("@/lib/analysis", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis")>("@/lib/analysis");
  return { ...actual, getAnalysisService: () => analysisService.value };
});
vi.mock("@/lib/storyboard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storyboard")>("@/lib/storyboard");
  return { ...actual, getStoryboardService: () => storyboardService.value };
});

const { GET: listAnalyses } = await import("@/app/api/properties/[propertyId]/analyses/route");
const { GET: listProjects, POST: createProject } = await import("@/app/api/properties/[propertyId]/video-projects/route");
const { GET: readStoryboard, POST: composeStoryboard } = await import("@/app/api/video-projects/[projectId]/storyboard/route");

const provider: ImageAnalysisProvider = {
  name: "stub",
  analyze: () =>
    Promise.resolve({
      roomType: "KITCHEN",
      confidence: 0.9,
      qualityScore: 0.8,
      brightnessScore: 0.5,
      blurScore: 0.1,
      detectedObjects: [],
      safetyFlags: [],
    }),
  normalizeError: () => ({ kind: "PROVIDER", retryable: true, code: "e", messageSanitized: "failed" }),
};

class BytesStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  createSignedUploadUrl() {
    return Promise.resolve({ url: "upload://", expiresAt: new Date(0) });
  }
  createSignedDownloadUrl() {
    return Promise.resolve({ url: "download://", expiresAt: new Date(0) });
  }
  putObject(key: string, data: Uint8Array) {
    this.objects.set(key, data);
    return Promise.resolve();
  }
  getObject(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  deleteObject(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string) {
    return Promise.resolve(this.objects.has(key));
  }
}

interface Seeded {
  readonly propertyId: string;
  readonly projectId: string;
}
interface Ctx {
  readonly orgId: string;
  /** The CREATOR is responsible for `mine`; `theirs` is unassigned. */
  readonly mine: Seeded;
  readonly theirs: Seeded;
  readonly projectCount: () => number;
}
let ctx: Ctx;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const owner = await auth.register({ email: "o@e.com", password: PASSWORD, name: "Owner" });
  const creator = await auth.register({ email: "c@e.com", password: PASSWORD, name: "Creator" });
  const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Acme" });
  await deps.repos.memberships.create({ organizationId: organization.id, userId: creator.id, role: "CREATOR" });

  const propertyRepo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  const assetRepo = new InMemoryMediaAssetRepository(deps.clock);
  const analysisRepo = new InMemoryAssetAnalysisRepository(deps.clock);
  const storage = new BytesStorage();
  const projectRows = new Map<string, VideoProject>();
  const sceneRows = new Map<string, StoryboardScene[]>();
  const storyboards: StoryboardRepositories = {
    projects: {
      create: (input) => {
        const row = { ...input, createdAt: deps.clock.now(), updatedAt: deps.clock.now() };
        projectRows.set(row.id, row);
        return Promise.resolve(row);
      },
      findById: (org, id) => {
        const row = projectRows.get(id);
        return Promise.resolve(row && row.organizationId === org ? row : null);
      },
      listByProperty: (org, propertyId) =>
        Promise.resolve([...projectRows.values()].filter((p) => p.organizationId === org && p.propertyId === propertyId)),
      update: (org, id, changes) => {
        const row = projectRows.get(id);
        if (!row || row.organizationId !== org) throw new Error("project not found");
        const next = { ...row, ...changes };
        projectRows.set(id, next);
        return Promise.resolve(next);
      },
    },
    scenes: {
      listByProject: (_org, id) => Promise.resolve(sceneRows.get(id) ?? []),
      replaceForProject: (_org, id, rows) => {
        const stored = rows.map((r) => ({ ...r, createdAt: deps.clock.now(), updatedAt: deps.clock.now() }));
        sceneRows.set(id, stored);
        return Promise.resolve(stored);
      },
    },
  };
  const properties = new PropertyService({ identity: deps, properties: propertyRepo, assets: assetRepo, clock: deps.clock, ids: deps.ids });
  const analysis = new AnalysisService({
    identity: deps,
    properties: propertyRepo,
    assets: assetRepo,
    analyses: analysisRepo,
    storage,
    provider,
    reviewTx: new InMemoryReviewTransaction(analysisRepo, assetRepo),
    clock: deps.clock,
    ids: deps.ids,
  });
  const storyboard = new StoryboardService({
    identity: deps,
    properties: propertyRepo,
    assets: assetRepo,
    analyses: analysisRepo,
    storyboards,
    moderator: createOfflinePromptModerator(),
    ids: deps.ids,
  });
  analysisService.value = analysis;
  storyboardService.value = storyboard;

  const seed = async (responsibleUserId?: string): Promise<Seeded> => {
    const property = await properties.create(owner.id, {
      organizationId: organization.id,
      name: responsibleUserId ? "Mine" : "Theirs",
      propertyType: "HOUSE",
      rightsConfirmed: true,
      ...(responsibleUserId ? { responsibleUserId } : {}),
    });
    const photo = await assetRepo.create({
      id: `ast_${property.id}`,
      organizationId: organization.id,
      propertyId: property.id,
      storageKey: `key/${property.id}`,
      originalFilename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      width: 1600,
      height: 1200,
      sha256: "a".repeat(64),
      perceptualHash: null,
      status: "READY",
      failureReason: null,
      thumbnailKey: null,
      createdBy: owner.id,
      deletionRequestedAt: null,
      retentionExpiresAt: null,
    });
    await storage.putObject(photo.storageKey, new Uint8Array([1, 2, 3]));
    await analysis.analyzeAsset(owner.id, organization.id, photo.id);
    const project = await storyboard.createProject(owner.id, organization.id, property.id, {
      name: "Tour",
      durationSeconds: 30,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
    });
    return { propertyId: property.id, projectId: project.id };
  };
  ctx = {
    orgId: organization.id,
    mine: await seed(creator.id),
    theirs: await seed(),
    projectCount: () => projectRows.size,
  };
  currentUser.value = { user: { id: creator.id } };
});

const query = () => new Request(`http://t/api?organizationId=${encodeURIComponent(ctx.orgId)}`);
const json = (body: Record<string, unknown>) =>
  new Request("http://t/api", { method: "POST", body: JSON.stringify({ organizationId: ctx.orgId, ...body }) });
const property = (propertyId: string) => ({ params: Promise.resolve({ propertyId }) });
const project = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

/** A response as a member sees it, without the per-request id. */
async function seen(res: Response): Promise<{ status: number; body: unknown }> {
  const body = (await res.json()) as { error?: { requestId?: string } };
  if (body.error) delete body.error.requestId;
  return { status: res.status, body };
}

/** Each route, called for a Property id or a project id, and what it answers within reach. */
const routes: Record<
  string,
  { readonly call: (id: string) => Promise<Response>; readonly of: (s: Seeded) => string; readonly missing: string; readonly own: number }
> = {
  "GET analyses": { call: (id) => listAnalyses(query(), property(id)), of: (s) => s.propertyId, missing: "prp_missing", own: 200 },
  "GET video-projects": { call: (id) => listProjects(query(), property(id)), of: (s) => s.propertyId, missing: "prp_missing", own: 200 },
  "POST video-projects": {
    call: (id) =>
      createProject(json({ name: "Tour", durationSeconds: 30, aspectRatio: "16:9", targetOutputResolution: "1080p" }), property(id)),
    of: (s) => s.propertyId,
    missing: "prp_missing",
    own: 201,
  },
  "GET storyboard": { call: (id) => readStoryboard(query(), project(id)), of: (s) => s.projectId, missing: "vpr_missing", own: 200 },
  // Within reach, composing one unapproved photo is refused for the minimum.
  "POST storyboard": {
    call: (id) => composeStoryboard(json({ minSceneSeconds: 2, maxSceneSeconds: 10 }), project(id)),
    of: (s) => s.projectId,
    missing: "vpr_missing",
    own: 422,
  },
};

describe("analysis, video-project and storyboard routes for a member out of reach", () => {
  for (const [name, route] of Object.entries(routes)) {
    it(`${name}: answers out of reach exactly as an id that does not exist, and creates nothing`, async () => {
      const missing = await seen(await route.call(route.missing));
      const projects = ctx.projectCount();
      expect(await seen(await route.call(route.of(ctx.theirs)))).toEqual(missing);
      expect(ctx.projectCount()).toBe(projects);
    });

    it(`${name}: serves the member's own Property`, async () => {
      expect((await route.call(route.of(ctx.mine))).status).toBe(route.own);
    });
  }

  it("lists no analyses for a Property out of reach, as for one that does not exist", async () => {
    expect(await seen(await listAnalyses(query(), property(ctx.theirs.propertyId)))).toEqual({ status: 200, body: { analyses: [] } });
    const own = (await (await listAnalyses(query(), property(ctx.mine.propertyId))).json()) as { analyses: unknown[] };
    expect(own.analyses).toHaveLength(1);
  });
});
