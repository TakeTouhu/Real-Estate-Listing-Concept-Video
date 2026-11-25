import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Suites that speak to Mailpit, a mail catcher, over SMTP (ADR-0166). Kept out
 * of the default run, like the database, media, Cloud Storage and ClamAV
 * suites, so `pnpm test` needs no server; CI runs them in the `storage` job
 * beside Mailpit's service container, and `pnpm test:smtp` runs them locally
 * once `MAILPIT_TEST_SMTP_PORT` and `MAILPIT_TEST_API_PORT` name its ports on
 * this machine. Without them the run fails: the file fails as it loads, and
 * none of its tests runs.
 *
 * The base `test` block is spread rather than merged, because Vite's
 * mergeConfig concatenates arrays and would re-add the unit-test globs.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: ["tests/email/**/*.smtp.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
