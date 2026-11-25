import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@app/shared";
import { appErrorToResponse } from "./http";

/** The lines the web app logged: one JSON object a line (ADR-0177). */
let lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A JSON error answer (ADR-0173 Decision 7): its status, the two headers a refusal adds, and its envelope. */
async function answered(error: unknown, route?: string) {
  const response = appErrorToResponse(error, route);
  const body = (await response.json()) as { error: { details: unknown; requestId: unknown } };
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    cacheControl: response.headers.get("cache-control"),
    error: { ...body.error, requestId: typeof body.error.requestId },
  };
}

describe("a JSON error answer", () => {
  it("answers a rate limit's refusal 429 with Retry-After in whole seconds, no-store and the envelope", async () => {
    const refused = new AppError("RATE_LIMITED", "Too many uploads. Try again in 14 minutes.", {
      details: { retryAfterSeconds: 840 },
    });
    expect(await answered(refused)).toEqual({
      status: 429,
      retryAfter: "840",
      cacheControl: "no-store",
      error: {
        code: "RATE_LIMITED",
        message: "Too many uploads. Try again in 14 minutes.",
        requestId: "string",
        details: { retryAfterSeconds: 840 },
      },
    });
  });

  it("adds neither header without a whole wait of one second or more, or for another code", async () => {
    const waits: unknown[] = [0, -1, 1.5, "840", Number.NaN, 2 ** 53, undefined];
    for (const retryAfterSeconds of waits) {
      const seen = await answered(new AppError("RATE_LIMITED", "Too many.", { details: { retryAfterSeconds } }));
      expect([seen.status, seen.retryAfter, seen.cacheControl]).toEqual([429, null, null]);
    }
    const other = await answered(new AppError("VALIDATION_FAILED", "Bad.", { details: { retryAfterSeconds: 60 } }));
    expect([other.status, other.retryAfter, other.cacheControl]).toEqual([422, null, null]);
    expect(other.error.details).toEqual({ retryAfterSeconds: 60 });
    // An expected answer is no failure of the app's: nothing is logged.
    expect(lines).toEqual([]);
  });

  it("answers anything that is not an application error as a 500 that says nothing of it", async () => {
    expect(await answered(new Error("The rate limiter could not answer"))).toEqual({
      status: 500,
      retryAfter: null,
      cacheControl: null,
      error: { code: "INTERNAL_ERROR", message: "Unexpected error", requestId: "string", details: {} },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ component: "request", route: "UNNAMED", errorName: "Error", code: "UNEXPECTED" });
  });

  it("logs an unknown error, or a 5xx AppError, under its route with the id the envelope answers", async () => {
    const unknown = appErrorToResponse(new Error("postgresql://u:CANARY@h/db"), "POST /api/assets/[assetId]/retry");
    const configuration = appErrorToResponse(new AppError("CONFIGURATION_ERROR", "Not set"), "GET /api/x");
    const ids: string[] = [];
    for (const response of [unknown, configuration]) {
      ids.push(((await response.json()) as { error: { requestId: string } }).error.requestId);
    }
    expect(lines.map(({ route, requestId, code }) => [route, requestId, code])).toEqual([
      ["POST /api/assets/[assetId]/retry", ids[0], "UNEXPECTED"],
      ["GET /api/x", ids[1], "CONFIGURATION_ERROR"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("CANARY");
  });
});

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Source files of the applications and packages, less tests and test doubles. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", ".next", "dist", "testing"].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("a RATE_LIMITED error", () => {
  it("is made by the web app's limits alone, so no provider's or plan's refusal answers as a rate limit", () => {
    const makers = ["apps", "packages"]
      .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .filter((file) => /AppError\(\s*["'`]RATE_LIMITED["'`]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file));
    expect(makers).toEqual(["apps/web/src/lib/rate-limit.ts"]);
  });
});
