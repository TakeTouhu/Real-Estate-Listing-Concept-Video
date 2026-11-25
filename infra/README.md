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
- The worker's image is RD-10c's.
