import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import { failureCode, failureName, isUnknownFailure, logRequestFailure } from "./failure-log";

/**
 * The line of a request's failure the app does not know (ADR-0177): one
 * `error` line of the component `request`, with the route, the request's id,
 * the error's name and code and its cause's name, never its message.
 */
const CANARY = "postgresql://u:CANARY@h:5432/db?sig=CANARY";
const EMAIL = "canary@example.com";
const KEYS = ["level", "time", "message", "component", "route", "requestId", "errorName", "code"];

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the logger wrote, each line as written and as read. */
function logged(): { raw: string[]; lines: Record<string, unknown>[] } {
  const raw: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void raw.push(line));
  return { raw, get lines() { return raw.map((line) => JSON.parse(line) as Record<string, unknown>); } };
}

describe("logRequestFailure", () => {
  it("writes one error line, with exactly its fields, and returns the id it wrote", () => {
    const sink = logged();
    const id = logRequestFailure(new Error("boom"), "POST /api/x", "id-1");
    expect(id).toBe("id-1");
    expect(sink.lines).toHaveLength(1);
    const [line] = sink.lines;
    expect(Object.keys(line ?? {})).toEqual(KEYS);
    expect(line).toMatchObject({
      level: "error",
      message: "A request failed",
      component: "request",
      route: "POST /api/x",
      requestId: "id-1",
      errorName: "Error",
      code: "UNEXPECTED",
    });
    expect(logRequestFailure(new Error("boom"), "GET /y")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs nothing for a 4xx AppError, and logs a 5xx one by its code", () => {
    const sink = logged();
    for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_FAILED", "RATE_LIMITED"] as const) {
      expect(isUnknownFailure(new AppError(code, "x"))).toBe(false);
      logRequestFailure(new AppError(code, "x"), "POST /x");
    }
    expect(sink.raw).toEqual([]);
    logRequestFailure(new AppError("CONFIGURATION_ERROR", "x"), "POST /x");
    logRequestFailure(new AppError("NOT_FOUND", "x", { httpStatus: 503 }), "POST /x");
    expect(sink.lines.map(({ errorName, code }) => [errorName, code])).toEqual([
      ["AppError", "CONFIGURATION_ERROR"],
      ["AppError", "NOT_FOUND"],
    ]);
  });

  it("never writes the message, meta, input, cause's message or a typed email", () => {
    const sink = logged();
    const error = Object.assign(new Error(`${CANARY} ${EMAIL}`, { cause: new Error(`${CANARY} ${EMAIL}`) }), {
      meta: { url: CANARY, email: EMAIL },
      input: { email: EMAIL, address: CANARY },
    });
    logRequestFailure(error, "POST /api/auth/login");
    expect(sink.raw).toHaveLength(1);
    expect(sink.raw[0]).not.toMatch(/CANARY|canary@|u:/);
    expect(Object.keys(sink.lines[0] ?? {})).toEqual([...KEYS, "causeName"]);
    expect(sink.lines[0]).toMatchObject({ errorName: "Error", code: "UNEXPECTED", causeName: "Error" });
  });

  it("names a recorded causeName only when it is one word, and names no cause that is not an object", () => {
    const sink = logged();
    logRequestFailure(Object.assign(new Error("x"), { causeName: `db at ${CANARY}` }), "POST /x");
    logRequestFailure(new Error("x", { cause: `${CANARY} ${EMAIL}` }), "POST /x");
    logRequestFailure(new Error("x", { cause: 7 }), "POST /x");
    expect(sink.raw.join("\n")).not.toMatch(/CANARY|canary@/);
    expect(sink.lines[0]?.causeName).toBe("UNNAMED");
    expect(sink.lines.slice(1).map((line) => Object.keys(line))).toEqual([KEYS, KEYS]);
  });

  it("names a cause, read four deep for a code, or recorded as the limiter records it", () => {
    const sink = logged();
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    logRequestFailure(new TypeError("fetch failed", { cause: refused }), "POST /x");
    const limiter = Object.assign(new Error("The rate limiter could not answer"), {
      name: "RateLimiterUnavailable",
      code: "UNEXPECTED",
      causeName: "PrismaClientInitializationError",
    });
    logRequestFailure(limiter, "POST /y");
    let deep: unknown = { code: "P1001" };
    for (let depth = 0; depth < 5; depth += 1) deep = new Error("wrapped", { cause: deep });
    expect(failureCode(deep)).toBe("UNEXPECTED");
    expect(failureCode((deep as Error).cause)).toBe("P1001");
    expect(sink.lines.map(({ errorName, code, causeName }) => [errorName, code, causeName])).toEqual([
      ["TypeError", "ECONNREFUSED", "Error"],
      ["RateLimiterUnavailable", "UNEXPECTED", "PrismaClientInitializationError"],
    ]);
  });

  it("names what has no plain name UNNAMED, and what has no plain code UNEXPECTED", () => {
    const sink = logged();
    for (const thrown of ["a thrown string", null, undefined, 7]) logRequestFailure(thrown, "POST /x");
    for (const name of ["two words", "N".repeat(61), "", "1st"]) {
      expect(failureName(Object.assign(new Error("x"), { name }))).toBe("UNNAMED");
    }
    expect(failureName(Object.assign(new Error("x"), { name: "N".repeat(60) }))).toBe("N".repeat(60));
    const named = sink.lines.map(({ errorName, code, causeName }) => [errorName, code, causeName]);
    expect(named).toEqual(Array.from({ length: 4 }, () => ["UNNAMED", "UNEXPECTED", undefined]));
  });

  it("gives Prisma's first-connection failure by its own name, without its message", () => {
    const sink = logged();
    const error = new Prisma.PrismaClientInitializationError(`Can't reach database server at ${CANARY}`, "5.22.0");
    logRequestFailure(error, "POST /api/auth/login");
    expect(sink.raw[0]).not.toContain("CANARY");
    expect(sink.lines[0]).toMatchObject({ errorName: "PrismaClientInitializationError", code: "UNEXPECTED" });
  });

  it("answers the same, and throws nothing, when the line cannot be written", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(logRequestFailure(new Error("boom"), "POST /x", "id-2")).toBe("id-2");
  });
});
