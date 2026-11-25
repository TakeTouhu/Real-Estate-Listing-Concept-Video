import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@app/shared";

const env = vi.hoisted(() => ({ read: (): Partial<ServerEnv> => ({ NODE_ENV: "test" }) }));
vi.mock("./env", () => ({ getServerEnv: () => env.read() }));

const { isSameOriginPost, originRefusal } = await import("./same-origin");

/** ADR-0068 Decision 4: a purchase is approved only from a page of this site. */
function post(headers: Record<string, string>): Request {
  return new Request("http://internal:3000/api/organizations/org_1/unit-purchases", { method: "POST", headers });
}

describe("isSameOriginPost without APP_BASE_URL, outside production", () => {
  it("accepts a post from the host the browser addressed", () => {
    expect(isSameOriginPost(post({ origin: "https://app.example.com", host: "app.example.com" }))).toBe(true);
  });

  it("compares the port too", () => {
    expect(isSameOriginPost(post({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isSameOriginPost(post({ origin: "http://localhost:4000", host: "localhost:3000" }))).toBe(false);
  });

  it.each([
    ["another site", "https://evil.example.net"],
    ["another origin of the same site", "https://files.example.com"],
    ["an opaque origin", "null"],
    ["a malformed origin", "app.example.com"],
  ])("refuses %s", (_what, origin) => {
    expect(isSameOriginPost(post({ origin, host: "app.example.com" }))).toBe(false);
  });

  it("refuses a post that names no origin, or reaches no host", () => {
    expect(isSameOriginPost(post({ host: "app.example.com" }))).toBe(false);
    expect(isSameOriginPost(new Request("http://x/", { method: "POST", headers: { origin: "http://x" } }))).toBe(
      false,
    );
  });

  it("compares against the host a proxy forwarded, the first when it lists several", () => {
    const behindProxy = { origin: "https://app.example.com", host: "internal:3000" };
    expect(isSameOriginPost(post({ ...behindProxy, "x-forwarded-host": "app.example.com" }))).toBe(true);
    expect(isSameOriginPost(post({ ...behindProxy, "x-forwarded-host": "app.example.com, edge.internal" }))).toBe(
      true,
    );
    expect(isSameOriginPost(post({ ...behindProxy, "x-forwarded-host": "edge.internal, app.example.com" }))).toBe(
      false,
    );
    expect(isSameOriginPost(post(behindProxy))).toBe(false);
  });
});

const BASE = { baseUrl: "https://app.example.com", production: true };
const UNSET = { baseUrl: undefined, production: false };

describe("originRefusal (ADR-0174)", () => {
  it("accepts exactly APP_BASE_URL's origin where it is set, whatever the host", () => {
    expect(originRefusal(post({ origin: "https://app.example.com", host: "internal:3000" }), BASE)).toBeNull();
    const from = (baseUrl: string) => originRefusal(post({ origin: "https://app.example.com" }), { ...BASE, baseUrl });
    expect(from("https://app.example.com/a/b")).toBeNull();
    expect(from("https://APP.example.com:443")).toBeNull();
  });

  it.each([
    ["http where the setting is https", { origin: "http://app.example.com" }, "MISMATCH"],
    ["another port", { origin: "https://app.example.com:8443" }, "MISMATCH"],
    ["a trailing slash", { origin: "https://app.example.com/" }, "MISMATCH"],
    ["a malformed origin", { origin: "app.example.com" }, "MISMATCH"],
    ["the host addressed", { origin: "https://in.example.net", "x-forwarded-host": "in.example.net" }, "MISMATCH"],
    ["no origin", {}, "NO_ORIGIN"],
    ["an opaque origin", { origin: "null" }, "OPAQUE"],
  ])("refuses %s where it is set", (_what, headers, reason) => {
    expect(originRefusal(post({ host: "in.example.net", ...headers }), BASE)).toBe(reason);
  });

  it("refuses every change in production where it is unset, even from the addressed host", () => {
    const headers = { origin: "https://app.example.com", host: "app.example.com" };
    expect(originRefusal(post(headers), { ...UNSET, production: true })).toBe("NO_SETTING");
  });

  it("refuses every change where the setting is set but unreadable, outside production too", () => {
    const headers = { origin: "https://app.example.com", host: "app.example.com" };
    expect(originRefusal(post(headers), { baseUrl: "not a url", production: false })).toBe("NO_SETTING");
  });

  it.each([
    ["another site", { origin: "https://evil.example.net", host: "app.example.com" }, "MISMATCH"],
    ["no origin", { host: "app.example.com" }, "NO_ORIGIN"],
    ["an opaque origin", { origin: "null", host: "app.example.com" }, "OPAQUE"],
    ["no host", { origin: "http://x" }, "NO_HOST"],
  ])("names why the host rule refuses %s", (_what, headers, reason) => {
    expect(originRefusal(new Request("http://x/", { method: "POST", headers }), UNSET)).toBe(reason);
  });
});

describe("isSameOriginPost's setting and log", () => {
  const lines: string[] = [];
  const capture = () => vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  const headers = { origin: "https://app.example.com", host: "app.example.com" };

  afterEach(() => {
    lines.length = 0;
    env.read = () => ({ NODE_ENV: "test" });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("compares with APP_BASE_URL where the environment sets it", () => {
    env.read = () => ({ NODE_ENV: "test", APP_BASE_URL: "http://localhost:3210" });
    expect(isSameOriginPost(post({ origin: "http://localhost:3210", host: "elsewhere:1" }))).toBe(true);
    capture();
    expect(isSameOriginPost(post({ origin: "http://elsewhere:1", host: "elsewhere:1" }))).toBe(false);
  });

  it("logs a refusal's reason and route at warn, never a header's value", () => {
    capture();
    const evil = { origin: "https://evil.example.net", host: "app.example.com" };
    expect(isSameOriginPost(post(evil), "POST /api/auth/login")).toBe(false);
    expect(isSameOriginPost(post({ host: "app.example.com" }))).toBe(false);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.map(({ level, code, reason, route }) => [level, code, reason, route])).toEqual([
      ["warn", "ORIGIN_REFUSED", "MISMATCH", "POST /api/auth/login"],
      ["warn", "ORIGIN_REFUSED", "NO_ORIGIN", undefined],
    ]);
    expect(lines.join("\n")).not.toMatch(/evil|app\.example\.com/);
  });

  it("refuses in production without the setting, by either NODE_ENV", () => {
    capture();
    env.read = () => ({ NODE_ENV: "production" });
    expect(isSameOriginPost(post(headers))).toBe(false);
    env.read = () => ({ NODE_ENV: "test" });
    vi.stubEnv("NODE_ENV", "production");
    expect(isSameOriginPost(post(headers))).toBe(false);
    expect(lines.map((line) => (JSON.parse(line) as { reason: string }).reason)).toEqual(["NO_SETTING", "NO_SETTING"]);
  });

  it("keeps the host rule where the environment cannot be read, outside production only", () => {
    env.read = () => {
      throw new Error("SESSION_SECRET: Required");
    };
    expect(isSameOriginPost(post(headers))).toBe(true);
    capture();
    vi.stubEnv("NODE_ENV", "production");
    expect(isSameOriginPost(post(headers))).toBe(false);
  });
});
