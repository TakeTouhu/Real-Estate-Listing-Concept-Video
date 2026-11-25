import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config.mjs";
import { API_POLICY, fixedHeaderRules } from "../fixed-headers.mjs";

/** The rules `next.config.mjs` gives Next.js, read under the `NODE_ENV` given. */
async function configuredRules(nodeEnv: string): Promise<{ source: string; headers: Map<string, string> }[]> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  const rules = (await nextConfig.headers?.()) ?? [];
  return rules.map(({ source, headers }) => ({
    source,
    headers: new Map(headers.map(({ key, value }): [string, string] => [key.toLowerCase(), value])),
  }));
}

/** The headers a rule sets, or a failure naming the rule that is missing. */
function headersOf(rules: { source: string; headers: Map<string, string> }[], source: string): Map<string, string> {
  const rule = rules.find((candidate) => candidate.source === source);
  if (rule === undefined) throw new Error(`No rule for ${source}`);
  return rule.headers;
}

const ENVIRONMENTS = ["production", "development", "test"] as const;

/**
 * Headers a route handler decides per answer (measured over `apps/web/src`): a routing-level header of the same name
 * would replace the handler's, so the configuration never names one (ADR-0174 Decision 8).
 */
const HANDLER_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "location",
  "retry-after",
  "set-cookie",
];

const directives = (policy: string): string[] => policy.split(";").map((directive) => directive.trim());

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config.mjs", () => {
  it("sends no X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it.each(ENVIRONMENTS)("sends the fixed headers on every path under NODE_ENV=%s", async (nodeEnv) => {
    const everyAnswer = headersOf(await configuredRules(nodeEnv), "/:path*");
    expect(everyAnswer.get("x-content-type-options")).toBe("nosniff");
    expect(everyAnswer.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(everyAnswer.get("x-frame-options")).toBe("DENY");
    expect(everyAnswer.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
    );
    expect(everyAnswer.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(everyAnswer.get("cross-origin-resource-policy")).toBe("same-origin");
    // The page policy is the middleware's (Decision 10): never one here on every path.
    expect(everyAnswer.has("content-security-policy")).toBe(false);
  });

  it.each(ENVIRONMENTS)("sends the API policy on /api only under NODE_ENV=%s", async (nodeEnv) => {
    const rules = await configuredRules(nodeEnv);
    expect(rules.map(({ source }) => source)).toEqual(["/:path*", "/api/:path*"]);
    expect([...headersOf(rules, "/api/:path*")]).toEqual([
      ["content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox"],
    ]);
  });

  it("sends HSTS from a production build only, for this host only", async () => {
    expect(headersOf(await configuredRules("production"), "/:path*").get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    for (const nodeEnv of ["development", "test", ""]) {
      expect(headersOf(await configuredRules(nodeEnv), "/:path*").has("strict-transport-security")).toBe(false);
    }
    expect(fixedHeaderRules(undefined)[0]?.headers.map(({ key }) => key)).not.toContain("Strict-Transport-Security");
  });

  it.each(ENVIRONMENTS)("names no header a handler decides, and never no-referrer, under NODE_ENV=%s", async (env) => {
    for (const { headers } of await configuredRules(env)) {
      for (const name of HANDLER_HEADERS) expect(headers.has(name)).toBe(false);
      for (const value of headers.values()) expect(value.toLowerCase()).not.toContain("no-referrer");
      const hsts = headers.get("strict-transport-security") ?? "";
      expect(hsts.toLowerCase()).not.toMatch(/includesubdomains|preload/);
    }
  });

  it("gives the download route a policy at least as strict as its own, and the same nosniff", () => {
    // The configuration's header wins over the route's (Decision 9), so the route's own must be a subset.
    const route = readFileSync(new URL("./app/api/storage/download/route.ts", import.meta.url), "utf8");
    const own = /"Content-Security-Policy": "([^"]+)"/.exec(route)?.[1];
    expect(own).toBeDefined();
    expect(directives(API_POLICY)).toEqual(expect.arrayContaining(directives(own ?? "")));
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
  });

  it("returns new objects on each call, which Next.js may annotate", () => {
    const first = fixedHeaderRules("production");
    const second = fixedHeaderRules("production");
    expect(second).toEqual(first);
    expect(second[0]?.headers[0]).not.toBe(first[0]?.headers[0]);
  });
});
