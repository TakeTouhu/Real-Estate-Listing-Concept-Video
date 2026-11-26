import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactUrl } from "./redact";

describe("redact", () => {
  it("redacts sensitive keys regardless of casing", () => {
    const out = redact({
      Authorization: "Bearer abc",
      apiKey: "sk-123",
      webhookSecret: "shh",
      nested: { accessToken: "t", safe: "ok" },
    }) as Record<string, unknown>;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.webhookSecret).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).accessToken).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).safe).toBe("ok");
  });

  it("strips signed query strings from URL values", () => {
    const out = redact({
      link: "https://storage.example.com/o/key?X-Amz-Signature=deadbeef&exp=123",
    }) as Record<string, unknown>;
    expect(out.link).toBe(`https://storage.example.com/o/key?${REDACTED}`);
  });

  it("redacts provider prediction ids", () => {
    const out = redact({ predictionId: "pred_123" }) as Record<string, unknown>;
    expect(out.predictionId).toBe(REDACTED);
  });

  it("handles arrays and circular references", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const out = redact({ items: [1, 2], cyclic }) as Record<string, unknown>;
    expect(out.items).toEqual([1, 2]);
    expect((out.cyclic as Record<string, unknown>).self).toBe("[CIRCULAR]");
  });
});

describe("redactUrl", () => {
  it("keeps origin and path but redacts query", () => {
    expect(redactUrl("https://h.test/a/b?sig=1")).toBe(`https://h.test/a/b?${REDACTED}`);
  });

  it("returns plain urls unchanged", () => {
    expect(redactUrl("https://h.test/a/b")).toBe("https://h.test/a/b");
  });

  it("drops a user name and password even when there is no query or fragment", () => {
    expect(redactUrl("https://user:pw@h.test/a")).toBe("https://h.test/a");
    expect(redactUrl("https://user@h.test/a")).toBe("https://h.test/a");
    expect(redactUrl("https://:pw@h.test/a")).toBe("https://h.test/a");
    expect(redactUrl("http://user:pw@h.test:8080/a/b")).toBe("http://h.test:8080/a/b");
  });

  it("drops a user name and password with the query when there is one", () => {
    expect(redactUrl("https://user:pw@h.test/a?sig=1")).toBe(`https://h.test/a?${REDACTED}`);
    expect(redactUrl("https://user:pw@h.test/a#t=1")).toBe(`https://h.test/a?${REDACTED}`);
  });

  it("returns a value it cannot parse as given, credentials included (a known gap, ADR-0182)", () => {
    expect(redactUrl("https://user:pw@[bad/a")).toBe("https://user:pw@[bad/a");
    expect(redactUrl("not a url")).toBe("not a url");
  });

  it("drops a user name and password from a URL value in a record", () => {
    expect(redact({ link: "https://user:pw@h.test/a" })).toEqual({ link: "https://h.test/a" });
  });

  it("rewrites a string that starts with a URL and drops or re-encodes the rest, but not a URL further in", () => {
    expect(redact({ a: "https://h.test/a?sig=1 tail" })).toEqual({ a: `https://h.test/a?${REDACTED}` });
    expect(redact({ a: "https://u:p@h.test/a tail" })).toEqual({ a: "https://h.test/a%20tail" });
    expect(redact({ a: "Fetched https://h.test/a?sig=1" })).toEqual({ a: "Fetched https://h.test/a?sig=1" });
  });

  it("writes a URL that loses its credentials in its normalized form", () => {
    expect(redactUrl("HTTPS://USER:PW@H.TEST:443/x/../A")).toBe("https://h.test/A");
  });
});
