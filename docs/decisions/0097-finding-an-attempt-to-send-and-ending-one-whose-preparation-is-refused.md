# ADR-0097 — Finding an orchestrated attempt to send, and ending one whose preparation is refused for good

Status: Accepted (GS-7c-2a, 2026-10-29). Fourth of the pull requests for row
GS-7 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`). GS-7c-2 is
split in two: this pull request finds the attempts to send and ends the ones
preparation refuses for good, and GS-7c-2b sends one.
Builds on: ADR-0026 (the execution preflight) and ADR-0027 (its canonical
dispositions), ADR-0083 (Transaction K), ADR-0084 (Transaction L), ADR-0095
(the launch commit admits each scene's first attempt `QUEUED`) and ADR-0096
(the gate moves only the source it locked).

## Context

The launch commit admits each scene's first attempt `QUEUED` in its
orchestration state (ADR-0095), and the paid-submission gate moves one to
`SUBMITTING` only for the source preparation signed a URL for (ADR-0096). The
sender between them must find the attempts waiting, and prepare each with the
execution preflight (`prepareQueuedGeneration`, ADR-0026), before it can ask
the gate.

Nothing finds an orchestrated attempt to send: the legacy executor's discovery
offers legacy rows only (ADR-0096 Decision 1). And nothing records a refusal
of one. The legacy park (`failQueuedPreflight`, ADR-0027) now leaves
orchestrated attempts alone, so an attempt whose photo is gone would be refused
on every pass and stay `QUEUED`. Transaction K settles a request only once its
newest attempt has ended, so its Unit would stay held, against ADR-0052
Decision 19 (`docs/decisions/TODO.md`, *Move the execution preflight's failures
onto the orchestration state*).

## Decision 1 — Discovery offers what the sender could send

`findSubmissionCandidates({ limit })` offers an attempt when:

- its orchestration state is `QUEUED`, and its submission certainty is
  `PRE_SUBMISSION` (or none, read as `PRE_SUBMISSION` as the gate reads it);
- its request and its job are `GENERATING`;
- its project's Property is not deleted.

They come oldest first by the attempt's creation, `id` breaking ties, as every
other sweep orders. The bound is 1 to 100 and is refused, not clamped, outside
it. The read takes no lock: it is a hint, and the gate decides again under its
own locks (ADR-0096). Each candidate carries the organization the attempt's
project names, so preparation reads the photo through the tenant-scoped asset
repository, as the legacy discovery does (ADR-0025).

The job and request conditions keep out an attempt that is waiting for
Transaction L: when K fails one scene's request it fails the job and releases
the Unit, and the other scenes' attempts stay `QUEUED` until L cancels them
(ADR-0084). Preparing one would sign a URL for a call the gate refuses, the
reservation being released.

The Property condition mirrors the gate, which refuses a deleted Property's
attempt for good (ADR-0096 Decision 2). Offered, such attempts would be
prepared and refused on every pass, oldest first, ahead of attempts that can
be sent. Passing them over also means preparation never ends one, even once
its photos are asked to be deleted, so its Unit stays held, as a waiting job's
does under a deleted Property (ADR-0095 Decision 3). Ending both is GS-7d's.

## Decision 2 — The canonical disposition decides what a refusal does

When preparation refuses, `preparationRefusalEnding(reason)` answers from the
canonical disposition (`preflightDispositionFor`), not from a second list:

| Disposition | What happens to the attempt |
| --- | --- |
| `TERMINAL` | it ends, `QUEUED → CANCELLED_PRE_SUBMISSION`, with the reason as its durable code |
| `RETRYABLE` | nothing; it stays `QUEUED` and is prepared again on a later pass |

**Why `CANCELLED_PRE_SUBMISSION`.** It is the one ended state an attempt may
reach without having entered the provider boundary. The state machine allows
`QUEUED → FAILED_*`, but the schema requires a boundary instant on every
orchestration state past `QUEUED` except this one
(`scene_generations_submission_boundary_check`). Stamping one on an attempt
that was never sent would record a crossing that never happened, in the column
crash recovery reads to judge a submission. Transaction L uses the same state
for the same fact (ADR-0084); the reason code and the event type tell the two
apart. The cost-exposure classifier counts the attempt as no cost, its
certainty being `PRE_SUBMISSION`. Transaction K reads it as ended without a
video (ADR-0083 Decision 2), so it fails the request, the scene and the job
and releases the Unit.

**Why a retryable refusal leaves the attempt `QUEUED`.** The legacy park
records one as `FAILED_RETRYABLE`. For an orchestrated attempt that state is
refused by the same check, and K settles it as ended, so it would fail the
customer's job and release its Unit over storage that did not answer once, or
a photo still being processed. Left `QUEUED`, it is prepared again on the next
pass. What that costs: an attempt whose reason never clears, such as a model
never restored, holds its Unit. How long an attempt may wait is the open
question already recorded for attempts that never finish, and is not decided
here (`docs/decisions/TODO.md`, *Bound how long an attempt may run before it is
treated as failed*).

**A known asymmetry.** Preparation refuses a photo whose key, MIME type or
digest changed while its URL was being signed as `ASSET_SOURCE_CHANGED`, which
is `TERMINAL`, so such an attempt ends and its Unit is released. The gate
refuses the same change found after preparation as `SOURCE_INVALID`
`ASSET_SOURCE_CHANGED`, and the attempt stays `QUEUED` to be prepared again
(ADR-0096). A `READY` photo has no production route into re-processing
(ADR-0029), so neither case is expected. The canonical table is not changed
here: it is shared with the legacy park, and a disposition is a decision of its
own (`docs/decisions/TODO.md`).

**A refusal the deployment causes.** Two `TERMINAL` reasons come from the
deployment's model catalog rather than from the customer's photo or request:
`PROVIDER_IDENTITY_MISMATCH` and `MODEL_DELIVERY_PLAN_CHANGED`. A worker with
a misconfigured catalog, or an older worker during a rollout, would end every
attempt it prepares; Transaction K would then fail those customers' jobs, the
Units released and nothing charged, and only an operator could recover them
(ADR-0052 Decision 20). Whether such a refusal should end an attempt or leave
it for a correctly configured worker is not decided here
(`docs/decisions/TODO.md`).

## Decision 3 — The ending is one transaction behind the cost-admission lock

`endPreparationRefusal({ organizationId, attemptId, reason, context })`
derives the target from the reason and refuses a reason that may still pass
with `INTERNAL_ERROR` before reading anything: that is a caller's defect, not a
refusal. Then, in one transaction:

```text
cost-admission advisory lock (organization, the reservation's frozen cycle or "unreserved")
  -> SceneGeneration      compare-and-set QUEUED -> CANCELLED_PRE_SUBMISSION
  -> GenerationTransitionEvent   insert
  -> commit
```

The lock key is the one the gate takes for the same attempt, read by the same
query. The transactions that take this lock (the gate, the submission outcome,
completion, reconciliation, Transactions H, K and L) take it before any row
lock, and nothing that holds an asset or a Property lock waits for it (ADR-0096
Decision 2). Nothing else here is locked, so the ending adds no cycle.

The compare-and-set requires the attempt to be in the caller's organization,
through its project, `QUEUED` and before submission. The gate's arm also
requires it `QUEUED`, so exactly one of the two moves it: a refused attempt is
never sent, and a sent one is never ended here. The gate and the ending
serialize on the cost-admission lock; a writer that takes none, such as the
attempt repository's own arm, which only tests call (ADR-0096 Decision 3), is
waited for on the attempt's row, and then the ending finds the attempt
moved. It writes
`stateVersion + 1`, the reason as `normalizedErrorCode`, and clears
`normalizedErrorMessage`, so the state and the code describe one failure. The
event is `QUEUED → CANCELLED_PRE_SUBMISSION`, type `attempt.preparation_refused`,
with the reason as its reason code and the caller's actor and correlation.

Anything else answers `NOT_QUEUED` and writes nothing: an attempt of another
organization, one already ended, one the gate armed, one whose certainty has
moved, or none.

No audit entry is written. The ending sends and spends nothing, and Transactions
K and L, which release the Unit and cancel attempts, write none either; the
transition event is the record. Whether a refused preparation warrants an audit
entry stays open (`docs/decisions/TODO.md`).

## Decision 4 — Nothing runs it yet

`createAttemptSubmissionRepository` has no caller outside tests, and a static
test keeps it so. Its module and repository reach no provider, HTTP client or
storage and schedule nothing. The sender (GS-7c-2b) and the pipeline command
(GS-9) are what will call it.

## Not decided here

- **Sending** (GS-7c-2b): the signed URL's freshness checked before the call,
  the gate, one POST through the provider port, and the answer recorded.
- **An attempt the gate refuses for good** (GS-7d), including a deleted
  Property's, which discovery passes over.
- **How long a retryable refusal may hold a Unit** (the TODO item above).
- **Keeping the window moving.** Discovery is one window over every
  organization, oldest first. An attempt left `QUEUED` by a retryable refusal,
  or by a gate refusal that writes nothing (a hard pause, an ineligible price,
  a route not authorized), is offered on every pass. Once a window's worth of
  them are oldest, no newer attempt in any organization is found. How the pass
  (GS-7c-2b, GS-9) keeps such attempts from filling it, as the launch must for
  jobs (ADR-0095 Decision 7), is not decided here (`docs/decisions/TODO.md`).

## Consequences

- `@app/domain`: the `attempt-submission` module, with
  `preparationRefusalEnding`, `ATTEMPT_PREPARATION_REFUSED_EVENT_TYPE`, the
  batch limit and `AttemptSubmissionRepository`.
- `@app/database`: `createAttemptSubmissionRepository(prisma)`.
- No migration. Nothing outside tests constructs the repository, so no path a
  customer or a worker reaches changes.
