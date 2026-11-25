# ADR-0175 — Container images built in CI and never pushed; the web image

Status: Accepted (RD-10a, 2026-11-25). The first part of the tenth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`, design item
7 and PR-10). It decides the rules every image of RD-10 keeps, the web
app's image and the CI job that builds and runs it. RD-10a builds
Decisions 1 to 6 and 8; Decision 7 is **built in RD-10b**. The worker
image is RD-10c's, with an ADR of its own (ADR-0176), which rests on
what RD-10c measures of its FFmpeg. If a later RD-10 measurement
contradicts a decision here, that PR writes a new ADR rather than
editing this one.

Builds on: ADR-0054 (Google Cloud; container images in Artifact
Registry, Decision 1), ADR-0072 (CI's own FFmpeg; production FFmpeg not
decided, Decision 6), ADR-0150 Decision 2 and ADR-0151 (the ambient and
the configured `NODE_ENV`; the start check, which Next.js skips while
`NEXT_PHASE` names the build), ADR-0154 (readiness says what the start
check refuses), ADR-0155 (two database clients in a process, and the
two names Prisma's engine sets), ADR-0158 Decision 6 (the storage
adapter's own connections; no proxy), ADR-0159 Decision 7 (a production
build run with Google's names redirected, by hand), ADR-0163 Decision 5
(an image pinned by digest; a digest no longer served fails loudly),
ADR-0174 Decisions 8 and 12 (HSTS fixed by `next build`; redirects built
from `request.url`).

## Context

Nothing in the repository built an image: `infra/` held a README, and no
Dockerfile existed. Part 2 deploys to Cloud Run from Artifact Registry
(ADR-0054); part 1 only proves that an image can be built from a clean
checkout and that it starts as production requires. Four reports and a
critic in `/mnt/project-files/cto/rd-10/` read the build, the image, CI
and the open items; `decision.md` there records the CTO's choices, all
as the critic recommended (`critic.md` §2 to §5).

## Decision 1 — Built and run in CI, pushed nowhere

Every image is built and run in CI on every push and pull request, one
job per image, added by the pull request that adds the image: the
`web-image` job here. A job builds with the runner's own Docker and
`docker buildx build --provenance=false --load --platform linux/amd64`,
no other action than `actions/checkout` (with
`persist-credentials: false`), and `permissions: contents: read`. The
commit is recorded as the label
`org.opencontainers.image.revision`, from the job's `env:`.

Nothing is pushed: no registry, login, secret, build cache or schedule.
Artifact Registry is part 2's. The workflow runs on `push` and on
`pull_request`, so a job shows two checks on a pull request: 10 before
RD-10a, 12 after it. The merge rule reads "every check green".

## Decision 2 — One pinned base for every image

Every image starts from `node:22-trixie-slim` by its index digest, one
digest for all:

```text
node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6
```

Debian 13 carries `libssl3t64`, which Prisma's engine needs, and is
Debian's stable release; Node.js 22 is `.nvmrc`'s. Alpine breaks the
glibc builds of Prisma and `sharp`; distroless is not an official
`node` or `debian` image.

A person refreshes the digest in a reviewed pull request, at once for a
Node.js or OpenSSL security release, otherwise at the CTO's dependency
review. No bot, schedule or step in CI looks for a newer digest; each
build pulls the pinned one from Docker Hub. A digest Docker Hub
stops serving fails the job loudly, and the fix is the same bump.

## Decision 3 — What every Dockerfile keeps

Each Dockerfile:

- starts with `# check=error=true` and has no `# syntax=` line, which
  would pull a frontend image from outside `node` and `debian`;
- pins every outside `FROM` by tag and digest;
- has no `ARG`, which the build log, the history and a provenance
  record would show, and no `ADD`;
- has no `HEALTHCHECK`: a probe repeated on an interval is a timer in
  the image, and the platform's probes are part 2's;
- sets in `ENV` no setting of the app, no proxy, none of the names the
  repository bans or production refuses, and no name that reads as a
  secret (`SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, a `_KEY`
  ending); a secret under another name is review's to catch;
- ends, in the stage that becomes the image, with a numeric, non-root
  `USER`, and gives no file another owner or mode (no `--chown`,
  `--chmod`, `chown` or `chmod`), so the server cannot change its own
  code;
- names every outside image it reads, in `FROM`, `COPY --from=` or a
  mount's `from=`, by tag and digest, and has no `ONBUILD` and no
  here-document;
- has its own ignore file beside it, `<Dockerfile>.dockerignore`, which
  BuildKit reads instead of a root `.dockerignore`, of which there is
  none. Its patterns that must reach every depth start with `**/`, since
  Docker matches from the context's root, and none starts with `!`.

`tests/container-images.test.ts` reads every Dockerfile it lists (a
new image adds its own), its ignore file and the workflow as text, and
holds all of it, with the web image's own rules below. It reads
comments as Docker does, and reads the image's job field by field in the
plain block style it is written in, so another shape fails it.

## Decision 4 — The web build

`apps/web/next.config.mjs` sets `output: "standalone"`: `next build`
also writes the server and only the files it loads, and the image runs
`node apps/web/server.js`. The build stage installs from the lockfile,
refuses to go on if `.env`, `packages/database/.env`,
`packages/database/prisma/.env` or any `apps/web/.env*` exists (the
ignore file already leaves `.env` and `.env.*` out at any depth, and
`next build` copies `apps/web`'s `.env` and `.env.production` into the
standalone tree), and lets `prisma generate` pick its engine by the
base's OpenSSL. The generator is unchanged (`native`). The build
requires `libquery_engine-debian-openssl-3.0.x.so.node` and refuses a
`1.1.x` one, which could not load, saying why. That name is amd64's
(read from Prisma's engine names, not built elsewhere), so the image is
built for `linux/amd64` alone, and another platform's build refuses.
`next build` runs under `env -u NODE_ENV`, so it fixes `production` and
sends HSTS (ADR-0174 Decision 8). No setting is given to the build.

## Decision 5 — The web runtime

The runtime stage installs `ca-certificates` alone, from Debian, and
requires its bundle to exist. It sets `NODE_ENV=production`,
`NEXT_TELEMETRY_DISABLED=1`, `HOSTNAME=0.0.0.0` (Docker sets the
container's id there, which
`server.js` would bind), `PORT=3000`, and `SSL_CERT_FILE` and
`SSL_CERT_DIR` to Debian's own store, so Prisma's engine never sets
them from a thread of its own (ADR-0155). They name the store the
engine would find itself, so they add no authority. It copies the
standalone tree and `.next/static`; `apps/web` has no `public/`. It runs
as `1000:1000`, the base's `node` user.

The entrypoint is
`["/usr/bin/env", "-u", "NEXT_PHASE", "node", "apps/web/server.js"]`: a
`NEXT_PHASE` naming the build never reaches Next.js, so the start check
runs (ADR-0151). **A deployment must not replace the entrypoint**: a
command that starts `server.js` directly brings back the start the
start check does not see, which readiness then reports (ADR-0154).

## Decision 6 — What CI proves, and what is RD-11's

The `web-image` job runs every container with `--network none
--read-only --cap-drop ALL --security-opt no-new-privileges`:

1. no settings: exit 1, `The web app cannot start in production` and
   `SESSION_SECRET: Required`;
2. the same with `NEXT_PHASE=phase-production-build`: exit 1;
3. the image's `User` is `1000:1000`, its entrypoint Decision 5's, and
   no name in its `Env` contains `proxy`;
4. sixteen stand-in settings from a file under `$RUNNER_TEMP` written
   under `umask 077`, the secrets, the MFA key and the database
   password from `openssl rand -hex 32`, the database on port 1 of
   loopback, `APP_BASE_URL` `https://app.rd10.test` and names under
   `.test`: liveness `200` with HSTS and no `X-Powered-By`; `/login`
   `200` with a nonce in its policy; readiness `401` without the token
   and `503` with it, its log naming `P1001` for the database (Prisma's
   OpenSSL 3 engine loaded and asked) and never `UNEXPECTED` for it;
   `id -u`
   `1000`; the logout redirect's `Location` printed as data;
5. an inventory: `dpkg-query -W`, `node --version`, the image's size.

The job waits for the server in a loop in the workflow, at most 30
tries a second apart, under the step's `timeout-minutes`; the two
refusals run under 2 minutes each; nothing in the image or the code
waits. The last step prints the server's log and removes it, whatever
happened. **RD-11's**: readiness `ready` against live
PostgreSQL and the emulators, migrations, Google's names redirected
with a test authority, sign-up to storage, and the production policy in
a browser.

## Decision 7 — Route handlers redirect to a path

A route handler redirects to a path, never to an address built from
`request.url`, which behind a proxy names the server's bind address: one
helper answers `303` with a relative `Location`, and refuses a path that
starts `//` or `/\`, which a browser would read as another host. A
guard test holds that no route file passes `request.url` to a redirect.
**Built in RD-10b.**

## Decision 8 — No scanner in part 1; an inventory

No image or dependency scanner runs in CI: each downloads a binary and
a database that changes daily, from outside `node` and `debian`. CI
prints each image's packages and Node.js version instead. Choosing a
scanner and an SBOM format is part 2's, with the deployment.
`pnpm audit --prod` on 2026-11-25 found 22 advisories, three critical in
`next` 15.5.22; they are recorded in `TODO.md`, "Open in RD-10".

## What was measured

Here, on the pinned base, with a private Docker daemon: `docker buildx
build --check` found no warning. Debian's mirror is refused by this
sandbox and the build's downloads need its proxy authority, so a
throwaway copy of the Dockerfile was built, outside the repository,
that differs only by a secret mount of that authority on the two
install steps and by leaving out the runtime's `apt-get` line. Its
build stage passed every check: one engine,
`libquery_engine-debian-openssl-3.0.x.so.node`, beside `libssl.so.3`;
`next build` took 60 s. Its image, 467 MB without `ca-certificates`,
passed every step of Decision 6 with the job's own scripts: readiness
logged `P1001` for the database and `STORAGE_CREDENTIAL_UNAVAILABLE`
for storage, the read-only root needed no `--tmpfs`, and the logout
answered `303` with `Location: http://0.0.0.0:3000/login`. Started with
`NEXT_PHASE` and the entrypoint replaced, it started and reported
Ready. A production
build of the repository on this machine refused with no settings, and
with `NEXT_PHASE` under `env -u`, with exit 1, and with stand-in
settings sent HSTS and no `X-Powered-By` from liveness and a nonce from
`/login`.

After review, the throwaway copy was made again from the Dockerfile as
committed, by the same two differences, and built with `--platform
linux/amd64`: the `.env` refusal, `apps/web` included, and the engine
check passed, the image held one engine and no `.env` file, and every
step of Decision 6 passed again with the job's own scripts. The two
refusals' shell, run under `dash` on stand-in trees, refused an
`apps/web/.env.production`, a missing engine, a `1.1.x` one beside the
`3.0.x` and an arm64-named one alone.

**Not measured here**: the runtime's `apt-get` line and the image as
committed. The first full build is CI's.

## Consequences

- A pull request shows 12 checks, and the `web-image` job adds a few
  minutes of runner time per event.
- `apps/web`'s `start` script, `next start`, stays: with standalone
  output Next.js 15.5.22 only warns that it "does not work" (read in
  its source, not run). Nothing runs it; the browser test runs
  `next dev`.
- The image sets no setting of the app: whoever runs it gives them all.
- A deployment that replaces the entrypoint, or runs the image without
  a read-only root and a non-root user, loses what this ADR proves.
- For the product owner, nothing to decide; told: CI takes longer, and
  Docker Hub's anonymous pull limit may one day need an account or a
  mirror.
