import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  OrganizationService,
  StoryboardService,
  createOfflinePromptModerator,
  type Role,
  type VideoProject,
} from "@app/domain";
import {
  createTestDeps,
  InMemoryAssetAnalysisRepository,
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
} from "@app/domain/testing";

/**
 * Route tests for video-project creation. Only session resolution is stubbed;
 * the handler runs against a real StoryboardService over in-memory
 * repositories, so authorization and tenant isolation are exercised rather than
 * mocked away.
 *
 * The storyboard project store is a small local double: nothing in this
 * milestone reads scenes, and a reusable in-memory storyboard repository stays
 * deferred (Phase 3C-4 decision).
 */
const PASSWORD = "password-123456";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const storyboardService = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve(currentUser.value) }));
vi.mock("@/lib/storyboard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storyboard")>("@/lib/storyboard");
  return { ...actual, getStoryboardService: () => storyboardService.value };
});

const { POST: createProject } = await import(
  "@/app/api/properties/[propertyId]/video-projects/route"
);

interface Context {
  readonly orgId: string;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly reviewerId: string;
  readonly outsiderId: string;
  readonly otherOrgId: string;
  readonly otherPropertyId: string;
  readonly projects: Map<string, VideoProject>;
}

let ctx: Context;

async function setup(): Promise<Context> {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const organizations = new OrganizationService(deps);
  const properties = new InMemoryPropertyRepository(deps.clock);
  const projects = new Map<string, VideoProject>();

  const owner = await auth.register({ email: "owner@example.com", password: PASSWORD, name: "Owner" });
  const { organization: org } = await organizations.createOrganization(owner.id, { name: "Studio" });
  const outsider = await auth.register({ email: "outsider@example.com", password: PASSWORD, name: "Out" });
  const { organization: other } = await organizations.createOrganization(outsider.id, { name: "Rival" });

  // A reviewer in the owning organization: a member who cannot write.
  const reviewer = await auth.register({ email: "reviewer@example.com", password: PASSWORD, name: "Rev" });
  await deps.repos.memberships.create({
    organizationId: org.id,
    userId: reviewer.id,
    role: "REVIEWER" as Role,
  });

  const property = await properties.create({
    id: "prp_1",
    organizationId: org.id,
    name: "Sunny flat",
    propertyType: "APARTMENT",
    addressMasked: null,
    description: null,
    status: "ACTIVE",
    createdBy: owner.id,
  });
  const otherProperty = await properties.create({
    id: "prp_other",
    organizationId: other.id,
    name: "Rival flat",
    propertyType: "APARTMENT",
    addressMasked: null,
    description: null,
    status: "ACTIVE",
    createdBy: outsider.id,
  });

  storyboardService.value = new StoryboardService({
    identity: deps,
    properties,
    assets: new InMemoryMediaAssetRepository(deps.clock),
    analyses: new InMemoryAssetAnalysisRepository(deps.clock),
    storyboards: {
      projects: {
        create: (input: Omit<VideoProject, "createdAt" | "updatedAt">) => {
          const row = { ...input, createdAt: deps.clock.now(), updatedAt: deps.clock.now() };
          projects.set(row.id, row);
          return Promise.resolve(row);
        },
        findById: (org2: string, id: string) => {
          const row = projects.get(id);
          return Promise.resolve(row && row.organizationId === org2 ? row : null);
        },
      },
      scenes: {},
    } as unknown as ConstructorParameters<typeof StoryboardService>[0]["storyboards"],
    moderator: createOfflinePromptModerator(),
    ids: deps.ids,
  });

  currentUser.value = { user: { id: owner.id } };
  return {
    orgId: org.id,
    propertyId: property.id,
    ownerId: owner.id,
    reviewerId: reviewer.id,
    outsiderId: outsider.id,
    otherOrgId: other.id,
    otherPropertyId: otherProperty.id,
    projects,
  };
}

function req(body: unknown, raw?: string): Request {
  return new Request("http://localhost/api/properties/prp_1/video-projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function params(propertyId = "prp_1") {
  return { params: Promise.resolve({ propertyId }) };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ctx.orgId,
    name: "Walkthrough",
    durationSeconds: 30,
    aspectRatio: "16:9",
    resolution: "1080p",
    ...overrides,
  };
}

beforeEach(async () => {
  ctx = await setup();
});

describe("authentication and authorization", () => {
  it("returns 401 without a session", async () => {
    currentUser.value = null;
    expect((await createProject(req(validBody()), params())).status).toBe(401);
  });

  it("returns 403 for a REVIEWER, who cannot write properties", async () => {
    currentUser.value = { user: { id: ctx.reviewerId } };
    expect((await createProject(req(validBody()), params())).status).toBe(403);
  });

  it("returns 403 for a non-member", async () => {
    currentUser.value = { user: { id: ctx.outsiderId } };
    expect((await createProject(req(validBody()), params())).status).toBe(403);
  });

  it("creates for a permitted writer", async () => {
    expect((await createProject(req(validBody()), params())).status).toBe(201);
  });
});

describe("tenant isolation", () => {
  it("returns 404 for an unknown property", async () => {
    const res = await createProject(req(validBody()), params("prp_missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404, not 403, for another organization's property", async () => {
    // The owner is a member of their own organization but the property is not
    // theirs: existence in another tenant is never disclosed.
    const res = await createProject(req(validBody()), params(ctx.otherPropertyId));
    expect(res.status).toBe(404);
    expect(ctx.projects.size).toBe(0);
  });

  it("returns 403 when naming an organization the caller does not belong to", async () => {
    const res = await createProject(
      req(validBody({ organizationId: ctx.otherOrgId })),
      params(ctx.otherPropertyId),
    );
    expect(res.status).toBe(403);
  });
});

describe("creation result", () => {
  it("returns 201 with a project that starts DRAFT and has no scenes", async () => {
    const res = await createProject(req(validBody({ prompt: "bright and airy" })), params());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe("DRAFT");
    expect(body.propertyId).toBe(ctx.propertyId);
    expect(body.prompt).toBe("bright and airy");
    expect(body).not.toHaveProperty("scenes");
    expect(ctx.projects.get(body.id as string)!.compositionFingerprint).toBeNull();
  });

  it("ignores client-supplied lifecycle state entirely", async () => {
    const res = await createProject(
      req(
        validBody({
          status: "STORYBOARD_READY",
          compositionFingerprint: "sha256:forged",
          scenes: [{ assetId: "ast_x" }],
        }),
      ),
      params(),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("DRAFT");
    const stored = ctx.projects.get(body.id as string)!;
    expect(stored.status).toBe("DRAFT");
    expect(stored.compositionFingerprint).toBeNull();
  });

  it("applies no provider capability rule", async () => {
    const res = await createProject(
      req(validBody({ durationSeconds: 987, aspectRatio: "21:9", resolution: "8k" })),
      params(),
    );
    expect(res.status).toBe(201);
  });
});

describe("request validation", () => {
  it("returns 422 for missing, wrong-typed, and malformed bodies", async () => {
    const cases: [string, Request][] = [
      ["no organization", req({ name: "x", durationSeconds: 30 })],
      ["missing name", req(validBody({ name: undefined }))],
      ["blank name", req(validBody({ name: "" }))],
      ["fractional duration", req(validBody({ durationSeconds: 30.5 }))],
      ["zero duration", req(validBody({ durationSeconds: 0 }))],
      ["string duration", req(validBody({ durationSeconds: "30" }))],
      ["missing resolution", req(validBody({ resolution: undefined }))],
      ["non-JSON body", req(null, "not json")],
    ];
    for (const [name, request] of cases) {
      const res = await createProject(request, params());
      expect(res.status, name).toBe(422);
    }
    expect(ctx.projects.size).toBe(0);
  });
});

describe("response hygiene", () => {
  it("exposes no tenant, persistence, provider, or prompt internals", async () => {
    const res = await createProject(
      req(validBody({ prompt: "warm light", negativePrompt: "no blur" })),
      params(),
    );
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(body).not.toHaveProperty("organizationId");
    expect(body).not.toHaveProperty("compositionFingerprint");
    expect(body).not.toHaveProperty("compiledPrompt");
    expect(body).not.toHaveProperty("createdBy");
    expect(raw).not.toContain(ctx.orgId);
    expect(raw).not.toContain("storageKey");
    // No preservation rules, system negatives, or moderator identity leak out:
    // those are server-side generation data (ADR-0014).
    expect(raw).not.toContain("preservation");
    expect(raw).not.toContain("Preserve visible structure");
    expect(raw).not.toContain("offline-documented-rules");
  });
});
