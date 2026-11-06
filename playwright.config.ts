import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, e2eEnvironment } from "./tests/e2e/support/environment";

/** This process's environment, for Chromium, under a UTF-8 locale. */
const browserEnvironment: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
};

/**
 * The browser test (GS-13a, ADR-0121): Chromium drives the web app, run by
 * `next dev` with the test provider and a shared folder, against a disposable
 * PostgreSQL database on this machine (`DATABASE_URL`, migrated). Run it with
 * `pnpm test:e2e`; CI runs it in the `e2e` job.
 *
 * One worker: the tests share one web app and one database.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // `next dev` compiles each page the first time it is asked for.
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    acceptDownloads: true,
    navigationTimeout: 120_000,
    actionTimeout: 60_000,
    screenshot: "only-on-failure",
    trace: "off",
    // Chromium names a saved file outside ASCII only under a UTF-8 locale (ADR-0118 Decision 2).
    launchOptions: { env: browserEnvironment },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @app/web exec next dev --port ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    env: e2eEnvironment(),
    reuseExistingServer: false,
    timeout: 180_000,
    // `next dev` logs each request's address, signed links included: only its errors are shown.
    stdout: "ignore",
    stderr: "pipe",
  },
});
