import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isCanonicalStorageKey, type ObjectStorage, type SignedUrl } from "@app/domain";
import { AppError } from "@app/shared";
import type { DeliverableObjectClient } from "./managed-output/deliverable-composition-io";
import type {
  S3AbortMultipartUploadInput,
  S3CompleteMultipartUploadInput,
  S3CreateMultipartUploadInput,
  S3CreateMultipartUploadResult,
  S3GetObjectInput,
  S3GetObjectResult,
  S3MultipartClient,
  S3ObjectBody,
  S3UploadPartInput,
  S3UploadPartResult,
} from "./managed-output/s3-staging-sink";
import { assertNotProduction } from "./production-guard";
import { signedStorageUrl, type SignedPurpose } from "./signing";

/**
 * Object storage in a folder on disk, shared by the web app and the worker in
 * development and CI (ADR-0085).
 *
 * Both processes open the same absolute folder, so a photo the web app stores
 * is there for the worker, and a video the worker publishes is there for the
 * web app to serve. Objects survive a restart, which the in-memory
 * `LocalObjectStorage` cannot offer.
 *
 * It has two views of one set of objects, because the two sides of the system
 * already speak two contracts and neither changes:
 *
 * - `objectStorage`, the domain's `ObjectStorage` port with signed URLs, for
 *   the web app, exactly as `LocalObjectStorage` serves it;
 * - `objectClient`, the narrow S3-shaped seam the worker's staging sink, media
 *   validator, composition input and output, and Clean Master store take, with
 *   the one bucket {@link SHARED_FOLDER_STORAGE_BUCKET}.
 *
 * ## What it keeps from object storage
 *
 * - **A key is an object, never a path.** Only a canonical key is accepted
 *   (ADR-0074), so no key can name anything outside the folder.
 * - **No reader sees half an object.** Every write lands in a private temporary
 *   file first and is then renamed or linked into place in one step.
 * - **First wins where the seam says so.** A multipart completion and
 *   `putObjectIfAbsent` publish with a hard link, which the file system refuses
 *   when the key is taken. A losing completion is refused with a `412`, as S3
 *   refuses it, so the existing sink reads the winner back unchanged.
 * - **Absence is proved, never assumed.** A key reads as empty only when no file
 *   is at it and the objects folder this store opened is still in place.
 * - **A refusal names no key and no path.** File system errors carry the full
 *   path in their message, so none is passed on; only its code is.
 *
 * It keeps no metadata, so a content type given to it is not stored.
 *
 * NOT PRODUCTION-SAFE: construction throws when either the ambient or the given
 * NODE_ENV is production, with no escape hatch, and the environment schema
 * refuses its setting there too.
 */

/** The one bucket the worker's seam may name. */
export const SHARED_FOLDER_STORAGE_BUCKET = "shared-folder";

/** The most a body hands over per read: 1 MiB. */
export const SHARED_FOLDER_READ_CHUNK_BYTES = 1024 * 1024;

/** S3's largest part number. */
const MAX_PART_NUMBER = 10_000;

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Codes that prove nothing is stored at a key. */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** Node's code for `rm` meeting a folder: one that holds other keys, not an object. */
const RM_FOLDER_CODE = "ERR_FS_EISDIR";

export interface SharedFolderStorageOptions {
  /** The shared folder. Absolute, so every process names the same one. */
  readonly root: string;
  /** HMAC secret used to sign storage tokens. Server-side only. */
  readonly secret: string;
  /** Base path that serves signed objects, e.g. "/api/storage". */
  readonly basePath?: string;
  readonly now?: () => Date;
  /** Refused as production too, besides the ambient NODE_ENV; for tests. */
  readonly nodeEnv?: string;
}

/** The worker's view: every call the S3-shaped seams make. */
export type SharedFolderObjectClient = S3MultipartClient & DeliverableObjectClient;

export interface SharedFolderStorage {
  readonly objectStorage: ObjectStorage;
  readonly objectClient: SharedFolderObjectClient;
}

/**
 * A refusal shaped as the S3 seam reads one: an HTTP status in `$metadata`, a
 * fixed name, and at most a file system error code beside it.
 */
export class SharedFolderStorageError extends Error {
  readonly $metadata: { readonly httpStatusCode: number };

  constructor(status: number, name: string, code?: string) {
    super(code === undefined ? name : `${name} (${code})`);
    this.name = name;
    this.$metadata = { httpStatusCode: status };
  }
}

function errorCode(error: unknown): string {
  try {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function isAbsent(error: unknown): boolean {
  return ABSENT_CODES.has(errorCode(error));
}

/** An error of the store's own, which leaves only as its code. */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover file never replaces the caller's result.
  }
}

/**
 * Create or adopt one of the store's folders: a folder, not a link, that this
 * user owns, readable by this user alone. Returns it open, as checked.
 */
function privateFolder(path: string): number {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    // A link, or anything else that is not a folder.
    throw failure("FOLDER_NOT_PRIVATE");
  }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw failure("FOLDER_NOT_PRIVATE");
    }
    fchmodSync(fd, 0o700);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function sha256(bytes: Uint8Array, encoding: "hex" | "base64"): string {
  return createHash("sha256").update(bytes).digest(encoding);
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Best effort: never replaces the caller's result.
  }
}

/** The objects themselves, shared by both views. */
class Folder {
  readonly #objects: string;
  readonly #uploads: string;
  readonly #staging: string;
  readonly #objectsDevice: number;
  readonly #objectsInode: number;

  constructor(root: string) {
    this.#objects = join(root, "objects");
    this.#uploads = join(root, "uploads");
    this.#staging = join(root, "staging");
    for (const dir of [root, this.#uploads, this.#staging]) closeSync(privateFolder(dir));
    // Held open for the store's life, never closed: while it is open, no folder
    // put in its place can have its identity, so `confirmAbsent` cannot be
    // fooled by a file system that hands out a freed inode number again.
    const objects = fstatSync(privateFolder(this.#objects));
    this.#objectsDevice = objects.dev;
    this.#objectsInode = objects.ino;
  }

  /**
   * The answer for a key at which no file is found: nothing is stored there, as
   * long as the objects folder this store opened is still in place. If it was
   * deleted or replaced, the store no longer knows, and says so.
   */
  async confirmAbsent(): Promise<null> {
    try {
      const objects = await stat(this.#objects);
      if (objects.dev === this.#objectsDevice && objects.ino === this.#objectsInode) return null;
    } catch {
      // Gone: answered below.
    }
    throw failure("FOLDER_MISSING");
  }

  /** The key's file, or `null` for a key that is not canonical. */
  path(key: string): string | null {
    if (key.length === 0 || key.includes("\0") || !isCanonicalStorageKey(key)) return null;
    return join(this.#objects, ...key.split("/"));
  }

  /** A fresh private file in the folder, beside the objects it may become. */
  async stage(write: (path: string) => Promise<void>): Promise<string> {
    const path = join(this.#staging, randomUUID());
    try {
      await write(path);
    } catch (error) {
      await removeQuietly(path);
      throw error;
    }
    return path;
  }

  /** Move a staged file onto the key, replacing what is there. */
  async replace(file: string, staged: string): Promise<void> {
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await rename(staged, file);
    } catch (error) {
      await removeQuietly(staged);
      throw error;
    }
  }

  /** Link a staged file onto the key unless it is taken; `false` when taken. */
  async publishIfAbsent(file: string, staged: string): Promise<boolean> {
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await link(staged, file);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    } finally {
      await removeQuietly(staged);
    }
  }

  /** The open file and its size, or `null` when nothing is stored there. */
  async openRead(file: string): Promise<{ handle: FileHandle; size: number } | null> {
    let handle: FileHandle;
    try {
      // Non-blocking, so a pipe left in the folder cannot hang the open.
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (isAbsent(error) || errorCode(error) === "EISDIR") return this.confirmAbsent();
      throw error;
    }
    let isFile: boolean;
    let isDirectory: boolean;
    let size: number;
    try {
      const stats = await handle.stat();
      [isFile, isDirectory, size] = [stats.isFile(), stats.isDirectory(), stats.size];
    } catch (error) {
      await closeQuietly(handle);
      throw error;
    }
    if (isFile) return { handle, size };
    await closeQuietly(handle);
    // A folder holds other keys, so nothing is stored at this one. Anything
    // else is nothing this store wrote, and proves nothing about the key.
    if (isDirectory) return this.confirmAbsent();
    throw failure("NOT_AN_OBJECT");
  }

  /** Whether an object is stored at the key's file, by `openRead`'s rules. */
  async holds(file: string): Promise<boolean> {
    let stats: Stats;
    try {
      stats = await stat(file);
    } catch (error) {
      if (!isAbsent(error)) throw error;
      await this.confirmAbsent();
      return false;
    }
    if (stats.isFile()) return true;
    if (!stats.isDirectory()) throw failure("NOT_AN_OBJECT");
    await this.confirmAbsent();
    return false;
  }

  /** An upload's folder, or `null` for an id this folder never issued. */
  upload(uploadId: string): string | null {
    return UPLOAD_ID.test(uploadId) ? join(this.#uploads, uploadId) : null;
  }

  async newUpload(key: string): Promise<string> {
    const uploadId = randomUUID();
    const dir = join(this.#uploads, uploadId);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "key"), key, { flag: "wx", mode: 0o600 });
    return uploadId;
  }
}

/** A body that reads the open file in bounded chunks and closes it at the end. */
function fileBody(handle: FileHandle): S3ObjectBody {
  let state: "OPEN" | "ENDED" | "CANCELLED" = "OPEN";
  return {
    async read(): Promise<Uint8Array | null> {
      if (state === "ENDED") return null;
      if (state === "CANCELLED") throw new SharedFolderStorageError(500, "BodyCancelled");
      try {
        const chunk = new Uint8Array(SHARED_FOLDER_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead > 0) return chunk.subarray(0, bytesRead);
      } catch {
        state = "CANCELLED";
        await closeQuietly(handle);
        throw new SharedFolderStorageError(500, "BodyReadFailed");
      }
      state = "ENDED";
      await closeQuietly(handle);
      return null;
    },
    async cancel(): Promise<void> {
      if (state !== "OPEN") return;
      state = "CANCELLED";
      await closeQuietly(handle);
    },
  };
}

export function createSharedFolderStorage(
  options: SharedFolderStorageOptions,
): SharedFolderStorage {
  // The given value cannot vouch for the ambient one: either says production.
  for (const nodeEnv of [options.nodeEnv, process.env.NODE_ENV]) {
    assertNotProduction(
      "SharedFolderStorage",
      "objects are kept in a folder on one machine's disk, for development and CI",
      "configure the Google Cloud Storage adapter",
      { nodeEnv },
    );
  }
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    throw new AppError("CONFIGURATION_ERROR", "The shared storage folder must be an absolute path");
  }
  let folder: Folder;
  try {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    folder = new Folder(realpathSync(options.root));
  } catch (error) {
    // The web app opens the folder inside a request, so this message reaches
    // its logs: the code, never the path.
    throw new AppError(
      "CONFIGURATION_ERROR",
      `The shared storage folder could not be opened (${errorCode(error)})`,
    );
  }
  return {
    objectStorage: createObjectStorageView(folder, options),
    objectClient: createObjectClientView(folder),
  };
}

// ---------------------------------------------------------------------------
// The web app's view
// ---------------------------------------------------------------------------

function createObjectStorageView(
  folder: Folder,
  options: SharedFolderStorageOptions,
): ObjectStorage {
  const basePath = options.basePath ?? "/api/storage";
  const now = options.now ?? (() => new Date());
  const secret = options.secret;

  // A defect in the caller, never a customer's doing: every key is built by the
  // application. Neither message names the key or the folder.
  const fileOf = (key: string): string => {
    const file = folder.path(key);
    if (file === null) {
      throw new AppError("INTERNAL_ERROR", "A stored object's key must be canonical");
    }
    return file;
  };
  const failed = (operation: string, error: unknown): AppError =>
    new AppError(
      "INTERNAL_ERROR",
      `The shared storage folder could not ${operation} an object (${errorCode(error)})`,
    );

  // The signer refuses an internal-only key (ADR-0074); the executor turns that
  // into a rejected promise, as the port promises.
  const sign = (key: string, purpose: SignedPurpose, ttlSeconds: number): Promise<SignedUrl> =>
    new Promise((resolve) =>
      resolve(signedStorageUrl({ key, purpose, ttlSeconds, secret, basePath, now: now() })),
    );

  return {
    createSignedUploadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
      return sign(key, "upload", ttlSeconds);
    },

    createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
      return sign(key, "download", ttlSeconds);
    },

    async putObject(key: string, data: Uint8Array): Promise<void> {
      const file = fileOf(key);
      try {
        const staged = await folder.stage((path) =>
          writeFile(path, data, { flag: "wx", mode: 0o600 }),
        );
        await folder.replace(file, staged);
      } catch (error) {
        throw failed("store", error);
      }
    },

    async getObject(key: string): Promise<Uint8Array | null> {
      const file = fileOf(key);
      let opened: Awaited<ReturnType<Folder["openRead"]>>;
      try {
        opened = await folder.openRead(file);
      } catch (error) {
        throw failed("read", error);
      }
      if (opened === null) return null;
      try {
        return new Uint8Array(await readFile(opened.handle));
      } catch (error) {
        throw failed("read", error);
      } finally {
        await closeQuietly(opened.handle);
      }
    },

    async deleteObject(key: string): Promise<void> {
      const file = fileOf(key);
      try {
        await rm(file, { force: true });
      } catch (error) {
        if (!isAbsent(error) && errorCode(error) !== RM_FOLDER_CODE) throw failed("delete", error);
      }
    },

    async exists(key: string): Promise<boolean> {
      const file = fileOf(key);
      try {
        return await folder.holds(file);
      } catch (error) {
        throw failed("check", error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The worker's view
// ---------------------------------------------------------------------------

function createObjectClientView(folder: Folder): SharedFolderObjectClient {
  /** Every call names this folder's bucket, no owner, and a canonical key. */
  const fileOf = (input: {
    readonly bucket: string;
    readonly key: string;
    readonly expectedBucketOwner: string | undefined;
  }): string => {
    if (input.bucket !== SHARED_FOLDER_STORAGE_BUCKET) {
      throw new SharedFolderStorageError(404, "NoSuchBucket");
    }
    // A folder has no owner to check; a caller that asks for one is told so
    // rather than given an object the check would not have covered.
    if (input.expectedBucketOwner !== undefined) {
      throw new SharedFolderStorageError(403, "AccessDenied");
    }
    const file = folder.path(input.key);
    if (file === null) throw new SharedFolderStorageError(400, "InvalidKey");
    return file;
  };

  /** The upload's folder, once its recorded key matches; `null` when gone. */
  const uploadOf = async (uploadId: string, key: string): Promise<string | null> => {
    const dir = folder.upload(uploadId);
    if (dir === null) throw new SharedFolderStorageError(404, "NoSuchUpload");
    let recorded: string;
    try {
      recorded = await readFile(join(dir, "key"), "utf8");
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
    if (recorded !== key) throw new SharedFolderStorageError(404, "NoSuchUpload");
    return dir;
  };

  // Every other failure leaves as a bare 500: a file system error's message is
  // its path, and the seams discard the rejection unread anyway.
  const seam = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SharedFolderStorageError) throw error;
      throw new SharedFolderStorageError(500, "InternalError", errorCode(error));
    }
  };

  return {
    createMultipartUpload(
      input: S3CreateMultipartUploadInput,
    ): Promise<S3CreateMultipartUploadResult> {
      return seam(async () => {
        fileOf(input);
        return { uploadId: await folder.newUpload(input.key) };
      });
    },

    uploadPart(input: S3UploadPartInput): Promise<S3UploadPartResult> {
      return seam(async () => {
        fileOf(input);
        if (
          !Number.isInteger(input.partNumber) ||
          input.partNumber < 1 ||
          input.partNumber > MAX_PART_NUMBER
        ) {
          throw new SharedFolderStorageError(400, "InvalidArgument");
        }
        // As S3 does: a part whose checksum does not match its bytes is refused.
        if (sha256(input.body, "base64") !== input.checksumSha256Base64) {
          throw new SharedFolderStorageError(400, "BadDigest");
        }
        const dir = await uploadOf(input.uploadId, input.key);
        if (dir === null) throw new SharedFolderStorageError(404, "NoSuchUpload");
        // A part uploaded again replaces the first, as on S3.
        const staged = join(dir, `incoming-${randomUUID()}`);
        await writeFile(staged, input.body, { flag: "wx", mode: 0o600 });
        await rename(staged, join(dir, `part-${input.partNumber}`));
        return { etag: `"${sha256(input.body, "hex")}"` };
      });
    },

    completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void> {
      return seam(async () => {
        const file = fileOf(input);
        // Only the conditional completion exists here: anything else would be
        // an overwrite of a canonical object, which nothing may ask for.
        if (input.ifNoneMatch !== "*") throw new SharedFolderStorageError(501, "NotImplemented");
        const dir = await uploadOf(input.uploadId, input.key);
        if (dir === null) throw new SharedFolderStorageError(404, "NoSuchUpload");
        if (input.parts.length === 0) throw new SharedFolderStorageError(400, "MalformedXML");

        let previous = 0;
        for (const part of input.parts) {
          if (part.partNumber <= previous) {
            throw new SharedFolderStorageError(400, "InvalidPartOrder");
          }
          previous = part.partNumber;
        }

        // One part in memory at a time: each is read once, checked against the
        // tag and checksum the caller holds, and those same bytes are appended.
        const staged = await folder.stage(async (path) => {
          const handle = await open(path, "wx", 0o600);
          try {
            let written = 0;
            for (const part of input.parts) {
              let bytes: Uint8Array;
              try {
                bytes = await readFile(join(dir, `part-${part.partNumber}`));
              } catch (error) {
                if (isAbsent(error)) throw new SharedFolderStorageError(400, "InvalidPart");
                throw error;
              }
              if (
                part.etag !== `"${sha256(bytes, "hex")}"` ||
                part.checksumSha256Base64 !== sha256(bytes, "base64")
              ) {
                throw new SharedFolderStorageError(400, "InvalidPart");
              }
              await handle.writeFile(bytes);
              written += bytes.byteLength;
            }
            if ((await handle.stat()).size !== written) throw failure("SHORT_WRITE");
          } catch (error) {
            await closeQuietly(handle);
            throw error;
          }
          // A close that fails may have lost the bytes, so it fails the completion.
          await handle.close();
        });
        // The upload stays when it loses, as on S3; the sink aborts it.
        if (!(await folder.publishIfAbsent(file, staged))) {
          throw new SharedFolderStorageError(412, "PreconditionFailed");
        }
        // Published: a leftover part can no longer change what was stored.
        await removeQuietly(dir);
      });
    },

    abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void> {
      return seam(async () => {
        fileOf(input);
        // Aborting an upload that is already gone changes nothing.
        const dir = await uploadOf(input.uploadId, input.key);
        if (dir !== null) await removeQuietly(dir);
      });
    },

    getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
      return seam(async () => {
        const opened = await folder.openRead(fileOf(input));
        // The one absence the seam reports: nothing is stored at the key.
        if (opened === null) return { contentLength: null, body: null };
        return { contentLength: opened.size, body: fileBody(opened.handle) };
      });
    },

    putObjectIfAbsent(input): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }> {
      return seam(async () => {
        const file = fileOf(input);
        const staged = await folder.stage(async (path) => {
          await copyFile(input.localPath, path, constants.COPYFILE_EXCL);
          // A copy takes its source's mode; a stored object is this user's alone.
          await chmod(path, 0o600);
        });
        return (await folder.publishIfAbsent(file, staged))
          ? { kind: "CREATED" as const }
          : { kind: "ALREADY_EXISTS" as const };
      });
    },
  };
}
