import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { OrganizationService } from "../identity/organization-service";
import { AuthService } from "../identity/auth-service";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryMediaAssetRepository } from "../testing/in-memory-property";
import { InMemoryAssetAnalysisRepository } from "../testing/in-memory-analysis";
import type { MediaAsset, MediaAssetStatus } from "../property/types";
import type { ObjectStorage } from "../property/ports";
import { AnalysisService } from "./analysis-service";
import { analysisProviderError } from "./normalization";
import type { AnalysisRequest, AnalysisResult, AssetAnalysisRepository, ImageAnalysisProvider } from "./ports";

const PASSWORD = "password-123456";
const STORAGE_KEY = "org/o/properties/p/assets/a/normalized.jpg";

/** Deterministic provider with a call counter and injectable failure. */
class StubProvider implements ImageAnalysisProvider {
  readonly name = "stub";
  calls = 0;
  failWith: unknown = null;
  constructor(private readonly result: AnalysisResult) {}
  analyze(_request: AnalysisRequest): Promise<AnalysisResult> {
    this.calls += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.result);
  }
  normalizeError(error: unknown) {
    if (error instanceof Error && error.message === "timeout") {
      return analysisProviderError({
        kind: "TIMEOUT",
        code: "provider_timeout",
        messageSanitized: "Analysis timed out",
      });
    }
    return analysisProviderError({
      kind: "PROVIDER",
      code: "provider_error",
      messageSanitized: "Analysis provider failed",
    });
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

/**
 * Wraps a repository and fails the chosen method a set number of times, so a
 * database outage can be simulated without weakening the real adapter.
 */
function failingRepository(
  inner: AssetAnalysisRepository,
  method: "create" | "update",
  times: number,
): AssetAnalysisRepository {
  let remaining = times;
  return {
    // Bound explicitly: `inner` is a class instance, so spreading it would drop
    // its prototype methods.
    findById: (organizationId, id) => inner.findById(organizationId, id),
    findByAssetId: (organizationId, assetId) => inner.findByAssetId(organizationId, assetId),
    listByAssetIds: (organizationId, assetIds) =>
      inner.listByAssetIds(organizationId, assetIds),
    create: (input) => {
      if (method === "create" && remaining-- > 0) {
        return Promise.reject(new Error("db write failed"));
      }
      return inner.create(input);
    },
    update: (analysis) => {
      if (method === "update" && remaining-- > 0) {
        return Promise.reject(new Error("db write failed"));
      }
      return inner.update(analysis);
    },
  };
}

const RESULT: AnalysisResult = {
  roomType: "KITCHEN",
  confidence: 0.8,
  qualityScore: 0.7,
  brightnessScore: 0.5,
  blurScore: 0.2,
  detectedObjects: [{ label: "sink", confidence: 0.9 }],
  safetyFlags: [],
};

interface Fixture {
  deps: TestDeps;
  analyses: InMemoryAssetAnalysisRepository;
  assets: InMemoryMediaAssetRepository;
  storage: MapStorage;
  provider: StubProvider;
  service: AnalysisService;
  ownerId: string;
  orgId: string;
  assetId: string;
}

let fx: Fixture;

async function seedAsset(
  assets: InMemoryMediaAssetRepository,
  organizationId: string,
  createdBy: string,
  overrides: Partial<MediaAsset> = {},
): Promise<MediaAsset> {
  return assets.create({
    id: overrides.id ?? "ast_1",
    organizationId,
    propertyId: "prp_1",
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

async function build(): Promise<Fixture> {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const orgs = new OrganizationService(deps);
  const owner = await auth.register({
    email: "owner@example.com",
    password: PASSWORD,
    name: "Owner",
  });
  const { organization: org } = await orgs.createOrganization(owner.id, { name: "Acme" });

  const analyses = new InMemoryAssetAnalysisRepository(deps.clock);
  const assets = new InMemoryMediaAssetRepository(deps.clock);
  const storage = new MapStorage();
  const provider = new StubProvider(RESULT);
  const asset = await seedAsset(assets, org.id, owner.id);
  await storage.putObject(asset.storageKey, new Uint8Array([1, 2, 3, 4]));

  return {
    deps,
    analyses,
    assets,
    storage,
    provider,
    service: new AnalysisService({
      identity: deps,
      assets,
      analyses,
      storage,
      provider,
      clock: deps.clock,
      ids: deps.ids,
    }),
    ownerId: owner.id,
    orgId: org.id,
    assetId: asset.id,
  };
}

function serviceWith(f: Fixture, analyses: AssetAnalysisRepository): AnalysisService {
  return new AnalysisService({
    identity: f.deps,
    assets: f.assets,
    analyses,
    storage: f.storage,
    provider: f.provider,
    clock: f.deps.clock,
    ids: f.deps.ids,
  });
}

function actions(f: Fixture): string[] {
  return f.deps.repos.auditLogs.all().map((entry) => entry.action);
}

beforeEach(async () => {
  fx = await build();
});

describe("analyzeAsset", () => {
  it("persists a SUCCEEDED analysis from the provider result", async () => {
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(analysis.status).toBe("SUCCEEDED");
    expect(analysis.roomType).toBe("KITCHEN");
    expect(analysis.confidence).toBe(0.8);
    expect(analysis.detectedObjects).toEqual([{ label: "sink", confidence: 0.9 }]);
    expect(analysis.provider).toBe("stub");
    expect(analysis.failureReason).toBeNull();
    expect(fx.analyses.all()).toHaveLength(1);
  });

  it("merges provider flags with platform-derived quality flags", async () => {
    await fx.assets.update({
      ...(await fx.assets.findById(fx.orgId, fx.assetId))!,
      width: 320,
      height: 240,
    });
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(analysis.safetyFlags.map((f) => f.code)).toContain("LOW_RESOLUTION");
  });

  it("emits requested and succeeded audit entries without leaking storage keys", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(actions(fx)).toEqual(
      expect.arrayContaining(["analysis.requested", "analysis.succeeded"]),
    );
    const serialized = JSON.stringify(fx.deps.repos.auditLogs.all());
    expect(serialized).not.toContain("normalized.jpg");
    expect(serialized).not.toContain(STORAGE_KEY);
  });

  it.each<MediaAssetStatus>([
    "PENDING_UPLOAD",
    "UPLOADED",
    "SCANNING",
    "QUARANTINED",
    "PROCESSING",
    "REJECTED",
    "FAILED",
    "DELETION_PENDING",
  ])("refuses to analyze an asset in %s", async (status) => {
    const other = await seedAsset(fx.assets, fx.orgId, fx.ownerId, {
      id: `ast_${status}`,
      storageKey: `key/${status}`,
      status,
    });
    await expect(
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, other.id),
    ).rejects.toThrow(AppError);
    expect(fx.analyses.all()).toHaveLength(0);
  });

  it("treats a DELETED or unknown asset as not found", async () => {
    const deleted = await seedAsset(fx.assets, fx.orgId, fx.ownerId, {
      id: "ast_deleted",
      storageKey: "key/deleted",
      status: "DELETED",
    });
    await expect(
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, deleted.id),
    ).rejects.toThrow(/not found/i);
    await expect(
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, "ast_missing"),
    ).rejects.toThrow(/not found/i);
  });
});

describe("idempotency", () => {
  it("returns the existing SUCCEEDED analysis without calling the provider again", async () => {
    const first = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const second = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(second).toEqual(first);
    expect(fx.provider.calls).toBe(1);
    expect(fx.analyses.all()).toHaveLength(1);
  });

  it("keeps exactly one row across many sequential retries", async () => {
    for (let i = 0; i < 5; i += 1) {
      await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    }
    expect(fx.analyses.all()).toHaveLength(1);
    expect(fx.provider.calls).toBe(1);
  });
});

describe("failure handling", () => {
  it("records FAILED, not SUCCEEDED, when the provider times out", async () => {
    fx.provider.failWith = new Error("timeout");
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(analysis.status).toBe("FAILED");
    expect(analysis.failureReason).toBe("Analysis timed out");
    expect(analysis.roomType).toBeNull();
    expect(actions(fx)).toContain("analysis.failed");
  });

  it("records FAILED with a sanitized reason when the provider throws", async () => {
    fx.provider.failWith = new Error("ECONNRESET at vendor.internal/v1/secret-path");
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(analysis.status).toBe("FAILED");
    expect(analysis.failureReason).toBe("Analysis provider failed");
    expect(analysis.failureReason).not.toContain("vendor.internal");
  });

  it("records FAILED when the stored image cannot be read", async () => {
    fx.storage.objects.clear();
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(analysis.status).toBe("FAILED");
    expect(fx.provider.calls).toBe(0);
  });

  it("succeeds on a retry after a failure, converging to one SUCCEEDED row", async () => {
    fx.provider.failWith = new Error("timeout");
    const failed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(failed.status).toBe("FAILED");

    fx.provider.failWith = null;
    const retried = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe("SUCCEEDED");
    expect(retried.failureReason).toBeNull();
    expect(fx.analyses.all()).toHaveLength(1);
  });
});

describe("write-failure safety", () => {
  it("surfaces a reservation write failure without creating a row", async () => {
    const service = serviceWith(fx, failingRepository(fx.analyses, "create", 1));
    await expect(
      service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/db write failed/);

    expect(fx.analyses.all()).toHaveLength(0);
    expect(fx.provider.calls).toBe(0);
  });

  it("leaves the row PENDING when the terminal write fails, and converges on retry", async () => {
    const flaky = failingRepository(fx.analyses, "update", 1);
    await expect(
      serviceWith(fx, flaky).analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/db write failed/);

    // Reserved but not completed: no partially-updated result was persisted.
    const [row] = fx.analyses.all();
    expect(row?.status).toBe("PENDING");
    expect(row?.roomType).toBeNull();

    const recovered = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(recovered.status).toBe("SUCCEEDED");
    expect(recovered.id).toBe(row?.id);
    expect(fx.analyses.all()).toHaveLength(1);
  });

  it("persists the terminal analysis before the audit entry, so an audit failure cannot hide it", async () => {
    const auditLogs = fx.deps.repos.auditLogs;
    const original = auditLogs.append.bind(auditLogs);
    let calls = 0;
    auditLogs.append = (input) => {
      calls += 1;
      // Fail the terminal (succeeded) entry, after the row has been written.
      return calls === 2 ? Promise.reject(new Error("audit sink down")) : original(input);
    };

    await expect(
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/audit sink down/);

    const [row] = fx.analyses.all();
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.roomType).toBe("KITCHEN");

    auditLogs.append = original;
    const again = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(again.status).toBe("SUCCEEDED");
    expect(fx.analyses.all()).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("creates a single analysis row for concurrent requests on the same asset", async () => {
    const [a, b] = await Promise.all([
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
    ]);

    expect(fx.analyses.all()).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe("SUCCEEDED");
    expect(b.status).toBe("SUCCEEDED");
    expect(a.roomType).toBe(b.roomType);
  });

  it("adopts the winner's row when its own insert loses the unique-index race", async () => {
    // The real race: both requests read "no analysis yet", both insert, one
    // insert is rejected by the unique index on assetId. Simulated by hiding an
    // already-present row from the first read only.
    const winner = await fx.analyses.create({
      id: "ana_winner",
      organizationId: fx.orgId,
      assetId: fx.assetId,
      provider: "stub",
      status: "PENDING",
      roomType: null,
      confidence: null,
      qualityScore: null,
      brightnessScore: null,
      blurScore: null,
      duplicateGroup: null,
      detectedObjects: [],
      safetyFlags: [],
      suggestedOrder: null,
      failureReason: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    let reads = 0;
    const racing: AssetAnalysisRepository = {
      findById: (o, id) => fx.analyses.findById(o, id),
      listByAssetIds: (o, ids) => fx.analyses.listByAssetIds(o, ids),
      create: (input) => fx.analyses.create(input),
      update: (analysis) => fx.analyses.update(analysis),
      findByAssetId: (o, assetId) =>
        (reads += 1) === 1 ? Promise.resolve(null) : fx.analyses.findByAssetId(o, assetId),
    };

    const analysis = await serviceWith(fx, racing).analyzeAsset(
      fx.ownerId,
      fx.orgId,
      fx.assetId,
    );

    expect(analysis.id).toBe(winner.id);
    expect(analysis.status).toBe("SUCCEEDED");
    expect(fx.analyses.all()).toHaveLength(1);
  });

  it("does not swallow a create failure that is not a uniqueness conflict", async () => {
    const service = serviceWith(fx, failingRepository(fx.analyses, "create", 1));
    await expect(
      service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/db write failed/);
  });
});

describe("authorization and tenant isolation", () => {
  it("denies a user with no membership in the organization", async () => {
    const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
    const outsider = await auth.register({
      email: "outsider@example.com",
      password: PASSWORD,
      name: "Outsider",
    });
    await expect(
      fx.service.analyzeAsset(outsider.id, fx.orgId, fx.assetId),
    ).rejects.toThrow(/do not have access/i);
    expect(fx.analyses.all()).toHaveLength(0);
  });

  it("denies a REVIEWER, who may approve but not write assets", async () => {
    const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
    const reviewer = await auth.register({
      email: "reviewer@example.com",
      password: PASSWORD,
      name: "Reviewer",
    });
    await fx.deps.repos.memberships.create({
      organizationId: fx.orgId,
      userId: reviewer.id,
      role: "REVIEWER",
    });

    await expect(
      fx.service.analyzeAsset(reviewer.id, fx.orgId, fx.assetId),
    ).rejects.toThrow(/lacks permission/i);
  });

  it("cannot reach an asset owned by another organization", async () => {
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });
    const foreign = await seedAsset(fx.assets, other.id, fx.ownerId, {
      id: "ast_foreign",
      storageKey: "key/foreign",
    });

    // The actor is a member of both orgs, but the asset is scoped to `other`.
    await expect(
      fx.service.analyzeAsset(fx.ownerId, fx.orgId, foreign.id),
    ).rejects.toThrow(/not found/i);
    expect(fx.analyses.all()).toHaveLength(0);
  });

  it("does not expose another tenant's analysis row", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });

    expect(await fx.analyses.findByAssetId(other.id, fx.assetId)).toBeNull();
  });
});
