import { describe, expect, it } from "vitest";
import { isSameOriginPost } from "./same-origin";

/** ADR-0068 Decision 4: a purchase is approved only from a page of this site. */
function post(headers: Record<string, string>): Request {
  return new Request("http://internal:3000/api/organizations/org_1/unit-purchases", { method: "POST", headers });
}

describe("isSameOriginPost", () => {
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
