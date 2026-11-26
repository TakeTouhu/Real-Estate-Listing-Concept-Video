import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/environment";

/**
 * The one spec without the Content Security Policy guard (PT-7c3, ADR-0189):
 * it makes the policy refuse a script on purpose, to see the refusal reported.
 * Every other spec keeps the guard (`support/csp-guard.test.ts`).
 */

/** A same-origin address that is no page of the app: the test answers it, the web app never sees it. */
const DOCUMENT = `${E2E_BASE_URL}/csp-report-probe`;

/** The endpoint, which the web app answers. */
const CSP_REPORT_PATH = "/api/csp-report";

/** `next dev`'s page policy as the middleware sends it (`security-headers.spec.ts`), but without `report-to csp`. */
const reportUriPolicy = (nonce: string): string =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'; ` +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; " +
  "frame-ancestors 'none'; report-uri /api/csp-report";

/**
 * The keys CSP3 names for a report-uri body. Chromium 153 sent all but `column-number` (measured, PT-7c3); the
 * test's Chromium may differ in that one, so the body is held to this list, not to an exact set.
 */
const REPORT_KEYS = [
  "blocked-uri",
  "column-number",
  "disposition",
  "document-uri",
  "effective-directive",
  "line-number",
  "original-policy",
  "referrer",
  "script-sample",
  "source-file",
  "status-code",
  "violated-directive",
];

/**
 * A page under `next dev`'s policy, as the middleware sends it but without
 * `report-to` (measured, PT-7c3): Chromium reports by `report-to` alone when
 * the policy names it, registers no `Reporting-Endpoints` from a plain-`http`
 * page such as `next dev`'s, and sends that upload from its network service,
 * which a page's requests do not show. With `report-uri` alone, the page posts
 * the report itself. One nonced script runs; one inline script without the
 * nonce is refused. The endpoint itself is not intercepted: the web app
 * answers it.
 */
test("a refused inline script is reported by report-uri, and the endpoint answers 204", async ({ page }) => {
  const nonce = randomBytes(16).toString("base64");
  const policy = reportUriPolicy(nonce);
  const html =
    `<!doctype html><html><head><title>probe</title><script nonce="${nonce}">document.title = "nonced";</script>` +
    '<script>document.title = "inline";</script></head><body></body></html>';
  const headers = { "content-security-policy": policy };
  await page.route(DOCUMENT, (route) => route.fulfill({ status: 200, contentType: "text/html", headers, body: html }));

  // Bounded by Playwright's own default limit for a wait and the test's limit, never by a timer of the test's.
  const reported = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === CSP_REPORT_PATH,
  );
  await page.goto(DOCUMENT);
  const request = await reported;
  expect(await page.title()).toBe("nonced");

  expect(request.url()).toBe(`${E2E_BASE_URL}${CSP_REPORT_PATH}`);
  expect(request.headers()["content-type"]).toBe("application/csp-report");
  const response = await request.response();
  expect(response?.status()).toBe(204);
  expect(await response?.text()).toBe("");

  const body = request.postDataJSON() as { "csp-report": Record<string, unknown> };
  expect(Object.keys(body)).toEqual(["csp-report"]);
  expect(Object.keys(body["csp-report"]).filter((key) => !REPORT_KEYS.includes(key))).toEqual([]);
  expect(body["csp-report"]).toMatchObject({
    "document-uri": DOCUMENT,
    "blocked-uri": "inline",
    "effective-directive": "script-src-elem",
    "violated-directive": "script-src-elem",
    "original-policy": policy,
    disposition: "enforce",
    "status-code": 200,
    // No `'report-sample'` in the policy, so no sample of the refused script.
    "script-sample": "",
  });
});
