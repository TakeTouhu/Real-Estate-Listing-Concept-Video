import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config.mjs";
import { API_POLICY } from "../fixed-headers.mjs";
import { config, middleware } from "./middleware";
import { NONCE_PATTERN, pageContentSecurityPolicy } from "./lib/security-headers";

const BASE = "http://localhost:3210";

/** Page addresses, a client-side navigation's payload included: each gets the page policy. */
const PAGES = ["/", "/login", "/login/mfa", "/properties/p-1/review?asset=a-1", "/apiary", "/no-such-page"];

/** Addresses that are not pages: the API, which has its own policy, and Next.js's own files. */
const NOT_PAGES = [
  "/api",
  "/api/",
  "/api/health",
  "/api/storage/download?token=t",
  "/_next",
  "/_next?x=1",
  "/_next/static/chunks/main.js",
  "/_next/image?url=x",
  "/_next/webpack-hmr",
  "/favicon.ico",
];

/** `next build` (production), `next dev` and the unit tests. */
const ENVIRONMENTS = ["production", "development", "test"];

const matches = (url: string, headers: Record<string, string> = {}): boolean =>
  unstable_doesMiddlewareMatch({ config, url, headers });

/** The nonce of a policy's `script-src`. */
const nonceOf = (policy: string | null): string | undefined => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the middleware's matcher", () => {
  it.each(PAGES)("runs for the page %s", (url) => {
    expect(matches(url)).toBe(true);
    expect(matches(url, { rsc: "1" })).toBe(true);
  });

  it.each(NOT_PAGES)("does not run for %s", (url) => {
    expect(matches(url)).toBe(false);
  });

  it("does not run for Next.js's router prefetch, which fetches a payload, not a document", () => {
    expect(matches("/login", { "next-router-prefetch": "1" })).toBe(false);
  });

  it("runs for a browser's document prefetch or prerender, which may become the page", () => {
    expect(matches("/login", { purpose: "prefetch", "sec-purpose": "prefetch" })).toBe(true);
    expect(matches("/login", { "sec-purpose": "prefetch;prerender" })).toBe(true);
  });

  it.each(ENVIRONMENTS.flatMap((env) => [...PAGES, ...NOT_PAGES].map((url) => [url, env])))(
    "never gives %s a second policy, under NODE_ENV=%s",
    async (url, env) => {
      // The configuration sends the API policy on `/api/:path*` (RD-9d, Decision 9) and, from a production build, on
      // `/_next/:path*` and `/favicon.ico` (ADR-0188 Decision 4); the middleware the page's, and none of those.
      vi.stubEnv("NODE_ENV", env);
      const api = url === "/api" || url.startsWith("/api/");
      const next = url === "/_next" || url.startsWith("/_next/") || url.startsWith("/_next?");
      const unmatched = env === "production" && (next || url === "/favicon.ico");
      const configured = await unstable_getResponseFromNextConfig({ url: `${BASE}${url}`, nextConfig });
      expect(configured.headers.get("content-security-policy")).toBe(api || unmatched ? API_POLICY : null);
      expect(matches(url)).toBe(!api && !NOT_PAGES.includes(url));
    },
  );
});

describe("middleware", () => {
  it("sets one page policy, with a fresh nonce, on the request and on the answer", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = middleware(new NextRequest(`${BASE}/login`));
    const policy = first.headers.get("content-security-policy");
    const nonce = nonceOf(policy);
    expect(nonce).toMatch(NONCE_PATTERN);
    expect(policy).toBe(pageContentSecurityPolicy(nonce ?? "", "production"));
    // `NextResponse.next({ request })` hands the render the request's new headers.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(first.headers.get("x-middleware-override-headers")?.split(",")).toContain("content-security-policy");
    expect(first.headers.get("x-middleware-next")).toBe("1");

    const second = middleware(new NextRequest(`${BASE}/login`));
    expect(nonceOf(second.headers.get("content-security-policy"))).not.toBe(nonce);
  });

  it("replaces a policy the client sent, so the render never reads the client's nonce", () => {
    const request = new NextRequest(`${BASE}/login`, {
      headers: { "content-security-policy": "script-src 'nonce-chosenbytheclient'", cookie: "session=s" },
    });
    const response = middleware(request);
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(response.headers.get("content-security-policy"));
    expect(forwarded).not.toContain("chosenbytheclient");
    // Every other request header goes on unchanged.
    expect(response.headers.get("x-middleware-request-cookie")).toBe("session=s");
  });

  it("sends next dev's policy under next dev only", () => {
    vi.stubEnv("NODE_ENV", "development");
    const policy = middleware(new NextRequest(`${BASE}/login`)).headers.get("content-security-policy") ?? "";
    expect(policy).toBe(pageContentSecurityPolicy(nonceOf(policy) ?? "", "development"));
    expect(policy).toContain("'unsafe-eval'");
  });
});

describe("what the middleware imports", () => {
  /** The module specifiers a source file imports. */
  const importsOf = (path: string): string[] => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return [...source.matchAll(/^(?:import|export)[^;]*?\sfrom\s+"([^"]+)"/gm)].map((match) => match[1] ?? "");
  };

  it("is only next/server and the policy, so nothing Node-only reaches the Edge runtime", () => {
    expect(importsOf("./middleware.ts")).toEqual(["next/server", "./lib/security-headers"]);
    const policySource = readFileSync(new URL("./lib/security-headers.ts", import.meta.url), "utf8");
    expect(importsOf("./lib/security-headers.ts")).toEqual([]);
    expect(policySource).not.toMatch(/\brequire\(|\bimport\(|\bprocess\b|\bBuffer\b/);
  });
});
