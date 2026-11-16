import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outgoingEmail } from "@app/domain";
import { serverEnvSchema } from "@app/shared";
import { NonProductionAdapterError, readDevelopmentEmailOutbox } from "@app/storage";
import { chooseWebAdapters, createWebAdapters } from "./adapters";

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

  it("refuses production by the ambient value too, whatever the configured one says", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const adapters = createWebAdapters(serverEnvSchema.parse({ ...base, EMAIL_OUTBOX_DIR: join(dir, "outbox") }));
      expect(() => adapters.storage()).toThrow(NonProductionAdapterError);
      expect(() => adapters.malwareScanner()).toThrow(NonProductionAdapterError);
      expect(() => adapters.email()).toThrow(NonProductionAdapterError);
    } finally {
      vi.unstubAllEnvs();
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
    await adapters.email()?.send(mail);
    expect((await readDevelopmentEmailOutbox(outbox)).map((sent) => sent.to)).toEqual(["user@example.com"]);
    expect(createWebAdapters(serverEnvSchema.parse(base)).email()).toBeNull();
  });
});
