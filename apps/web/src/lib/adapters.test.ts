import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail } from "@app/domain";
import { AppError, serverEnvSchema } from "@app/shared";
import { NonProductionAdapterError, readDevelopmentEmailOutbox } from "@app/storage";
import { chooseWebAdapters } from "./adapter-choice";
import { createWebAdapters, loggingScanFailures, scanFailureCode } from "./adapters";

/** Which adapters the web app takes, from its environment alone (RD-1, ADR-0150; ADR-0085, ADR-0126). */
const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
  NODE_ENV: "test",
};
const KEY = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vta-web-adapters-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the web app's adapter choice", () => {
  it("takes the shared folder and the outbox when they are named", () => {
    const env = serverEnvSchema.parse({ ...base, SHARED_STORAGE_DIR: dir, EMAIL_OUTBOX_DIR: join(dir, "outbox") });
    expect(chooseWebAdapters(env)).toEqual({
      storage: "shared-folder",
      malwareScanner: "passthrough",
      email: "outbox",
      imageAnalysis: "deterministic",
      promptModeration: "offline",
    });
  });

  it("takes this process's memory and no email otherwise", () => {
    expect(chooseWebAdapters(serverEnvSchema.parse(base))).toMatchObject({ storage: "memory", email: "none" });
  });

  it("is made without building any adapter, so production refuses only when one is built", () => {
    const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, NODE_ENV: "production" }));
    expect(adapters.choice).toMatchObject({ storage: "memory", malwareScanner: "passthrough", email: "none" });
    expect(() => adapters.storage()).toThrow(NonProductionAdapterError);
    expect(() => adapters.malwareScanner()).toThrow(NonProductionAdapterError);
    expect(adapters.email()).toBeNull();
  });

  it("refuses production by the ambient value too, read when each adapter is built", () => {
    const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, EMAIL_OUTBOX_DIR: join(dir, "outbox") }));
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => adapters.storage()).toThrow(NonProductionAdapterError);
      expect(() => adapters.malwareScanner()).toThrow(NonProductionAdapterError);
      expect(() => adapters.email()).toThrow(NonProductionAdapterError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the web app's Cloud Storage (ADR-0159)", () => {
  const bucket = { GOOGLE_CLOUD_STORAGE_BUCKET: "vtavision-objects" };
  const emulator = { ...bucket, GOOGLE_CLOUD_STORAGE_ENDPOINT: "http://127.0.0.1:1" };
  const configurationError = (build: () => unknown): string | null => {
    try {
      build();
    } catch (error) {
      return error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
    }
    return null;
  };

  it("takes Google's store for a bucket alone, and an emulator for a bucket with an endpoint", () => {
    const google = serverEnvSchema.parse({ ...base, NODE_ENV: "production", ...bucket });
    expect(chooseWebAdapters(google).storage).toBe("gcs");
    expect(chooseWebAdapters(serverEnvSchema.parse({ ...base, ...emulator })).storage).toBe("gcs-emulator");
    // The schema refuses a bucket beside the folder; made without it, the choice names what is built.
    const both = { ...serverEnvSchema.parse({ ...base, ...emulator }), SHARED_STORAGE_DIR: dir };
    expect(chooseWebAdapters(both).storage).toBe("gcs-emulator");
  });

  it("builds an emulator outside production, once, asking nothing as it is built", () => {
    const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, ...emulator }));
    expect(adapters.storage()).toBe(adapters.storage());
  });

  it("refuses an emulator where either NODE_ENV says production, as every development adapter does", () => {
    const env = serverEnvSchema.parse({ ...base, ...emulator });
    // The schema refuses an endpoint in production; an environment made without it is refused when built.
    expect(() => createWebAdapters({ ...env, NODE_ENV: "production" }).storage()).toThrow(NonProductionAdapterError);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createWebAdapters(env).storage()).toThrow(NonProductionAdapterError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an emulator at Google's own origin, which the schema refuses too", () => {
    const env = serverEnvSchema.parse({ ...base, ...emulator });
    const google = { ...env, GOOGLE_CLOUD_STORAGE_ENDPOINT: "https://STORAGE.googleapis.com:443/" };
    expect(configurationError(() => createWebAdapters(google).storage())).toBe(
      "CONFIGURATION_ERROR: A Cloud Storage emulator cannot be Google's own store",
    );
    // An address that does not parse is the adapter's to refuse, by a code: Node's own error would carry it.
    const unparsed = { ...env, GOOGLE_CLOUD_STORAGE_ENDPOINT: "http://" };
    expect(configurationError(() => createWebAdapters(unparsed).storage())).toBe(
      "CONFIGURATION_ERROR: The storage endpoint must be an http or https origin",
    );
  });

  it("builds Google's store only where both NODE_ENV values say production, so development never asks it", () => {
    const env = serverEnvSchema.parse({ ...base, NODE_ENV: "production", ...bucket });
    const refused = "CONFIGURATION_ERROR: Google's own Cloud Storage is used only by a production build";
    // This process is not a production build: configured production alone does not vouch for it.
    expect(configurationError(() => createWebAdapters(env).storage())).toBe(refused);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(configurationError(() => createWebAdapters({ ...env, NODE_ENV: "development" }).storage())).toBe(refused);
      const adapters = createWebAdapters(env);
      expect(configurationError(() => adapters.storage())).toBeNull();
      expect(adapters.storage()).toBe(adapters.storage());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("asks the emulator the endpoint names, with no token", async () => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const env = { ...bucket, GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint };
      const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, ...env }));
      expect(await adapters.storage().exists(KEY)).toBe(false);
      expect(seen.map(({ url }) => url.split("?")[0])).toEqual(["/storage/v1/b/vtavision-objects/o"]);
      expect(seen[0]?.headers.authorization).toBeUndefined();
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("is reached only through getWebAdapters(), so the process keeps one token", () => {
    const src = join(__dirname, "..");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const naming = (pattern: RegExp) =>
      files(src).filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.slice(src.length + 1));
    expect(naming(/\.storage\(\)/).sort()).toEqual(["lib/property.ts", "lib/readiness.ts"]);
    for (const file of naming(/\.storage\(\)/)) {
      expect(readFileSync(join(src, file), "utf8")).toMatch(/getWebAdapters\(\)/);
    }
    // The mailer makes its own for each email, and never asks it for storage.
    expect(naming(/createWebAdapters\(/).sort()).toEqual(["lib/adapters.ts", "lib/mailer.ts"]);
  });
});

describe("the web app's ClamAV scanner (ADR-0164)", () => {
  type StandIn = { port: number; connections: () => number; close: () => Promise<void> };
  /**
   * A stand-in daemon on this machine that reads one scan to its zero-length chunk, then gives `answer`, and
   * counts the connections it was given.
   */
  async function daemon(answer: string): Promise<StandIn> {
    let connections = 0;
    const server = createTcpServer((socket) => {
      connections += 1;
      let seen = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        seen = Buffer.concat([seen, chunk]);
        if (seen.length > 14 && seen.subarray(-4).equals(Buffer.alloc(4))) socket.end(`${answer}\0`);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return { port, connections: () => connections, close: () => new Promise((done) => server.close(() => done())) };
  }
  const scannerFor = (port: number) =>
    createWebAdapters(serverEnvSchema.parse({ ...base, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(port) }));

  it("takes the daemon CLAMAV_HOST names, and the test scanner otherwise", () => {
    expect(chooseWebAdapters(serverEnvSchema.parse({ ...base, CLAMAV_HOST: "clamav" })).malwareScanner).toBe("clamav");
    expect(chooseWebAdapters(serverEnvSchema.parse(base)).malwareScanner).toBe("passthrough");
  });

  it("is built in production, once, connecting to nothing as it is built", async () => {
    const stand = await daemon("stream: OK");
    vi.stubEnv("NODE_ENV", "production");
    try {
      const settings = { NODE_ENV: "production", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(stand.port) };
      const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, ...settings }));
      expect(adapters.choice.malwareScanner).toBe("clamav");
      expect(adapters.malwareScanner()).toBe(adapters.malwareScanner());
      // A connection would have been taken by now.
      await new Promise((settled) => setImmediate(settled));
      await new Promise((settled) => setImmediate(settled));
      expect(stand.connections()).toBe(0);
      // The same scanner connects once it scans.
      expect(await adapters.malwareScanner().scan(new Uint8Array([1]))).toEqual({ verdict: "CLEAN" });
      expect(stand.connections()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await stand.close();
    }
  });

  it("asks the daemon, at the port given", async () => {
    const cases = [["stream: OK", "CLEAN"], ["stream: Eicar-Signature FOUND", "INFECTED"]] as const;
    for (const [answer, verdict] of cases) {
      const stand = await daemon(answer);
      try {
        expect(await scannerFor(stand.port).malwareScanner().scan(new Uint8Array([1, 2, 3]))).toEqual({ verdict });
      } finally {
        await stand.close();
      }
    }
  });

  it("logs each scan that could not be completed by its code alone", async () => {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(JSON.parse(line)));
    try {
      const stand = await daemon("stream: Eicar-Signature FOUND");
      await stand.close();
      // Nothing listens there now: the connection is refused.
      const result = await scannerFor(stand.port).malwareScanner().scan(new Uint8Array([1]));
      expect(result).toEqual({ verdict: "SCAN_FAILED", detail: "ECONNREFUSED" });
      const line = { severity: "WARNING", component: "malware-scan", message: "A malware scan could not be completed" };
      expect(lines).toEqual([{ ...line, code: "ECONNREFUSED", time: expect.any(String) }]);
      expect(JSON.stringify(lines)).not.toContain(String(stand.port));
      // A scan that ends in a verdict logs nothing: the daemon's detection, and the test scanner's, detail and all.
      const found = await daemon("stream: Eicar-Signature FOUND");
      try {
        const verdict = await scannerFor(found.port).malwareScanner().scan(new Uint8Array([1]));
        expect(verdict).toEqual({ verdict: "INFECTED" });
      } finally {
        await found.close();
      }
      const passthrough = createWebAdapters(serverEnvSchema.parse(base)).malwareScanner();
      await passthrough.scan(new Uint8Array([1]));
      const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
      expect((await passthrough.scan(new TextEncoder().encode(eicar))).verdict).toBe("INFECTED");
      expect(lines).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("logs another scanner's detail only by the code it filters to, never the detail itself", async () => {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(JSON.parse(line)));
    try {
      const detail = "connect ECONNREFUSED 10.0.0.7:3310";
      const scanner = loggingScanFailures({ scan: () => Promise.resolve({ verdict: "SCAN_FAILED", detail }) });
      // The verdict and its detail reach the domain unchanged; only the log is filtered.
      expect(await scanner.scan(new Uint8Array([1]))).toEqual({ verdict: "SCAN_FAILED", detail });
      expect(lines).toEqual([expect.objectContaining({ component: "malware-scan", code: "UNEXPECTED" })]);
      expect(JSON.stringify(lines)).not.toMatch(/10\.0\.0\.7|3310|ECONNREFUSED/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves the verdict as it was when the log cannot be written", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("the log is closed");
    });
    try {
      const idle = { verdict: "SCAN_FAILED", detail: "CLAMAV_IDLE" } as const;
      const scanner = loggingScanFailures({ scan: () => Promise.resolve(idle) });
      expect(await scanner.scan(new Uint8Array([1]))).toEqual({ verdict: "SCAN_FAILED", detail: "CLAMAV_IDLE" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("logs a code only when it is one plain word of capitals, digits and underscores, 40 at most", () => {
    for (const code of ["CLAMAV_IDLE", "ECONNREFUSED", "P1001", "A".repeat(40)]) {
      expect(scanFailureCode(code)).toBe(code);
    }
    const others = [undefined, "", "connect ECONNREFUSED 10.0.0.7:3310", "Eicar-Signature", "A".repeat(41)];
    for (const detail of [...others, "eicar", "10.0.0.7", "HOST:3310", "_X", "CLAMAV IDLE"]) {
      expect(scanFailureCode(detail)).toBe("UNEXPECTED");
    }
  });
});

describe("the web app's adapters", () => {
  it("store in the shared folder when it is chosen", async () => {
    const env = serverEnvSchema.parse({ ...base, SHARED_STORAGE_DIR: dir });
    await createWebAdapters(env).storage().putObject(KEY, new Uint8Array([1, 2]));
    expect(await readdir(join(dir, "objects"))).toEqual(["org"]);
    expect(await createWebAdapters(env).storage().getObject(KEY)).toEqual(new Uint8Array([1, 2]));
  });

  it("store in this process's own memory otherwise, as before", async () => {
    const env = serverEnvSchema.parse(base);
    await createWebAdapters(env).storage().putObject(KEY, new Uint8Array([1, 2]));
    expect(await createWebAdapters(env).storage().getObject(KEY)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it("are each built once and then kept", async () => {
    const adapters = createWebAdapters(serverEnvSchema.parse(base));
    await adapters.storage().putObject(KEY, new Uint8Array([3]));
    expect(await adapters.storage().getObject(KEY)).toEqual(new Uint8Array([3]));
    for (const port of ["storage", "malwareScanner", "images", "imageAnalysis", "promptModerator"] as const) {
      expect(adapters[port]()).toBe(adapters[port]());
    }
  });

  it("open the outbox for each email, and none when no email is configured", async () => {
    const outbox = join(dir, "outbox");
    const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, EMAIL_OUTBOX_DIR: outbox }));
    const mail = outgoingEmail({ kind: "PASSWORD_RESET", to: "user@example.com", subject: "Subject", text: "Text" });
    expect(adapters.email()).not.toBe(adapters.email());
    await adapters.email()?.send(mail);
    expect((await readDevelopmentEmailOutbox(outbox)).map((sent) => sent.to)).toEqual(["user@example.com"]);
    expect(createWebAdapters(serverEnvSchema.parse(base)).email()).toBeNull();
  });
});
