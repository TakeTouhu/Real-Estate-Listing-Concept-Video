import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  AssetService,
  AuthService,
  DEFAULT_UPLOAD_LIMITS,
  OrganizationService,
  PropertyService,
  sniffMimeType,
} from "@app/domain";
import { createTestDeps, InMemoryMediaAssetRepository, InMemoryPropertyRepository } from "@app/domain/testing";
import { LocalObjectStorage, SharpImageProcessor, createClamAvScanner } from "@app/storage";
import { clamAvTestPort, EICAR, plainPng, storedZip } from "./clamav";

/** Read as the file loads, so a run without the daemon's port fails before any test runs. */
const PORT = clamAvTestPort();
const scanner = (port = PORT) => createClamAvScanner({ host: "127.0.0.1", port });
/** A clean photo: the PNG, or the JPEG the upload's own image processing makes of it. */
const photo = async (format: "jpeg" | "png"): Promise<Buffer> =>
  format === "png" ? plainPng() : Buffer.from((await new SharpImageProcessor().process(plainPng())).normalized);

/** A port on this machine nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** The ClamAV adapter against a real daemon (ADR-0163). */
describe("the ClamAV scanner against a daemon", () => {
  it("passes clean photos and finds the EICAR test file", async () => {
    expect(await scanner().scan(new Uint8Array(await photo("jpeg")))).toEqual({ verdict: "CLEAN" });
    expect(await scanner().scan(new Uint8Array(await photo("png")))).toEqual({ verdict: "CLEAN" });
    expect(await scanner().scan(new Uint8Array(EICAR))).toEqual({ verdict: "INFECTED" });
  });

  it("finds the test file in a ZIP behind a real JPEG, which the type check takes for a photo", async () => {
    const disguised = Buffer.concat([await photo("jpeg"), storedZip("eicar.com", EICAR)]);
    expect(sniffMimeType(disguised)).toBe("image/jpeg");
    expect(await scanner().scan(new Uint8Array(disguised))).toEqual({ verdict: "INFECTED" });
  });

  it("finds the test file at the end of a photo as large as an upload may be", async () => {
    const head = await photo("jpeg");
    const zip = storedZip("eicar.com", EICAR);
    const limit = DEFAULT_UPLOAD_LIMITS.maxFileSizeBytes;
    const large = Buffer.concat([head, randomBytes(limit - head.length - zip.length), zip]);
    expect(large.length).toBe(limit);
    expect(await scanner().scan(new Uint8Array(large))).toEqual({ verdict: "INFECTED" });
  });

  it("fails a photo longer than the daemon reads, never passing it", async () => {
    // One byte past the daemon's own 100 MiB StreamMaxLength. Its refusal and the connection's reset race, so only
    // the verdict is checked.
    const over = new Uint8Array(100 * 1024 * 1024 + 1);
    expect((await scanner().scan(over)).verdict).toBe("SCAN_FAILED");
  });

  it("fails a scan no daemon answers, by the transport's code", async () => {
    expect(await scanner(await closedPort()).scan(new Uint8Array(EICAR))).toEqual({
      verdict: "SCAN_FAILED",
      detail: "ECONNREFUSED",
    });
  });
});

describe("an upload scanned by the daemon", () => {
  async function upload(bytes: Buffer, port: number) {
    const deps = createTestDeps();
    const owner = await new AuthService(deps, { sessionTtlSeconds: 3600 }).register({
      email: "o@example.com",
      name: "O",
      password: "password-123456",
    });
    const { organization } = await new OrganizationService(deps).createOrganization(owner.id, { name: "Org" });
    const storage = new LocalObjectStorage({ secret: "integration-storage-secret-1234" });
    const properties = new InMemoryPropertyRepository(deps.clock, deps.repos);
    const assetRepo = new InMemoryMediaAssetRepository(deps.clock);
    const property = await new PropertyService({
      identity: deps,
      properties,
      assets: assetRepo,
      clock: deps.clock,
      ids: deps.ids,
    }).create(owner.id, {
      organizationId: organization.id,
      name: "Listing",
      propertyType: "APARTMENT",
      rightsConfirmed: true,
    });
    const assets = new AssetService({
      identity: deps,
      properties,
      assets: assetRepo,
      storage,
      scanner: scanner(port),
      images: new SharpImageProcessor(),
      clock: deps.clock,
      ids: deps.ids,
    });
    const { asset } = await assets.requestUpload(owner.id, {
      organizationId: organization.id,
      propertyId: property.id,
      originalFilename: "room.jpg",
      declaredSizeBytes: bytes.length,
    });
    await storage.putObject(asset.storageKey, new Uint8Array(bytes));
    return (await assets.completeUpload(owner.id, organization.id, asset.id)).asset;
  }

  it("is READY when clean, QUARANTINED when the daemon finds something, and FAILED when none answers", async () => {
    const clean = await photo("jpeg");
    expect((await upload(clean, PORT)).status).toBe("READY");
    const disguised = Buffer.concat([clean, storedZip("eicar.com", EICAR)]);
    expect((await upload(disguised, PORT)).status).toBe("QUARANTINED");
    const failed = await upload(clean, await closedPort());
    expect([failed.status, failed.failureReason]).toEqual(["FAILED", "Malware scan could not be completed"]);
  });
});
