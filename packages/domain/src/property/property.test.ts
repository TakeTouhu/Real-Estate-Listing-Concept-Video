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
  deleteObject(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string) {
    return Promise.resolve(this.objects.has(key));
  }
}

class FakeScanner implements MalwareScanner {
  constructor(public verdict: ScanVerdict = "CLEAN") {}
  scan() {
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
  process(): Promise<ProcessedImage> {
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
