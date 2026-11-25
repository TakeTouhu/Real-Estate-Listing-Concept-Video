# API Changes — RD-10a

The web app has a production container image, built and run by a new CI
job on every push and pull request and pushed nowhere (ADR-0175).
**No migration, no dependency, no route and no new setting.** RD-10 has
started with it.

## HTTP

No route, header or answer changed. `next build` now also writes the
standalone server (`output: "standalone"`), which the image runs.
Measured on a production build here, that server sends HSTS and no
`X-Powered-By` from liveness, the page policy with a nonce from
`/login`, and readiness `401` without the token.

Behind the image's bind address, a redirect built from `request.url`
names `0.0.0.0:3000`: measured on the throwaway copy's image (below),
`POST /api/auth/logout`
answered `303` with `Location: http://0.0.0.0:3000/login`. CI prints it
as data; RD-10b makes route handlers answer a path (ADR-0175
Decision 7).

## The image

`apps/web/Dockerfile`, built from the repository root:

| Stage | What it does |
| --- | --- |
| `build` | `node:22-trixie-slim` by digest; `pnpm fetch` and an offline install from the lockfile; refuses a `.env` at the root, `packages/database` or its `prisma` folder, and any `apps/web/.env*`; requires Prisma's OpenSSL 3 engine and refuses a 1.1 one, saying why; `env -u NODE_ENV pnpm --filter @app/web build` |
| `runtime` | the same base; `ca-certificates` alone, its bundle required; the standalone tree and `.next/static`, owned by root; `USER 1000:1000`; port 3000 |

The image's environment adds exactly `NODE_ENV=production`,
`NEXT_TELEMETRY_DISABLED=1`, `HOSTNAME=0.0.0.0`, `PORT=3000`,
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` and
`SSL_CERT_DIR=/etc/ssl/certs` to the base's. Its entrypoint is
`/usr/bin/env -u NEXT_PHASE node apps/web/server.js`; it has no `CMD`,
no `HEALTHCHECK` and no build argument. `apps/web/Dockerfile.dockerignore`
keeps `.git` and `.claude` at any depth, `.github`, `docs`,
`.pnpm-store`, every `dist` and `out`, every `.env` and `.env.*`,
`node_modules`, `.next`, coverage, test and development output, build
info, `next-env.d.ts` and logs out of the context.

## Environment

None added or changed. The image carries no setting of the app; a run
gives them all, and a production start refuses without them, as before
(ADR-0151).

## Internal API

None. The one source change is `output: "standalone"` in
`apps/web/next.config.mjs`.

## Logs

None changed.

## Tests and CI

New `tests/container-images.test.ts`, in `pnpm test`: the text guard of
ADR-0175 Decision 3 for every Dockerfile, its ignore file and the
workflow, and the web image's own rules (`tests/README.md`).

New CI job `web-image` (`ubuntu-24.04`, 30 minutes, `contents: read`):
it builds the image with `docker buildx build --provenance=false --load
--platform linux/amd64` and the commit as
`org.opencontainers.image.revision`, then runs it with
`--network none --read-only --cap-drop ALL --security-opt
no-new-privileges`: no settings and `NEXT_PHASE` each exit 1, each
step under 2 minutes; the
image's user, entrypoint and environment; sixteen stand-in settings,
liveness, `/login`, readiness `401` and `503` with `P1001` logged for
the database, uid 1000 and the logout `Location`; then the packages,
Node.js's version and the size. Its last step prints the server's log
and removes the container whatever happened. A pull request shows 12
checks.

Where this differs from the RD-10 design (`critic.md` §2 and §3, and
`ci-and-supply-chain.md`, whose job has the `--check` step and the
`--tmpfs`):

- **No `--check` step.** `# check=error=true` already fails the build
  on any warning of BuildKit's checks.
- **The guard holds more than C12 lists**: comments read as Docker
  reads them; no `--chown`, `--chmod`, `chown`, `chmod`, `ONBUILD` or
  here-document; every image named by `--from=` or a mount pinned; the
  last `USER` of the image's own stage; no setting of the environment
  schema but `NODE_ENV` in `ENV`, nor `NODE_OPTIONS`,
  `NODE_EXTRA_CA_CERTS` or `OPENSSL_CONF`; no proxy in any instruction;
  the web runtime stage word for word; and the `web-image` job read
  field by field (below, `tests/README.md`).
- **The logout probe sends `Origin: https://app.rd10.test`**, so the
  origin check lets it reach the redirect.
- **No `--tmpfs`.** On a read-only root every step of the smoke passed
  and nothing was logged of a failed write (measured on a local copy of
  the image, below).
- **A last step prints the server's log and removes its container**
  whatever happened.

Measured here on a throwaway copy of the Dockerfile that differs only
by this sandbox's proxy authority on the two install steps and no
`apt-get` line (Debian's mirror is refused here): the build stage
passed its checks with only the OpenSSL 3 engine, and the job's own
scripts passed every step against its image; after review it was made
again from the Dockerfile as committed and passed again. The runtime's
`apt-get` line has not run anywhere yet; the first full build is CI's.
