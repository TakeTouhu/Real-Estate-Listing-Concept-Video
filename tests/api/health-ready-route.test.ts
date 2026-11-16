import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route tests for the readiness probe (RD-2b, ADR-0152 Decision 1): nothing
 * is asked before the operator's token is checked, and readiness that is not
 * ready answers 503. Only the cookie store, the environment, the identity
 * wiring and readiness itself are stubbed.
 */
const TOKEN = "healthcheck-token-abcdef123456";

const buildReadiness = vi.hoisted(() => vi.fn());

// `next` is installed for the web app only, so its module is named by its resolved path.
const nextHeaders = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/headers");
});

vi.mock(nextHeaders, () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ HEALTHCHECK_API_TOKEN: TOKEN }) }));
vi.mock("@/lib/identity", () => ({ getIdentityServices: () => null }));
vi.mock("@/lib/readiness", () => ({ buildReadiness }));

const { GET } = await import("@/app/api/health/ready/route");

const ask = (authorization?: string) =>
  GET(new Request("https://app.vtavision.test/api/health/ready", { headers: authorization ? { authorization } : {} }));

beforeEach(() => {
  buildReadiness.mockReset();
});

describe("GET /api/health/ready", () => {
  it("asks nothing of a request without the operator's token", async () => {
    for (const authorization of [undefined, "Bearer not-the-token", `Basic ${TOKEN}`, TOKEN, "Bearer "]) {
      const response = await ask(authorization);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
    expect(buildReadiness).not.toHaveBeenCalled();
  });

  it("answers 200 when ready and 503 when not, with what readiness reports", async () => {
    for (const [status, answer] of [
      ["ready", 200],
      ["degraded", 503],
    ] as const) {
      const readiness = { status, checks: [{ name: "database", ok: status === "ready" }] };
      buildReadiness.mockResolvedValueOnce(readiness);
      const response = await ask(`Bearer ${TOKEN}`);
      expect(response.status).toBe(answer);
      expect(await response.json()).toEqual(readiness);
    }
    expect(buildReadiness).toHaveBeenCalledTimes(2);
  });
});
