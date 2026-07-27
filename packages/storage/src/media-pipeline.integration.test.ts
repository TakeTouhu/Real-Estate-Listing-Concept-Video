import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AssetService,
  AuthService,
  OrganizationService,
  PropertyService,
  hammingDistanceHex,
  sniffMimeType,
} from "@app/domain";
import {
  createTestDeps,
  InMemoryMediaAssetRepository,
  InMemoryPropertyRepository,
} from "@app/domain/testing";
import { LocalObjectStorage } from "./local-storage";
import { SharpImageProcessor, averageHashHex } from "./image-processor";
import { PassthroughMalwareScanner } from "./scanner";
import { verifyStorageToken } from "./signing";

const SECRET = "integration-storage-secret-1234";
const PASSWORD = "password-123456";

/** Build a real JPEG carrying EXIF orientation + GPS metadata. */
async function jpegWithMetadata(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .withMetadata({
      // GPS is a valid EXIF IFD but is absent from sharp's Exif type, so the
      // block is cast; the point of the fixture is that ALL of it is stripped.
      exif: {
        IFD0: { Copyright: "Test", Make: "TestCam" },
        GPS: { GPSLatitudeRef: "N" },
      } as unknown as sharp.Exif,
      orientation: 6,
    })
    .jpeg()
    .toBuffer();
}

describe("SharpImageProcessor (real image pipeline)", () => {
  const processor = new SharpImageProcessor();

  it("strips EXIF/GPS metadata from the processed copy", async () => {
    const input = await jpegWithMetadata(1200, 800);
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processor.process(new Uint8Array(input));
    const outMeta = await sharp(Buffer.from(result.normalized)).metadata();
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.orientation).toBeUndefined();
  });

  it("applies EXIF orientation (6 = 90° rotate), swapping dimensions", async () => {
    const input = await jpegWithMetadata(1200, 800);
    const result = await processor.process(new Uint8Array(input));
    // Orientation 6 rotates, so the reported size is the rotated geometry.
    expect(result.width).toBe(800);
    expect(result.height).toBe(1200);
  });

  it("normalizes down to the configured long edge", async () => {
    const small = new SharpImageProcessor({ maxLongEdgePx: 640 });
    const input = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const result = await small.process(new Uint8Array(input));
    expect(Math.max(result.width, result.height)).toBe(640);
  });

  it("produces a real webp thumbnail bounded by the configured size", async () => {
    const input = await jpegWithMetadata(1600, 1200);
    const result = await processor.process(new Uint8Array(input));
    expect(result.thumbnailMimeType).toBe("image/webp");
    const thumbMeta = await sharp(Buffer.from(result.thumbnail)).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(400);
  });

  it("produces a 16-hex-character perceptual hash that matches for identical images", async () => {
    const input = await jpegWithMetadata(1000, 1000);
    const a = await processor.process(new Uint8Array(input));
    const b = await processor.process(new Uint8Array(input));
    expect(a.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistanceHex(a.perceptualHash, b.perceptualHash)).toBe(0);
  });

  it("gives distant hashes for visually different images", async () => {
    const dark = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 300, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    const inverted = await sharp(dark).flop().jpeg().toBuffer();
    const h1 = await averageHashHex(new Uint8Array(dark));
    const h2 = await averageHashHex(new Uint8Array(inverted));
    expect(hammingDistanceHex(h1, h2)).toBeGreaterThan(6);
  });

  it("rejects non-image bytes", async () => {
    await expect(processor.process(new Uint8Array(Buffer.from("not an image")))).rejects.toThrow();
  });
});

describe("end-to-end secure upload flow (storage + domain + real images)", () => {
  async function setup() {
    const deps = createTestDeps();
    const auth = new AuthService(deps, { sessionTtlSeconds: 3600 });
    const orgs = new OrganizationService(deps);
    const storage = new LocalObjectStorage({ secret: SECRET });
    const propertyRepo = new InMemoryPropertyRepository(deps.clock);
    const assetRepo = new InMemoryMediaAssetRepository(deps.clock);

    const owner = await auth.register({ email: "o@example.com", name: "O", password: PASSWORD });
    const { organization } = await orgs.createOrganization(owner.id, { name: "Org" });

    const properties = new PropertyService({
      identity: deps,
      properties: propertyRepo,
      assets: assetRepo,
      clock: deps.clock,
      ids: deps.ids,
    });
    const assets = new AssetService({
      identity: deps,
      properties: propertyRepo,
      assets: assetRepo,
      storage,
      scanner: new PassthroughMalwareScanner(),
      images: new SharpImageProcessor(),
      clock: deps.clock,
      ids: deps.ids,
    });
    const property = await properties.create(owner.id, {
      organizationId: organization.id,
      name: "Listing",
      propertyType: "APARTMENT",
      rightsConfirmed: true,
    });
    return { deps, storage, assets, ownerId: owner.id, orgId: organization.id, propertyId: property.id };
  }

  it("uploads a real photo through signed URLs to READY and back out again", async () => {
    const ctx = await setup();
    const photo = await jpegWithMetadata(1600, 1200);

    const { asset, upload } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId: ctx.propertyId,
      originalFilename: "living-room.jpg",
      declaredSizeBytes: photo.byteLength,
    });

    // The signed upload URL authorizes exactly this tenant-scoped key.
    const token = new URL(`http://x${upload.url}`).searchParams.get("token")!;
    const verified = verifyStorageToken(token, SECRET, "upload");
    expect(verified?.key).toBe(asset.storageKey);
    expect(verified?.key.startsWith(`org/${ctx.orgId}/`)).toBe(true);

    await ctx.storage.putObject(asset.storageKey, new Uint8Array(photo));
    const { asset: ready } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);

    expect(ready.status).toBe("READY");
    expect(ready.mimeType).toBe("image/jpeg");
    expect(ready.width).toBe(1200);
    expect(ready.height).toBe(1600);
    expect(ready.perceptualHash).toMatch(/^[0-9a-f]{16}$/);

    // Stored derivatives are real images with metadata stripped.
    const normalized = await ctx.storage.getObject(ready.storageKey);
    expect(sniffMimeType(normalized!)).toBe("image/jpeg");
    expect((await sharp(Buffer.from(normalized!)).metadata()).exif).toBeUndefined();

    const download = await ctx.assets.createDownloadUrl(ctx.ownerId, ctx.orgId, ready.id);
    const dlToken = new URL(`http://x${download.url}`).searchParams.get("token")!;
    expect(verifyStorageToken(dlToken, SECRET, "download")?.key).toBe(ready.storageKey);
    // A download token must not be usable for upload.
    expect(verifyStorageToken(dlToken, SECRET, "upload")).toBeNull();
  });

  it("quarantines an EICAR payload disguised with a JPEG header", async () => {
    const ctx = await setup();
    const { asset } = await ctx.assets.requestUpload(ctx.ownerId, {
      organizationId: ctx.orgId,
      propertyId: ctx.propertyId,
      originalFilename: "bad.jpg",
      declaredSizeBytes: 100,
    });
    const eicar = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
    ]);
    await ctx.storage.putObject(asset.storageKey, new Uint8Array(eicar));
    const { asset: result } = await ctx.assets.completeUpload(ctx.ownerId, ctx.orgId, asset.id);
    expect(result.status).toBe("QUARANTINED");
  });
});
