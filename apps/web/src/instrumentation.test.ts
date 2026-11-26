import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Instrumentation } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError, register } from "./instrumentation";

const checkWebStart = vi.hoisted(() => vi.fn());
vi.mock("./lib/startup", () => ({ checkWebStart }));

// Mocked, so no case here replaces the worker's own console (ADR-0186).
const installConsoleBridge = vi.hoisted(() => vi.fn());
vi.mock("./lib/console-bridge", () => ({ installConsoleBridge }));

const logUncaught = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("./lib/failure-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/failure-log")>()),
  logUncaughtRequestFailure: logUncaught.spy,
}));

// Set before each test, so neither the order of tests nor `restoreAllMocks` loses the pass-through.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("./lib/failure-log")>("./lib/failure-log");
  logUncaught.spy.mockImplementation(actual.logUncaughtRequestFailure);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  checkWebStart.mockReset();
  installConsoleBridge.mockClear();
  logUncaught.spy.mockClear();
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

  it("bridges the console of a production Node.js server, after its start passed the check", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    await register();
    expect(installConsoleBridge).toHaveBeenCalledTimes(1);
    expect(installConsoleBridge).toHaveBeenCalledWith();
    const [checked = Infinity] = checkWebStart.mock.invocationCallOrder;
    expect(checked).toBeLessThan(installConsoleBridge.mock.invocationCallOrder[0] ?? 0);
  });

  it("bridges nothing when the check ends the start, nor in the edge runtime, development or a test", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    checkWebStart.mockImplementationOnce(() => {
      throw new Error("process.exit(1)");
    });
    await expect(register()).rejects.toThrow("process.exit(1)");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    for (const environment of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", environment);
      await register();
    }
    expect(installConsoleBridge).not.toHaveBeenCalled();
  });
});

describe("onRequestError", () => {
  // Next.js's own type of the hook: a change that drops or retypes a field the hook reads fails the typecheck.
  const hook: Instrumentation.onRequestError = onRequestError;
  const error = new Error("failed at /properties/p1?token=s3cret");
  const request = { path: "/properties/p1?token=s3cret", method: "GET", headers: { cookie: "session=s3cret" } };
  const context = {
    routerKind: "App Router",
    routePath: "/properties/[propertyId]",
    routeType: "render",
    renderSource: "react-server-components",
    revalidateReason: undefined,
  } as const;

  it("logs one line in Node.js, passing the method and the context, never the path or headers", async () => {
    const raw: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void raw.push(line));
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await hook(error, request, context);
    expect(logUncaught.spy).toHaveBeenCalledTimes(1);
    expect(logUncaught.spy).toHaveBeenCalledWith(error, "GET", context);
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toMatch(/s3cret|token|cookie|\/p1/);
    expect(JSON.parse(raw[0] ?? "{}")).toMatchObject({
      message: "Next.js answered a request that failed",
      route: "GET /properties/[propertyId]",
    });
  });

  it("logs nothing, and throws nothing, in the edge runtime or where no runtime is named", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(onRequestError(error, request, context)).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "");
    await expect(onRequestError(error, request, context)).resolves.toBeUndefined();
    expect(logUncaught.spy).not.toHaveBeenCalled();
  });

  it("loads the logger only through the import inside the test of the runtime, so the edge build lacks it", () => {
    const source = readFileSync(join(__dirname, "instrumentation.ts"), "utf8");
    const named = [...source.matchAll(/^.*["']\.\/lib\/failure-log["'].*$/gm)].map(([line]) => line.trim());
    expect(named).toEqual([
      'import type { UncaughtRequestContext } from "./lib/failure-log";',
      'const { logUncaughtRequestFailure } = await import("./lib/failure-log");',
    ]);
    expect(source.indexOf('await import("./lib/failure-log")')).toBeGreaterThan(
      source.indexOf('if (process.env.NEXT_RUNTIME === "nodejs") {', source.indexOf("onRequestError(")),
    );
  });
});
