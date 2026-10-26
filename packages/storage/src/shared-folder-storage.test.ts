/**
 * The shared storage folder (ADR-0085), against real files in a fresh folder
 * per test: its whole claim is about what is on disk, what a second process
 * opening the same folder sees, and what is never written.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { chown, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managedCleanMasterKey,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  sha256Digest,
  safePositiveByteCount,
} from "@app/domain";
import { AppError } from "@app/shared";
import { createCleanMasterStore } from "./managed-output/clean-master-store";
import {
  createDeliverableCompositionSourceMaterializer,
  createDeliverableOutputPublisher,
} from "./managed-output/deliverable-composition-io";
import { nodeManagedOutputTempFileFactory } from "./managed-output/media-validation";
import { S3ManagedOutputStagingSink, type S3ObjectBody } from "./managed-output/s3-staging-sink";
import { NonProductionAdapterError } from "./production-guard";
import {
  SHARED_FOLDER_READ_CHUNK_BYTES,
  SHARED_FOLDER_STORAGE_BUCKET,
  SharedFolderStorageError,
  createSharedFolderStorage,
  type SharedFolderStorage,
} from "./shared-folder-storage";
import { verifyStorageToken } from "./signing";

const SECRET = "shared-folder-signing-secret";
const BUCKET = SHARED_FOLDER_STORAGE_BUCKET;
const ASSET = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";
const OUTPUT = managedGenerationOutputKey({
  organizationId: "org_1",
  attemptId: "att_1",
});
const MASTER = managedCleanMasterKey({
  organizationId: "org_1",
  deliverableVersionId: "gdv_1",
});
const NOT_CANONICAL = [
  "",
  "../escape",
  "org/../../escape",
  "/escape",
  "org//escape",
  "org/./escape",
  "org/escape/",
  "org\\escape",
  "org/esc\0ape",
];

let base: string;
let root: string;
let store: SharedFolderStorage;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vta-shared-folder-test-"));
  root = join(base, "root");
  store = createSharedFolderStorage({ root, secret: SECRET, nodeEnv: "test" });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);
const target = (key: string) => ({
  bucket: BUCKET,
  key,
  expectedBucketOwner: undefined,
});
const b64 = (data: Uint8Array) => createHash("sha256").update(data).digest("base64");
const hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function drain(body: S3ObjectBody): Promise<{ data: Uint8Array; chunks: number[] }> {
  const chunks: Uint8Array[] = [];
  for (let chunk = await body.read(); chunk !== null; chunk = await body.read()) chunks.push(chunk);
  return {
    data: new Uint8Array(Buffer.concat(chunks)),
    chunks: chunks.map((c) => c.byteLength),
  };
}

async function stored(key: string): Promise<Uint8Array | null> {
  const result = await store.objectClient.getObject(target(key));
  return result.body === null ? null : (await drain(result.body)).data;
}

async function upload(key: string, ...parts: Uint8Array[]) {
  const { uploadId } = await store.objectClient.createMultipartUpload(target(key));
  const refs = [];
  for (const [index, body] of parts.entries()) {
    const checksumSha256Base64 = b64(body);
    const { etag } = await store.objectClient.uploadPart({
      ...target(key),
      uploadId,
      partNumber: index + 1,
      body,
      checksumSha256Base64,
    });
    refs.push({ partNumber: index + 1, etag, checksumSha256Base64 });
  }
  return { uploadId, parts: refs };
}

const complete = (
  key: string,
  uploadId: string,
  parts: readonly {
    partNumber: number;
    etag: string;
    checksumSha256Base64: string;
  }[],
) =>
  store.objectClient.completeMultipartUpload({
    ...target(key),
    uploadId,
    parts,
    ifNoneMatch: "*",
  });

/** The open files below the test's folder, where the platform can list them. */
const PROC_FD = "/proc/self/fd";
function openFilesBelow(dir: string): number {
  return readdirSync(PROC_FD).filter((fd) => {
    try {
      return readlinkSync(join(PROC_FD, fd)).startsWith(dir);
    } catch {
      return false;
    }
  }).length;
}

/** What a call rejected with, as an `AppError`'s message. */
async function appRefusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).message;
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ status: number; name: string; message: string }> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SharedFolderStorageError);
  const refused = error as SharedFolderStorageError;
  return {
    status: refused.$metadata.httpStatusCode,
    name: refused.name,
    message: refused.message,
  };
}

describe("opening the folder", () => {
  it("is refused in production, with no escape hatch, and creates nothing", async () => {
    expect(() =>
      createSharedFolderStorage({
        root: join(base, "prod"),
        secret: SECRET,
        nodeEnv: "production",
      }),
    ).toThrow(NonProductionAdapterError);
    expect(await readdir(base)).toEqual(["root"]);
  });

  it("is refused when the process runs in production, whatever it is told", async () => {
    const ambient = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        createSharedFolderStorage({ root: join(base, "prod"), secret: SECRET, nodeEnv: "test" }),
      ).toThrow(NonProductionAdapterError);
    } finally {
      process.env.NODE_ENV = ambient;
    }
    expect(await readdir(base)).toEqual(["root"]);
  });

  it("needs an absolute folder, so every process names the same one", async () => {
    const relative = `vta-relative-${process.pid}`;
    let error: unknown;
    try {
      createSharedFolderStorage({ root: `${relative}/storage`, secret: SECRET, nodeEnv: "test" });
    } catch (e) {
      error = e;
    } finally {
      // Refused before anything is made, so this finds nothing to remove.
      expect(existsSync(resolve(relative))).toBe(false);
      await rm(resolve(relative), { recursive: true, force: true });
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("CONFIGURATION_ERROR");
    expect((error as AppError).message).not.toContain("relative");
  });

  it("creates the folder with its objects, uploads and staging areas", async () => {
    expect((await readdir(root)).sort()).toEqual(["objects", "staging", "uploads"]);
  });

  it("names neither the folder nor the path when it cannot open it", async () => {
    await writeFile(join(base, "file"), "");
    let error: unknown;
    try {
      createSharedFolderStorage({ root: join(base, "file", "root"), secret: SECRET });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("CONFIGURATION_ERROR");
    expect((error as AppError).message).toBe(
      "The shared storage folder could not be opened (ENOTDIR)",
    );
  });

  it("adopts only real folders, never a link to one somewhere else", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    const linked = join(base, "linked");
    await mkdir(linked);
    await symlink(elsewhere, join(linked, "objects"));
    expect(() => createSharedFolderStorage({ root: linked, secret: SECRET })).toThrow(
      "The shared storage folder could not be opened (FOLDER_NOT_PRIVATE)",
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it.runIf(process.getuid?.() === 0)("adopts only folders this user owns", async () => {
    const theirs = join(base, "theirs");
    await mkdir(theirs);
    await chown(theirs, 65534, 65534);
    expect(() => createSharedFolderStorage({ root: theirs, secret: SECRET })).toThrow(
      "The shared storage folder could not be opened (FOLDER_NOT_PRIVATE)",
    );
  });

  it("keeps every folder and every object readable by this user alone", async () => {
    const chmodded = join(base, "open");
    await mkdir(chmodded, { mode: 0o755 });
    const opened = createSharedFolderStorage({ root: chmodded, secret: SECRET });
    await opened.objectStorage.putObject(ASSET, bytes(1));
    const local = join(base, "local");
    await writeFile(local, bytes(2), { mode: 0o644 });
    await opened.objectClient.putObjectIfAbsent({
      ...target(MASTER),
      localPath: local,
      contentType: "video/mp4",
    });
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    for (const dir of ["", "objects", "staging", "uploads", "objects/org/org_1"]) {
      expect(await mode(join(chmodded, dir))).toBe(0o700);
    }
    expect(await mode(join(chmodded, "objects", ASSET))).toBe(0o600);
    expect(await mode(join(chmodded, "objects", MASTER))).toBe(0o600);
  });
});

describe("the web app's view", () => {
  it("stores, reads, checks and deletes an object", async () => {
    const view = store.objectStorage;
    expect(await view.getObject(ASSET)).toBeNull();
    expect(await view.exists(ASSET)).toBe(false);
    await view.putObject(ASSET, bytes(1, 2, 3));
    expect(await view.getObject(ASSET)).toEqual(bytes(1, 2, 3));
    expect(await view.exists(ASSET)).toBe(true);
    await view.putObject(ASSET, bytes(9));
    expect(await view.getObject(ASSET)).toEqual(bytes(9));
    await view.deleteObject(ASSET);
    await view.deleteObject(ASSET);
    expect(await view.getObject(ASSET)).toBeNull();
    expect(await view.exists(ASSET)).toBe(false);
  });

  it("keeps its own copy of what it stores and hands out copies", async () => {
    const data = bytes(1, 2, 3);
    await store.objectStorage.putObject(ASSET, data);
    data[0] = 7;
    const read = await store.objectStorage.getObject(ASSET);
    read![1] = 7;
    expect(await store.objectStorage.getObject(ASSET)).toEqual(bytes(1, 2, 3));
  });

  it("is seen by a second store opening the same folder, and by no other folder", async () => {
    await store.objectStorage.putObject(ASSET, bytes(4, 5));
    const again = createSharedFolderStorage({
      root,
      secret: SECRET,
      nodeEnv: "test",
    });
    expect(await again.objectStorage.getObject(ASSET)).toEqual(bytes(4, 5));
    const other = createSharedFolderStorage({
      root: join(base, "other"),
      secret: SECRET,
      nodeEnv: "test",
    });
    expect(await other.objectStorage.exists(ASSET)).toBe(false);
  });

  it("does not count a folder of other keys as an object", async () => {
    await store.objectStorage.putObject(ASSET, bytes(1));
    const folder = "org/org_1/properties/prp_1";
    expect(await store.objectStorage.exists(folder)).toBe(false);
    expect(await store.objectStorage.getObject(folder)).toBeNull();
    expect(await stored(folder)).toBeNull();
    await store.objectStorage.deleteObject(folder);
    expect(await store.objectStorage.exists(ASSET)).toBe(true);
  });

  it("finds nothing below a stored object", async () => {
    await store.objectStorage.putObject(ASSET, bytes(1));
    const below = `${ASSET}/below`;
    expect(await store.objectStorage.exists(below)).toBe(false);
    expect(await store.objectStorage.getObject(below)).toBeNull();
    expect(await stored(below)).toBeNull();
    await store.objectStorage.deleteObject(below);
  });

  it("refuses a key the file system cannot name, rather than calling it absent", async () => {
    // Canonical, but one segment longer than any file name may be, below a
    // folder that exists, so the file system reaches that segment.
    await store.objectStorage.putObject(ASSET, bytes(1));
    const long = `org/org_1/${"x".repeat(300)}`;
    const error: unknown = await store.objectStorage.getObject(long).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe(
      "The shared storage folder could not read an object (ENAMETOOLONG)",
    );
    expect(await refusal(store.objectClient.getObject(target(long)))).toEqual({
      status: 500,
      name: "InternalError",
      message: "InternalError (ENAMETOOLONG)",
    });
  });

  it("refuses a key that is not canonical, and writes nothing outside the folder", async () => {
    for (const key of NOT_CANONICAL) {
      for (const call of [
        () => store.objectStorage.putObject(key, bytes(1)),
        () => store.objectStorage.getObject(key),
        () => store.objectStorage.exists(key),
        () => store.objectStorage.deleteObject(key),
      ]) {
        const error: unknown = await call().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("INTERNAL_ERROR");
      }
    }
    expect(await readdir(base)).toEqual(["root"]);
    expect((await readdir(root)).sort()).toEqual(["objects", "staging", "uploads"]);
    expect(await readdir(join(root, "objects"))).toEqual([]);
  });

  it("refuses what is at a key but is no object, rather than calling it absent", async () => {
    await mkdir(join(root, "objects", "org", "org_1"), { recursive: true });
    const device = "org/org_1/device";
    await symlink("/dev/null", join(root, "objects", device));
    expect(await appRefusal(store.objectStorage.getObject(device))).toBe(
      "The shared storage folder could not read an object (NOT_AN_OBJECT)",
    );
    expect(await appRefusal(store.objectStorage.exists(device))).toBe(
      "The shared storage folder could not check an object (NOT_AN_OBJECT)",
    );
    expect((await refusal(store.objectClient.getObject(target(device)))).message).toBe(
      "InternalError (NOT_AN_OBJECT)",
    );
    if (!existsSync("/usr/bin/mkfifo")) return;
    // A pipe would hang a blocking open; this one is refused at once.
    const pipe = "org/org_1/pipe";
    execFileSync("/usr/bin/mkfifo", [join(root, "objects", pipe)]);
    expect((await refusal(store.objectClient.getObject(target(pipe)))).message).toBe(
      "InternalError (NOT_AN_OBJECT)",
    );
  });

  it("calls nothing absent once the objects folder itself is gone", async () => {
    await store.objectStorage.putObject(ASSET, bytes(1));
    await rm(join(root, "objects"), { recursive: true });
    for (const read of [
      () => store.objectStorage.getObject(ASSET),
      () => store.objectStorage.getObject(OUTPUT),
    ]) {
      expect(await appRefusal(read())).toBe(
        "The shared storage folder could not read an object (FOLDER_MISSING)",
      );
    }
    expect(await appRefusal(store.objectStorage.exists(ASSET))).toBe(
      "The shared storage folder could not check an object (FOLDER_MISSING)",
    );
    expect((await refusal(store.objectClient.getObject(target(OUTPUT)))).message).toBe(
      "InternalError (FOLDER_MISSING)",
    );
    // Nor once another folder stands in its place, empty as it is.
    await mkdir(join(root, "objects"));
    expect(await appRefusal(store.objectStorage.exists(ASSET))).toBe(
      "The shared storage folder could not check an object (FOLDER_MISSING)",
    );
    expect((await refusal(store.objectClient.getObject(target(ASSET)))).message).toBe(
      "InternalError (FOLDER_MISSING)",
    );
  });

  it("signs URLs as every store does, and never for an internal key", async () => {
    const upload = await store.objectStorage.createSignedUploadUrl(ASSET, 60);
    const download = await store.objectStorage.createSignedDownloadUrl(ASSET, 60);
    expect(upload.url.startsWith("/api/storage/upload?token=")).toBe(true);
    const token = (url: string) => decodeURIComponent(url.split("token=")[1]!);
    expect(verifyStorageToken(token(upload.url), SECRET, "upload")?.key).toBe(ASSET);
    expect(verifyStorageToken(token(download.url), SECRET, "download")?.key).toBe(ASSET);
    await expect(store.objectStorage.createSignedUploadUrl(MASTER, 60)).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(store.objectStorage.createSignedDownloadUrl(MASTER, 60)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("leaves no staged file behind", async () => {
    await store.objectStorage.putObject(ASSET, bytes(1));
    await store.objectStorage.putObject(ASSET, bytes(2));
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });
});

describe("the worker's view", () => {
  it("reports a missing key as the seam's one absence", async () => {
    expect(await store.objectClient.getObject(target(OUTPUT))).toEqual({
      contentLength: null,
      body: null,
    });
  });

  it("streams a stored object in bounded chunks and then ends", async () => {
    const data = new Uint8Array(2.5 * SHARED_FOLDER_READ_CHUNK_BYTES).map((_, i) => i % 251);
    await store.objectStorage.putObject(OUTPUT, data);
    const result = await store.objectClient.getObject(target(OUTPUT));
    expect(result.contentLength).toBe(data.byteLength);
    const read = await drain(result.body!);
    // By digest: element-wise equality over megabytes is slow and says no more.
    expect(hex(read.data)).toBe(hex(data));
    expect(read.chunks).toEqual([1, 1, 0.5].map((n) => n * SHARED_FOLDER_READ_CHUNK_BYTES));
    expect(await result.body!.read()).toBeNull();
  });

  it("refuses a read after the body is cancelled", async () => {
    await store.objectStorage.putObject(OUTPUT, bytes(1, 2));
    const { body } = await store.objectClient.getObject(target(OUTPUT));
    await body!.cancel();
    await body!.cancel();
    expect((await refusal(body!.read())).status).toBe(500);
  });

  it("refuses another bucket, an owner check and a key that is not canonical", async () => {
    const get = (input: { bucket: string; key: string; expectedBucketOwner: string | undefined }) =>
      refusal(store.objectClient.getObject(input));
    expect((await get({ ...target(OUTPUT), bucket: "other" })).status).toBe(404);
    expect((await get({ ...target(OUTPUT), expectedBucketOwner: "123456789012" })).status).toBe(
      403,
    );
    for (const key of NOT_CANONICAL) {
      expect((await get(target(key))).status).toBe(400);
      expect((await refusal(store.objectClient.createMultipartUpload(target(key)))).status).toBe(
        400,
      );
    }
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("publishes a multipart upload only when it completes, in part order", async () => {
    const { uploadId, parts } = await upload(OUTPUT, bytes(1, 2), bytes(3), bytes(4, 5, 6));
    expect(await stored(OUTPUT)).toBeNull();
    expect(await store.objectStorage.exists(OUTPUT)).toBe(false);
    await complete(OUTPUT, uploadId, parts);
    expect(await stored(OUTPUT)).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect(await store.objectStorage.getObject(OUTPUT)).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect(await readdir(join(root, "uploads"))).toEqual([]);
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("lets a part uploaded again replace the first", async () => {
    const { uploadId } = await upload(OUTPUT, bytes(1));
    const body = bytes(2, 2);
    const { etag } = await store.objectClient.uploadPart({
      ...target(OUTPUT),
      uploadId,
      partNumber: 1,
      body,
      checksumSha256Base64: b64(body),
    });
    expect(etag).toBe(`"${hex(body)}"`);
    await complete(OUTPUT, uploadId, [{ partNumber: 1, etag, checksumSha256Base64: b64(body) }]);
    expect(await stored(OUTPUT)).toEqual(bytes(2, 2));
  });

  it("refuses a part whose checksum or number is wrong", async () => {
    const { uploadId } = await upload(OUTPUT);
    const part = (partNumber: number, checksumSha256Base64: string) =>
      refusal(
        store.objectClient.uploadPart({
          ...target(OUTPUT),
          uploadId,
          partNumber,
          body: bytes(1),
          checksumSha256Base64,
        }),
      );
    expect(await part(1, b64(bytes(2)))).toMatchObject({
      status: 400,
      name: "BadDigest",
    });
    for (const partNumber of [0, 10_001, 1.5]) {
      expect((await part(partNumber, b64(bytes(1)))).status).toBe(400);
    }
  });

  it("refuses a completion it cannot prove, and publishes nothing", async () => {
    const { uploadId, parts } = await upload(OUTPUT, bytes(1), bytes(2));
    const [first, second] = parts as [(typeof parts)[0], (typeof parts)[0]];
    const refused = async (
      input: Parameters<typeof store.objectClient.completeMultipartUpload>[0],
    ) => (await refusal(store.objectClient.completeMultipartUpload(input))).status;
    const base = { ...target(OUTPUT), uploadId, parts, ifNoneMatch: "*" };
    expect(await refused({ ...base, ifNoneMatch: "" })).toBe(501);
    expect(await refused({ ...base, parts: [] })).toBe(400);
    expect(await refused({ ...base, parts: [second, first] })).toBe(400);
    expect(await refused({ ...base, parts: [first, { ...second, partNumber: 3 }] })).toBe(400);
    expect(
      await refused({
        ...base,
        parts: [first, { ...second, etag: first.etag }],
      }),
    ).toBe(400);
    expect(
      await refused({
        ...base,
        parts: [first, { ...second, checksumSha256Base64: first.checksumSha256Base64 }],
      }),
    ).toBe(400);
    expect(await stored(OUTPUT)).toBeNull();
    await complete(OUTPUT, uploadId, parts);
    expect(await stored(OUTPUT)).toEqual(bytes(1, 2));
  });

  it("lets the first completion win and refuses the second with a 412", async () => {
    const first = await upload(OUTPUT, bytes(1));
    const second = await upload(OUTPUT, bytes(2));
    await complete(OUTPUT, first.uploadId, first.parts);
    expect(await refusal(complete(OUTPUT, second.uploadId, second.parts))).toMatchObject({
      status: 412,
      name: "PreconditionFailed",
    });
    expect(await stored(OUTPUT)).toEqual(bytes(1));
    expect(await readdir(join(root, "uploads"))).toEqual([second.uploadId]);
    await store.objectClient.abortMultipartUpload({
      ...target(OUTPUT),
      uploadId: second.uploadId,
    });
    await store.objectClient.abortMultipartUpload({
      ...target(OUTPUT),
      uploadId: second.uploadId,
    });
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("lets exactly one of two racing completions publish", async () => {
    const first = await upload(OUTPUT, bytes(1));
    const second = await upload(OUTPUT, bytes(2));
    const results = await Promise.allSettled([
      complete(OUTPUT, first.uploadId, first.parts),
      complete(OUTPUT, second.uploadId, second.parts),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as SharedFolderStorageError).$metadata.httpStatusCode).toBe(412);
    const winner = results[0]!.status === "fulfilled" ? bytes(1) : bytes(2);
    expect(await stored(OUTPUT)).toEqual(winner);
  });

  it("only knows the uploads it issued, for the key it issued them for", async () => {
    const { uploadId, parts } = await upload(OUTPUT, bytes(1));
    const other = managedGenerationOutputKey({
      organizationId: "org_2",
      attemptId: "att_1",
    });
    for (const id of ["../../objects", "not-an-id", "00000000-0000-4000-8000-000000000000"]) {
      expect((await refusal(complete(OUTPUT, id, parts))).status).toBe(404);
    }
    expect((await refusal(complete(other, uploadId, parts))).status).toBe(404);
    expect(
      (
        await refusal(
          store.objectClient.abortMultipartUpload({
            ...target(other),
            uploadId,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          store.objectClient.abortMultipartUpload({
            ...target(OUTPUT),
            uploadId: "../x",
          }),
        )
      ).status,
    ).toBe(404);
    expect(await readdir(join(root, "uploads"))).toEqual([uploadId]);
  });

  it("stores a local file only where nothing is stored yet", async () => {
    const file = (name: string, data: Uint8Array) =>
      writeFile(join(base, name), data).then(() => join(base, name));
    const put = async (localPath: string) =>
      (
        await store.objectClient.putObjectIfAbsent({
          ...target(MASTER),
          localPath,
          contentType: "video/mp4",
        })
      ).kind;
    expect(await put(await file("a", bytes(1, 1)))).toBe("CREATED");
    expect(await put(await file("b", bytes(2, 2)))).toBe("ALREADY_EXISTS");
    expect(await stored(MASTER)).toEqual(bytes(1, 1));
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("lets exactly one of many racing writers store a file", async () => {
    const paths = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map(async (n) => {
        await writeFile(join(base, `f${n}`), bytes(n));
        return join(base, `f${n}`);
      }),
    );
    const kinds = await Promise.all(
      paths.map((localPath) =>
        store.objectClient.putObjectIfAbsent({
          ...target(MASTER),
          localPath,
          contentType: "video/mp4",
        }),
      ),
    );
    const created = kinds.flatMap((k, i) => (k.kind === "CREATED" ? [i + 1] : []));
    expect(created).toHaveLength(1);
    expect(await stored(MASTER)).toEqual(bytes(created[0]!));
  });

  it("names no key and no folder when the file system fails", async () => {
    const refused = await refusal(
      store.objectClient.putObjectIfAbsent({
        ...target(MASTER),
        localPath: join(base, "missing"),
        contentType: "video/mp4",
      }),
    );
    expect(refused).toEqual({
      status: 500,
      name: "InternalError",
      message: "InternalError (ENOENT)",
    });
    expect(await stored(MASTER)).toBeNull();
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it.runIf(existsSync(PROC_FD))("leaves no file open, however a read ends", async () => {
    await store.objectStorage.putObject(OUTPUT, bytes(1, 2, 3));
    await mkdir(join(root, "objects", "org", "org_1"), { recursive: true });
    await symlink("/dev/null", join(root, "objects", "org", "org_1", "device"));
    const { uploadId, parts } = await upload(MASTER, bytes(1), bytes(2));
    const before = openFilesBelow(base);

    const ended = await store.objectClient.getObject(target(OUTPUT));
    await drain(ended.body!);
    const cancelled = await store.objectClient.getObject(target(OUTPUT));
    await cancelled.body!.read();
    await cancelled.body!.cancel();
    await store.objectStorage.getObject(OUTPUT);
    await store.objectStorage.getObject("org/org_1");
    await refusal(store.objectClient.getObject(target("org/org_1/device")));
    const [first, second] = parts as [(typeof parts)[0], (typeof parts)[0]];
    await refusal(complete(MASTER, uploadId, [first, { ...second, etag: first.etag }]));
    await complete(MASTER, uploadId, parts);

    expect(openFilesBelow(base)).toBe(before);
  });
});

describe("the worker's existing seams, over the folder", () => {
  it("lets the S3 staging sink publish first-wins and read the winner back", async () => {
    const sink = new S3ManagedOutputStagingSink({ bucket: BUCKET }, { client: store.objectClient });
    const receipt = (data: Uint8Array) => ({
      sha256: sha256Digest(hex(data)),
      sizeBytes: safePositiveByteCount(data.byteLength),
    });

    const first = await sink.begin({ destinationKey: OUTPUT });
    await first.write(bytes(1, 2));
    await first.write(bytes(3));
    expect(await first.commit({ receipt: receipt(bytes(1, 2, 3)) })).toEqual({
      kind: "PUBLISHED",
    });

    const second = await sink.begin({ destinationKey: OUTPUT });
    await second.write(bytes(9));
    expect(await second.commit({ receipt: receipt(bytes(9)) })).toEqual({
      kind: "EXISTING",
      receipt: receipt(bytes(1, 2, 3)),
    });
    expect(await store.objectStorage.getObject(OUTPUT)).toEqual(bytes(1, 2, 3));
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("lets the S3 staging sink publish an object of several parts", async () => {
    const partSizeBytes = 5 * 1024 * 1024;
    const sink = new S3ManagedOutputStagingSink(
      { bucket: BUCKET, partSizeBytes },
      { client: store.objectClient },
    );
    const data = new Uint8Array(2 * partSizeBytes + 7).map((_, i) => i % 253);
    const staged = await sink.begin({ destinationKey: OUTPUT });
    for (let at = 0; at < data.byteLength; at += SHARED_FOLDER_READ_CHUNK_BYTES) {
      await staged.write(data.subarray(at, at + SHARED_FOLDER_READ_CHUNK_BYTES));
    }
    const receipt = {
      sha256: sha256Digest(hex(data)),
      sizeBytes: safePositiveByteCount(data.byteLength),
    };
    expect(await staged.commit({ receipt })).toEqual({ kind: "PUBLISHED" });
    const result = await store.objectClient.getObject(target(OUTPUT));
    expect(result.contentLength).toBe(data.byteLength);
    expect(hex((await drain(result.body!)).data)).toBe(hex(data));
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("lets composition read its sources and publish the video first-wins", async () => {
    const io = { client: store.objectClient, tempFiles: nodeManagedOutputTempFileFactory };
    const scene = bytes(7, 7, 7);
    await store.objectStorage.putObject(OUTPUT, scene);
    const materialized = await createDeliverableCompositionSourceMaterializer(io, {
      bucket: BUCKET,
    }).materialize({
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
      const publisher = createDeliverableOutputPublisher(io, { bucket: BUCKET });
      const key = managedDeliverableOutputKey({
        organizationId: "org_1",
        deliverableVersionId: "gdv_1",
      });
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

  it("lets the Clean Master store publish and copy back what is stored, which no URL reaches", async () => {
    const masters = createCleanMasterStore(
      {
        client: store.objectClient,
        tempFiles: nodeManagedOutputTempFileFactory,
      },
      { bucket: BUCKET },
    );
    const master = bytes(5, 6, 7, 8);
    const localPath = join(base, "encoded.mp4");
    await writeFile(localPath, master);
    const published = await masters.publish({ key: MASTER, localPath });
    expect(published.kind).toBe("COPIED");
    if (published.kind !== "COPIED") return;
    expect(published.copy.sha256).toBe(hex(master));
    await published.copy.release();
    expect(await masters.probe({ key: MASTER })).toEqual({
      kind: "STORED",
      sha256: hex(master),
      sizeBytes: master.byteLength,
    });
    await expect(store.objectStorage.createSignedDownloadUrl(MASTER, 60)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("hands the worker a photo the web app stored", async () => {
    await store.objectStorage.putObject(ASSET, bytes(3, 1, 4));
    const worker = createSharedFolderStorage({
      root,
      secret: SECRET,
      nodeEnv: "test",
    });
    const result = await worker.objectClient.getObject(target(ASSET));
    expect((await drain(result.body!)).data).toEqual(bytes(3, 1, 4));
  });
});

describe("where it is opened", () => {
  it("is opened in production code only by the web app's wiring", () => {
    // The worker's side is opened by the pipeline command (GS-9), which adds
    // itself here. Anything else that opens the folder gets that review too.
    const repo = join(__dirname, "..", "..", "..");
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === "node_modules" || name === ".next" || name === "dist") return [];
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const openers = ["packages", "apps"]
      .flatMap((root) => sources(join(repo, root)))
      .filter((file) => readFileSync(file, "utf8").includes("createSharedFolderStorage("))
      .map((file) => file.slice(repo.length + 1));
    expect(openers.sort()).toEqual([
      "apps/web/src/lib/property.ts",
      "packages/storage/src/shared-folder-storage.ts",
    ]);
  });
});
