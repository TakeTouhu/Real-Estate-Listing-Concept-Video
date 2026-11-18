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
import { AppError } from "@app/shared";
import { signedStorageUrl, type SignedPurpose } from "../signing";

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
 * - **The last write wins.** A put replaces what is stored, as the port's
 *   callers expect.
 * - **A refusal names nothing.** Its message is its code alone: no bucket, no
 *   key, no host and nothing the store said.
 * - **Nothing is asked again.** A request that fails is not retried.
 * - **A streamed read reads one generation.** It asks the object's size and
 *   generation, then that generation's bytes alone, as the caller pulls them
 *   (ADR-0157).
 *
 * Nothing constructs it yet: the change that wires it does (RD-3c).
 *
 * It sends no credential: as written it can speak only to a store that asks
 * for none, such as the emulator the tests use.
 */

/**
 * The milliseconds a question that moves no object's bytes is given to be
 * answered in full: `exists`, the list that proves a bucket after a `404`, and
 * the size and generation a streamed read asks first. A setting of gaxios's
 * own, which keeps the deadline; none is written here (ADR-0156 Decision 3,
 * ADR-0157). A put, a delete, a whole object's read and a streamed read's bytes
 * are given none.
 */
export const GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS = 3_000;

/** The most bytes Cloud Storage takes in an object's name. */
export const GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES = 1024;

/**
 * Lowercase letters, digits, `-`, `_` and `.`, 3 to 63 of them, beginning and
 * ending with a letter or a digit. Every name Cloud Storage allows of at most
 * 63 characters, and some it refuses (an address such as `192.168.5.4`, a name
 * beginning `goog`), which no bucket can have; none can reach another path.
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

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
 * - `STORAGE_FORBIDDEN`: `401` or `403`;
 * - `STORAGE_RATE_LIMITED`: `429`;
 * - `STORAGE_UNAVAILABLE`: a `5xx`;
 * - `STORAGE_BUCKET_MISSING`: the bucket answered `404`;
 * - `STORAGE_OBJECT_CHANGED`: the object was written again between a streamed
 *   read's two requests;
 * - `STORAGE_REFUSED`: any other status;
 * - `STORAGE_UNEXPECTED_ANSWER`: an answer that cannot be read, proves nothing,
 *   or is not the bytes asked for;
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
      const { name, code } = current as { readonly name?: unknown; readonly code?: unknown };
      // node-fetch ends an aborted request with an `AbortError`; only a limit aborts one here.
      if (name === "AbortError" || name === "TimeoutError" || code === "AbortError" || code === "TimeoutError") {
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

export function createGoogleCloudStorage(options: GoogleCloudStorageOptions): ObjectStorage {
  if (typeof options.bucket !== "string" || !BUCKET_NAME.test(options.bucket)) {
    throw configurationError("The storage bucket must be named by Cloud Storage's rules");
  }
  const origin = originOf(options.endpoint);
  const bucketUrl = `${origin}/storage/v1/b/${escape(options.bucket)}`;
  const uploadUrl = `${origin}/upload/storage/v1/b/${escape(options.bucket)}/o`;
  const basePath = options.basePath ?? "/api/storage";
  const now = options.now ?? (() => new Date());
  const secret = options.secret;

  // Every status is read here, nothing is asked twice, and a redirect is a refusal, never followed.
  const http = new Gaxios({ retry: false, validateStatus: () => true, redirect: "manual" });
  const ask = async (request: GaxiosOptions): Promise<GaxiosResponse<unknown>> => {
    try {
      return await http.request<unknown>(request);
    } catch (error) {
      throw new GoogleCloudStorageError(transportCode(error));
    }
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

  return {
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
}
