import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

/**
 * Suites that run the real `ffmpeg` and `ffprobe` (ADR-0072). Kept out of the
 * default run, like the database suites, so `pnpm test` needs no binaries; CI
 * runs them in the `media` job with Ubuntu 24.04's FFmpeg installed, and
 * `pnpm test:media` runs them locally.
 *
 * The base `test` block is spread rather than merged, because Vite's
 * mergeConfig concatenates arrays and would re-add the unit-test globs.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: ["tests/media/**/*.media.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    // Encodes are CPU-bound: one file at a time keeps each within its timeout.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
