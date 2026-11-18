import { createHash, randomBytes } from "node:crypto";
import { globalAgent } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { managedCleanMasterKey, managedDeliverableOutputKey, type ObjectRead, type ObjectStorage } from "@app/domain";
import { AppError } from "@app/shared";
import { verifyStorageToken } from "@app/storage";
import {
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
} from "@app/storage/google-cloud-storage";
import { createEmulatorBucket, emulatorEndpoint, emulatorObjectNames } from "./emulator";

/**
 * The Google Cloud Storage adapter against the Cloud Storage emulator
 * (ADR-0156, ADR-0157): the web app's view of the port, as the shared folder's
 * tests hold it. The emulator proves the adapter's logic only: it has no
 * permissions, so what Google answers a caller that may not read or list is
 * not seen here, and it cannot be made to fail partway through an answer, which
 * the stand-in suite holds.
 */

const SECRET = "google-cloud-storage-signing-secret";
const ASSET = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";
const MASTER = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

let endpoint: string;
let store: ObjectStorage;
let bucket: string;

beforeAll(() => {
  endpoint = emulatorEndpoint();
  // The adapter's client honours the proxy variables (ADR-0156 Decision 1); the
  // emulator is on this machine, so none may send the suite's requests elsewhere.
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, "");
});

afterAll(() => {
  vi.unstubAllEnvs();
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
      expect(joined(await chunksOf(await store.readObject(key, null)))).toEqual(bytes(index));
    }
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([...keys].sort());
    for (const key of keys) await store.deleteObject(key);
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });

  it("refuses a key that is not canonical, or one Cloud Storage cannot name, and stores nothing", async () => {
    const longest = `org/${"a".repeat(GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES - 4)}`;
    await store.putObject(longest, bytes(1));
    expect(await store.exists(longest)).toBe(true);
    await store.deleteObject(longest);
    // The limit counts bytes: `é` is two.
    const multibyte = `org/${"é".repeat(510)}`;
    await store.putObject(multibyte, bytes(2));
    expect(await store.exists(multibyte)).toBe(true);
    await store.deleteObject(multibyte);
    for (const key of [
      "",
      "../x",
      "org//x",
      "org/./x",
      "org\\x",
      "org/a\nb",
      "org/a\rb",
      `${longest}a`,
      `${multibyte}é`,
      "org/\uD800x",
    ]) {
      await expect(store.putObject(key, bytes(1))).rejects.toBeInstanceOf(AppError);
      await expect(store.getObject(key)).rejects.toBeInstanceOf(AppError);
      await expect(store.deleteObject(key)).rejects.toBeInstanceOf(AppError);
      await expect(store.exists(key)).rejects.toBeInstanceOf(AppError);
      await expect(store.readObject(key, null)).rejects.toBeInstanceOf(AppError);
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
      () => missing.readObject(ASSET, null),
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

/** Every chunk a read's stream holds, read to its end. */
async function chunksOf(read: ObjectRead): Promise<Uint8Array[]> {
  if (read.kind !== "READ") throw new Error(`expected a read, not ${read.kind}`);
  const reader = read.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function joined(chunks: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks));
}

/** Connections the adapter's client is using now; one left idle for the next request holds nothing. */
const inUse = (): number => Object.values(globalAgent.sockets).reduce((count, list) => count + (list?.length ?? 0), 0);

describe("the web app's streamed read, in Cloud Storage (ADR-0157)", () => {
  const VIDEO = managedDeliverableOutputKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });

  it("reads nothing at a key where nothing is stored", async () => {
    expect(await store.readObject(VIDEO, null)).toEqual({ kind: "ABSENT" });
    expect(await store.readObject(VIDEO, { kind: "FROM", start: 0, end: 1 })).toEqual({ kind: "ABSENT" });
  });

  it("reads the whole object, or the bytes a range names, with the object's size", async () => {
    await store.putObject(VIDEO, bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    const whole = await store.readObject(VIDEO, null);
    expect(whole).toMatchObject({ kind: "READ", size: 10, start: 0, length: 10 });
    expect(joined(await chunksOf(whole))).toEqual(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    const middle = await store.readObject(VIDEO, { kind: "FROM", start: 3, end: 5 });
    expect(middle).toMatchObject({ kind: "READ", size: 10, start: 3, length: 3 });
    expect(joined(await chunksOf(middle))).toEqual(bytes(3, 4, 5));
    const last = await store.readObject(VIDEO, { kind: "LAST", length: 2 });
    expect(last).toMatchObject({ kind: "READ", size: 10, start: 8, length: 2 });
    expect(joined(await chunksOf(last))).toEqual(bytes(8, 9));
    const past = await store.readObject(VIDEO, { kind: "FROM", start: 8, end: 99 });
    expect(joined(await chunksOf(past))).toEqual(bytes(8, 9));
  });

  it("answers a range past the end with the object's size, holding nothing", async () => {
    await store.putObject(VIDEO, bytes(1, 2, 3));
    const before = inUse();
    expect(await store.readObject(VIDEO, { kind: "FROM", start: 3, end: null })).toEqual({
      kind: "UNSATISFIABLE",
      size: 3,
    });
    expect(inUse()).toBeLessThanOrEqual(before);
  });

  it("streams a large object, across the transport's chunks, then holds nothing", async () => {
    const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 5));
    await store.putObject(VIDEO, data);
    const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const before = inUse();
    const whole = await chunksOf(await store.readObject(VIDEO, null));
    expect(whole.length).toBeGreaterThan(1);
    expect(digest(joined(whole))).toBe(digest(data));
    const start = 64 * 1024 - 2;
    const range = await chunksOf(await store.readObject(VIDEO, { kind: "FROM", start, end: start + 3 }));
    expect(joined(range)).toEqual(data.slice(start, start + 4));
    await vi.waitFor(() => expect(inUse()).toBeLessThanOrEqual(before));
  });

  it("lets the object go when the reader stops early", async () => {
    await store.putObject(VIDEO, new Uint8Array(8 * 1024 * 1024));
    const before = inUse();
    const read = await store.readObject(VIDEO, null);
    if (read.kind !== "READ") throw new Error("expected a read");
    expect(inUse()).toBe(before + 1);
    const reader = read.body.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(inUse()).toBe(before));
  });

  it("keeps reading the object it opened when the key is written again", async () => {
    await store.putObject(VIDEO, bytes(1, 2, 3));
    const read = await store.readObject(VIDEO, null);
    await store.putObject(VIDEO, bytes(9, 9, 9, 9));
    expect(joined(await chunksOf(read))).toEqual(bytes(1, 2, 3));
    expect(await store.readObject(VIDEO, null)).toMatchObject({ kind: "READ", size: 4 });
  });

  it("reads an empty object as no bytes, asking for none", async () => {
    await store.putObject(VIDEO, new Uint8Array(0));
    const before = inUse();
    const read = await store.readObject(VIDEO, null);
    expect(read).toMatchObject({ kind: "READ", size: 0, start: 0, length: 0 });
    expect(inUse()).toBeLessThanOrEqual(before);
    expect(await chunksOf(read)).toEqual([]);
    expect(await store.readObject(VIDEO, { kind: "LAST", length: 10 })).toMatchObject({
      kind: "READ",
      size: 0,
      start: 0,
      length: 0,
    });
    expect(await store.readObject(VIDEO, { kind: "FROM", start: 0, end: null })).toEqual({
      kind: "UNSATISFIABLE",
      size: 0,
    });
  });
});
