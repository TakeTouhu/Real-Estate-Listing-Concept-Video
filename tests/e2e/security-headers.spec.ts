import { randomUUID } from "node:crypto";
import type { APIResponse, Response } from "@playwright/test";
import { createSharedFolderStorage } from "@app/storage";
import { expect, test } from "./support/csp-guard";
import { E2E_BASE_URL, E2E_SHARED_STORAGE_DIR, E2E_STORAGE_SIGNING_SECRET } from "./support/environment";

/** The fixed headers every answer carries (RD-9d, ADR-0174 Decision 8). */
const EVERY_ANSWER = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** The API policy (Decision 9): the download route's own `default-src 'none'; sandbox`, and no framing. */
const API_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** `next dev`'s page policy (Decision 10), which serves this test, for a nonce; it reports (ADR-0189, PT-7c3). */
const devPagePolicy = (nonce: string): string =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'; ` +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; " +
  "frame-ancestors 'none'; report-uri /api/csp-report; report-to csp";

/** Where a page's `report-to` group posts: on every page answer, never on the API's (PT-7c3). */
const REPORTING_ENDPOINTS = 'csp="/api/csp-report"';

/** Every `Content-Security-Policy` an answer carries: one source of headers each, never two (RD-9e). */
async function policiesOf(answer: Response | APIResponse): Promise<string[]> {
  const headers = await answer.headersArray();
  return headers.filter(({ name }) => name.toLowerCase() === "content-security-policy").map(({ value }) => value);
}

/** The fixed headers, and neither HSTS, which only a production build sends, nor `X-Powered-By`. */
function expectFixedHeaders(headers: Record<string, string>): void {
  expect(headers).toMatchObject(EVERY_ANSWER);
  expect(headers["strict-transport-security"]).toBeUndefined();
  expect(headers["x-powered-by"]).toBeUndefined();
}

/**
 * The fixed security headers and the API policy, as a browser receives them
 * from the web app (RD-9d, ADR-0174 Decisions 8 and 9): on a page, on the
 * liveness probe and on a signed download link. A header set by the
 * configuration replaces a handler's of the same name, so the download link
 * shows which of the route's own headers it keeps.
 */
test("pages, the API and a signed download link carry the fixed security headers", async ({ page, request }) => {
  const login = await page.goto("/login");
  if (login === null) throw new Error("The sign-in page gave no answer");
  expect(login.status()).toBe(200);
  const pageHeaders = await login.allHeaders();
  expectFixedHeaders(pageHeaders);
  // The API policy forbids scripts: it is never a page's.
  expect(await policiesOf(login)).toEqual([expect.not.stringContaining("sandbox")]);
  expect(pageHeaders["reporting-endpoints"]).toBe(REPORTING_ENDPOINTS);

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expectFixedHeaders(health.headers());
  // The middleware never runs for the API: the configuration's policy is the only one.
  expect(await policiesOf(health)).toEqual([API_POLICY]);
  expect(health.headers()["reporting-endpoints"]).toBeUndefined();

  // A link the web app's own signer makes, to an object in its shared folder. It is asked from Node, outside
  // Playwright's recorded steps, and only its answer is read: the link is never printed (ADR-0121 Decision 1).
  const { objectStorage } = createSharedFolderStorage({
    root: E2E_SHARED_STORAGE_DIR,
    secret: E2E_STORAGE_SIGNING_SECRET,
  });
  const key = `e2e/security-headers/${randomUUID()}`;
  await objectStorage.putObject(key, new TextEncoder().encode("stored bytes"));
  try {
    const link = await objectStorage.createSignedDownloadUrl(key, 60, { attachmentFilename: "headers.txt" });
    const download = await fetch(new URL(link.url, E2E_BASE_URL)).catch(() => {
      throw new Error("The signed download link could not be read");
    });
    expect(download.status).toBe(200);
    const downloadHeaders = Object.fromEntries(download.headers);
    expectFixedHeaders(downloadHeaders);
    // The configuration's policy replaces the route's own, which it contains; what the route decides per answer
    // stays.
    expect(downloadHeaders["content-security-policy"]).toBe(API_POLICY);
    expect(downloadHeaders).toMatchObject({
      "cache-control": "private, no-store",
      "content-disposition": "attachment; filename=\"headers.txt\"; filename*=UTF-8''headers.txt",
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
    });
    expect(await download.text()).toBe("stored bytes");
  } finally {
    await objectStorage.deleteObject(key);
  }

  // A refused link gains the policy and nosniff, which the route sets only on the answers that serve bytes.
  const refused = await request.get("/api/storage/download");
  expect(refused.status()).toBe(401);
  expectFixedHeaders(refused.headers());
  expect(refused.headers()["content-security-policy"]).toBe(API_POLICY);
  expect(refused.headers()["cache-control"]).toBe("private, no-store");
});

/**
 * The page policy (RD-9e, ADR-0174 Decision 10): the middleware sends it with a
 * new nonce on every load, Next.js puts that nonce on every script of the page,
 * and the scripts run. `next dev` serves this test, so it is `next dev`'s
 * policy; the guard every spec runs fails on anything it refuses.
 */
test("a page carries the page policy, with a new nonce on every script of each load", async ({ page }) => {
  const nonces: string[] = [];
  for (const address of ["/login", "/login", "/no-such-page"]) {
    const answer = await page.goto(address);
    if (answer === null) throw new Error(`${address} gave no answer`);
    expect(answer.status()).toBe(address === "/no-such-page" ? 404 : 200);
    const policies = await policiesOf(answer);
    expect(policies).toHaveLength(1);
    const nonce = /'nonce-([^']+)'/.exec(policies[0] ?? "")?.[1] ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policies[0]).toBe(devPagePolicy(nonce));
    expect(await answer.headerValue("reporting-endpoints")).toBe(REPORTING_ENDPOINTS);
    nonces.push(nonce);

    const scripts = (await answer.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(` nonce="${nonce}"`);
    // Next.js's inline scripts ran and loaded its chunks: the client router started.
    await expect
      .poll(() => page.evaluate(() => typeof (globalThis as { next?: { version?: unknown } }).next?.version))
      .toBe("string");
  }
  expect(new Set(nonces).size).toBe(nonces.length);
});
