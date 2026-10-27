# ADR-0087 — A generation starts in one commit

Status: Accepted (GS-4b, 2026-10-27). Second of three pull requests for GS-4,
the whole-video start step, in the generation-to-preview plan the product owner
approved on 2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`,
Design 2).
Builds on: ADR-0055 (the Unit ledger and Transaction B), ADR-0073 (the
disclosure mode is frozen on the job), ADR-0086 (the project row orders
compositions and the start step), ADR-0052 Decisions 6, 7 and 19.

## Context

Every piece a start needs exists, each in a commit of its own: create the job,
move it to `RESERVING`, reserve its Units (Transaction B), create each scene,
create each scene's first request. Run as five or more commits, a failure part
way leaves a job holding Units with no scenes, or scenes copied from a
storyboard that changed between two of them, and nothing would ever release
that hold (ADR-0052 Decision 19). A start the customer sends twice, by
pressing start twice or by a retried request, would create two jobs and hold
Units twice. No job carried a key that could tell the two apart.

GS-4b builds the start as one commit in the database. GS-4c builds the service
that decides whether a start may be made and builds what this commit records;
GS-10 its route. Nothing outside tests constructs it until then.

## Decision 1 — One commit, or nothing

`createGenerationStartRepository(prisma).start(record)` runs one transaction:

```text
project row FOR SHARE (scoped to the organization)
  -> replay: a job of this project with this start key?           -> EXISTING
  -> the storyboard the service judged current, still the project's? -> STORYBOARD_CHANGED
  -> the quality the project's resolution gives, the one confirmed?  -> QUALITY_CHANGED
  -> Units for the storyboard's length                              -> DURATION_NOT_SUPPORTED
  -> job CREATED, then RESERVING, with its events
  -> Transaction B on that job: reservation-admission lock, period,
     cost-admission lock, funding plan, reservation, allocations,
     job RESERVED                          -> NO_ENTITLEMENT_PERIOD / INSUFFICIENT_ENTITLEMENT
  -> each storyboard scene copied PENDING, and its INITIAL request PENDING, with events
  -> the audit entry
```

and answers `STARTED` with everything it wrote, or one of the refusals, having
written nothing.

- **The storyboard is the service's, checked again under the lock.** The record
  names the composition the service judged current: its fingerprint and its
  scene ids in position order. The commit refuses unless the project is
  `STORYBOARD_READY`, carries that fingerprint, and holds exactly those scenes
  in that order, at least one. With ADR-0086, a project's scenes and
  fingerprint always come from one composition, and the project row held
  `FOR SHARE` keeps a composition from changing either before the commit.
- **Quality comes from the project.** 720p is Normal and 1080p is HQ, the only
  quality choice the product offers (ADR-0052 Decision 6), and
  `qualityTierForResolution` is the one mapping. The record carries the quality
  the customer confirmed; the commit derives it again from the locked project
  and refuses `QUALITY_CHANGED` if they differ, so a customer is never charged
  at a quality they did not see.
- **Units come from the storyboard's length.** The job's
  `requestedDurationSeconds` is the sum of the locked scenes' durations, the
  length that will be generated, and `requiredUnitsFor` sizes the reservation
  from it. Composition allocates the project's duration across the scenes, so
  the two agree for any storyboard composed today.
- **The job snapshots the project.** Resolution and aspect ratio are copied
  from the locked row, as job creation does.
- **The disclosure mode is the record's.** A mode the job cannot carry is
  refused `DISCLOSURE_MODE_NOT_SUPPORTED` before the transaction opens, as job
  creation refuses it (ADR-0073). Mode A is the only one today; which mode a
  start asks for is the service's.
- **Transaction B is the same code.** Its body moved, unchanged, into a
  module-private function both `reserve()` and the start run. The start calls it
  on the job it just created, at its first version and at the record's
  `startedAt`, which must come from the server clock.
- **Scenes and requests are copied, not referenced.** Each generation scene
  takes its storyboard scene's position, asset, analysis revision, duration,
  camera motion and compiled prompt (ADR-0016: generation history outlives
  recomposition), and its first request is `INITIAL`, `PENDING`, by the
  requesting user. The ids are the record's, so the service decides them.
- **The audit entry is the caller's, written in the commit.** The record's
  `audit` builds it from what the commit wrote. A builder that throws rolls
  everything back, so a start is never committed without its audit entry.

## Decision 2 — The start key

Migration 32 adds `generation_jobs."idempotencyKey"`, nullable, unique with
`"videoProjectId"`, and checked to 1 to 200 characters when present. Jobs
created any other way carry none.

- **A replay is answered first.** Right after the project lock, a job of this
  project with this key answers `EXISTING` with that job, whatever the
  storyboard, the quality or the balance are now. A retry after the customer
  recomposed still finds the job it started instead of failing as stale.
- **Two at once start one job.** Both pass the replay read; the second's job
  insert waits on the first's entry in the unique index. When the first
  commits, the second is refused by the index, its transaction rolls back, and
  it answers `EXISTING` with the first's job, read again scoped to the
  organization. When the first rolls back, the second proceeds.
- **Scoped to the project, not the organization.** `docs/DataModel.md` sketches
  `(organization_id, idempotency_key)`. The job has no organization column; it
  belongs to its organization through its project, and a project to exactly
  one organization, so a project-scoped key is never shared across tenants. A
  replay names the same project as the start it repeats. Another
  organization naming the project, key or not, matches no project row and is
  answered `PROJECT_NOT_FOUND` before the replay is read, so a key never
  reveals another tenant's job.

## Decision 3 — Lock order

```text
video_projects row FOR SHARE
  -> reservation-admission lock (the new job's)
  -> cost-admission lock (organization + billing cycle)
  -> period, reservation, allocation and job rows
```

- **Composition and start take turns.** Composition locks the row
  `FOR NO KEY UPDATE` (ADR-0086), which conflicts with `FOR SHARE`: a start
  waits for a composition already saving and then judges the storyboard it
  left; a composition waits for a start. Starts and job creation share the row.
- **No cycle.** Only three transactions lock a `video_projects` row: job
  creation (`FOR SHARE`), composition and the start. Composition and job
  creation take no advisory lock. Every other transaction that takes the
  cost-admission lock and also joins the project row locks only the rows it
  names (`FOR UPDATE OF ...`), so nothing that holds an advisory lock waits on
  a project row. Rows that only reference the project check their foreign key
  `FOR KEY SHARE`, which `FOR SHARE` does not block.
- **The reservation-admission lock is uncontended.** It is keyed by the job,
  and the job was created in this transaction, so nothing else can name it. It
  is taken anyway, so Transaction B keeps one lock order however it is entered.

## Decision 4 — Every refusal writes nothing

Refusals found before the job is written return with nothing written. The two
found after it, in Transaction B, are thrown inside the transaction, so the job
and its events roll back with it, and answered once it has. Any other answer
from Transaction B on a job this transaction just created is a defect and
throws.

## Decision 5 — The start stops at `RESERVED`

The commit admits no attempt and creates no generation row for a worker to
discover (ADR-0024): the job stays `RESERVED`, its scenes and requests
`PENDING`. An organization runs at most 1, 3 or 5 jobs at once, extra jobs
waiting with their Units reserved (the approved plan's Design 6, from ADR-0052
Decision 7), so the first attempts are admitted when the job may run, by GS-7's
launch step.

## Decision 6 — The default transaction limit stands

The start runs under Prisma's default interactive-transaction limits (2 seconds
to begin, 5 to finish). Its work grows with the storyboard's scene count, which
the 90-second limit and composition bound. A start that overruns, or waits on a
composition past the limit, rolls back whole and fails; the start key makes the
retry safe. A composition waiting on a start counts against its own limit, as
ADR-0086 recorded.

## Not decided here

- **The start service (GS-4c):** `video.generate` and `unit.consume`, reach
  (ADR-0064), validating the start key, judging freshness, the quality offered,
  Mode A, opening the Unit period first, generating the ids and the server
  clock, the audit action and metadata, and the outcomes the start screen shows.
- **Analysis changes are not locked**, as ADR-0086 recorded. A start that read
  the inputs before an approval changed them has started from the storyboard as
  it then was.
- **A job that never launches** must not hold its Units indefinitely; GS-7
  decides what releases it (`docs/decisions/TODO.md`).

## Consequences

- One migration, one nullable column with its index and check; no existing row
  changes.
- `@app/database` exports `createGenerationStartRepository`; the
  within-transaction body of Transaction B stays private to its module, and a
  static test bounds its callers.
- The database tests prove: a start writes the job, reservation, allocations,
  scenes, requests, events and audit entry together; a replay, and a second
  start with the same key at the same moment, answer with the first job and
  write nothing; a key may start two projects; another organization's replay
  is not answered; each refusal writes nothing, including the two after the
  job is written and a failing audit builder; and a start waits for a
  composition already saving, then refuses the storyboard it changed or starts
  from the one it left. Each wait is observed on the lock the database reports,
  not on a timer.
- Nothing outside tests constructs the repository. No route, no page, and
  nothing a customer can see changes.
