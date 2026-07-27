import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { createVideoProvider } from "./factory";
import type { HttpClient } from "./wavespeed/http";

const noopHttp: HttpClient = { request: () => Promise.resolve({ status: 200, body: "{}" }) };

const baseEnv = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
};

describe("createVideoProvider", () => {
  it("defaults to the fake provider in Phase 0", () => {
    const env = serverEnvSchema.parse(baseEnv);
    expect(createVideoProvider(env).name).toBe("fake");
  });

  it("constructs the WaveSpeed provider only when configured with a key", () => {
    const env = serverEnvSchema.parse({
      ...baseEnv,
      VIDEO_PROVIDER: "wavespeed",
      WAVESPEED_API_KEY: "k",
    });
    expect(createVideoProvider(env, { http: noopHttp }).name).toBe("wavespeed");
  });
});
