import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Integration suites that require a live PostgreSQL database. Kept in a
 * separate config (and excluded from the default run) so `pnpm test` stays
 * offline and deterministic, while `pnpm test:db` opts in explicitly.
 *
 * DATABASE_URL must point at a disposable test database — never production.
 *
 * The base `test` block is spread rather than merged, because Vite's
 * mergeConfig concatenates arrays and would re-add the unit-test globs.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: ["tests/integration/**/*.db.test.ts"],
    // The base config excludes tests/integration from the default offline run.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    // Migrations and shared tables make parallel files unsafe.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
