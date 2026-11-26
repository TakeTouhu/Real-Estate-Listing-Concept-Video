#!/usr/bin/env bash
# Refuses a change to a migration the parent already holds (ADR-0191).
#
#   bash tests/migrations/append-only.sh <parent prisma dir> <head prisma dir>
#
# Each argument is a folder holding `migrations/`, as `packages/database/prisma` does. Prisma cannot see an edited,
# renamed or deleted migration once it has been applied, so CI refuses one before it can reach a database:
#
# - every migration folder in the parent exists in the head, with the same entries and the same bytes;
# - `migrations/migration_lock.toml` is the same;
# - every name only the head holds sorts after the parent's last, in byte order;
# - every name only the head holds matches ^[0-9]{14}_[a-z0-9_]+$ and holds none of the words the tripwire tests
#   filter on (mfa, queue, delivery, recovery, phase). Names the parent already holds are never judged by these.
#
# It prints each offending name with the rule it breaks and exits 1, or exits 0. It reads no setting and no database.
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 2 ]; then
  echo "usage: append-only.sh <parent prisma dir> <head prisma dir>" >&2
  exit 2
fi
parent="$1/migrations"
head="$2/migrations"
for dir in "$parent" "$head"; do
  if [ ! -d "$dir" ]; then
    echo "no migrations folder: $dir" >&2
    exit 2
  fi
done

faults=0
fault() {
  echo "$1: $2"
  faults=$((faults + 1))
}

# The migration folders of a migrations folder, one name per line, in byte order.
names() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
}

# The entries of one migration folder, relative to it, in byte order.
entries() {
  (cd "$1" && find . -mindepth 1 | sort)
}

parent_names="$(names "$parent")"
head_names="$(names "$head")"
last=""
count=0

while IFS= read -r name; do
  [ -n "$name" ] || continue
  last="$name"
  count=$((count + 1))
  if [ ! -d "$head/$name" ]; then
    fault "$name" "is in the parent but not in the head (deleted or renamed)"
    continue
  fi
  if [ "$(entries "$parent/$name")" != "$(entries "$head/$name")" ]; then
    fault "$name" "holds different files in the head than in the parent"
    continue
  fi
  while IFS= read -r entry; do
    [ -d "$parent/$name/$entry" ] && [ -d "$head/$name/$entry" ] && continue
    if [ ! -f "$parent/$name/$entry" ] || [ ! -f "$head/$name/$entry" ] ||
      ! cmp -s "$parent/$name/$entry" "$head/$name/$entry"; then
      fault "$name" "changed ${entry#./} after the parent held it"
    fi
  done <<< "$(entries "$parent/$name")"
done <<< "$parent_names"

lock="migration_lock.toml"
if [ -e "$parent/$lock" ] || [ -e "$head/$lock" ]; then
  if [ ! -f "$parent/$lock" ] || [ ! -f "$head/$lock" ] || ! cmp -s "$parent/$lock" "$head/$lock"; then
    fault "$lock" "differs from the parent's"
  fi
fi

while IFS= read -r name; do
  [ -n "$name" ] || continue
  [ -d "$parent/$name" ] && continue
  if [ -n "$last" ] && [[ ! "$name" > "$last" ]]; then
    fault "$name" "is new but sorts before the parent's last migration, $last"
  fi
  if [[ ! "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]]; then
    fault "$name" "is new and does not match ^[0-9]{14}_[a-z0-9_]+$"
  fi
  for word in mfa queue delivery recovery phase; do
    if [[ "$name" == *"$word"* ]]; then
      fault "$name" "is new and holds the word $word, which the tripwire tests filter on"
    fi
  done
done <<< "$head_names"

if [ "$faults" -gt 0 ]; then
  echo "$faults fault(s): an applied migration is never edited, renamed or deleted; add a new one (ADR-0191)."
  exit 1
fi
echo "Append-only: the parent's $count migration(s) are unchanged."
