import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Suites that speak to a ClamAV daemon (ADR-0163). Kept out of the default
 * run, like the database, media and Cloud Storage suites, so `pnpm test`
 * needs no daemon; CI runs them in the `storage` job beside the daemon's
 * service container, and `pnpm test:clamav` runs them locally once
 * `CLAMAV_TEST_PORT` names a daemon's port on this machine. Without it the
 * run fails: the file fails as it loads, and none of its tests runs.
 *
 * The base `test` block is spread rather than merged, because Vite's
 * mergeConfig concatenates arrays and would re-add the unit-test globs.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: ["tests/scanner/**/*.clamav.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
