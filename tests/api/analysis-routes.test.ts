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
} from "@app/domain";
import {
  createTestDeps,
  InMemoryAssetAnalysisRepository,
  InMemoryMediaAssetRepository,
} from "@app/domain/testing";

/**
 * Route-level tests. Only session resolution is stubbed; the routes run against
 * a real AnalysisService over in-memory repositories, so authorization and
 * tenant isolation are exercised for real rather than mocked away.
 */
const PASSWORD = "password-123456";
const STORAGE_KEY = "org/o/properties/prp_1/assets/ast_1/normalized.jpg";

const currentUser = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
const analysisService = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(currentUser.value),
}));
vi.mock("@/lib/analysis", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis")>("@/lib/analysis");
  return { ...actual, getAnalysisService: () => analysisService.value };
});

const { POST: startAnalysis, GET: getAnalysis } = await import(
  "@/app/api/properties/[propertyId]/assets/[assetId]/analysis/route"
);
const { POST: refreshAnalysis } = await import(
  "@/app/api/properties/[propertyId]/assets/[assetId]/analysis/refresh/route"
);
const { GET: listAnalyses } = await import(
  "@/app/api/properties/[propertyId]/analyses/route"
);

class StubProvider implements ImageAnalysisProvider {
  readonly name = "stub";
  calls = 0;
  analyze(_request: AnalysisRequest): Promise<AnalysisResult> {
    this.calls += 1;
    return Promise.resolve({
      roomType: "KITCHEN",
      confidence: 0.8,
      qualityScore: 0.7,
      brightnessScore: 0.5,
      blurScore: 0.2,
      detectedObjects: [{ label: "sink", confidence: 0.9 }],
      safetyFlags: [],
    });
  }
  normalizeError() {
    return {
      kind: "PROVIDER" as const,
      retryable: true,
      code: "e",
      messageSanitized: "Analysis provider failed",
    };
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
  ownerId: string;
  reviewerId: string;
  outsiderId: string;
  orgId: string;
  otherOrgId: string;
  provider: StubProvider;
  assets: InMemoryMediaAssetRepository;
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
    perceptualHash: "ffffffffffffffff",
    status: overrides.status ?? "READY",
    failureReason: null,
    thumbnailKey: null,
    createdBy,
    deletionRequestedAt: null,
    retentionExpiresAt: null,
  });
}

/** Response bodies are asserted field-by-field; typed loosely on purpose. */
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const params = (assetId = "ast_1", propertyId = "prp_1") => ({
  params: Promise.resolve({ propertyId, assetId }),
});
const postReq = (organizationId: unknown) =>
  new Request("http://t/api/analysis", {
    method: "POST",
    body: JSON.stringify({ organizationId }),
  });
const getReq = (organizationId: string) =>
  new Request(`http://t/api/analysis?organizationId=${encodeURIComponent(organizationId)}`);

beforeEach(async () => {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const orgs = new OrganizationService(deps);
  const owner = await auth.register({ email: "o@e.com", password: PASSWORD, name: "Owner" });
  const reviewer = await auth.register({ email: "r@e.com", password: PASSWORD, name: "Rev" });
  const outsider = await auth.register({ email: "x@e.com", password: PASSWORD, name: "Out" });
  const { organization: org } = await orgs.createOrganization(owner.id, { name: "Acme" });
  const { organization: other } = await orgs.createOrganization(owner.id, { name: "Other" });
  await deps.repos.memberships.create({
    organizationId: org.id,
    userId: reviewer.id,
    role: "REVIEWER",
  });

  const assets = new InMemoryMediaAssetRepository(deps.clock);
  const storage = new MapStorage();
  const provider = new StubProvider();
  const asset = await seed(assets, org.id, owner.id);
  await storage.putObject(asset.storageKey, new Uint8Array([1, 2, 3, 4]));
  await seed(assets, other.id, owner.id, {
    id: "ast_foreign",
    storageKey: "key/foreign",
    propertyId: "prp_foreign",
  });

  analysisService.value = new AnalysisService({
    identity: deps,
    assets,
    analyses: new InMemoryAssetAnalysisRepository(deps.clock),
    storage,
    provider,
    clock: deps.clock,
    ids: deps.ids,
  });
  currentUser.value = { user: { id: owner.id } };
  ctx = {
    ownerId: owner.id,
    reviewerId: reviewer.id,
    outsiderId: outsider.id,
    orgId: org.id,
    otherOrgId: other.id,
    provider,
    assets,
  };
});

describe("POST /analysis", () => {
  it("returns the analysis and is idempotent on re-request", async () => {
    const first = await startAnalysis(postReq(ctx.orgId), params());
    expect(first.status).toBe(200);
    const body = await jsonOf(first);
    expect(body.status).toBe("SUCCEEDED");
    expect(body.roomType).toBe("KITCHEN");
    expect(body.suggestedOrder).toBe(5);
    expect(body.lowConfidence).toBe(false);

    const second = await startAnalysis(postReq(ctx.orgId), params());
    expect(second.status).toBe(200);
    expect(ctx.provider.calls).toBe(1);
  });

  it("rejects an asset that is not READY", async () => {
    await seed(ctx.assets, ctx.orgId, ctx.ownerId, {
      id: "ast_pending",
      storageKey: "key/pending",
      status: "PENDING_UPLOAD",
    });
    const res = await startAnalysis(postReq(ctx.orgId), params("ast_pending"));
    expect(res.status).toBe(422);
  });

  it("returns 404 for an unknown asset", async () => {
    expect((await startAnalysis(postReq(ctx.orgId), params("ast_nope"))).status).toBe(404);
  });

  it("returns 422 when organizationId is missing or malformed", async () => {
    expect((await startAnalysis(postReq(undefined), params())).status).toBe(422);
    expect((await startAnalysis(postReq(""), params())).status).toBe(422);
    const bad = new Request("http://t/a", { method: "POST", body: "{not json" });
    expect((await startAnalysis(bad, params())).status).toBe(422);
  });
});

describe("POST /analysis/refresh", () => {
  it("recomputes, calling the provider again", async () => {
    await startAnalysis(postReq(ctx.orgId), params());
    const res = await refreshAnalysis(postReq(ctx.orgId), params());
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).status).toBe("SUCCEEDED");
    expect(ctx.provider.calls).toBe(2);
  });

  it("denies a REVIEWER", async () => {
    currentUser.value = { user: { id: ctx.reviewerId } };
    expect((await refreshAnalysis(postReq(ctx.orgId), params())).status).toBe(403);
  });
});

describe("GET routes", () => {
  it("returns one analysis and lists a property's analyses", async () => {
    await startAnalysis(postReq(ctx.orgId), params());

    const one = await getAnalysis(getReq(ctx.orgId), params());
    expect(one.status).toBe(200);
    expect((await jsonOf(one)).assetId).toBe("ast_1");

    const many = await listAnalyses(getReq(ctx.orgId), params());
    expect(many.status).toBe(200);
    expect((await jsonOf(many)).analyses).toHaveLength(1);
  });

  it("returns 404 when the asset has no analysis", async () => {
    expect((await getAnalysis(getReq(ctx.orgId), params())).status).toBe(404);
  });

  it("lets a REVIEWER read", async () => {
    await startAnalysis(postReq(ctx.orgId), params());
    currentUser.value = { user: { id: ctx.reviewerId } };
    expect((await getAnalysis(getReq(ctx.orgId), params())).status).toBe(200);
    expect((await listAnalyses(getReq(ctx.orgId), params())).status).toBe(200);
  });
});

describe("authentication and tenant isolation", () => {
  it("returns 401 on every route when unauthenticated", async () => {
    currentUser.value = null;
    expect((await startAnalysis(postReq(ctx.orgId), params())).status).toBe(401);
    expect((await refreshAnalysis(postReq(ctx.orgId), params())).status).toBe(401);
    expect((await getAnalysis(getReq(ctx.orgId), params())).status).toBe(401);
    expect((await listAnalyses(getReq(ctx.orgId), params())).status).toBe(401);
  });

  it("denies a non-member on every route", async () => {
    currentUser.value = { user: { id: ctx.outsiderId } };
    expect((await startAnalysis(postReq(ctx.orgId), params())).status).toBe(403);
    expect((await refreshAnalysis(postReq(ctx.orgId), params())).status).toBe(403);
    expect((await getAnalysis(getReq(ctx.orgId), params())).status).toBe(403);
    expect((await listAnalyses(getReq(ctx.orgId), params())).status).toBe(403);
  });

  it("hides another organization's asset from a member of both", async () => {
    // The owner belongs to both orgs, but ast_foreign is scoped to the other.
    const res = await startAnalysis(postReq(ctx.orgId), params("ast_foreign"));
    expect(res.status).toBe(404);

    const list = await listAnalyses(getReq(ctx.orgId), params("ast_1", "prp_foreign"));
    expect((await jsonOf(list)).analyses).toEqual([]);
  });
});

describe("response hygiene", () => {
  it("never exposes storage keys, organization ids, or the provider name", async () => {
    const res = await startAnalysis(postReq(ctx.orgId), params());
    const raw = JSON.stringify(await jsonOf(res));
    expect(raw).not.toContain(STORAGE_KEY);
    expect(raw).not.toContain("normalized.jpg");
    expect(raw).not.toContain(ctx.orgId);
    expect(raw).not.toContain("stub");
    expect(raw).not.toContain("reviewedBy");
  });
});
