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

## 4. Run the worker (optional)

```bash
pnpm --filter @app/worker start
```

The Phase 0 worker validates configuration, constructs the configured provider,
runs an offline self-check, logs readiness, and exits.

## 4a. Run the development pipeline (optional)

A video started on a development machine becomes a published one only when
you run the pipeline, on the test provider (ADR-0108). Export the variables of
`.env.local` in your shell, with `VIDEO_PROVIDER=fake` and the same
`SHARED_STORAGE_DIR` as the web app (section 3b), have FFmpeg on the `PATH`,
and run:

```bash
pnpm --filter @app/worker pipeline \
  --provider-folder /absolute/path/to/Real-Estate-Listing-Concept-Video/.dev-provider
```

`--provider-folder` is where the test provider keeps the clips it makes. Use
the same folder every time: a later run collects a clip from it. It runs every
step once per cycle until a whole cycle changes nothing, printing one line per
cycle, counts only:

```text
cycle 1: launch 1, submission 2, provider output 2, clips checked 2, scenes delivered (F) 2, …
cycle 2: nothing changed
nothing more to do now after 2 cycles; in all: launch 1, submission 2, …
```

Here one video was made in the first cycle and published.

It never waits. Work handed back for later waits for your next run: for
example, when a job fails because its clips are unusable, its second clip is
settled at least five minutes later. `--limit` (1 to 25, 10 if omitted) is how many items each step takes per
pass, and `--max-cycles` (1 to 1000, 50 if omitted) bounds one run. Exit code
0 means nothing more to do now, 1 that it stopped or a step reported a
failure, 2 that it was refused before any step ran: in production, without
the test provider or the shared folder, or on a database holding attempts of
another provider, which a development database never does.

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
`sudo apt-get install ffmpeg`. The `database` job installs them.

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

## Notes

- `.env.local` and all `.env*` files (except `.env.example`) are git-ignored.
- `next-env.d.ts` is generated by Next.js and is git-ignored; it is recreated
  by `pnpm dev` / `pnpm build`.
