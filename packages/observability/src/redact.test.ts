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
});
