# tests

Cross-cutting suites that do not belong to a single workspace package.

## `tests/integration/*.db.test.ts`

Live-PostgreSQL integration tests. They are **excluded** from the default
`pnpm test` run (see `vitest.config.ts`) so the required checks stay offline and
deterministic, and are run explicitly with:

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/revt_test?schema=public"
pnpm --filter @app/database run db:migrate
pnpm test:db
```

`DATABASE_URL` must point at a disposable database. These suites create and
delete rows under fixture ids and must never run against production data. CI
runs them in the `database` job against a PostgreSQL 16 service container with
throwaway credentials.

The development pipeline's suite runs each case on the shared folder and, when
`GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT` names a Cloud Storage emulator, again in a
fresh bucket there (ADR-0162). The `database` job names one, and in CI a missing
name fails the file; a local run without one runs the folder's cases alone.

## `tests/media/*.media.test.ts`

Suites that run the real `ffmpeg` and `ffprobe` (ADR-0072): the dormant
deliverable composer and media inspector on synthetic clips, and the committed
disclosure images laid over a real encode. They are **excluded** from
`pnpm test` and run explicitly, with FFmpeg on the `PATH`:

```bash
pnpm test:media
```

Every input is generated in the test or committed in `assets/disclosure/`; no
customer or provider media is used. Without FFmpeg the run fails, its tests
reported as skipped. CI runs them in the `media` job on Ubuntu 24.04.

## `tests/storage/*.gcs.test.ts`

Suites that speak to the Cloud Storage emulator (ADR-0156 to ADR-0161):
the Google Cloud Storage adapter storing, reading, streaming and deleting
objects in a bucket of each test's own, the web app's own storage as a
bucket and an endpoint choose it, and the worker's view of a bucket under
its staging sink, composition, media validation and Clean Master seams,
with the proxy variables naming a proxy that is not there. They are
**excluded** from `pnpm test` and run explicitly, with the emulator
running and named:

```bash
export GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT=http://127.0.0.1:4443
pnpm test:gcs
```

Without the variable the run fails: Vitest marks the file failed and its
tests skipped. An origin that is not on this machine is refused, and the
adapter sends no request through a proxy and no token to any store but
Google's, so no suite reaches a real store. The
emulator has no permissions, so what Google answers a caller that may not
read or list is not seen here. Nor does it check a resumable upload's
precondition before its last chunk, or cancel one, so when Google checks
the precondition, and that a cancel cancels, are not seen here either. CI
runs them in the `storage` job beside the emulator's service container.

## `tests/scanner/*.clamav.test.ts`

Suites that speak to a ClamAV daemon (ADR-0163): the ClamAV scanner
passing clean photos and finding EICAR, a ZIP holding it behind a real
JPEG, and that ZIP at the end of a photo as large as an upload may be;
failing a photo past the daemon's limit and a scan no daemon answers; and
an upload through `completeUpload` ending `READY`, `QUARANTINED` and
`FAILED`; and the web app's scanner, built from `CLAMAV_HOST` and
`CLAMAV_PORT`, asking the daemon (ADR-0164). They are **excluded** from
`pnpm test` and run explicitly, with a daemon on this machine and its
port named:

```bash
export CLAMAV_TEST_PORT=3310
pnpm test:clamav
```

Without the variable the run fails: the file fails as it loads, and none
of its tests runs. The host is always `127.0.0.1`. CI runs them in the
`storage` job beside a pinned ClamAV service container.

## `tests/email/*.smtp.test.ts`

Suites that speak to Mailpit, a mail catcher, over SMTP (ADR-0166): the
SMTP email sender delivering one email over STARTTLS, with Mailpit's own
certificate as the only authority trusted, its Japanese subject and body,
an emoji, lines that are or start with a dot, and a body of the longest
length on one line, all arriving intact and as seven-bit text in lines
SMTP allows; and refusing, with nothing arriving, Mailpit's certificate
when it is not trusted, the same certificate under another name, and
TLS from the first byte against a server that speaks STARTTLS. They are
**excluded** from `pnpm test` and run explicitly, with Mailpit on this
machine and its two ports named:

```bash
export MAILPIT_TEST_SMTP_PORT=1025 MAILPIT_TEST_API_PORT=8025
pnpm test:smtp
```

Without either variable the run fails: the file fails as it loads, and
none of its tests runs. The host is always `127.0.0.1`, for SMTP and for
reading back through Mailpit's API. CI runs them in the `storage` job
beside a pinned Mailpit service container.

## `tests/e2e/*.spec.ts`

The browser test (ADR-0121): Playwright's Chromium drives the web app, which
the run starts under `next dev` with the test provider and a shared folder
under `.e2e/`. It is **excluded** from `pnpm test` and run explicitly, with a
disposable, migrated database on this machine and FFmpeg on the `PATH`:

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/revt_e2e?schema=public"
pnpm --filter @app/database run db:migrate
pnpm test:e2e
```

The test goes from sign-up to a Property's photos analyzed from the review
page (GS-13b, ADR-0122). Each test signs up its own owner and organization, so
runs never meet. Its helpers live in `tests/e2e/support/`; their own unit tests
(`*.test.ts`) run with `pnpm test`. CI runs it in the `e2e` job.

## `tests/container-images.test.ts`

A text guard of every container image's recipe it lists (ADR-0175),
run with `pnpm test`. It reads a Dockerfile as Docker does, comment lines
dropped before continued lines are joined, and holds: the first line
`# check=error=true` and no `# syntax=` or `# escape=`; every outside
image in `FROM`, `COPY --from=` or a mount's `from=` pinned by tag and
digest, one digest for all; no `ARG`, `ADD`, `ONBUILD`, `HEALTHCHECK` or
here-document; no `--chown`, `--chmod`, `chown` or `chmod`; no proxy in
any instruction, and no setting of the app, banned name or name that
reads as a secret in `ENV`; a numeric non-root last `USER` in the
image's own stage; every line of each `<Dockerfile>.dockerignore`,
none starting with `!`, and no root `.dockerignore`. For the web image:
standalone output, one `next build`, under `env -u NODE_ENV`;
`pnpm fetch` and an offline install from the lockfile; the `.env`
refusal, `apps/web` included; the OpenSSL 3 engine required alone; and
the runtime stage word for word. It reads the `web-image` job field by
field: `contents: read`, only `actions/checkout` with
`persist-credentials: false`, `if:` only on the last step, the build
word for word with `-f` for each image, and Docker only to build, run,
exec, read logs, remove and inspect. Anywhere in the workflow: no
`docker` outside that job, and no push, secret, token, build argument,
cache, output, schedule or proxy. It builds nothing: CI's `web-image`
job does.

## Unit tests

Unit tests live next to their source as `*.test.ts` and run via the root
`vitest.config.ts` with `pnpm test`.

## Not present yet

End-to-end Playwright suites (Phase 3B onward, once there is a review UI worth
driving through a browser).
