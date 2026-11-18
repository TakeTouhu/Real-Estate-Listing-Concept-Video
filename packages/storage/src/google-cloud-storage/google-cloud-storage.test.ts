import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Gaxios } from "gaxios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRead, ObjectStorage } from "@app/domain";
import { AppError } from "@app/shared";
import {
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
} from "./index";

/**
 * The adapter against stand-ins for the store, on this machine: what it asks,
 * and what it makes of every answer the emulator cannot give (ADR-0156,
 * ADR-0157). The emulator suite (`pnpm test:gcs`) holds what it stores.
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
 * `repeat`, as fast as they are taken; say nothing; or hang up.
 */
type Answer =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Buffer;
      readonly afterMs?: number;
      readonly cutAfter?: number;
      readonly holdOpen?: boolean;
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
      if (answered.status >= 300 && answered.status < 400) headers.location = "http://127.0.0.1:9/elsewhere";
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

// The adapter's client honours the proxy variables (ADR-0156 Decision 1); the
// stand-ins are on this machine, so none may send them elsewhere.
beforeEach(() => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, "");
});

afterEach(() => {
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
    const request = Gaxios.prototype.request;
    vi.spyOn(Gaxios.prototype, "request").mockImplementation(async function (this: Gaxios, options) {
      const response = await request.call(this, options);
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

describe("where it is constructed", () => {
  it("is constructed by no production code, and loaded by none through `@app/storage`", () => {
    // It sends no credential (ADR-0156 Decision 7, ADR-0157): the change that
    // wires it gets this review.
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
    expect(naming(/createGoogleCloudStorage\(/)).toEqual([
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
    ]);
    // Any quoted path beginning with gaxios, or naming the folder or anything below it, so an alias is caught too.
    const loading = /["'`]gaxios(?:\/[^"'`]*)?["'`]|google-cloud-storage(?:\/[\w.-]*)*["'`]/;
    expect(naming(loading).sort()).toEqual([
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
      "packages/storage/src/google-cloud-storage/index.ts",
    ]);
    const barrel = readFileSync(join(repo, "packages/storage/src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/google-cloud-storage|gaxios/);
  });
});
