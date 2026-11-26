import { defineConfig, devices } from "@playwright/test";
import { APP_BASE_URL } from "./tests/production/support/run";

/**
 * The browser through the production-mode job's TLS front (RD-11b, ADR-0178):
 * Chromium drives the web image as built, which CI's `production-mode` job
 * runs against stand-ins and starts itself, so no server is started here. Run
 * it with `pnpm test:production` from that job's steps, with `runner.env`
 * loaded; it has no meaning elsewhere.
 *
 * The front presents a leaf of this run's own authority, which Chromium is
 * not given: certificate errors are ignored here alone (and on the second
 * person's page), while CI's curl proves the leaf against the authority.
 */
export default defineConfig({
  testDir: "tests/production",
  testMatch: "*.spec.ts",
  outputDir: "test-results/production",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 10 * 60_000,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: APP_BASE_URL,
    ignoreHTTPSErrors: true,
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    // No trace: it would keep every request, mailed links included. A failure keeps a screenshot alone.
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
