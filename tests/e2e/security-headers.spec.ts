import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createSharedFolderStorage } from "@app/storage";
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
  expect(pageHeaders["content-security-policy"] ?? "").not.toContain("sandbox");

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expectFixedHeaders(health.headers());
  expect(health.headers()["content-security-policy"]).toBe(API_POLICY);

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
