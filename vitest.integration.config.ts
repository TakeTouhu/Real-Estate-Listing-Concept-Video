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
    // can move the environment and free the old one while a second client,
    // being built at that instant, is copying it. Processes without the
    // names were seen to leave a second client without DATABASE_URL
    // (P1012), or to die, which Vitest reports as "Channel closed". With
    // both set before a file loads, the engine replaces each value in place
    // and nothing moves. The paths exist on Ubuntu, where CI runs (the
    // engine's own choice there, /usr/lib/ssl/cert.pem and
    // /usr/lib/ssl/certs, links to them); it keeps a path that exists and
    // replaces one that does not. `first-connection.db.test.ts` holds this.
    env: {
      SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? "/etc/ssl/certs/ca-certificates.crt",
      SSL_CERT_DIR: process.env.SSL_CERT_DIR ?? "/etc/ssl/certs",
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
