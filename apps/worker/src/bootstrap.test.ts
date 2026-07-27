import { describe, expect, it, vi } from "vitest";
import { serverEnvSchema } from "@app/shared";
import { createLogger } from "@app/observability";
import { FakeVideoProvider } from "@app/video-providers";
import { bootstrapWorker } from "./bootstrap";

const env = serverEnvSchema.parse({
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
});

const silentLogger = createLogger({ sink: () => {} });

describe("bootstrapWorker", () => {
  it("bootstraps with the fake provider and runs an offline self-check", async () => {
    const provider = new FakeVideoProvider();
    const spy = vi.spyOn(provider, "estimateCost");
    const result = await bootstrapWorker({ env, logger: silentLogger, provider });
    expect(result).toEqual({ ready: true, provider: "fake" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("propagates provider self-check failures", async () => {
    const provider = new FakeVideoProvider();
    vi.spyOn(provider, "estimateCost").mockRejectedValueOnce(new Error("boom"));
    await expect(
      bootstrapWorker({ env, logger: silentLogger, provider }),
    ).rejects.toThrow("boom");
  });
});
