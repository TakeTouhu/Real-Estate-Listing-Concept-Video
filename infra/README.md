# infra

Placeholder for infrastructure-as-code (containers, environments, deployment).

Deployment infrastructure is delivered in **Phase 7 — SaaS operations and
production readiness** (see `docs/Roadmap.md`). The only automation present in
Phase 0 is the GitHub Actions CI pipeline at `.github/workflows/ci.yml`.

The container images live beside their apps, not here, and are built
from the repository root (ADR-0175):

- `apps/web/Dockerfile`, with its own ignore file
  `apps/web/Dockerfile.dockerignore`: the web app's production image,
  built and run by CI's `web-image` job and pushed nowhere.
- `apps/worker/Dockerfile`, with its own ignore file
  `apps/worker/Dockerfile.dockerignore` and its check and checksum list
  in `apps/worker/image/`: the worker's runtime layer, Debian 13's FFmpeg
  and the six disclosure images with no worker code (ADR-0176), built
  and checked by CI's `worker-image` job and pushed nowhere.
- `packages/database/Dockerfile`, with its own ignore file
  `packages/database/Dockerfile.dockerignore`: the migration image, the
  Prisma CLI, its engines, `schema.prisma` and the migrations, running
  `migrate deploy` by default (ADR-0192), built, checked offline and
  scanned by CI's `migrate-image` job, and pushed nowhere. Nothing
  deploys it yet; the production job that runs it is PT-10's.
