#!/usr/bin/env bash
# Upgrades a seeded database to the head's migrations (ADR-0191 Decision 4, "Built in PT-8b").
#
#   PGHOST=... PGUSER=... PGDATABASE=<fresh> UPGRADE_DATABASE_URL=... \
#     bash tests/migrations/upgrade.sh <prisma dir> <seed dir> <upgrade database>
#
# <fresh> is a database the head's migrations were applied to, empty before; it is checked, then only read. The script
# creates <upgrade database>, which must not exist, and for each seed file <seed dir>/<14-digit level>.sql, in byte
# order: applies the head's migrations up to that level from a temporary folder holding only them, the lock file and
# the schema, and runs the seed in one transaction that stops at its first error. Then it applies the head's full set,
# runs <seed dir>/check.sql (a seeded row lost or a seeded value changed fails), checks the applied checksums, and
# compares pg_dump --schema-only of both databases, _prisma_migrations left out.
#
# psql and pg_dump reach the server through libpq's environment, never through an argument. Prisma gets
# UPGRADE_DATABASE_URL, which must name <upgrade database>, as DATABASE_URL for each deploy command only. Neither is
# printed. Exits 0, or non-zero after the failing command's own output (2 when it cannot start).
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 3 ] || [ ! -d "$1/migrations" ] || [ ! -f "$1/schema.prisma" ] || [ ! -d "$2" ]; then
  echo "usage: upgrade.sh <prisma dir> <seed dir> <upgrade database>" >&2
  exit 2
fi
prisma="$(cd "$1" && pwd)"
seeds="$(cd "$2" && pwd)"
target="$3"
here="$(cd "$(dirname "$0")" && pwd)"
fresh="${PGDATABASE:?PGDATABASE must name the freshly migrated database}"
if [[ ! "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || [ "$target" = "$fresh" ]; then
  echo "the upgrade database must be a plain lower-case name other than PGDATABASE's" >&2
  exit 2
fi
if [ -z "${UPGRADE_DATABASE_URL:-}" ]; then
  echo "UPGRADE_DATABASE_URL must name the upgrade database" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sql() { psql -X -w -q -A -t -v ON_ERROR_STOP=1 "$@"; }
deploy() { DATABASE_URL="$UPGRADE_DATABASE_URL" pnpm --filter @app/database exec prisma migrate deploy --schema "$1"; }

# pg_dump refuses a server newer than itself, and a dump is compared only when it can be made.
server="$(sql -c 'SHOW server_version_num')"
client="$(pg_dump --version | sed -E 's/^pg_dump \(PostgreSQL\) ([0-9]+).*/\1/')"
if [[ ! "$client" =~ ^[0-9]+$ ]] || [ "$client" -lt "$((server / 10000))" ]; then
  echo "pg_dump $client cannot dump a PostgreSQL $((server / 10000)) server" >&2
  exit 2
fi

echo "The fresh database, $fresh:"
bash "$here/checksums.sh" "$prisma/migrations"
sql -c "CREATE DATABASE \"$target\""
export PGDATABASE="$target"

migrations="$(find "$prisma/migrations" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
count=0
while IFS= read -r seed; do
  [ -n "$seed" ] || continue
  level="${seed%.sql}"
  name="$(grep -E "^${level}_" <<< "$migrations" || true)"
  if [ "$(grep -c . <<< "$name")" -ne 1 ]; then
    echo "$seed: names no single migration" >&2
    exit 1
  fi
  mkdir -p "$work/$level/migrations"
  cp "$prisma/schema.prisma" "$work/$level/"
  cp "$prisma/migrations/migration_lock.toml" "$work/$level/migrations/"
  while IFS= read -r dir; do
    [[ "$dir" > "$name" ]] || cp -R "$prisma/migrations/$dir" "$work/$level/migrations/"
  done <<< "$migrations"
  echo "Applying the migrations up to $name, then $seed:"
  deploy "$work/$level/schema.prisma"
  sql -1 -f "$seeds/$seed"
  count=$((count + 1))
done <<< "$(find "$seeds" -mindepth 1 -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9]{14}\.sql' \
  -exec basename {} \; | sort)"

echo "Applying the head's migrations to the seeded database:"
deploy "$prisma/schema.prisma"
sql -f "$seeds/check.sql"
bash "$here/checksums.sh" "$prisma/migrations"

# pg_dump (16.10 and later) writes a random \restrict key into each dump; it is not part of the schema.
for db in "$fresh" "$target"; do
  PGDATABASE="$db" pg_dump -w --schema-only --exclude-table=_prisma_migrations | grep -vE '^\\(un)?restrict ' \
    > "$work/$db.sql"
done
if ! diff -u "$work/$fresh.sql" "$work/$target.sql" > "$work/schema.diff"; then
  head -n 200 "$work/schema.diff"
  echo "The upgraded schema differs from the fresh one (pg_dump --schema-only)."
  exit 1
fi
echo "Upgrade: $count seed file(s) applied at their level kept their rows and values through the head's migrations;"
echo "the upgraded schema equals the fresh one."
