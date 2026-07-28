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

## Unit tests

Unit tests live next to their source as `*.test.ts` and run via the root
`vitest.config.ts` with `pnpm test`.

## Not present yet

End-to-end Playwright suites (Phase 3B onward, once there is a review UI worth
driving through a browser).
