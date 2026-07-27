# Phase 0 Gap Analysis

Version: 1.0
Status: Complete
Scope: Phase 0 — Engineering foundation (see `docs/Roadmap.md`)

## Method

Inspected the repository at the start of Phase 0, compared it against the
Phase 0 scope and completion criteria in `docs/Roadmap.md` and the "First
assignment" in `CLAUDE.md`, then implemented the smallest vertical milestone
that satisfies every completion criterion without starting later phases.

## Starting state

- Repository contained only `LICENSE` and the design documents under `docs/`
  plus `CLAUDE.md`.
- No application code, build tooling, tests, or CI.

## Requirement-by-requirement analysis

| Phase 0 requirement (Roadmap / CLAUDE.md) | Before | Delivered in this milestone |
| --- | --- | --- |
| Repository & monorepo structure | Missing | pnpm workspace: `apps/{web,worker}`, `packages/{shared,observability,video-providers,domain,database,storage,queue,ai-providers}`, plus `prisma/`, `infra/`, `tests/` placeholders |
| TypeScript strict configuration | Missing | `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `noUnused*`, etc.; `@typescript-eslint/no-explicit-any` enforced |
| Local development environment | Missing | `.env.example`, `README.md`, `docs/local-setup.md`, `pnpm dev` |
| CI pipeline | Missing | `.github/workflows/ci.yml`: install → typecheck → lint → test → build |
| Minimal authenticated health-check app | Missing | Next.js app: public `/api/health`, authenticated `/api/health/ready`, login-gated dashboard UI |
| Testing foundation | Missing | Vitest workspace config + 53 unit tests across domain-free logic, provider adapters, redaction, auth, health |
| Architecture decision records | Missing | ADR-0001…0004 under `docs/decisions/` |
| Environment / secret conventions | Missing | Zod-validated server env (`@app/shared`), server-only accessor, `.gitignore` excludes `.env*` |
| WaveSpeedAI provider ADR & adapter contract | Missing | `VideoGenerationProvider` interface + `FakeVideoProvider` (offline default); ADR-0003 + ADR-0005. `WaveSpeedVideoProvider` implementation deferred to Phase 1 |
| Gap analysis & completion report | Missing | This file + `docs/phase-0-completion.md` |

## Explicitly deferred (later phases)

These are intentionally **not** implemented in Phase 0, to keep the milestone
small while preserving module boundaries:

- PostgreSQL + Prisma, identity/orgs, tenant isolation — Phase 1
  (`packages/database`, `packages/domain` are placeholders).
- Property CRUD, signed uploads, EXIF handling — Phase 2 (`packages/storage`).
- AI analysis / storyboard — Phase 3 (`packages/ai-providers`).
- `WaveSpeedVideoProvider` implementation (submission, status mapping, webhook
  verification, polling, managed-storage copy) — begins in Phase 1 per project
  instruction (the roadmap forbids real API calls in Phase 0; the full
  scene-generation pipeline is Roadmap Phase 4).
- FFmpeg composition, review/approval — Phase 5.
- Stripe billing & credit ledger — Phase 6.
- Observability backends, IaC, hardening — Phase 7 (`infra/`).

## Key decisions taken here

- Consume internal packages as TypeScript source (no per-package build step);
  Next `transpilePackages` and Vitest aliases resolve them.
- Phase 0 authentication is a single interim operator token exchanged for a
  signed session cookie; replaced by real identity in Phase 1 (ADR-0004).
- The WaveSpeed provider is deferred to Phase 1; Phase 0 proves the adapter
  boundary with the fake adapter only, so no real API call is possible. The
  current WaveSpeedAI contract was verified against official docs (ADR-0005).

## Verification

All Phase 0 completion criteria pass; exact command results are recorded in
`docs/phase-0-completion.md`.
