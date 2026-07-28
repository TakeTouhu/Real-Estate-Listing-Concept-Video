import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
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
      "apps/**/*.{test,spec}.ts",
      "tests/**/*.{test,spec}.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      // Live-PostgreSQL suites; run via vitest.integration.config.ts.
      "tests/integration/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.{test,spec}.ts", "**/index.ts"],
    },
  },
});
