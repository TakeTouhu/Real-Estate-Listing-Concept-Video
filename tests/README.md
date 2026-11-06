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

Each test signs up its own owner and organization, so runs never meet. Its
helpers live in `tests/e2e/support/`; their own unit tests (`*.test.ts`) run
with `pnpm test`. CI runs it in the `e2e` job.

## Unit tests

Unit tests live next to their source as `*.test.ts` and run via the root
`vitest.config.ts` with `pnpm test`.

## Not present yet

End-to-end Playwright suites (Phase 3B onward, once there is a review UI worth
driving through a browser).
