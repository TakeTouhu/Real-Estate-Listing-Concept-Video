import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Suites that speak to the Cloud Storage emulator (ADR-0156). Kept out of the
 * default run, like the database and media suites, so `pnpm test` needs no
 * emulator; CI runs them in the `storage` job beside the emulator's service
 * container, and `pnpm test:gcs` runs them locally once
 * `GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT` names a running emulator. Without it
 * the run fails: Vitest marks the file failed and its tests skipped.
 *
 * The base `test` block is spread rather than merged, because Vite's
 * mergeConfig concatenates arrays and would re-add the unit-test globs.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: ["tests/storage/**/*.gcs.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
