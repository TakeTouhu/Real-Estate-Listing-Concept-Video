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
});
