# ADR-0191 — Migrations are append-only; CI checks the applied checksums

Status: Accepted (PT-8a, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`); the CTO
decided the guard, the checksum check and what PT-8a leaves out the
same day. No customer surface, charge, business rule, route, setting,
stored value or migration changes.

Builds on: ADR-0178 (the `production-mode` job applies the migrations
from the runner; unchanged), ADR-0179 (one run per commit on one pinned
PostgreSQL; still 8 checks).

## Context

`packages/database/prisma/migrations/` holds 36 migrations,
`00000000000000_init` to `00000000000035_rate_limit_counters`, and
`migration_lock.toml`. CI's `database` job applies them to an empty
PostgreSQL 16 and checks the committed schema for drift. Nothing
checked that a migration a database already holds was left as it was.

Prisma cannot see that. Measured on a throwaway PostgreSQL 16.15 with
the repository's Prisma 5.22.0, on a database holding all 36:

- with `00000000000035_rate_limit_counters/migration.sql` edited after
  it was applied, `migrate deploy` printed "36 migrations found" and
  "No pending migrations to apply.", and `migrate status` "Database
  schema is up to date!", both exit 0;
- a new folder `00000000000020a_lab_x`, which sorts before the last
  applied name, was applied by `migrate deploy` with exit 0 and no
  warning.

Prisma stores each applied file's SHA-256 in `_prisma_migrations`, so a
check can. Pull requests merge with merge commits, so a merged commit's
first parent is the `main` it was merged into (read: `230972fb`'s
parents). Nothing is deployed, and no tag marks a release.

## Decision 1 — The first parent is the previous release, for now

The checked-out commit's first parent, `HEAD^1`, stands for "the
previous release" until production records which migration it holds
(G1/G3). The `database` job's checkout gets `fetch-depth: 2`, so the
parent is present with no token or extra fetch, and
`persist-credentials: false`, since no later step needs Git
credentials. On a pull request the checkout is GitHub's test merge
commit, whose first parent is the base branch *(inference from
GitHub's documented behaviour, not fetched)*; on a push to `main` it is
the merge commit. If `HEAD^1` is missing, the step fails with a message
rather than skipping. Recording what production holds, so CI upgrades
from it, is a new item in `TODO.md`.

## Decision 2 — A merged migration is never edited, renamed or deleted

The step "Check that no applied migration changed" extracts the first
parent's `packages/database/prisma` with `git archive` and runs
`tests/migrations/append-only.sh <parent> <head>`. It exits 1, naming
each offending folder and the rule, when:

- a parent folder is missing from the head, or holds other entries or
  other bytes there;
- `migration_lock.toml` differs;
- a name only the head holds sorts, in byte order (`LC_ALL=C`), at or
  before the parent's last;
- a name only the head holds does not match `^[0-9]{14}_[a-z0-9_]+$`,
  or holds `mfa`, `queue`, `delivery`, `recovery` or `phase`, the words
  the tripwire tests filter on.

The name rules judge only names the parent does not hold. 25 of
today's names hold a banned word (`00000000000001_phase2_…` and on),
and they stay as they are.

**A merged migration is undone by a new migration, never by a revert.**
Reverting a pull request that added a migration deletes its folder, and
this step refuses that. An exception needs a new ADR and a change to
the guard in the same pull request.

## Decision 3 — Checksums after the fresh apply

The step "Check the applied migrations' checksums" runs right after
"Apply migrations to an empty database".
`tests/migrations/checksums.sh` compares every finished, not
rolled-back row of `_prisma_migrations` with the SHA-256 of the head's
`migration.sql` of the same name. A mismatch, a row with no folder, a
folder with no row or a name applied twice exits 1. It prints names and
rules only, never a checksum. psql reaches the database through libpq's
own variables, as the shadow-database step already does, so no address
is on a command line and nothing is printed.

## Decision 4 — No unseeded upgrade

With Decision 2 in force, the parent's migrations are a byte-equal
prefix of the head's, and Prisma applies the rest in name order. So
applying the parent's set to an empty database and then the head's runs
the same SQL in the same order as the fresh apply *(from the guard's
rules and the order Prisma applies names in; not measured as a pair)*.
PT-8a therefore adds no such step and no second throwaway database.
**An upgrade's only value is the seeded path:** rows that a later
migration must carry or refuse. That is built in PT-8b, with a seed at
a fixed level applied at its own level and then the head's remaining
set.

## Decision 5 — In the `database` job, still 8 checks

Both steps run in the existing `database` job, which already has the
pinned PostgreSQL service (ADR-0179), psql and the Prisma CLI. No job,
Docker command, action, secret or trigger is added, so a pull request
still shows 8 checks. Each step has `timeout-minutes: 2`.

## What holds it

- **Unit:** `tests/migrations/append-only.test.ts` runs the script on
  trees it builds: an unchanged copy passes; an appended comment, a
  deleted folder, a renamed folder, an extra file in an old folder and
  a changed lock file each fail with the name; a new name sorting
  before the parent's last, a name outside the pattern and a new name
  holding each banned word fail; a parent already holding `phase…` and
  `mfa…` names passes with a valid new one; and two names whose order
  differs between byte order and `en_US.UTF-8` are judged by byte
  order. The repository's own migrations pass against themselves.
- **Unit:** `tests/migrations/workflow.test.ts` reads `ci.yml` as text,
  printing no line that may hold an address or password. It requires
  the checkout's two settings, the steps in order and their exact
  commands. It refuses `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`, `migrate
  dev`, `migrate reset`, `db push`, `--accept-data-loss`,
  `--force-reset`, `--from-url` and `--to-url` in the workflow and the
  scripts, and tracing or an `echo` of a `…URL` variable in the scripts.
- **CI:** both steps on every pull request and push to `main`.

## What was measured

On a throwaway PostgreSQL 16.15 (trust on a unix socket, so no
password existed), migrated with the repository's `prisma migrate
deploy`:

- `checksums.sh` exited 0 on the 36 applied migrations;
- with one row's checksum set to 64 zeros it exited 1, naming
  `00000000000034_one_pending_invitation`;
- it exited 1 for a rolled-back row, an unfinished row, an extra row
  and a duplicate row, naming each, and 2 when the database did not
  exist;
- against a copy with migration 35 edited it exited 1, where Prisma
  passed (Context).

The append-only step's own script, run locally with bash `-e -o
pipefail` as Actions runs it:

- exited 0 on this tree, after extracting `230972fb`'s first parent;
- exited 1 with both names in a scratch clone of depth 2, on a commit
  that edited migration 35 and added `00000000000036_lab_recovery_x`;
- exited 1 with its message in a clone of depth 1.

With an `en_US.UTF-8` locale built for the test, that locale ordered
`…_ab` before `…_a_z`, the reverse of byte order, and the two ordering
tests failed once `export LC_ALL=C` was removed from the script. On a
machine without that locale those two tests pass either way
*(inference: glibc then falls back to byte order)*.

## Not done

- **The previous build's code against the new schema.** Nothing runs
  the parent's code on the head's schema. PT-8e writes the rule for
  migrations that are safe with the previous build.
- **Stacked pull requests and stale bases.** A pull request based on a
  branch other than `main` gets that branch as its "previous release".
  Two pull requests that each add a migration can both pass on their
  own base and meet only in `main`'s push run. "Require branches to be
  up to date before merging" would close that; it is a branch
  protection setting, so it is T14's, held by whoever has GitHub admin
  access.
- **A rebase push of several commits** makes `HEAD^1` the previous
  commit, not the previous `main`. The repository merges with merge
  commits, and each pull request's own run tested its base.

## Considered and not done

**An unseeded "parent, then head" upgrade** (the plan's first PT-8a):
equal to the fresh apply under Decision 2 (Decision 4). **`migrate
diff` or `migrate status` as proof of equal schemas:** neither sees a
dropped CHECK constraint or partial index *(measured in the PT-8
critique, not in this milestone)*. **The pull request's base SHA with
a `git fetch`:** equal on pull requests, needs credentials. **Every
prefix upgraded to head:** adds nothing without data. **Git tags:**
none exist, and phase tags mark phases, not releases. **Flipping the
Phase 1 "live-PostgreSQL CI job" item:** an unrelated cleanup, left
for its own change.

## Consequences

- Fixing a merged migration whose SQL is wrong needs a new ADR and a
  guard change until PT-8e defines the exception path.
- For a milestone that adds a migration, "Rolling back is a revert"
  holds only until it merges. After that it is rolled back by a new
  migration that undoes it.
- A pull request that renames, deletes or edits a migration folder
  fails the `database` job.
