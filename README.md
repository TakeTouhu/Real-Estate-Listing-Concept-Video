# Real Estate Virtual Tour AI

A commercial, multi-tenant SaaS that generates real-estate interior
walkthrough-style videos from uploaded property photos.

> **Status: Phase 0 — Engineering foundation.** This repository currently
> contains the monorepo scaffolding, the video-provider abstraction (with an
> offline fake adapter and a WaveSpeedAI skeleton), a minimal authenticated
> health-check app, tests, and CI. It does **not** yet generate videos or call
> the real WaveSpeedAI API. See `docs/Roadmap.md` and
> `docs/phase-0-completion.md`.

## Design documents

`CLAUDE.md` is the implementation guide. Full specifications live in `docs/`
(product requirements, architecture, AI pipeline, WaveSpeedAI integration, data
model, API, UX, security/compliance, SaaS operations, roadmap). Decisions are
recorded in `docs/decisions/`.

## Repository layout

```text
apps/
├── web/        # Next.js app: authenticated health-check console + API
└── worker/     # async generation worker (Phase 0: bootstrap + self-check)
packages/
├── shared/            # env schema, errors, money, security utils
├── observability/     # structured logger with redaction
├── video-providers/   # VideoGenerationProvider + Fake + WaveSpeed adapters
├── domain/            # placeholder (Phase 1+)
├── database/          # placeholder (Phase 1)
├── storage/           # placeholder (Phase 2/4)
├── queue/             # placeholder (Phase 4)
└── ai-providers/      # placeholder (Phase 3)
prisma/  infra/  tests/  docs/
```

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10 (`corepack enable`)

## Quick start

```bash
corepack enable
pnpm install
cp .env.example .env.local   # then edit values (see docs/local-setup.md)
pnpm dev                     # web app on http://localhost:3000
```

See `docs/local-setup.md` for details, including generating the local
`SESSION_SECRET` / `HEALTHCHECK_API_TOKEN`.

## Checks

```bash
pnpm typecheck   # tsc --noEmit across all workspaces
pnpm lint        # eslint (flat config; no-explicit-any enforced)
pnpm test        # vitest unit tests
pnpm build       # next production build
pnpm check       # all of the above, in CI order
```

CI runs the same steps on every push and pull request
(`.github/workflows/ci.yml`).

## Health endpoints

- `GET /api/health` — public liveness (no secrets).
- `GET /api/health/ready` — authenticated readiness; send
  `Authorization: Bearer $HEALTHCHECK_API_TOKEN`.
- `/` — login-gated operations dashboard (`/login` to sign in).

## Security notes

The WaveSpeedAI API key and other secrets are server-side only and must never
be exposed to the browser. The video provider is only ever used through the
`VideoGenerationProvider` interface. See `docs/SecurityCompliance.md` and
`docs/decisions/0003-wavespeedai-video-provider.md`.
