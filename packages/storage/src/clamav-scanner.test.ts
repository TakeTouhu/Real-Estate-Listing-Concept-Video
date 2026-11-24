import { readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { CLAMAV_CHUNK_BYTES, createClamAvScanner } from "./clamav-scanner";

const servers: Server[] = [];
const peers: Socket[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** A stand-in daemon on this machine: `behave` is given each connection as it opens. */
async function daemon(behave: (socket: Socket) => void): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    peers.push(socket);
    socket.on("error", () => undefined);
    behave(socket);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

/** The request's chunks, once its length of zero has arrived; undefined until then. */
function chunksOf(request: Buffer): number[] | undefined {
  if (request.length < 10) return undefined;
  const lengths: number[] = [];
  for (let at = 10; at + 4 <= request.length; ) {
    const length = request.readUInt32BE(at);
    lengths.push(length);
    if (length === 0) return lengths;
    at += 4 + length;
  }
  return undefined;
}

/** Reads the whole request, then calls `then` with it. */
const afterRequest =
  (then: (socket: Socket, request: Buffer) => void) =>
  (socket: Socket): void => {
    const parts: Buffer[] = [];
    socket.on("data", (part: Buffer) => {
      parts.push(part);
      const request = Buffer.concat(parts);
      if (chunksOf(request) !== undefined) then(socket, request);
    });
  };

const answer = (text: string) => afterRequest((socket) => socket.end(text));
const scanner = (port: number) => createClamAvScanner({ host: "127.0.0.1", port, idleLimitMs: 300 });
const small = new Uint8Array([1, 2, 3]);
/** More than this machine's connection holds unread, so sending it waits on a daemon that does not read. */
const large = new Uint8Array(16 * 1024 * 1024);

describe("createClamAvScanner", () => {
  it("sends zINSTREAM, the photo in 64 KiB chunks each after its length, then a length of zero", async () => {
    let sent = Buffer.alloc(0);
    const { port } = await daemon(
      afterRequest((socket, request) => {
        sent = request;
        socket.end("stream: OK\0");
      }),
    );
    const photo = new Uint8Array(150_000).map((_, i) => i % 251);
    expect(await scanner(port).scan(photo)).toEqual({ verdict: "CLEAN" });
    expect(sent.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
    expect(chunksOf(sent)).toEqual([CLAMAV_CHUNK_BYTES, CLAMAV_CHUNK_BYTES, 150_000 - 2 * CLAMAV_CHUNK_BYTES, 0]);
    const body: Buffer[] = [];
    for (let at = 10; sent.readUInt32BE(at) !== 0; at += 4 + sent.readUInt32BE(at)) {
      body.push(sent.subarray(at + 4, at + 4 + sent.readUInt32BE(at)));
    }
    expect(Buffer.concat(body).equals(Buffer.from(photo))).toBe(true);
    expect(sent.length).toBe(10 + 3 * 4 + 150_000 + 4);
  });

  it("sends an empty photo as the command and a length of zero alone", async () => {
    let sent = "";
    const { port } = await daemon(
      afterRequest((socket, request) => {
        sent = request.toString("hex");
        socket.end("stream: OK\0");
      }),
    );
    expect(await scanner(port).scan(new Uint8Array(0))).toEqual({ verdict: "CLEAN" });
    expect(sent).toBe(`${Buffer.from("zINSTREAM\0").toString("hex")}00000000`);
  });

  it("reads FOUND as INFECTED with no detail, so no signature's name goes further", async () => {
    const { port } = await daemon(answer("stream: Win.Test.EICAR_HDB-1 FOUND\0"));
    expect(await scanner(port).scan(small)).toEqual({ verdict: "INFECTED" });
  });

  it.each([
    ["a photo not read in full", "stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0", "CLAMAV_LIMITS_EXCEEDED"],
    ["the size limit's refusal", "INSTREAM size limit exceeded. ERROR\0", "CLAMAV_SIZE_LIMIT"],
    ["any other refusal", "stream: Can't allocate memory ERROR\0", "CLAMAV_ERROR"],
    ["an answer with no NUL", "stream: OK", "CLAMAV_UNEXPECTED_ANSWER"],
    ["two answers", "stream: OK\0stream: Eicar FOUND\0", "CLAMAV_UNEXPECTED_ANSWER"],
    ["OK with more after it", "stream: OK trailing\0", "CLAMAV_UNEXPECTED_ANSWER"],
    ["a name with a space", "stream: Two Words FOUND\0", "CLAMAV_UNEXPECTED_ANSWER"],
    ["the daemon's read timeout", "COMMAND READ TIMED OUT\n", "CLAMAV_UNEXPECTED_ANSWER"],
    ["an answer from something else", "HTTP/1.1 400 Bad Request\r\n\r\n", "CLAMAV_UNEXPECTED_ANSWER"],
    ["nothing at all", "", "CLAMAV_CLOSED"],
  ])("reads %s as SCAN_FAILED by its code", async (_, text, code) => {
    const { port } = await daemon(answer(text));
    expect(await scanner(port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: code });
  });

  it("gives up on an answer longer than any of the daemon's", async () => {
    const { port } = await daemon(afterRequest((socket) => socket.write("x".repeat(1025))));
    expect(await scanner(port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_UNEXPECTED_ANSWER" });
  });

  it("reads an answer only when the daemon closes its side: OK left open is a quiet connection", async () => {
    const { port } = await daemon(afterRequest((socket) => socket.write("stream: OK\0")));
    expect(await scanner(port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_IDLE" });
  });

  it("gives up on a daemon that reads everything and never answers", async () => {
    const { port } = await daemon((socket) => socket.resume());
    expect(await scanner(port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_IDLE" });
  });

  it("gives up on a daemon that stops reading, without the photo's sending ever finishing", async () => {
    const { port } = await daemon((socket) => socket.once("data", () => socket.pause()));
    expect(await scanner(port).scan(large)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_IDLE" });
  });

  it("never reads OK sent before the whole photo was, as CLEAN", async () => {
    const { port } = await daemon((socket) => {
      socket.pause();
      socket.end("stream: OK\0");
    });
    expect(await scanner(port).scan(large)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_EARLY_ANSWER" });
  });

  it("keeps a refusal sent before the whole photo was, through the connection's reset", async () => {
    const { port } = await daemon((socket) => {
      socket.pause();
      socket.write("INSTREAM size limit exceeded. ERROR\0", () => setTimeout(() => socket.resetAndDestroy(), 100));
    });
    expect(await scanner(port).scan(large)).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_SIZE_LIMIT" });
  });

  it("never reads OK cut off by a reset as CLEAN", async () => {
    const { port } = await daemon(
      afterRequest((socket) => socket.write("stream: OK\0", () => setTimeout(() => socket.resetAndDestroy(), 100))),
    );
    expect(await scanner(port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: "ECONNRESET" });
  });

  it("passes on the transport's code for a reset or a refused connection", async () => {
    const reset = await daemon((socket) => socket.resetAndDestroy());
    const code = (await scanner(reset.port).scan(large)).detail;
    expect(["ECONNRESET", "EPIPE"]).toContain(code);
    const closed = await daemon(() => undefined);
    await new Promise((done) => servers.pop()?.close(done));
    expect(await scanner(closed.port).scan(small)).toEqual({ verdict: "SCAN_FAILED", detail: "ECONNREFUSED" });
  });

  it("scans several photos at once on separate connections", async () => {
    const { port, connections } = await daemon(answer("stream: OK\0"));
    const scan = scanner(port);
    const results = await Promise.all([small, small, small].map((photo) => scan.scan(photo)));
    expect(results).toEqual([{ verdict: "CLEAN" }, { verdict: "CLEAN" }, { verdict: "CLEAN" }]);
    expect(connections()).toBe(3);
  });

  it("refuses a host, port or idle limit it cannot use, repeating none of them, and connects to nothing", async () => {
    const refusal = (build: () => unknown): string | null => {
      try {
        build();
      } catch (error) {
        return error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      }
      return null;
    };
    const hosts = ["", "clamav:3310", "tcp://clamav", "[::1]", "user@clamav", "clam av", "-clamav", "fe80::1%eth0"];
    for (const host of hosts) {
      expect(refusal(() => createClamAvScanner({ host }))).toBe(
        "CONFIGURATION_ERROR: The ClamAV host must be a DNS name or an IP address, with no port",
      );
    }
    for (const port of [0, 65_536, 3310.5, Number.NaN]) {
      expect(refusal(() => createClamAvScanner({ host: "clamav", port }))).toBe(
        "CONFIGURATION_ERROR: The ClamAV port must be a whole number from 1 to 65535",
      );
    }
    for (const idleLimitMs of [0, -1, 1.5]) {
      expect(refusal(() => createClamAvScanner({ host: "clamav", idleLimitMs }))).toBe(
        "CONFIGURATION_ERROR: The ClamAV idle limit must be a whole number of milliseconds",
      );
    }
    const { port, connections } = await daemon(() => undefined);
    for (const host of ["clamav", "clamav.internal", "10.0.0.7", "::1", "fd00::7", "127.0.0.1"]) {
      expect(refusal(() => createClamAvScanner({ host, port }))).toBeNull();
    }
    await new Promise((done) => setTimeout(done, 50));
    expect(connections()).toBe(0);
  });
});

describe("who builds it", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..");

  /** Every source file outside the tests, comments stripped so prose naming the adapter does not count. */
  function sources(dir: string): { name: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return ["node_modules", ".next"].includes(entry.name) ? [] : sources(full);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
      const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      return [{ name: full.slice(REPO_ROOT.length + 1), text }];
    });
  }

  it("is built by nothing in either application or any package yet (ADR-0163)", () => {
    const files = [...sources(join(REPO_ROOT, "apps")), ...sources(join(REPO_ROOT, "packages"))];
    expect(files.map(({ name }) => name)).toContain("apps/web/src/lib/adapters.ts");
    const naming = files.filter(({ text }) => /createClamAvScanner|clamav-scanner/.test(text));
    expect(naming.map(({ name }) => name).sort()).toEqual([
      "packages/storage/src/clamav-scanner.ts",
      "packages/storage/src/index.ts",
    ]);
  });
});
