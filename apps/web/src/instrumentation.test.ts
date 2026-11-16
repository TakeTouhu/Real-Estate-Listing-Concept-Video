import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

const checkWebStart = vi.hoisted(() => vi.fn());
vi.mock("./lib/startup", () => ({ checkWebStart }));

afterEach(() => {
  vi.unstubAllEnvs();
  checkWebStart.mockClear();
});

describe("register", () => {
  it("checks the start of a Node.js server", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    await register();
    expect(checkWebStart).toHaveBeenCalledTimes(1);
    expect(checkWebStart).toHaveBeenCalledWith();
  });

  it("checks nothing in the edge runtime, or where no runtime is named", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    vi.stubEnv("NEXT_RUNTIME", "");
    await register();
    expect(checkWebStart).not.toHaveBeenCalled();
  });

  it("checks nothing while `next build` runs, by Next.js's own name for that phase", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", PHASE_PRODUCTION_BUILD);
    await register();
    expect(checkWebStart).not.toHaveBeenCalled();
  });
});
