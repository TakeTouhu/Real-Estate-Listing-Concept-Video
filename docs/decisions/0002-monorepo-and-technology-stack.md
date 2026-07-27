# ADR-0002: Monorepo structure and technology stack

- Status: Accepted
- Date: 2026-07-27
- Phase: 0

## Context

`CLAUDE.md` and `docs/SystemArchitecture.md` prescribe a modular monolith with
independently scalable asynchronous workers, and recommend TypeScript, Next.js,
PostgreSQL, Prisma, object storage, queue-based workers, FFmpeg, Stripe,
OpenTelemetry, Vitest, and Playwright. Phase 0 needs the structure and tooling
in place without implementing later-phase concerns.

## Decision

- **Package manager / workspace:** pnpm workspaces (`apps/*`, `packages/*`).
- **Language:** TypeScript in strict mode; ESLint forbids `any`.
- **Web/API:** Next.js 15 (App Router), React 19.
- **Testing:** Vitest for unit tests now; Playwright reserved for E2E later.
- **Lint:** ESLint 9 flat config with `typescript-eslint`.
- **Internal packages** are consumed as TypeScript source (their `exports`
  point at `src/index.ts`); Next `transpilePackages` and Vitest path aliases
  handle resolution, so no per-package build step is needed in Phase 0.
- **Module boundaries** from CLAUDE.md are created now, even where a package is
  only a placeholder, so later phases fill them in without restructuring.
- **Pinned, conservative dependency versions** are used for reproducible CI
  rather than the newest available majors.

## Consequences

- One `pnpm install`, one lockfile, unified typecheck/lint/test/build scripts.
- Placeholder packages (`domain`, `database`, `storage`, `queue`,
  `ai-providers`) carry no logic yet but establish the boundary and are
  typechecked/linted.
- Prisma/PostgreSQL are deferred to Phase 1; `prisma/` holds a placeholder.
