import { runInNewContext } from "node:vm";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import {
  failureCode,
  failureName,
  isUnknownFailure,
  logRequestFailure,
  logUncaughtRequestFailure,
  uncaughtRequestFields,
} from "./failure-log";

/**
 * The line of a request's failure the app does not know (ADR-0177): one
 * `error` line of the component `request`, with the route, the request's id,
 * the error's name and code and its cause's name, never its message.
 */
const CANARY = "postgresql://u:CANARY@h:5432/db?sig=CANARY";
const EMAIL = "canary@example.com";
const KEYS = ["severity", "time", "message", "component", "route", "requestId", "errorName", "code"];

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
      severity: "ERROR",
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

describe("logUncaughtRequestFailure", () => {
  const PAGE = { routePath: "/properties/[propertyId]", routeType: "render", renderSource: "server-rendering" };
  const ROUTE = { routePath: "/api/auth/login", routeType: "route" };
  const fields = (method: string, context: typeof PAGE | typeof ROUTE, error: unknown = new Error("x")) =>
    uncaughtRequestFields(error, method, context, "id-3");

  it("writes one error line, with exactly its fields, under a message of its own", () => {
    const sink = logged();
    const error = Object.assign(new Error("boom"), { digest: "836979235" });
    logUncaughtRequestFailure(error, "GET", { ...PAGE, renderSource: "react-server-components" }, "id-3");
    logUncaughtRequestFailure(new Error("boom"), "POST", ROUTE);
    expect(sink.lines.map((line) => Object.keys(line))).toEqual([
      [...KEYS, "routeType", "renderSource", "digest"],
      [...KEYS, "routeType"],
    ]);
    expect(sink.lines[0]).toEqual({
      severity: "ERROR",
      time: sink.lines[0]?.time,
      message: "Next.js answered a request that failed",
      component: "request",
      route: "GET /properties/[propertyId]",
      requestId: "id-3",
      errorName: "Error",
      code: "UNEXPECTED",
      routeType: "render",
      renderSource: "react-server-components",
      digest: "836979235",
    });
    const fresh = expect.stringMatching(/^[0-9a-f-]{36}$/);
    expect(sink.lines[1]).toMatchObject({ route: "POST /api/auth/login", requestId: fresh });
  });

  it("names a method outside the list OTHER, and a route that is not a pattern (other)", () => {
    expect(fields("get", ROUTE).route).toBe("OTHER /api/auth/login");
    expect(fields("PROPFIND", ROUTE).route).toBe("OTHER /api/auth/login");
    expect(fields("GET", { ...PAGE, routePath: "/(app)/[...slug]/@modal" }).route).toBe("GET /(app)/[...slug]/@modal");
    for (const routePath of ["/a b", "/a?token=s3cret", `/${"a".repeat(199)}`, "a", ""]) {
      expect(fields("GET", { ...ROUTE, routePath }).route).toBe("GET (other)");
    }
  });

  it("keeps only a digest of digits, and only the route types and render sources Next.js names", () => {
    const digest = (value: unknown) => fields("GET", PAGE, Object.assign(new Error("x"), { digest: value })).digest;
    expect(digest("1234")).toBe("1234");
    for (const value of ["NEXT_REDIRECT;replace;/x?token=s3cret;307;", "1".repeat(21), "", 1234]) {
      expect(digest(value)).toBeUndefined();
    }
    expect(fields("GET", { ...PAGE, routeType: "page", renderSource: "client" })).toMatchObject({
      routeType: "other",
      renderSource: "other",
    });
  });

  it("logs a 4xx AppError too, since no catch took it", () => {
    const sink = logged();
    logUncaughtRequestFailure(new AppError("NOT_FOUND", "x"), "GET", PAGE);
    expect(sink.lines[0]).toMatchObject({ errorName: "AppError", code: "NOT_FOUND" });
  });

  it("never writes the error's message, stack, cause's message or the request's path", () => {
    const sink = logged();
    const error = new Error("GET /properties/p1?token=s3cret", { cause: new Error(`${CANARY} ${EMAIL}`) });
    logUncaughtRequestFailure(error, "GET", PAGE);
    expect(sink.raw).toHaveLength(1);
    expect(sink.raw[0]).not.toMatch(/s3cret|token|\/p1|CANARY|canary@|failure-log\.test/);
    expect(sink.lines[0]).toMatchObject({ errorName: "Error", causeName: "Error" });
  });

  it("names an error made in another realm, and survives a name that throws", () => {
    expect(fields("GET", PAGE, runInNewContext("new TypeError('x')")).errorName).toBe("TypeError");
    const hostile = Object.defineProperty(new Error("x"), "name", {
      get: () => {
        throw new Error("no name");
      },
    });
    expect(fields("GET", PAGE, hostile)).toMatchObject({ errorName: "UNNAMED", code: "UNEXPECTED" });
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => logUncaughtRequestFailure(hostile, "GET", PAGE)).not.toThrow();
  });

  it("gives a context whose reads throw the fields' fallbacks", () => {
    const thrower = () => {
      throw new Error("no context");
    };
    const context = Object.defineProperties({}, {
      routePath: { get: thrower },
      routeType: { get: thrower },
      renderSource: { get: thrower },
    }) as typeof PAGE;
    expect(fields("GET", context)).toMatchObject({ route: "GET (other)", routeType: "other" });
    expect(fields("GET", context)).not.toHaveProperty("renderSource");
  });
});
