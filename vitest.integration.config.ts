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
    // Prisma's engine sets these two names at a process's first connection,
    // from a thread of its own. Where a name is not set yet, the C library
    // moves the environment and frees the old one, and a second client being
    // built at that instant copies the freed one: its engine has no
    // DATABASE_URL from then on (P1012), or the process dies and Vitest
    // reports "Channel closed". With both set before a file loads, the
    // engine replaces each value in place and nothing moves. The paths are
    // the ones the engine finds on Ubuntu, where CI runs; it replaces one
    // that does not exist. `first-connection.db.test.ts` holds this.
    env: {
      SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? "/etc/ssl/certs/ca-certificates.crt",
      SSL_CERT_DIR: process.env.SSL_CERT_DIR ?? "/etc/ssl/certs",
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
