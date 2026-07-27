import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
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
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.{test,spec}.ts", "**/index.ts"],
    },
  },
});
