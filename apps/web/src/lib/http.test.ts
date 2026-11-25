import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { appErrorToResponse } from "./http";

/** A JSON error answer (ADR-0173 Decision 7): its status, the two headers a refusal adds, and its envelope. */
async function answered(error: unknown) {
  const response = appErrorToResponse(error);
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
  });

  it("answers anything that is not an application error as a 500 that says nothing of it", async () => {
    expect(await answered(new Error("The rate limiter could not answer"))).toEqual({
      status: 500,
      retryAfter: null,
      cacheControl: null,
      error: { code: "INTERNAL_ERROR", message: "Unexpected error", requestId: "string", details: {} },
    });
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
