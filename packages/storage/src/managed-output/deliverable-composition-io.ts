/**
 * The two object-storage boundaries composition execution needs: bringing the
 * planned scene bytes down, and publishing the composed file back up.
 *
 * Both are deliberately in one module because they share the temporary-directory
 * discipline, and neither may leak a storage error, a bucket name, a key or a
 * local path across its port.
 *
 * ## Temporary files carry no identity
 *
 * One random directory per execution, and inside it fixed names: `input-0000`,
 * `input-0001`, …, `output.mp4`. Nothing is derived from an organization, job,
 * scene, property or customer filename. A local path built from customer data is
 * how a filename ends up in a log line, an error message or a crash dump, and
 * the composer's arguments are exactly where that would be most visible.
 *
 * ## Cleanup is unconditional and never the answer
 *
 * The directory is removed on every exit path, and a cleanup failure is
 * swallowed. Leaving a temporary directory behind is an operational annoyance;
 * replacing a successful composition's outcome with a `rmdir` error is a defect.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_DELIVERABLE_OUTPUT_BYTES,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type CompositionSceneInput,
  type DeliverableCompositionSourceMaterializer,
  type DeliverableOutputPublisher,
  type MaterializeCompositionSourcesOutcome,
  type PublishDeliverableOutcome,
} from "@app/domain";
import type { ManagedOutputTempFileFactory, S3ManagedObjectReader } from "./media-validation";
import type { S3ObjectBody } from "./s3-staging-sink";

/** The read-and-write slice of the S3 seam these two boundaries need. */
export interface DeliverableObjectClient extends S3ManagedObjectReader {
  /**
   * Publish `localPath` at `key`, refusing if an object already exists there.
   *
   * First-wins is the *storage's* job, not a read-then-write in this process:
   * two workers checking "does it exist?" and then writing would both see
   * nothing and both write. The adapter is expected to express this as a
   * conditional create.
   */
  putObjectIfAbsent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly localPath: string;
    readonly contentType: string;
    readonly expectedBucketOwner: string | undefined;
  }): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }>;
}

export interface DeliverableCompositionIoConfig {
  readonly bucket: string;
  readonly expectedBucketOwner?: string | undefined;
}

export interface DeliverableCompositionIoDeps {
  readonly client: DeliverableObjectClient;
  /** Reused verbatim from media validation; not a filesystem abstraction. */
  readonly tempFiles: ManagedOutputTempFileFactory;
}

/** The fixed local name for the nth source. Zero-padded so order is visible. */
export function sourceFileName(index: number): string {
  return `input-${String(index).padStart(4, "0")}`;
}

/** The fixed local name for the composed file. */
export const COMPOSED_FILE_NAME = "output.mp4";

async function cancelQuietly(body: S3ObjectBody | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Best effort.
  }
}

export function createDeliverableCompositionSourceMaterializer(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
): DeliverableCompositionSourceMaterializer {
  return {
    async materialize({ organizationId, scenes }): Promise<MaterializeCompositionSourcesOutcome> {
      // No budget check here. The plan's frozen source total is arithmetic the
      // caller already has, it is decided before this port is reached, and an
      // overrun ends the work rather than deferring it — so a second copy of
      // that rule inside a storage adapter could only disagree with the first.
      const dir = await mkdtemp(join(tmpdir(), "vta-compose-"));
      const release = async (): Promise<void> => {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // Best effort: never replaces the caller's result.
        }
      };

      const sources: { position: number; localPath: string }[] = [];
      try {
        for (const [index, scene] of scenes.entries()) {
          const localPath = join(dir, sourceFileName(index));
          const outcome = await materializeOne(deps, config, organizationId, scene, localPath);
          if (outcome !== "OK") {
            await release();
            return outcome === "MISMATCH"
              ? { kind: "INTEGRITY_MISMATCH" }
              : { kind: "RETRYABLE_FAILURE" };
          }
          sources.push({ position: scene.position, localPath });
        }
      } catch {
        await release();
        return { kind: "RETRYABLE_FAILURE" };
      }

      return { kind: "MATERIALIZED", sources, release };
    },
  };
}

/**
 * Stream one canonical source to disk, hashing and counting as it goes.
 *
 * Never buffers the whole object: a 512 MiB clip held in memory per scene is how
 * one worker takes a machine down. The receipt comparison is the last step and
 * the only one that may conclude `MISMATCH` — a read failure is not evidence
 * that the bytes are wrong, and calling it one would have an operator chasing a
 * corrupt object that does not exist.
 */
async function materializeOne(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
  organizationId: string,
  scene: CompositionSceneInput,
  localPath: string,
): Promise<"OK" | "MISMATCH" | "RETRYABLE"> {
  const key = managedGenerationOutputKey({
    organizationId,
    attemptId: scene.sceneGenerationAttemptId,
  });
  // The plan's key and the freshly derived one must agree; they are built from
  // the same two identifiers, so a difference would be a defect in the builder.
  if (key !== scene.sourceStorageKey) return "RETRYABLE";

  let body: S3ObjectBody | null = null;
  try {
    const result = await deps.client.getObject({
      bucket: config.bucket,
      key,
      expectedBucketOwner: config.expectedBucketOwner,
    });
    body = result.body;
    if (body === null) return "RETRYABLE";

    const file = await deps.tempFiles.openExclusive0600(localPath);
    const hash = createHash("sha256");
    let total = 0;
    let streamed = false;
    try {
      for (;;) {
        const chunk = await body.read();
        if (chunk === null) break;
        if (!(chunk instanceof Uint8Array)) return "RETRYABLE";
        const next = total + chunk.byteLength;
        // The plan's frozen byte count is this stream's ceiling, so a longer
        // object is already proved not to be the planned bytes — concluded
        // here rather than after another gigabyte of reading, and never by
        // filling the disk first.
        if (next > scene.sourceSizeBytes) return "MISMATCH";
        // The chunk counts for nothing until all of it is on disk: a short or
        // stalled write leaves a truncated file, and a truncated file must never
        // be described by a hash of bytes it does not contain.
        if (!(await writeAll(file, chunk))) return "RETRYABLE";
        hash.update(chunk);
        total = next;
      }
      streamed = true;
    } finally {
      if (!streamed) {
        try {
          await file.close();
        } catch {
          // Best effort.
        }
      }
    }

    // Writing every byte is not the same as having every byte: data still owed
    // to the file is flushed by `close()`, so a failing close means the local
    // copy may be short of what the hash already counted.
    try {
      await file.close();
    } catch {
      return "RETRYABLE";
    }

    // The last step, and the only one that may conclude the bytes are wrong. A
    // clean stream at the wrong digest or length means the object at the
    // canonical key is not what the plan froze — never fed to the composer, and
    // never silently replaced with some other attempt's output.
    if (hash.digest("hex") !== scene.sourceSha256 || total !== scene.sourceSizeBytes) {
      return "MISMATCH";
    }
    return "OK";
  } catch {
    return "RETRYABLE";
  } finally {
    await cancelQuietly(body);
  }
}

async function writeAll(
  file: { write(d: Uint8Array, o: number, l: number): Promise<{ bytesWritten: number }> },
  chunk: Uint8Array,
): Promise<boolean> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await file.write(chunk, written, chunk.byteLength - written);
    // A zero-byte write is a stalled sink, not progress; looping on it forever
    // is how a worker hangs holding a lease.
    if (result.bytesWritten <= 0) return false;
    written += result.bytesWritten;
  }
  return true;
}

export function createDeliverableOutputPublisher(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
): DeliverableOutputPublisher {
  return {
    async publish({ key, localPath }): Promise<PublishDeliverableOutcome> {
      let localBytes: number;
      try {
        const info = await stat(localPath);
        localBytes = info.size;
      } catch {
        return { kind: "RETRYABLE_FAILURE" };
      }
      // A cheap preflight only. `stat` bounds what is *sent*; the receipt below
      // is read back from the canonical object, so the limit is enforced again
      // against the bytes that actually exist rather than trusted from here.
      if (localBytes > MAX_DELIVERABLE_OUTPUT_BYTES) return { kind: "OUTPUT_TOO_LARGE" };
      if (localBytes <= 0) return { kind: "RETRYABLE_FAILURE" };

      try {
        await deps.client.putObjectIfAbsent({
          bucket: config.bucket,
          key,
          localPath,
          contentType: "video/mp4",
          expectedBucketOwner: config.expectedBucketOwner,
        });
      } catch {
        return { kind: "RETRYABLE_FAILURE" };
      }

      // The receipt is read from the object that is **actually at the key**,
      // never assumed from the local file — even when this call created it.
      //
      // That is what makes "published, then crashed before the database learned
      // of it" recoverable: the retry finds an object it did not write, and
      // finalizes against its real digest rather than against the bytes it just
      // composed. Assuming the two are equal would durably record a receipt for
      // an object nobody read.
      return readCanonicalReceipt(deps, config, key);
    },
  };
}

async function readCanonicalReceipt(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
  key: string,
): Promise<PublishDeliverableOutcome> {
  let body: S3ObjectBody | null = null;
  try {
    const result = await deps.client.getObject({
      bucket: config.bucket,
      key,
      expectedBucketOwner: config.expectedBucketOwner,
    });
    body = result.body;
    if (body === null) return { kind: "RETRYABLE_FAILURE" };

    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = await body.read();
      if (chunk === null) break;
      if (!(chunk instanceof Uint8Array)) return { kind: "RETRYABLE_FAILURE" };
      total += chunk.byteLength;
      if (total > MAX_DELIVERABLE_OUTPUT_BYTES) return { kind: "OUTPUT_TOO_LARGE" };
      hash.update(chunk);
    }
    // A zero-byte canonical object is not a deliverable. Retryable rather than
    // terminal: an operator may replace it, and this phase never declares a
    // customer's deliverable permanently impossible.
    if (total <= 0) return { kind: "RETRYABLE_FAILURE" };

    // The digest is of the bytes just read. An ETag is never used as a SHA-256:
    // it is not one for a multipart object, and trusting it would record a
    // receipt that no reader could reproduce.
    return {
      kind: "PUBLISHED",
      sha256: sha256Digest(hash.digest("hex")),
      sizeBytes: safePositiveByteCount(total),
    };
  } catch {
    return { kind: "RETRYABLE_FAILURE" };
  } finally {
    await cancelQuietly(body);
  }
}

/**
 * The composed file's path, beside the sources it was made from.
 *
 * Derived from a materialized source path rather than from any identifier, so
 * the output lands in the same private directory and is removed by the same
 * unconditional cleanup.
 */
export function composedOutputPathFor(anySourceLocalPath: string): string {
  return join(dirname(anySourceLocalPath), COMPOSED_FILE_NAME);
}
