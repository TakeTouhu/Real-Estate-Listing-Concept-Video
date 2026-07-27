# tests

Cross-cutting test suites (integration, API authorization / tenant-isolation,
end-to-end via Playwright) live here as they are introduced from Phase 1 onward.

In Phase 0, unit tests live next to their source as `*.test.ts` files and are
run by Vitest via the root `vitest.config.ts`. Run them with `pnpm test`.
