# ADR-0179 — CI runs once per commit, on one PostgreSQL

Status: Accepted (PT-6a, 2026-11-26). The first milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at 04:38Z.
**Amends ADR-0178 Decision 1** (when `production-mode` runs and how many
checks a pull request shows). ADR-0178's other decisions stay as written.

Builds on: ADR-0178 (the production-mode job and its pinned PostgreSQL).

## Context

Since Phase 0 the workflow ran on `push` to every branch and on
`pull_request`, so each commit of a branch with a pull request ran the
whole workflow twice: 16 checks, about eight minutes each run
(`docs/production-readiness-completion.md`). A newer commit did not stop
the older run. GitHub Actions minutes beyond a private repository's free
allowance are billed.

The `database` and `e2e` jobs ran PostgreSQL as `postgres:16`, a tag that
moves with each minor release, while `production-mode` pinned
`postgres:16.16-trixie` by index digest (ADR-0178). Three jobs could test
against two different servers (`TODO.md`, "Open in RD-11a").

## Decision 1 — One run per commit

The workflow runs on `push` to `main` only, and on `pull_request`. A
commit of a pull request runs once, as the `pull_request` event; a merge
into `main` runs once, as the `push` event. A pull request shows eight
checks, one per job; their names are unchanged. A branch with no pull
request runs no CI.

## Decision 2 — A newer commit cancels its pull request's run

`concurrency` groups a pull request's runs by its number and cancels the
run in progress when a newer commit arrives. Each commit of `main` has a
group of its own (its SHA), and `cancel-in-progress` is false for it, so
no run of a merged commit is cancelled or replaced by a later one.

## Decision 3 — Every job runs the same PostgreSQL

The `database` and `e2e` service containers run the image
`production-mode` names in `PG_IMAGE`, by the same tag and index digest.
Moving to another PostgreSQL changes all three in one commit.

## Decision 4 — A test holds both

`tests/ci-workflow.test.ts` reads the workflow as text: its head (name,
triggers, `concurrency`) is compared whole, no other trigger or job-level
`concurrency` appears, and every PostgreSQL image line names
`PG_IMAGE`'s value. It never compares or prints a line holding a
credential.

## Consequences

- Half the CI minutes per pull request commit, and none for a superseded
  commit's unfinished run.
- The pull request run tests GitHub's merge of the head into its base, not
  the head alone; the push run on `main` tests the merged commit itself.
- A branch pushed without a pull request gets no CI until one is opened.
- A PostgreSQL minor upgrade is one reviewed change, never a silent move.
