import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { FakeVideoProvider } from "@app/video-providers";
import { buildLiveness, computeReadiness } from "./health";

const env = serverEnvSchema.parse({
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
});

describe("buildLiveness", () => {
  it("returns ok with service metadata", () => {
    const live = buildLiveness(() => new Date("2026-01-01T00:00:00.000Z"));
    expect(live.status).toBe("ok");
    expect(live.time).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("computeReadiness", () => {
  it("reports ready when the provider adapter self-check passes", async () => {
    const readiness = await computeReadiness(env, new FakeVideoProvider());
    expect(readiness.status).toBe("ready");
    expect(readiness.provider).toBe("fake");
    expect(readiness.checks[0]).toMatchObject({ name: "video-provider-adapter", ok: true });
  });

  it("reports degraded when the provider self-check throws", async () => {
    const failing = new FakeVideoProvider();
    failing.estimateCost = () => Promise.reject(new Error("nope"));
    const readiness = await computeReadiness(env, failing);
    expect(readiness.status).toBe("degraded");
    expect(readiness.checks[0]?.ok).toBe(false);
  });
});
