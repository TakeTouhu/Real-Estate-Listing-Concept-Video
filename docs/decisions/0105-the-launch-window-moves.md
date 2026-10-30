# ADR-0105 — The launch window moves

Status: Accepted (GS-9a, 2026-10-30). The first milestone of row GS-9 of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the pipeline command").
Builds on: ADR-0095 (the launch commit and its runner, Decision 7), ADR-0098
Decision 6 (the submission window's cursor, which this mirrors) and ADR-0099
(a waiting job refused for configuration keeps waiting).

## Context

The launch runner offers each organization its oldest waiting job, where its
plan leaves a place, oldest first, up to the pass's limit (ADR-0095 Decision
7). A job the planner refuses for VTaVision's configuration or for timing
(`NO_ROUTE`, `AMBIGUOUS_ROUTE`, `NO_CURRENT_PRICING`,
`AMBIGUOUS_CURRENT_PRICING`, `NO_FX_RATE`) is left waiting, its Units held, so
it can launch once the configuration is fixed (ADR-0099 Decision 1). So is a
job the commit refuses for a reason only another writer can cause. Such a job
stays its organization's oldest, so it is offered again on every pass.

Once the limit's worth of organizations all have such a job at their head,
every pass reads the same window, and no other organization's job is ever
offered. A route or a rate missing for one organization's quality would stop
every other organization's videos. ADR-0095 left this to the pipeline command,
and the TODO records it as GS-9's to settle before generation is activated.

GS-9 is split into four milestones, each its own pull request:

- **GS-9a** (this record): the launch window moves.
- **GS-9b**: the development assembly, which builds every runner for the test
  provider only and fills what has no factory outside tests yet.
- **GS-9c**: the pipeline command, which runs the passes in order, carries
  each window's cursor and decides when to stop.
- **GS-9d**: an end-to-end test of the command against a database and FFmpeg
  in CI.

## Decision 1 — The query reads after a cursor

`findJobLaunchCandidates({ limit, after })` reads the window after `after`, a
`{ createdAt, generationJobId }` cursor in the query's own order: each
organization's oldest waiting job, by its creation and then its id. `null`
starts from the oldest. Each candidate now carries its job's `createdAt`, so a
caller can name where it stopped.

The cursor is applied after each organization's oldest waiting job is chosen.
It moves over organizations, never between one organization's jobs. An
organization whose oldest job is at or before the cursor is not offered in
that window, and neither are its later jobs. The launch is strictly oldest
first within an organization (ADR-0095), so a later job could not launch
anyway.

The instant is compared in UTC. A `Date` parameter reaches PostgreSQL as
`timestamptz`, and the column holds UTC with no zone. Compared as they are, a
session in another time zone would move the window's start by its offset, and
a pass could skip or repeat organizations. The query turns the parameter to UTC
first. A test runs the window in a session set to `Asia/Tokyo`.

`validateJobLaunchCursor` accepts `null`, or a `Date` with a finite time and a
non-empty string id. Anything else is refused with `VALIDATION_FAILED`. The
query checks it, since it is public, and so does the runner, before it reads
anything.

## Decision 2 — The runner returns where the next pass starts

`JobLaunchRunner.runOnce(limit, after = null)` passes the cursor to the
launches' query. The report gains `next`:

- the last candidate the query returned, when it returned `limit` of them,
  whatever that candidate's launch answered;
- `null` when it returned fewer: the window reached the end, and the next
  pass starts from the oldest.

The window is full by what the query read, not by what was offered: a second
candidate of one organization, which the runner skips, still counts.

The cursor applies to the launches only. A pass still ends a deleted
Property's waiting jobs, then its launched jobs not yet being assembled, each
from the oldest (ADR-0099, ADR-0102). An ending moves its job out of what its
query finds, so an ending that succeeds holds no window.

The cursor is the caller's to keep. Nothing stores it. Without a cursor a pass
reads from the oldest, as it did before.

## Decision 3 — What a caller owes

The caller is the pipeline command (GS-9c), and the rule is the submission
window's (ADR-0098 Decision 6):

- pass each `next` to the following pass;
- consider the launches settled only after a whole cycle, from the oldest
  until a pass returns `next: null`, in which nothing was launched or ended. A
  full window of waiting jobs launches and ends nothing while newer
  organizations wait behind it, so one quiet pass proves nothing.

A job is written with its `createdAt` before its transaction commits. One
committed after a pass has read past that instant is reached when the cursor
next comes round from the oldest. It waits; it is not lost. An organization
whose job launched in a pass may be offered again later in the same cycle,
for its next job, which is now its oldest.

## Decision 4 — Nothing else changes

The launch commit, both endings and the planner are unchanged. No migration.
Nothing outside tests constructs the runner or the repository, and the static
tests keep it so. No timer, cron or startup hook is added.

## Considered and not done

- **Storing when each job was last offered**, and ordering by it. It needs a
  column, and a write on every read. The cursor needs neither.
- **Leaving configuration refusals out of the query.** The planner refuses
  them against the route kit and the rate source, in memory, at planning
  time; the query cannot know them.
- **A larger limit.** It postpones the problem to one more organization than
  the limit.
- **A random order.** Tests could not pin it, and no pass would be sure to
  reach every organization.

## Not decided here

- The pipeline command: its order of passes, when it stops, and what it reports
  (GS-9c).
- How long a job refused for configuration may hold its Units
  (`docs/decisions/TODO.md`).
- Other raw queries compare `Date` parameters with zone-less columns as they
  are. That is correct only in a UTC session, which is what every environment
  uses today (`docs/decisions/TODO.md`).

## Consequences

- `@app/domain`, in the `job-launch` module: `JobLaunchCursor`,
  `JobLaunchWindowQuery` and `validateJobLaunchCursor`.
  `JobLaunchCandidate` gains `createdAt`. `findJobLaunchCandidates` takes a
  `JobLaunchWindowQuery`. `JobLaunchRunner.runOnce` takes an optional cursor,
  and `JobLaunchReport` gains `next`.
- `@app/database`: `createJobLaunchRepository(prisma)` reads the window after
  the cursor and returns each candidate's `createdAt`.
- No migration, no new table, no new event.
