# ADR-0104 — Planning a video's composition once its scenes are ready

Status: Accepted (GS-8, 2026-10-29). A milestone of the generation-to-preview
plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-8: "the step that
plans composition once every scene is ready").
Builds on: ADR-0049 (Transaction I, the composition plan), ADR-0046 (scene
delivery, Transaction F, which moves a job to `SCENES_READY`), ADR-0050 (the
composition claim, J1, which takes a `COMPOSITION_PENDING` job), and the sweep
pattern of ADR-0083 and ADR-0084.

## Context

Transaction F delivers a job's last scene and moves the job `GENERATING →
SCENES_READY`. Transaction I then freezes which scene videos make the next
deliverable version and moves the job `SCENES_READY → COMPOSITION_PENDING`, where
the composition claim (J1) finds it. Transaction I has existed since Phase 5A,
but nothing finds the jobs it should plan or calls it. Phase 5A shipped it with
no discovery on purpose, because nothing after it ran yet (ADR-0049). Everything
after it now exists, dormant, so a job that reaches `SCENES_READY` stops there.

## Decision 1 — A sweep over durable facts

The driver offers jobs to Transaction I through a bounded query, like the other
sweeps of this plan. There is no work row and no lease. Transaction I is its own
idempotence: a job it plans leaves `SCENES_READY`, and a second call for the
same job answers `ALREADY_PLANNED` without writing.

`findCompositionPlanCandidates({ limit })` is on the plan repository's port. It
reads without a lock and outside a transaction, and it returns identifiers only:
the job and the organization of its project. Transaction I re-reads and re-decides
everything under its own locks, as before.

**It mirrors every refusal of Transaction I**, so a job Transaction I would
refuse is never offered and cannot hold a place at the head of the batch. A job
is offered when:

- it is `SCENES_READY`;
- its reservation describes one of the two composition cycles: no current
  deliverable with the hold `RESERVED` (the first video), or a current
  deliverable with the hold `CONSUMED` (a recomposition). A job with no
  reservation is not offered;
- it has at least one scene;
- every scene is `READY`, its delivered pointer names a `DELIVERED` request of
  that scene, that request's latest attempt by ordinal is `OUTPUT_VERIFIED`, and
  that attempt's media verdict is `VALID`.

A `VALID` verdict always records its instant: the database's check refuses one
without it. So Transaction I's test of that instant is not repeated in the
query.

**A defect is not mirrored.** A verdict bound to other bytes than its attempt's
receipt makes Transaction I raise `SOURCE_RECEIPT_BINDING_CONFLICT`. No writer
produces that state. Such a job is offered on every pass and reported as failed
with its code, so whoever runs the pass sees it. Hiding it in the query would
leave the job at `SCENES_READY` with nothing saying why.

The cost is that such a job keeps its place: nothing it does moves it, so it
stays the oldest. So does a job whose admission keeps throwing for any other
reason. With `limit` of them at the head, a pass plans no newer job, and each
report lists them as failed until someone repairs them. That is the trade
against a defect nobody sees.

The order is the job's creation, oldest first, then its id. The limit is an
integer from 1 to 100, refused otherwise and never clamped, checked by the
query as well as the runner, since the query is public.

## Decision 2 — The runner

`CompositionPlanRunner.runOnce(limit)` asks for candidates once, then calls
Transaction I once per job:

- with the candidate's organization and job;
- with a fresh deliverable version id from its `ids` dependency
  (`nextDeliverableVersionId`), which Transaction I uses only if it plans. A
  version id is never reused between jobs or passes;
- with a context built for that call, so each plan carries its own correlation.

A job listed twice in one batch is planned once. A call that throws is that job's
`FAILED` outcome, with its code when it is a `DeliverableCompositionDefect` and
nothing else about the error, and the pass goes on. A query that throws rejects
the pass, and nothing is planned.

The report counts the jobs planned and the calls that failed, and lists each
job's outcome: `PLANNED`, `ALREADY_PLANNED`, `NOT_ELIGIBLE`, `NOT_FOUND` or
`FAILED`. `ALREADY_PLANNED` and `NOT_ELIGIBLE` are races with another writer,
answered by Transaction I and not retried in the pass.

## Decision 3 — Nothing else changes

Transaction I is unchanged: its locks, its judgement, its writes and its events.
The driver writes nothing itself. It moves no Unit and no current-deliverable
pointer, and it reaches no provider, storage, FFmpeg or HTTP client.

**A deleted Property's job is offered.** Transaction I does not read the
Property, and the query mirrors Transaction I. A deleted Property's job in
`SCENES_READY` or `COMPOSITION_PENDING` is ended and its Unit released by the
launched-job ending (ADR-0102). One already claimed for composition is refused
at publication, and its Unit released (ADR-0103). Planning such a job first
writes a version nothing will publish, and moves no money.

## Decision 4 — Nothing runs it yet

Nothing outside tests constructs `CompositionPlanRunner` or calls
`findCompositionPlanCandidates` or `admitCompositionPlan` except the runner, and
the static tests keep it so. The pipeline command (GS-9) is what will run it, on
the test provider only. No timer, cron or startup hook is added.

## Considered and not done

- **Calling Transaction I from Transaction F's runner** when a delivery moves
  the job to `SCENES_READY`. It would tie two steps into one pass, and a job
  whose last delivery committed before the plan failed would wait for a later
  delivery that never comes. A sweep reaches every such job.
- **Skipping a deleted Property's job in the query.** The query would then
  disagree with Transaction I, which is the authority, and ADR-0102 and ADR-0103
  already end that job and return its Unit.
- **Mirroring the receipt defect** (Decision 1).

## Not decided here

- The pipeline command that runs this runner and the others (GS-9).
- How the customer is shown a video waiting for composition (GS-11).

## Consequences

- `@app/domain`, in the `deliverable-composition` module:
  `CompositionPlanRunner` with `CompositionPlanRunnerDeps`, `CompositionPlanIds`,
  `CompositionPlanReport` and `CompositionPlanRunOutcome`;
  `MAX_COMPOSITION_PLAN_BATCH_SIZE` and `validateCompositionPlanBatchLimit`;
  `CompositionPlanCandidate` and `CompositionPlanCandidateQuery`; and
  `findCompositionPlanCandidates` on `DeliverableCompositionPlanRepository`.
- `@app/database`: `createDeliverableCompositionPlanRepository(prisma)` gains the
  query.
- No migration, no new table, no new event.
- The composition plan's static tests now allow the runner in its own module and
  forbid constructing it anywhere else in production.
