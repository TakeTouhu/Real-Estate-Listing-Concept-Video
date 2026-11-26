# API Changes — PT-8a

Migrations are append-only; CI checks the applied checksums (ADR-0191).
Production readiness, part 2. **No route, request, response, stored
value, setting, image or migration changes.** What changes is CI's
`database` job, two scripts and their tests.

## The `database` job, before and after

Before, its steps applied the migrations to an empty database, checked
the committed schema for drift and ran `pnpm run test:db`, on a bare
checkout of one commit.

After:

| Step | What it refuses |
| --- | --- |
| Checkout, `fetch-depth: 2`, `persist-credentials: false` | nothing; it fetches the first parent and keeps no Git credentials |
| Apply migrations to an empty database | unchanged |
| **Check the applied migrations' checksums** | a finished, not rolled-back `_prisma_migrations` row whose checksum is not the SHA-256 of its `migration.sql`; a row with no folder; a folder with no row; a name applied twice |
| Create shadow database for the drift check | unchanged |
| Verify committed migrations match the schema | unchanged |
| **Check that no applied migration changed** | a first-parent migration folder deleted, renamed, or with other entries or bytes; a changed `migration_lock.toml`; a new name at or before the parent's last in byte order; a new name outside `^[0-9]{14}_[a-z0-9_]+$` or holding `mfa`, `queue`, `delivery`, `recovery` or `phase` |
| Database integration tests | unchanged |

The append-only step fails with a message if the checkout holds no
first parent, and runs with `shell: bash`, so with pipefail. Each new
step has `timeout-minutes: 2`. Both print names and rules only: no
checksum, address or password. The one exception is psql's own
connection error, which names the host or socket, the port and the
database, never a password. Still 8 checks.

## The scripts

- `tests/migrations/append-only.sh <parent prisma dir> <head prisma
  dir>`: no database, no setting. Exit 0, 1 with each fault, or 2 on a
  usage error.
- `tests/migrations/checksums.sh <migrations dir>`: psql through
  libpq's variables (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`
  or a password file), never an address argument, and with `-w`, so it
  never prompts. Exit 0, 1 with each fault, 2 on a usage error, or
  psql's own exit code if it cannot connect or query.

`docs/local-setup.md` shows how to run both against a scratch
database.

## Not applicable

- **OpenAPI:** no route, request or response body changes.
- **ER diagram and migration:** no stored value changes.
- **Sequence diagram:** no request flow changes.
