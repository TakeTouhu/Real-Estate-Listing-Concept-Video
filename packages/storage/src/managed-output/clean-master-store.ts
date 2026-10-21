/**
 * The Clean Master's object-storage boundary (ADR-0076 Decision 2): reading a
 * stored master's receipt, copying a stored master to a private local file, and
 * storing a newly encoded master first-wins.
 *
 * ## The copy is of what is stored
 *
 * Every copy is made by reading the object at the key, never by keeping the file
 * the master encode wrote. Publication stores first-wins and then copies back
 * what is there, which may be a master another attempt stored first, so every
 * attempt lays the disclosure over the same stored bytes, and so does a later
 * recomposition from the master (ADR-0071 Decision 7).
 *
 * ## One read, hashed as it is written
 *
 * The receipt is the digest and byte count of the bytes streamed into the copy,
 * so it describes exactly the file the composer will read. Nothing is buffered
 * whole in memory, and the read stops at {@link MAX_CLEAN_MASTER_BYTES} rather
 * than filling the disk first.
 *
 * ## Only the internal namespace is written
 *
 * The master carries no disclosure and is never the customer's (ADR-0052
 * Decision 17), so `publish` refuses any key outside
 * `org/{organizationId}/internal/`, which no signed URL reaches (ADR-0074). The
 * key's type already says so; the check holds when a cast does not.
 *
 * ## Temporary files carry no identity
 *
 * One random directory per copy, and inside it fixed names: `clean-master.mp4`
 * for the copy and `output.mp4` for the customer's video. Cleanup is
 * unconditional on every failure path and a cleanup failure is swallowed, as for
 * the materializer.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@app/shared";
import {
  MAX_CLEAN_MASTER_BYTES,
  isCanonicalStorageKey,
  isInternalStorageKey,
  safePositiveByteCount,
  sha256Digest,
  type CleanMasterStore,
  type FetchCleanMasterOutcome,
  type ManagedCleanMasterKey,
  type ProbeCleanMasterOutcome,
  type PublishCleanMasterOutcome,
} from "@app/domain";
import {
  COMPOSED_FILE_NAME,
  writeAll,
  type DeliverableCompositionIoConfig,
  type DeliverableCompositionIoDeps,
} from "./deliverable-composition-io";
import type { ManagedOutputTempFile } from "./media-validation";
import type { S3ObjectBody } from "./s3-staging-sink";

/** The fixed local name of a Clean Master copy. */
export const CLEAN_MASTER_COPY_FILE_NAME = "clean-master.mp4";

/** The prefix of each copy's private directory. */
export const CLEAN_MASTER_DIRECTORY_PREFIX = "vta-master-";

type StoredRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "READ"; readonly sha256: string; readonly sizeBytes: number }
  | { readonly kind: "TOO_LARGE" }
  | { readonly kind: "RETRYABLE_FAILURE" };

export function createCleanMasterStore(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
): CleanMasterStore {
  return {
    async probe({ key }): Promise<ProbeCleanMasterOutcome> {
      const read = await readStored(deps, config, key, null);
      if (read.kind !== "READ") return read;
      return {
        kind: "STORED",
        sha256: sha256Digest(read.sha256),
        sizeBytes: safePositiveByteCount(read.sizeBytes),
      };
    },

    async fetch({ key }): Promise<FetchCleanMasterOutcome> {
      return copyStored(deps, config, key);
    },

    async publish({ key, localPath }): Promise<PublishCleanMasterOutcome> {
      // A defect in the caller, never a customer's doing, and its message names
      // no key: no route accepts a key from a customer.
      if (!isCanonicalStorageKey(key) || !isInternalStorageKey(key)) {
        throw new AppError(
          "INTERNAL_ERROR",
          "A Clean Master is only ever stored under the internal namespace",
        );
      }

      let localBytes: number;
      try {
        localBytes = (await stat(localPath)).size;
      } catch {
        return { kind: "RETRYABLE_FAILURE" };
      }
      // A cheap preflight only: the copy below is read back from the stored
      // object, so the ceiling is enforced again against the bytes that exist.
      // An encode over the ceiling is not sent, but another attempt may already
      // have stored a master within it, and what is stored is the answer:
      // "too large" ends the work, so it is said only when nothing is there.
      if (localBytes > MAX_CLEAN_MASTER_BYTES) {
        const stored = await copyStored(deps, config, key);
        return stored.kind === "ABSENT" ? { kind: "TOO_LARGE" } : stored;
      }
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

      // Created or already there, what is at the key is what is copied back.
      // Absent straight after a successful write is not an answer to act on:
      // retrying reads the key again rather than encoding a second master.
      const copied = await copyStored(deps, config, key);
      return copied.kind === "ABSENT" ? { kind: "RETRYABLE_FAILURE" } : copied;
    },
  };
}

/** Copy the stored master into a fresh private directory, or report why not. */
async function copyStored(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
  key: ManagedCleanMasterKey,
): Promise<FetchCleanMasterOutcome> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), CLEAN_MASTER_DIRECTORY_PREFIX));
  } catch {
    return { kind: "RETRYABLE_FAILURE" };
  }
  const release = async (): Promise<void> => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort: never replaces the caller's result.
    }
  };

  const cleanMasterPath = join(dir, CLEAN_MASTER_COPY_FILE_NAME);
  const read = await readStored(deps, config, key, cleanMasterPath);
  if (read.kind !== "READ") {
    await release();
    return read;
  }
  return {
    kind: "COPIED",
    copy: {
      cleanMasterPath,
      sha256: sha256Digest(read.sha256),
      sizeBytes: safePositiveByteCount(read.sizeBytes),
      // Beside the copy, because this function made the directory: the video
      // made from the copy is removed by the same release.
      outputPath: join(dir, COMPOSED_FILE_NAME),
      release,
    },
  };
}

/**
 * Read the object at `key` once, hashing and counting, and stream it into a new
 * owner-only file at `sinkPath` when one is given. Never throws.
 *
 * `ABSENT` only when the store positively says nothing is there. A zero-byte
 * object is not a master, and is retryable rather than terminal, as for the
 * customer's video: an operator may replace it.
 */
async function readStored(
  deps: DeliverableCompositionIoDeps,
  config: DeliverableCompositionIoConfig,
  key: ManagedCleanMasterKey,
  sinkPath: string | null,
): Promise<StoredRead> {
  let body: S3ObjectBody | null = null;
  let file: ManagedOutputTempFile | null = null;
  try {
    const result = await deps.client.getObject({
      bucket: config.bucket,
      key,
      expectedBucketOwner: config.expectedBucketOwner,
    });
    body = result.body;
    if (body === null) return { kind: "ABSENT" };

    if (sinkPath !== null) file = await deps.tempFiles.openExclusive0600(sinkPath);
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = await body.read();
      if (chunk === null) break;
      if (!(chunk instanceof Uint8Array)) return { kind: "RETRYABLE_FAILURE" };
      total += chunk.byteLength;
      if (total > MAX_CLEAN_MASTER_BYTES) return { kind: "TOO_LARGE" };
      // A chunk counts for nothing until all of it is on disk: the receipt
      // must never describe bytes the copy does not contain.
      if (file !== null && !(await writeAll(file, chunk))) return { kind: "RETRYABLE_FAILURE" };
      hash.update(chunk);
    }
    if (total <= 0) return { kind: "RETRYABLE_FAILURE" };

    if (file !== null) {
      // Data still owed to the file is flushed by `close()`, so a failing close
      // means the copy may be short of what the hash already counted.
      const closing = file;
      file = null;
      try {
        await closing.close();
      } catch {
        return { kind: "RETRYABLE_FAILURE" };
      }
    }
    return { kind: "READ", sha256: hash.digest("hex"), sizeBytes: total };
  } catch {
    return { kind: "RETRYABLE_FAILURE" };
  } finally {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // Best effort: the directory is removed by the caller.
      }
    }
    if (body !== null) {
      try {
        await body.cancel();
      } catch {
        // Best effort.
      }
    }
  }
}
