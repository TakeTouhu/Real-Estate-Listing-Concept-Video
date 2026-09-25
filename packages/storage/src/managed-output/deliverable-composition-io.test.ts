/**
 * Source materialization and output publication, against a fake object store
 * and real temporary files on disk.
 *
 * Real files on purpose. The whole claim of the materializer is that what ends
 * up on disk is byte-for-byte the object the plan froze, and a fake filesystem
 * proves only that the code believed so. The store is fake because no test may
 * need a bucket.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DELIVERABLE_OUTPUT_BYTES,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type CompositionSceneInput,
} from "@app/domain";
import { FakeManagedOutputTempFiles } from "../testing/media-fakes";
import {
  COMPOSED_FILE_NAME,
  composedOutputPathFor,
  createDeliverableCompositionSourceMaterializer,
  createDeliverableOutputPublisher,
  sourceFileName,
  type DeliverableObjectClient,
} from "./deliverable-composition-io";
import type { S3GetObjectInput, S3GetObjectResult, S3ObjectBody } from "./s3-staging-sink";

const ORG = "org_1";
const BUCKET = "managed-output-bucket";
const VERSION = "gdv_1";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bodyOf(chunks: readonly Uint8Array[], options: { failAt?: number } = {}): S3ObjectBody {
  let index = 0;
  let cancelled = false;
  return {
    async read() {
      if (options.failAt === index) throw new Error("stream failed");
      const chunk = chunks[index];
      index += 1;
      return chunk ?? null;
    },
    async cancel() {
      cancelled = true;
      void cancelled;
    },
  };
}

interface StoreOptions {
  readonly objects?: Record<string, readonly Uint8Array[]>;
  readonly getThrows?: boolean;
  readonly nullBody?: boolean;
  readonly putThrows?: boolean;
  readonly occupiedWith?: Uint8Array;
}

class FakeStore implements DeliverableObjectClient {
  readonly gets: S3GetObjectInput[] = [];
  readonly puts: { key: string; localPath: string; contentType: string }[] = [];
  readonly stored = new Map<string, Uint8Array>();

  constructor(private readonly options: StoreOptions = {}) {
    if (options.occupiedWith !== undefined) {
      this.stored.set(
        managedDeliverableOutputKey({ organizationId: ORG, deliverableVersionId: VERSION }),
        options.occupiedWith,
      );
    }
  }

  async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
    this.gets.push(input);
    if (this.options.getThrows === true) throw new Error("store unreachable");
    if (this.options.nullBody === true) return { contentLength: null, body: null };
    const fromStore = this.stored.get(input.key);
    const chunks = this.options.objects?.[input.key] ?? (fromStore ? [fromStore] : undefined);
    if (chunks === undefined) return { contentLength: null, body: null };
    return { contentLength: null, body: bodyOf(chunks) };
  }

  async putObjectIfAbsent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly localPath: string;
    readonly contentType: string;
    readonly expectedBucketOwner: string | undefined;
  }): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }> {
    this.puts.push({ key: input.key, localPath: input.localPath, contentType: input.contentType });
    if (this.options.putThrows === true) throw new Error("put failed");
    if (this.stored.has(input.key)) return { kind: "ALREADY_EXISTS" };
    this.stored.set(input.key, new Uint8Array(await readFile(input.localPath)));
    return { kind: "CREATED" };
  }
}

function sceneOf(
  attemptId: string,
  bytes: Uint8Array,
  overrides: Partial<CompositionSceneInput> = {},
): CompositionSceneInput {
  return {
    position: 1,
    generationSceneId: `gs_${attemptId}`,
    sceneGenerationAttemptId: attemptId,
    sourceStorageKey: managedGenerationOutputKey({ organizationId: ORG, attemptId }),
    sourceSha256: sha256Digest(digestOf(bytes)),
    sourceSizeBytes: safePositiveByteCount(bytes.byteLength),
    durationSeconds: 5,
    ...overrides,
  };
}

function materializerFor(store: FakeStore) {
  return createDeliverableCompositionSourceMaterializer(
    { client: store, tempFiles: new FakeManagedOutputTempFiles() },
    { bucket: BUCKET },
  );
}

const A = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const B = new Uint8Array([9, 9, 9, 9]);

function storeWith(...scenes: { attemptId: string; bytes: Uint8Array }[]): FakeStore {
  const objects: Record<string, readonly Uint8Array[]> = {};
  for (const one of scenes) {
    objects[managedGenerationOutputKey({ organizationId: ORG, attemptId: one.attemptId })] = [
      one.bytes,
    ];
  }
  return new FakeStore({ objects });
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

describe("sources are streamed to private files named by position, never by identity", () => {
  it("writes the planned bytes in plan order and reports each local path", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: A }, { attemptId: "sg_b", bytes: B });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A), sceneOf("sg_b", B, { position: 2 })],
    });

    expect(outcome.kind).toBe("MATERIALIZED");
    if (outcome.kind !== "MATERIALIZED") return;
    scratch.push(join(outcome.sources[0]!.localPath, ".."));

    expect(outcome.sources.map((one) => one.position)).toEqual([1, 2]);
    expect(outcome.sources[0]!.localPath.endsWith("input-0000")).toBe(true);
    expect(outcome.sources[1]!.localPath.endsWith("input-0001")).toBe(true);
    expect(new Uint8Array(await readFile(outcome.sources[0]!.localPath))).toEqual(A);
    expect(new Uint8Array(await readFile(outcome.sources[1]!.localPath))).toEqual(B);
    await outcome.release();
  });

  it("derives every local name from an index, never from tenant data", () => {
    expect(sourceFileName(0)).toBe("input-0000");
    expect(sourceFileName(7)).toBe("input-0007");
    expect(sourceFileName(1234)).toBe("input-1234");
    expect(COMPOSED_FILE_NAME).toBe("output.mp4");
    for (const name of [sourceFileName(0), COMPOSED_FILE_NAME]) {
      for (const leak of [ORG, VERSION, "sg_a", "property", "customer"]) {
        expect(`${name} leaks ${leak}: ${name.includes(leak)}`).toBe(`${name} leaks ${leak}: false`);
      }
    }
  });

  it("puts the composed file beside its sources, in the same private directory", () => {
    expect(composedOutputPathFor("/tmp/vta-compose-abc/input-0000")).toBe(
      "/tmp/vta-compose-abc/output.mp4",
    );
  });

  it("reads each source from the canonical key the plan named", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: A });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A)],
    });
    if (outcome.kind === "MATERIALIZED") await outcome.release();
    expect(store.gets.map((one) => one.key)).toEqual([
      managedGenerationOutputKey({ organizationId: ORG, attemptId: "sg_a" }),
    ]);
    expect(store.gets[0]!.bucket).toBe(BUCKET);
  });
});

describe("a receipt disagreement is a mismatch; a read failure never is", () => {
  it("reports INTEGRITY_MISMATCH when the digest differs", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]) });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      // Same length, different bytes: only the digest can tell.
      scenes: [sceneOf("sg_a", A)],
    });
    expect(outcome.kind).toBe("INTEGRITY_MISMATCH");
  });

  it("reports INTEGRITY_MISMATCH when the object is shorter than its receipt", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: new Uint8Array([1, 2, 3]) });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A)],
    });
    expect(outcome.kind).toBe("INTEGRITY_MISMATCH");
  });

  it("stops a longer-than-planned object at the ceiling its receipt states", async () => {
    // Concluded from the frozen byte count rather than after reading the rest:
    // an object longer than its receipt is already proved not to be the planned
    // bytes.
    const store = storeWith({ attemptId: "sg_a", bytes: new Uint8Array(64).fill(3) });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A)],
    });
    expect(outcome.kind).toBe("INTEGRITY_MISMATCH");
  });

  it("reports a store failure as retryable, never as corrupt bytes", async () => {
    for (const options of [{ getThrows: true }, { nullBody: true }, {}]) {
      const outcome = await materializerFor(new FakeStore(options)).materialize({
        organizationId: ORG,
        scenes: [sceneOf("sg_a", A)],
      });
      expect(outcome.kind).toBe("RETRYABLE_FAILURE");
    }
  });

  it("refuses the whole materialization when any one source disagrees", async () => {
    const store = storeWith(
      { attemptId: "sg_a", bytes: A },
      { attemptId: "sg_b", bytes: new Uint8Array([0, 0, 0, 0]) },
    );
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A), sceneOf("sg_b", B, { position: 2 })],
    });
    // A deliverable composed partly from bytes nobody validated is worse than
    // no deliverable.
    expect(outcome.kind).toBe("INTEGRITY_MISMATCH");
  });

  it("removes the temporary directory on every failure path", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: new Uint8Array([9]) });
    const tempFiles = new FakeManagedOutputTempFiles();
    const outcome = await createDeliverableCompositionSourceMaterializer(
      { client: store, tempFiles },
      { bucket: BUCKET },
    ).materialize({ organizationId: ORG, scenes: [sceneOf("sg_a", A)] });

    expect(outcome.kind).toBe("INTEGRITY_MISMATCH");
    // The directory the failing attempt opened into is gone, and the outcome
    // carries no release handle for the caller to forget.
    const opened = tempFiles.openedPaths[0]!;
    await expect(readFile(opened)).rejects.toThrow();
    await expect(readFile(join(opened, ".."))).rejects.toThrow();
    expect("release" in outcome).toBe(false);
  });

  it("carries no store message, key, bucket or path in any failure outcome", async () => {
    for (const options of [{ getThrows: true }, { nullBody: true }]) {
      const outcome = await materializerFor(new FakeStore(options)).materialize({
        organizationId: ORG,
        scenes: [sceneOf("sg_a", A)],
      });
      const serialized = JSON.stringify(outcome);
      for (const leak of [BUCKET, ORG, "sg_a", "unreachable", "/tmp"]) {
        expect(`${leak}: ${serialized.includes(leak)}`).toBe(`${leak}: false`);
      }
    }
  });

  it("releases more than once without complaining", async () => {
    const store = storeWith({ attemptId: "sg_a", bytes: A });
    const outcome = await materializerFor(store).materialize({
      organizationId: ORG,
      scenes: [sceneOf("sg_a", A)],
    });
    if (outcome.kind !== "MATERIALIZED") throw new Error("expected materialization");
    await outcome.release();
    await expect(outcome.release()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

const KEY = managedDeliverableOutputKey({ organizationId: ORG, deliverableVersionId: VERSION });

async function withComposedFile<T>(
  bytes: Uint8Array,
  run: (localPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vta-publish-"));
  scratch.push(dir);
  const localPath = join(dir, COMPOSED_FILE_NAME);
  await writeFile(localPath, bytes);
  return run(localPath);
}

function publisherFor(store: FakeStore) {
  return createDeliverableOutputPublisher(
    { client: store, tempFiles: new FakeManagedOutputTempFiles() },
    { bucket: BUCKET },
  );
}

describe("publication is first-wins and the receipt is read back from the object", () => {
  it("publishes to the canonical key as video/mp4 and returns the real digest", async () => {
    const composed = new Uint8Array([4, 4, 4, 4, 4, 4]);
    const store = new FakeStore();
    const outcome = await withComposedFile(composed, (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(store.puts.map((one) => one.key)).toEqual([KEY]);
    expect(store.puts[0]!.contentType).toBe("video/mp4");
    expect(outcome).toEqual({
      kind: "PUBLISHED",
      sha256: digestOf(composed),
      sizeBytes: composed.byteLength,
    });
  });

  it("returns the occupying object's receipt, not the bytes it just composed", async () => {
    // This is what makes "published, then crashed before the database learned of
    // it" recoverable. Assuming the two are equal would durably record a receipt
    // for an object nobody read.
    const occupying = new Uint8Array([1, 1, 1]);
    const store = new FakeStore({ occupiedWith: occupying });
    const outcome = await withComposedFile(new Uint8Array([2, 2, 2, 2, 2, 2, 2]), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(outcome).toEqual({
      kind: "PUBLISHED",
      sha256: digestOf(occupying),
      sizeBytes: occupying.byteLength,
    });
  });

  it("never overwrites an object that is already there", async () => {
    const occupying = new Uint8Array([1, 1, 1]);
    const store = new FakeStore({ occupiedWith: occupying });
    await withComposedFile(new Uint8Array([2, 2]), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(store.stored.get(KEY)).toEqual(occupying);
  });

  it("publishes a file well inside the ceiling", async () => {
    // The 512 MiB ceiling itself is deliberately NOT exercised with a real
    // file: writing half a gigabyte per run would make this suite a disk test.
    // The constant is pinned in the domain suite, and the runner suite pins
    // that an `OUTPUT_TOO_LARGE` outcome blocks rather than defers -- which is
    // the behaviour that actually matters.
    const store = new FakeStore();
    const outcome = await withComposedFile(new Uint8Array(8), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(outcome.kind).toBe("PUBLISHED");
    expect(MAX_DELIVERABLE_OUTPUT_BYTES).toBe(536_870_912);
  });

  it("reports a missing or unreadable local file as retryable", async () => {
    const store = new FakeStore();
    const outcome = await publisherFor(store).publish({
      key: KEY,
      localPath: "/nonexistent/vta-compose/output.mp4",
    });
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(store.puts).toHaveLength(0);
  });

  it("refuses to publish a zero-byte composition", async () => {
    const store = new FakeStore();
    const outcome = await withComposedFile(new Uint8Array(0), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(store.puts).toHaveLength(0);
  });

  it("reports a failed put as retryable and carries none of its text", async () => {
    const store = new FakeStore({ putThrows: true });
    const outcome = await withComposedFile(new Uint8Array([5, 5]), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(JSON.stringify(outcome).includes("put failed")).toBe(false);
  });

  it("re-reads the canonical object even when this call created it", async () => {
    const store = new FakeStore();
    await withComposedFile(new Uint8Array([6, 6, 6]), (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    expect(store.gets.map((one) => one.key)).toEqual([KEY]);
  });

  it("never uses an ETag as a digest", async () => {
    const composed = new Uint8Array([7, 7, 7, 7]);
    const store = new FakeStore();
    const outcome = await withComposedFile(composed, (localPath) =>
      publisherFor(store).publish({ key: KEY, localPath }),
    );
    if (outcome.kind !== "PUBLISHED") throw new Error("expected publication");
    // A SHA-256 of the bytes actually read: 64 lowercase hex characters, and
    // equal to the digest computed here independently.
    expect(outcome.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.sha256).toBe(digestOf(composed));
  });
});
