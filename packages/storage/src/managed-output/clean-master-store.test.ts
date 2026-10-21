/**
 * The Clean Master store, against a fake object store and real files on disk.
 *
 * Real files on purpose, as for the materializer: the store's whole claim is
 * that the copy holds exactly the bytes stored at the key and that the receipt
 * describes that copy. Every test runs with its own `TMPDIR`, so what the store
 * leaves behind, or does not, is visible.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CLEAN_MASTER_BYTES,
  MAX_DELIVERABLE_OUTPUT_BYTES,
  managedCleanMasterKey,
  managedDeliverableOutputKey,
  type ManagedCleanMasterKey,
} from "@app/domain";
import { FakeManagedOutputTempFiles, type FakeTempFileOptions } from "../testing/media-fakes";
import {
  CLEAN_MASTER_COPY_FILE_NAME,
  CLEAN_MASTER_DIRECTORY_PREFIX,
  createCleanMasterStore,
} from "./clean-master-store";
import { COMPOSED_FILE_NAME, type DeliverableObjectClient } from "./deliverable-composition-io";
import type { ManagedOutputTempFile } from "./media-validation";
import type { S3GetObjectInput, S3GetObjectResult, S3ObjectBody } from "./s3-staging-sink";

const ORG = "org_1";
const VERSION = "gdv_1";
const BUCKET = "managed-output-bucket";
const OWNER = "123456789012";
const KEY = managedCleanMasterKey({ organizationId: ORG, deliverableVersionId: VERSION });

const MASTER = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const OTHER = new Uint8Array([42, 42, 42]);

function digestOf(...chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * A chunk that reports a byte length it does not hold, so the ceiling can be
 * crossed without a gigabyte in memory. The store counts a chunk before it
 * hashes or writes it, so a chunk past the ceiling is never written. One at
 * the ceiling exactly is hashed as its one real byte, so only its count is
 * asserted.
 */
class CountedOnlyChunk extends Uint8Array {
  constructor(private readonly reported: number) {
    super(1);
  }
  override get byteLength(): number {
    return this.reported;
  }
}

/**
 * The fake temporary files, refusing a counted-only chunk with an error rather
 * than handing Node a length its buffer does not hold, which aborts the test
 * worker. The store never writes one; a change that did fails an assertion.
 */
class GuardedTempFiles extends FakeManagedOutputTempFiles {
  override async openExclusive0600(path: string): Promise<ManagedOutputTempFile> {
    const file = await super.openExclusive0600(path);
    return {
      write: async (data, offset, length) => {
        if (data instanceof CountedOnlyChunk) throw new Error("a counted-only chunk reached a file");
        return file.write(data, offset, length);
      },
      close: () => file.close(),
    };
  }
}

interface StoreOptions {
  readonly objects?: Record<string, readonly (Uint8Array | string)[]>;
  readonly getThrows?: boolean;
  readonly readThrowsAt?: number;
  readonly putThrows?: boolean;
  /** The put reports success and stores nothing. */
  readonly putDrops?: boolean;
}

class FakeStore implements DeliverableObjectClient {
  readonly gets: S3GetObjectInput[] = [];
  readonly puts: { bucket: string; key: string; localPath: string; contentType: string; owner: string | undefined }[] = [];
  readonly stored = new Map<string, readonly (Uint8Array | string)[]>();
  bodies = 0;
  cancels = 0;

  constructor(private readonly options: StoreOptions = {}) {
    for (const [key, chunks] of Object.entries(options.objects ?? {})) this.stored.set(key, chunks);
  }

  async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
    this.gets.push(input);
    if (this.options.getThrows === true) throw new Error("store unreachable at s3://secret-bucket/org_1");
    const chunks = this.stored.get(input.key);
    if (chunks === undefined) return { contentLength: null, body: null };
    let index = 0;
    const body: S3ObjectBody = {
      read: async () => {
        if (this.options.readThrowsAt === index) throw new Error("stream reset");
        const chunk = chunks[index];
        index += 1;
        return (chunk ?? null) as Uint8Array | null;
      },
      cancel: async () => {
        this.cancels += 1;
      },
    };
    this.bodies += 1;
    return { contentLength: null, body };
  }

  async putObjectIfAbsent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly localPath: string;
    readonly contentType: string;
    readonly expectedBucketOwner: string | undefined;
  }): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }> {
    this.puts.push({
      bucket: input.bucket,
      key: input.key,
      localPath: input.localPath,
      contentType: input.contentType,
      owner: input.expectedBucketOwner,
    });
    if (this.options.putThrows === true) throw new Error("put failed");
    if (this.stored.has(input.key)) return { kind: "ALREADY_EXISTS" };
    if (this.options.putDrops !== true) {
      this.stored.set(input.key, [new Uint8Array(await readFile(input.localPath))]);
    }
    return { kind: "CREATED" };
  }
}

let scratch: string;
let temp: string;
let originalTmpdir: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "clean-master-store-"));
  temp = join(scratch, "tmp");
  await mkdir(temp);
  originalTmpdir = process.env["TMPDIR"];
  process.env["TMPDIR"] = temp;
});

afterEach(async () => {
  if (originalTmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = originalTmpdir;
  await rm(scratch, { recursive: true, force: true });
});

function storeFor(client: FakeStore, tempFiles: FakeManagedOutputTempFiles = new GuardedTempFiles()) {
  return createCleanMasterStore(
    { client, tempFiles },
    { bucket: BUCKET, expectedBucketOwner: OWNER },
  );
}

const stored = (chunks: readonly (Uint8Array | string)[]) => new FakeStore({ objects: { [KEY]: chunks } });

/** What the store left in its temporary directory. */
const leftovers = () => readdir(temp);

async function localFile(bytes: Uint8Array): Promise<string> {
  const path = join(scratch, "encoded-master.mp4");
  await writeFile(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------

describe("probe reads the stored master's receipt and writes nothing", () => {
  it("reports the digest and byte count of every stored chunk, from one read of the key", async () => {
    const client = stored([MASTER.slice(0, 4), MASTER.slice(4)]);
    const tempFiles = new GuardedTempFiles();
    const outcome = await storeFor(client, tempFiles).probe({ key: KEY });

    expect(outcome).toEqual({ kind: "STORED", sha256: digestOf(MASTER), sizeBytes: MASTER.byteLength });
    expect(client.gets).toEqual([{ bucket: BUCKET, key: KEY, expectedBucketOwner: OWNER }]);
    expect(tempFiles.openedPaths).toEqual([]);
    expect(await leftovers()).toEqual([]);
    expect(client.cancels).toBe(1);
  });

  it("is absent only when the store says nothing is there", async () => {
    const client = new FakeStore();
    expect(await storeFor(client).probe({ key: KEY })).toEqual({ kind: "ABSENT" });
    expect(client.gets).toHaveLength(1);
  });

  it("is retryable when the key cannot be read, the stream fails, a chunk is not bytes, or nothing is stored", async () => {
    for (const client of [
      new FakeStore({ objects: { [KEY]: [MASTER] }, getThrows: true }),
      new FakeStore({ objects: { [KEY]: [MASTER, MASTER] }, readThrowsAt: 1 }),
      stored([MASTER, "not bytes"]),
      stored([]),
      stored([new Uint8Array(0)]),
    ]) {
      expect(await storeFor(client).probe({ key: KEY })).toEqual({ kind: "RETRYABLE_FAILURE" });
      expect(client.cancels).toBe(client.bodies);
    }
  });

  it("accepts a master of exactly the ceiling and refuses one byte more, without reading further", async () => {
    expect(MAX_CLEAN_MASTER_BYTES).toBe(1_073_741_824);
    expect(MAX_CLEAN_MASTER_BYTES).toBe(2 * MAX_DELIVERABLE_OUTPUT_BYTES);

    const atCeiling = await storeFor(stored([new CountedOnlyChunk(MAX_CLEAN_MASTER_BYTES)])).probe({ key: KEY });
    expect(atCeiling).toMatchObject({ kind: "STORED", sizeBytes: MAX_CLEAN_MASTER_BYTES });

    const over = stored([new CountedOnlyChunk(MAX_CLEAN_MASTER_BYTES), new Uint8Array(1), "never read"]);
    expect(await storeFor(over).probe({ key: KEY })).toEqual({ kind: "TOO_LARGE" });
    expect(over.cancels).toBe(1);
  });
});

describe("fetch copies the stored master to a private file and names the video beside it", () => {
  it("writes exactly the stored bytes, owner-only, with the receipt of what it wrote", async () => {
    const client = stored([MASTER.slice(0, 3), MASTER.slice(3)]);
    const outcome = await storeFor(client).fetch({ key: KEY });

    expect(outcome.kind).toBe("COPIED");
    if (outcome.kind !== "COPIED") return;
    const { copy } = outcome;
    expect(new Uint8Array(await readFile(copy.cleanMasterPath))).toEqual(MASTER);
    expect((await stat(copy.cleanMasterPath)).mode & 0o777).toBe(0o600);
    expect(copy.sha256).toBe(digestOf(MASTER));
    expect(copy.sizeBytes).toBe(MASTER.byteLength);
    expect(client.gets).toEqual([{ bucket: BUCKET, key: KEY, expectedBucketOwner: OWNER }]);
    expect(client.cancels).toBe(1);

    // One private directory, made under the temporary directory, holding the
    // copy and naming the video: fixed names, nothing from the tenant.
    const dir = dirname(copy.cleanMasterPath);
    expect(dirname(dir)).toBe(temp);
    expect(basename(dir).startsWith(CLEAN_MASTER_DIRECTORY_PREFIX)).toBe(true);
    expect(basename(copy.cleanMasterPath)).toBe(CLEAN_MASTER_COPY_FILE_NAME);
    expect(copy.outputPath).toBe(join(dir, COMPOSED_FILE_NAME));
    for (const path of [copy.cleanMasterPath, copy.outputPath]) {
      for (const leak of [ORG, VERSION, BUCKET, "internal", "clean-masters"]) {
        expect(`${path} leaks ${leak}: ${path.slice(temp.length).includes(leak)}`).toBe(`${path} leaks ${leak}: false`);
      }
    }

    // Release removes the copy and anything written as the video, and may be
    // called again.
    await writeFile(copy.outputPath, OTHER);
    await copy.release();
    await copy.release();
    expect(await leftovers()).toEqual([]);
  });

  it("writes every byte through short writes", async () => {
    const tempFiles = new GuardedTempFiles({ writeCaps: [2, 1, 3] });
    const outcome = await storeFor(stored([MASTER]), tempFiles).fetch({ key: KEY });
    if (outcome.kind !== "COPIED") throw new Error("expected a copy");
    expect(new Uint8Array(await readFile(outcome.copy.cleanMasterPath))).toEqual(MASTER);
    expect(outcome.copy.sha256).toBe(digestOf(MASTER));
    await outcome.copy.release();
  });

  it("is absent when nothing is stored, and leaves nothing behind", async () => {
    const tempFiles = new GuardedTempFiles();
    expect(await storeFor(new FakeStore(), tempFiles).fetch({ key: KEY })).toEqual({ kind: "ABSENT" });
    expect(tempFiles.openedPaths).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it("removes its directory on every failure, and never reports a receipt for a copy it could not finish", async () => {
    const cases: { readonly client: FakeStore; readonly files?: FakeTempFileOptions; readonly kind: string }[] = [
      { client: new FakeStore({ objects: { [KEY]: [MASTER] }, getThrows: true }), kind: "RETRYABLE_FAILURE" },
      { client: new FakeStore({ objects: { [KEY]: [MASTER, MASTER] }, readThrowsAt: 1 }), kind: "RETRYABLE_FAILURE" },
      { client: stored([MASTER, "not bytes"]), kind: "RETRYABLE_FAILURE" },
      { client: stored([]), kind: "RETRYABLE_FAILURE" },
      { client: stored([MASTER]), files: { openFails: true }, kind: "RETRYABLE_FAILURE" },
      { client: stored([MASTER]), files: { reportWithoutWriting: { call: 1, bytesWritten: 0 } }, kind: "RETRYABLE_FAILURE" },
      { client: stored([MASTER]), files: { closeFails: true }, kind: "RETRYABLE_FAILURE" },
      { client: stored([MASTER, new CountedOnlyChunk(MAX_CLEAN_MASTER_BYTES)]), kind: "TOO_LARGE" },
    ];
    for (const { client, files, kind } of cases) {
      const tempFiles = new GuardedTempFiles(files);
      const outcome = await storeFor(client, tempFiles).fetch({ key: KEY });
      expect(outcome).toEqual({ kind });
      expect(await leftovers()).toEqual([]);
      // Every file opened is closed once, and every body returned is cancelled:
      // a removed directory does not prove either, since an open descriptor
      // survives `rm`.
      const opened = files?.openFails === true ? 0 : tempFiles.openedPaths.length;
      expect(tempFiles.closeCalls).toBe(opened);
      expect(client.cancels).toBe(client.bodies);
    }
  });

  it("is retryable, and reads nothing, when no private directory can be made", async () => {
    process.env["TMPDIR"] = join(scratch, "no-such-directory");
    const client = stored([MASTER]);
    expect(await storeFor(client).fetch({ key: KEY })).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(client.gets).toHaveLength(0);
  });
});

describe("publish stores first-wins under the internal namespace and copies back what is stored", () => {
  it("stores the encoded master and copies back the stored object", async () => {
    const client = new FakeStore();
    const localPath = await localFile(MASTER);
    const outcome = await storeFor(client).publish({ key: KEY, localPath });

    expect(client.puts).toEqual([
      { bucket: BUCKET, key: KEY, localPath, contentType: "video/mp4", owner: OWNER },
    ]);
    // The copy is read back from the key, never the file the encode wrote.
    expect(client.gets).toEqual([{ bucket: BUCKET, key: KEY, expectedBucketOwner: OWNER }]);
    if (outcome.kind !== "COPIED") throw new Error("expected a copy");
    expect(outcome.copy.cleanMasterPath).not.toBe(localPath);
    expect(new Uint8Array(await readFile(outcome.copy.cleanMasterPath))).toEqual(MASTER);
    expect(outcome.copy).toMatchObject({ sha256: digestOf(MASTER), sizeBytes: MASTER.byteLength });
    await outcome.copy.release();
  });

  it("copies back the master another attempt stored first, never overwriting it", async () => {
    const client = stored([OTHER]);
    const outcome = await storeFor(client).publish({ key: KEY, localPath: await localFile(MASTER) });

    expect(client.puts).toHaveLength(1);
    if (outcome.kind !== "COPIED") throw new Error("expected a copy");
    expect(new Uint8Array(await readFile(outcome.copy.cleanMasterPath))).toEqual(OTHER);
    expect(outcome.copy).toMatchObject({ sha256: digestOf(OTHER), sizeBytes: OTHER.byteLength });
    await outcome.copy.release();
  });

  it("refuses, as a defect, any key outside the internal namespace or not canonical", async () => {
    const client = new FakeStore();
    const localPath = await localFile(MASTER);
    for (const key of [
      managedDeliverableOutputKey({ organizationId: ORG, deliverableVersionId: VERSION }),
      `org/${ORG}/clean-masters/${VERSION}`,
      `org/${ORG}/Internal/clean-masters/${VERSION}`,
      `org/${ORG}/internal/clean-masters/${VERSION}/../../deliverables/${VERSION}/output`,
      `org/${ORG}//internal/clean-masters/${VERSION}`,
    ]) {
      await expect(
        storeFor(client).publish({ key: key as unknown as ManagedCleanMasterKey, localPath }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    }
    expect(client.puts).toHaveLength(0);
    expect(client.gets).toHaveLength(0);
  });

  it("checks the encoded file's size before sending it, and sends nothing over the ceiling", async () => {
    const client = new FakeStore({ putThrows: true });
    const path = join(scratch, "sparse.mp4");
    await writeFile(path, new Uint8Array(0));

    // Sparse, so no gigabyte is written: only its size is read.
    await truncate(path, MAX_CLEAN_MASTER_BYTES + 1);
    expect(await storeFor(client).publish({ key: KEY, localPath: path })).toEqual({ kind: "TOO_LARGE" });
    expect(client.puts).toHaveLength(0);
    // Too large is said only once the key is seen to hold nothing.
    expect(client.gets).toHaveLength(1);

    await truncate(path, MAX_CLEAN_MASTER_BYTES);
    expect(await storeFor(client).publish({ key: KEY, localPath: path })).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(client.puts).toHaveLength(1);
  });

  it("answers an encode over the ceiling with the master already stored, or with what reading it says", async () => {
    const path = join(scratch, "sparse.mp4");
    await writeFile(path, new Uint8Array(0));
    await truncate(path, MAX_CLEAN_MASTER_BYTES + 1);

    const occupied = stored([OTHER]);
    const outcome = await storeFor(occupied).publish({ key: KEY, localPath: path });
    if (outcome.kind !== "COPIED") throw new Error("expected the stored master");
    expect(new Uint8Array(await readFile(outcome.copy.cleanMasterPath))).toEqual(OTHER);
    expect(occupied.puts).toHaveLength(0);
    await outcome.copy.release();

    const unreadable = new FakeStore({ objects: { [KEY]: [OTHER] }, getThrows: true });
    expect(await storeFor(unreadable).publish({ key: KEY, localPath: path })).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(unreadable.puts).toHaveLength(0);
    expect(await leftovers()).toEqual([]);
  });

  it("is retryable, sending nothing, for a missing or empty encoded file", async () => {
    const client = new FakeStore();
    expect(await storeFor(client).publish({ key: KEY, localPath: join(scratch, "missing.mp4") })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
    expect(await storeFor(client).publish({ key: KEY, localPath: await localFile(new Uint8Array(0)) })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
    expect(client.puts).toHaveLength(0);
  });

  it("is retryable when the write fails, or when nothing is at the key after it", async () => {
    for (const client of [new FakeStore({ putThrows: true }), new FakeStore({ putDrops: true })]) {
      expect(await storeFor(client).publish({ key: KEY, localPath: await localFile(MASTER) })).toEqual({
        kind: "RETRYABLE_FAILURE",
      });
      expect(client.puts).toHaveLength(1);
      expect(await leftovers()).toEqual([]);
    }
  });

  it("answers a failed write as retryable without reading the key, even when a master is there", async () => {
    // A write that failed says nothing about the key; the next attempt's write
    // finds the stored master and copies it back.
    const client = new FakeStore({ objects: { [KEY]: [OTHER] }, putThrows: true });
    expect(await storeFor(client).publish({ key: KEY, localPath: await localFile(MASTER) })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
    expect(client.gets).toHaveLength(0);
    expect(await leftovers()).toEqual([]);
  });

  it("reports the stored master's own ceiling and read failures from the copy back", async () => {
    const tooLarge = stored([new CountedOnlyChunk(MAX_CLEAN_MASTER_BYTES + 1)]);
    expect(await storeFor(tooLarge).publish({ key: KEY, localPath: await localFile(MASTER) })).toEqual({
      kind: "TOO_LARGE",
    });
    const unreadable = new FakeStore({ objects: { [KEY]: [MASTER] }, readThrowsAt: 0 });
    expect(await storeFor(unreadable).publish({ key: KEY, localPath: await localFile(MASTER) })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
    expect(await leftovers()).toEqual([]);
  });
});
