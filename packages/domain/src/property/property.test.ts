import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../identity/auth-service";
import { OrganizationService } from "../identity/organization-service";
import { MembershipService } from "../identity/membership-service";
import { createTestDeps, type TestDeps } from "../testing/in-memory";
import {
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
} from "../testing/in-memory-property";
import { PropertyService } from "./property-service";
import { AssetService } from "./asset-service";
import { buildAssetStorageKey } from "./media";
import type { ImageProcessor, MalwareScanner, ObjectStorage, ProcessedImage } from "./ports";
import type { ScanVerdict } from "./ports";

const PASSWORD = "password-123456";
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];

function jpegBytes(size = 2048): Uint8Array {
  const data = new Uint8Array(size);
  data.set(JPEG_HEADER, 0);
  for (let i = JPEG_HEADER.length; i < size; i += 1) data[i] = i % 251;
  return data;
}

/** Minimal in-memory ObjectStorage that records signed-URL requests. */
class FakeStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly signed: { key: string; purpose: string; ttl: number }[] = [];
  createSignedUploadUrl(key: string, ttlSeconds: number) {
    this.signed.push({ key, purpose: "upload", ttl: ttlSeconds });
    return Promise.resolve({ url: `upload://${key}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
  }
  createSignedDownloadUrl(key: string, ttlSeconds: number) {
    this.signed.push({ key, purpose: "download", ttl: ttlSeconds });
    return Promise.resolve({ url: `download://${key}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
  }
  putObject(key: string, data: Uint8Array) {
    this.objects.set(key, data);
    return Promise.resolve();
  }
  getObject(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  /** Keys this fake was asked to delete, and an optional injected failure. */
  readonly deleted: string[] = [];
  failDeleteFor?: (key: string) => boolean;
  deleteObject(key: string) {
    this.deleted.push(key);
    if (this.failDeleteFor?.(key)) return Promise.reject(new Error(`storage down for ${key}`));
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string) {
    return Promise.resolve(this.objects.has(key));
  }
}

class FakeScanner implements MalwareScanner {
  /** How many times a scan actually ran — proves a lost guard stopped earlier. */
  scanned = 0;
  constructor(public verdict: ScanVerdict = "CLEAN") {}
  scan() {
    this.scanned += 1;
    return Promise.resolve({ verdict: this.verdict });
  }
}

/** Deterministic processor: no native deps, controllable dimensions/hash. */
class FakeImageProcessor implements ImageProcessor {
  constructor(
    public width = 1600,
    public height = 1200,
    public hash = "0f0f0f0f0f0f0f0f",
    public shouldThrow = false,
  ) {}
  /** Count of real invocations, and a hook for interleaving a competing write. */
  processed = 0;
  onProcess?: () => Promise<void>;
  async process(): Promise<ProcessedImage> {
    this.processed += 1;
    if (this.onProcess) await this.onProcess();
    if (this.shouldThrow) return Promise.reject(new Error("corrupt image"));
    return Promise.resolve({
      normalized: new Uint8Array([1, 2, 3, 4]),
      normalizedMimeType: "image/jpeg",
      thumbnail: new Uint8Array([5, 6]),
      thumbnailMimeType: "image/webp",
      width: this.width,
      height: this.height,
      perceptualHash: this.hash,
    });
  }
}

interface Ctx {
  deps: TestDeps;
  properties: PropertyService;
  assets: AssetService;
  /** The repository itself, so a test can interleave a real deletion. */
  assetRepo: InMemoryMediaAssetRepository;
  storage: FakeStorage;
  scanner: FakeScanner;
  images: FakeImageProcessor;
  ownerId: string;
  orgId: string;
}

async function setup(): Promise<Ctx> {
  const deps = createTestDeps();
  const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
  const orgs = new OrganizationService(deps);
  const propertyRepo = new InMemoryPropertyRepository(deps.clock);
  const assetRepo = new InMemoryMediaAssetRepository(deps.clock);
  const storage = new FakeStorage();
  const scanner = new FakeScanner();
  const images = new FakeImageProcessor();

  const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
  const { organization } = await orgs.createOrganization(owner.id, { name: "Org One" });

  return {
    deps,
    assetRepo,
    storage,
    scanner,
    images,
    ownerId: owner.id,
    orgId: organization.id,
    properties: new PropertyService({
      identity: deps,
      properties: propertyRepo,
      assets: assetRepo,
      clock: deps.clock,
      ids: deps.ids,
    }),
    assets: new AssetService({
      identity: deps,
      properties: propertyRepo,
      assets: assetRepo,
      storage,
      scanner,
      images,
      clock: deps.clock,
      ids: deps.ids,
    }),
  };
}

describe("PropertyService CRUD", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("creates, reads, lists, updates, and soft-deletes a property", async () => {
    const created = await ctx.properties.create(ctx.ownerId, {
      organizationId: ctx.orgId,
      name: "  Sunny Apartment  ",
      propertyType: "APARTMENT",
      rightsConfirmed: true,
    });
    expect(created.name).toBe("Sunny Apartment");
    expect(created.status).toBe("ACTIVE");

    expect((await ctx.properties.get(ctx.ownerId, ctx.orgId, created.id)).id).toBe(created.id);
    expect((await ctx.properties.list(ctx.ownerId, ctx.orgId)).length).toBe(1);

    const updated = await ctx.properties.update(ctx.ownerId, ctx.orgId, created.id, {
      name: "Renamed",
      description: "Nice",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.description).toBe("Nice");

    await ctx.properties.remove(ctx.ownerId, ctx.orgId, created.id);
    expect((await ctx.properties.list(ctx.ownerId, ctx.orgId)).length).toBe(0);
    await expect(ctx.properties.get(ctx.ownerId, ctx.orgId, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("requires the rights confirmation (mandatory product rule)", async () => {
    await expect(
      ctx.properties.create(ctx.ownerId, {
        organizationId: ctx.orgId,
        name: "No rights",
        propertyType: "HOUSE",
        rightsConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("validates name and property type", async () => {
    await expect(
      ctx.properties.create(ctx.ownerId, {
        organizationId: ctx.orgId,
        name: "   ",
        propertyType: "HOUSE",
        rightsConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("emits audit events for create/update/delete", async () => {
    const p = await ctx.properties.create(ctx.ownerId, {
      organizationId: ctx.orgId,
      name: "Audited",
      propertyType: "OFFICE",
      rightsConfirmed: true,
    });
    await ctx.properties.update(ctx.ownerId, ctx.orgId, p.id, { name: "Audited 2" });
    await ctx.properties.remove(ctx.ownerId, ctx.orgId, p.id);
    const actions = (await ctx.deps.repos.auditLogs.listByOrganization(ctx.orgId)).map((a) => a.action);
    expect(actions).toContain("property.created");
    expect(actions).toContain("property.updated");
    expect(actions).toContain("property.deleted");
  });

  it("moves assets to DELETION_PENDING when the property is deleted (retention foundation)", async () => {
    const p = await ctx.properties.create(ctx.ownerId, {
      organizationId: ctx.orgId,
      name: "With assets",
      propertyType: "HOUSE",
      rightsConfirmed: true,
    });
    const { asset } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId: p.id,
      originalFilename: "a.jpg",
      declaredSizeBytes: 1000,
    });
    await ctx.properties.remove(ctx.ownerId, ctx.orgId, p.id);
    const list = await ctx.assets.list(ctx.ownerId, ctx.orgId, p.id);
    expect(list.find((a) => a.id === asset.id)?.status).toBe("DELETION_PENDING");
  });
});

describe("upload lifecycle", () => {
  let ctx: Ctx;
  let propertyId: string;
  beforeEach(async () => {
    ctx = await setup();
    propertyId = (
      await ctx.properties.create(ctx.ownerId, {
        organizationId: ctx.orgId,
        name: "Listing",
        propertyType: "APARTMENT",
        rightsConfirmed: true,
      })
    ).id;
  });

  async function uploadValid(filename = "photo.jpg") {
    const { asset, upload } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId,
      originalFilename: filename,
      declaredSizeBytes: 2048,
    });
    await ctx.storage.putObject(asset.storageKey, jpegBytes());
    return { asset, upload };
  }

  it("issues a short-lived, tenant-scoped signed upload URL", async () => {
    const { asset, upload } = await uploadValid();
    expect(asset.status).toBe("PENDING_UPLOAD");
    expect(asset.storageKey.startsWith(`org/${ctx.orgId}/`)).toBe(true);
    expect(upload.url).toContain(asset.storageKey);
    const signed = ctx.storage.signed.at(-1);
    expect(signed?.purpose).toBe("upload");
    expect(signed?.ttl).toBeLessThanOrEqual(600);
  });

  it("completes the pipeline to READY with derivatives, dimensions, and pHash", async () => {
    const { asset } = await uploadValid();
    const { asset: ready } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(ready.status).toBe("READY");
    expect(ready.mimeType).toBe("image/jpeg");
    expect(ready.width).toBe(1600);
    expect(ready.height).toBe(1200);
    expect(ready.perceptualHash).toBe("0f0f0f0f0f0f0f0f");
    expect(ready.thumbnailKey).toContain("thumbnail.webp");
    expect(ready.storageKey).toContain("normalized.jpg");
    expect(await ctx.storage.exists(ready.storageKey)).toBe(true);
    expect(await ctx.storage.exists(ready.thumbnailKey!)).toBe(true);
  });

  it("sanitizes the client filename (path traversal)", async () => {
    const { asset } = await uploadValid("../../etc/passwd.jpg");
    expect(asset.originalFilename).toBe("passwd.jpg");
  });

  it("issues signed download URLs only for READY assets", async () => {
    const { asset } = await uploadValid();
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const { asset: ready } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    const url = await ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, ready.id, "thumbnail");
    expect(url.url).toContain("thumbnail");
    expect(ctx.storage.signed.at(-1)?.purpose).toBe("download");
  });

  it("denies a download URL for a REJECTED asset", async () => {
    const { asset } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId,
      originalFilename: "not-an-image.jpg",
      declaredSizeBytes: 64,
    });
    // Content whose real type is not an allowed image is rejected.
    await ctx.storage.putObject(asset.storageKey, new Uint8Array(Buffer.from("<?php echo 1; ?>")));
    const { asset: rejected } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(rejected.status).toBe("REJECTED");

    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id, "thumbnail"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("denies a download URL for a DELETION_PENDING asset", async () => {
    const { asset } = await uploadValid();
    const { asset: ready } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(ready.status).toBe("READY");
    // Downloadable while READY...
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id),
    ).resolves.toBeDefined();

    // ...and denied once deletion has been requested.
    const pending = await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    expect(pending.status).toBe("DELETION_PENDING");
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id, "thumbnail"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("supports failed-upload recovery without creating a duplicate row", async () => {
    const { asset } = await uploadValid();
    ctx.images.shouldThrow = true;
    const failed = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(failed.asset.status).toBe("FAILED");

    ctx.images.shouldThrow = false;
    const retried = await ctx.assets.retryUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(retried.asset.id).toBe(asset.id);
    expect(retried.asset.status).toBe("PENDING_UPLOAD");

    await ctx.storage.putObject(retried.asset.storageKey, jpegBytes());
    const done = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(done.asset.status).toBe("READY");
    expect((await ctx.assets.list(ctx.ownerId, ctx.orgId, propertyId)).length).toBe(1);
  });

  it("flags near-duplicates via perceptual hash", async () => {
    const first = await uploadValid("one.jpg");
    await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, first.asset.id);
    const second = await uploadValid("two.jpg");
    const result = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, second.asset.id);
    expect(result.duplicateOf).toContain(first.asset.id);
  });

  it("requests deletion and stamps the deletion timestamp", async () => {
    const { asset } = await uploadValid();
    const deleted = await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    expect(deleted.status).toBe("DELETION_PENDING");
    expect(deleted.deletionRequestedAt).not.toBeNull();
  });

  it("emits audit events across the asset lifecycle", async () => {
    const { asset } = await uploadValid();
    await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    await ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id);
    await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    const actions = (await ctx.deps.repos.auditLogs.listByOrganization(ctx.orgId)).map((a) => a.action);
    expect(actions).toContain("asset.upload_requested");
    expect(actions).toContain("asset.upload_completed");
    expect(actions).toContain("asset.ready");
    expect(actions).toContain("asset.download_url_issued");
    expect(actions).toContain("asset.deletion_requested");
  });
});

describe("upload security", () => {
  let ctx: Ctx;
  let propertyId: string;
  beforeEach(async () => {
    ctx = await setup();
    propertyId = (
      await ctx.properties.create(ctx.ownerId, {
        organizationId: ctx.orgId,
        name: "Listing",
        propertyType: "APARTMENT",
        rightsConfirmed: true,
      })
    ).id;
  });

  async function request(declared = 2048) {
    return ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId,
      originalFilename: "photo.jpg",
      declaredSizeBytes: declared,
    });
  }

  it("rejects content whose real type is not an allowed image (disguised upload)", async () => {
    const { asset } = await request();
    await ctx.storage.putObject(asset.storageKey, new Uint8Array(Buffer.from("<?php echo 1; ?>")));
    const { asset: result } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(result.status).toBe("REJECTED");
    expect(result.failureReason).toMatch(/Unsupported or mismatched/);
  });

  it("rejects an oversized declared size up front", async () => {
    await expect(request(200 * 1024 * 1024)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects actual bytes over the size limit even if the client under-declared", async () => {
    const { asset } = await request(10);
    await ctx.storage.putObject(asset.storageKey, jpegBytes(26 * 1024 * 1024));
    const { asset: result } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(result.status).toBe("REJECTED");
  });

  it("quarantines a file the malware scanner flags", async () => {
    const { asset } = await request();
    await ctx.storage.putObject(asset.storageKey, jpegBytes());
    ctx.scanner.verdict = "INFECTED";
    const { asset: result } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(result.status).toBe("QUARANTINED");
    // Quarantined content is never downloadable.
    await expect(
      ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const actions = (await ctx.deps.repos.auditLogs.listByOrganization(ctx.orgId)).map((a) => a.action);
    expect(actions).toContain("asset.quarantined");
  });

  it("fails the asset when the scan cannot complete", async () => {
    const { asset } = await request();
    await ctx.storage.putObject(asset.storageKey, jpegBytes());
    ctx.scanner.verdict = "SCAN_FAILED";
    const { asset: result } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(result.status).toBe("FAILED");
  });

  it("enforces minimum and maximum image dimensions", async () => {
    const tiny = await request();
    await ctx.storage.putObject(tiny.asset.storageKey, jpegBytes());
    ctx.images.width = 100;
    ctx.images.height = 100;
    expect((await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, tiny.asset.id)).asset.status).toBe(
      "REJECTED",
    );

    const huge = await request();
    await ctx.storage.putObject(huge.asset.storageKey, jpegBytes());
    ctx.images.width = 20000;
    ctx.images.height = 20000;
    expect((await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, huge.asset.id)).asset.status).toBe(
      "REJECTED",
    );
  });

  it("enforces the per-property file-count limit", async () => {
    for (let i = 0; i < 20; i += 1) await request();
    await expect(request()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects completing an upload with no stored object", async () => {
    const { asset } = await request();
    await expect(
      ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("tenant isolation for properties and assets", () => {
  it("denies cross-tenant reads and writes for properties and assets", async () => {
    const a = await setup();
    // A second organization owned by a different user.
    const auth = new AuthService(a.deps, { sessionTtlSeconds: 3600 });
    const orgs = new OrganizationService(a.deps);
    const outsider = await auth.register({ email: "x@example.com", name: "X", password: PASSWORD });
    const { organization: otherOrg } = await orgs.createOrganization(outsider.id, { name: "Org Two" });

    const property = await a.properties.create(a.ownerId, {
      organizationId: a.orgId,
      name: "Private listing",
      propertyType: "HOUSE",
      rightsConfirmed: true,
    });
    const { asset } = await a.assets.requestUpload(a.ownerId, {
      organizationId: a.orgId,
      propertyId: property.id,
      originalFilename: "p.jpg",
      declaredSizeBytes: 1000,
    });

    // READ denial: outsider cannot list or read org1 resources.
    await expect(a.properties.list(outsider.id, a.orgId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.properties.get(outsider.id, a.orgId, property.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.assets.list(outsider.id, a.orgId, property.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.assets.createDownloadUrl(outsider.id, a.orgId, asset.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // WRITE denial: outsider cannot update, delete, upload, retry, or delete assets.
    await expect(
      a.properties.update(outsider.id, a.orgId, property.id, { name: "hacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.properties.remove(outsider.id, a.orgId, property.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.assets.requestUpload(outsider.id, {
        organizationId: a.orgId,
        propertyId: property.id,
        originalFilename: "x.jpg",
        declaredSizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.assets.retryUpload(outsider.id, a.orgId, asset.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      a.assets.requestDeletion(outsider.id, a.orgId, asset.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Even as a legitimate owner of org2, org1's ids are not addressable.
    await expect(
      a.properties.get(outsider.id, otherOrg.id, property.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      a.assets.createDownloadUrl(outsider.id, otherOrg.id, asset.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("denies asset writes to a REVIEWER (insufficient role)", async () => {
    const ctx = await setup();
    const auth = new AuthService(ctx.deps, { sessionTtlSeconds: 3600 });
    const members = new MembershipService(ctx.deps, { invitationTtlSeconds: 3600 });
    const property = await ctx.properties.create(ctx.ownerId, {
      organizationId: ctx.orgId,
      name: "Listing",
      propertyType: "HOUSE",
      rightsConfirmed: true,
    });
    const { token } = await members.invite(ctx.ownerId, {
      organizationId: ctx.orgId,
      email: "r@example.com",
      role: "REVIEWER",
    });
    const reviewer = await auth.register({ email: "r@example.com", name: "R", password: PASSWORD });
    await members.acceptInvitation(reviewer.id, token);

    // A reviewer may read but not write.
    expect((await ctx.properties.list(reviewer.id, ctx.orgId)).length).toBe(1);
    await expect(
      ctx.assets.requestUpload(reviewer.id, {
        organizationId: ctx.orgId,
        propertyId: property.id,
        originalFilename: "x.jpg",
        declaredSizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/**
 * Deletion intent is monotonic, and lifecycle work stops when it loses.
 *
 * These interleave a **real** deletion against a real in-flight operation
 * rather than stubbing a repository to return `null`. The window that matters
 * is `completeUpload`'s: it reads the asset once, then scans, processes an
 * image and writes two storage objects before its final write, and every one of
 * those stages runs on a snapshot taken before them.
 */
describe("deletion-intent monotonicity", () => {
  let ctx: Ctx;
  let propertyId: string;
  beforeEach(async () => {
    ctx = await setup();
    propertyId = (
      await ctx.properties.create(ctx.ownerId, {
        organizationId: ctx.orgId,
        name: "Listing",
        propertyType: "APARTMENT",
        rightsConfirmed: true,
      })
    ).id;
  });

  async function pendingAsset() {
    const { asset } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId,
      originalFilename: "photo.jpg",
      declaredSizeBytes: 2048,
    });
    await ctx.storage.putObject(asset.storageKey, jpegBytes());
    return asset;
  }

  it("stops completeUpload before scanning when deletion wins first", async () => {
    const asset = await pendingAsset();
    await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);

    await expect(
      ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // The very first guarded write lost, so nothing downstream ran at all.
    expect(ctx.scanner.scanned).toBe(0);
    expect(ctx.images.processed).toBe(0);
  });

  it("stops completeUpload at a later stage and never reaches READY", async () => {
    const asset = await pendingAsset();
    // Deletion lands *during* image processing — the longest stretch, and the
    // one the pre-4C-3A-1 code would have finished by resurrecting the asset.
    ctx.images.onProcess = async () => {
      await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    };

    await expect(
      ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const after = (await ctx.assetRepo.findById(ctx.orgId, asset.id))!;
    expect(after.status).toBe("DELETION_PENDING");
    expect(after.deletionRequestedAt).not.toBeNull();
    // The resurrection this milestone exists to prevent.
    expect(after.status).not.toBe("READY");
  });

  it("does not mint a fresh upload URL when retryUpload loses the guard", async () => {
    const asset = await pendingAsset();
    await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    const signedBefore = ctx.storage.signed.length;

    await expect(
      ctx.assets.retryUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // An upload credential for an asset being deleted is worse than a refusal.
    expect(ctx.storage.signed.length).toBe(signedBefore);
  });

  it("audits every successful deletion request, including a convergent one", async () => {
    // `AssetDeletionRequested` records a successful *invocation*, not the first
    // durable transition. Two API calls means two people asked, and the log
    // says so. An earlier revision suppressed the second entry, which is what
    // made a missing audit unrepairable.
    const asset = await pendingAsset();
    const first = await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    expect(deletionAudits(ctx)).toBe(1);

    const second = await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);

    expect(second.status).toBe("DELETION_PENDING");
    // One durable request — the timestamp is still the winner's — but two
    // audited invocations.
    expect(second.deletionRequestedAt).toEqual(first.deletionRequestedAt);
    expect(deletionAudits(ctx)).toBe(2);
  });

  it("fails the call when its audit write fails, and lets a retry repair it", async () => {
    // The gap review found. The CAS commits, the audit throws, and the call
    // fails — leaving deletion intent durable and unrecorded. What matters is
    // that the *next* call can still write the missing entry.
    const asset = await pendingAsset();
    const audits = ctx.deps.repos.auditLogs;
    const realAppend = audits.append.bind(audits);
    audits.append = () => Promise.reject(new Error("audit unavailable"));

    await expect(
      ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toThrow(/audit unavailable/);

    // Durable and unaudited: the honest intermediate state, not rolled back.
    const afterFailure = (await ctx.assetRepo.findById(ctx.orgId, asset.id))!;
    expect(afterFailure.status).toBe("DELETION_PENDING");
    expect(afterFailure.deletionRequestedAt).not.toBeNull();
    audits.append = realAppend;
    expect(deletionAudits(ctx)).toBe(0);

    // The retry converges on the existing intent and writes the entry that was
    // missing. Under the old suppression branch this returned success and left
    // the count at zero forever.
    const repaired = await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);

    expect(repaired.status).toBe("DELETION_PENDING");
    expect(repaired.deletionRequestedAt).toEqual(afterFailure.deletionRequestedAt);
    expect(deletionAudits(ctx)).toBe(1);
  });

  it("still reports a missing asset as NOT_FOUND", async () => {
    await expect(
      ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, "ast_missing"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes the derivatives it wrote when the final READY write loses", async () => {
    // The compensation. Both objects are already in storage when the guarded
    // write loses, and the durable row names neither — so nothing that walks
    // asset rows could ever find them.
    const asset = await pendingAsset();
    ctx.images.onProcess = async () => {
      await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    };

    await expect(
      ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const derivatives = [...ctx.storage.objects.keys()].filter(
      (k) => k.includes("normalized") || k.includes("thumbnail"),
    );
    expect(derivatives).toEqual([]);
    expect((await ctx.assetRepo.findById(ctx.orgId, asset.id))?.status).toBe("DELETION_PENDING");
    // And no success audit for work that did not succeed.
    expect(auditActions(ctx)).not.toContain("asset.upload_completed");
  });

  it("never deletes a derivative the durable row now references", async () => {
    // Future-proofing, and the reason cleanup re-reads rather than deleting
    // blindly. If another winner has taken ownership of these exact keys —
    // `buildAssetStorageKey` is deterministic, so a concurrent re-process of
    // the same asset produces the same normalized key — removing them would
    // turn a lost race into data loss.
    const asset = await pendingAsset();
    let normalizedKey = "";
    ctx.images.onProcess = async () => {
      // Drive the row to a READY state that owns the keys this operation is
      // about to write, then lose the race for it.
      const inFlight = (await ctx.assetRepo.findById(ctx.orgId, asset.id))!;
      // The real key builder, so the row references exactly what the service is
      // about to write — the whole point of the guard.
      normalizedKey = buildAssetStorageKey({
        organizationId: ctx.orgId,
        propertyId: inFlight.propertyId,
        assetId: asset.id,
        variant: "normalized",
        extension: "jpg",
      });
      await ctx.assetRepo.updateIfCurrent(
        { ...inFlight, status: "READY", storageKey: normalizedKey, thumbnailKey: null },
        inFlight.status,
      );
    };

    await expect(
      ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // The referenced key survives; this invocation still lost ownership.
    expect(ctx.storage.objects.has(normalizedKey)).toBe(true);
    expect((await ctx.assetRepo.findById(ctx.orgId, asset.id))?.storageKey).toBe(normalizedKey);
  });

  it("surfaces a sanitized failure when cleanup cannot complete", async () => {
    const asset = await pendingAsset();
    ctx.images.onProcess = async () => {
      await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, asset.id);
    };
    ctx.storage.failDeleteFor = (key) => key.includes("normalized");

    const error = await ctx.assets
      .completeUpload(ctx.ownerId, ctx.orgId, asset.id)
      .then(() => null)
      .catch((e: unknown) => e as { code: string; message: string; details?: unknown });

    expect(error!.code).toBe("INTERNAL_ERROR");
    // Both keys attempted even though the first threw, so one storage error
    // cannot strand the other object.
    expect(ctx.storage.deleted.filter((k) => k.includes("thumbnail"))).toHaveLength(1);
    // No storage key reaches the customer.
    expect(JSON.stringify(error)).not.toContain(asset.id);
    expect(error!.message).not.toContain("normalized");
    expect((await ctx.assetRepo.findById(ctx.orgId, asset.id))?.deletionRequestedAt).not.toBeNull();
  });

  it("removes a property even when one asset is already deletion-pending", async () => {
    const a = await pendingAsset();
    const b = await pendingAsset();
    await ctx.assets.requestDeletion(ctx.ownerId, ctx.orgId, a.id);

    // A concurrent deletion already moved `a` the way removal wants it to go;
    // refusing removal over that would fail the request for having partly
    // succeeded already.
    await expect(
      ctx.properties.remove(ctx.ownerId, ctx.orgId, propertyId),
    ).resolves.toBeUndefined();

    // Both the status **and** the recorded intent. Status alone would be
    // satisfied by an ordinary lifecycle write, which cannot set
    // `deletionRequestedAt` at all — leaving a row that looks deletion-pending
    // but carries no record that deletion was ever requested, and so no
    // timestamp for a retention window to start from.
    for (const id of [a.id, b.id]) {
      const asset = (await ctx.assetRepo.findById(ctx.orgId, id))!;
      expect(asset.status).toBe("DELETION_PENDING");
      expect(asset.deletionRequestedAt).not.toBeNull();
    }
  });
});

/** Deletion audit entries recorded so far, for duplicate-emission checks. */
function deletionAudits(ctx: Ctx): number {
  return ctx.deps.repos.auditLogs
    .all()
    .filter((entry) => entry.action === "asset.deletion_requested").length;
}

/** All audit actions recorded so far. */
function auditActions(ctx: Ctx): string[] {
  return ctx.deps.repos.auditLogs.all().map((entry) => entry.action);
}
