import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisService,
  AuthService,
  OrganizationService,
  type AnalysisRequest,
  type AnalysisResult,
  type ImageAnalysisProvider,
  type MediaAsset,
  type ObjectStorage,
  type SafetyFlag,
} from "@app/domain";
import {
  createTestDeps,
  InMemoryAssetAnalysisRepository,
  InMemoryMediaAssetRepository,
  InMemoryReviewTransaction,
} from "@app/domain/testing";

/**
 * Route tests for the review endpoints. Only session resolution is stubbed; the
 * handlers run against a real AnalysisService over in-memory repositories, so
 * authorization, the duplicate rule and tenant isolation are exercised rather
 * than mocked away.
 */
const PASSWORD = "password-123456";
const STORAGE_KEY = "org/o/properties/prp_1/assets/ast_1/normalized.jpg";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const analysisService = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: () => Promise.resolve(currentUser.value) }));
vi.mock("@/lib/analysis", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis")>("@/lib/analysis");
  return { ...actual, getAnalysisService: () => analysisService.value };
});

const { POST: approve } = await import(
  "@/app/api/properties/[propertyId]/assets/[assetId]/analysis/approve/route"
);
const { POST: reject } = await import(
  "@/app/api/properties/[propertyId]/assets/[assetId]/analysis/reject/route"
);

class StubProvider implements ImageAnalysisProvider {
  readonly name = "stub";
  safetyFlags: SafetyFlag[] = [];
  analyze(_request: AnalysisRequest): Promise<AnalysisResult> {
    return Promise.resolve({
      roomType: "KITCHEN",
      confidence: 0.8,
      qualityScore: 0.7,
      brightnessScore: 0.5,
      blurScore: 0.2,
      detectedObjects: [],
      safetyFlags: this.safetyFlags,
    });
  }
  normalizeError() {
    return { kind: "PROVIDER" as const, retryable: true, code: "e", messageSanitized: "failed" };
  }
}

class MapStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  createSignedUploadUrl() {
    return Promise.resolve({ url: "u", expiresAt: new Date() });
  }
  createSignedDownloadUrl() {
    return Promise.resolve({ url: "d", expiresAt: new Date() });
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

interface Ctx {
  deps: ReturnType<typeof createTestDeps>;
  assets: InMemoryMediaAssetRepository;
  storage: MapStorage;
  provider: StubProvider;
  service: AnalysisService;
  ownerId: string;
  creatorId: string;
  outsiderId: string;
  orgId: string;
  otherOrgId: string;
}
let ctx: Ctx;

function seed(
  assets: InMemoryMediaAssetRepository,
  organizationId: string,
  createdBy: string,
  overrides: Partial<MediaAsset> = {},
): Promise<MediaAsset> {
  return assets.create({
    id: overrides.id ?? "ast_1",
    organizationId,
    propertyId: overrides.propertyId ?? "prp_1",
    storageKey: overrides.storageKey ?? STORAGE_KEY,
    originalFilename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    width: 1600,
    height: 1200,
    sha256: "a".repeat(64),
    perceptualHash:
      overrides.perceptualHash === undefined ? "ffffffffffffffff" : overrides.perceptualHash,
    status: overrides.status ?? "READY",
    failureReason: null,
    thumbnailKey: null,
    createdBy,
    deletionRequestedAt: null,
    retentionExpiresAt: null,
  });
}

const params = (assetId = "ast_1", propertyId = "prp_1") => ({
  params: Promise.resolve({ propertyId, assetId }),
});
const req = (body: unknown) =>
  new Request("http://t/api/review", { method: "POST", body: JSON.stringify(body) });
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
const review = (body: Record<string, unknown>) => body.review as Record<string, unknown>;

/** Analyze an asset so it is SUCCEEDED and reviewable. */
async function analyzed(assetId: string, overrides: Partial<MediaAsset> = {}): Promise<void> {
  const asset = await seed(ctx.assets, ctx.orgId, ctx.ownerId, {
    id: assetId,
    storageKey: `key/${assetId}`,
    ...overrides,
  });
  await ctx.storage.putObject(asset.storageKey, new Uint8Array([1, 2, 3, 4]));
  await ctx.service.analyzeAsset(ctx.ownerId, ctx.orgId, asset.id);
}

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const orgs = new OrganizationService(deps);
  const owner = await auth.register({ email: "o@e.com", password: PASSWORD, name: "Owner" });
  const creator = await auth.register({ email: "c@e.com", password: PASSWORD, name: "Creator" });
  const outsider = await auth.register({ email: "x@e.com", password: PASSWORD, name: "Out" });
  const { organization: org } = await orgs.createOrganization(owner.id, { name: "Acme" });
  const { organization: other } = await orgs.createOrganization(owner.id, { name: "Other" });
  await deps.repos.memberships.create({
    organizationId: org.id,
    userId: creator.id,
    role: "CREATOR",
  });

  const analyses = new InMemoryAssetAnalysisRepository(deps.clock);
  const assets = new InMemoryMediaAssetRepository(deps.clock);
  const storage = new MapStorage();
  const provider = new StubProvider();
  const service = new AnalysisService({
    identity: deps,
    assets,
    analyses,
    storage,
    provider,
    reviewTx: new InMemoryReviewTransaction(analyses, assets),
    clock: deps.clock,
    ids: deps.ids,
  });

  ctx = {
    deps,
    assets,
    storage,
    provider,
    service,
    ownerId: owner.id,
    creatorId: creator.id,
    outsiderId: outsider.id,
    orgId: org.id,
    otherOrgId: other.id,
  };
  analysisService.value = service;
  currentUser.value = { user: { id: owner.id } };
  await analyzed("ast_1", { perceptualHash: "0000000000000001" });
});

describe("POST /analysis/approve", () => {
  it("records the approval and returns the nested review object", async () => {
    const res = await approve(req({ organizationId: ctx.orgId, reason: "Looks good" }), params());
    expect(res.status).toBe(200);

    const body = await jsonOf(res);
    expect(review(body).status).toBe("APPROVED");
    expect(review(body).note).toBe("Looks good");
    expect(review(body).reviewedBy).toBe(ctx.ownerId);
    expect(review(body).reviewedAt).toEqual(expect.any(String));
    // Required assertion: the revision travels with the decision.
    expect(review(body).analysisRevision).toBe(1);
    // Review fields are nested, never top-level.
    expect(body.reviewStatus).toBeUndefined();
    expect(body.reviewedBy).toBeUndefined();
    expect(body.analysisRevision).toBeUndefined();
  });

  it("reports the revision after a refresh", async () => {
    await ctx.service.analyzeAsset(ctx.ownerId, ctx.orgId, "ast_1", { refresh: true });
    const res = await approve(req({ organizationId: ctx.orgId }), params());
    expect(review(await jsonOf(res)).analysisRevision).toBe(2);
  });

  it("returns 422 for a blocking finding", async () => {
    ctx.provider.safetyFlags = [
      { code: "PERSON_DETECTED", severity: "BLOCKING", message: "person" },
    ];
    await analyzed("ast_blocked", { perceptualHash: "0000000000000002" });
    expect((await approve(req({ organizationId: ctx.orgId }), params("ast_blocked"))).status).toBe(
      422,
    );
  });

  it("returns 422 when the revision was already reviewed", async () => {
    await approve(req({ organizationId: ctx.orgId }), params());
    expect((await approve(req({ organizationId: ctx.orgId }), params())).status).toBe(422);
  });

  it("returns 422 when a duplicate group needs a primary and none is given", async () => {
    await analyzed("ast_twin_a", { perceptualHash: "ffffffffffffffff" });
    await analyzed("ast_twin_b", { perceptualHash: "ffffffffffffffff" });
    expect((await approve(req({ organizationId: ctx.orgId }), params("ast_twin_a"))).status).toBe(
      422,
    );
  });

  it("returns 422 when primaryAssetId names another asset", async () => {
    await analyzed("ast_twin_a", { perceptualHash: "ffffffffffffffff" });
    await analyzed("ast_twin_b", { perceptualHash: "ffffffffffffffff" });
    const res = await approve(
      req({ organizationId: ctx.orgId, primaryAssetId: "ast_twin_b" }),
      params("ast_twin_a"),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for a duplicate-group conflict, not 409", async () => {
    await analyzed("ast_twin_a", { perceptualHash: "ffffffffffffffff" });
    await analyzed("ast_twin_b", { perceptualHash: "ffffffffffffffff" });
    await approve(
      req({ organizationId: ctx.orgId, primaryAssetId: "ast_twin_a" }),
      params("ast_twin_a"),
    );

    const res = await approve(
      req({ organizationId: ctx.orgId, primaryAssetId: "ast_twin_b" }),
      params("ast_twin_b"),
    );
    expect(res.status).toBe(422);
    expect(res.status).not.toBe(409);
  });
});

describe("POST /analysis/reject", () => {
  it("records the rejection and returns the nested review object", async () => {
    const res = await reject(req({ organizationId: ctx.orgId, reason: "Too blurry" }), params());
    expect(res.status).toBe(200);

    const body = await jsonOf(res);
    expect(review(body).status).toBe("REJECTED");
    expect(review(body).note).toBe("Too blurry");
    expect(review(body).reviewedBy).toBe(ctx.ownerId);
    // Required assertion: the revision travels with the decision.
    expect(review(body).analysisRevision).toBe(1);
  });

  it("returns 422 when the reason is missing or blank", async () => {
    expect((await reject(req({ organizationId: ctx.orgId }), params())).status).toBe(422);
    expect((await reject(req({ organizationId: ctx.orgId, reason: "  " }), params())).status).toBe(
      422,
    );
  });
});

describe("authentication, authorization and tenant isolation", () => {
  it("returns 401 on both routes when unauthenticated", async () => {
    currentUser.value = null;
    expect((await approve(req({ organizationId: ctx.orgId }), params())).status).toBe(401);
    expect(
      (await reject(req({ organizationId: ctx.orgId, reason: "no" }), params())).status,
    ).toBe(401);
  });

  it("returns 403 for a CREATOR, who may analyze but not review", async () => {
    currentUser.value = { user: { id: ctx.creatorId } };
    expect((await approve(req({ organizationId: ctx.orgId }), params())).status).toBe(403);
    expect(
      (await reject(req({ organizationId: ctx.orgId, reason: "no" }), params())).status,
    ).toBe(403);
  });

  it("returns 403 for a non-member", async () => {
    currentUser.value = { user: { id: ctx.outsiderId } };
    expect((await approve(req({ organizationId: ctx.orgId }), params())).status).toBe(403);
  });

  it("returns 404 for an unknown asset and for another organization's asset", async () => {
    expect((await approve(req({ organizationId: ctx.orgId }), params("ast_nope"))).status).toBe(404);
    // Owner belongs to both organizations, but ast_1 is scoped to the first.
    expect((await approve(req({ organizationId: ctx.otherOrgId }), params())).status).toBe(404);
  });

  it("returns 422 for a malformed body, never a 500", async () => {
    expect((await approve(req({}), params())).status).toBe(422);
    expect((await approve(req({ organizationId: "" }), params())).status).toBe(422);
    const bad = new Request("http://t/a", { method: "POST", body: "{not json" });
    expect((await approve(bad, params())).status).toBe(422);
    expect(
      (await approve(req({ organizationId: ctx.orgId, reason: 42 }), params())).status,
    ).toBe(422);
  });
});

describe("response hygiene", () => {
  it("exposes only the reviewer id and no internal identifiers", async () => {
    const res = await approve(req({ organizationId: ctx.orgId, reason: "ok" }), params());
    const body = await jsonOf(res);
    const raw = JSON.stringify(body);

    expect(review(body).reviewedBy).toBe(ctx.ownerId);
    // The reviewer id is not expanded into user details.
    expect(raw).not.toContain("o@e.com");
    expect(raw).not.toContain("Owner");
    expect(raw).not.toContain(STORAGE_KEY);
    expect(raw).not.toContain(ctx.orgId);
    expect(raw).not.toContain("stub");
  });
});
