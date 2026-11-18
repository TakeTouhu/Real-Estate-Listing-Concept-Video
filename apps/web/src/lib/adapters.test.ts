import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail } from "@app/domain";
import { AppError, serverEnvSchema } from "@app/shared";
import { NonProductionAdapterError, readDevelopmentEmailOutbox } from "@app/storage";
import { chooseWebAdapters } from "./adapter-choice";
import { createWebAdapters } from "./adapters";

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
