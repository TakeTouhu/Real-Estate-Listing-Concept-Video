import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { createServer, globalAgent, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { globalAgent as globalTlsAgent } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { Gaxios, type GaxiosOptions, type GaxiosResponse } from "gaxios";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  managedCleanMasterKey,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ObjectRead,
  type ObjectStorage,
} from "@app/domain";
import { AppError } from "@app/shared";
import {
  GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES,
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
  createGoogleCloudStorageViews,
  type GoogleCloudStorageObjectClient,
} from "./index";
import { S3ManagedOutputStagingSink, type S3ObjectBody } from "../managed-output/s3-staging-sink";
import {
  GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS,
  GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS,
  metadataAccessToken,
} from "./access-token";
import { googleCloudStorageAgents, googleCloudStorageClient } from "./client";

/** Every file stream the adapter opens, so a test can see that each is closed. */
const readStreams = vi.hoisted((): Array<{ readonly closed: boolean }> => []);
/** Run once, on the file, before the next stream the adapter opens reads it. */
const beforeNextRead = vi.hoisted((): { hook?: (path: string) => void } => ({}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const hook = beforeNextRead.hook;
      beforeNextRead.hook = undefined;
      hook?.(String(args[0]));
      const stream = fs.createReadStream(...args);
      readStreams.push(stream);
      return stream;
    },
  };
});

/**
 * The adapter against stand-ins for the store and the metadata server, on this
 * machine: what it asks, and what it makes of every answer the emulator cannot
 * give (ADR-0156, ADR-0157, ADR-0158). Google's own origin is answered by the
 * test itself, never reached. The emulator suite (`pnpm test:gcs`) holds what
 * it stores.
 */

const SECRET = "google-cloud-storage-signing-secret";
const BUCKET = "vtavision-unit";
const ASSET = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";
const ESCAPED_ASSET = encodeURIComponent(ASSET);

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/**
 * What a stand-in does with a request: answer it, after a wait or at once,
 * hanging up once `cutAfter` bytes of the body are sent, or never ending the
 * answer once the body is sent when `holdOpen` is set; send `times` copies of
 * `repeat`, as fast as they are taken; say nothing; or hang up. A redirect
 * names `location`, or a port of this machine where nothing listens.
 */
type Answer =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Buffer;
      readonly afterMs?: number;
      readonly cutAfter?: number;
      readonly holdOpen?: boolean;
      readonly location?: string;
    }
  | {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly repeat: Buffer;
      readonly times: number;
    }
  | "SILENT"
  | "HANG_UP";

interface StandIn {
  readonly origin: string;
  readonly seen: Seen[];
  /** Bytes of `repeat` answers taken by the transport so far. */
  readonly sent: { bytes: number };
  /** Connections not yet closed. */
  open(): number;
}

const servers: Array<{ close(): void; closeAllConnections(): void }> = [];

async function standIn(answer: (request: Seen) => Answer): Promise<StandIn> {
  const seen: Seen[] = [];
  const sent = { bytes: 0 };
  const sockets = new Set<Socket>();
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const asked: Seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(asked);
      const answered = answer(asked);
      if (answered === "SILENT") return;
      if (answered === "HANG_UP") {
        request.socket.destroy();
        return;
      }
      const headers: Record<string, string> = { "content-type": "application/json", ...answered.headers };
      if (answered.status >= 300 && answered.status < 400) {
        headers.location = ("location" in answered && answered.location) || "http://127.0.0.1:9/elsewhere";
      }
      response.writeHead(answered.status, headers);
      if ("repeat" in answered) {
        let left = answered.times;
        const more = (): void => {
          while (left > 0 && !response.destroyed) {
            left -= 1;
            const taken = response.write(answered.repeat);
            sent.bytes += answered.repeat.byteLength;
            if (!taken) return void response.once("drain", more);
          }
          response.end();
        };
        more();
        return;
      }
      const send = () => {
        const { body = "", cutAfter, holdOpen = false } = answered;
        if (holdOpen) response.write(body);
        else if (cutAfter === undefined) response.end(body);
        else response.write(Buffer.from(body).subarray(0, cutAfter), () => request.socket.destroy());
      };
      if (answered.afterMs === undefined) send();
      else setTimeout(send, answered.afterMs);
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, sent, open: () => sockets.size };
}

/** gaxios's own request, before any test answers in its place. */
const sendRequest = Gaxios.prototype.request;
/** Every request a test sends; one to anywhere but this machine fails unsent, and is kept here. */
let requests: MockInstance<Gaxios["request"]>;
let offMachine: string[];
/** A proxy that records what reaches it, which every proxy variable names: nothing may (ADR-0158). */
let proxy: { readonly origin: string; readonly seen: string[]; close(): void };

beforeAll(async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(502).end();
  });
  server.on("connect", (request: { readonly url?: string }, socket: Socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
});

afterAll(() => proxy.close());

beforeEach(() => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, proxy.origin);
  for (const name of ["NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  offMachine = [];
  requests = vi.spyOn(Gaxios.prototype, "request").mockImplementation(async function (this: Gaxios, options) {
    const url = new URL(String(options?.url));
    if (url.hostname !== "127.0.0.1") {
      offMachine.push(url.origin);
      throw new Error("This suite sends nothing off this machine");
    }
    return sendRequest.call(this, options);
  });
});

afterEach(() => {
  expect(proxy.seen.splice(0)).toEqual([]);
  expect(offMachine).toEqual([]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

const storeAt = (origin: string): ObjectStorage =>
  createGoogleCloudStorage({ bucket: BUCKET, endpoint: origin, secret: SECRET });

/** The rejection a call ends in, or `null` when it resolves. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => null,
    (error: unknown) => error,
  );
}

const LISTED = (name: string) => JSON.stringify({ kind: "storage#objects", items: [{ name }] });
const LISTED_NONE = JSON.stringify({ kind: "storage#objects" });

describe("constructing it", () => {
  it("takes every bucket name Cloud Storage allows up to 63 characters, and none that reaches another path", () => {
    for (const bucket of ["abc", "a-b_c.d", "0bucket9", "a".repeat(63)]) {
      expect(() => createGoogleCloudStorage({ bucket, endpoint: "http://127.0.0.1:1", secret: SECRET })).not.toThrow();
    }
    for (const bucket of ["", "ab", "Abc", "-abc", "abc-", "a/b", "a b", "a%2Fb", "a".repeat(64), "abc\n"]) {
      const error = (() => {
        try {
          createGoogleCloudStorage({ bucket, endpoint: "http://127.0.0.1:1", secret: SECRET });
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "CONFIGURATION_ERROR",
        message: "The storage bucket must be named by Cloud Storage's rules",
      });
    }
  });

  it("takes an http or https origin, and names nothing it was given when it refuses one", () => {
    for (const endpoint of [
      "http://127.0.0.1:4443",
      "https://storage.googleapis.com",
      "https://storage.googleapis.com/",
    ]) {
      expect(() => createGoogleCloudStorage({ bucket: BUCKET, endpoint, secret: SECRET })).not.toThrow();
    }
    for (const endpoint of [
      "storage.example.test",
      "secret-word",
      "ftp://storage.example.test",
      "https://user:secret-word@storage.example.test",
      "https://storage.example.test/storage/v1",
      "https://storage.example.test/?secret-word=1",
      "https://storage.example.test/#secret-word",
    ]) {
      let error: unknown = null;
      try {
        createGoogleCloudStorage({ bucket: BUCKET, endpoint, secret: SECRET });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as Error).message).toBe("The storage endpoint must be an http or https origin");
      expect(JSON.stringify(error)).not.toMatch(/secret-word|example/);
    }
  });
});

describe("what it asks", () => {
  it("asks the JSON API once for each operation, with no credential", async () => {
    const store = await standIn((request) => {
      if (request.url.includes("/o?prefix=")) return { status: 200, body: LISTED(ASSET) };
      if (request.method === "GET") return { status: 200, body: "\u0001\u0002" };
      if (request.method === "DELETE") return { status: 204 };
      return { status: 200, body: "{}" };
    });
    const storage = storeAt(store.origin);
    await storage.putObject(ASSET, new Uint8Array([1, 2, 3]));
    expect(await storage.getObject(ASSET)).toEqual(new Uint8Array([1, 2]));
    expect(await storage.exists(ASSET)).toBe(true);
    await storage.deleteObject(ASSET);
    expect(store.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST /upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${ESCAPED_ASSET}`,
      `GET /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}?alt=media`,
      `GET /storage/v1/b/${BUCKET}/o?prefix=${ESCAPED_ASSET}&maxResults=1`,
      `DELETE /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}`,
    ]);
    expect(store.seen[0]!.headers["content-type"]).toBe("application/octet-stream");
    expect([...store.seen[0]!.body]).toEqual([1, 2, 3]);
    for (const request of store.seen) expect(request.headers.authorization).toBeUndefined();
  });

  it("escapes every character in a name that is not unreserved, in a path and in a query", async () => {
    const store = await standIn(() => ({ status: 200, body: LISTED_NONE }));
    await storeAt(store.origin).exists("org/(a)!*'b");
    expect(store.seen[0]!.url).toBe(`/storage/v1/b/${BUCKET}/o?prefix=org%2F%28a%29%21%2A%27b&maxResults=1`);
  });

  it("asks the bucket after a read or a delete finds nothing, and calls the object absent only then", async () => {
    const store = await standIn((request) =>
      request.url.includes("/o?prefix=") ? { status: 200, body: LISTED_NONE } : { status: 404, body: "{}" },
    );
    const storage = storeAt(store.origin);
    expect(await storage.getObject(ASSET)).toBeNull();
    await storage.deleteObject(ASSET);
    expect(store.seen.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `GET /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}`,
      `GET /storage/v1/b/${BUCKET}/o`,
      `DELETE /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}`,
      `GET /storage/v1/b/${BUCKET}/o`,
    ]);
  });

  it("finds only the name itself, never a longer name the list puts first", async () => {
    const store = await standIn(() => ({ status: 200, body: LISTED(`${ASSET}.bak`) }));
    expect(await storeAt(store.origin).exists(ASSET)).toBe(false);
  });

  it("sends nothing for a key that is not canonical, or one Cloud Storage cannot name, and names no key", async () => {
    const store = await standIn(() => ({ status: 200, body: LISTED_NONE }));
    const storage = storeAt(store.origin);
    const longest = `org/${"a".repeat(GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES - 4)}`;
    // 1,026 bytes in 515 characters: the limit counts bytes.
    const multibyte = `org/${"é".repeat(511)}`;
    for (const key of [
      "",
      "../x",
      "org//x",
      "org/./x",
      "org\\x",
      "org/a\nb",
      "org/a\rb",
      `${longest}a`,
      multibyte,
      "org/\uD800x",
    ]) {
      for (const call of [
        () => storage.putObject(key, new Uint8Array([1])),
        () => storage.getObject(key),
        () => storage.deleteObject(key),
        () => storage.exists(key),
        () => storage.readObject(key, null),
      ]) {
        const error = await failureOf(call);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({
          code: "INTERNAL_ERROR",
          message: "A stored object's key must be canonical, and one Cloud Storage can name",
        });
        expect((error as AppError).details).toBeUndefined();
        expect(JSON.stringify(error)).not.toMatch(/org|\.\./);
      }
    }
    expect(store.seen).toEqual([]);
    // Signing asks the store nothing; the longest names, by bytes, are asked.
    await storage.createSignedUploadUrl(ASSET, 60);
    await storage.createSignedDownloadUrl(ASSET, 60);
    expect(store.seen).toEqual([]);
    expect(await storage.exists(longest)).toBe(false);
    expect(await storage.exists(`org/${"é".repeat(510)}`)).toBe(false);
    // A whole surrogate pair is a character like any other.
    expect(await storage.exists("org/\u{1F600}")).toBe(false);
    expect(store.seen).toHaveLength(3);
  });
});

describe("what it makes of a refusal", () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [400, "STORAGE_REFUSED"],
    [401, "STORAGE_FORBIDDEN"],
    [403, "STORAGE_FORBIDDEN"],
    [409, "STORAGE_REFUSED"],
    [412, "STORAGE_REFUSED"],
    [429, "STORAGE_RATE_LIMITED"],
    [500, "STORAGE_UNAVAILABLE"],
    [503, "STORAGE_UNAVAILABLE"],
    // A redirect is never followed: the place it names is never asked.
    [302, "STORAGE_REFUSED"],
    [307, "STORAGE_REFUSED"],
  ];

  it.each(cases)("turns %i into %s, asks once, and names nothing", async (status, code) => {
    const body = JSON.stringify({ error: { code: status, message: `${BUCKET} ${ASSET} secret-word` } });
    const store = await standIn(() => ({ status, body }));
    const storage = storeAt(store.origin);
    const calls: ReadonlyArray<() => Promise<unknown>> = [
      () => storage.putObject(ASSET, new Uint8Array([1])),
      () => storage.getObject(ASSET),
      () => storage.deleteObject(ASSET),
      () => storage.exists(ASSET),
      () => storage.readObject(ASSET, null),
    ];
    for (const call of calls) {
      const error = await failureOf(call);
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      expect(error).toMatchObject({ code, message: code });
      expect(JSON.stringify(error)).not.toMatch(/vtavision|org_1|secret-word|127\.0\.0\.1/);
      expect(String((error as Error).stack)).not.toMatch(/vtavision|org_1|secret-word/);
    }
    expect(store.seen).toHaveLength(calls.length);
  });

  it("calls a 404 to a list, or to an upload, the bucket's", async () => {
    const store = await standIn(() => ({ status: 404, body: "{}" }));
    const storage = storeAt(store.origin);
    for (const call of [
      () => storage.exists(ASSET),
      () => storage.getObject(ASSET),
      () => storage.deleteObject(ASSET),
      () => storage.putObject(ASSET, new Uint8Array([1])),
      () => storage.readObject(ASSET, null),
    ]) {
      expect(await failureOf(call)).toMatchObject({ code: "STORAGE_BUCKET_MISSING" });
    }
  });

  it("calls an object absent only from a list it can read, which proves the absence", async () => {
    for (const body of [
      "not json",
      "null",
      "[]",
      '"text"',
      JSON.stringify({ items: {} }),
      JSON.stringify({ items: [{}] }),
      JSON.stringify({ items: [{ name: 7 }] }),
      JSON.stringify({ nextPageToken: "more" }),
      JSON.stringify({ items: [], nextPageToken: "more" }),
    ]) {
      const store = await standIn(() => ({ status: 200, body }));
      expect(await failureOf(() => storeAt(store.origin).exists(ASSET))).toMatchObject({
        code: "STORAGE_UNEXPECTED_ANSWER",
      });
    }
    for (const body of [LISTED_NONE, JSON.stringify({ items: [] })]) {
      const store = await standIn(() => ({ status: 200, body }));
      expect(await storeAt(store.origin).exists(ASSET)).toBe(false);
    }
  });

  it("names the transport's code when nothing is listening", async () => {
    const store = await standIn(() => ({ status: 200 }));
    for (const server of servers.splice(0)) server.close();
    expect(await failureOf(() => storeAt(store.origin).exists(ASSET))).toMatchObject({
      code: "ECONNREFUSED",
      message: "ECONNREFUSED",
    });
  });

  it("asks once when the store hangs up, and never again", async () => {
    const store = await standIn(() => "HANG_UP");
    const storage = storeAt(store.origin);
    const calls: ReadonlyArray<() => Promise<unknown>> = [
      () => storage.putObject(ASSET, new Uint8Array([1])),
      () => storage.getObject(ASSET),
      () => storage.deleteObject(ASSET),
      () => storage.exists(ASSET),
      () => storage.readObject(ASSET, null),
    ];
    for (const call of calls) {
      expect(await failureOf(call)).toMatchObject({ code: "ECONNRESET", message: "ECONNRESET" });
    }
    expect(store.seen).toHaveLength(calls.length);
  });
});

describe("how long it waits", () => {
  it("gives a question its limit, by gaxios's own setting, and asks it once", async () => {
    const store = await standIn(() => "SILENT");
    const started = performance.now();
    const error = await failureOf(() => storeAt(store.origin).exists(ASSET));
    const elapsed = performance.now() - started;
    expect(error).toMatchObject({ code: "STORAGE_TIMEOUT", message: "STORAGE_TIMEOUT" });
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_000);
    expect(store.seen).toHaveLength(1);
  });

  it("gives the list after a read that found nothing the same limit, and asks it once", async () => {
    const store = await standIn((request) => (request.url.includes("/o?prefix=") ? "SILENT" : { status: 404 }));
    const started = performance.now();
    expect(await failureOf(() => storeAt(store.origin).getObject(ASSET))).toMatchObject({ code: "STORAGE_TIMEOUT" });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_000);
    expect(store.seen).toHaveLength(2);
  });

  it("gives a whole object's read no limit", async () => {
    const afterMs = GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 500;
    const store = await standIn(() => ({ status: 200, body: "\u0007", afterMs }));
    expect(await storeAt(store.origin).getObject(ASSET)).toEqual(new Uint8Array([7]));
  });

  it("gives the size a streamed read asks first the same limit, and asks no bytes", async () => {
    const store = await standIn(() => "SILENT");
    const started = performance.now();
    const error = await failureOf(() => storeAt(store.origin).readObject(ASSET, null));
    const elapsed = performance.now() - started;
    expect(error).toMatchObject({ code: "STORAGE_TIMEOUT", message: "STORAGE_TIMEOUT" });
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_000);
    expect(store.seen).toHaveLength(1);
  });

  it("gives a streamed read's bytes no limit", async () => {
    const afterMs = GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 500;
    const held = holding(Buffer.from([1, 2, 3]));
    const store = await standIn((request) => {
      const answer = held(request);
      return isMedia(request) && typeof answer === "object" ? { ...answer, afterMs } : answer;
    });
    expect(joined(await chunksOf(await storeAt(store.origin).readObject(ASSET, null)))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

const GENERATION = "1794979978444859123";
const isMedia = (request: Seen): boolean => request.url.includes("alt=media");
const metadata = (size: number, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: ASSET, bucket: BUCKET, size: String(size), generation: GENERATION, ...fields });

/** A stand-in holding one object of `data`'s bytes: its size, its ranges and its name, as Cloud Storage says them. */
function holding(data: Buffer): (request: Seen) => Answer {
  return (request) => {
    if (request.url.includes("/o?prefix=")) return { status: 200, body: LISTED(ASSET) };
    if (!isMedia(request)) return { status: 200, body: metadata(data.byteLength) };
    const [first = "", last = ""] = String(request.headers.range).replace("bytes=", "").split("-");
    const [start, end] = [Number(first), Number(last)];
    const headers = {
      "content-range": `bytes ${start}-${end}/${data.byteLength}`,
      "content-length": String(end - start + 1),
      "x-goog-generation": GENERATION,
    };
    return { status: 206, headers, body: data.subarray(start, end + 1) };
  };
}

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

const joined = (chunks: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(chunks));

describe("the streamed read (ADR-0157)", () => {
  const TEN = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const MEBIBYTE = 1024 * 1024;

  it("asks the size and generation, then that generation's bytes in the range asked, once each", async () => {
    const store = await standIn(holding(TEN));
    const storage = storeAt(store.origin);
    const whole = await storage.readObject(ASSET, null);
    expect(whole).toMatchObject({ kind: "READ", size: 10, start: 0, length: 10 });
    expect(joined(await chunksOf(whole))).toEqual(new Uint8Array(TEN));
    const middle = await storage.readObject(ASSET, { kind: "FROM", start: 3, end: 5 });
    expect(middle).toMatchObject({ kind: "READ", size: 10, start: 3, length: 3 });
    expect([...joined(await chunksOf(middle))]).toEqual([3, 4, 5]);
    const last = await storage.readObject(ASSET, { kind: "LAST", length: 2 });
    expect(last).toMatchObject({ kind: "READ", size: 10, start: 8, length: 2 });
    expect([...joined(await chunksOf(last))]).toEqual([8, 9]);
    const rest = await storage.readObject(ASSET, { kind: "FROM", start: 7, end: 99 });
    expect([...joined(await chunksOf(rest))]).toEqual([7, 8, 9]);
    const object = `/storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}`;
    expect(store.seen.map(({ method, url }) => `${method} ${url}`)).toEqual(
      Array.from({ length: 4 }, () => [
        `GET ${object}?fields=size,generation,contentEncoding`,
        `GET ${object}?alt=media&generation=${GENERATION}`,
      ]).flat(),
    );
    // A last range is sent as the bytes it names, never as a suffix.
    expect(store.seen.filter(isMedia).map(({ headers }) => headers.range)).toEqual([
      "bytes=0-9",
      "bytes=3-5",
      "bytes=8-9",
      "bytes=7-9",
    ]);
    for (const { headers } of store.seen.filter(isMedia)) {
      expect(headers["accept-encoding"]).toBe("identity");
      expect(headers.authorization).toBeUndefined();
    }
  });

  it("takes a whole object answered whole, but never a range answered whole", async () => {
    const store = await standIn((request) =>
      isMedia(request) ? { status: 200, body: TEN } : { status: 200, body: metadata(10) },
    );
    const storage = storeAt(store.origin);
    expect(joined(await chunksOf(await storage.readObject(ASSET, null)))).toEqual(new Uint8Array(TEN));
    for (const [start, end] of [
      [3, 5],
      [0, 5],
    ] as const) {
      expect(await failureOf(() => storage.readObject(ASSET, { kind: "FROM", start, end }))).toMatchObject({
        code: "STORAGE_UNEXPECTED_ANSWER",
      });
    }
  });

  it("asks for no bytes when the range holds none of them, or the object holds none", async () => {
    const three = await standIn(holding(Buffer.from([1, 2, 3])));
    expect(await storeAt(three.origin).readObject(ASSET, { kind: "FROM", start: 3, end: null })).toEqual({
      kind: "UNSATISFIABLE",
      size: 3,
    });
    const empty = await standIn(holding(Buffer.alloc(0)));
    const storage = storeAt(empty.origin);
    const whole = await storage.readObject(ASSET, null);
    expect(whole).toMatchObject({ kind: "READ", size: 0, start: 0, length: 0 });
    expect(await chunksOf(whole)).toEqual([]);
    expect(await storage.readObject(ASSET, { kind: "LAST", length: 10 })).toMatchObject({ kind: "READ", length: 0 });
    expect(await storage.readObject(ASSET, { kind: "FROM", start: 0, end: null })).toEqual({
      kind: "UNSATISFIABLE",
      size: 0,
    });
    expect([...three.seen, ...empty.seen].filter(isMedia)).toEqual([]);
  });

  it("calls the object absent once the bucket is proved, whether gone before its size or its bytes", async () => {
    const before = await standIn((request) =>
      request.url.includes("/o?prefix=") ? { status: 200, body: LISTED_NONE } : { status: 404, body: "{}" },
    );
    expect(await storeAt(before.origin).readObject(ASSET, null)).toEqual({ kind: "ABSENT" });
    expect(before.seen.map(({ url }) => url.split("?")[0])).toEqual([
      `/storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}`,
      `/storage/v1/b/${BUCKET}/o`,
    ]);
    for (const [listed, outcome] of [
      [LISTED_NONE, { kind: "ABSENT" }],
      // Written again between the two: its size is another object's.
      [LISTED(ASSET), { code: "STORAGE_OBJECT_CHANGED", message: "STORAGE_OBJECT_CHANGED" }],
    ] as const) {
      const between = await standIn((request) => {
        if (request.url.includes("/o?prefix=")) return { status: 200, body: listed };
        return isMedia(request) ? { status: 404, body: "Not Found" } : { status: 200, body: metadata(10) };
      });
      const read = await storeAt(between.origin)
        .readObject(ASSET, null)
        .catch((error: unknown) => error);
      expect(read).toMatchObject(outcome);
      expect(between.seen).toHaveLength(3);
    }
  });

  it("asks no bytes for a size or generation it cannot read, or an object stored encoded", async () => {
    const valid = { size: "10", generation: GENERATION };
    for (const body of [
      "not json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...valid, size: 10 }),
      ...["", "-1", "01", "1e3", "1.5", " 10", "9007199254740993"].map((size) => JSON.stringify({ ...valid, size })),
      JSON.stringify({ size: "10" }),
      JSON.stringify({ ...valid, generation: 7 }),
      ...["", "0", "007", "1.5", "-7"].map((generation) => JSON.stringify({ ...valid, generation })),
      ...["gzip", "br", ""].map((contentEncoding) => JSON.stringify({ ...valid, contentEncoding })),
    ]) {
      const store = await standIn(() => ({ status: 200, body }));
      expect(await failureOf(() => storeAt(store.origin).readObject(ASSET, null))).toMatchObject({
        code: "STORAGE_UNEXPECTED_ANSWER",
      });
      expect(store.seen).toHaveLength(1);
    }
    const identity = await standIn((request) =>
      isMedia(request) ? holding(TEN)(request) : { status: 200, body: metadata(10, { contentEncoding: "identity" }) },
    );
    expect(await storeAt(identity.origin).readObject(ASSET, null)).toMatchObject({ kind: "READ", size: 10 });
  });

  it("refuses an answer that is not the bytes asked for, by its code alone", async () => {
    const asked = { "content-range": "bytes 3-5/10", "content-length": "3" };
    const unexpected = "STORAGE_UNEXPECTED_ANSWER";
    const cases: ReadonlyArray<readonly [Answer, string]> = [
      [{ status: 206, headers: { ...asked, "content-range": "bytes 3-5/11" }, body: "abc" }, unexpected],
      [{ status: 206, headers: { ...asked, "content-range": "bytes 3-6/10" }, body: "abc" }, unexpected],
      [{ status: 206, headers: { "content-length": "3" }, body: "abc" }, unexpected],
      [{ status: 206, headers: { ...asked, "content-length": "4" }, body: "abcd" }, unexpected],
      [{ status: 206, headers: { ...asked, "content-encoding": "gzip" }, body: "abc" }, unexpected],
      [{ status: 206, headers: { ...asked, "x-goog-generation": "8" }, body: "abc" }, unexpected],
      [{ status: 204 }, unexpected],
      [{ status: 416, body: `<Error>bytes=3-5 ${ASSET}</Error>` }, unexpected],
      [{ status: 403, body: ASSET }, "STORAGE_FORBIDDEN"],
      [{ status: 429 }, "STORAGE_RATE_LIMITED"],
      [{ status: 503 }, "STORAGE_UNAVAILABLE"],
      [{ status: 302 }, "STORAGE_REFUSED"],
    ];
    for (const [media, code] of cases) {
      const store = await standIn((request) => (isMedia(request) ? media : { status: 200, body: metadata(10) }));
      const error = await failureOf(() => storeAt(store.origin).readObject(ASSET, { kind: "FROM", start: 3, end: 5 }));
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      expect(error).toMatchObject({ code, message: code });
      expect(JSON.stringify(error)).not.toMatch(/vtavision|org_1|127\.0\.0\.1/);
      expect(store.seen).toHaveLength(2);
    }
  });

  it("ends the stream with a code when the answer ends short of its range, or runs past it", async () => {
    for (const body of ["ab", "abcd"]) {
      // No length is said, so only the bytes counted can show the answer is wrong.
      const store = await standIn((request) =>
        isMedia(request)
          ? { status: 206, headers: { "content-range": "bytes 3-5/10" }, body }
          : { status: 200, body: metadata(10) },
      );
      const read = await storeAt(store.origin).readObject(ASSET, { kind: "FROM", start: 3, end: 5 });
      const error = await failureOf(() => chunksOf(read));
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      expect(error).toMatchObject({ code: "STORAGE_UNEXPECTED_ANSWER", message: "STORAGE_UNEXPECTED_ANSWER" });
    }
  });

  it("ends the stream with the transport's code alone when the store hangs up partway, and holds nothing", async () => {
    const size = 4 * MEBIBYTE;
    const store = await standIn((request) =>
      isMedia(request)
        ? {
            status: 206,
            headers: { "content-range": `bytes 0-${size - 1}/${size}`, "content-length": String(size) },
            body: Buffer.alloc(size),
            cutAfter: 1_000,
          }
        : { status: 200, body: metadata(size) },
    );
    const read = await storeAt(store.origin).readObject(ASSET, null);
    const error = await failureOf(() => chunksOf(read));
    expect(error).toBeInstanceOf(GoogleCloudStorageError);
    expect(error).toMatchObject({ code: "ECONNRESET", message: "ECONNRESET" });
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/vtavision|org_1|127\.0\.0\.1/);
    expect(String((error as Error).stack)).not.toMatch(/vtavision|org_1|127\.0\.0\.1/);
    await vi.waitFor(() => expect(store.open()).toBe(0));
  });

  it("takes nothing from the answer before the reader asks, then one read of it for each, and lets it go", async () => {
    // The answer the adapter is handed, so what is taken from it can be counted.
    const answers: Readable[] = [];
    const guarded = requests.getMockImplementation()!;
    requests.mockImplementation(async function (this: Gaxios, options) {
      const response = await guarded.call(this, options);
      if (response.data instanceof Readable) answers.push(response.data);
      return response;
    });
    const size = 64 * MEBIBYTE;
    const store = await standIn((request) =>
      isMedia(request)
        ? {
            status: 206,
            headers: { "content-range": `bytes 0-${size - 1}/${size}`, "content-length": String(size) },
            repeat: Buffer.alloc(64 * 1024, 1),
            times: size / (64 * 1024),
          }
        : { status: 200, body: metadata(size) },
    );
    const read = await storeAt(store.origin).readObject(ASSET, null);
    if (read.kind !== "READ") throw new Error("expected a read");
    const [answer] = answers;
    if (answer === undefined) throw new Error("expected the answer");
    const taken: number[] = [];
    const readAnswer = answer.read.bind(answer);
    answer.read = (bytes?: number): unknown => {
      const chunk: unknown = readAnswer(bytes);
      if (chunk instanceof Uint8Array) taken.push(chunk.byteLength);
      return chunk;
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answer.readableDidRead).toBe(false);
    expect(taken).toEqual([]);
    const reader = read.body.getReader();
    const first = await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(taken).toEqual([first.value?.byteLength]);
    const second = await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(taken).toEqual([first.value?.byteLength, second.value?.byteLength]);
    // What the transport buffers is sent; the rest waits for the reader.
    expect(store.sent.bytes).toBeLessThan(size / 4);
    await reader.cancel();
    await vi.waitFor(() => expect(store.open()).toBe(0));
    expect(store.sent.bytes).toBeLessThan(size / 4);
  });

  it("ends the stream at its range's last byte, and lets the answer go, though the answer goes on", async () => {
    const store = await standIn((request) =>
      isMedia(request)
        ? { status: 206, headers: { "content-range": "bytes 3-5/10" }, body: "abc", holdOpen: true }
        : { status: 200, body: metadata(10) },
    );
    const read = await storeAt(store.origin).readObject(ASSET, { kind: "FROM", start: 3, end: 5 });
    expect(Buffer.from(joined(await chunksOf(read))).toString()).toBe("abc");
    await vi.waitFor(() => expect(store.open()).toBe(0));
  });

  it("ends the stream with a code at the first chunk past its range, and lets the rest go", async () => {
    const size = 64 * MEBIBYTE;
    const store = await standIn((request) =>
      isMedia(request)
        ? {
            status: 206,
            headers: { "content-range": "bytes 3-5/10" },
            repeat: Buffer.alloc(64 * 1024, 1),
            times: size / (64 * 1024),
          }
        : { status: 200, body: metadata(10) },
    );
    const read = await storeAt(store.origin).readObject(ASSET, { kind: "FROM", start: 3, end: 5 });
    if (read.kind !== "READ") throw new Error("expected a read");
    const error = await failureOf(() => read.body.getReader().read());
    expect(error).toBeInstanceOf(GoogleCloudStorageError);
    expect(error).toMatchObject({ code: "STORAGE_UNEXPECTED_ANSWER", message: "STORAGE_UNEXPECTED_ANSWER" });
    await vi.waitFor(() => expect(store.open()).toBe(0));
    expect(store.sent.bytes).toBeLessThan(size / 4);
  });

  it("lets go of a long answer it does not pass on", async () => {
    const size = 64 * MEBIBYTE;
    const store = await standIn((request) =>
      isMedia(request)
        ? { status: 500, headers: {}, repeat: Buffer.alloc(64 * 1024, 1), times: size / (64 * 1024) }
        : { status: 200, body: metadata(size) },
    );
    expect(await failureOf(() => storeAt(store.origin).readObject(ASSET, null))).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await vi.waitFor(() => expect(store.open()).toBe(0));
    expect(store.sent.bytes).toBeLessThan(size / 4);
  });
});

const START = Date.parse("2026-11-18T00:00:00Z");
const MARKER = "ya29.marker-token";

const FLAVOR = { "metadata-flavor": "Google" };
const tokenBody = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ access_token: MARKER, expires_in: 3599, token_type: "Bearer", ...fields });
/** The metadata server's answer of a token, as Google gives it. */
const TOKEN = (fields: Record<string, unknown> = {}): Answer => ({
  status: 200,
  headers: FLAVOR,
  body: tokenBody(fields),
});

describe("the token (ADR-0158)", () => {
  const tokenAt = (origin: string, clock: { at: number }) =>
    metadataAccessToken(googleCloudStorageClient(), origin, () => new Date(clock.at));

  it("asks the metadata server once, as Google says, and keeps the token until the margin before its end", async () => {
    let count = 0;
    const clock = { at: START };
    const server = await standIn(() => {
      count += 1;
      // The first answer comes 2 seconds after the question: a token's life counts from the question.
      if (count === 1) clock.at += 2_000;
      return TOKEN({ access_token: `ya29.t${count}`, expires_in: count === 1 ? 3599 : 300 });
    });
    const token = tokenAt(server.origin, clock);
    expect(await token.get()).toBe("ya29.t1");
    clock.at = START + 3_599_000 - GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS - 1;
    expect(await token.get()).toBe("ya29.t1");
    expect(server.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET /computeMetadata/v1/instance/service-accounts/default/token",
    ]);
    expect(server.seen[0]!.headers["metadata-flavor"]).toBe("Google");
    expect(server.seen[0]!.headers.authorization).toBeUndefined();
    clock.at += 1;
    expect(await token.get()).toBe("ya29.t2");
    // A token living less than twice the margin is kept for half its life.
    clock.at += 149_999;
    expect(await token.get()).toBe("ya29.t2");
    clock.at += 1;
    expect(await token.get()).toBe("ya29.t3");
    expect(server.seen).toHaveLength(3);
  });

  it("takes only a token the metadata server gives, keeps nothing else, and asks again next time", async () => {
    const elsewhere = await standIn(() => TOKEN({ access_token: "ya29.elsewhere" }));
    const refused: Answer[] = [
      { status: 503, headers: FLAVOR, body: tokenBody() },
      { status: 429, headers: FLAVOR, body: tokenBody() },
      { status: 203, headers: FLAVOR, body: tokenBody() },
      // A redirect is never followed, even to a token.
      { status: 301, headers: FLAVOR, body: tokenBody(), location: `${elsewhere.origin}/token` },
      // Something other than the metadata server answering, such as a proxy.
      { status: 200, body: tokenBody() },
      { status: 200, headers: { "metadata-flavor": "google" }, body: tokenBody() },
      { status: 200, headers: FLAVOR, body: "not json" },
      { status: 200, headers: FLAVOR, body: "null" },
      { status: 200, headers: FLAVOR, body: "[]" },
      TOKEN({ token_type: "MAC" }),
      TOKEN({ token_type: undefined }),
      TOKEN({ expires_in: "3599" }),
      TOKEN({ expires_in: 0 }),
      TOKEN({ expires_in: -1 }),
      TOKEN({ expires_in: 1.5 }),
      TOKEN({ expires_in: 2 ** 53 }),
      TOKEN({ access_token: "" }),
      TOKEN({ access_token: 7 }),
      TOKEN({ access_token: "ya29.a b" }),
      TOKEN({ access_token: "ya29.a\r\nx-evil: 1" }),
    ];
    let next = 0;
    const server = await standIn(() => refused[next] ?? TOKEN({ token_type: "bearer" }));
    const token = tokenAt(server.origin, { at: START });
    for (next = 0; next < refused.length; next += 1) expect(await token.get()).toBeNull();
    expect(await token.get()).toBe(MARKER);
    expect(server.seen).toHaveLength(refused.length + 1);
    expect(elsewhere.seen).toEqual([]);
  });

  it("gives the request its limit, by gaxios's own setting, once for every caller waiting", async () => {
    const server = await standIn(() => "SILENT");
    const token = tokenAt(server.origin, { at: START });
    const started = performance.now();
    const tokens = await Promise.all(Array.from({ length: 20 }, () => token.get()));
    const elapsed = performance.now() - started;
    expect(tokens).toEqual(Array.from({ length: 20 }, () => null));
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS + 1_000);
    expect(server.seen).toHaveLength(1);
  });

  it("asks once for every caller waiting", async () => {
    const server = await standIn(() => ({ status: 200, headers: FLAVOR, body: tokenBody(), afterMs: 50 }));
    const token = tokenAt(server.origin, { at: START });
    expect(await Promise.all(Array.from({ length: 50 }, () => token.get()))).toEqual(
      Array.from({ length: 50 }, () => MARKER),
    );
    expect(server.seen).toHaveLength(1);
  });

  it("sends a due token while it lasts when its renewal fails, and never one it was told was refused", async () => {
    let count = 0;
    const server = await standIn(() => {
      count += 1;
      return count === 1 ? TOKEN({ expires_in: 600 }) : { status: 503, headers: FLAVOR };
    });
    const clock = { at: START };
    const token = tokenAt(server.origin, clock);
    expect(await token.get()).toBe(MARKER);
    clock.at = START + 600_000 - GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS - 1;
    expect(await token.get()).toBe(MARKER);
    expect(server.seen).toHaveLength(1);
    clock.at += 1;
    expect(await token.get()).toBe(MARKER);
    clock.at = START + 600_000 - 1;
    expect(await token.get()).toBe(MARKER);
    clock.at = START + 600_000;
    expect(await token.get()).toBeNull();
    expect(server.seen).toHaveLength(4);
    token.drop("ya29.another");
    clock.at = START + 600_000 - 1;
    expect(await token.get()).toBe(MARKER);
    token.drop(MARKER);
    expect(await token.get()).toBeNull();
  });

  it("forgets only the token it is told was refused", async () => {
    let count = 0;
    const server = await standIn(() => TOKEN({ access_token: `ya29.t${(count += 1)}` }));
    const token = tokenAt(server.origin, { at: START });
    expect(await token.get()).toBe("ya29.t1");
    token.drop("ya29.t0");
    expect(await token.get()).toBe("ya29.t1");
    token.drop("ya29.t1");
    expect(await token.get()).toBe("ya29.t2");
    expect(server.seen).toHaveLength(2);
  });

  it("sends every request straight to its origin, on the adapter's own connections", async () => {
    // Node.js's own proxy settings are put on its global agents: they are never used.
    const used = [
      vi.spyOn(globalAgent, "getName"),
      vi.spyOn(globalTlsAgent, "getName"),
      vi.spyOn(googleCloudStorageAgents.http, "getName"),
      vi.spyOn(googleCloudStorageAgents.https, "getName"),
    ];
    const metadataServer = await standIn(() => TOKEN());
    expect(await tokenAt(metadataServer.origin, { at: START }).get()).toBe(MARKER);
    const store = await standIn(() => ({ status: 200, body: LISTED_NONE }));
    expect(await storeAt(store.origin).exists(ASSET)).toBe(false);
    // An https request is given its connection before it connects, here to a port where nothing listens.
    expect(await failureOf(() => storeAt("https://127.0.0.1:1").exists(ASSET))).toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(used.map((spy) => spy.mock.calls.length > 0)).toEqual([false, false, true, true]);
    // Node.js 22's own options for its global agents, less the proxy they may be given (ADR-0158 Decision 6).
    const optionsOf = (agent: object): Record<string, unknown> =>
      (agent as { readonly options: Record<string, unknown> }).options;
    const lessProxy = (agent: object): Record<string, unknown> => {
      const { proxyEnv: _proxyEnv, ...options } = optionsOf(agent);
      return options;
    };
    expect(optionsOf(googleCloudStorageAgents.http)).toEqual(lessProxy(globalAgent));
    expect(optionsOf(googleCloudStorageAgents.https)).toEqual(lessProxy(globalTlsAgent));
  });
});

/** What Google's store, or its metadata server, is asked by a test that answers in their place. */
interface Asked {
  readonly url: URL;
  readonly authorization: string | null;
  readonly headers: Headers;
}

/** What a test answers in place of Google. */
interface GoogleAnswer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly data?: unknown;
}

/** Answers every request in place of Google, sending nothing anywhere; the requests are kept. */
function answeringAsGoogle(answer: (url: URL) => GoogleAnswer): Asked[] {
  const asked: Asked[] = [];
  requests.mockImplementation(async (options?: GaxiosOptions) => {
    const url = new URL(String(options?.url));
    const sent = new Headers(options?.headers);
    asked.push({ url, authorization: sent.get("authorization"), headers: sent });
    const { status, headers = {}, data = "" } = answer(url);
    return { status, statusText: "", headers: new Headers(headers), data, config: options } as GaxiosResponse;
  });
  return asked;
}

const GOOGLE = "https://storage.googleapis.com";
const METADATA_SERVER = "http://metadata.google.internal";
const TOKEN_ANSWER = (token: string) => ({ status: 200, headers: FLAVOR, data: tokenBody({ access_token: token }) });

/** Google's store holding three bytes under every name, as the test answers in its place. */
function asGoogleStore(url: URL): GoogleAnswer {
  if (url.pathname.startsWith("/upload/")) return { status: 200, data: "{}" };
  if (url.search.includes("prefix=")) return { status: 200, data: LISTED(ASSET) };
  if (url.search.includes("fields=")) return { status: 200, data: metadata(3) };
  if (url.search.includes("generation=")) {
    const headers = { "content-range": "bytes 0-2/3", "content-length": "3", "x-goog-generation": GENERATION };
    return { status: 206, headers, data: Readable.from([Buffer.from([1, 2, 3])]) };
  }
  if (url.search.includes("alt=media")) return { status: 200, data: new Uint8Array([1, 2, 3]).buffer };
  return { status: 204 };
}

describe("Google's store (ADR-0158)", () => {
  it("sends every request a token from the metadata server, asked for once", async () => {
    const asked = answeringAsGoogle((url) =>
      url.origin === METADATA_SERVER ? TOKEN_ANSWER(MARKER) : asGoogleStore(url),
    );
    const storage = createGoogleCloudStorage({ bucket: BUCKET, endpoint: GOOGLE, secret: SECRET });
    await storage.createSignedUploadUrl(ASSET, 60);
    expect(asked).toEqual([]);
    await storage.putObject(ASSET, new Uint8Array([1, 2, 3]));
    expect(await storage.getObject(ASSET)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.exists(ASSET)).toBe(true);
    expect(joined(await chunksOf(await storage.readObject(ASSET, null)))).toEqual(new Uint8Array([1, 2, 3]));
    await storage.deleteObject(ASSET);
    const [first, ...rest] = asked;
    expect(first?.url.href).toBe(`${METADATA_SERVER}/computeMetadata/v1/instance/service-accounts/default/token`);
    expect(first?.authorization).toBeNull();
    expect(rest.map(({ url, authorization }) => [url.origin, authorization])).toEqual(
      Array.from({ length: 6 }, () => [GOOGLE, `Bearer ${MARKER}`]),
    );
    // The token joins each request's own headers, never in their place.
    expect(rest[0]?.headers.get("content-type")).toBe("application/octet-stream");
    expect(rest[4]?.headers.get("range")).toBe("bytes=0-2");
    // The token is asked for on the store's own client, and so on the adapter's connections.
    const clients = new Set(requests.mock.contexts as Gaxios[]);
    expect(clients.size).toBe(1);
    const [client] = clients;
    const agentFor = client?.defaults.agent as (url: URL) => unknown;
    expect(agentFor(new URL(METADATA_SERVER))).toBe(googleCloudStorageAgents.http);
    expect(agentFor(new URL(GOOGLE))).toBe(googleCloudStorageAgents.https);
  });

  it("sends a token to Google's origin however it is written, and to no other", async () => {
    const asked = answeringAsGoogle((url) =>
      url.origin === METADATA_SERVER ? TOKEN_ANSWER(MARKER) : { status: 200, data: LISTED_NONE },
    );
    const sent = async (endpoint: string): Promise<Array<string | null>> => {
      asked.splice(0);
      await createGoogleCloudStorage({ bucket: BUCKET, endpoint, secret: SECRET }).exists(ASSET);
      return asked.map(({ authorization }) => authorization);
    };
    for (const endpoint of ["https://STORAGE.googleapis.com:443/", `${GOOGLE}/`]) {
      expect(await sent(endpoint)).toEqual([null, `Bearer ${MARKER}`]);
    }
    for (const endpoint of [
      "http://storage.googleapis.com",
      "https://storage.googleapis.com.",
      "https://storage.googleapis.com:8443",
      "https://storage.googleapis.com.example.test",
      "https://www.googleapis.com",
    ]) {
      expect(await sent(endpoint)).toEqual([null]);
    }
  });

  it("lets go of a token the store answers 401, keeps one it answers 403, and asks nothing again", async () => {
    const statuses = [200, 403, 401, 200];
    let tokens = 0;
    const asked = answeringAsGoogle((url) =>
      url.origin === METADATA_SERVER
        ? TOKEN_ANSWER(`ya29.t${(tokens += 1)}`)
        : { status: statuses.shift() ?? 500, data: LISTED(ASSET) },
    );
    const storage = createGoogleCloudStorage({ bucket: BUCKET, endpoint: GOOGLE, secret: SECRET });
    expect(await storage.exists(ASSET)).toBe(true);
    expect(await failureOf(() => storage.exists(ASSET))).toMatchObject({ code: "STORAGE_FORBIDDEN" });
    expect(await failureOf(() => storage.exists(ASSET))).toMatchObject({ code: "STORAGE_FORBIDDEN" });
    expect(await storage.exists(ASSET)).toBe(true);
    expect(asked.map(({ url, authorization }) => authorization ?? url.origin)).toEqual([
      METADATA_SERVER,
      "Bearer ya29.t1",
      "Bearer ya29.t1",
      "Bearer ya29.t1",
      METADATA_SERVER,
      "Bearer ya29.t2",
    ]);
  });

  it("lets go of the token whichever request the store answers 401", async () => {
    let tokens = 0;
    let refusing: (url: URL) => boolean = () => false;
    answeringAsGoogle((url) => {
      if (url.origin === METADATA_SERVER) return TOKEN_ANSWER(`ya29.t${(tokens += 1)}`);
      if (!refusing(url)) return asGoogleStore(url);
      refusing = () => false;
      // A streamed read's answer is a stream, whatever its status.
      return { status: 401, data: Readable.from([]) };
    });
    const storage = createGoogleCloudStorage({ bucket: BUCKET, endpoint: GOOGLE, secret: SECRET });
    const calls: ReadonlyArray<readonly [(url: URL) => boolean, () => Promise<unknown>]> = [
      [(url) => url.pathname.startsWith("/upload/"), () => storage.putObject(ASSET, new Uint8Array([1]))],
      [(url) => url.search === "?alt=media", () => storage.getObject(ASSET)],
      [(url) => url.search.includes("generation="), async () => chunksOf(await storage.readObject(ASSET, null))],
      [() => true, () => storage.deleteObject(ASSET)],
    ];
    for (const [refused, call] of calls) {
      refusing = refused;
      expect(await failureOf(call)).toMatchObject({ code: "STORAGE_FORBIDDEN" });
      // The next request asks for a new token.
      const asked = tokens;
      expect(await storage.exists(ASSET)).toBe(true);
      expect(tokens).toBe(asked + 1);
    }
  });

  it("sends the store nothing when no token can be had, and names nothing", async () => {
    const asked = answeringAsGoogle(() => ({ status: 503, data: `${MARKER} secret-word` }));
    const storage = createGoogleCloudStorage({ bucket: BUCKET, endpoint: GOOGLE, secret: SECRET });
    const calls: ReadonlyArray<() => Promise<unknown>> = [
      () => storage.putObject(ASSET, new Uint8Array([1])),
      () => storage.getObject(ASSET),
      () => storage.deleteObject(ASSET),
      () => storage.exists(ASSET),
      () => storage.readObject(ASSET, null),
    ];
    for (const call of calls) {
      const error = await failureOf(call);
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      expect(error).toMatchObject({
        code: "STORAGE_CREDENTIAL_UNAVAILABLE",
        message: "STORAGE_CREDENTIAL_UNAVAILABLE",
      });
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toMatch(/ya29|secret-word|metadata/);
    }
    expect(asked.map(({ url }) => url.origin)).toEqual(calls.map(() => METADATA_SERVER));
  });
});

describe("a production build's transport", () => {
  it("reads a timeout from an abort whose name the build changed", async () => {
    const abort = Object.assign(new Error("The operation was aborted."), { name: "P", type: "aborted" });
    for (const error of [abort, Object.assign(new Error("request to the store failed"), { cause: abort })]) {
      requests.mockRejectedValueOnce(error);
      expect(await failureOf(() => storeAt("http://127.0.0.1:1").exists(ASSET))).toMatchObject({
        code: "STORAGE_TIMEOUT",
        message: "STORAGE_TIMEOUT",
      });
    }
  });
});

describe("the worker's view (ADR-0160)", () => {
  const TEN = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const MEBIBYTE = 1024 * 1024;
  const MASTER = managedCleanMasterKey({ organizationId: "org_1", deliverableVersionId: "gdv_1" });
  const UPLOAD = `POST /upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(MASTER)}`;
  const target = (key: string) => ({ bucket: BUCKET, key, expectedBucketOwner: undefined });
  const clientAt = (origin: string): GoogleCloudStorageObjectClient =>
    createGoogleCloudStorageViews({ bucket: BUCKET, endpoint: origin, secret: SECRET }).objectClient;
  let folder: string;
  let files = 0;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "vta-gcs-worker-"));
  });

  afterEach(async () => {
    beforeNextRead.hook = undefined;
    await rm(folder, { recursive: true, force: true });
  });

  /** A local file of `data`, as the worker hands one over. */
  const file = async (data: Uint8Array): Promise<string> => {
    files += 1;
    const path = join(folder, `file-${files}`);
    await writeFile(path, data);
    return path;
  };
  const put = (client: GoogleCloudStorageObjectClient, localPath: string) =>
    client.putObjectIfAbsent({ ...target(MASTER), localPath, contentType: "video/mp4" });
  const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  /** Every byte a body holds, read to its end. */
  async function drained(body: S3ObjectBody): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await body.read();
      if (chunk === null) return joined(chunks);
      chunks.push(chunk);
    }
  }

  it("reads a stored object's one generation as the worker pulls it, then ends", async () => {
    const store = await standIn(holding(TEN));
    const { contentLength, body } = await clientAt(store.origin).getObject(target(ASSET));
    expect(contentLength).toBe(10);
    expect(await drained(body!)).toEqual(new Uint8Array(TEN));
    expect(await body!.read()).toBeNull();
    expect(store.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}?fields=size,generation,contentEncoding`,
      `GET /storage/v1/b/${BUCKET}/o/${ESCAPED_ASSET}?alt=media&generation=${GENERATION}`,
    ]);
  });

  it("calls an object absent only once the bucket is proved, and a missing bucket never", async () => {
    const absent = await standIn((request) =>
      request.url.includes("/o?prefix=") ? { status: 200, body: LISTED_NONE } : { status: 404, body: "{}" },
    );
    expect(await clientAt(absent.origin).getObject(target(ASSET))).toEqual({ contentLength: null, body: null });
    const missing = await standIn(() => ({ status: 404, body: "{}" }));
    expect(await failureOf(() => clientAt(missing.origin).getObject(target(ASSET)))).toMatchObject({
      code: "STORAGE_BUCKET_MISSING",
    });
  });

  it("fails a read with a code when the answer ends short, never with an end", async () => {
    const store = await standIn((request) =>
      isMedia(request)
        ? { status: 206, headers: { "content-range": "bytes 0-9/10" }, body: TEN.subarray(0, 4) }
        : { status: 200, body: metadata(10) },
    );
    const { body } = await clientAt(store.origin).getObject(target(ASSET));
    expect(await failureOf(() => drained(body!))).toMatchObject({
      code: "STORAGE_UNEXPECTED_ANSWER",
      message: "STORAGE_UNEXPECTED_ANSWER",
    });
    // A body that has failed is let go quietly.
    await expect(body!.cancel()).resolves.toBeUndefined();
  });

  it("refuses a read once the body is cancelled", async () => {
    const store = await standIn(holding(TEN));
    const { body } = await clientAt(store.origin).getObject(target(ASSET));
    await body!.cancel();
    await body!.cancel();
    expect(await failureOf(() => body!.read())).toMatchObject({
      code: "STORAGE_BODY_CANCELLED",
      message: "STORAGE_BODY_CANCELLED",
    });
  });

  it("refuses a read still waiting when the body is cancelled, and lets the answer go", async () => {
    const store = await standIn((request) =>
      isMedia(request)
        ? { status: 206, headers: { "content-range": "bytes 0-9/10" }, body: TEN.subarray(0, 3), holdOpen: true }
        : { status: 200, body: metadata(10) },
    );
    const { body } = await clientAt(store.origin).getObject(target(ASSET));
    let read = 0;
    while (read < 3) read += (await body!.read())!.byteLength;
    const waiting = failureOf(() => body!.read());
    await body!.cancel();
    expect(await waiting).toMatchObject({ code: "STORAGE_BODY_CANCELLED", message: "STORAGE_BODY_CANCELLED" });
    await vi.waitFor(() => expect(store.open()).toBe(0));
  });

  it("lets go of the answer when the body is cancelled partway", async () => {
    const size = 64 * MEBIBYTE;
    const store = await standIn((request) =>
      isMedia(request)
        ? {
            status: 206,
            headers: { "content-range": `bytes 0-${size - 1}/${size}`, "content-length": String(size) },
            repeat: Buffer.alloc(64 * 1024, 1),
            times: size / (64 * 1024),
          }
        : { status: 200, body: metadata(size) },
    );
    const { body } = await clientAt(store.origin).getObject(target(ASSET));
    expect((await body!.read())!.byteLength).toBeGreaterThan(0);
    await body!.cancel();
    await vi.waitFor(() => expect(store.open()).toBe(0));
    expect(store.sent.bytes).toBeLessThan(size / 4);
  });

  it("sends nothing for another bucket, an owner, or a key that is not canonical, and names none", async () => {
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    const client = clientAt(store.origin);
    // No such file: each refusal comes before the file is read.
    const localPath = join(folder, "missing.mp4");
    for (const input of [
      { ...target(ASSET), bucket: "vtavision-other" },
      { ...target(ASSET), expectedBucketOwner: "123456789012" },
      { ...target(ASSET), expectedBucketOwner: "" },
    ]) {
      for (const call of [
        () => client.getObject(input),
        () => client.putObjectIfAbsent({ ...input, localPath, contentType: "video/mp4" }),
      ]) {
        const error = await failureOf(call);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({
          code: "CONFIGURATION_ERROR",
          message: "A worker's request must name the store's own bucket, and no owner",
        });
        expect(JSON.stringify(error)).not.toMatch(/vtavision|123456789012|org/);
      }
    }
    for (const key of ["../x", "org//x", "org/a\nb"]) {
      for (const call of [
        () => client.getObject(target(key)),
        () => client.putObjectIfAbsent({ ...target(key), localPath, contentType: "video/mp4" }),
      ]) {
        expect(await failureOf(call)).toMatchObject({ code: "INTERNAL_ERROR" });
      }
    }
    expect(store.seen).toEqual([]);
  });

  it("stores a local file only where nothing is stored, with its length and MD5", async () => {
    const data = Buffer.from("a deliverable's bytes");
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    expect(await put(clientAt(store.origin), await file(data))).toEqual({ kind: "CREATED" });
    expect(store.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([`${UPLOAD}&ifGenerationMatch=0`]);
    const [sent] = store.seen;
    expect(sent!.headers["content-type"]).toBe("video/mp4");
    expect(sent!.headers["content-length"]).toBe(String(data.byteLength));
    expect(sent!.headers["x-goog-hash"]).toBe(`md5=${createHash("md5").update(data).digest("base64")}`);
    expect(sent!.body).toEqual(data);
    expect(sent!.headers.authorization).toBeUndefined();
  });

  it("sends the MD5 of every byte of a file, however many reads it takes", async () => {
    for (const data of [Buffer.from([7]), Buffer.from(Array.from({ length: MEBIBYTE + 3 }, (_, i) => i % 251))]) {
      const store = await standIn(() => ({ status: 200, body: "{}" }));
      expect(await put(clientAt(store.origin), await file(data))).toEqual({ kind: "CREATED" });
      expect(store.seen[0]!.headers["x-goog-hash"]).toBe(`md5=${createHash("md5").update(data).digest("base64")}`);
      // By digest: element-wise equality over a mebibyte takes seconds and says no more.
      expect(sha256Of(store.seen[0]!.body)).toBe(sha256Of(data));
    }
  });

  it("fails a put whose file is shorter as it is sent than when it was hashed, and sends only what was", async () => {
    const data = Buffer.alloc(200 * 1024, 5);
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    const send = requests.getMockImplementation()!;
    const shorter = await file(data);
    requests.mockImplementationOnce(async function (this: Gaxios, options) {
      await truncate(shorter, 100 * 1024);
      return send.call(this, options);
    });
    // Refused, where the store would wait for the bytes its length promised: cut before it is whole.
    expect(await failureOf(() => put(clientAt(store.origin), shorter))).toMatchObject({
      code: "STORAGE_FILE_CHANGED",
      message: "STORAGE_FILE_CHANGED",
    });
    expect(store.seen).toEqual([]);
    const longer = await file(data);
    requests.mockImplementationOnce(async function (this: Gaxios, options) {
      await appendFile(longer, Buffer.from([9, 9]));
      return send.call(this, options);
    });
    expect(await put(clientAt(store.origin), longer)).toEqual({ kind: "CREATED" });
    expect(sha256Of(store.seen[0]!.body)).toBe(sha256Of(data));
    // An empty file written to before it is sent is still sent as no bytes.
    const empty = await file(new Uint8Array(0));
    let handed: unknown;
    requests.mockImplementationOnce(async function (this: Gaxios, options) {
      await appendFile(empty, Buffer.from([9, 9]));
      handed = options?.data;
      return send.call(this, options);
    });
    // What the transport was handed is asserted first, so a failure names it.
    const outcome = await put(clientAt(store.origin), empty).catch((error: unknown) => error);
    expect(handed).toEqual(Buffer.alloc(0));
    expect(outcome).toEqual({ kind: "CREATED" });
    expect(store.seen[1]!.headers["content-length"]).toBe("0");
    expect(store.seen[1]!.body.byteLength).toBe(0);
  });

  it("sends a file grown while it is hashed only as far as its size, with that MD5", async () => {
    const data = Buffer.alloc(200 * 1024, 6);
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    const localPath = await file(data);
    beforeNextRead.hook = (path) => appendFileSync(path, Buffer.from([9, 9]));
    expect(await put(clientAt(store.origin), localPath)).toEqual({ kind: "CREATED" });
    expect(store.seen[0]!.headers["content-length"]).toBe(String(data.byteLength));
    expect(store.seen[0]!.headers["x-goog-hash"]).toBe(`md5=${createHash("md5").update(data).digest("base64")}`);
    expect(sha256Of(store.seen[0]!.body)).toBe(sha256Of(data));
  });

  it("fails a put whose file is read short of its size as it is hashed, before anything is sent", async () => {
    readStreams.splice(0);
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    const localPath = await file(Buffer.alloc(200 * 1024, 4));
    beforeNextRead.hook = (path) => truncateSync(path, 100 * 1024);
    expect(await failureOf(() => put(clientAt(store.origin), localPath))).toMatchObject({
      code: "STORAGE_FILE_CHANGED",
      message: "STORAGE_FILE_CHANGED",
    });
    // Only the MD5's read opened the file: no request was made to send it.
    expect(readStreams).toHaveLength(1);
    expect(requests).not.toHaveBeenCalled();
    expect(store.seen).toEqual([]);
  });

  it("opens the file to send only as it is sent, and lets it go however the put ends", async () => {
    readStreams.splice(0);
    const localPath = await file(Buffer.alloc(256 * 1024, 3));
    // No token: refused before anything is sent, so only the MD5's read opened the file.
    answeringAsGoogle((url) => (url.origin === METADATA_SERVER ? { status: 503 } : asGoogleStore(url)));
    const google = createGoogleCloudStorageViews({ bucket: BUCKET, endpoint: GOOGLE, secret: SECRET }).objectClient;
    expect(await failureOf(() => put(google, localPath))).toMatchObject({ code: "STORAGE_CREDENTIAL_UNAVAILABLE" });
    expect(readStreams).toHaveLength(1);
    // Answered once the first bytes are taken, the rest unsent.
    requests.mockImplementation(async (options?: GaxiosOptions) => {
      const data = options?.data as Readable;
      await new Promise((resolve) => data.once("readable", resolve));
      expect(data.read()).not.toBeNull();
      return { status: 412, statusText: "", headers: new Headers(), data: "", config: options } as GaxiosResponse;
    });
    expect(await put(clientAt("http://127.0.0.1:9"), localPath)).toEqual({ kind: "ALREADY_EXISTS" });
    expect(readStreams).toHaveLength(3);
    // Cut partway with no answer, whatever the transport does with the body.
    requests.mockImplementation(async (options?: GaxiosOptions) => {
      const data = options?.data as Readable;
      await new Promise((resolve) => data.once("readable", resolve));
      expect(data.read()).not.toBeNull();
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    expect(await failureOf(() => put(clientAt("http://127.0.0.1:9"), localPath))).toMatchObject({
      code: "ECONNRESET",
    });
    expect(readStreams).toHaveLength(5);
    await vi.waitFor(() => expect(readStreams.every((stream) => stream.closed)).toBe(true));
  });

  it("sends an empty file as no bytes, with the MD5 of none", async () => {
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    expect(await put(clientAt(store.origin), await file(new Uint8Array(0)))).toEqual({ kind: "CREATED" });
    expect(store.seen[0]!.headers["content-length"]).toBe("0");
    expect(store.seen[0]!.headers["x-goog-hash"]).toBe("md5=1B2M2Y8AsgTpgAmY7PhCfg==");
    expect(store.seen[0]!.body.byteLength).toBe(0);
  });

  it("reads a 412 as an object already stored, and any other refusal as its code alone", async () => {
    const localPath = await file(new Uint8Array([1, 2]));
    const answers: Array<[number, unknown]> = [
      [412, { kind: "ALREADY_EXISTS" }],
      [404, "STORAGE_BUCKET_MISSING"],
      // As Google, by its documents, refuses bytes whose MD5 is not the one sent.
      [400, "STORAGE_REFUSED"],
      [403, "STORAGE_FORBIDDEN"],
      [429, "STORAGE_RATE_LIMITED"],
      [503, "STORAGE_UNAVAILABLE"],
      [307, "STORAGE_REFUSED"],
      // Only 200 is a stored object.
      [201, "STORAGE_REFUSED"],
      [204, "STORAGE_REFUSED"],
    ];
    for (const [status, outcome] of answers) {
      const store = await standIn(() => ({ status, body: "{\"error\":\"org/org_1\"}" }));
      if (typeof outcome === "string") {
        expect(await failureOf(() => put(clientAt(store.origin), localPath))).toMatchObject({
          code: outcome,
          message: outcome,
        });
      } else {
        expect(await put(clientAt(store.origin), localPath)).toEqual(outcome);
      }
      expect(store.seen).toHaveLength(1);
    }
  });

  it("names no path when the file cannot be read, and sends nothing", async () => {
    const store = await standIn(() => ({ status: 200, body: "{}" }));
    const error = await failureOf(() => put(clientAt(store.origin), join(folder, "missing")));
    expect(error).toMatchObject({ code: "ENOENT", message: "ENOENT" });
    expect(JSON.stringify(error)).not.toContain(folder);
    expect(store.seen).toEqual([]);
  });

  it("gives the put no limit, as every request that carries bytes", async () => {
    const afterMs = GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 500;
    const store = await standIn(() => ({ status: 200, body: "{}", afterMs }));
    expect(await put(clientAt(store.origin), await file(new Uint8Array([1])))).toEqual({ kind: "CREATED" });
    expect(requests.mock.calls.map(([options]) => options?.timeout)).toEqual([undefined]);
    // Waits past the question limit on purpose; the margin is for a loaded runner.
  }, 10_000);

  it("asks Google's metadata server once for both views, and sends the worker's requests its token", async () => {
    const asked = answeringAsGoogle((url) =>
      url.origin === METADATA_SERVER ? TOKEN_ANSWER(MARKER) : asGoogleStore(url),
    );
    const { objectStorage, objectClient } = createGoogleCloudStorageViews({
      bucket: BUCKET,
      endpoint: GOOGLE,
      secret: SECRET,
    });
    expect(await objectStorage.exists(ASSET)).toBe(true);
    expect(await put(objectClient, await file(new Uint8Array(0)))).toEqual({ kind: "CREATED" });
    const { body } = await objectClient.getObject(target(ASSET));
    expect(await drained(body!)).toEqual(new Uint8Array([1, 2, 3]));
    const [first, ...rest] = asked;
    expect(first?.url.origin).toBe(METADATA_SERVER);
    expect(rest.map(({ url, authorization }) => [url.origin, authorization])).toEqual(
      Array.from({ length: 4 }, () => [GOOGLE, `Bearer ${MARKER}`]),
    );
  });
});

describe("the staging sink's upload (ADR-0161)", () => {
  const QUANTUM = GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES;
  const MEBIBYTE = 1024 * 1024;
  const OUTPUT = managedGenerationOutputKey({ organizationId: "org_1", attemptId: "att_1" });
  const OTHER = managedGenerationOutputKey({ organizationId: "org_1", attemptId: "att_2" });
  /** What a session's URI holds: nothing the adapter says may carry it. */
  const SESSION_ID = "SESSION-MARKER-4f1c9e";
  const SESSION_PATH = `/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(OUTPUT)}`;
  const OPENED = `POST ${SESSION_PATH}&ifGenerationMatch=0`;
  const SESSION = `${SESSION_PATH}&upload_id=${SESSION_ID}`;
  const CHUNK = `PUT ${SESSION}`;
  const CANCEL = `DELETE ${SESSION}`;
  const target = { bucket: BUCKET, key: OUTPUT, expectedBucketOwner: undefined };
  const clientAt = (origin: string): GoogleCloudStorageObjectClient =>
    createGoogleCloudStorageViews({ bucket: BUCKET, endpoint: origin, secret: SECRET }).objectClient;
  const sum = (bytes: Uint8Array, encoding: "base64" | "hex"): string =>
    createHash("sha256").update(bytes).digest(encoding);
  const filled = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);
  const part = (uploadId: string, partNumber: number, body: Uint8Array) => ({
    ...target,
    uploadId,
    partNumber,
    body,
    checksumSha256Base64: sum(body, "base64"),
  });
  const ref = (partNumber: number, body: Uint8Array) => ({
    partNumber,
    etag: `"${sum(body, "hex")}"`,
    checksumSha256Base64: sum(body, "base64"),
  });
  const complete = (uploadId: string, parts: ReturnType<typeof ref>[]) => ({
    ...target,
    uploadId,
    parts,
    ifNoneMatch: "*",
  });
  const refs = (parts: Uint8Array[]) => parts.map((body, index) => ref(index + 1, body));
  /** Each request a store was sent, with the range of the bytes it carried. */
  const described = (store: StandIn): string[] =>
    store.seen.map(({ method, url, headers }) => `${method} ${url} ${headers["content-range"] ?? ""}`.trim());

  /**
   * A store taking resumable uploads as Google documents them: a start answers
   * with a session at the store's own origin, a chunk with the range of the
   * bytes kept, the last chunk with the object, and a cancel with `499`.
   * `instead` may answer any request, the `index`th, in its place.
   */
  async function resumableStore(
    instead: (request: Seen, index: number) => Answer | undefined = () => undefined,
  ): Promise<StandIn> {
    let origin = "";
    let kept = 0;
    let index = 0;
    const store = await standIn((request) => {
      const answered = instead(request, index++);
      if (answered !== undefined) return answered;
      if (request.method === "POST") return { status: 200, headers: { location: `${origin}${SESSION}` } };
      if (request.method === "DELETE") return { status: 499, body: "{}" };
      kept += request.body.byteLength;
      if (String(request.headers["content-range"]).endsWith("/*")) {
        return { status: 308, headers: { range: `bytes=0-${kept - 1}` } };
      }
      return { status: 200, body: "{}" };
    });
    origin = store.origin;
    return store;
  }

  it("sends the parts as one upload: each when the next comes, the last with the size and MD5", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const parts = [filled(QUANTUM, 1), filled(2 * QUANTUM, 2), filled(3, 3)];
    const { uploadId } = await client.createMultipartUpload(target);
    expect(uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const etags: string[] = [];
    for (const [index, body] of parts.entries()) {
      etags.push((await client.uploadPart(part(uploadId, index + 1, body))).etag);
      // A part is held until the next comes, or the upload's completion.
      expect(store.seen).toHaveLength(index + 1);
    }
    expect(etags).toEqual(refs(parts).map(({ etag }) => etag));
    await client.completeMultipartUpload(complete(uploadId, refs(parts)));
    const whole = Buffer.concat(parts);
    expect(described(store)).toEqual([
      OPENED,
      `${CHUNK} bytes 0-262143/*`,
      `${CHUNK} bytes 262144-786431/*`,
      `${CHUNK} bytes 786432-786434/786435`,
    ]);
    expect(sum(Buffer.concat(store.seen.slice(1).map(({ body }) => body)), "hex")).toBe(sum(whole, "hex"));
    expect(store.seen[0]!.headers["x-upload-content-type"]).toBe("application/octet-stream");
    expect(store.seen.map(({ headers }) => headers["x-goog-hash"])).toEqual([
      undefined,
      undefined,
      undefined,
      `md5=${createHash("md5").update(whole).digest("base64")}`,
    ]);
    // Finished, the upload is let go: there is nothing left to cancel.
    await client.abortMultipartUpload({ ...target, uploadId });
    expect(store.seen).toHaveLength(4);
  });

  it("sends a single part whole when the upload is completed, finished at 200 or 201", async () => {
    for (const status of [200, 201]) {
      const store = await resumableStore((request) => (request.method === "PUT" ? { status, body: "{}" } : undefined));
      const client = clientAt(store.origin);
      const { uploadId } = await client.createMultipartUpload(target);
      await client.uploadPart(part(uploadId, 1, filled(3, 7)));
      await client.completeMultipartUpload(complete(uploadId, refs([filled(3, 7)])));
      // Finished, the upload is let go: there is nothing left to cancel.
      await client.abortMultipartUpload({ ...target, uploadId });
      expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-2/3`]);
      expect(store.seen[1]!.body).toEqual(Buffer.from([7, 7, 7]));
    }
  });

  it("keeps a copy of each part, so the sink may fill its array again", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const array = filled(QUANTUM, 7);
    await client.uploadPart(part(uploadId, 1, array));
    array.fill(8);
    await client.uploadPart(part(uploadId, 2, array.subarray(0, 5)));
    expect(sum(store.seen[1]!.body, "hex")).toBe(sum(filled(QUANTUM, 7), "hex"));
  });

  it("gives the start and the cancel the question limit, and the bytes none", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const parts = [filled(QUANTUM, 1), filled(1, 2)];
    const sent = await client.createMultipartUpload(target);
    for (const [index, body] of parts.entries()) await client.uploadPart(part(sent.uploadId, index + 1, body));
    await client.completeMultipartUpload(complete(sent.uploadId, refs(parts)));
    const cancelled = await client.createMultipartUpload(target);
    await client.abortMultipartUpload({ ...target, uploadId: cancelled.uploadId });
    expect(requests.mock.calls.map(([options]) => `${options?.method} ${options?.timeout}`)).toEqual([
      `POST ${GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS}`,
      "PUT undefined",
      "PUT undefined",
      `POST ${GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS}`,
      `DELETE ${GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS}`,
    ]);
  });

  it("gives up a start not answered within the question limit, and asks it once", async () => {
    const store = await standIn(() => "SILENT");
    const started = performance.now();
    const error = await failureOf(() => clientAt(store.origin).createMultipartUpload(target));
    const elapsed = performance.now() - started;
    expect(error).toMatchObject({ code: "STORAGE_TIMEOUT" });
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_000);
    expect(store.seen).toHaveLength(1);
  });

  it("refuses a part out of order, sent again, empty or not its checksum's, sending nothing", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const body = filled(QUANTUM, 1);
    for (const refused of [
      part(uploadId, 2, body),
      part(uploadId, 0, body),
      part(uploadId, 1, new Uint8Array(0)),
      { ...part(uploadId, 1, body), checksumSha256Base64: sum(filled(QUANTUM, 2), "base64") },
    ]) {
      expect(await failureOf(() => client.uploadPart(refused))).toMatchObject({ code: "STORAGE_PART_REFUSED" });
    }
    await client.uploadPart(part(uploadId, 1, body));
    expect(await failureOf(() => client.uploadPart(part(uploadId, 1, body)))).toMatchObject({
      code: "STORAGE_PART_REFUSED",
    });
    expect(store.seen).toHaveLength(1);
    // A refused part fails nothing: the upload goes on.
    await client.uploadPart(part(uploadId, 2, filled(3, 2)));
    await client.completeMultipartUpload(complete(uploadId, refs([body, filled(3, 2)])));
    expect(store.seen).toHaveLength(3);
  });

  it("refuses a part after one that is not a whole number of 256 KiB, which may only be the last", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const odd = filled(QUANTUM + 1, 1);
    const { uploadId } = await client.createMultipartUpload(target);
    await client.uploadPart(part(uploadId, 1, odd));
    expect(await failureOf(() => client.uploadPart(part(uploadId, 2, filled(1, 2))))).toMatchObject({
      code: "STORAGE_PART_REFUSED",
    });
    expect(store.seen).toHaveLength(1);
    await client.completeMultipartUpload(complete(uploadId, refs([odd])));
    expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-262144/262145`]);
  });

  it("refuses a completion naming other parts than were taken, or none, or unconditional; sends nothing", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const [body, last] = [filled(QUANTUM, 1), filled(2, 2)];
    const { uploadId } = await client.createMultipartUpload(target);
    await client.uploadPart(part(uploadId, 1, body));
    await client.uploadPart(part(uploadId, 2, last));
    for (const parts of [
      [],
      [ref(1, body)],
      [ref(1, body), ref(2, last), ref(3, last)],
      [ref(2, last), ref(1, body)],
      [ref(1, body), { ...ref(2, last), etag: '"other"' }],
      [ref(1, body), { ...ref(2, last), checksumSha256Base64: sum(body, "base64") }],
      [{ ...ref(1, body), partNumber: 3 }, ref(2, last)],
    ]) {
      expect(await failureOf(() => client.completeMultipartUpload(complete(uploadId, parts)))).toMatchObject({
        code: "STORAGE_PART_REFUSED",
      });
    }
    const unconditional = await failureOf(() =>
      client.completeMultipartUpload({ ...complete(uploadId, refs([body, last])), ifNoneMatch: "" }),
    );
    expect(unconditional).toBeInstanceOf(AppError);
    expect(unconditional).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(store.seen).toHaveLength(2);
    await client.completeMultipartUpload(complete(uploadId, refs([body, last])));
    expect(store.seen).toHaveLength(3);
    // An upload that took no part is not finished as an empty object.
    const none = await client.createMultipartUpload(target);
    expect(await failureOf(() => client.completeMultipartUpload(complete(none.uploadId, [])))).toMatchObject({
      code: "STORAGE_PART_REFUSED",
    });
    expect(store.seen).toHaveLength(4);
  });

  it("knows only the uploads it started, for the key it started them for", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const UNKNOWN = { code: "STORAGE_UNKNOWN_UPLOAD" };
    expect(await failureOf(() => client.uploadPart(part(unknown, 1, filled(1, 1))))).toMatchObject(UNKNOWN);
    expect(await failureOf(() => client.uploadPart({ ...part(uploadId, 1, filled(1, 1)), key: OTHER }))).toMatchObject(
      UNKNOWN,
    );
    expect(
      await failureOf(() => client.completeMultipartUpload({ ...complete(uploadId, []), key: OTHER })),
    ).toMatchObject(UNKNOWN);
    expect(await failureOf(() => client.abortMultipartUpload({ ...target, key: OTHER, uploadId }))).toMatchObject(
      UNKNOWN,
    );
    // Another store of the same bucket holds none of this one's uploads.
    expect(await failureOf(() => clientAt(store.origin).uploadPart(part(uploadId, 1, filled(1, 1))))).toMatchObject(
      UNKNOWN,
    );
    // Cancelling an upload it does not hold changes nothing.
    await client.abortMultipartUpload({ ...target, uploadId: unknown });
    expect(store.seen).toHaveLength(1);
  });

  it("refuses another bucket and any owner on every call, sending nothing", async () => {
    const store = await resumableStore();
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const wrongs = [{ bucket: "another-bucket" }, { expectedBucketOwner: "123456789012" }, { expectedBucketOwner: "" }];
    for (const wrong of wrongs) {
      for (const call of [
        () => client.createMultipartUpload({ ...target, ...wrong }),
        () => client.uploadPart({ ...part(uploadId, 1, filled(1, 1)), ...wrong }),
        () => client.completeMultipartUpload({ ...complete(uploadId, []), ...wrong }),
        () => client.abortMultipartUpload({ ...target, uploadId, ...wrong }),
      ]) {
        const error = await failureOf(call);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: "CONFIGURATION_ERROR" });
      }
    }
    expect(store.seen).toHaveLength(1);
  });

  it("takes and drops the parts of an upload refused at its start, and refuses its completion as lost", async () => {
    const store = await resumableStore((request) =>
      request.method === "POST" ? { status: 412, body: "{}" } : undefined,
    );
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const parts = [filled(QUANTUM, 1), filled(QUANTUM, 2), filled(1, 3)];
    for (const [index, body] of parts.entries()) await client.uploadPart(part(uploadId, index + 1, body));
    const lost = await failureOf(() => client.completeMultipartUpload(complete(uploadId, refs(parts))));
    expect(lost).toBeInstanceOf(GoogleCloudStorageError);
    expect(lost).toMatchObject({ code: "STORAGE_PRECONDITION_FAILED", $metadata: { httpStatusCode: 412 } });
    // The store opened no session: nothing was sent on one, and there is none to cancel.
    await client.abortMultipartUpload({ ...target, uploadId });
    expect(described(store)).toEqual([OPENED]);
  });

  it("drops the parts after bytes refused for their precondition, and refuses the completion as lost", async () => {
    const store = await resumableStore((request) =>
      request.method === "PUT" ? { status: 412, body: "{}" } : undefined,
    );
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    const parts = [filled(QUANTUM, 1), filled(QUANTUM, 2), filled(QUANTUM, 3), filled(1, 4)];
    for (const [index, body] of parts.entries()) await client.uploadPart(part(uploadId, index + 1, body));
    expect(await failureOf(() => client.completeMultipartUpload(complete(uploadId, refs(parts))))).toMatchObject({
      code: "STORAGE_PRECONDITION_FAILED",
      $metadata: { httpStatusCode: 412 },
    });
    await client.abortMultipartUpload({ ...target, uploadId });
    expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-262143/*`, CANCEL]);
  });

  it("refuses the completion as a lost race when its last bytes are refused for their precondition", async () => {
    const store = await resumableStore((request) =>
      String(request.headers["content-range"]).endsWith("/3") ? { status: 412, body: "{}" } : undefined,
    );
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    await client.uploadPart(part(uploadId, 1, filled(3, 1)));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = complete(uploadId, refs([filled(3, 1)]));
      expect(await failureOf(() => client.completeMultipartUpload(completion))).toMatchObject({
        code: "STORAGE_PRECONDITION_FAILED",
        $metadata: { httpStatusCode: 412 },
      });
    }
    await client.abortMultipartUpload({ ...target, uploadId });
    expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-2/3`, CANCEL]);
  });

  it("fails an upload whose store keeps fewer bytes than were sent, or answers otherwise; sends no more", async () => {
    for (const [answer, code] of [
      [{ status: 308, headers: { range: "bytes=0-262142" } }, "STORAGE_UNEXPECTED_ANSWER"],
      [{ status: 308 }, "STORAGE_UNEXPECTED_ANSWER"],
      [{ status: 200, body: "{}" }, "STORAGE_UNEXPECTED_ANSWER"],
      [{ status: 404, body: "{}" }, "STORAGE_REFUSED"],
      [{ status: 503, body: "{}" }, "STORAGE_UNAVAILABLE"],
    ] as const) {
      const store = await resumableStore((request) => (request.method === "PUT" ? answer : undefined));
      const client = clientAt(store.origin);
      const { uploadId } = await client.createMultipartUpload(target);
      const parts = [filled(QUANTUM, 1), filled(QUANTUM, 2), filled(1, 3)];
      await client.uploadPart(part(uploadId, 1, parts[0]!));
      expect(await failureOf(() => client.uploadPart(part(uploadId, 2, parts[1]!)))).toMatchObject({ code });
      const FAILED = { code: "STORAGE_UPLOAD_FAILED" };
      expect(await failureOf(() => client.uploadPart(part(uploadId, 2, parts[1]!)))).toMatchObject(FAILED);
      const completion = complete(uploadId, refs(parts));
      expect(await failureOf(() => client.completeMultipartUpload(completion))).toMatchObject(FAILED);
      await client.abortMultipartUpload({ ...target, uploadId });
      expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-262143/*`, CANCEL]);
    }
  });

  it("fails an upload whose last bytes are not taken as the object, and sends no more", async () => {
    for (const [answer, code] of [
      [{ status: 308, headers: { range: "bytes=0-2" } }, "STORAGE_UNEXPECTED_ANSWER"],
      [{ status: 204 }, "STORAGE_UNEXPECTED_ANSWER"],
      [{ status: 503, body: "{}" }, "STORAGE_UNAVAILABLE"],
    ] as const) {
      const store = await resumableStore((request) => (request.method === "PUT" ? answer : undefined));
      const client = clientAt(store.origin);
      const { uploadId } = await client.createMultipartUpload(target);
      await client.uploadPart(part(uploadId, 1, filled(3, 1)));
      const completion = complete(uploadId, refs([filled(3, 1)]));
      expect(await failureOf(() => client.completeMultipartUpload(completion))).toMatchObject({ code });
      expect(await failureOf(() => client.completeMultipartUpload(completion))).toMatchObject({
        code: "STORAGE_UPLOAD_FAILED",
      });
      await client.abortMultipartUpload({ ...target, uploadId });
      expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-2/3`, CANCEL]);
    }
  });

  it("refuses a call on an upload while another on it is unanswered", async () => {
    const store = await resumableStore((_request, index) =>
      index === 1 ? { status: 308, headers: { range: "bytes=0-262143" }, afterMs: 200 } : undefined,
    );
    const client = clientAt(store.origin);
    const [first, second] = [filled(QUANTUM, 1), filled(5, 2)];
    const { uploadId } = await client.createMultipartUpload(target);
    await client.uploadPart(part(uploadId, 1, first));
    const sending = client.uploadPart(part(uploadId, 2, second));
    const BUSY = { code: "STORAGE_UPLOAD_BUSY" };
    expect(await failureOf(() => client.uploadPart(part(uploadId, 3, filled(1, 3))))).toMatchObject(BUSY);
    const early = complete(uploadId, refs([first]));
    expect(await failureOf(() => client.completeMultipartUpload(early))).toMatchObject(BUSY);
    await sending;
    await client.completeMultipartUpload(complete(uploadId, refs([first, second])));
    expect(described(store)).toEqual([OPENED, `${CHUNK} bytes 0-262143/*`, `${CHUNK} bytes 262144-262148/262149`]);
  });

  it("takes a cancel while a chunk is unanswered, and lets the upload go at once", async () => {
    const store = await resumableStore((_request, index) =>
      index === 1 ? { status: 308, headers: { range: "bytes=0-262143" }, afterMs: 200 } : undefined,
    );
    const client = clientAt(store.origin);
    const { uploadId } = await client.createMultipartUpload(target);
    await client.uploadPart(part(uploadId, 1, filled(QUANTUM, 1)));
    const sending = client.uploadPart(part(uploadId, 2, filled(5, 2)));
    await client.abortMultipartUpload({ ...target, uploadId });
    await sending;
    expect(await failureOf(() => client.uploadPart(part(uploadId, 3, filled(1, 3))))).toMatchObject({
      code: "STORAGE_UNKNOWN_UPLOAD",
    });
    // The chunk already sent is not stopped; the cancel goes beside it.
    expect(described(store).sort()).toEqual([OPENED, `${CHUNK} bytes 0-262143/*`, CANCEL].sort());
  });

  it("takes a session only at the store's own origin and upload path, naming nothing of one it refuses", async () => {
    for (const location of [
      (origin: string) => `${origin.replace(/:\d+$/, ":9")}${SESSION}`,
      (origin: string) => `${origin}${SESSION}`.replace(`/b/${BUCKET}/o`, `/b/${BUCKET}-other/o`),
      (origin: string) => `${origin}${SESSION}`.replace(`upload_id=${SESSION_ID}`, "upload_id="),
      (origin: string) => `${origin}${SESSION}`.replace(`upload_id=${SESSION_ID}`, `id=${SESSION_ID}`),
      (origin: string) => `${origin}${SESSION}`.replace("http://", `http://${SESSION_ID}@`),
      (origin: string) => `${origin}${SESSION}`.replace("http://", `http://:${SESSION_ID}@`),
      (origin: string) => `${origin}${SESSION}#${SESSION_ID}`,
      () => SESSION,
      () => `http://[${SESSION_ID}`,
      () => null,
    ]) {
      const store = await standIn((): Answer => {
        const at = location(origin);
        const headers: Record<string, string> = at === null ? {} : { location: at };
        return { status: 200, headers };
      });
      const origin = store.origin;
      const error = await failureOf(() => clientAt(store.origin).createMultipartUpload(target));
      expect(error).toMatchObject({ code: "STORAGE_UNEXPECTED_ANSWER" });
      for (const text of [inspect(error, { depth: 10 }), JSON.stringify(error), String(error)]) {
        expect(text).not.toContain(SESSION_ID);
      }
      expect(store.seen).toHaveLength(1);
    }
  });

  it("names nothing of a session when a request on it fails", async () => {
    for (const answer of ["HANG_UP", { status: 503, body: SESSION_ID }, { status: 308 }] as const) {
      const store = await resumableStore((request) => (request.method === "PUT" ? answer : undefined));
      const client = clientAt(store.origin);
      const { uploadId } = await client.createMultipartUpload(target);
      expect(uploadId).not.toContain(SESSION_ID);
      await client.uploadPart(part(uploadId, 1, filled(QUANTUM, 1)));
      const error = await failureOf(() => client.uploadPart(part(uploadId, 2, filled(1, 2))));
      expect(error).toBeInstanceOf(GoogleCloudStorageError);
      for (const text of [inspect(error, { depth: 10 }), JSON.stringify(error), String(error)]) {
        expect(text).not.toContain(SESSION_ID);
      }
      // However it failed, the upload sends nothing more.
      expect(await failureOf(() => client.uploadPart(part(uploadId, 2, filled(1, 2))))).toMatchObject({
        code: "STORAGE_UPLOAD_FAILED",
      });
      expect(store.seen).toHaveLength(2);
    }
  });

  it("calls a start's 404 a missing bucket, and any other refusal by its code", async () => {
    for (const [status, code] of [
      [404, "STORAGE_BUCKET_MISSING"],
      [403, "STORAGE_FORBIDDEN"],
      [503, "STORAGE_UNAVAILABLE"],
      [201, "STORAGE_REFUSED"],
    ] as const) {
      const store = await standIn(() => ({ status, body: "{}" }));
      expect(await failureOf(() => clientAt(store.origin).createMultipartUpload(target))).toMatchObject({ code });
    }
  });

  it("cancels an upload when it is aborted, once, and lets it go whatever the store answers", async () => {
    for (const [answer, code] of [
      [{ status: 499, body: "{}" }, null],
      [{ status: 404, body: "{}" }, null],
      [{ status: 410, body: "{}" }, null],
      [{ status: 503, body: "{}" }, "STORAGE_UNAVAILABLE"],
      [{ status: 204 }, "STORAGE_REFUSED"],
    ] as const) {
      const store = await resumableStore((request) => (request.method === "DELETE" ? answer : undefined));
      const client = clientAt(store.origin);
      const { uploadId } = await client.createMultipartUpload(target);
      const error = await failureOf(() => client.abortMultipartUpload({ ...target, uploadId }));
      if (code === null) expect(error).toBeNull();
      else expect(error).toMatchObject({ code });
      await client.abortMultipartUpload({ ...target, uploadId });
      expect(await failureOf(() => client.uploadPart(part(uploadId, 1, filled(1, 1))))).toMatchObject({
        code: "STORAGE_UNKNOWN_UPLOAD",
      });
      expect(described(store)).toEqual([OPENED, CANCEL]);
    }
  });

  it("on Google's origin, sends a session's requests the token, and refuses a session anywhere else", async () => {
    const google = `${GOOGLE}${SESSION}`;
    let location = google;
    const asked: string[] = [];
    requests.mockImplementation(async (options?: GaxiosOptions) => {
      const url = new URL(String(options?.url));
      const sent = new Headers(options?.headers);
      asked.push(`${options?.method ?? "GET"} ${url.origin} ${sent.get("authorization")}`);
      const answer: GoogleAnswer =
        url.origin === METADATA_SERVER
          ? TOKEN_ANSWER(MARKER)
          : options?.method === "POST"
            ? { status: 200, headers: { location } }
            : options?.method === "DELETE"
              ? { status: 499 }
              : sent.get("content-range")?.endsWith("/*")
                ? { status: 308, headers: { range: `bytes=0-${QUANTUM - 1}` } }
                : { status: 200, data: "{}" };
      const { status, headers = {}, data = "" } = answer;
      return { status, statusText: "", headers: new Headers(headers), data, config: options } as GaxiosResponse;
    });
    const client = clientAt(GOOGLE);
    const parts = [filled(QUANTUM, 1), filled(1, 2)];
    const sent = await client.createMultipartUpload(target);
    for (const [index, body] of parts.entries()) await client.uploadPart(part(sent.uploadId, index + 1, body));
    await client.completeMultipartUpload(complete(sent.uploadId, refs(parts)));
    const cancelled = await client.createMultipartUpload(target);
    await client.abortMultipartUpload({ ...target, uploadId: cancelled.uploadId });
    const bearer = `Bearer ${MARKER}`;
    expect(asked).toEqual([
      `GET ${METADATA_SERVER} null`,
      `POST ${GOOGLE} ${bearer}`,
      `PUT ${GOOGLE} ${bearer}`,
      `PUT ${GOOGLE} ${bearer}`,
      `POST ${GOOGLE} ${bearer}`,
      `DELETE ${GOOGLE} ${bearer}`,
    ]);
    // A session at another origin is refused, so neither bytes nor the token go there.
    location = google.replace(GOOGLE, "https://storage.example.com");
    expect(await failureOf(() => client.createMultipartUpload(target))).toMatchObject({
      code: "STORAGE_UNEXPECTED_ANSWER",
    });
    expect(asked.slice(6)).toEqual([`POST ${GOOGLE} ${bearer}`]);
  });

  it("lets the unchanged sink read the winner back when the store refuses the upload at its start", async () => {
    const winner = Buffer.from([3, 1, 4, 1, 5]);
    const held = holding(winner);
    const store = await standIn((request) => (request.method === "POST" ? { status: 412, body: "{}" } : held(request)));
    const partSizeBytes = 5 * MEBIBYTE;
    const sink = new S3ManagedOutputStagingSink({ bucket: BUCKET, partSizeBytes }, { client: clientAt(store.origin) });
    const session = await sink.begin({ destinationKey: OUTPUT });
    const data = filled(partSizeBytes + 3, 9);
    // The first part is sent as it is written, the second at the commit: both are taken and dropped.
    await session.write(data);
    const receiptOf = (bytes: Uint8Array) => ({
      sha256: sha256Digest(sum(bytes, "hex")),
      sizeBytes: safePositiveByteCount(bytes.byteLength),
    });
    expect(await session.commit({ receipt: receiptOf(data) })).toEqual({
      kind: "EXISTING",
      receipt: receiptOf(winner),
    });
    expect(store.seen.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `POST /upload/storage/v1/b/${BUCKET}/o`,
      `GET /storage/v1/b/${BUCKET}/o/${encodeURIComponent(OUTPUT)}`,
      `GET /storage/v1/b/${BUCKET}/o/${encodeURIComponent(OUTPUT)}`,
    ]);
  });
});

describe("where it is constructed", () => {
  it("is constructed only by the web app's adapters, and loaded by none through `@app/storage`", () => {
    // It reaches Google's store with the process's own identity (ADR-0158): anything else that
    // constructs it gets this review (ADR-0159).
    const repo = join(__dirname, "..", "..", "..", "..");
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === "node_modules" || name === ".next" || name === "dist") return [];
        if (statSync(path).isDirectory()) return sources(path);
        return /\.[cm]?[jt]sx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const production = ["packages", "apps"].flatMap((root) => sources(join(repo, root)));
    const naming = (pattern: RegExp): string[] =>
      production.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.slice(repo.length + 1));
    expect(naming(/createGoogleCloudStorage\w*\(/).sort()).toEqual([
      "apps/web/src/lib/adapters.ts",
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
    ]);
    // The token is asked for by the adapter alone, and nothing in it is read from the environment.
    expect(naming(/metadataAccessToken\(|googleCloudStorageClient\(/).sort()).toEqual([
      "packages/storage/src/google-cloud-storage/access-token.ts",
      "packages/storage/src/google-cloud-storage/client.ts",
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
    ]);
    const reads = /\bprocess\s*(?:\?\.|[.[;,)}])|[=(,{:]\s*process\b|["'`](?:node:)?process["'`]/.source;
    const environment = new RegExp(`${reads}|GCE_METADATA|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_EMULATOR_HOST`);
    expect(naming(environment)).not.toContainEqual(expect.stringContaining("google-cloud-storage/"));
    // Any quoted path beginning with gaxios, or naming the folder or anything below it, so an alias is caught too.
    const loading = /["'`]gaxios(?:\/[^"'`]*)?["'`]|google-cloud-storage(?:\/[\w.-]*)*["'`]/;
    expect(naming(loading).sort()).toEqual([
      "apps/web/src/lib/adapters.ts",
      "packages/storage/src/google-cloud-storage/access-token.ts",
      "packages/storage/src/google-cloud-storage/client.ts",
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
      "packages/storage/src/google-cloud-storage/index.ts",
    ]);
    const subpath = readFileSync(join(repo, "packages/storage/src/google-cloud-storage/index.ts"), "utf8");
    expect(subpath).not.toMatch(/access-token|\.\/client|metadataAccessToken|Agents/);
    const barrel = readFileSync(join(repo, "packages/storage/src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/google-cloud-storage|gaxios/);
  });
});
