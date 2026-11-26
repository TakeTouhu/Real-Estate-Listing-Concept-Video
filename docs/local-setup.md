# Local Setup

## Prerequisites

- Node.js 22 (`nvm use` reads `.nvmrc`)
- pnpm 10 via Corepack: `corepack enable`

## 1. Install

```bash
pnpm install
```

## 2. Configure environment

Copy the example file and fill in local values:

```bash
cp .env.example .env.local
```

Generate strong local values for the interim auth secrets:

```bash
# SESSION_SECRET and HEALTHCHECK_API_TOKEN (32-byte hex each)
openssl rand -hex 32
openssl rand -hex 32
```

`MFA_SECRET_KEY` (ADR-0065) seals authenticator secrets at rest. Set it with
another `openssl rand -hex 32`. MFA is mandatory for an organization's `OWNER`
(MFA-3), so without the key you cannot sign in once you have created an
organization: the set-up page says MFA is not available, and the readiness
probe reports `degraded`. Keep it once set: a different key cannot open MFA
secrets sealed under the old one.

The readiness probe also reports `degraded` while the database or the object
storage does not answer (RD-2b, ADR-0152), so it reads `ready` only with
PostgreSQL running.

`SESSION_SECRET` also keys the abuse limits (ADR-0170). Their
`RATE_LIMIT_*` settings take their defaults when unset, and
`FORWARDED_FOR_TRUSTED_ENTRIES` stays unset on a development machine, so
nothing is counted by client address, sign-up included; `.env.example`
lists them. The browser test refuses each of them from the shell.

Set `DATABASE_URL` to a local PostgreSQL instance (Phase 1). Keep
`VIDEO_PROVIDER=fake` unless you are deliberately exercising the real provider.

Environment variables are validated at load time by the Zod schema in
`packages/shared/src/env.ts`; invalid or missing values fail fast with a
readable message.

## 2b. Database (Phase 1)

With `DATABASE_URL` pointing at a running PostgreSQL database:

```bash
pnpm --filter @app/database run db:generate       # generate the Prisma client
pnpm --filter @app/database run db:migrate          # apply committed migrations
# or, to create/apply a new migration during development:
pnpm --filter @app/database run db:migrate:dev
```

The Prisma client is also generated automatically on `pnpm install`. The
required checks (`pnpm check`) do not need a database.

## 3. Run the web app

```bash
pnpm dev
```

Then:

- Open http://localhost:3000 → redirected to `/login`.
- Sign in with the value you set for `HEALTHCHECK_API_TOKEN`.
- The dashboard shows liveness and readiness (including the active video
  provider adapter).

Check the endpoints directly:

```bash
curl http://localhost:3000/api/health
curl -H "Authorization: Bearer $HEALTHCHECK_API_TOKEN" \
     http://localhost:3000/api/health/ready
```

## 3b. Keep stored objects in a folder (optional)

By default the web app keeps uploaded photos in its own memory, and a restart
loses them. To keep them on disk instead, set `SHARED_STORAGE_DIR` in
`.env.local` to an absolute folder (ADR-0085), for example:

```bash
SHARED_STORAGE_DIR=/absolute/path/to/Real-Estate-Listing-Concept-Video/.dev-storage
```

The folder is created on first use, readable by your user alone; `.dev-storage/`
is git-ignored. The path must be absolute, because the web app and the worker
run from different folders, and the setting is refused in production. The
development pipeline (section 4a) reads the same folder. Delete the folder to
start over.

### Or in the Cloud Storage emulator

The web app can keep its objects in the Cloud Storage emulator instead, as
it keeps them in Google's own store in production (ADR-0159). Start the
emulator (section 5, *Cloud Storage emulator tests*), make a bucket in it,
and name both in `.env.local`, without `SHARED_STORAGE_DIR`:

```bash
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"name":"vtavision-dev"}' http://127.0.0.1:4443/storage/v1/b
```

```bash
GOOGLE_CLOUD_STORAGE_BUCKET=vtavision-dev
GOOGLE_CLOUD_STORAGE_ENDPOINT=http://127.0.0.1:4443
```

Readiness then reads `adapter=gcs-emulator`. Outside production a bucket
needs the endpoint, and an endpoint at Google's own domain is refused, so
development never uses Google's own store or its token. The development
pipeline reads the same bucket when given the same two settings (section
4a). The emulator keeps its objects in memory until it stops, while the
database keeps its rows: keep it running between the web app and the
pipeline. After a restart, make the bucket again: until then a run that
finds a job waiting to send its photo ends with exit 1, and the job waits
with its Unit reserved. Once it is made, a waiting job whose photo is gone
fails, and its Unit is given back. The browser test
keeps its own folder, and refuses to start while either setting is in its
environment.

## 3c. Sign up and verify your email address

A new account sees only the verify page until it opens the link mailed to its
address (ADR-0129). In development the web app writes each email to a folder
instead of sending it (ADR-0126); it sends through SMTP only when `SMTP_HOST`
is set (ADR-0168), never beside the folder. Set both in `.env.local`:

```bash
EMAIL_OUTBOX_DIR=/absolute/path/to/Real-Estate-Listing-Concept-Video/.dev-outbox
APP_BASE_URL=http://localhost:3000
```

`APP_BASE_URL` is the address the links start with; use the one you open the
web app at, exactly: once it is set, a checked form posted from any other
origin (`http://127.0.0.1:3000`, another port) is refused with `403`
(ADR-0174).
Unset, outside production, the host you opened is accepted.

After signing up, open the newest file in the folder, copy the
link from its `text` and open it in the browser, then press **Verify email
address**. The link works once, for 24 hours; the verify page sends a new one.
`.dev-outbox/` is git-ignored, and the folder is readable by your user alone.

A forgotten password is reset the same way: **Forgot your password?** on the
sign-in page mails a link to the same folder (ADR-0133). It works once, for 1
hour, and choosing a new password signs the account out everywhere. Without
both settings the reset page still says a link was sent, and nothing arrives.

Without both settings no email is sent: the verify page says the email could
not be sent, and the account cannot be verified. Accounts made before AT-3b
are unverified too, and verify the same way at their next sign-in, except one
whose address no email can reach (`owner@localhost`, say), which sign-up
accepted before AT-3b: make it again.

## 4. Run the worker (optional)

```bash
pnpm --filter @app/worker start
```

The Phase 0 worker validates configuration, constructs the configured provider,
runs an offline self-check, logs readiness, and exits.

## 4a. Run the development pipeline (optional)

A started video becomes a published one only when you run the pipeline, on
the test provider (ADR-0108). Until GS-10 adds a way for a customer to start
a video, only the tests start one, so on a fresh database the pipeline finds
nothing to do. Export the variables of `.env.local` in your shell, with
`VIDEO_PROVIDER=fake` and the same store as the web app (section 3b): the
same `SHARED_STORAGE_DIR`, or the same `GOOGLE_CLOUD_STORAGE_BUCKET` and
`GOOGLE_CLOUD_STORAGE_ENDPOINT` with the emulator running. Have FFmpeg on
the `PATH`, and run:

```bash
pnpm --filter @app/worker pipeline \
  --provider-folder /absolute/path/to/Real-Estate-Listing-Concept-Video/.dev-provider
```

`--provider-folder` is where the test provider keeps the clips it makes: a
folder on disk, whichever store the pipeline uses. Use the same folder every
time: a later run collects a clip from it. It runs every
step once per cycle until cycles that change nothing have read all the waiting
work, printing one line per cycle, counts only:

```text
cycle 1: launch 1, submission 2, provider output 2, clips checked 2, scenes delivered (F) 2, …
cycle 2: nothing changed
nothing more to do now after 2 cycles; in all: launch 1, submission 2, …
```

Here one video was made in the first cycle and published.

It never waits. Work handed back for later waits for your next run: for
example, when a job fails because its clips are unusable, its second clip is
settled at least five minutes later. `--limit` (1 to 25, 10 if omitted) is how
many items each step takes per pass, and `--max-cycles` (1 to 1000, 50 if
omitted) bounds one run. Exit code 0 means nothing more to do now, 1 that it
stopped or a step reported a failure (`(1 failed)` after a step's count), 2
that it was refused before any step ran: in production, without the test
provider, without a store or with both, with a bucket and no endpoint or an
endpoint and no bucket, with an endpoint at Google's own domain, when
`DATABASE_URL` does not name a database on
this machine (`localhost`, `127.0.0.1` or `[::1]`), or on a database holding
attempts of another provider, which a development database never does. Do not
point it at a shared database through a tunnel: it acts on every
organization's rows.

## 4b. Give an organization its contract's plan (optional)

An organization has no plan, and its Units page says so, until an operator gives
it the plan of its executed contract (ADR-0066). With `DATABASE_URL` set:

```bash
pnpm --filter @app/ops provision-subscription \
  --organization <organization id> --plan premium \
  --starts 2026-04-01T00:00:00+09:00 --contract VT-2026-001 \
  --operator "Your name" --reason "Signed order 12"
```

Pass the options straight after the script name, without a `--` separator:
the command takes no positional arguments. Every option is required. The plan is always invoice-paid (`SALES_ASSISTED`).
Running it again with the same plan, start and contract writes nothing; anything
else is refused. Exit code 0 means the organization has this plan, 1 refused, 2
unusable arguments.

## 4c. List invoice-paid Unit purchases for invoicing (optional)

An operator lists the purchases approved in a window, so VTaVision can invoice
them (ADR-0069). With `DATABASE_URL` set:

```bash
pnpm --filter @app/ops export-unit-purchases \
  --from 2026-10-01T00:00:00+09:00 --to 2026-11-01T00:00:00+09:00 \
  --out unit-purchases-2026-10.csv \
  --operator "Your name" --reason "October invoices"
```

`--from` is included and `--to` excluded, so consecutive months neither overlap
nor leave a gap; `--to` must be at least ten minutes ago, so that no purchase
approved before it is still being recorded. `--out` must be a new file:
the command never overwrites one. Each organization listed is audited with the
operator and the reason. Exit code 0 means the file was written, 1 refused, 2
unusable arguments.

## 4d. Cancel a mistaken Unit purchase (optional)

An operator cancels a purchase made by mistake (ADR-0070). With `DATABASE_URL`
set, first show it:

```bash
pnpm --filter @app/ops cancel-unit-purchase \
  --purchase upur_... --fault customer \
  --operator "Your name" --reason "Bought by mistake"
```

`--fault` says whose mistake it was: `vtavision` or `customer`. This writes
nothing: it shows the purchase, how many of its Units were delivered, are still
generating and are unused, and what cancelling would do or why it would be
refused. Run the same command again with `--confirm` to cancel it.
VTaVision's own mistake is cancelled whenever it is found: its unused Units
are withdrawn, the used ones stay used, and it is not invoiced. The customer's
is cancelled only within 10 hours of its approval with none of its Units used,
and otherwise refused. A cancellation cannot be undone. Exit code 0 means
shown, cancelled or already cancelled, 1 refused, 2 unusable arguments.

## 4e. Render the AI disclosure images again (rarely)

```bash
pnpm --filter @app/storage render-disclosure-layers --out /tmp/disclosure-layers
```

Renders the six disclosure images from the bundled font, under its own font
configuration, into the directory given, and says for each whether it is the
committed image in `assets/disclosure/` (exit code 0 if all are, 1 if any
differs, 2 for unusable arguments). It never writes over the committed images:
a different look is a new layer version (ADR-0071), and the committed images
are what ships.

## 5. Run the checks

```bash
pnpm check   # typecheck + lint + test + build — no database required
```

Run `pnpm test` without `APP_BASE_URL` in the shell: eight route test files
read the process's environment and post from an origin of their own, which
the origin check then refuses (ADR-0174).

### Database integration tests

`pnpm check` stays offline. The live-PostgreSQL suites are opt-in and need a
**disposable** database — never a production one:

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/revt_test?schema=public"
pnpm --filter @app/database run db:migrate   # apply migrations to the empty DB
pnpm test:db                                 # vitest.integration.config.ts
```

CI runs the same sequence in the `database` job against a PostgreSQL 16 service
container, and additionally verifies that the committed migrations have no drift
against the schema.

The development pipeline's suite makes a real video, so `pnpm test:db` also
needs `ffmpeg` and `ffprobe` on the `PATH` (ADR-0107); on Ubuntu,
`sudo apt-get install ffmpeg`. The `database` job installs them. With
`GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT` naming the emulator (section 5, *Cloud
Storage emulator tests*), that suite runs on the emulator too, as the
`database` job runs it; without it, on the folder alone (ADR-0162).

### Migration checks

The `database` job also runs three scripts (ADR-0191; the third since
PT-8b1). The append-only
check needs no database: it compares a parent commit's
`packages/database/prisma` with your tree's, here `origin/main`'s.

```bash
parent="$(mktemp -d)"
git archive "$(git rev-parse origin/main)" packages/database/prisma | tar -x -C "$parent"
bash tests/migrations/append-only.sh "$parent/packages/database/prisma" packages/database/prisma
```

A fresh folder each time keeps an older extraction from showing up as a
folder "in the parent but not in the head".

It names each changed, deleted or renamed migration, and each new name
that sorts too early or breaks the naming rule, then exits 1.

The checksum check reads a **disposable** database that the migrations
were just applied to, the one `DATABASE_URL` names for Prisma. Set
`PGUSER` and `PGDATABASE` to the user and database `DATABASE_URL`
names; the example below assumes `revt` and `revt_test`. psql reaches
it through libpq's own variables, so no address goes on the
command line; a password, if the database needs one, belongs in
`~/.pgpass` rather than the shell. psql runs with `-w`, so it fails
rather than prompting when it finds no password:

```bash
export PGHOST=localhost PGUSER=revt PGDATABASE=revt_test
pnpm --filter @app/database run db:migrate
bash tests/migrations/checksums.sh packages/database/prisma/migrations
```

It names each applied migration whose checksum is not its
`migration.sql`'s SHA-256, and each name applied but not committed or
committed but not applied, then exits 1. Never set
`PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`, and never run `migrate reset` or
`db push`, against a database anyone else uses.

The seeded upgrade (PT-8b1) reads that same freshly migrated database
and creates a second one, here `revt_upgrade`, which must not exist yet.
Prisma needs that second database's address as `UPGRADE_DATABASE_URL`;
the script refuses one whose path names another database, hands it to
each deploy as `DATABASE_URL` and never prints it. Keep it in your
shell's environment or a sourced file, never on the command line. It
needs `pg_dump` of the server's major version or newer:

```bash
export PGHOST=localhost PGUSER=revt PGDATABASE=revt_test
export UPGRADE_DATABASE_URL  # set beforehand: revt_test's address, with revt_upgrade as the database
bash tests/migrations/upgrade.sh packages/database/prisma tests/migrations/seed revt_upgrade
dropdb -w revt_upgrade  # before the next run
```

It fails on the first deploy, seed or check that fails, printing that
command's own error; a seeded row lost or changed is named by table, and
a schema difference is printed as a diff.

### Media tests

The suites that run the real `ffmpeg` and `ffprobe` are opt-in too (ADR-0072).
They need FFmpeg on the `PATH`; on Ubuntu, `sudo apt-get install ffmpeg`.

```bash
pnpm test:media   # vitest.media.config.ts
```

They encode synthetic clips into each composition size and lay the disclosure
images over them, in temporary directories they remove. Without FFmpeg the
run fails: the suites cannot make their inputs, so Vitest marks each file
failed and reports its tests as skipped. CI runs them in the `media` job on
Ubuntu 24.04, whose FFmpeg 6.1.1 their tolerances were measured with.
Since RD-10c (ADR-0176), CI's `worker-image` job also runs them on the
worker image's Debian 13 FFmpeg (section 7).

### Cloud Storage emulator tests

The suites for the Google Cloud Storage adapter (ADR-0156) speak to the
Cloud Storage emulator, never to Google. Start it, with Docker or with Go:

```bash
docker run --rm -p 4443:4443 -e FAKE_GCS_SCHEME=http -e FAKE_GCS_BACKEND=memory \
  fsouza/fake-gcs-server:1.56.1
# or: go install github.com/fsouza/fake-gcs-server@v1.56.1
#     fake-gcs-server -scheme http -host 127.0.0.1 -port 4443 -backend memory
```

Then name it and run them:

```bash
export GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT=http://127.0.0.1:4443
pnpm test:gcs   # vitest.gcs.config.ts
```

Without that variable the run fails, and an origin that is not on this
machine is refused. Each test makes a bucket of its own, held in the
emulator's memory until it stops. The web app's own storage, as its settings
choose it, is tested there too (ADR-0159). CI runs them in the `storage`
job.

### ClamAV scanner tests

The suites for the ClamAV scanner (ADR-0163) speak to a ClamAV daemon on
this machine. Start one with Docker, with its signature updater off so it
sends no request, published on `127.0.0.1` alone, since the daemon asks
no credential:

```bash
docker run --rm -p 127.0.0.1:3310:3310 \
  -e CLAMAV_NO_FRESHCLAMD=true -e CLAMAV_NO_MILTERD=true clamav/clamav:1.5.5
```

It answers once its signatures are loaded, about 15 seconds in, and needs
about 1 GiB. Then name its port and run them:

```bash
export CLAMAV_TEST_PORT=3310
pnpm test:clamav   # vitest.clamav.config.ts
```

Without that variable the run fails. CI runs them in the `storage` job.

The same daemon can scan the web app's uploads (ADR-0164): set
`CLAMAV_HOST=127.0.0.1` in `.env.local`, and `CLAMAV_PORT` if it is not
3310. Unset, the web app uses the test scanner. The browser test refuses
both settings, as it runs no daemon.

### SMTP email sender tests

The suite for the SMTP email sender (ADR-0166) speaks to Mailpit, a mail
catcher, on this machine. Start it with Docker as CI does: it makes its
own certificate for `mail.rd6.test`, requires STARTTLS, accepts any login
and relays nothing. Publish it on `127.0.0.1` alone:

```bash
docker run --rm -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 \
  -e MP_DISABLE_VERSION_CHECK=true \
  -e MP_SMTP_TLS_CERT=sans:mail.rd6.test \
  -e MP_SMTP_TLS_KEY=sans:mail.rd6.test \
  -e MP_SMTP_REQUIRE_STARTTLS=true -e MP_SMTP_AUTH_ACCEPT_ANY=true \
  axllent/mailpit:v1.33.1
```

Then name its two ports and run it:

```bash
export MAILPIT_TEST_SMTP_PORT=1025 MAILPIT_TEST_API_PORT=8025
pnpm test:smtp   # vitest.smtp.config.ts
```

Without those variables the run fails. CI runs it in the `storage` job.
The web app sends through SMTP when `SMTP_HOST` and its six companions
are set (ADR-0168), but only to a DNS name whose certificate Node.js
trusts, so it is not pointed at this Mailpit; the outbox serves
development, and the browser test refuses every SMTP setting.

### Browser tests

The browser test (ADR-0121) drives the web app in Playwright's Chromium. It
starts the web app itself (`next dev` on port 3210, so stop anything already
there) with its own throwaway settings, and needs a **disposable**, migrated
database on this machine and FFmpeg on the `PATH`. Use a database of its own:
the test adds an owner, an organization and a plan on every run.

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/revt_e2e?schema=public"
pnpm --filter @app/database run db:migrate   # apply migrations to the empty DB
pnpm exec playwright install chromium        # once, if Chromium is not installed
pnpm test:e2e                                # playwright.config.ts
```

It keeps the web app's photos under `.e2e/` and its results under
`test-results/` and `playwright-report/`, all git-ignored; delete them to
start over. Add `--trace on` to record a trace; a trace records every request,
signed links and the session cookie included, so keep it on your machine and
never share or upload it. CI runs it in the `e2e` job, which keeps no trace.

## 6. Build and run the web app's image (optional)

The production image (ADR-0175) is built from the repository root, as
CI's `web-image` job builds it. It needs Docker with BuildKit and access
to Docker Hub, Debian's package mirror and the npm registry; nothing is
given to the build, and nothing is pushed.

```bash
docker buildx build --load --platform linux/amd64 \
  -f apps/web/Dockerfile -t vtavision-web:local .
```

The image is built for `linux/amd64`, as CI builds it: the build requires
Prisma's `debian-openssl-3.0.x` engine, which is amd64's, and refuses to
go on with another. On an arm64 machine Docker must emulate amd64 for
it (inferred, not measured here).

The build reads `apps/web/Dockerfile.dockerignore`, not a root
`.dockerignore`: it leaves every `.env` file, `node_modules`, `.next`
and the test output out of the context, and the build refuses to go on
if a `.env` reaches the tree where Prisma reads one, or `apps/web`, whose
`.env` and `.env.production` `next build` would copy into the image. A
production start
of the image without settings must refuse, as in CI:

```bash
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges vtavision-web:local   # exit code 1
```

To see it serve, give it the sixteen settings CI's job gives it, every
one a stand-in, in a file only you can read (`--env-file`), and keep
`--network none`: a production server with a bucket asks Google's
metadata server for a token at its first storage request, readiness's
included. Ask it from inside, as the job does, and
never give a local run real credentials:

```bash
docker exec <container> node -e \
  "fetch('http://127.0.0.1:3000/api/health').then((r) => console.log(r.status))"
```

`pnpm build` now also writes `apps/web/.next/standalone`, which the
image copies; `pnpm --filter @app/web start` (`next start`) only warns
about it, and nothing runs it.

A production build's page policy ends with `upgrade-insecure-requests`
(ADR-0190), so a browser asks the page's own files over `https`.
Measured with Chromium 153 on `next start` over plain `http`:
`http://localhost` and `http://127.0.0.1` are not upgraded and the page
works, but a non-loopback host name (`app.pt7c4.test`, mapped to the
same server) lost its scripts and styles and did not hydrate. A LAN
address or another hosts-file name is expected to behave the same
*(inference: Chromium exempts only potentially trustworthy hosts;
`*.localhost` names may not)*. Other browsers were not measured. To
work on the app in a browser, use `next dev`
(`pnpm dev`), whose policy has no such directive.

CI's `production-mode` job (ADR-0178) runs the image against stand-ins;
its steps in `.github/workflows/ci.yml` are the procedure, and no script
repeats them. By hand they need Docker with Buildx, `openssl`, `curl`,
`jq`, `sudo` for a hosts line for `app.rd11.test`, and pnpm and Node.js
as in section 1; set `RUNNER_TEMP` to an empty private folder,
`GITHUB_WORKSPACE` to the checkout, and the job's `env:` values
(`REVISION` and the five `*_IMAGE` pins). Its browser step needs
Playwright's Chromium (`pnpm exec playwright install chromium`) and
`runner.env` loaded; `pnpm test:production` means nothing elsewhere.
Never give them a real credential.

## 7. Build and check the worker's image (optional)

The worker's image (ADR-0176) carries Debian 13's FFmpeg and the six
disclosure images, and no worker code. It needs what section 6 needs.
Its `media-test` stage runs the media suites on the image's own FFmpeg,
as CI's `worker-image` job does, with no network:

```bash
docker buildx build --load --platform linux/amd64 \
  -f apps/worker/Dockerfile --target media-test -t vtavision-worker-media:local .
docker run --rm --network none vtavision-worker-media:local
docker buildx build --load --platform linux/amd64 \
  -f apps/worker/Dockerfile -t vtavision-worker:local .
docker run --rm --network none --read-only vtavision-worker:local worker-image-check
docker run --rm --network none --read-only vtavision-worker:local   # exit code 2
```

`worker-image-check` refuses an FFmpeg of another series than `7.1`,
one without `libx264`, an image whose SHA-256 differs from
`apps/worker/image/disclosure-layers.sha256`, or a file the list does
not name. That list must equal `DISCLOSURE_LAYER_ASSETS`, which
`pnpm test` checks. Section 4e never overwrites the committed images:
a new look is a new layer version, which changes
`DISCLOSURE_LAYER_ASSETS`, and the list, the Dockerfile's
`layer-v1-*.png` line and the guard test change with it. The default
command only refuses: the worker has no production runtime until
part 2.

The image copies `apps/worker/image/check.sh` with the mode the
checkout gave it, so build from a checkout that keeps Git's executable
bit (`100755`). On one that drops it (Windows, or a copy or file
system that loses modes), the base's entrypoint hands the check to
`node`, which fails with "Cannot find module" instead of a refusal; the
guard test fails there too.

## 8. Build and check the migration image (optional)

The migration image (ADR-0192) carries the Prisma CLI, its engines,
`schema.prisma` and the migrations, and runs `migrate deploy` by
default. It needs what section 6 needs. CI's `migrate-image` job runs
its checks with no network; two of them, locally:

```bash
docker buildx build --load --platform linux/amd64 \
  -f packages/database/Dockerfile -t vtavision-migrate:local .
docker run --rm --network none --read-only vtavision-migrate:local --version
echo 'DATABASE_URL=postgresql://local@127.0.0.1:1/local' > /tmp/migrate.env
docker run --rm --network none --read-only --env-file /tmp/migrate.env \
  vtavision-migrate:local   # exit code 1, P1001: nothing listens there
```

To apply the migrations to a **disposable** database, give the
container a way to reach it and its `DATABASE_URL` in a file, never on
the command line. Arguments replace the default command, as in
`migrate status --schema /app/prisma/schema.prisma`. Never set
`PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`. The image copies
`packages/database/prisma` from your tree, so it holds what you have
checked out, uncommitted changes included; CI compares it with the
commit.

## Notes

- `.env.local` and all `.env*` files (except `.env.example`) are git-ignored.
- `next-env.d.ts` is generated by Next.js and is git-ignored; it is recreated
  by `pnpm dev` / `pnpm build`.
