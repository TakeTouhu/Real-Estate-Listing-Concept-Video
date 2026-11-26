import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { describe, expect, it } from "vitest";
import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  NONCE_BYTES,
  NONCE_PATTERN,
  newNonce,
  pageContentSecurityPolicy,
} from "./security-headers";

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

/**
 * The production policy, exactly (ADR-0174 Decision 10), reporting to the endpoint (ADR-0189, PT-7c3) and upgrading
 * insecure requests (ADR-0190, PT-7c4).
 */
const PRODUCTION =
  "default-src 'self'; script-src 'self' 'nonce-AAECAwQFBgcICQoLDA0ODw==' 'strict-dynamic'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; " +
  "report-uri /api/csp-report; report-to csp; upgrade-insecure-requests";

/** `next dev`'s: the same but `upgrade-insecure-requests`, plus `eval` and the Fast Refresh socket. */
const DEVELOPMENT =
  "default-src 'self'; script-src 'self' 'nonce-AAECAwQFBgcICQoLDA0ODw==' 'strict-dynamic' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; " +
  "frame-ancestors 'none'; report-uri /api/csp-report; report-to csp";

/** A policy as a map from directive to its sources. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive): [string, string[]] => {
      const [name = "", ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );
}

describe("pageContentSecurityPolicy", () => {
  it("is the production policy for a production build, and for anything but next dev", () => {
    for (const nodeEnv of ["production", "test", "", undefined]) {
      expect(pageContentSecurityPolicy(NONCE, nodeEnv)).toBe(PRODUCTION);
    }
  });

  it("adds exactly eval and the Fast Refresh socket under next dev", () => {
    expect(pageContentSecurityPolicy(NONCE, "development")).toBe(DEVELOPMENT);
  });

  it("runs only nonced scripts in production, and never inline or eval'd ones", () => {
    const scripts = directives(pageContentSecurityPolicy(NONCE, "production")).get("script-src");
    expect(scripts).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
  });

  it.each(["production", "development"])("allows inline styles without a nonce under NODE_ENV=%s", (nodeEnv) => {
    // A nonce in style-src would switch 'unsafe-inline' off, and Next.js's fallback page has no nonce (R5).
    const styles = directives(pageContentSecurityPolicy(NONCE, nodeEnv)).get("style-src");
    expect(styles).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it.each(["production", "development"])("is enforced, and reports to the endpoint, under NODE_ENV=%s", (nodeEnv) => {
    const policy = pageContentSecurityPolicy(NONCE, nodeEnv);
    // Both mechanisms, to one endpoint on the page's own origin; the group is never `default` (PT-7c3).
    expect(directives(policy).get("report-uri")).toEqual(["/api/csp-report"]);
    expect(directives(policy).get("report-to")).toEqual(["csp"]);
    expect([CSP_REPORT_PATH, CSP_REPORT_GROUP]).toEqual(["/api/csp-report", "csp"]);
    expect(directives(policy).has("sandbox")).toBe(false);
    expect(policy).not.toMatch(/https?:|\*/);
  });

  it("upgrades insecure requests in every policy but next dev's, as its last directive, with no sources", () => {
    for (const nodeEnv of ["production", "test", "", undefined]) {
      const policy = pageContentSecurityPolicy(NONCE, nodeEnv);
      expect(policy.endsWith("; upgrade-insecure-requests")).toBe(true);
      expect(directives(policy).get("upgrade-insecure-requests")).toEqual([]);
    }
    // `next dev` serves plain http, where the upgrade would break its own files (ADR-0190).
    expect(pageContentSecurityPolicy(NONCE, "development")).not.toContain("upgrade-insecure-requests");
  });

  it("gives Next.js the nonce it reads from the request", () => {
    for (const nodeEnv of ["production", "development"]) {
      expect(getScriptNonceFromHeader(pageContentSecurityPolicy(NONCE, nodeEnv))).toBe(NONCE);
    }
  });

  it("refuses a nonce Next.js would not read", () => {
    for (const nonce of ["", "abc def", "abc'; script-src *", "abc;", "ab=c"]) {
      expect(() => pageContentSecurityPolicy(nonce, "production")).toThrow("base64 nonce");
    }
  });
});

describe("newNonce", () => {
  it("is 16 random bytes, base64, in Next.js's pattern", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(NONCE_PATTERN);
    expect(nonce).toHaveLength(24);
    expect(atob(nonce)).toHaveLength(NONCE_BYTES);
  });

  it("is new on every call", () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => newNonce()));
    expect(nonces.size).toBe(1000);
  });
});
