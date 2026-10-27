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
reservation-admission lock (the new job's)
  -> the period containing startedAt; its cost-admission lock (organization + cycle)
  -> project row FOR SHARE (scoped to the organization)              -> PROJECT_NOT_FOUND
  -> replay: a job of this project with this start key?             -> EXISTING
  -> the storyboard the service judged current, still the project's? -> STORYBOARD_CHANGED
  -> the quality the project's resolution gives, the one confirmed?  -> QUALITY_CHANGED
  -> Units for the storyboard's length                              -> DURATION_NOT_SUPPORTED
  -> a period found above?                                          -> NO_ENTITLEMENT_PERIOD
  -> job CREATED, then RESERVING, with its events
  -> Transaction B on that job (its two locks already held): funding plan,
     reservation, allocations, job RESERVED                         -> INSUFFICIENT_ENTITLEMENT
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
  `startedAt`, which must come from the server clock. It takes its two advisory
  locks again, which a transaction already holding them is granted at once, and
  finds the same period: periods never overlap and never change.
- **Scenes and requests are copied, not referenced.** Each generation scene
  takes its storyboard scene's position, asset, analysis revision, duration,
  camera motion and compiled prompt (ADR-0016: generation history outlives
  recomposition), and its first request is `INITIAL`, `PENDING`, by the
  requesting user. The ids are the record's, so the service decides them.
- **The audit entry is the caller's, written in the commit.** The record's
  `audit` builds it from what the commit wrote. A builder that throws, or an
  entry naming another organization than the start's, rolls everything back,
  so a start is never committed without its audit entry or with one filed
  under another tenant.

## Decision 2 — The start key

Migration 32 adds `generation_jobs."idempotencyKey"`, nullable, unique with
`"videoProjectId"`, and checked to 1 to 200 characters when present. Jobs
created any other way carry none.

- **Checked before the transaction.** A key that is not a string of 1 to 200
  characters is refused with a validation error before anything is read: the
  replay is read before anything is inserted, so the column's check would come
  too late, and a missing key would match any job of the project. The service
  validates the key first (GS-4c); this guards a caller that is not
  type-checked, as the disclosure mode's refusal does.
- **A replay is answered first.** Right after the project lock, a job of this
  project with this key answers `EXISTING` with that job, whatever the
  storyboard, the quality or the balance are now. A retry after the customer
  recomposed still finds the job it started instead of failing as stale.
- **Two at once start one job.** Two starts with one key in one period take
  turns at that period's cost-admission lock, so the second reads the first's
  committed job as a replay. Two in different periods, a start as one period
  ends and its retry as the next begins, take different cost-admission locks:
  the second's job insert waits on the first's entry in the unique index. When
  the first commits, the second is refused by the index, rolls back, and
  answers `EXISTING` with the first's job, read again scoped to the
  organization. When the first rolls back, the second proceeds and starts.
- **What a second start is answered depends on when it reads.** One that reads
  before the first commits is judged on its own record, so a retry that
  differs (in quality, say) can be refused for that difference while the first
  is still in flight, and is answered `EXISTING` once it has committed.
- **Scoped to the project, not the organization.** `docs/DataModel.md` sketches
  `(organization_id, idempotency_key)`. The job has no organization column; it
  belongs to its organization through its project, and a project to exactly
  one organization, so a project-scoped key is never shared across tenants. A
  replay names the same project as the start it repeats. Another
  organization naming the project, key or not, matches no project row and is
  answered `PROJECT_NOT_FOUND` before the replay is read, so a key never
  reveals another tenant's job. The same key sent for two different projects
  starts two jobs; a client makes one key per start, so this only happens when
  a caller reuses a key on purpose.

## Decision 3 — Lock order

```text
reservation-admission lock (the new job's)
  -> cost-admission lock (organization + billing cycle)
  -> video_projects row FOR SHARE
  -> the job row (created here), then the reservation and allocation rows
```

- **The cost-admission lock stays the outermost lock.** Every workflow that
  takes it takes it before any row lock (`cost-admission-lock.ts`), and no row
  lock is held while it is acquired. The start holds the project row until it
  commits, so it takes the cost-admission lock, and the reservation-admission
  lock before it, as its first statements, in Transaction B's order. A start
  no period covers takes no cost-admission lock, and is refused before the job
  is written, so Transaction B never takes one under the project row.
- **The reservation-admission lock is uncontended.** It is keyed by the job,
  and the job id is new, so nothing else can name it. It is taken anyway, so
  Transaction B keeps one lock order however it is entered.
- **Composition and start take turns.** Composition locks the row
  `FOR NO KEY UPDATE` (ADR-0086), which conflicts with `FOR SHARE`: a start
  waits for a composition already saving and then judges the storyboard it
  left; a composition waits for a start. A start waiting for the cost-admission
  lock holds no row, so compositions save meanwhile. Starts and job creation
  share the row.
- **No cycle.** A `video_projects` row is locked or written only by job
  creation (`FOR SHARE`), composition (`FOR NO KEY UPDATE`, then its
  `UPDATE`), the start, and `projects.update`, a single statement with no
  production caller. Composition and job creation take no advisory lock.
  Every transaction that takes the cost-admission lock and joins the project
  row locks only the rows it names (`FOR UPDATE OF ...`). Rows that only
  reference the project check their foreign key `FOR KEY SHARE`, which
  `FOR SHARE` does not block. A static test lists every lock and write on a
  project row in the database package, so a new one is checked against this
  order before it is added.
- **The organization's other cost decisions wait for a start.** Holding the
  cost-admission lock for the whole start serializes it with the
  organization's reservations, block grants, settlements and paid-submission
  checks for that cycle, for the length of the start's transaction.

## Decision 4 — Every refusal writes nothing

Refusals found before the job is written return with nothing written. The one
found after it, a short entitlement in Transaction B, is thrown inside the
transaction, so the job and its events roll back with it, and answered once it
has. A missing period would be handled the same way, though the start refuses
it earlier. Any other answer from Transaction B on a job this transaction just
created is a defect and throws.

## Decision 5 — The start stops at `RESERVED`

The commit admits no attempt and creates no generation row for a worker to
discover (ADR-0024): the job stays `RESERVED`, its scenes and requests
`PENDING`. An organization runs at most 1, 3 or 5 jobs at once, extra jobs
waiting with their Units reserved (the approved plan's Design 6, from ADR-0052
Decision 7), so the first attempts are admitted when the job may run, by GS-7's
launch step.

## Decision 6 — The default transaction limit stands

The start runs under Prisma's default interactive-transaction limits (2 seconds
to begin, 5 to finish). Its work grows with the storyboard's scene count: about
six statements per scene, and a 90-second storyboard of one-second scenes has
90. Measured on the local test database, composing and starting such a
storyboard together take under a second. A start that overruns, or waits on a
composition past the limit, rolls back whole and fails, and the start key makes
the retry safe; but a start that overruns because of its own size would overrun
again, so its time on the production database is to be measured before
activation (`docs/decisions/TODO.md`). A composition waiting on a start counts
against its own limit, as ADR-0086 recorded.

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
  static test keeps every mention of it in that module.
- The lock module's and the authorization repository's notes on lock order now
  name the start.
- The database tests prove: a start writes the job, reservation, allocations,
  scenes, requests, events and audit entry together; a 720p project starts at
  Normal; a key may start two projects; a replay answers with the first job and
  writes nothing, even after recomposition; two starts with one key in one
  period take turns and start one job; two in different periods are decided by
  the key's index, and the second starts when the first dies; another
  organization's replay is not answered; each refusal writes nothing, including
  a short entitlement after the job is written, a failing audit builder, an
  audit entry naming another organization, and a key the column cannot hold; a
  start waits for the cost-admission lock holding no row, while a composition
  saves; it waits for a composition already saving, then refuses the
  storyboard it changed or starts from the one it left; it does not wait for
  another reader of the project; and a 90-scene storyboard starts within the
  default limit. Each wait is observed on the lock the database reports, not
  on a timer.
- Nothing outside tests constructs the repository. No route, no page, and
  nothing a customer can see changes.
