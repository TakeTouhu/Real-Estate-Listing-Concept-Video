# API Changes — PT-8b1

CI upgrades a seeded database to the head's migrations (ADR-0191
Decision 4, "Built in PT-8b"; PT-8b has no ADR of its own).
Production readiness, part 2. **No route, request, response, stored
value, setting, image or migration changes.** What changes is CI's
`database` job, one script, two SQL files and their tests.

## The `database` job, before and after

Before, after the append-only check it ran `pnpm run test:db`. After,
one step stands between them:

| Step | What it refuses |
| --- | --- |
| **Upgrade a seeded database to the head's migrations** | a seed that fails at its level; a head migration that cannot carry the seeded rows; a seeded row lost or a seeded value changed (`check.sql`); a checksum other than the committed file's; an upgraded schema that differs from the fresh one |

The job gains one throwaway variable, `UPGRADE_DATABASE_URL`, beside
`SHADOW_DATABASE_URL`. The step has `timeout-minutes: 3`. Still 8
checks.

## The script and the seed

`tests/migrations/upgrade.sh <prisma dir> <seed dir> <upgrade
database>`:

1. runs `checksums.sh` on `PGDATABASE`, the freshly migrated database;
2. creates `<upgrade database>` with psql, as the shadow database is
   created; it fails if that database exists;
3. for each `<seed dir>/<14-digit level>.sql`, in byte order, applies
   the head's migrations up to that level from a temporary folder
   holding only those folders, `migration_lock.toml` and
   `schema.prisma`, then runs the seed with `psql -X -w -v
   ON_ERROR_STOP=1 -1 -f`;
4. applies the head's full set, runs `<seed dir>/check.sql`, then
   `checksums.sh` on the upgraded database;
5. compares `pg_dump --schema-only --exclude-table=_prisma_migrations`
   of both databases, with pg_dump's `\restrict` and `\unrestrict`
   lines left out. pg_dump sees CHECK constraints and partial indexes,
   which `migrate diff` does not *(measured in the PT-8 critique, not
   in this milestone)*. It refuses a pg_dump older than the server's
   major version.

psql and pg_dump reach the server only through libpq's variables.
Prisma gets `UPGRADE_DATABASE_URL` as `DATABASE_URL` for each deploy
command alone. Neither address nor password is an argument or printed.

The runner should have pg_dump 16.16 *(inference, not yet observed in
a run)*: the `ubuntu-24.04` image installs PostgreSQL 16.16 from the
PostgreSQL apt repository (`actions/runner-images`, read on
2026-11-26), and pg_dump ships in `postgresql-client-16` with the psql
the job already uses. If it is missing or older, the step fails.

`tests/migrations/seed/00000000000035.sql` seeds 20 tables at the last
migration: `organizations`, `users`, `credentials`,
`user_mfa_factors`, `user_mfa_recovery_codes`, `account_links`,
`sessions`, `memberships`, `member_permission_grants`, `groups`,
`group_members`, `group_permissions`, `invitations`, `audit_logs`,
`organization_subscriptions`, `unit_entitlement_periods`,
`unit_add_on_blocks`, `unit_purchases`, `unit_purchase_cancellations`
and `rate_limit_counters`. It holds every enum value of their enum
columns, `NULL` and a value in every nullable column, rows sharing what
a later uniqueness rule could refuse, and the lengths their CHECKs
bound. Values are fake: `example.com` addresses and hex built from
`5eed35`. `check.sql` compares each table's seeded row count and an MD5
of its seeded columns; allowed changes are listed there with the
migration that makes them (none yet).

The limit, from ADR-0191: data the level's constraints already forbid
cannot be seeded, so a failure that needs it is not caught.

## Tests

- `seed-coverage.test.ts`, offline: every table of `schema.prisma` is
  seeded or on the PT-8b2 list (the media, storyboard and generation
  tables, 21), never both; each seed level names one migration;
  `check.sql` checks exactly the seeded tables; no `DROP`, `TRUNCATE`,
  `ALTER` or `CREATE` in a seed or the check.
- `workflow.test.ts`: the step's place, command and variable, and the
  seed run with `ON_ERROR_STOP` before the head's full deploy.

## Not applicable

- **OpenAPI:** no route, request or response body changes.
- **ER diagram and migration:** no stored value changes.
- **Sequence diagram:** no request flow changes.
