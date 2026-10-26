import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { createObjectStorage } from "./property";

/** Which store the web app takes, from its environment alone (ADR-0085). */
const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
  NODE_ENV: "test",
};
const KEY = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vta-web-storage-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the web app's object storage", () => {
  it("is the shared folder when SHARED_STORAGE_DIR names one", async () => {
    const env = serverEnvSchema.parse({ ...base, SHARED_STORAGE_DIR: dir });
    await createObjectStorage(env).putObject(KEY, new Uint8Array([1, 2]));
    expect(await readdir(join(dir, "objects"))).toEqual(["org"]);
    expect(await createObjectStorage(env).getObject(KEY)).toEqual(new Uint8Array([1, 2]));
  });

  it("is this process's own memory otherwise, as before", async () => {
    const env = serverEnvSchema.parse(base);
    await createObjectStorage(env).putObject(KEY, new Uint8Array([1, 2]));
    expect(await createObjectStorage(env).getObject(KEY)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
