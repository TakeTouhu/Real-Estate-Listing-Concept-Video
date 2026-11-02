# ADR-0110 — One video of a project at a time

Status: Accepted (GS-10b, 2026-11-02), applying the recommended answer while
the product owner's is pending. The second milestone of row GS-10 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). Builds on ADR-0087 (the
start commit), ADR-0088 (the start service) and ADR-0109 (the start offer).

## Context

Each start with a new key reserves its Units, so a customer who opens the
start screen twice and presses twice reserves twice, and nothing says what
making a delivered video again costs (ADR-0052 says only that a regeneration
uses more Units). On 2026-10-30 the product owner was asked which projects may
be started again, with three options: only after a failure (recommended), also
after delivery as a new video at its full Units, or at any time.

The question is still open. This milestone applies the recommended answer: it
is the one that never holds a customer's Units twice for one project, and the
other two each need a price decision first. The pull request waits for the
product owner's yes, and `docs/decisions/TODO.md` keeps the question open until
it is answered. Another answer changes Decision 1's rule, which is written twice:
`holdsItsProject` and its query form in the start commit.

## Decision 1 — A job holds its project until it ended without a video and its Units came back

`holdsItsProject(jobState, reservationState)` in `@app/domain`: every job
holds its project, unless it is `FAILED_TERMINAL` or `CANCELLED`
(`JOB_STATES_ENDED_WITHOUT_A_VIDEO`, the job states with no way out) and its
reservation is `RELEASED` or it has none.

- **A delivered video holds its project for good.** `DELIVERABLE_READY` never
  fails, and a replacement or a regeneration that fails returns to it with the
  customer's video (ADR-0082, ADR-0083).
- **A failed video whose Units are not back holds it**: its reservation is
  anything but `RELEASED`. While the provider's answer on one of its requests
  is unknown (`RECONCILIATION_HOLD`), the customer has one video's Units held,
  not two. A failed job with a `CONSUMED` reservation should not exist; if one
  did, it would hold the project.
- **A job with no reservation never reserved any**, so once it ended it holds
  nothing.

A unit test ties the ended states to the job state machine: a new final state
would fail it until this rule is decided for it.

## Decision 2 — The start answers `VIDEO_EXISTS` with the job that holds the project

The start commit, after the replay read and before the storyboard checks,
reads the newest job of the project that holds it (the query form of
Decision 1); if there is one it returns `VIDEO_EXISTS` with that job and writes
nothing. The start service answers `VIDEO_EXISTS` with it.

- **A replay comes first.** A start whose key started the job that holds the
  project answers `ALREADY_STARTED`, as before. The service's two reads are not
  one statement, so when it finds the project held it reads the key's job
  again: a retry whose first request committed in between is still a replay.
- **Reach comes first.** A deleted Property's project is not found, whatever
  its jobs.
- **The service reads it too, before the commit**, after its own replay read
  and before it judges the storyboard: a held project's start opens no Unit
  period. That read is outside the commit's lock; only the commit's own read
  decides.
- The repository gains `findHolding(organizationId, videoProjectId)`, scoped to
  the organization and refusing a missing id, as `findStarted` does.

## Decision 3 — One start of a project at a time: the project-start lock

Two starts of one project with different keys must not both find it free.
Under the cost-admission lock they cannot, but only while both instants fall
in one period: at a period boundary they take different cost-admission locks,
and neither sees the other's job before it commits.

So the start commit's first statement takes a transaction-scoped advisory lock
on the organization and the project (`acquireProjectStartLock`, in
`cost-admission-lock.ts` with every other advisory-lock formula, not exported
from the package). The order is:

```text
project-start lock -> reservation-admission lock -> cost-admission lock
  -> project and Property rows FOR SHARE -> replay -> a job holding the project
  -> storyboard -> job -> Transaction B -> scenes, requests, audit
```

Only the start commit takes it, and takes it first, so nothing holding another
lock ever waits for it and it cannot form a cycle. Two starts of one project
now queue; starts of different projects do not wait on it.

It also orders two starts of one project with one key, so the second reads the
first's job as a replay. The key's unique index (migration 32) stays as the
backstop: should a job with the key be written outside a start, the start
still answers the index's refusal as a replay.

## Decision 4 — The offer answers `VIDEO_EXISTS` before anything about the storyboard

`offer` answers `VIDEO_EXISTS` with the job's id and whether it has delivered
a video (`currentDeliverableVersionId` set, which a revision in progress has),
right after the permissions and reach and before `NOT_COMPOSED`. The screen
shows the project's video, its progress (GS-11) or its preview (GS-12),
instead of a start.

## Decision 5 — No migration

A unique index cannot say "unless the job ended and its reservation was
released": the rule spans two tables. The lock and the read say it. No route,
page or environment variable either: nothing outside tests constructs the
service until GS-10c's route.

## Consequences

- Pressing start twice reserves once. A project is started again only after its
  video failed and its Units came back.
- A project started again after a failure may find the failed job's identical
  requests still with the provider. The launch already waits for those
  (`SAME_REQUEST_RUNNING`, ADR-0095), so that guard stays.
- Regenerating a scene or changing a delivered video's disclosure or logo is
  not a start and is not affected.
- The older job creation (`GenerationJobRepository.create`, the single-scene
  path) neither reads the jobs holding the project nor takes the lock. Nothing
  in production constructs it; only the start makes whole videos.
- The lock, like the others, relies on READ COMMITTED: the read after the wait
  sees the job the holder committed.
- If the product owner allows starting again after delivery, Decision 1 frees a
  delivered job's project and the price of the new video must be decided; if
  at any time, the rule and the lock go.
