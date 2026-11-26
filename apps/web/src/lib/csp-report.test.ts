import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerCspReport,
  blockedCategory,
  directiveCategory,
  dispositionCategory,
  OTHER_PAGE,
  PAGE_PATTERNS,
  pageCategory,
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
  it("keeps reports from a host that is not ASCII however often URLs were checked before", async () => {
    const sink = logged();
    for (let i = 0; i < 100_000; i += 1) URL.canParse(`https://a${i % 10}.example`);
    const idn = "https://bücher.example";
    const body = JSON.stringify({ "csp-report": { "document-uri": `${idn}/login`, "blocked-uri": "inline" } });
    const request = new Request(`${idn}/api/csp-report`, {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body,
    });
    expect(await answerCspReport(request, () => idn)).toBe(204);
    expect(sink).toHaveLength(1);
  });

  it("writes one INFO line of categories for a report-uri body, and never a secret it carried", async () => {
    const sink = logged();
    const secrets = reportUri({
      "document-uri": `${BASE}/properties/${UUID}/review?token=s3cret`,
      "blocked-uri": `${BASE}/api/storage/download?token=s3cret`,
      referrer: `${BASE}/reset-password?token=s3cret`,
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
    expect(line.violations).toEqual([{ mechanism: "report-uri", page: "/properties/[propertyId]/review",
      directive: "script-src-elem", blocked: "self", disposition: "enforce", source: "other", count: 1, total: 1 }]);
    for (const secret of ["s3cret", "token", "N0nce", "nonce", "?", "reset", UUID, "app.example"]) {
      expect(sink[0]).not.toContain(secret);
    }
    // The page's pattern is the line's one path.
    expect(sink[0]?.replace('"page":"/properties/[propertyId]/review"', "")).not.toContain("/");
  });

  it("reads report-to's csp-violation entries only, ten at most, and counts the rest as dropped", async () => {
    const sink = logged();
    const batch = [{ type: "deprecation", body: {} }, ...Array.from({ length: 12 }, () => violation())];
    expect(await answer(JSON.stringify(batch), "application/reports+json; charset=utf-8")).toBe(204);
    const line = JSON.parse(sink[0] ?? "{}") as { violations: Record<string, unknown>[]; dropped: number };
    expect(line.dropped).toBe(2);
    expect(line.violations).toEqual([{ mechanism: "report-to", page: "/login", directive: "script-src-elem",
      blocked: "inline", disposition: "other", source: "none", count: 10, total: 10 }]);
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

  it("lists every key that reached a power of two with one request, and only those, in one line", async () => {
    const sink = logged();
    const keys = (line: string | undefined) =>
      (JSON.parse(line ?? "{}") as { violations: Record<string, unknown>[] }).violations
        .map(({ blocked, count, total }) => ({ blocked, count, total }));
    const eval1 = violation({ blockedURL: "eval" });
    const reports = (...batch: unknown[]) => answer(JSON.stringify(batch), "application/reports+json");
    expect(await reports(violation(), eval1, eval1)).toBe(204);
    expect(sink).toHaveLength(1);
    expect(keys(sink[0])).toEqual([{ blocked: "inline", count: 1, total: 1 }, { blocked: "eval", count: 2, total: 2 }]);
    // inline reaches 2 and is listed; eval reaches 3, passing no power of two, and is not.
    expect(await reports(violation(), eval1)).toBe(204);
    expect(sink).toHaveLength(2);
    expect(keys(sink[1])).toEqual([{ blocked: "inline", count: 1, total: 2 }]);
  });

  it("reads report-uri's violated-directive's first word when effective-directive is absent", async () => {
    const sink = logged();
    const body = JSON.stringify({ "csp-report": { "document-uri": `${BASE}/login`, "blocked-uri": "inline",
      "violated-directive": "script-src 'nonce-N0nceS3cret'" } });
    expect(await answer(body)).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ violations: [{ directive: "script-src" }] });
    expect(sink[0]).not.toContain("N0nce");
  });
});

/**
 * Bodies shaped like the specifications' examples (CSP3's deprecated
 * serialization and the Reporting API's report), with every key they name
 * and each nullable field `null`; not captured from a browser (PT-7c3).
 */
describe("bodies shaped like the specifications'", () => {
  const POLICY = "script-src 'nonce-N0nceS3cret' 'strict-dynamic'; object-src 'none'";
  it("answers 204 and counts a report-uri body with every key, its optional ones null", async () => {
    const sink = logged();
    const body = JSON.stringify({ "csp-report": {
      "document-uri": `${BASE}/login`, referrer: "", "blocked-uri": null, "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem", "original-policy": POLICY, disposition: "report",
      "status-code": 200, "script-sample": "", "source-file": null, "line-number": null, "column-number": null,
    } });
    expect(await answer(body)).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ violations: [{ mechanism: "report-uri",
      directive: "script-src-elem", blocked: "other", disposition: "report", source: "none", count: 1, total: 1 }] });
  });

  it("answers 204 and counts a reports+json batch with every key, its nullable ones null", async () => {
    const sink = logged();
    const batch = [{ type: "csp-violation", age: 10, url: `${BASE}/login`, user_agent: "Mozilla/5.0 s3cret", body: {
      documentURL: `${BASE}/login`, referrer: null, blockedURL: null, effectiveDirective: "script-src-elem",
      originalPolicy: POLICY, sourceFile: null, sample: null, disposition: "enforce", statusCode: 200,
      lineNumber: null, columnNumber: null,
    } }, { type: "csp-violation", age: 3, url: `${BASE}/login`, user_agent: "Mozilla/5.0", body: {
      documentURL: `${BASE}/login`, referrer: "", blockedURL: "inline", effectiveDirective: "style-src-attr",
      originalPolicy: POLICY, sourceFile: `${BASE}/_next/static/chunks/app.js`,
      sample: "s3cret", disposition: "enforce", statusCode: 200, lineNumber: 1, columnNumber: 2,
    } }];
    expect(await answer(JSON.stringify(batch), "application/reports+json")).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ dropped: 0, violations: [
      { mechanism: "report-to", directive: "script-src-elem", blocked: "other", disposition: "enforce",
        source: "none" },
      { mechanism: "report-to", directive: "style-src-attr", blocked: "inline", disposition: "enforce",
        source: "next-static" },
    ] });
    for (const secret of ["s3cret", "N0nce", "Mozilla"]) expect(sink[0]).not.toContain(secret);
  });
});

/**
 * Bodies as Chromium 153 (headless) sent them in PT-7c3, for an inline script
 * refused on a page at `/login?run=1` over HTTPS, with this origin put in.
 * Neither names a column.
 */
describe("bodies captured from Chromium", () => {
  const POLICY = "script-src 'nonce-N0nceS3cret'; report-uri /api/csp-report; report-to csp";
  const expected = (mechanism: string) => ({ mechanism, page: "/login", directive: "script-src-elem",
    blocked: "inline", disposition: "enforce", source: "other", count: 1, total: 1 });

  it("counts report-uri's", async () => {
    const sink = logged();
    const body = JSON.stringify({ "csp-report": {
      "document-uri": `${BASE}/login?run=1`, referrer: "", "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem", "original-policy": POLICY, disposition: "enforce",
      "blocked-uri": "inline", "line-number": 1, "source-file": `${BASE}/login`, "status-code": 200,
      "script-sample": "",
    } });
    expect(await answer(body)).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ dropped: 0, violations: [expected("report-uri")] });
  });

  it("counts report-to's", async () => {
    const sink = logged();
    const body = JSON.stringify([{ age: 0, body: {
      blockedURL: "inline", disposition: "enforce", documentURL: `${BASE}/login?run=1`,
      effectiveDirective: "script-src-elem", lineNumber: 1, originalPolicy: POLICY, referrer: "", sample: "",
      sourceFile: `${BASE}/login`, statusCode: 200,
    }, type: "csp-violation", url: `${BASE}/login?run=1`, user_agent: "Mozilla/5.0 HeadlessChrome/153.0.0.0" }]);
    expect(await answer(body, "application/reports+json")).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ dropped: 0, violations: [expected("report-to")] });
    expect(sink[0]).not.toContain("Chrome");
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

  it("names a page by its route pattern, never by its path, query or ids", () => {
    const cases: Record<string, string> = {
      [`${BASE}/`]: "/", [`${BASE}/login?token=s3cret#x`]: "/login", [`${BASE}/login/mfa`]: "/login/mfa",
      [`${BASE}/properties/${UUID}/review`]: "/properties/[propertyId]/review",
      [`${BASE}/properties/${UUID}/video-projects/${UUID}/start`]:
        "/properties/[propertyId]/video-projects/[projectId]/start",
      [`${BASE}/organizations/${UUID}/members/${UUID}/permissions`]:
        "/organizations/[organizationId]/members/[userId]/permissions",
      [`${BASE}/properties/${UUID}/x`]: OTHER_PAGE, [`${BASE}/properties`]: OTHER_PAGE,
      [`${BASE}/properties/a%2Fb/review`]: OTHER_PAGE, [`${BASE}/login/`]: OTHER_PAGE,
      [`${BASE}/properties/${"a".repeat(65)}`]: OTHER_PAGE, [`${BASE}/${"a".repeat(199)}`]: OTHER_PAGE,
      [`${BASE}/properties/${UUID}/video-projects/${"a".repeat(150)}`]: OTHER_PAGE,
      "https://evil.example/login": OTHER_PAGE, "http://app.example.test/login": OTHER_PAGE, "not a url": OTHER_PAGE,
    };
    for (const [document, page] of Object.entries(cases)) expect([document, pageCategory(document, BASE)])
      .toEqual([document, page]);
    expect(pageCategory(undefined, BASE)).toBe(OTHER_PAGE);
  });

  it("knows every page of the app, and nothing else", () => {
    const pages = readdirSync(new URL("../app/", import.meta.url), { recursive: true, encoding: "utf8" })
      .map((path) => path.split("\\").join("/"))
      .filter((path) => path === "page.tsx" || path.endsWith("/page.tsx"))
      .map((path) => `/${path.slice(0, -"page.tsx".length)}`.replace(/(.)\/$/, "$1"));
    expect([...PAGE_PATTERNS].sort()).toEqual(pages.sort());
    expect(new Set(PAGE_PATTERNS).size).toBe(PAGE_PATTERNS.length);
  });

  it("logs a page's pattern, and the page of any path off the list as (other), never the path", async () => {
    const sink = logged();
    const pageOf = (line: string | undefined) =>
      (JSON.parse(line ?? "{}") as { violations: { page: string }[] }).violations[0]?.page;
    expect(await answer(reportUri({ "document-uri": `${BASE}/properties/${UUID}/review?token=s3cret` }))).toBe(204);
    expect(await answer(reportUri({ "document-uri": `${BASE}/properties/${UUID}/x?token=s3cret` }))).toBe(204);
    expect(await answer(reportUri({ "document-uri": `${BASE}/${"p".repeat(200)}?token=s3cret` }))).toBe(204);
    expect(sink.map(pageOf)).toEqual(["/properties/[propertyId]/review", OTHER_PAGE, OTHER_PAGE]);
    for (const secret of ["s3cret", "token", UUID, "/x", "ppp"]) expect(sink.join("\n")).not.toContain(secret);
  });

  it("names a source next-static only for our own built scripts", () => {
    expect(sourceCategory(`${BASE}/_next/static/chunks/app-1a2b.js`, BASE)).toBe("next-static");
    expect(sourceCategory(`${BASE}/_next/static/chunks/a.js#x`, BASE)).toBe("other");
    expect(sourceCategory("https://evil.example/_next/static/chunks/a.js", BASE)).toBe("other");
    expect(sourceCategory(`${BASE}/login`, BASE)).toBe("other");
    expect(sourceCategory("chrome-extension://abc/content.js", BASE)).toBe("extension");
    expect(sourceCategory(undefined, BASE)).toBe("none");
  });

  it("names a disposition enforce or report and anything else other, never the sender's text", async () => {
    expect([dispositionCategory("enforce"), dispositionCategory("report")]).toEqual(["enforce", "report"]);
    expect([dispositionCategory("s3cret-disposition"), dispositionCategory(undefined)]).toEqual(["other", "other"]);
    const sink = logged();
    expect(await answer(reportUri({ disposition: "s3cret-disposition" }))).toBe(204);
    expect(JSON.parse(sink[0] ?? "{}")).toMatchObject({ violations: [{ disposition: "other" }] });
    expect(sink[0]).not.toContain("s3cret");
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
