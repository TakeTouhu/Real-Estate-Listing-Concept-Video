import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Next compiles JSX itself (tsconfig keeps `jsx: preserve`), so component
  // tests need the automatic runtime declared here or esbuild falls back to
  // the classic transform and `React` is undefined at render time.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      {
        // apps/web uses "@/..." for its own source; mirror its tsconfig path so
        // route handlers can be exercised by tests.
        find: /^@\/(.+)$/,
        replacement: resolve(rootDir, "apps/web/src/$1"),
      },
      {
        // Subpath exports (e.g. "@app/domain/testing") resolve to their folder
        // barrel. Must precede the bare-package rule.
        find: /^@app\/([^/]+)\/(.+)$/,
        replacement: resolve(rootDir, "packages/$1/src/$2/index.ts"),
      },
      {
        // Resolve internal workspace packages to their TypeScript source so
        // Vitest transforms them (aliases bypass node_modules externalization).
        find: /^@app\/([^/]+)$/,
        replacement: resolve(rootDir, "packages/$1/src/index.ts"),
      },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/**/*.{test,spec}.ts",
      "apps/**/*.{test,spec}.{ts,tsx}",
      "tests/**/*.{test,spec}.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      // Live-PostgreSQL suites; run via vitest.integration.config.ts.
      "tests/integration/**",
      // Real-FFmpeg suites; run via vitest.media.config.ts.
      "tests/media/**",
      // Cloud Storage emulator suites; run via vitest.gcs.config.ts.
      "tests/storage/**",
      // ClamAV suites; run via vitest.clamav.config.ts.
      "tests/scanner/**",
      // SMTP suites against Mailpit; run via vitest.smtp.config.ts.
      "tests/email/**",
      // Browser tests; run by Playwright (playwright.config.ts).
      "tests/e2e/**/*.spec.ts",
      // The browser through the production-mode job's front; run by Playwright (playwright.production.config.ts).
      "tests/production/**/*.spec.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.{test,spec}.ts", "**/index.ts"],
    },
  },
});
