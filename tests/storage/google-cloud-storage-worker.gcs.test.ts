import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedCleanMasterKey,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
} from "@app/domain";
import { AppError } from "@app/shared";
import {
  S3ManagedOutputMediaValidator,
  createCleanMasterStore,
  createDeliverableCompositionSourceMaterializer,
  createDeliverableOutputPublisher,
  nodeManagedOutputTempFileFactory,
  type S3ObjectBody,
} from "@app/storage";
import {
  createGoogleCloudStorage,
  createGoogleCloudStorageViews,
  type GoogleCloudStorageViews,
} from "@app/storage/google-cloud-storage";
import { createEmulatorBucket, emulatorEndpoint, emulatorObjectNames } from "./emulator";

/**
 * The worker's view of a Cloud Storage bucket against the emulator (ADR-0160):
 * the reads and the first-wins write the worker's managed output makes, held
 * as the shared folder's tests hold them, and the seams that use them. The
 * emulator does not check the MD5 an upload carries, nor any permission; the
 * stand-in suite holds what the adapter sends.
 */

const SECRET = "google-cloud-storage-signing-secret";
const ASSET = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";
const OUTPUT = managedGenerationOutputKey({ organizationId: "org_1", attemptId: "att_1" });
const MASTER = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
const MEBIBYTE = 1024 * 1024;

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

let endpoint: string;
let bucket: string;
let store: GoogleCloudStorageViews;
let folder: string;

beforeAll(() => {
  endpoint = emulatorEndpoint();
  // A proxy that is not there: the adapter's requests go straight to the emulator, never through one (ADR-0158).
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, "http://127.0.0.1:9");
  for (const name of ["NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  bucket = await createEmulatorBucket(endpoint);
  store = createGoogleCloudStorageViews({ bucket, endpoint, secret: SECRET });
  folder = await mkdtemp(join(tmpdir(), "vta-gcs-worker-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const target = (key: string) => ({ bucket, key, expectedBucketOwner: undefined });

/** A local file of `data`, as the worker hands one over. */
async function file(name: string, data: Uint8Array): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, data);
  return path;
}

/** Every byte a body holds, and the size of each chunk it gave. */
async function drain(body: S3ObjectBody): Promise<{ data: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const chunk = await body.read();
    if (chunk === null) return { data: new Uint8Array(Buffer.concat(parts)), chunks: parts.length };
    parts.push(chunk);
  }
}

describe("the worker's view, in Cloud Storage", () => {
  it("reports a missing key as the seam's one absence", async () => {
    expect(await store.objectClient.getObject(target(OUTPUT))).toEqual({ contentLength: null, body: null });
  });

  it("streams a stored object as the worker pulls it, and then ends", async () => {
    const data = randomBytes(3 * MEBIBYTE + 17);
    await store.objectStorage.putObject(OUTPUT, data);
    const result = await store.objectClient.getObject(target(OUTPUT));
    expect(result.contentLength).toBe(data.byteLength);
    const read = await drain(result.body!);
    // By digest: element-wise equality over megabytes is slow and says no more.
    expect(hex(read.data)).toBe(hex(data));
    expect(read.chunks).toBeGreaterThan(1);
    expect(await result.body!.read()).toBeNull();
  });

  it("reads an empty object as one that ends at once", async () => {
    await store.objectStorage.putObject(OUTPUT, new Uint8Array(0));
    const result = await store.objectClient.getObject(target(OUTPUT));
    expect(result.contentLength).toBe(0);
    expect(await result.body!.read()).toBeNull();
  });

  it("refuses a read after the body is cancelled", async () => {
    await store.objectStorage.putObject(OUTPUT, bytes(1, 2));
    const { body } = await store.objectClient.getObject(target(OUTPUT));
    await body!.cancel();
    await body!.cancel();
    await expect(body!.read()).rejects.toMatchObject({ code: "STORAGE_BODY_CANCELLED" });
  });

  it("calls a missing bucket missing, never the object absent", async () => {
    const elsewhere = `vtavision-missing-${randomBytes(6).toString("hex")}`;
    const missing = createGoogleCloudStorageViews({ bucket: elsewhere, endpoint, secret: SECRET });
    const input = { bucket: elsewhere, key: MASTER, expectedBucketOwner: undefined };
    await expect(missing.objectClient.getObject(input)).rejects.toMatchObject({ code: "STORAGE_BUCKET_MISSING" });
    const localPath = await file("master", bytes(1));
    await expect(
      missing.objectClient.putObjectIfAbsent({ ...input, localPath, contentType: "video/mp4" }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_MISSING" });
  });

  it("stores a local file only where nothing is stored yet", async () => {
    const put = async (localPath: string) =>
      (await store.objectClient.putObjectIfAbsent({ ...target(MASTER), localPath, contentType: "video/mp4" })).kind;
    expect(await put(await file("a", bytes(1, 1)))).toBe("CREATED");
    expect(await put(await file("b", bytes(2, 2)))).toBe("ALREADY_EXISTS");
    expect(await store.objectStorage.getObject(MASTER)).toEqual(bytes(1, 1));
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([MASTER]);
  });

  it("stores a large file whole, as it streams it", async () => {
    const data = randomBytes(24 * MEBIBYTE + 5);
    const localPath = await file("large", data);
    expect(
      await store.objectClient.putObjectIfAbsent({ ...target(MASTER), localPath, contentType: "video/mp4" }),
    ).toEqual({ kind: "CREATED" });
    const { contentLength, body } = await store.objectClient.getObject(target(MASTER));
    expect(contentLength).toBe(data.byteLength);
    expect(hex((await drain(body!)).data)).toBe(hex(data));
  });

  it("lets exactly one of many racing writers store a file", async () => {
    const paths = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => file(`f${n}`, bytes(n))));
    const kinds = await Promise.all(
      paths.map((localPath) =>
        store.objectClient.putObjectIfAbsent({ ...target(MASTER), localPath, contentType: "video/mp4" }),
      ),
    );
    const created = kinds.flatMap((k, i) => (k.kind === "CREATED" ? [i + 1] : []));
    expect(created).toHaveLength(1);
    expect(await store.objectStorage.getObject(MASTER)).toEqual(bytes(created[0]!));
  });
});

describe("the worker's existing seams, in Cloud Storage", () => {
  it("lets composition read its sources and publish the video first-wins", async () => {
    const io = { client: store.objectClient, tempFiles: nodeManagedOutputTempFileFactory };
    const scene = bytes(7, 7, 7);
    await store.objectStorage.putObject(OUTPUT, scene);
    const materialized = await createDeliverableCompositionSourceMaterializer(io, { bucket }).materialize({
      organizationId: "org_1",
      scenes: [
        {
          position: 1,
          generationSceneId: "gs_1",
          sceneGenerationAttemptId: "att_1",
          sourceStorageKey: OUTPUT,
          sourceSha256: sha256Digest(hex(scene)),
          sourceSizeBytes: safePositiveByteCount(scene.byteLength),
          durationSeconds: 5,
        },
      ],
    });
    expect(materialized.kind).toBe("MATERIALIZED");
    if (materialized.kind !== "MATERIALIZED") return;
    try {
      expect(new Uint8Array(readFileSync(materialized.sources[0]!.localPath))).toEqual(scene);
      const publisher = createDeliverableOutputPublisher(io, { bucket });
      const key = managedDeliverableOutputKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
      expect(await publisher.probeExistingOutput({ key })).toEqual({ kind: "ABSENT" });
      const video = bytes(8, 8);
      await writeFile(materialized.outputPath, video);
      const receipt = {
        kind: "PUBLISHED",
        sha256: sha256Digest(hex(video)),
        sizeBytes: safePositiveByteCount(video.byteLength),
      };
      expect(await publisher.publish({ key, localPath: materialized.outputPath })).toEqual(receipt);
      await writeFile(materialized.outputPath, bytes(9));
      expect(await publisher.publish({ key, localPath: materialized.outputPath })).toEqual(receipt);
      expect(await publisher.probeExistingOutput({ key })).toEqual(receipt);
      expect(await store.objectStorage.getObject(key)).toEqual(video);
    } finally {
      await materialized.release();
    }
  });

  it("lets media validation read back what is stored, and only that", async () => {
    const data = bytes(4, 4, 4, 4);
    await store.objectStorage.putObject(OUTPUT, data);
    const inspected: Uint8Array[] = [];
    const validator = new S3ManagedOutputMediaValidator(
      { bucket },
      {
        reader: store.objectClient,
        probe: {
          probe: (localPath) => {
            inspected.push(new Uint8Array(readFileSync(localPath)));
            return Promise.resolve({ kind: "INVALID", reason: "CONTAINER_UNSUPPORTED" });
          },
        },
      },
    );
    const receipt = (d: Uint8Array) => ({
      sha256: sha256Digest(hex(d)),
      sizeBytes: safePositiveByteCount(d.byteLength),
    });
    expect(await validator.validate({ destinationKey: OUTPUT, expectedReceipt: receipt(data) })).toEqual({
      kind: "INVALID_MEDIA",
      reason: "CONTAINER_UNSUPPORTED",
    });
    expect(inspected).toEqual([data]);
    expect(await validator.validate({ destinationKey: OUTPUT, expectedReceipt: receipt(bytes(5)) })).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    const missing = managedGenerationOutputKey({ organizationId: "org_1", attemptId: "att_2" });
    expect(await validator.validate({ destinationKey: missing, expectedReceipt: receipt(data) })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
    expect(inspected).toHaveLength(1);
  });

  it("lets the Clean Master store publish and copy back what is stored, which no URL reaches", async () => {
    const masters = createCleanMasterStore(
      { client: store.objectClient, tempFiles: nodeManagedOutputTempFileFactory },
      { bucket },
    );
    const master = bytes(5, 6, 7, 8);
    const published = await masters.publish({ key: MASTER, localPath: await file("encoded.mp4", master) });
    expect(published.kind).toBe("COPIED");
    if (published.kind !== "COPIED") return;
    expect(published.copy.sha256).toBe(hex(master));
    await published.copy.release();
    expect(await masters.probe({ key: MASTER })).toEqual({ kind: "STORED", sha256: hex(master), sizeBytes: 4 });
    await expect(store.objectStorage.createSignedDownloadUrl(MASTER, 60)).rejects.toBeInstanceOf(AppError);
  });

  it("hands the worker a photo the web app stored", async () => {
    await createGoogleCloudStorage({ bucket, endpoint, secret: SECRET }).putObject(ASSET, bytes(3, 1, 4));
    const result = await store.objectClient.getObject(target(ASSET));
    expect((await drain(result.body!)).data).toEqual(bytes(3, 1, 4));
  });
});
