# ADR-0192 — Migrations run from their own image, as one job before each deploy

Status: Accepted (PT-8c, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`); the CTO
decided the image, its job and the ninth check the same day. No
customer surface, charge, business rule, route, setting, stored value
or migration changes. ADR-0175 Decision 1 is unchanged: nothing is
pushed, logged in to, cached or put on a timed trigger.

Builds on: ADR-0175 (one pinned base, one job per image), ADR-0178
(`production-mode` applies the migrations from the runner; amended
from PT-8d, Decision 6), ADR-0180 (each image scanned in its own job),
ADR-0191 (migrations are append-only; CI checks the checksums).

## Context

Production has no way to apply migrations. The web image holds no
Prisma CLI; CI's `database` job and `production-mode` apply them from
the runner (`TODO.md`, "Decide how migrations run in production"). The
part 2 plan weighed four ways: the runner with production database
access, the web image, a `--target migrate` stage of the web
Dockerfile, and an image of its own. Measured in the PT-8 research lab
on PostgreSQL 16 with Prisma 5.22.0, not in this milestone: a second
`migrate deploy` while another holds Prisma's advisory lock fails
after 10 s with `P1002`; with `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=1`
it skips the lock; a run killed mid-file leaves its history row
unfinished, and the next run stops with `P3009`.

## Decision 1 — An image of the CLI, the schema and the migrations

`packages/database/Dockerfile` builds on ADR-0175 Decision 2's base. A
build stage installs the workspace from the lockfile, refuses a `.env`
where Prisma reads one, and copies, with `cp -a`, exactly six
`node_modules/.pnpm` folders: `prisma@*`, `@prisma+engines@*`,
`@prisma+engines-version@*`, `@prisma+debug@*`,
`@prisma+fetch-engine@*` and `@prisma+get-platform@*`. Each pattern
must match one folder, or the build refuses: a Prisma upgrade that
renames or duplicates one fails there. One that adds a seventh package
passes the build and leaves a dead link, which the job refuses
(Decision 4). Both of Debian 13's OpenSSL 3
engines, `schema-engine-debian-openssl-3.0.x` and
`libquery_engine-debian-openssl-3.0.x.so.node`, must be there, and no
`openssl-1.1.x` file.

The image adds `ca-certificates` alone, for a verified TLS connection
to the database if one is chosen; `ENV` sets exactly
`CHECKPOINT_DISABLE`, `PRISMA_HIDE_UPDATE_MESSAGE`, `SSL_CERT_FILE` and
`SSL_CERT_DIR`. It copies the six folders, then the schema and the
migrations by two lines, `./prisma/schema.prisma` and
`./prisma/migrations`: one `COPY` of both would put the migrations'
folders beside the schema, and Prisma would find none and pass (the
PT-8 critique, item 4). It runs as `1000:1000`. Not the client, not
the apps, not psql or any PostgreSQL package.

## Decision 2 — `migrate deploy` by default, once per release

`ENTRYPOINT ["node", "/app/node_modules/prisma/build/index.js"]` and
`CMD ["migrate", "deploy", "--schema", "/app/prisma/schema.prisma"]`;
other arguments replace the command (`migrate status --schema …`,
`migrate resolve …`). It reads `DATABASE_URL` from its environment;
the image sets none.

In production it is to run as one job, once per release, before the
web revision takes traffic, and its exit status gates the rollout. The
job resource, its order before the web revision, its task timeout and
its retry count are PT-10's, with the owner's values (T8(k)). No ADR
fixes them, nor any `lock_timeout` or `statement_timeout` (T8(g)).
**The CTO recommends to the owner a retry count of 0:** a retry after
a killed or timed-out run meets `P3009`, not a recovery (measured in
the research lab, above). The job's first run is G1's.

## Decision 3 — Prisma's lock is never turned off

`PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` is never set: with it, two runs
would proceed at once. `BANNED_ENV` refuses it in every Dockerfile,
and `tests/migrations/workflow.test.ts` already refuses it in the
workflow and the migration scripts.

## Decision 4 — Its own job, the ninth check

The `migrate-image` job builds the image as `vtavision-migrate:ci`.
Every check and CLI run of it has no network, a read-only root, no
capability and `no-new-privileges`; the step that prints what it
holds has no network and a read-only root, as in `web-image` and
`worker-image`. It checks: user `1000:1000`; `id
-u` 1000; the entrypoint and command literals; no `proxy` in its
environment; `/app` holding only `node_modules/` and `prisma/`;
`node_modules/` holding only `.pnpm/` and the `prisma` link, and
`.pnpm/` exactly the six packages; every entry root's and none but a
link writable by others; no client, `.prisma` or `apps/`; no dead
link. A failing check prints what it found. It lists every entry under
`/app/prisma` by type and relative path, and every file by SHA-256,
and compares that with the same list of this commit's `schema.prisma`
and `migrations/`: a missing, extra, moved or changed file fails. The
CLI runs with `--network none --read-only --cap-drop ALL
--security-opt no-new-privileges`:
`--version` must print `prisma` 5.22.0 and a schema engine, and
`migrate deploy` against `127.0.0.1:1`, with no password, must exit 1
with `P1001` and print neither `binaries.prisma.sh` nor `ECONNREFUSED`.
It prints what the image holds, then runs ADR-0180's three scan steps
word for word. Only stand-in values exist in the job. The stand-in
address goes in an env file, as `web-image` writes its settings to
one, because the image-job guard admits no job `env` but `REVISION`,
`SYFT_PIN` and `GRYPE_PIN`; it has no password and is never printed.

The CTO's PT-8 decisions asked first to fit this into an existing
image job within the guards. It does not fit: the guard holds
every image job to one set of the three scan steps, for one tag, after
every functional step, with only guarded steps after them (ADR-0180,
"Each image is scanned in its own job"); scanning a second image in
`web-image` or `worker-image` would need a looser guard. ADR-0175
Decision 1 already says "one job per image, added by the pull request
that adds the image".

ADR-0180 rejected "A ninth job" because "It would rebuild or transfer
each image, and add a check". This job rebuilds and transfers nothing:
it builds and scans its own image. It does add a check: a pull request
now shows 9. Its Actions minutes are the owner's (T14). Branch
protection naming the check, if checks are listed by name, and
"require branches to be up to date" are T14 items too.

## Decision 5 — Never pushed

The image is built and checked in CI and pushed nowhere; ADR-0175
Decision 1 stands. Artifact Registry and the job that runs it are
PT-10's.

## Decision 6 — Built in PT-8d

PT-8d has no ADR of its own; this is its contract. `production-mode`
runs this image against its PostgreSQL instead of the runner's
`db:migrate`, which **amends ADR-0178 Decision 8**. It asserts that the
first run's log holds "`<N>` migrations found in prisma/migrations",
with N the directory count, and "All migrations have been successfully
applied."

## Considered and not done

- **The runner, with production database access.** The CTO's default 3
  says migrations are not run from CI with production database
  access; it would also need G2's federation and an amendment of
  ADR-0175.
- **The web image.** It holds no CLI, PT-10 bans overriding its
  entrypoint, and at web startup every instance of a scale-out would
  contend for the lock, the second failing after 10 s with `P1002`
  (measured in the research lab, Context).
- **A `--target migrate` stage of `apps/web/Dockerfile`.** The guard
  checks `USER` in the final stage alone, and the web job scans one
  tag, so the stage would ship unscanned; it would also tie the two
  images' releases together.

## What holds it

- **Unit:** `tests/container-images.test.ts` runs its per-Dockerfile
  rules on the new file, holds the job in `IMAGE_JOBS` (one build,
  scan last, nothing pushed), bans the lock's name in `BANNED_ENV`, and
  holds the final `ENTRYPOINT`, `CMD`, the four `ENV` names, the two
  `COPY` lines, `ca-certificates` alone, no PostgreSQL, the six-folder
  copy, the engine check, the install from the lockfile alone, the
  ignore file's exact lines, the files check's key lines, the path and
  hash comparison word for word and the offline run's key lines.
- **CI:** the job on every pull request and push to `main`.

## What was measured

Local measurements, on a rehearsal copy of the Dockerfile: its two
`FROM` lines named the same base by a local tag, the build stage added
the agent's CA and `NODE_EXTRA_CA_CERTS`, the build ran with the host
network and proxy settings given as build arguments, and the runtime
stage had no `apt-get` line, since no Debian mirror was reachable from
the sandbox. So the image measured lacked `ca-certificates` and
`openssl`; nothing measured used TLS. Prisma 5.22.0, PostgreSQL 16.15.

- The build passed; each of the six patterns matched one folder; both
  engines were listed. `/app/node_modules` was 62 MB, `/app/prisma`
  460 KB.
- Each check step's run text, executed with `bash -e`, exited 0.
  `--version` printed `prisma : 5.22.0` and `Schema Engine :
  schema-engine-cli 6051…`; `migrate deploy` exited 1 with `P1001`.
  `--read-only` worked for every run.
- The comparison exited 1 on four broken variants: one flattened
  `COPY`, a missing `migration.sql`, an appended line and an extra
  file. The flattened image, against an empty database, printed "No
  migration found in prisma/migrations" and exited 0.
- On a throwaway PostgreSQL with no password, through the host network:
  the first run printed "36 migrations found in prisma/migrations" and
  "All migrations have been successfully applied."; the second "No
  pending migrations to apply."; `migrate status` exited 0, and
  `checksums.sh` passed all 36.
- Syft and Grype were not run: the sandbox could not fetch their
  layers. The job's first CI run scans the image.
- The committed file as written (pinned `FROM`, the runtime `apt-get`
  line, no proxy) was never built end to end outside CI: run verbatim
  here, it stopped at `corepack enable` with no route out. The job's
  first run is its first build, `apt-get` line included.
- After review, the files check also failed, printing the offending
  entry, on images with an extra workspace folder, an extra `.pnpm`
  package, a client package or a dead link; the offline run printed
  the CLI's own error for a missing engine.

## Consequences

- A pull request shows 9 checks; the merge rule is still "every check
  green".
- A Prisma upgrade must keep the six folders, or change the Dockerfile,
  the job's files check and the guard in the same pull request. It
  also changes the job's `5\.22\.0` version check and that line in the
  guard.
- Nothing runs the image outside its job until PT-8d.
