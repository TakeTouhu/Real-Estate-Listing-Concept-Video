# Real Estate Virtual Tour AI

A commercial, multi-tenant SaaS that generates real-estate interior
walkthrough-style videos from uploaded property photos.

> **Status: Phase 5C complete.** Phases 0–5C are merged.
>
> Delivered: the monorepo foundation; identity, organizations, RBAC, sessions,
> Prisma persistence and audit logging; property CRUD and a secure photo-upload
> pipeline (short-lived signed URLs, tenant-scoped object storage, content-based
> MIME validation, malware-scan hook with quarantine, EXIF removal, orientation
> correction, normalization, thumbnails, perceptual hashing); AI image analysis
> with **source-photo** review, correction and storyboard composition; scene
> generation admission with an immutable frozen request; the managed-output
> integrity, media-validation and failure-settlement lifecycles; and Phase 5's
> deliverable composition plan (5A), composition execution with a durable
> SHA-256 receipt (5B), and deliverable validation plus the publication boundary
> that consumes an entitlement Unit exactly once (5C).
>
> **The product still does not generate a video.** Every generation and
> composition runner is dormant: nothing constructs them, there is no scheduler,
> cron or timer, and no paid provider call has ever been made. **Paid Provider
> Activation and production scheduler activation are BLOCKED** and require
> explicit CTO authorization (ADR-0054).
>
> Also not yet built, though required for the initial release: the AI-generated
> disclosure renders at no layer, the company logo pipeline does not exist, and
> the groups/Scope authorization model is unimplemented. See
> `docs/decisions/TODO.md`.
>
> The approved initial-release product, commercial and production contract is
> ADR-0052, ADR-0053 and ADR-0054. See also `docs/Roadmap.md`,
> `docs/progress.md`, and the per-phase completion reports in `docs/`.

## Design documents

`CLAUDE.md` is the implementation guide. The approved initial-release contract is
ADR-0052 (product and delivery), ADR-0053 (commercial) and ADR-0054 (production
platform and activation gates) — read those first, because they supersede stale
product assumptions in the older v1.0 specifications. Full specifications live in
`docs/` (product requirements, architecture, AI pipeline, provider integration,
data model, API, UX, security/compliance, SaaS operations, roadmap). Decisions are
recorded in `docs/decisions/`.

### As-built documentation

| Topic | Document |
| --- | --- |
| Delivery status, tags, governance | `docs/progress.md` |
| Architecture diagram (implemented) | `docs/architecture.md` |
| Entity-relationship diagram | `docs/er-diagram.md` |
| Upload lifecycle sequence + state machine | `docs/sequence-upload-lifecycle.md` |
| API change summary + OpenAPI fragment | `docs/api-changes-phase-2.md` |
| Change log | `CHANGELOG.md` |
| Release notes | `docs/release-notes-phase-2.md` |
| Database migration notes | `docs/migration-notes.md` |
| Phase completion reports | `docs/phase-0-completion.md`, `docs/phase-1-completion.md`, `docs/phase-2-completion.md` |

## Repository layout

```text
apps/
├── web/        # Next.js app: authenticated health-check console + API
└── worker/     # async generation worker (Phase 0: bootstrap + self-check)
packages/
├── shared/            # env schema, errors, money, security + crypto utils
├── observability/     # structured logger with redaction
├── video-providers/   # VideoGenerationProvider + Fake + WaveSpeed adapters
├── domain/            # identity + property/media domain: entities, RBAC, services, ports
├── database/          # Prisma schema, client, org-scoped repositories
├── storage/           # object storage, signed URLs, image pipeline, malware hook
├── queue/             # empty by decision — no transport (ADR-0024)
└── ai-providers/      # placeholder (Phase 3)
infra/  tests/  docs/
```

The Prisma schema and migrations live in `packages/database/prisma`.

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
