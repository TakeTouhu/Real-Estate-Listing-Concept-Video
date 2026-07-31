import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { OrganizationService } from "../identity/organization-service";
import { AuthService } from "../identity/auth-service";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import { InMemoryMediaAssetRepository } from "../testing/in-memory-property";
import { InMemoryAssetAnalysisRepository } from "../testing/in-memory-analysis";
import { InMemoryReviewTransaction } from "../testing/in-memory-review-transaction";
import type { MediaAsset, MediaAssetStatus } from "../property/types";
import type { ObjectStorage } from "../property/ports";
import { AnalysisService } from "./analysis-service";
import { analysisProviderError } from "./normalization";
import type { AnalysisRequest, AnalysisResult, AssetAnalysisRepository, ImageAnalysisProvider } from "./ports";
import type { AssetAnalysis } from "./types";

const PASSWORD = "password-123456";
const STORAGE_KEY = "org/o/properties/p/assets/a/normalized.jpg";

/** Deterministic provider with a call counter and injectable failure. */
class StubProvider implements ImageAnalysisProvider {
  readonly name = "stub";
  calls = 0;
  failWith: unknown = null;
  constructor(public result: AnalysisResult) {}
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
      reviewTx: new InMemoryReviewTransaction(analyses, assets),
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
    reviewTx: new InMemoryReviewTransaction(f.analyses, f.assets),
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
      analysisRevision: 1,
      reviewStatus: "UNREVIEWED",
      reviewNote: null,
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

// --- Phase 3A-2c -----------------------------------------------------------

/** Analyze a freshly seeded asset, returning its analysis. */
async function analyzeSeeded(
  id: string,
  overrides: Partial<MediaAsset> = {},
): Promise<AssetAnalysis> {
  const asset = await seedAsset(fx.assets, fx.orgId, fx.ownerId, {
    id,
    storageKey: `key/${id}`,
    ...overrides,
  });
  await fx.storage.putObject(asset.storageKey, new Uint8Array([9, 9, 9, 9]));
  return fx.service.analyzeAsset(fx.ownerId, fx.orgId, asset.id);
}

describe("refresh", () => {
  it("calls the provider again and reuses the same analysis row", async () => {
    const first = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const refreshed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, {
      refresh: true,
    });

    expect(fx.provider.calls).toBe(2);
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.status).toBe("SUCCEEDED");
    expect(fx.analyses.all()).toHaveLength(1);
    expect(actions(fx)).toContain("analysis.refreshed");
  });

  it("remains idempotent without refresh, leaving the provider uncalled", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const again = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    expect(fx.provider.calls).toBe(1);
    expect(again.status).toBe("SUCCEEDED");
    expect(actions(fx)).not.toContain("analysis.refreshed");
  });

  it("ends in FAILED with no stale result surviving a failed refresh", async () => {
    const first = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(first.roomType).toBe("KITCHEN");
    expect(first.suggestedOrder).not.toBeNull();

    fx.provider.failWith = new Error("timeout");
    const failed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, {
      refresh: true,
    });

    expect(failed.id).toBe(first.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("Analysis timed out");
    // Nothing from the previous successful run may survive.
    expect(failed.roomType).toBeNull();
    expect(failed.confidence).toBeNull();
    expect(failed.qualityScore).toBeNull();
    expect(failed.duplicateGroup).toBeNull();
    expect(failed.suggestedOrder).toBeNull();
    expect(failed.detectedObjects).toEqual([]);
    expect(failed.safetyFlags).toEqual([]);
  });

  it("clears a previous failure reason when a later refresh succeeds", async () => {
    fx.provider.failWith = new Error("timeout");
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    fx.provider.failWith = null;

    const recovered = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, {
      refresh: true,
    });
    expect(recovered.status).toBe("SUCCEEDED");
    expect(recovered.failureReason).toBeNull();
    expect(fx.analyses.all()).toHaveLength(1);
  });
});

describe("duplicate grouping", () => {
  it("starts a new group for the first analyzed asset", async () => {
    const first = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(first.duplicateGroup).toBe(`dup_${fx.assetId}`);
  });

  it("puts identical perceptual hashes in the same group", async () => {
    const first = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const twin = await analyzeSeeded("ast_twin", { perceptualHash: "ffffffffffffffff" });

    expect(twin.duplicateGroup).toBe(first.duplicateGroup);
  });

  it("keeps a distant perceptual hash in its own group", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const distinct = await analyzeSeeded("ast_other", { perceptualHash: "0000000000000000" });

    expect(distinct.duplicateGroup).toBe("dup_ast_other");
  });

  it("leaves duplicateGroup null when the asset has no perceptual hash", async () => {
    const unhashed = await analyzeSeeded("ast_nohash", { perceptualHash: null });
    expect(unhashed.duplicateGroup).toBeNull();
  });

  it("ignores an identical hash owned by another organization", async () => {
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });
    const foreign = await seedAsset(fx.assets, other.id, fx.ownerId, {
      id: "ast_foreign_twin",
      storageKey: "key/foreign_twin",
      perceptualHash: "ffffffffffffffff",
    });
    await fx.storage.putObject(foreign.storageKey, new Uint8Array([7, 7, 7, 7]));
    const foreignAnalysis = await fx.service.analyzeAsset(fx.ownerId, other.id, foreign.id);

    // Same hash, different tenant: our asset must not join their group.
    const mine = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(mine.duplicateGroup).toBe(`dup_${fx.assetId}`);
    expect(mine.duplicateGroup).not.toBe(foreignAnalysis.duplicateGroup);
  });
});

describe("suggested order", () => {
  it("ranks by the documented room sequence", async () => {
    fx.provider.result = { ...RESULT, roomType: "EXTERIOR" };
    const exterior = await analyzeSeeded("ast_ext", { perceptualHash: "0000000000000001" });
    fx.provider.result = { ...RESULT, roomType: "LIVING_ROOM" };
    const living = await analyzeSeeded("ast_liv", { perceptualHash: "0000000000000010" });
    fx.provider.result = { ...RESULT, roomType: "BEDROOM" };
    const bedroom = await analyzeSeeded("ast_bed", { perceptualHash: "0000000000000100" });

    expect(exterior.suggestedOrder).toBeLessThan(living.suggestedOrder!);
    expect(living.suggestedOrder).toBeLessThan(bedroom.suggestedOrder!);
  });

  it("ranks OTHER after every recognized room type", async () => {
    fx.provider.result = { ...RESULT, roomType: "OTHER" };
    const other = await analyzeSeeded("ast_other_room", { perceptualHash: "0000000000001000" });
    fx.provider.result = { ...RESULT, roomType: "BALCONY" };
    const balcony = await analyzeSeeded("ast_balcony", { perceptualHash: "0000000000010000" });

    expect(other.suggestedOrder).toBeGreaterThan(balcony.suggestedOrder!);
  });
});

describe("reads", () => {
  it("returns only the requested property's analyses, organization-scoped", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await analyzeSeeded("ast_p2", { propertyId: "prp_2", perceptualHash: "0000000000100000" });

    const first = await fx.service.listForProperty(fx.ownerId, fx.orgId, "prp_1");
    expect(first.map((a) => a.assetId)).toEqual([fx.assetId]);

    const second = await fx.service.listForProperty(fx.ownerId, fx.orgId, "prp_2");
    expect(second.map((a) => a.assetId)).toEqual(["ast_p2"]);
  });

  it("returns an empty list for a property in another organization", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });

    expect(await fx.service.listForProperty(fx.ownerId, other.id, "prp_1")).toEqual([]);
  });

  it("returns the analysis for an asset", async () => {
    const created = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const read = await fx.service.getForAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(read.id).toBe(created.id);
  });

  it("throws NOT_FOUND when the asset has no analysis", async () => {
    await expect(
      fx.service.getForAsset(fx.ownerId, fx.orgId, "ast_never_analyzed"),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a REVIEWER read, though they may not start an analysis", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
    const reviewer = await auth.register({
      email: "reader@example.com",
      password: PASSWORD,
      name: "Reader",
    });
    await fx.deps.repos.memberships.create({
      organizationId: fx.orgId,
      userId: reviewer.id,
      role: "REVIEWER",
    });

    expect((await fx.service.getForAsset(reviewer.id, fx.orgId, fx.assetId)).assetId).toBe(
      fx.assetId,
    );
    expect(await fx.service.listForProperty(reviewer.id, fx.orgId, "prp_1")).toHaveLength(1);
    await expect(
      fx.service.analyzeAsset(reviewer.id, fx.orgId, fx.assetId, { refresh: true }),
    ).rejects.toThrow(/lacks permission/i);
  });

  it("denies a non-member both reads", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
    const outsider = await auth.register({
      email: "nobody@example.com",
      password: PASSWORD,
      name: "Nobody",
    });

    await expect(
      fx.service.getForAsset(outsider.id, fx.orgId, fx.assetId),
    ).rejects.toThrow(/do not have access/i);
    await expect(
      fx.service.listForProperty(outsider.id, fx.orgId, "prp_1"),
    ).rejects.toThrow(/do not have access/i);
  });

  it("keeps another tenant's analysis invisible", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });

    // Member of both organizations, but the analysis belongs to the first.
    await expect(
      fx.service.getForAsset(fx.ownerId, other.id, fx.assetId),
    ).rejects.toThrow(/not found/i);
  });
});

// --- Phase 3B-1b: review -----------------------------------------------------

/** Seed, store bytes for, and analyze an asset, returning its analysis. */
async function analyzedAsset(
  id: string,
  overrides: Partial<MediaAsset> = {},
): Promise<AssetAnalysis> {
  const asset = await seedAsset(fx.assets, fx.orgId, fx.ownerId, {
    id,
    storageKey: `key/${id}`,
    ...overrides,
  });
  await fx.storage.putObject(asset.storageKey, new Uint8Array([5, 5, 5, 5]));
  return fx.service.analyzeAsset(fx.ownerId, fx.orgId, asset.id);
}

async function memberWithRole(
  email: string,
  role: "OWNER" | "ADMIN" | "CREATOR" | "REVIEWER",
): Promise<string> {
  const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
  const user = await auth.register({ email, password: PASSWORD, name: email });
  await fx.deps.repos.memberships.create({
    organizationId: fx.orgId,
    userId: user.id,
    role,
  });
  return user.id;
}

function auditFor(action: string): Record<string, unknown> | undefined {
  const entry = fx.deps.repos.auditLogs.all().find((e) => e.action === action);
  return entry?.metadata as Record<string, unknown> | undefined;
}

describe("analysisRevision", () => {
  it("starts at 1 for the first successful analysis", async () => {
    expect((await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId)).analysisRevision).toBe(1);
  });

  it("increments on each successful refresh", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const second = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    expect(second.analysisRevision).toBe(2);
    const third = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    expect(third.analysisRevision).toBe(3);
  });

  it("leaves the revision unchanged when a refresh fails, then resumes from it", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    fx.provider.failWith = new Error("timeout");
    const failed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    expect(failed.status).toBe("FAILED");
    expect(failed.analysisRevision).toBe(1);

    fx.provider.failWith = null;
    const recovered = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    expect(recovered.analysisRevision).toBe(2);
  });

  it("does not advance the revision when an initial analysis is retried after failing", async () => {
    fx.provider.failWith = new Error("timeout");
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    fx.provider.failWith = null;

    const retried = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    expect(retried.status).toBe("SUCCEEDED");
    expect(retried.analysisRevision).toBe(1);
  });
});

describe("approve", () => {
  it("records the decision with the reviewer, timestamp and optional reason", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const approved = await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, {
      reason: "Looks good",
    });

    expect(approved.reviewStatus).toBe("APPROVED");
    expect(approved.reviewNote).toBe("Looks good");
    expect(approved.reviewedBy).toBe(fx.ownerId);
    expect(approved.reviewedAt).not.toBeNull();
    expect((await fx.assets.findById(fx.orgId, fx.assetId))?.status).toBe("READY");
  });

  it("treats a blank or absent approval reason as null", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const approved = await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, { reason: "   " });
    expect(approved.reviewNote).toBeNull();
  });

  it("refuses to approve an analysis carrying a BLOCKING flag", async () => {
    fx.provider.result = {
      ...RESULT,
      safetyFlags: [{ code: "PERSON_DETECTED", severity: "BLOCKING", message: "person visible" }],
    };
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/blocking safety finding/i);
    expect((await fx.analyses.findByAssetId(fx.orgId, fx.assetId))?.reviewStatus).toBe("UNREVIEWED");
  });

  it("still allows rejecting an analysis carrying a BLOCKING flag", async () => {
    fx.provider.result = {
      ...RESULT,
      safetyFlags: [{ code: "PERSON_DETECTED", severity: "BLOCKING", message: "person visible" }],
    };
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    const rejected = await fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, {
      reason: "Person visible",
    });
    expect(rejected.reviewStatus).toBe("REJECTED");
  });
});

describe("reject", () => {
  it("marks the asset REJECTED alongside the analysis", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const rejected = await fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, {
      reason: "Too blurry",
    });

    expect(rejected.reviewStatus).toBe("REJECTED");
    expect(rejected.reviewNote).toBe("Too blurry");
    expect((await fx.assets.findById(fx.orgId, fx.assetId))?.status).toBe("REJECTED");
  });

  it("requires a non-blank reason", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await expect(
      fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, { reason: "   " }),
    ).rejects.toThrow(/reason is required/i);
    await expect(
      fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, { reason: "" }),
    ).rejects.toThrow(/reason is required/i);
    expect((await fx.analyses.findByAssetId(fx.orgId, fx.assetId))?.reviewStatus).toBe("UNREVIEWED");
  });

  it("applies neither write when the transaction fails part-way", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const original = fx.assets.update.bind(fx.assets);
    fx.assets.update = () => Promise.reject(new Error("asset write failed"));

    await expect(
      fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, { reason: "Too blurry" }),
    ).rejects.toThrow(/asset write failed/);

    fx.assets.update = original;
    expect((await fx.analyses.findByAssetId(fx.orgId, fx.assetId))?.reviewStatus).toBe("UNREVIEWED");
    expect((await fx.assets.findById(fx.orgId, fx.assetId))?.status).toBe("READY");
    expect(actions(fx)).not.toContain("analysis.rejected");
  });
});

describe("review immutability", () => {
  it.each([
    ["approve", "approve"],
    ["approve", "reject"],
    ["reject", "approve"],
    ["reject", "reject"],
  ])("refuses to %s then %s the same revision", async (first, second) => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const run = (which: string) =>
      which === "approve"
        ? fx.service.approve(fx.ownerId, fx.orgId, fx.assetId)
        : fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, { reason: "no" });

    await run(first);
    await expect(run(second)).rejects.toThrow(/already been reviewed/i);
  });

  it("becomes reviewable again after a refresh, which clears the decision", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, { reason: "fine" });

    const refreshed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, {
      refresh: true,
    });
    expect(refreshed.reviewStatus).toBe("UNREVIEWED");
    expect(refreshed.reviewNote).toBeNull();
    expect(refreshed.reviewedBy).toBeNull();
    expect(refreshed.reviewedAt).toBeNull();

    await expect(fx.service.approve(fx.ownerId, fx.orgId, fx.assetId)).resolves.toBeDefined();
  });

  it("clears the decision even when the refresh then fails", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId);

    fx.provider.failWith = new Error("timeout");
    const failed = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    expect(failed.status).toBe("FAILED");
    expect(failed.reviewStatus).toBe("UNREVIEWED");
    expect(failed.reviewedBy).toBeNull();
  });

  it("refuses to review an analysis that is not SUCCEEDED", async () => {
    fx.provider.failWith = new Error("timeout");
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);

    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/completed analysis/i);
  });
});

describe("duplicate groups", () => {
  it("requires a primary choice once the group has more than one member", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await analyzedAsset("ast_twin", { perceptualHash: "ffffffffffffffff" });

    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/choose the primary asset/i);
  });

  it("requires primaryAssetId to be the asset being approved", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await analyzedAsset("ast_twin", { perceptualHash: "ffffffffffffffff" });

    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, { primaryAssetId: "ast_twin" }),
    ).rejects.toThrow(/must be the asset being approved/i);
  });

  it("approves the chosen primary", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await analyzedAsset("ast_twin", { perceptualHash: "ffffffffffffffff" });

    const approved = await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, {
      primaryAssetId: fx.assetId,
    });
    expect(approved.reviewStatus).toBe("APPROVED");
  });

  it("needs no primary choice for a single-member group", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await expect(fx.service.approve(fx.ownerId, fx.orgId, fx.assetId)).resolves.toBeDefined();
  });

  it("maps the database uniqueness conflict to a validation failure", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await analyzedAsset("ast_twin", { perceptualHash: "ffffffffffffffff" });
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, { primaryAssetId: fx.assetId });

    // The constraint, not a pre-check, refuses the second approval.
    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, "ast_twin", { primaryAssetId: "ast_twin" }),
    ).rejects.toThrow(/already approved/i);
    expect((await fx.analyses.findByAssetId(fx.orgId, "ast_twin"))?.reviewStatus).toBe("UNREVIEWED");
  });

  it("rethrows a write failure that is not a duplicate-group conflict", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const original = fx.analyses.update.bind(fx.analyses);
    fx.analyses.update = () => Promise.reject(new Error("db write failed"));

    await expect(
      fx.service.approve(fx.ownerId, fx.orgId, fx.assetId),
    ).rejects.toThrow(/db write failed/);
    fx.analyses.update = original;
  });
});

describe("review authorization and tenant isolation", () => {
  it("denies a CREATOR, who may run analyses but not review them", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const creator = await memberWithRole("creator@example.com", "CREATOR");

    await expect(
      fx.service.approve(creator, fx.orgId, fx.assetId),
    ).rejects.toThrow(/lacks permission/i);
    await expect(
      fx.service.reject(creator, fx.orgId, fx.assetId, { reason: "no" }),
    ).rejects.toThrow(/lacks permission/i);
  });

  it("allows a REVIEWER to approve and reject", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const reviewer = await memberWithRole("reviewer2@example.com", "REVIEWER");
    await expect(fx.service.approve(reviewer, fx.orgId, fx.assetId)).resolves.toBeDefined();

    const other = await analyzedAsset("ast_other", { perceptualHash: "0000000000000000" });
    expect(other.reviewStatus).toBe("UNREVIEWED");
    await expect(
      fx.service.reject(reviewer, fx.orgId, "ast_other", { reason: "blurry" }),
    ).resolves.toBeDefined();
  });

  it("denies a non-member", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const auth = new AuthService(fx.deps, { sessionTtlSeconds: 3600 });
    const outsider = await auth.register({
      email: "out2@example.com",
      password: PASSWORD,
      name: "Out",
    });

    await expect(
      fx.service.approve(outsider.id, fx.orgId, fx.assetId),
    ).rejects.toThrow(/do not have access/i);
  });

  it("keeps another tenant's analysis unreviewable", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    const orgs = new OrganizationService(fx.deps);
    const { organization: other } = await orgs.createOrganization(fx.ownerId, { name: "Other" });

    await expect(
      fx.service.approve(fx.ownerId, other.id, fx.assetId),
    ).rejects.toThrow(/not found/i);
  });
});

describe("review audit", () => {
  it("records every required field on approval", async () => {
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId, { reason: "Looks good" });

    expect(auditFor("analysis.approved")).toEqual({
      analysisId: analysis.id,
      assetId: fx.assetId,
      propertyId: "prp_1",
      organizationId: fx.orgId,
      actorId: fx.ownerId,
      reason: "Looks good",
      analysisRevision: 1,
    });
  });

  it("records a null reason when approval carries none, and the revision after a refresh", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId, { refresh: true });
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId);

    const meta = auditFor("analysis.approved");
    expect(meta?.reason).toBeNull();
    expect(meta?.analysisRevision).toBe(2);
  });

  it("records every required field on rejection", async () => {
    const analysis = await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.reject(fx.ownerId, fx.orgId, fx.assetId, { reason: "Too blurry" });

    expect(auditFor("analysis.rejected")).toEqual({
      analysisId: analysis.id,
      assetId: fx.assetId,
      propertyId: "prp_1",
      organizationId: fx.orgId,
      actorId: fx.ownerId,
      reason: "Too blurry",
      analysisRevision: 1,
    });
  });

  it("leaks no storage key or provider name into review audit metadata", async () => {
    await fx.service.analyzeAsset(fx.ownerId, fx.orgId, fx.assetId);
    await fx.service.approve(fx.ownerId, fx.orgId, fx.assetId);

    const serialized = JSON.stringify(auditFor("analysis.approved"));
    expect(serialized).not.toContain(STORAGE_KEY);
    expect(serialized).not.toContain("normalized.jpg");
    expect(serialized).not.toContain("stub");
  });
});
