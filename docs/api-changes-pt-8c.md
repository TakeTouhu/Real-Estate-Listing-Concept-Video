# API Changes — PT-8c

The migration image (ADR-0192). Production readiness, part 2. **No
route, request, response, stored value, setting or migration changes.**
What changes is a new container image, its ignore file, a ninth CI job
and the image guard.

## The image

`packages/database/Dockerfile`, with its own ignore file
`packages/database/Dockerfile.dockerignore` (the 22 lines every image
leaves out of its context), built from the repository root:

```bash
docker buildx build --load --platform linux/amd64 \
  -f packages/database/Dockerfile -t vtavision-migrate:local .
```

It holds the Prisma CLI 5.22.0 in its six `.pnpm` folders, both
Debian 13 OpenSSL 3 engines, `ca-certificates`, `/app/prisma/schema.prisma`
and `/app/prisma/migrations/`, on ADR-0175's pinned base, as
`1000:1000`. No client, app, psql or setting.

## Its default and other commands

The entrypoint is `node /app/node_modules/prisma/build/index.js`; the
default command is `migrate deploy --schema /app/prisma/schema.prisma`.
It reads `DATABASE_URL` from its environment, never from an argument:

```bash
docker run --rm --env-file migrate.env vtavision-migrate:local
docker run --rm --env-file migrate.env vtavision-migrate:local \
  migrate status --schema /app/prisma/schema.prisma
docker run --rm --env-file migrate.env vtavision-migrate:local \
  migrate resolve --rolled-back <name> --schema /app/prisma/schema.prisma
```

Arguments replace the default command, so `--schema` is given again.
When to use `migrate resolve` in production is PT-8e's written
procedure, not this file's.

## What runs it

Only CI's new `migrate-image` job, which builds it, checks it offline
and scans it (ADR-0192 Decision 4). Nothing deploys or pushes it;
`production-mode` still migrates from the runner until PT-8d, and the
production job is PT-10's. A pull request now shows 9 checks.
