import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerCspReport,
  blockedCategory,
  directiveCategory,
  readBounded,
  resetCspReportCountsForTests,
  sourceCategory,
} from "./csp-report";

/**
 * What a page policy report becomes (ADR-0189): categories only, at most one
 * line per request, and that line only when a category's count in this
 * process reaches a power of two.
 */
const BASE = "https://app.example.test";
const UUID = "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c";

beforeEach(() => resetCspReportCountsForTests());
afterEach(() => vi.restoreAllMocks());

/** What the logger wrote, as written. */
function logged(): string[] {
  const raw: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void raw.push(line));
  return raw;
}

const reportUri = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    "csp-report": {
      "document-uri": `${BASE}/login`,
      "effective-directive": "script-src-elem",
      "blocked-uri": "inline",
      disposition: "enforce",
      ...fields,
    },
  });
const violation = (body: Record<string, unknown> = {}) => ({
  type: "csp-violation",
  url: `${BASE}/login`,
  body: { documentURL: `${BASE}/login`, effectiveDirective: "script-src-elem", blockedURL: "inline", ...body },
});
const answer = (body: string, type = "application/csp-report") =>
  answerCspReport(new Request(`${BASE}/api/csp-report`, { method: "POST", headers: { "content-type": type }, body }),
    () => BASE);

describe("answerCspReport's line", () => {
  it("writes one INFO line of categories for a report-uri body, and never a secret it carried", async () => {
    const sink = logged();
    const secrets = reportUri({
      "document-uri": `${BASE}/reset-password?token=s3cret`,
      "blocked-uri": `${BASE}/api/storage/download?token=s3cret`,
      referrer: `${BASE}/properties/${UUID}/review?q=s3cret`,
      "script-sample": "s3cret sample",
      "original-policy": "script-src 'nonce-N0nceS3cret' 'strict-dynamic'",
      "source-file": `${BASE}/_next/static/chunks/app.js?token=s3cret`,
      "status-code": 200,
    });
    expect(await answer(secrets)).toBe(204);
    expect(sink).toHaveLength(1);
    const line = JSON.parse(sink[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ severity: "INFO", component: "csp-report", dropped: 0 });
    expect(line.message).toBe("Browsers reported page policy violations");
    expect(line.violations).toEqual([{ mechanism: "report-uri", directive: "script-src-elem", blocked: "self",
      disposition: "enforce", source: "other", count: 1, total: 1 }]);
    for (const secret of ["s3cret", "token", "N0nce", "nonce", "?", "/", "reset", UUID, "app.example"]) {
      expect(sink[0]).not.toContain(secret);
    }
  });

  it("reads report-to's csp-violation entries only, ten at most, and counts the rest as dropped", async () => {
    const sink = logged();
    const batch = [{ type: "deprecation", body: {} }, ...Array.from({ length: 12 }, () => violation())];
    expect(await answer(JSON.stringify(batch), "application/reports+json; charset=utf-8")).toBe(204);
    const line = JSON.parse(sink[0] ?? "{}") as { violations: Record<string, unknown>[]; dropped: number };
    expect(line.dropped).toBe(2);
    expect(line.violations).toEqual([{ mechanism: "report-to", directive: "script-src-elem", blocked: "inline",
      disposition: "other", source: "none", count: 10, total: 10 }]);
  });

  it("drops, with no line, every report whose page is not on APP_BASE_URL's origin, or with none set", async () => {
    const sink = logged();
    expect(await answer(reportUri({ "document-uri": "https://evil.example/login" }))).toBe(204);
    expect(await answer(reportUri({ "document-uri": "http://app.example.test/login" }))).toBe(204);
    expect(await answer(JSON.stringify([violation({ documentURL: "https://evil.example/" })]),
      "application/reports+json")).toBe(204);
    const request = new Request(`${BASE}/api/csp-report`,
      { method: "POST", headers: { "content-type": "application/csp-report" }, body: reportUri() });
    expect(await answerCspReport(request, () => undefined)).toBe(204);
    expect(sink).toEqual([]);
  });

  it("logs a category's 1st, 2nd, 4th and 8th report in this process, and not its 3rd, 5th, 6th or 7th", async () => {
    const sink = logged();
    const batch = (size: number) =>
      answer(JSON.stringify(Array.from({ length: size }, () => violation())), "application/reports+json");
    const written: number[] = [];
    for (let report = 1; report <= 9; report += 1) {
      const before = sink.length;
      await batch(1);
      if (sink.length > before) written.push(report);
    }
    expect(written).toEqual([1, 2, 4, 8]);
    const totals = () => sink.map((line) => (JSON.parse(line) as { violations: { total: number }[] }).violations[0]);
    expect(totals().map((entry) => entry?.total)).toEqual([1, 2, 4, 8]);
    // A request that carries its category past a power of two is written once: 9 + 7 passes 16, 16 + 7 does not.
    await batch(7);
    await batch(7);
    expect(totals().slice(4)).toEqual([expect.objectContaining({ count: 7, total: 16 })]);
  });
});

describe("the categories", () => {
  it("names a directive on the list and nothing else", () => {
    expect(directiveCategory("Script-Src-Elem")).toBe("script-src-elem");
    expect(directiveCategory("require-trusted-types-for")).toBe("other");
    expect(directiveCategory(undefined)).toBe("other");
  });

  it("names what was blocked by category, never by address", () => {
    const cases: Record<string, string> = {
      inline: "inline", eval: "eval", "wasm-eval": "wasm-eval", "data:image/png;base64,AA": "data",
      "blob:https://app.example.test/1": "blob", self: "self", [`${BASE}/x`]: "self",
      "chrome-extension://abc/x.js": "extension", "moz-extension": "extension",
      "safari-web-extension://abc/x.js": "extension", "https://evil.example/x?y": "external",
      "http://app.example.test/x": "external", "ws://app.example.test": "other", "": "other",
    };
    for (const [blocked, category] of Object.entries(cases)) expect([blocked, blockedCategory(blocked, BASE)])
      .toEqual([blocked, category]);
  });

  it("names a source next-static only for our own built scripts", () => {
    expect(sourceCategory(`${BASE}/_next/static/chunks/app-1a2b.js`, BASE)).toBe("next-static");
    expect(sourceCategory(`${BASE}/_next/static/chunks/a.js#x`, BASE)).toBe("other");
    expect(sourceCategory("https://evil.example/_next/static/chunks/a.js", BASE)).toBe("other");
    expect(sourceCategory(`${BASE}/login`, BASE)).toBe("other");
    expect(sourceCategory("chrome-extension://abc/content.js", BASE)).toBe("extension");
    expect(sourceCategory(undefined, BASE)).toBe("none");
  });

});

describe("readBounded", () => {
  it("returns unreadable, never throws, for a stream that errors after one chunk", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("aborted"));
      },
    });
    await expect(readBounded(body, 16)).resolves.toEqual({ kind: "unreadable" });
  });
});
