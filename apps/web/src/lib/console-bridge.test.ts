import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installConsoleBridge, stackFrames } from "./console-bridge";

/** The console bridge (ADR-0186), on a console and a sink of the test's own: never the global console. */
function bridged() {
  const raw: string[] = [];
  const original = { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() };
  const target = { ...original };
  const restore = installConsoleBridge(target, (line) => void raw.push(line));
  const lines = () => raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { raw, original, target, restore, lines };
}

const SECRET = /s3cret|token|canary/;
const IPV4 = "Failed to resolve IPv4 addresses with current network";

describe("installConsoleBridge", () => {
  it("writes one line for error and for warn, by severity, never the message or the stack's header", () => {
    const { raw, original, target, lines } = bridged();
    const error = new TypeError("failed at /x?token=s3cret");
    target.error(" ⨯", error);
    target.warn("token=s3cret", { password: "s3cret" });
    expect([original.error.mock.calls, original.warn.mock.calls, raw.length]).toEqual([[], [], 2]);
    expect(raw.join("\n")).not.toMatch(SECRET);
    expect(lines()[0]).toEqual({
      severity: "ERROR",
      time: lines()[0]?.time,
      message: "The web server printed an error",
      component: "console",
      method: "error",
      errorName: "TypeError",
      code: "UNEXPECTED",
      frames: expect.arrayContaining([expect.stringMatching(/^at .*console-bridge\.test\.ts:\d+:\d+\)?$/)]),
    });
    const { time, ...warning } = lines()[1] ?? {};
    expect([typeof time, warning]).toEqual([
      "string",
      { severity: "WARNING", message: "The web server printed a warning", component: "console", method: "warn" },
    ]);
  });

  it("names the error however Next.js passes it, from another realm or with a tag of its own, and a digest", () => {
    const { target, lines } = bridged();
    const error = Object.assign(new Error("x"), { digest: "917604536", code: "P1001" });
    target.error(error);
    target.error(" ⨯", error);
    target.error("Error in instrumentation.onRequestError:", error);
    target.error(runInNewContext("new RangeError('x')"));
    target.error(" ⨯", Object.defineProperty(new SyntaxError("x"), Symbol.toStringTag, { value: "Tagged" }));
    target.error(Object.assign(new Error("x"), { digest: "NEXT_REDIRECT;replace;/x?token=s3cret;307;" }));
    const named = lines().map(({ errorName, code, digest }) => ({ errorName, code, digest }));
    expect(named.slice(0, 3)).toEqual(Array(3).fill({ errorName: "Error", code: "P1001", digest: "917604536" }));
    expect(named.slice(3)).toEqual([
      { errorName: "RangeError", code: "UNEXPECTED", digest: undefined },
      { errorName: "SyntaxError", code: "UNEXPECTED", digest: undefined },
      { errorName: "Error", code: "UNEXPECTED", digest: undefined },
    ]);
  });

  it("keeps an allowed text only when it is exactly the text", () => {
    const { target, lines } = bridged();
    target.warn(IPV4);
    target.warn("Failed to resolve IPv6 addresses with current network");
    target.warn(`${IPV4} at 10.0.0.1`);
    target.warn("%s", IPV4.slice(0, 20));
    expect(lines().map((line) => line.text)).toEqual([IPV4, IPV4.replace("4", "6"), undefined, undefined]);
  });

  it("reads nothing from a plain object, and never throws: a throwing getter, null, a symbol, no argument", () => {
    const { target, lines } = bridged();
    target.error({ name: "alice", code: "SECRET_CODE", stack: "x\n    at y" });
    expect(Object.keys(lines().pop() ?? {})).toEqual(["severity", "time", "message", "component", "method"]);
    const stack = "Error: SECRET\n    at SECRET_FRAME (/a.js:1:1)";
    target.error({ [Symbol.toStringTag]: "Error", name: "Error", message: "SECRET", stack });
    expect(Object.keys(lines().pop() ?? {})).toEqual(["severity", "time", "message", "component", "method"]);
    const hostile = Object.defineProperty(new Error("x"), "name", {
      get: () => {
        throw new Error("no name");
      },
    });
    for (const args of [[hostile], [null], [Symbol("s")], [], [undefined, 1n]]) {
      expect(() => target.error(...args)).not.toThrow();
    }
    expect(lines()).toHaveLength(7);
    expect(lines()[2]).toMatchObject({ errorName: "UNNAMED", code: "UNEXPECTED" });
    const failing = { error: vi.fn(), warn: vi.fn() };
    installConsoleBridge(failing, () => {
      throw new Error("sink down");
    });
    expect(() => failing.warn(new Error("x"))).not.toThrow();
    expect(() => failing.error(new Error("x"))).not.toThrow();
  });

  it("writes a line for a revoked proxy, and only `method` for a call made while a line is built", () => {
    const { target, lines } = bridged();
    const { proxy, revoke } = Proxy.revocable(new Error("r"), {});
    revoke();
    target.error(proxy);
    expect(lines()).toEqual([expect.objectContaining({ method: "error" })]);
    expect(lines()[0]).not.toHaveProperty("errorName");
    const reentrant = Object.defineProperty(new Error("x"), "name", {
      get: () => {
        target.error(reentrant);
        return "Error";
      },
    });
    target.warn(reentrant);
    expect(lines().length).toBeGreaterThan(2);
    expect(lines().slice(1, -1).every((line) => Object.keys(line).at(-1) === "method")).toBe(true);
    expect(lines().at(-1)).toMatchObject({ method: "warn", errorName: "Error" });
  });

  it("leaves log and info alone, installs once, and restores only a method still the bridge's", () => {
    const { raw, original, target, restore } = bridged();
    expect([target.log, target.info]).toEqual([original.log, original.info]);
    const bridge = target.error;
    expect(installConsoleBridge(target, () => undefined)).toBe(restore);
    expect(target.error).toBe(bridge);
    target.error(new Error("x"));
    expect(raw).toHaveLength(1);
    const replaced = vi.fn();
    target.error = replaced;
    restore();
    restore();
    expect([target.error, target.warn]).toEqual([replaced, original.warn]);
    const other = bridged();
    other.target.warn = replaced;
    other.restore();
    expect([other.target.error, other.target.warn]).toEqual([other.original.error, replaced]);
  });
});

describe("stackFrames", () => {
  const withStack = (stack: string, message = "m") => Object.assign(new Error(message), { stack });

  it("keeps only the frames after the exact header, never a frame-shaped line of the message", () => {
    const message = "boom\n    at fake (/x?token=s3cret)";
    const error = withStack(`Error: ${message}\n    at real (/app/a.js:1:2)\n    at /app/b.js:3:4`, message);
    expect(stackFrames(error)).toEqual(["at real (/app/a.js:1:2)", "at /app/b.js:3:4"]);
    // V8's own header for an empty message and for an empty name.
    expect(stackFrames(withStack("Error\n    at a (/a.js:1:1)", ""))).toEqual(["at a (/a.js:1:1)"]);
    const unnamed = Object.assign(withStack("m\n    at a (/a.js:1:1)"), { name: "" });
    expect(stackFrames(unnamed)).toEqual(["at a (/a.js:1:1)"]);
    expect(stackFrames(new Error("real")).length).toBeGreaterThan(0);
  });

  it("gives no frames when the stack does not start with the header", () => {
    expect(stackFrames(withStack("Error: other\n    at a (/a.js:1:1)"))).toEqual([]);
    expect(stackFrames(withStack("Error: m    at a (/a.js:1:1)"))).toEqual([]);
    const changed = new Error("m");
    void changed.stack;
    changed.message = "changed";
    expect(stackFrames(changed)).toEqual([]);
    expect(stackFrames({ name: "N", stack: "Error\n    at a (/a.js:1:1)" })).toEqual([]);
    expect(stackFrames(Object.assign(new Error("m"), { stack: undefined }))).toEqual([]);
  });

  it("keeps a frame only when it ends where V8 says it ran, so text shaped like one is dropped", () => {
    const real = [
      "at async Promise.all (index 0)",
      "at new Foo (file:///app/a.mjs:1:2)",
      "at eval (eval at f (/app/a.js:1:2), <anonymous>:1:1)",
      "at <anonymous>",
      "at Object.<anonymous> (/app/a.js:1:2)",
      "at x (native)",
      "at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ];
    const fake = ["at token=SECRET (x)", "at SECRET", "at f (/a.js:1:2) SECRET", "at f (/a.js:1)"];
    expect(stackFrames(withStack(`Error: m\n    ${[...real, ...fake].join("\n    ")}`))).toEqual(real);
    // A message shortened after the stack's first read: its old lines follow the new header, and are not frames.
    const shortened = new Error("a\n    at SECRET (y)");
    void shortened.stack;
    shortened.message = "a";
    expect(stackFrames(shortened).some((frame) => frame.includes("SECRET"))).toBe(false);
  });

  it("reads Node.js's coded header and the place `vm` puts before a header, and nothing else", () => {
    // As Node.js 22.23.4 writes `Buffer.alloc(-1)`'s stack outside Vitest, which gives the plain header.
    const stack = "RangeError [ERR_OUT_OF_RANGE]: m\n    at Function.alloc (node:buffer:399:3)";
    const coded = Object.assign(new RangeError("m"), { code: "ERR_OUT_OF_RANGE", stack });
    expect(stackFrames(coded)).toEqual(["at Function.alloc (node:buffer:399:3)"]);
    // Node.js's own errors with an empty message keep the colon and space.
    const empty = { code: "ERR_ACCESS_DENIED", stack: "Error [ERR_ACCESS_DENIED]: \n    at a (node:fs:1:2)" };
    expect(stackFrames(Object.assign(new Error(""), empty))).toEqual(["at a (node:fs:1:2)"]);
    const thrown = (() => {
      try {
        runInNewContext("function f() { throw new RangeError('x') }\nf()", {}, { filename: "script.js" });
      } catch (error) {
        return error as Error;
      }
      throw new Error("no error");
    })();
    expect(thrown.stack?.startsWith("script.js:1\n")).toBe(true);
    expect(stackFrames(thrown).slice(0, 2)).toEqual(["at f (script.js:1:22)", "at script.js:2:1"]);
    const forged = Object.assign(new RangeError("m"), { code: "ERR_X", stack: "RangeError [ERR_Y]: m\n    at a (/a.js:1:1)" });
    expect(stackFrames(forged)).toEqual([]);
  });

  it("tests no line longer than a frame can be, so hostile text takes no time", () => {
    const hostile = `at a${" (a".repeat(33_000)}`;
    const started = performance.now();
    expect(stackFrames(withStack(`Error: m\n${hostile}\n${hostile}\n    at b (/b.js:1:1)`))).toEqual(["at b (/b.js:1:1)"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("drops lines that are not frames, scrubs a URL's query, and bounds each frame and the count", () => {
    const lines = ["at a (https://h.test/a.js?sig=s3cret:1:2)", "not a frame", "at\tb", "at c\u001b[31m", "at "];
    lines.push("at \u001b[31mred (z)");
    const frames = stackFrames(withStack(`Error: m\n    ${lines.join("\n    ")}`));
    expect(frames).toEqual(["at a (https://h.test/a.js?[REDACTED])"]);
    const many = Array.from({ length: 60 }, (_, i) => `    at f${i} (/${"a".repeat(500)}.js:1:1)`);
    const bounded = stackFrames(withStack(`Error: m\n${many.join("\n")}`));
    expect(bounded).toHaveLength(50);
    expect(bounded.every((frame) => frame.length === 400)).toBe(true);
  });
});
