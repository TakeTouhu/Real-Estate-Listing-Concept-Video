import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import {
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
  type GoogleCloudStorageObjects,
} from "./index";

/**
 * The adapter against stand-ins for the store, on this machine: what it asks,
 * and what it makes of every answer the emulator cannot give (ADR-0156). The
 * emulator suite (`pnpm test:gcs`) holds what it stores.
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

/** What a stand-in does with a request: answer it, after a wait or at once, say nothing, or hang up. */
type Answer = { readonly status: number; readonly body?: string; readonly afterMs?: number } | "SILENT" | "HANG_UP";

interface StandIn {
  readonly origin: string;
  readonly seen: Seen[];
}

const servers: Array<{ close(): void; closeAllConnections(): void }> = [];

async function standIn(answer: (request: Seen) => Answer): Promise<StandIn> {
  const seen: Seen[] = [];
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
      const send = () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (answered.status >= 300 && answered.status < 400) headers.location = "http://127.0.0.1:9/elsewhere";
        response.writeHead(answered.status, headers).end(answered.body ?? "");
      };
      if (answered.afterMs === undefined) send();
      else setTimeout(send, answered.afterMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

// The adapter's client honours the proxy variables (ADR-0156 Decision 1); the
// stand-ins are on this machine, so none may send them elsewhere.
beforeEach(() => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

const storeAt = (origin: string): GoogleCloudStorageObjects =>
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
      ]) {
        const error = await failureOf(call);
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({
          code: "INTERNAL_ERROR",
          message: "A stored object's key must be canonical, and one Cloud Storage can name",
        });
      }
    }
    expect(store.seen).toEqual([]);
    // Signing asks the store nothing; the longest names, by bytes, are asked.
    await storage.createSignedUploadUrl(ASSET, 60);
    await storage.createSignedDownloadUrl(ASSET, 60);
    expect(store.seen).toEqual([]);
    expect(await storage.exists(longest)).toBe(false);
    expect(await storage.exists(`org/${"é".repeat(510)}`)).toBe(false);
    expect(store.seen).toHaveLength(2);
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
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_500);
    expect(store.seen).toHaveLength(1);
  });

  it("gives the list after a read that found nothing the same limit, and asks it once", async () => {
    const store = await standIn((request) => (request.url.includes("/o?prefix=") ? "SILENT" : { status: 404 }));
    const started = performance.now();
    expect(await failureOf(() => storeAt(store.origin).getObject(ASSET))).toMatchObject({ code: "STORAGE_TIMEOUT" });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 1_500);
    expect(store.seen).toHaveLength(2);
  });

  it("gives a whole object's read no limit", async () => {
    const afterMs = GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS + 500;
    const store = await standIn(() => ({ status: 200, body: "\u0007", afterMs }));
    expect(await storeAt(store.origin).getObject(ASSET)).toEqual(new Uint8Array([7]));
  });
});

describe("where it is constructed", () => {
  it("is constructed by no production code, and loaded by none through `@app/storage`", () => {
    // It has no streamed read and sends no credential (ADR-0156 Decision 7):
    // the change that wires it gets this review.
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
    // Any import of gaxios or of the folder, by any path below it, so an alias is caught too.
    const loading = /["']gaxios(?:\/[^"']*)?["']|google-cloud-storage(?:\/[\w.-]+)*["']/;
    expect(naming(loading).sort()).toEqual([
      "packages/storage/src/google-cloud-storage/google-cloud-storage.ts",
      "packages/storage/src/google-cloud-storage/index.ts",
    ]);
    const barrel = readFileSync(join(repo, "packages/storage/src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/google-cloud-storage|gaxios/);
  });
});
