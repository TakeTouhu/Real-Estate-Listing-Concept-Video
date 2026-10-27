import { AppError } from "@app/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AnalysisService } from "../analysis/analysis-service";
import type { ImageAnalysisProvider } from "../analysis/ports";
import { GenerationService } from "../generation/generation-service";
import type { VideoModelCatalog } from "../generation/model-catalog";
import { AuthService } from "../identity/auth-service";
import { GroupService } from "../identity/group-service";
import { OrganizationService } from "../identity/organization-service";
import { ROLES, type Role } from "../identity/roles";
import { createOfflinePromptModerator } from "../storyboard/moderation";
import type { StoryboardRepositories } from "../storyboard/ports";
import { StoryboardService } from "../storyboard/storyboard-service";
import type { StoryboardScene, VideoProject } from "../storyboard/types";
import { InMemoryAssetAnalysisRepository } from "../testing/in-memory-analysis";
import { InMemorySceneGenerationRepository } from "../testing/in-memory-generation";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryMediaAssetRepository, InMemoryPropertyRepository } from "../testing/in-memory-property";
import { InMemoryReviewTransaction } from "../testing/in-memory-review-transaction";
import type { ObjectStorage } from "./ports";
import { PropertyService } from "./property-service";
import type { MediaAssetStatus } from "./types";

/**
 * Reach on the content under a Property (ADR-0052 Decision 10, Phase 6I-2,
 * ADR-0064): analyses and their review, video projects, storyboards and
 * generation admission are reached exactly when their Property is. Out of reach
 * they are answered as rows that do not exist, and nothing changes.
 */

const PASSWORD = "password-123456";
const PROJECT_INPUT = { name: "Tour", durationSeconds: 30, aspectRatio: "16:9", targetOutputResolution: "1080p" } as const;
const BOUNDS = { minSeconds: 2, maxSeconds: 10 };

const PROPERTIES = ["unassigned", "creators", "viewers", "east", "west", "north"] as const;
type Name = (typeof PROPERTIES)[number];

/** Which Properties each role reaches, as in the Property suite. */
const REACHED: Record<Exclude<Role, "BILLING">, readonly Name[]> = {
  OWNER: PROPERTIES,
  ADMIN: PROPERTIES,
  // Responsible for north, which is in a group it is not in: not reached.
  MANAGER: ["east", "west"],
  CREATOR: ["creators"],
  VIEWER: ["viewers"],
};
const READ_ROLES = ["OWNER", "ADMIN", "MANAGER", "CREATOR", "VIEWER"] as const;

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

/** Admission is refused before any model is chosen, so none is ever asked for. */
const noModels: VideoModelCatalog = {
  list: () => [],
  default: () => {
    throw new Error("a model was chosen before admission passed");
  },
  find: () => undefined,
};

interface Fixture {
  readonly deps: TestDeps;
  readonly properties: PropertyService;
  readonly analysis: AnalysisService;
  readonly storyboard: StoryboardService;
  readonly generation: GenerationService;
  readonly groups: GroupService;
  readonly orgId: string;
  readonly ownerId: string;
  readonly ids: Readonly<Record<Role, string>>;
  readonly groupIds: Readonly<Record<"east" | "west" | "north", string>>;
  readonly propertyIds: Readonly<Record<Name, string>>;
  /** A READY photo of each Property, analyzed and not yet reviewed. */
  readonly photos: Readonly<Record<Name, string>>;
  /** A photo of each Property still awaiting its upload. */
  readonly pending: Readonly<Record<Name, string>>;
  /** A video project of each Property, never composed. */
  readonly projects: Readonly<Record<Name, string>>;
  /** Everything a call could change, serialized. */
  readonly snapshot: () => string;
}

let fx: Fixture;

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const owner = await auth.register({ email: "owner@example.com", name: "Owner", password: PASSWORD });
  const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Org" });
  const orgId = organization.id;
  const ids = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await auth.register({ email: `member-${role.toLowerCase()}@example.com`, name: role, password: PASSWORD });
    await deps.repos.memberships.create({ organizationId: orgId, userId: user.id, role });
    ids[role] = user.id;
  }
  const groups = new GroupService(deps);
  const groupIds = {
    east: (await groups.create(owner.id, orgId, "East")).id,
    west: (await groups.create(owner.id, orgId, "West")).id,
    north: (await groups.create(owner.id, orgId, "North")).id,
  };
  await groups.addMember(owner.id, orgId, groupIds.east, ids.MANAGER);
  await groups.addMember(owner.id, orgId, groupIds.west, ids.MANAGER);
  await groups.addMember(owner.id, orgId, groupIds.east, ids.CREATOR);

  const propertyRepo = new InMemoryPropertyRepository(deps.clock, deps.repos);
  const assetRepo = new InMemoryMediaAssetRepository(deps.clock);
  const analysisRepo = new InMemoryAssetAnalysisRepository(deps.clock);
  const generationRepo = new InMemorySceneGenerationRepository(deps.clock);
  const storage = new BytesStorage();
  const projectRows = new Map<string, VideoProject>();
  const sceneRows = new Map<string, StoryboardScene[]>();
  const storyboards: StoryboardRepositories = {
    projects: {
      create: (input) => {
        const row = { ...input, createdAt: deps.clock.now(), updatedAt: deps.clock.now() };
        projectRows.set(row.id, row);
        generationRepo.registerProject(row.organizationId, row.id);
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
        const next = { ...row, ...changes, updatedAt: deps.clock.now() };
        projectRows.set(id, next);
        return Promise.resolve(next);
      },
    },
    scenes: {
      listByProject: (org, id) => Promise.resolve(projectRows.get(id)?.organizationId === org ? (sceneRows.get(id) ?? []) : []),
      saveComposition: (org, id, { scenes: rows, compositionFingerprint }) => {
        const row = projectRows.get(id);
        if (!row || row.organizationId !== org) throw new Error("project not found");
        const stored = rows.map((r) => ({ ...r, createdAt: deps.clock.now(), updatedAt: deps.clock.now() }));
        sceneRows.set(id, stored);
        const project = { ...row, status: "STORYBOARD_READY" as const, compositionFingerprint, updatedAt: deps.clock.now() };
        projectRows.set(id, project);
        return Promise.resolve({ project, scenes: stored });
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
  const generation = new GenerationService({ identity: deps, storyboard, generations: generationRepo, models: noModels, ids: deps.ids });

  const assignments: Record<Name, { responsibleUserId?: string; groupId?: string }> = {
    unassigned: {},
    creators: { responsibleUserId: ids.CREATOR },
    viewers: { responsibleUserId: ids.VIEWER },
    east: { groupId: groupIds.east },
    west: { groupId: groupIds.west },
    north: { groupId: groupIds.north, responsibleUserId: ids.MANAGER },
  };
  const seedPhoto = (propertyId: string, id: string, status: MediaAssetStatus) =>
    assetRepo.create({
      id,
      organizationId: orgId,
      propertyId,
      storageKey: `key/${id}`,
      originalFilename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      width: 1600,
      height: 1200,
      sha256: "a".repeat(64),
      perceptualHash: null,
      status,
      failureReason: null,
      thumbnailKey: null,
      createdBy: owner.id,
      deletionRequestedAt: null,
      retentionExpiresAt: null,
    });
  const propertyIds = {} as Record<Name, string>;
  const photos = {} as Record<Name, string>;
  const pending = {} as Record<Name, string>;
  const projects = {} as Record<Name, string>;
  for (const name of PROPERTIES) {
    const property = await properties.create(owner.id, {
      organizationId: orgId,
      name,
      propertyType: "HOUSE",
      rightsConfirmed: true,
      ...assignments[name],
    });
    propertyIds[name] = property.id;
    const photo = await seedPhoto(property.id, `ast_${name}`, "READY");
    await storage.putObject(photo.storageKey, new Uint8Array([1, 2, 3]));
    await analysis.analyzeAsset(owner.id, orgId, photo.id);
    photos[name] = photo.id;
    pending[name] = (await seedPhoto(property.id, `ast_${name}_pending`, "PENDING_UPLOAD")).id;
    projects[name] = (await storyboard.createProject(owner.id, orgId, property.id, PROJECT_INPUT)).id;
  }
  fx = {
    deps,
    properties,
    analysis,
    storyboard,
    generation,
    groups,
    orgId,
    ownerId: owner.id,
    ids,
    groupIds,
    propertyIds,
    photos,
    pending,
    projects,
    snapshot: () =>
      JSON.stringify({
        audits: deps.repos.auditLogs.all().length,
        analyses: analysisRepo.all(),
        projects: [...projectRows.values()],
        scenes: [...sceneRows.entries()],
        generations: generationRepo.all(),
      }),
  };
});

/** The refusal a call ends in, as a member would see it. */
async function refusal(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("lists under a Property", () => {
  it("lists analyses and video projects only for the Properties each role reaches", async () => {
    expect(await fx.analysis.listForProperty(fx.ownerId, fx.orgId, "prp_missing")).toEqual([]);
    const missing = await refusal(() => fx.storyboard.listProjects(fx.ownerId, fx.orgId, "prp_missing"));
    expect(missing).toEqual({ code: "NOT_FOUND", message: "Property not found" });

    for (const role of READ_ROLES) {
      const actor = fx.ids[role];
      for (const name of PROPERTIES) {
        const id = fx.propertyIds[name];
        const label = `${role} on ${name}`;
        if (REACHED[role].includes(name)) {
          expect((await fx.analysis.listForProperty(actor, fx.orgId, id)).map((a) => a.assetId), label).toEqual([fx.photos[name]]);
          expect((await fx.storyboard.listProjects(actor, fx.orgId, id)).map((p) => p.id), label).toEqual([fx.projects[name]]);
        } else {
          expect(await fx.analysis.listForProperty(actor, fx.orgId, id), label).toEqual([]);
          expect(await refusal(() => fx.storyboard.listProjects(actor, fx.orgId, id)), label).toEqual(missing);
        }
      }
    }
  });
});

describe("reads of one analysis or storyboard", () => {
  it("answers one out of reach exactly as one that does not exist", async () => {
    const missingAnalysis = await refusal(() => fx.analysis.getForAsset(fx.ownerId, fx.orgId, "ast_missing"));
    const missingProject = await refusal(() => fx.storyboard.getStoryboard(fx.ownerId, fx.orgId, "vpr_missing"));
    expect(missingAnalysis).toEqual({ code: "NOT_FOUND", message: "Analysis not found for this asset" });
    expect(missingProject).toEqual({ code: "NOT_FOUND", message: "Video project not found" });

    for (const role of READ_ROLES) {
      const actor = fx.ids[role];
      for (const name of PROPERTIES) {
        const label = `${role} on ${name}`;
        if (REACHED[role].includes(name)) {
          expect((await fx.analysis.getForAsset(actor, fx.orgId, fx.photos[name])).assetId, label).toBe(fx.photos[name]);
          expect((await fx.storyboard.getStoryboard(actor, fx.orgId, fx.projects[name])).project.id, label).toBe(fx.projects[name]);
          expect(await fx.storyboard.isFresh(actor, fx.orgId, fx.projects[name]), label).toBe(false);
        } else {
          expect(await refusal(() => fx.analysis.getForAsset(actor, fx.orgId, fx.photos[name])), label).toEqual(missingAnalysis);
          expect(await refusal(() => fx.storyboard.getStoryboard(actor, fx.orgId, fx.projects[name])), label).toEqual(missingProject);
          // Never flattened into "not fresh".
          expect(await refusal(() => fx.storyboard.isFresh(actor, fx.orgId, fx.projects[name])), label).toEqual(missingProject);
        }
      }
    }
  });
});

describe("writes under a Property", () => {
  /** Each write a CREATOR may make, against the Property `name`. */
  const writes: Record<string, (name: Name) => Promise<unknown>> = {
    "start an analysis": (name) => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, fx.photos[name]),
    "refresh an analysis": (name) => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, fx.photos[name], { refresh: true }),
    "approve a photo": (name) => fx.analysis.approve(fx.ids.CREATOR, fx.orgId, fx.photos[name]),
    "reject a photo": (name) => fx.analysis.reject(fx.ids.CREATOR, fx.orgId, fx.photos[name], { reason: "blurry" }),
    "correct a photo": (name) => fx.analysis.correct(fx.ids.CREATOR, fx.orgId, fx.photos[name], { roomType: { set: "STUDY" } }),
    "create a video project": (name) => fx.storyboard.createProject(fx.ids.CREATOR, fx.orgId, fx.propertyIds[name], PROJECT_INPUT),
  };
  const missing: Record<string, () => Promise<unknown>> = {
    "start an analysis": () => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, "ast_missing"),
    "refresh an analysis": () => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, "ast_missing", { refresh: true }),
    "approve a photo": () => fx.analysis.approve(fx.ids.CREATOR, fx.orgId, "ast_missing"),
    "reject a photo": () => fx.analysis.reject(fx.ids.CREATOR, fx.orgId, "ast_missing", { reason: "blurry" }),
    "correct a photo": () => fx.analysis.correct(fx.ids.CREATOR, fx.orgId, "ast_missing", { roomType: { set: "STUDY" } }),
    "create a video project": () => fx.storyboard.createProject(fx.ids.CREATOR, fx.orgId, "prp_missing", PROJECT_INPUT),
  };

  for (const [label, write] of Object.entries(writes)) {
    it(`${label}: out of reach is answered as not found and changes nothing`, async () => {
      const expected = await refusal(missing[label] ?? (() => Promise.resolve()));
      expect(expected.code).toBe("NOT_FOUND");
      for (const name of PROPERTIES.filter((n) => !REACHED.CREATOR.includes(n))) {
        const before = fx.snapshot();
        expect(await refusal(() => write(name)), `${label} on ${name}`).toEqual(expected);
        expect(fx.snapshot(), `${label} on ${name}`).toBe(before);
      }
    });

    it(`${label}: within reach goes through`, async () => {
      await write("creators");
    });
  }

  it("composes and admits generation only within reach, and writes nothing out of it", async () => {
    const missingProject = await refusal(() => fx.storyboard.compose(fx.ids.CREATOR, fx.orgId, "vpr_missing", BOUNDS));
    expect(missingProject).toEqual({ code: "NOT_FOUND", message: "Video project not found" });
    expect(await refusal(() => fx.generation.startScene(fx.ids.CREATOR, fx.orgId, "vpr_missing", "scn_1"))).toEqual(missingProject);
    for (const name of PROPERTIES.filter((n) => !REACHED.CREATOR.includes(n))) {
      const before = fx.snapshot();
      expect(await refusal(() => fx.storyboard.compose(fx.ids.CREATOR, fx.orgId, fx.projects[name], BOUNDS)), name).toEqual(missingProject);
      expect(await refusal(() => fx.generation.startScene(fx.ids.CREATOR, fx.orgId, fx.projects[name], "scn_1")), name).toEqual(missingProject);
      expect(fx.snapshot(), name).toBe(before);
    }
  });

  it("lets a MANAGER review in its groups' Properties, not in one it is only responsible for", async () => {
    await fx.analysis.approve(fx.ids.MANAGER, fx.orgId, fx.photos.east);
    expect(await refusal(() => fx.analysis.approve(fx.ids.MANAGER, fx.orgId, fx.photos.north))).toEqual({
      code: "NOT_FOUND",
      message: "Analysis not found for this asset",
    });
  });
});

describe("the order of the checks", () => {
  it("checks the permission before reach, as it does before existence", async () => {
    const review = { code: "FORBIDDEN", message: "Role VIEWER lacks permission 'analysis.review'" };
    expect(await refusal(() => fx.analysis.approve(fx.ids.VIEWER, fx.orgId, fx.photos.east))).toEqual(review);
    expect(await refusal(() => fx.analysis.approve(fx.ids.VIEWER, fx.orgId, "ast_missing"))).toEqual(review);
    const generate = { code: "FORBIDDEN", message: "Role VIEWER lacks permission 'video.generate'" };
    expect(await refusal(() => fx.storyboard.createProject(fx.ids.VIEWER, fx.orgId, fx.propertyIds.east, PROJECT_INPUT))).toEqual(generate);
    expect(await refusal(() => fx.storyboard.createProject(fx.ids.VIEWER, fx.orgId, "prp_missing", PROJECT_INPUT))).toEqual(generate);
  });

  it("checks reach before a photo's or an analysis's state", async () => {
    // Within reach, a photo awaiting upload is refused for its state...
    expect(await refusal(() => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, fx.pending.creators))).toEqual({
      code: "VALIDATION_FAILED",
      message: "Only READY assets can be analyzed (asset is PENDING_UPLOAD)",
    });
    // ...out of reach, the same state is answered as not found.
    expect(await refusal(() => fx.analysis.analyzeAsset(fx.ids.CREATOR, fx.orgId, fx.pending.viewers))).toEqual({
      code: "NOT_FOUND",
      message: "Asset not found",
    });

    await fx.analysis.approve(fx.ownerId, fx.orgId, fx.photos.creators);
    await fx.analysis.approve(fx.ownerId, fx.orgId, fx.photos.viewers);
    expect((await refusal(() => fx.analysis.approve(fx.ids.CREATOR, fx.orgId, fx.photos.creators))).code).toBe("VALIDATION_FAILED");
    expect(await refusal(() => fx.analysis.approve(fx.ids.CREATOR, fx.orgId, fx.photos.viewers))).toEqual({
      code: "NOT_FOUND",
      message: "Analysis not found for this asset",
    });
  });

  it("checks reach before a storyboard's state, at composition and at generation admission", async () => {
    // One approved photo is under the minimum, and nothing has been composed.
    await fx.analysis.approve(fx.ownerId, fx.orgId, fx.photos.creators);
    expect((await refusal(() => fx.storyboard.compose(fx.ids.CREATOR, fx.orgId, fx.projects.creators, BOUNDS))).message).toMatch(
      /^A storyboard needs at least 3 approved photos/,
    );
    const neverComposed = { code: "VALIDATION_FAILED", message: "This project has no composed storyboard" };
    expect(await refusal(() => fx.storyboard.assertFresh(fx.ids.CREATOR, fx.orgId, fx.projects.creators))).toEqual(neverComposed);
    expect(await refusal(() => fx.generation.startScene(fx.ids.CREATOR, fx.orgId, fx.projects.creators, "scn_1"))).toEqual(neverComposed);

    const notFound = { code: "NOT_FOUND", message: "Video project not found" };
    expect(await refusal(() => fx.storyboard.compose(fx.ids.CREATOR, fx.orgId, fx.projects.viewers, BOUNDS))).toEqual(notFound);
    expect(await refusal(() => fx.storyboard.assertFresh(fx.ids.CREATOR, fx.orgId, fx.projects.viewers))).toEqual(notFound);
    expect(await refusal(() => fx.generation.startScene(fx.ids.CREATOR, fx.orgId, fx.projects.viewers, "scn_1"))).toEqual(notFound);
  });
});

describe("a deleted Property", () => {
  it("takes no new video project and lists none, as a Property that does not exist", async () => {
    const property = await fx.properties.create(fx.ownerId, { organizationId: fx.orgId, name: "Gone", propertyType: "HOUSE", rightsConfirmed: true });
    await fx.storyboard.createProject(fx.ownerId, fx.orgId, property.id, PROJECT_INPUT);
    await fx.properties.remove(fx.ownerId, fx.orgId, property.id);

    const missing = { code: "NOT_FOUND", message: "Property not found" };
    const before = fx.snapshot();
    expect(await refusal(() => fx.storyboard.createProject(fx.ownerId, fx.orgId, property.id, PROJECT_INPUT))).toEqual(missing);
    expect(await refusal(() => fx.storyboard.listProjects(fx.ownerId, fx.orgId, property.id))).toEqual(missing);
    expect(fx.snapshot()).toBe(before);
  });
});

describe("changes take effect through the Property, on the next request", () => {
  it("follows a reassignment and a group membership change", async () => {
    const { unassigned, east } = fx.propertyIds;
    await expect(fx.analysis.getForAsset(fx.ids.CREATOR, fx.orgId, fx.photos.unassigned)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await fx.properties.assign(fx.ownerId, fx.orgId, unassigned, { responsibleUserId: fx.ids.CREATOR });
    expect((await fx.analysis.getForAsset(fx.ids.CREATOR, fx.orgId, fx.photos.unassigned)).assetId).toBe(fx.photos.unassigned);
    expect((await fx.storyboard.listProjects(fx.ids.CREATOR, fx.orgId, unassigned)).length).toBe(1);

    await fx.groups.removeMember(fx.ownerId, fx.orgId, fx.groupIds.east, fx.ids.MANAGER);
    expect(await fx.analysis.listForProperty(fx.ids.MANAGER, fx.orgId, east)).toEqual([]);
    await expect(fx.storyboard.getStoryboard(fx.ids.MANAGER, fx.orgId, fx.projects.east)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
