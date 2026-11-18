import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { managedCleanMasterKey } from "@app/domain";
import { AppError } from "@app/shared";
import { verifyStorageToken } from "@app/storage";
import {
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
  type GoogleCloudStorageObjects,
} from "@app/storage/google-cloud-storage";
import { createEmulatorBucket, emulatorEndpoint, emulatorObjectNames } from "./emulator";

/**
 * The Google Cloud Storage adapter against the Cloud Storage emulator
 * (ADR-0156): the web app's view of the port, as the shared folder's tests
 * hold it, except the streamed read. The emulator proves the adapter's logic
 * only: it has no permissions, so what Google answers a caller that may not
 * read or list is not seen here.
 */

const SECRET = "google-cloud-storage-signing-secret";
const ASSET = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";
const MASTER = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

let endpoint: string;
let store: GoogleCloudStorageObjects;
let bucket: string;

beforeAll(() => {
  endpoint = emulatorEndpoint();
});

beforeEach(async () => {
  bucket = await createEmulatorBucket(endpoint);
  store = createGoogleCloudStorage({ bucket, endpoint, secret: SECRET });
});

describe("the web app's view, in Cloud Storage", () => {
  it("stores, reads, checks and deletes an object", async () => {
    expect(await store.getObject(ASSET)).toBeNull();
    expect(await store.exists(ASSET)).toBe(false);
    await store.putObject(ASSET, bytes(1, 2, 3));
    expect(await store.getObject(ASSET)).toEqual(bytes(1, 2, 3));
    expect(await store.exists(ASSET)).toBe(true);
    await store.putObject(ASSET, bytes(9));
    expect(await store.getObject(ASSET)).toEqual(bytes(9));
    await store.deleteObject(ASSET);
    await store.deleteObject(ASSET);
    expect(await store.getObject(ASSET)).toBeNull();
    expect(await store.exists(ASSET)).toBe(false);
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });

  it("keeps its own copy of what it stores and hands out copies", async () => {
    const data = bytes(1, 2, 3);
    await store.putObject(ASSET, data);
    data[0] = 7;
    const read = await store.getObject(ASSET);
    read![1] = 7;
    expect(await store.getObject(ASSET)).toEqual(bytes(1, 2, 3));
  });

  it("stores an empty object, and one of several megabytes, byte for byte", async () => {
    await store.putObject(ASSET, new Uint8Array(0));
    expect(await store.exists(ASSET)).toBe(true);
    expect(await store.getObject(ASSET)).toEqual(new Uint8Array(0));
    const large = new Uint8Array(randomBytes(5 * 1024 * 1024 + 7));
    await store.putObject(ASSET, large);
    expect(Buffer.compare(Buffer.from((await store.getObject(ASSET))!), Buffer.from(large))).toBe(0);
  });

  it("finds an object by its whole name, never by a longer one it begins", async () => {
    await store.putObject(`${ASSET}.bak`, bytes(1));
    await store.putObject(`${ASSET}/below`, bytes(2));
    expect(await store.exists(ASSET)).toBe(false);
    expect(await store.getObject(ASSET)).toBeNull();
    await store.deleteObject(ASSET);
    await store.putObject(ASSET, bytes(3));
    expect(await store.exists(ASSET)).toBe(true);
    expect(await store.exists("org/org_1/properties/prp_1/assets/ast_1/normal")).toBe(false);
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([ASSET, `${ASSET}.bak`, `${ASSET}/below`].sort());
  });

  it("names the object it was given when a key holds characters a URL escapes", async () => {
    const keys = [
      "org/org_1/a b+c%20d.jpg",
      "org/org_1/q?x=1&y=2#frag",
      "org/org_1/(paren)!*'quote';:@$,=",
      "org/org_1/日本語-é.jpg",
    ];
    for (const [index, key] of keys.entries()) {
      await store.putObject(key, bytes(index));
      expect(await store.exists(key)).toBe(true);
      expect(await store.getObject(key)).toEqual(bytes(index));
    }
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([...keys].sort());
    for (const key of keys) await store.deleteObject(key);
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });

  it("refuses a key that is not canonical, or one Cloud Storage cannot name, and sends nothing", async () => {
    const longest = `org/${"a".repeat(GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES - 4)}`;
    await store.putObject(longest, bytes(1));
    expect(await store.exists(longest)).toBe(true);
    await store.deleteObject(longest);
    for (const key of ["", "../x", "org//x", "org/./x", "org\\x", "org/a\nb", "org/a\rb", `${longest}a`]) {
      await expect(store.putObject(key, bytes(1))).rejects.toBeInstanceOf(AppError);
      await expect(store.getObject(key)).rejects.toBeInstanceOf(AppError);
      await expect(store.deleteObject(key)).rejects.toBeInstanceOf(AppError);
      await expect(store.exists(key)).rejects.toBeInstanceOf(AppError);
    }
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });

  it("calls nothing absent in a bucket that is not there", async () => {
    const missing = createGoogleCloudStorage({ bucket: `${bucket}-missing`, endpoint, secret: SECRET });
    for (const ask of [
      () => missing.exists(ASSET),
      () => missing.getObject(ASSET),
      () => missing.deleteObject(ASSET),
      () => missing.putObject(ASSET, bytes(1)),
    ]) {
      const error = await ask().then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      expect(error).toMatchObject({ code: "STORAGE_BUCKET_MISSING", message: "STORAGE_BUCKET_MISSING" });
    }
  });

  it("signs URLs as every store does, and never for an internal key", async () => {
    const upload = await store.createSignedUploadUrl(ASSET, 60);
    const download = await store.createSignedDownloadUrl(ASSET, 60);
    expect(upload.url.startsWith("/api/storage/upload?token=")).toBe(true);
    expect(download.url.startsWith("/api/storage/download?token=")).toBe(true);
    const token = (url: string) => decodeURIComponent(url.split("token=")[1]!);
    expect(verifyStorageToken(token(upload.url), SECRET, "upload")?.key).toBe(ASSET);
    expect(verifyStorageToken(token(download.url), SECRET, "download")?.key).toBe(ASSET);
    await expect(store.createSignedUploadUrl(MASTER, 60)).rejects.toBeInstanceOf(AppError);
    await expect(store.createSignedDownloadUrl(MASTER, 60)).rejects.toBeInstanceOf(AppError);
    // A download saved under a name carries it, signed (ADR-0118); one without carries none.
    const named = await store.createSignedDownloadUrl(ASSET, 60, { attachmentFilename: "a b.jpg" });
    expect(verifyStorageToken(token(named.url), SECRET, "download")).toMatchObject({
      key: ASSET,
      attachmentFilename: "a b.jpg",
    });
    expect(verifyStorageToken(token(download.url), SECRET, "download")).not.toHaveProperty("attachmentFilename");
    await expect(store.createSignedDownloadUrl(ASSET, 60, { attachmentFilename: "a\nb.jpg" })).rejects.toBeInstanceOf(
      AppError,
    );
    // Signing asks the store nothing.
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });
});
