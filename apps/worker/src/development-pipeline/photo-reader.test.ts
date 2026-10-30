import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSharedFolderStorage, type SharedFolderStorage } from "@app/storage";
import { createSharedFolderPhotoReader } from "./photo-reader";

const BASE = "https://development.invalid/api/storage";
const SECRET = "photo-reader-signing-secret-0123456789";
const KEY = "org/org_reader/properties/prp_reader/assets/ast_reader/normalized.jpg";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let dir: string;
let storage: SharedFolderStorage;

function folder(options: { secret?: string; basePath?: string; now?: () => Date } = {}): SharedFolderStorage {
  return createSharedFolderStorage({ root: join(dir, "shared"), secret: SECRET, basePath: BASE, ...options });
}

const reader = () => createSharedFolderPhotoReader({ base: BASE, secret: SECRET, storage: storage.objectStorage });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "photo-reader-"));
  storage = folder();
  await storage.objectStorage.putObject(KEY, PHOTO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the development pipeline's photo reader", () => {
  it("reads the photo behind a download URL the shared folder signed under the base", async () => {
    const signed = await storage.objectStorage.createSignedDownloadUrl(KEY, 300);
    expect(signed.url.startsWith(`${BASE}/download?token=`)).toBe(true);
    expect(await reader().read(signed.url)).toEqual(PHOTO);
  });

  it("reads nothing for a key with nothing stored", async () => {
    const signed = await storage.objectStorage.createSignedDownloadUrl(`${KEY}.missing`, 300);
    expect(await reader().read(signed.url)).toBeNull();
  });

  it("reads nothing for a token it did not sign, an upload token or an expired one", async () => {
    const other = await folder({ secret: "another-signing-secret-0123456789" }).objectStorage.createSignedDownloadUrl(
      KEY,
      300,
    );
    // Under the download path, so only the token's purpose can refuse it.
    const upload = await storage.objectStorage.createSignedUploadUrl(KEY, 300);
    const uploadAsDownload = `${BASE}/download${upload.url.slice(upload.url.indexOf("?"))}`;
    const expired = await folder({ now: () => new Date(Date.now() - 3_600_000) }).objectStorage.createSignedDownloadUrl(
      KEY,
      300,
    );
    for (const url of [other.url, uploadAsDownload, expired.url]) {
      expect(await reader().read(url)).toBeNull();
    }
  });

  it("reads nothing for a URL outside its base, or with no token", async () => {
    const { url } = await storage.objectStorage.createSignedDownloadUrl(KEY, 300);
    const query = url.slice(url.indexOf("?"));
    for (const elsewhere of [
      `https://example.com/api/storage/download${query}`,
      `http://development.invalid/api/storage/download${query}`,
      `${BASE}/upload${query}`,
      `${BASE}/download/extra${query}`,
      `/api/storage/download${query}`,
      `${BASE}/download`,
      `${BASE}/download?other=1`,
      "not a url",
    ]) {
      expect(await reader().read(elsewhere)).toBeNull();
    }
  });
});
