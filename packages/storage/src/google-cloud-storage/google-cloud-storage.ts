import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Gaxios, type GaxiosOptions, type GaxiosResponse } from "gaxios";
import {
  isCanonicalStorageKey,
  resolveObjectByteRange,
  type ObjectByteRange,
  type ObjectRead,
  type ObjectStorage,
  type SignedDownloadOptions,
  type SignedUrl,
} from "@app/domain";
import { AppError, GOOGLE_CLOUD_STORAGE_ORIGIN, isCloudStorageBucketName } from "@app/shared";
import type { DeliverableObjectClient } from "../managed-output/deliverable-composition-io";
import type {
  S3AbortMultipartUploadInput,
  S3CompleteMultipartUploadInput,
  S3CompletedPartRef,
  S3CreateMultipartUploadInput,
  S3CreateMultipartUploadResult,
  S3GetObjectInput,
  S3GetObjectResult,
  S3MultipartClient,
  S3ObjectBody,
  S3UploadPartInput,
  S3UploadPartResult,
} from "../managed-output/s3-staging-sink";
import { signedStorageUrl, type SignedPurpose } from "../signing";
import { METADATA_SERVER_ORIGIN, metadataAccessToken } from "./access-token";
import { googleCloudStorageClient } from "./client";

/**
 * Object storage in one Google Cloud Storage bucket, spoken to over the Cloud
 * Storage JSON API through gaxios (ADR-0156).
 *
 * - **The links are the application's own.** A signed URL is made by
 *   `signedStorageUrl`, served under `/api/storage` as for every other store;
 *   the bucket is never given a URL a browser can use.
 * - **A key is an object, never anything else.** Only a canonical key that
 *   Cloud Storage can name is sent (ADR-0074).
 * - **Absence is proved, never assumed.** A missing object and a missing
 *   bucket answer the same `404`, so absence is counted only from a list in
 *   the bucket, which answers `404` for the bucket alone.
 * - **The last write wins for the web app, the first for the worker.** A put
 *   replaces what is stored, as the port's callers expect; the worker's view
 *   stores a file only where nothing is stored yet (ADR-0160).
 * - **A refusal names nothing.** Its message is its code alone: no bucket, no
 *   key, no host and nothing the store said.
 * - **Nothing is asked again.** A request that fails is not retried.
 * - **A streamed read reads one generation.** It asks the object's size and
 *   generation, then that generation's bytes alone, as the caller pulls them
 *   (ADR-0157).
 * - **A token goes to Google alone.** Google's own store is sent the token of
 *   the service account the process runs as, from the metadata server; any
 *   other store, such as the emulator the tests use, is sent none (ADR-0158).
 * - **Every request goes straight to its origin**, on connections of the
 *   adapter's own, never through a proxy (ADR-0158).
 *
 * The web app's adapters construct it (`apps/web/src/lib/adapters.ts`, ADR-0159),
 * and the development pipeline's assembly, on an emulator alone (ADR-0162).
 * `createGoogleCloudStorageViews` also gives the worker's view, on the same
 * connections and token, for the worker to be given it (ADR-0160): its reads,
 * its first-wins write, and the staging sink's multipart upload as one
 * resumable upload (ADR-0161).
 */

/**
 * The milliseconds a question that moves no object's bytes is given to be
 * answered in full: `exists`, the list that proves a bucket after a `404`, the
 * size and generation a streamed read asks first, and a resumable upload's
 * start and cancel (ADR-0161). A setting of gaxios's own, which keeps the
 * deadline; none is written here (ADR-0156 Decision 3, ADR-0157). A put, an
 * object's delete, a whole object's read, a streamed read's bytes and an
 * upload's chunks are given none.
 */
export const GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS = 3_000;

/** The most bytes Cloud Storage takes in an object's name. */
export const GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES = 1024;

/** Every chunk of a resumable upload but its last is a whole number of these, by Google's rule: 256 KiB. */
export const GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES = 256 * 1024;

/** A code named by the transport: one plain word, as Node.js's are. */
const TRANSPORT_CODE = /^[A-Z0-9][A-Z0-9_]{0,39}$/;

/** An object's size, a decimal string in the JSON API. */
const SIZE = /^(0|[1-9][0-9]*)$/;

/** A generation, a decimal string never read as a number: it can pass 2^53. Never `0`, which pins nothing. */
const GENERATION = /^[1-9][0-9]*$/;

export interface GoogleCloudStorageOptions {
  /** The bucket, by Cloud Storage's naming rules. */
  readonly bucket: string;
  /** The store's origin, `http` or `https`, with no path. */
  readonly endpoint: string;
  /** HMAC secret used to sign storage tokens. Server-side only. */
  readonly secret: string;
  /** Base path that serves signed objects, e.g. "/api/storage". */
  readonly basePath?: string;
  readonly now?: () => Date;
}

/**
 * A request the store did not answer as asked. The message is the code:
 *
 * - `STORAGE_TIMEOUT`: a question was not answered within its limit;
 * - `STORAGE_CREDENTIAL_UNAVAILABLE`: no token could be had for Google's
 *   store, and nothing was sent to it;
 * - `STORAGE_FORBIDDEN`: `401` or `403`;
 * - `STORAGE_RATE_LIMITED`: `429`;
 * - `STORAGE_UNAVAILABLE`: a `5xx`;
 * - `STORAGE_BUCKET_MISSING`: the bucket answered `404`;
 * - `STORAGE_OBJECT_CHANGED`: the object was written again between a streamed
 *   read's two requests;
 * - `STORAGE_REFUSED`: any other status;
 * - `STORAGE_UNEXPECTED_ANSWER`: an answer that cannot be read, proves nothing,
 *   or is not the bytes asked for;
 * - `STORAGE_BODY_CANCELLED`: a worker's read of a body it cancelled;
 * - `STORAGE_FILE_CHANGED`: a worker's file read short of its size as it was
 *   hashed, or shorter, as it was sent, than when it was hashed;
 * - `STORAGE_PRECONDITION_FAILED`: a worker's upload the store refused, `412`,
 *   because an object was stored at its key first; it carries that status as
 *   the staging sink reads one (ADR-0161);
 * - `STORAGE_UNKNOWN_UPLOAD`: an upload this store did not start, or not for
 *   that key, or one let go by a cancel or a publish (a cancel of an upload
 *   not held does nothing);
 * - `STORAGE_UPLOAD_BUSY`: a part or a completion of an upload while one of
 *   its chunks is unanswered (a cancel is always taken);
 * - `STORAGE_UPLOAD_FAILED`: a part or a completion of an upload once a
 *   request on it failed (a cancel is always taken);
 * - `STORAGE_PART_REFUSED`: a part out of order, empty, or whose checksum is
 *   not its bytes'; a part after one that is not a whole number of 256 KiB;
 *   or a completion naming other parts than those taken, or none;
 * - the transport's own one-word code, such as `ECONNREFUSED`;
 * - `STORAGE_UNREACHABLE`: a failure that names none.
 */
export class GoogleCloudStorageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GoogleCloudStorageError";
    this.code = code;
  }
}

/**
 * A worker's upload the store refused for its precondition: an object was
 * stored at its key first. Shaped as the staging sink reads a lost race, by the
 * status in `$metadata` (ADR-0161).
 */
class GoogleCloudStoragePreconditionFailed extends GoogleCloudStorageError {
  readonly $metadata: { readonly httpStatusCode: 412 } = { httpStatusCode: 412 };

  constructor() {
    super("STORAGE_PRECONDITION_FAILED");
  }
}

function statusFailure(status: number): GoogleCloudStorageError {
  if (status === 401 || status === 403) return new GoogleCloudStorageError("STORAGE_FORBIDDEN");
  if (status === 429) return new GoogleCloudStorageError("STORAGE_RATE_LIMITED");
  if (status >= 500) return new GoogleCloudStorageError("STORAGE_UNAVAILABLE");
  return new GoogleCloudStorageError("STORAGE_REFUSED");
}

/** The code of a request that failed before it was answered, read from the error and what caused it. */
function transportCode(error: unknown): string {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { name, code, type } = current as {
        readonly name?: unknown;
        readonly code?: unknown;
        readonly type?: unknown;
      };
      // node-fetch ends an aborted request with an `AbortError` of type `aborted`; only a limit aborts one
      // here. A production build renames the class, so its type is read too (ADR-0158 Decision 7).
      if (
        name === "AbortError" ||
        name === "TimeoutError" ||
        code === "AbortError" ||
        code === "TimeoutError" ||
        type === "aborted"
      ) {
        return "STORAGE_TIMEOUT";
      }
      if (typeof code === "string" && TRANSPORT_CODE.test(code)) return code;
      current = (current as { readonly cause?: unknown }).cause;
    }
  } catch {
    // An error that cannot be read names nothing.
  }
  return "STORAGE_UNREACHABLE";
}

/** A path segment or query value with every character that is not unreserved escaped. */
function escape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function configurationError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

/** The endpoint's origin. Neither refusal names what was given. */
function originOf(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // Node's error carries the whole address it was given.
    throw configurationError("The storage endpoint must be an http or https origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw configurationError("The storage endpoint must be an http or https origin");
  }
  return url.origin;
}

/** The first name a list answered, `null` when it answered none; throws when the answer proves nothing. */
function firstListedName(body: unknown): string | null {
  let parsed: unknown;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
  }
  const { items, nextPageToken } = parsed as { readonly items?: unknown; readonly nextPageToken?: unknown };
  if (items !== undefined && !Array.isArray(items)) throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
  const first: unknown = items?.[0];
  if (first === undefined) {
    // A page with nothing on it, and more to come, proves no absence.
    if (nextPageToken !== undefined) throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
    return null;
  }
  const name = typeof first === "object" && first !== null ? (first as { readonly name?: unknown }).name : undefined;
  if (typeof name !== "string") throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
  return name;
}

/**
 * The size and generation an object's metadata names. Throws when it names
 * them otherwise than Cloud Storage does, or names an encoding: an encoded
 * object is served decoded and whole, whatever range is asked, so its size
 * counts other bytes than those served (ADR-0157).
 */
function storedObjectOf(body: unknown): { readonly size: number; readonly generation: string } {
  let parsed: unknown;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
  }
  const { size, generation, contentEncoding } = parsed as {
    readonly size?: unknown;
    readonly generation?: unknown;
    readonly contentEncoding?: unknown;
  };
  if (
    typeof size !== "string" ||
    !SIZE.test(size) ||
    !Number.isSafeInteger(Number(size)) ||
    typeof generation !== "string" ||
    !GENERATION.test(generation) ||
    (contentEncoding !== undefined && contentEncoding !== "identity")
  ) {
    throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
  }
  return { size: Number(size), generation };
}

/**
 * Whether a media answer holds the bytes asked for, as stored: the range, or
 * the whole object answered whole; of the generation asked, when it names one;
 * as many bytes as asked, when it says how many; and not encoded.
 */
function isAskedBytes(
  answer: GaxiosResponse<unknown>,
  asked: { readonly start: number; readonly length: number; readonly size: number; readonly generation: string },
): boolean {
  const { status, headers } = answer;
  const last = asked.start + asked.length - 1;
  const ranged =
    status === 206
      ? headers.get("content-range") === `bytes ${asked.start}-${last}/${asked.size}`
      : status === 200 && asked.start === 0 && asked.length === asked.size;
  const length = headers.get("content-length");
  const encoding = headers.get("content-encoding");
  const generation = headers.get("x-goog-generation");
  return (
    ranged &&
    (length === null || length === String(asked.length)) &&
    (encoding === null || encoding === "identity") &&
    (generation === null || generation === asked.generation)
  );
}

/** A stream of no bytes, already ended. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * The `length` bytes an answer carries, as a stream read only as the caller
 * pulls: one read of the answer, all it holds then, for each pull, and none
 * before the first.
 * It ends once it has handed over exactly `length` bytes, whether or not the
 * answer has ended; an answer that ends short of them, brings a chunk past
 * them or fails errors it with a code alone. The answer is let go at the
 * stream's end, on cancel and on failure (ADR-0157).
 */
function answerStream(body: Readable, length: number): ReadableStream<Uint8Array> {
  let chunks: AsyncIterator<unknown> | undefined;
  let received = 0;
  let released = false;
  // Destroying the answer lets its connection go in every state: a pull
  // waiting, nothing read, or every byte arrived.
  const release = (): void => {
    if (released) return;
    released = true;
    body.destroy();
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, code: string): void => {
    release();
    controller.error(new GoogleCloudStorageError(code));
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: IteratorResult<unknown>;
        try {
          chunks ??= body[Symbol.asyncIterator]();
          next = await chunks.next();
        } catch (error) {
          // Once cancelled, the reader has gone: what the release ended is no failure.
          if (!released) fail(controller, transportCode(error));
          return;
        }
        if (released) return;
        // Every byte asked for closes the stream when it is handed over, so an end now is short of them.
        if (next.done === true) {
          fail(controller, "STORAGE_UNEXPECTED_ANSWER");
          return;
        }
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array) || received + chunk.byteLength > length) {
          fail(controller, "STORAGE_UNEXPECTED_ANSWER");
          return;
        }
        received += chunk.byteLength;
        controller.enqueue(chunk);
        // The last byte is handed over: the answer is let go now, not on a later pull.
        if (received === length) {
          release();
          controller.close();
        }
      },
      cancel() {
        release();
      },
    },
    // Nothing is taken from the answer before the reader asks for it.
    { highWaterMark: 0 },
  );
}

/**
 * The worker's view of the bucket: the reads and the first-wins write its
 * managed output makes (ADR-0160), and the staging sink's multipart upload
 * (ADR-0161), in the shape the shared folder gives it.
 */
export type GoogleCloudStorageObjectClient = DeliverableObjectClient & S3MultipartClient;

/**
 * One multipart upload, as the adapter keeps it: one resumable upload session
 * (ADR-0161). Its URI lets anyone who holds it write to the bucket, so it never
 * leaves the adapter: the sink is given a random id in its place.
 */
interface ResumableUpload {
  readonly name: string;
  /** The session's URI; `null` when the store refused to start it for its precondition. */
  readonly uri: string | null;
  /** `LOST` once the store refused it for its precondition; `FAILED` once a request on it failed. */
  state: "OPEN" | "LOST" | "FAILED";
  /** A request on it is unanswered. */
  busy: boolean;
  /** The bytes the store has taken: they run from the first to this one. */
  offset: number;
  /** The last part taken, a copy, sent when the next comes or at completion; `null` before the first. */
  held: Buffer | null;
  /** The MD5 of every part taken, in order: the object's, sent with its last bytes. */
  readonly md5: Hash;
  readonly parts: S3CompletedPartRef[];
}

/** The two views of one bucket, on one set of connections and one token. */
export interface GoogleCloudStorageViews {
  readonly objectStorage: ObjectStorage;
  readonly objectClient: GoogleCloudStorageObjectClient;
}

/**
 * A stream as the worker's body: one chunk for each `read`, `null` at its end.
 * A read once it is cancelled, or still waiting when it is, is refused, not
 * answered with an end, which would read as an object shorter than it is.
 */
function pulledBody(stream: ReadableStream<Uint8Array>): S3ObjectBody {
  const reader = stream.getReader();
  let cancelled = false;
  return {
    async read(): Promise<Uint8Array | null> {
      if (cancelled) throw new GoogleCloudStorageError("STORAGE_BODY_CANCELLED");
      const next = await reader.read();
      // A cancel while this read waited ends the stream: that end is not the object's.
      if (cancelled) throw new GoogleCloudStorageError("STORAGE_BODY_CANCELLED");
      return next.done ? null : next.value;
    },
    async cancel(): Promise<void> {
      if (cancelled) return;
      cancelled = true;
      try {
        await reader.cancel();
      } catch {
        // A stream that already failed has let its answer go.
      }
    },
  };
}

/**
 * A local file's size and MD5, read before it is sent: the MD5 travels with
 * it, so Cloud Storage refuses bytes that are not those read here, by its
 * documents; the emulator does not check (ADR-0160). A file read short of
 * its size as it is hashed is refused before anything is sent. A failure
 * names no path.
 */
async function fileToSend(path: string): Promise<{ readonly size: number; readonly md5: string }> {
  const hash = createHash("md5");
  let size: number;
  let hashed = 0;
  try {
    ({ size } = await stat(path));
    if (size > 0) {
      for await (const chunk of createReadStream(path, { start: 0, end: size - 1 })) {
        hashed += (chunk as Buffer).byteLength;
        hash.update(chunk as Buffer);
      }
    }
  } catch (error) {
    throw new GoogleCloudStorageError(transportCode(error));
  }
  if (hashed !== size) throw new GoogleCloudStorageError("STORAGE_FILE_CHANGED");
  return { size, md5: hash.digest("base64") };
}

/**
 * The file's first `size` bytes as they are sent, the file opened only once
 * the first is asked for, and closed with the stream. A file shorter now than
 * when it was hashed fails the upload, which would otherwise wait for bytes
 * that never come; one longer sends only as many bytes as were hashed.
 */
function sentFile(path: string, size: number): Readable {
  return Readable.from(
    (async function* (): AsyncGenerator<Buffer> {
      let sent = 0;
      for await (const chunk of createReadStream(path, { start: 0, end: size - 1 })) {
        sent += (chunk as Buffer).byteLength;
        yield chunk as Buffer;
      }
      if (sent !== size) throw new GoogleCloudStorageError("STORAGE_FILE_CHANGED");
    })(),
    { objectMode: false },
  );
}

export function createGoogleCloudStorage(options: GoogleCloudStorageOptions): ObjectStorage {
  return createGoogleCloudStorageViews(options).objectStorage;
}

export function createGoogleCloudStorageViews(options: GoogleCloudStorageOptions): GoogleCloudStorageViews {
  // The rule the environment's schema applies too (ADR-0159); the one origin a token is sent to is
  // Google's own store (ADR-0158 Decision 2). Both are `@app/shared`'s.
  if (typeof options.bucket !== "string" || !isCloudStorageBucketName(options.bucket)) {
    throw configurationError("The storage bucket must be named by Cloud Storage's rules");
  }
  const origin = originOf(options.endpoint);
  const bucketUrl = `${origin}/storage/v1/b/${escape(options.bucket)}`;
  const uploadUrl = `${origin}/upload/storage/v1/b/${escape(options.bucket)}/o`;
  const basePath = options.basePath ?? "/api/storage";
  const now = options.now ?? (() => new Date());
  const secret = options.secret;

  // Every status is read here, nothing is asked twice, and a redirect is a refusal, never followed.
  const http = googleCloudStorageClient();
  const credential =
    origin === GOOGLE_CLOUD_STORAGE_ORIGIN ? metadataAccessToken(http, METADATA_SERVER_ORIGIN, now) : null;
  const ask = async (request: GaxiosOptions): Promise<GaxiosResponse<unknown>> => {
    // Had before the request, outside its `try`: a missing token is its own failure.
    const token = credential === null ? undefined : await credential.get();
    if (token === null) throw new GoogleCloudStorageError("STORAGE_CREDENTIAL_UNAVAILABLE");
    const sent =
      token === undefined
        ? request
        : { ...request, headers: Gaxios.mergeHeaders(request.headers, { authorization: `Bearer ${token}` }) };
    let response: GaxiosResponse<unknown>;
    try {
      response = await http.request<unknown>(sent);
    } catch (error) {
      throw new GoogleCloudStorageError(transportCode(error));
    }
    // A token the store no longer takes is let go, so the next request has another; this one is not asked again.
    if (token !== undefined && response.status === 401) credential?.drop(token);
    return response;
  };

  // A defect in the caller, never a customer's doing: every key is built by the
  // application. The message names no key.
  const nameOf = (key: string): string => {
    if (
      !isCanonicalStorageKey(key) ||
      /[\r\n]/.test(key) ||
      // Half of a surrogate pair is no Unicode, which Cloud Storage names in.
      /\p{Cs}/u.test(key) ||
      Buffer.byteLength(key, "utf8") > GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES
    ) {
      throw new AppError("INTERNAL_ERROR", "A stored object's key must be canonical, and one Cloud Storage can name");
    }
    return key;
  };
  const objectUrl = (name: string): string => `${bucketUrl}/o/${escape(name)}`;

  /**
   * Whether the first object listed under the name is the name itself, which
   * sorts before every longer name it begins. A `404` here is the bucket's: a
   * list names no object.
   */
  const listed = async (name: string): Promise<boolean> => {
    const response = await ask({
      url: `${bucketUrl}/o?prefix=${escape(name)}&maxResults=1`,
      responseType: "text",
      timeout: GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
    });
    if (response.status === 404) throw new GoogleCloudStorageError("STORAGE_BUCKET_MISSING");
    if (response.status !== 200) throw statusFailure(response.status);
    return firstListedName(response.data) === name;
  };

  // The signer refuses an internal-only key (ADR-0074); the executor turns that
  // into a rejected promise, as the port promises.
  const sign = (
    key: string,
    purpose: SignedPurpose,
    ttlSeconds: number,
    attachmentFilename?: string,
  ): Promise<SignedUrl> =>
    new Promise((resolve) =>
      resolve(signedStorageUrl({ key, purpose, ttlSeconds, secret, basePath, now: now(), attachmentFilename })),
    );

  const objectStorage: ObjectStorage = {
    createSignedUploadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
      return sign(key, "upload", ttlSeconds);
    },

    createSignedDownloadUrl(key: string, ttlSeconds: number, options?: SignedDownloadOptions): Promise<SignedUrl> {
      return sign(key, "download", ttlSeconds, options?.attachmentFilename);
    },

    async putObject(key: string, data: Uint8Array): Promise<void> {
      const name = nameOf(key);
      const response = await ask({
        method: "POST",
        url: `${uploadUrl}?uploadType=media&name=${escape(name)}`,
        headers: { "content-type": "application/octet-stream" },
        // A copy: what the caller does with its array afterwards changes nothing stored.
        data: Buffer.from(data),
        responseType: "text",
      });
      if (response.status === 200) return;
      // An upload names no object that could be missing.
      if (response.status === 404) throw new GoogleCloudStorageError("STORAGE_BUCKET_MISSING");
      throw statusFailure(response.status);
    },

    async getObject(key: string): Promise<Uint8Array | null> {
      const name = nameOf(key);
      const response = await ask({ url: `${objectUrl(name)}?alt=media`, responseType: "arraybuffer" });
      if (response.status === 200 && response.data instanceof ArrayBuffer) return new Uint8Array(response.data);
      if (response.status === 200) throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
      if (response.status !== 404) throw statusFailure(response.status);
      // Absent when the read was asked, once the bucket is proved to be there.
      await listed(name);
      return null;
    },

    async deleteObject(key: string): Promise<void> {
      const name = nameOf(key);
      const response = await ask({ method: "DELETE", url: objectUrl(name), responseType: "text" });
      if (response.status === 204 || response.status === 200) return;
      if (response.status !== 404) throw statusFailure(response.status);
      // Nothing to delete, once the bucket is proved to be there.
      await listed(name);
    },

    async readObject(key: string, range: ObjectByteRange | null): Promise<ObjectRead> {
      const name = nameOf(key);
      const metadata = await ask({
        url: `${objectUrl(name)}?fields=size,generation,contentEncoding`,
        responseType: "text",
        timeout: GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
      });
      if (metadata.status === 404) {
        // Absent when the read was asked, once the bucket is proved to be there.
        await listed(name);
        return { kind: "ABSENT" };
      }
      if (metadata.status !== 200) throw statusFailure(metadata.status);
      const { size, generation } = storedObjectOf(metadata.data);
      const bytes = resolveObjectByteRange(range, size);
      if (bytes === null) return { kind: "UNSATISFIABLE", size };
      // No bytes to read: nothing is asked for them.
      if (bytes.length === 0) return { kind: "READ", size, start: bytes.start, length: 0, body: emptyStream() };

      const last = bytes.start + bytes.length - 1;
      const media: GaxiosOptions & { readonly compress: false } = {
        // Pinned to the generation the size is that of: never another object's bytes.
        url: `${objectUrl(name)}?alt=media&generation=${generation}`,
        headers: { range: `bytes=${bytes.start}-${last}`, "accept-encoding": "identity" },
        responseType: "stream",
        // The bytes as they are stored, never decoded.
        compress: false,
      };
      const answer = await ask(media);
      const body: unknown = answer.data;
      if (!(body instanceof Readable)) throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
      if (isAskedBytes(answer, { ...bytes, size, generation })) {
        return { kind: "READ", size, start: bytes.start, length: bytes.length, body: answerStream(body, bytes.length) };
      }
      // An answer not passed on is let go of now, so its connection is not held.
      body.destroy();
      const { status } = answer;
      if (status === 404) {
        // The generation is gone: deleted, or written over.
        if (await listed(name)) throw new GoogleCloudStorageError("STORAGE_OBJECT_CHANGED");
        return { kind: "ABSENT" };
      }
      // A generation's bytes never change, so a range of them that held is never unsatisfiable.
      if ((status >= 200 && status < 300) || status === 416) {
        throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
      }
      throw statusFailure(status);
    },

    exists(key: string): Promise<boolean> {
      return new Promise((resolve) => resolve(listed(nameOf(key))));
    },
  };

  /**
   * The key a worker's request names, once it names this store's bucket and no
   * owner. Cloud Storage checks no bucket's owner: a caller that asks for one
   * is refused, not given an object the check would not have covered. Nothing
   * is sent for either.
   */
  const workerKey = (input: {
    readonly bucket: string;
    readonly key: string;
    readonly expectedBucketOwner: string | undefined;
  }): string => {
    if (input.bucket !== options.bucket || input.expectedBucketOwner !== undefined) {
      throw configurationError("A worker's request must name the store's own bucket, and no owner");
    }
    return nameOf(input.key);
  };

  /** The worker's uploads under way, by the id the sink is given for each. */
  const uploads = new Map<string, ResumableUpload>();
  const uploadPath = new URL(uploadUrl).pathname;

  /**
   * The session a start answered with, once it is at the store's own origin
   * and upload path: it is sent the store's token too. A refusal names nothing
   * of it.
   */
  const sessionUri = (location: string | null): string => {
    let url: URL | null = null;
    try {
      if (location !== null) url = new URL(location);
    } catch {
      // Node's error carries the address it was given.
    }
    if (
      url === null ||
      url.origin !== origin ||
      url.pathname !== uploadPath ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      !url.searchParams.get("upload_id")
    ) {
      throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
    }
    return url.href;
  };

  /** The upload a worker's call names, once it names this store's bucket, no owner and the key it was started for. */
  const uploadOf = (input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly expectedBucketOwner: string | undefined;
  }): ResumableUpload => {
    const name = workerKey(input);
    const upload = uploads.get(input.uploadId);
    if (upload === undefined || upload.name !== name) throw new GoogleCloudStorageError("STORAGE_UNKNOWN_UPLOAD");
    // One request at a time: bytes sent out of order, or twice, would be stored so.
    if (upload.busy) throw new GoogleCloudStorageError("STORAGE_UPLOAD_BUSY");
    if (upload.state === "FAILED") throw new GoogleCloudStorageError("STORAGE_UPLOAD_FAILED");
    return upload;
  };

  /**
   * Sends the held part from where the store's bytes end: the last part with
   * the object's size and MD5, any other with neither. It carries bytes, so it
   * is given no limit. A request that fails leaves the upload failed.
   */
  const sendHeld = async (
    upload: ResumableUpload,
    uri: string,
    held: Buffer,
    last: { readonly size: number; readonly md5: string } | null,
  ): Promise<GaxiosResponse<unknown>> => {
    const end = upload.offset + held.byteLength - 1;
    const headers: Record<string, string> = {
      "content-length": String(held.byteLength),
      "content-range": `bytes ${upload.offset}-${end}/${last === null ? "*" : last.size}`,
    };
    if (last !== null) headers["x-goog-hash"] = `md5=${last.md5}`;
    upload.busy = true;
    try {
      return await ask({ method: "PUT", url: uri, headers, data: held, responseType: "text" });
    } catch (error) {
      upload.state = "FAILED";
      throw error;
    } finally {
      upload.busy = false;
    }
  };

  /** What an answer the upload cannot go on from is: one that is no refusal is unexpected. */
  const failedUpload = (upload: ResumableUpload, status: number): GoogleCloudStorageError => {
    upload.state = "FAILED";
    return status < 400 ? new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER") : statusFailure(status);
  };

  const objectClient: GoogleCloudStorageObjectClient = {
    async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
      const read = await objectStorage.readObject(workerKey(input), null);
      // The seam's one absence: nothing is stored at the key, once the bucket is proved to be there.
      if (read.kind === "ABSENT") return { contentLength: null, body: null };
      // A whole object's range is never unsatisfiable.
      if (read.kind !== "READ") throw new GoogleCloudStorageError("STORAGE_UNEXPECTED_ANSWER");
      return { contentLength: read.size, body: pulledBody(read.body) };
    },

    async putObjectIfAbsent(input): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }> {
      const name = workerKey(input);
      const { size, md5 } = await fileToSend(input.localPath);
      // As many bytes as the MD5 was read from, and no more: bytes changed since are refused by Google's
      // store, by its documents (the emulator does not check).
      const data = size === 0 ? Buffer.alloc(0) : sentFile(input.localPath, size);
      let response: GaxiosResponse<unknown>;
      try {
        response = await ask({
          method: "POST",
          // Generation 0 is no object: the store writes only where none is stored, and answers 412 otherwise.
          url: `${uploadUrl}?uploadType=media&name=${escape(name)}&ifGenerationMatch=0`,
          headers: { "content-type": input.contentType, "content-length": String(size), "x-goog-hash": `md5=${md5}` },
          data,
          responseType: "text",
        });
      } finally {
        // The file is let go however the request ended, sent whole, in part or not at all.
        if (data instanceof Readable) data.destroy();
      }
      if (response.status === 200) return { kind: "CREATED" };
      // Not a failure: what is stored is read back by every caller.
      if (response.status === 412) return { kind: "ALREADY_EXISTS" };
      // An upload names no object that could be missing.
      if (response.status === 404) throw new GoogleCloudStorageError("STORAGE_BUCKET_MISSING");
      throw statusFailure(response.status);
    },

    async createMultipartUpload(input: S3CreateMultipartUploadInput): Promise<S3CreateMultipartUploadResult> {
      const name = workerKey(input);
      const response = await ask({
        method: "POST",
        // Generation 0 is no object: the upload is finished only where none is stored, and answers 412 otherwise.
        url: `${uploadUrl}?uploadType=resumable&name=${escape(name)}&ifGenerationMatch=0`,
        // The seam names no content type: a scene's video is stored as bytes.
        headers: { "content-length": "0", "x-upload-content-type": "application/octet-stream" },
        responseType: "text",
        timeout: GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
      });
      let uri: string | null = null;
      if (response.status === 200) {
        uri = sessionUri(response.headers.get("location"));
      } else if (response.status !== 412) {
        // An upload names no object that could be missing.
        if (response.status === 404) throw new GoogleCloudStorageError("STORAGE_BUCKET_MISSING");
        throw statusFailure(response.status);
      }
      // Refused at the start, the upload takes its parts and drops them, and its completion is refused as a
      // lost race: the sink then reads what is stored, as for a race lost at the end.
      const uploadId = randomUUID();
      uploads.set(uploadId, {
        name,
        uri,
        state: uri === null ? "LOST" : "OPEN",
        busy: false,
        offset: 0,
        held: null,
        md5: createHash("md5"),
        parts: [],
      });
      return { uploadId };
    },

    async uploadPart(input: S3UploadPartInput): Promise<S3UploadPartResult> {
      const upload = uploadOf(input);
      // A copy, whose sum is checked: the sink fills its array again once this returns.
      const part = Buffer.from(input.body);
      const sum = createHash("sha256").update(part).digest();
      if (
        input.partNumber !== upload.parts.length + 1 ||
        part.byteLength === 0 ||
        sum.toString("base64") !== input.checksumSha256Base64
      ) {
        throw new GoogleCloudStorageError("STORAGE_PART_REFUSED");
      }
      const { uri, held } = upload;
      if (upload.state === "OPEN" && uri !== null && held !== null) {
        // The part before this one is not the last, so it goes now, a whole number of 256 KiB by Google's rule.
        if (held.byteLength % GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES !== 0) {
          throw new GoogleCloudStorageError("STORAGE_PART_REFUSED");
        }
        const response = await sendHeld(upload, uri, held, null);
        const end = upload.offset + held.byteLength - 1;
        if (response.status === 308 && response.headers.get("range") === `bytes=0-${end}`) {
          upload.offset = end + 1;
        } else if (response.status === 412) {
          upload.state = "LOST";
        } else {
          // No chunk is sent twice: bytes the store did not keep fail the upload, and the sink starts again.
          throw failedUpload(upload, response.status);
        }
      }
      // Once the race is lost, parts are taken and dropped.
      upload.held = upload.state === "OPEN" ? part : null;
      if (upload.state === "OPEN") upload.md5.update(part);
      const etag = `"${sum.toString("hex")}"`;
      upload.parts.push({ partNumber: input.partNumber, etag, checksumSha256Base64: input.checksumSha256Base64 });
      return { etag };
    },

    async completeMultipartUpload(input: S3CompleteMultipartUploadInput): Promise<void> {
      const upload = uploadOf(input);
      // Only the conditional completion exists: any other could replace a stored object.
      if (input.ifNoneMatch !== "*") {
        throw new AppError("INTERNAL_ERROR", "A worker's upload is finished only where nothing is stored");
      }
      const taken = upload.parts;
      const named = input.parts;
      if (
        named.length === 0 ||
        named.length !== taken.length ||
        named.some((part, index) => {
          const own = taken[index];
          return (
            own === undefined ||
            part.partNumber !== own.partNumber ||
            part.etag !== own.etag ||
            part.checksumSha256Base64 !== own.checksumSha256Base64
          );
        })
      ) {
        throw new GoogleCloudStorageError("STORAGE_PART_REFUSED");
      }
      const { uri, held } = upload;
      if (upload.state === "LOST" || uri === null || held === null) throw new GoogleCloudStoragePreconditionFailed();
      const size = upload.offset + held.byteLength;
      const response = await sendHeld(upload, uri, held, { size, md5: upload.md5.digest("base64") });
      if (response.status === 200 || response.status === 201) {
        // Finished: its URI and its last part are let go.
        uploads.delete(input.uploadId);
        return;
      }
      if (response.status === 412) {
        upload.state = "LOST";
        throw new GoogleCloudStoragePreconditionFailed();
      }
      throw failedUpload(upload, response.status);
    },

    async abortMultipartUpload(input: S3AbortMultipartUploadInput): Promise<void> {
      const name = workerKey(input);
      const upload = uploads.get(input.uploadId);
      // An upload finished, let go, or never started here changes nothing.
      if (upload === undefined) return;
      if (upload.name !== name) throw new GoogleCloudStorageError("STORAGE_UNKNOWN_UPLOAD");
      // Let go first: whatever the store answers, its URI is no longer held.
      uploads.delete(input.uploadId);
      if (upload.uri === null) return;
      const response = await ask({
        method: "DELETE",
        url: upload.uri,
        headers: { "content-length": "0" },
        responseType: "text",
        timeout: GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
      });
      // Google answers a cancel with 499; a session already ended answers 404 or 410.
      if (response.status === 499 || response.status === 404 || response.status === 410) return;
      throw statusFailure(response.status);
    },
  };

  return { objectStorage, objectClient };
}
