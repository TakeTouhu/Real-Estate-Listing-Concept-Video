#!/usr/bin/env bash
# Compares the migrations a database holds with the committed files (ADR-0191).
#
#   PGHOST=... PGUSER=... PGDATABASE=... bash tests/migrations/checksums.sh <migrations dir>
#
# psql reaches the database through libpq's own environment (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD or a
# password file), never through an argument, so no address or password is on a command line or in the output.
#
# Every finished, not rolled-back row of `_prisma_migrations` must name a folder of <migrations dir>, and its checksum
# must be the SHA-256 of that folder's `migration.sql`, which is what Prisma stores. Every folder must have one such
# row. It prints the names that break this, never a checksum, and exits 1, or exits 0.
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: checksums.sh <migrations dir>" >&2
  exit 2
fi
dir="$1"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

: > "$work/files"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ ! -f "$dir/$name/migration.sql" ]; then
    echo "$name: has no migration.sql"
    exit 1
  fi
  sum="$(sha256sum < "$dir/$name/migration.sql")"
  printf '%s %s\n' "$name" "${sum%% *}" >> "$work/files"
done <<< "$(find "$dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"

# -w: never prompt for a password; with none in the environment or a password file, fail at once instead.
psql -X -w -q -A -t -F ' ' -v ON_ERROR_STOP=1 \
  -c 'SELECT migration_name, checksum FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' > "$work/rows"
sort -o "$work/rows" "$work/rows"

# One line per fault: the name and the rule. A checksum is compared, never printed.
awk -v files="$work/files" '
  BEGIN { while ((getline line < files) > 0) { split(line, f, " "); file[f[1]] = f[2] } }
  { seen[$1] += 1; row[$1] = $2 }
  END {
    for (name in seen) {
      if (!(name in file)) print name ": is applied but no committed folder has that name"
      else if (seen[name] > 1) print name ": is applied more than once"
      else if (row[name] != file[name]) print name ": is applied with a checksum other than its migration.sql"
    }
    for (name in file) if (!(name in seen)) print name ": is committed but not applied"
  }
' "$work/rows" | sort > "$work/faults"

if [ -s "$work/faults" ]; then
  cat "$work/faults"
  echo "$(wc -l < "$work/faults") fault(s): the database does not hold the committed migrations as they are."
  exit 1
fi
echo "Checksums: all $(wc -l < "$work/files") applied migration(s) match their migration.sql."
