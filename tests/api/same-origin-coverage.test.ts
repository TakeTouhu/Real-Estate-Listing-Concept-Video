import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every cookie-based change checks its origin first (ADR-0174 Decision 6).
 *
 * Each exported `POST`, `PUT`, `PATCH` or `DELETE` of a route file is read
 * from its own `export` to the next one, so a `GET` above it is never read
 * for it, and must call the check before its first `await`. The routes below
 * do not yet: RD-9b and RD-9c take each off this list as they check it, and
 * the test fails for a listed route that is checked, so the list stays exact.
 */
const UNCHECKED: Readonly<Record<string, string>> = Object.fromEntries([
  ...[
    "/api/assets/[assetId]/complete",
    "/api/assets/[assetId]/retry",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/mfa",
    "/api/auth/register",
    "/api/auth/reset-password",
    "/api/auth/reset-password/request",
    "/api/auth/verify-email",
    "/api/auth/verify-email/resend",
    "/api/mfa/disable",
    "/api/mfa/recovery-codes",
    "/api/mfa/setup",
    "/api/mfa/setup/confirm",
    "/api/organizations",
    "/api/organizations/[organizationId]/mfa-requirement",
    "/api/properties/[propertyId]/assets/[assetId]/analysis",
    "/api/properties/[propertyId]/assets/[assetId]/analysis/approve",
    "/api/properties/[propertyId]/assets/[assetId]/analysis/correction",
    "/api/properties/[propertyId]/assets/[assetId]/analysis/refresh",
    "/api/properties/[propertyId]/assets/[assetId]/analysis/reject",
    "/api/properties/[propertyId]/assets/upload-url",
    "/api/properties/[propertyId]/video-projects",
    "/api/video-projects/[projectId]/storyboard",
  ].map((path) => [`POST ${path}`, "RD-9b or RD-9c"]),
  // Permanent: its signed upload token alone authorizes it; it reads no session cookie (ADR-0174 Decision 1).
  ["PUT /api/storage/upload", "token only"],
]);

const APP = join(__dirname, "..", "..", "apps", "web", "src", "app");
/** An exported name; a keyword is never taken for one, so `export const { POST }` goes uncounted and throws below. */
const EXPORT = new RegExp(
  String.raw`^export\s+(?:async\s+)?(?:function\s+|(?:const|let|var)\s+)?` +
    String.raw`(?!(?:const|let|var|class|default|function|async)\b)(\w+)`,
  "gm",
);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Source without comments, so a word in a comment never counts as a call. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

interface Handler {
  readonly key: string;
  readonly body: string;
}

/** Each mutating handler of every route file under `app`, by `METHOD /path`, with its own source. */
function mutatingHandlers(root: string = APP): Handler[] {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (path) => path === "route.ts" || path.endsWith(`${sep}route.ts`),
  );
  return files.flatMap((file) => {
    const path = `/${file.split(sep).slice(0, -1).join("/")}`;
    const source = code(readFileSync(join(root, file), "utf8"));
    const exports = [...source.matchAll(EXPORT)];
    // A handler exported any other way (`export { POST }`) would go unread.
    if (exports.length !== source.match(/^export\b/gm)?.length) {
      throw new Error(`An export the guard cannot read: ${file}`);
    }
    return exports.flatMap((match, index) => {
      const method = match[1] ?? "";
      if (!MUTATING.has(method)) return [];
      return [{ key: `${method} ${path}`, body: source.slice(match.index, exports[index + 1]?.index) }];
    });
  });
}

/** Whether the handler calls the check, on its own request, before anything it awaits. */
function checksFirst({ body }: Handler): boolean {
  const check = body.search(/\bisSameOriginPost\(request\b/);
  const wait = body.search(/\bawait\b/);
  return check > -1 && (wait === -1 || check < wait);
}

describe("the origin check's coverage", () => {
  const handlers = mutatingHandlers();

  it("reads every mutating handler: 45 today, one per route file", () => {
    expect(handlers).toHaveLength(45);
    expect(new Set(handlers.map(({ key }) => key)).size).toBe(45);
  });

  it("finds the check first in every handler but the listed ones, and in none of those", () => {
    const unchecked = handlers.filter((handler) => !checksFirst(handler)).map(({ key }) => key);
    expect(unchecked.sort()).toEqual(Object.keys(UNCHECKED).sort());
  });

  it("names, where a check names its route, its own method and path", () => {
    for (const { key, body } of handlers) {
      for (const [, named] of body.matchAll(/\bisSameOriginPost\(request,\s*"([^"]*)"/g)) {
        expect(`${key}: ${named}`).toBe(`${key}: ${key}`);
      }
    }
  });

  it("reads a handler from its own export, so a GET above it does not count", () => {
    const properties = handlers.find(({ key }) => key === "POST /api/properties");
    expect(properties?.body.startsWith("export async function POST(")).toBe(true);
    expect(properties && checksFirst(properties)).toBe(true);
    const late = "export async function POST(request) { await a(); isSameOriginPost(request); }";
    expect(checksFirst({ key: "POST /x", body: late })).toBe(false);
    expect(checksFirst({ key: "POST /y", body: "export async function POST(request) { await a(); }" })).toBe(false);
  });
});
