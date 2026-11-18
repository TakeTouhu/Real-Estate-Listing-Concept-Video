import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { chooseWebAdapters } from "@/lib/adapter-choice";
import { createWebAdapters } from "@/lib/adapters";
import { createEmulatorBucket, emulatorEndpoint, emulatorObjectNames } from "./emulator";

/**
 * The web app's own storage, as its environment chooses it, against the Cloud
 * Storage emulator (ADR-0159): a bucket and an endpoint outside production
 * choose the emulator, which the web app's adapters build and keep.
 */

const KEY = "org/org_1/properties/prp_1/assets/ast_1/normalized.jpg";

beforeAll(() => {
  // A proxy that is not there: the adapter's requests go straight to the emulator (ADR-0158).
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, "http://127.0.0.1:9");
  for (const name of ["NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("the web app's storage in the emulator", () => {
  it("is chosen by a bucket and an endpoint, built once, and stores, reads and deletes", async () => {
    const endpoint = emulatorEndpoint();
    const bucket = await createEmulatorBucket(endpoint);
    const env = serverEnvSchema.parse({
      NODE_ENV: "test",
      SESSION_SECRET: "session-secret-abcdef123456",
      HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
      STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
      GOOGLE_CLOUD_STORAGE_BUCKET: bucket,
      GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint,
    });
    expect(chooseWebAdapters(env).storage).toBe("gcs-emulator");
    const adapters = createWebAdapters(env);
    const storage = adapters.storage();
    expect(adapters.storage()).toBe(storage);
    expect(await storage.exists(KEY)).toBe(false);
    await storage.putObject(KEY, new Uint8Array([1, 2, 3]));
    expect(await storage.exists(KEY)).toBe(true);
    expect(await storage.getObject(KEY)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([KEY]);
    await storage.deleteObject(KEY);
    expect(await emulatorObjectNames(endpoint, bucket)).toEqual([]);
  });
});
